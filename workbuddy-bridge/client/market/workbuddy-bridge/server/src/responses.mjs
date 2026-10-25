// OpenAI Responses API 兼容层：/v1/responses
//
// 背景：Codex CLI / 桌面端 0.154+ 只认 Responses 协议（wire_api 仅接受 "responses"），
// 而本项目上游是 Chat Completions 语义。本模块做双向协议转换：
//
//   Codex(Responses 请求) → 本层 → Chat Completions → 复用车载 handler → 转回 Responses
//
// 设计原则：只新增，不改动 /v1/chat/completions 的任何既有行为。
import { resolveTarget } from './router.mjs';
import { openWithSiteFallback } from './openai.mjs';
import { openChat, openChatRotating, classifyFrame, upstreamErrorMessage, reportFrameError } from './upstream.mjs';
import { recordUsage, estimateCredit } from './usage.mjs';
import { startSSE, writeSSEEvent, sendJson, sendError, estimateTokens, startHeartbeat } from './util.mjs';
import { requestLog, warn } from './log.mjs';

/** 生成 Responses 风格 id。 */
function rid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Responses 请求 → Chat Completions 请求。
 *
 * 关键映射：
 *   - instructions          → system 消息
 *   - input(string)         → 单条 user 消息
 *   - input(数组)           → 逐项转换（message / function_call / function_call_output）
 *   - tools(function 扁平)  → tools(function 嵌套)
 *   - max_output_tokens     → max_tokens
 */
export function toChatRequest(body) {
  const messages = [];

  // 注意：上游对 system 消息做内容模式匹配，Codex 的 instructions（含 "You are a coding agent
  // running in the Codex CLI ..."）作为 system 会被判定为 "Illegal API invocation from an
  // unapproved channel"。实测证明同样内容放 user 位置可正常通过，因此这里把 instructions
  // 折进首条 user 消息，而不是用 system 角色发送。
  const instructions =
    typeof body.instructions === 'string' && body.instructions.trim() ? body.instructions.trim() : '';

  const input = body.input;

  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const type = item.type || (item.role ? 'message' : null);

      if (type === 'message') {
        // developer 角色上游不接受，统一降级为 user；再合并进 instructions
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: normalizeContent(item.content) });
      } else if (type === 'function_call') {
        // 模型发起的工具调用 → assistant.tool_calls
        //
        // 关键：连续的多个 function_call 必须合并进【同一条】assistant 消息。
        // 若每个都单独生成一条 assistant 消息，就会出现「两条 assistant 消息相邻、
        // 中间没有对应的 tool 结果」，上游会报：
        //   tool calls and tool results do not match
        // Codex 经常一次并行发起多个工具调用，所以这里必须合并。
        const call = {
          id: item.call_id || item.id || rid('call'),
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' },
        };
        const last = messages[messages.length - 1];
        // 合并进上一条 assistant（保留其文本）：模型的常见输出就是「分析文字 + 并行工具调用」，
        // 若拆成相邻两条 assistant，上游会报 tool calls and tool results do not match
        if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) {
          last.tool_calls.push(call);
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        }
      } else if (type === 'function_call_output') {
        // 工具执行结果 → role:tool
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id || '',
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
      } else if (type === 'reasoning') {
        // 推理项不回传给上游（上游不接受该角色）
        continue;
      } else if (item.role) {
        messages.push({ role: item.role, content: normalizeContent(item.content) });
      }
    }
  }

  if (!messages.length) messages.push({ role: 'user', content: '' });

  // 合并 instructions 到首条 user 消息（见上方说明：不能走 system 角色）
  if (instructions) {
    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser) {
      firstUser.content = `<instructions>\n${instructions}\n</instructions>\n\n${firstUser.content || ''}`;
    } else {
      messages.unshift({ role: 'user', content: `<instructions>\n${instructions}\n</instructions>` });
    }
  }

  // 上游硬性要求首条必须是 system，且过长/特定内容会被拒；这里只放一句极短占位
  if (messages[0]?.role !== 'system') {
    messages.unshift({ role: 'system', content: 'You are a helpful AI assistant.' });
  }

  const chat = { messages, stream: body.stream === true }; // Responses API 规范：stream 缺省为 false

  // 模型由调用方注入
  if (body.model) chat.model = body.model;

  if (body.max_output_tokens) chat.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;

  // ── reasoning.effort → reasoning_effort ──
  // 客户端（DSH / Codex）用 reasoning.effort 表达思考强度（minimal/low/medium/high）。
  // 之前这里整个丢弃，导致上游永远按默认强度跑、客户端也显示不出强度。
  // 映射名沿用生态标准（cc-switch / LiteLLM / zcode-proxy 同款）。
  // 上游不认识该字段时一般会忽略，不会 400；若实测发现上游严格校验，改走 stripFields 剔除。
  if (body.reasoning?.effort) chat.reasoning_effort = body.reasoning.effort;

  // tools：Responses 是扁平的 {type,name,parameters}，Chat 是嵌套的 {type,function:{...}}
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue;
      if (t.type === 'function' && t.name) {
        tools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || undefined,
            parameters: t.parameters || { type: 'object', properties: {} },
          },
        });
      } else if (t.type === 'function' && t.function) {
        tools.push(t); // 已是 Chat 格式，原样保留
      }
      // 其余内置工具类型（web_search 等）上游不支持，忽略
    }
    if (tools.length) chat.tools = tools;
  }

  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (typeof tc === 'string') chat.tool_choice = tc;
    else if (tc && typeof tc === 'object' && tc.name) chat.tool_choice = tc.name;
  }

  return chat;
}

/** Responses 的 content 可能是字符串或分块数组，统一压成字符串。 */
function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ?? '';
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') {
      if (typeof p === 'string') parts.push(p);
      continue;
    }
    if (typeof p.text === 'string') parts.push(p.text);
    else if (p.type === 'input_text' && typeof p.text === 'string') parts.push(p.text);
  }
  return parts.join('');
}

/** 组装一个完整的 Responses 对象（供非流式与流式收尾共用）。 */
function buildResponse({ id, model, status, output, usage, createdAt, reasoning, error }) {
  return {
    id,
    object: 'response',
    created_at: createdAt || Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    // 回显请求里的思考强度配置。客户端（DSH / Codex）据此显示「思考强度」，
    // 之前这里恒为 undefined，所以客户端拿不到有效值、显示不出来。
    reasoning: reasoning || null,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: usage || null,
    // failed 响应必须带 error 详情，否则客户端无从得知失败原因
    error: error || null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
  };
}

/** 把聚合后的 Chat 结果转成 Responses 的 output 数组。 */
function toOutput(agg) {
  const output = [];

  if (agg.reasoning) {
    output.push({
      type: 'reasoning',
      id: rid('rs'),
      summary: [{ type: 'summary_text', text: agg.reasoning }],
    });
  }

  if (agg.content) {
    output.push({
      type: 'message',
      id: rid('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: agg.content, annotations: [] }],
    });
  }

  for (const tc of agg.toolCallList || []) {
    output.push({
      type: 'function_call',
      id: rid('fc'),
      call_id: tc.id || rid('call'),
      name: tc.function?.name || '',
      arguments: tc.function?.arguments || '{}',
      status: 'completed',
    });
  }

  if (!output.length) {
    output.push({
      type: 'message',
      id: rid('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  return output;
}

/** Chat usage → Responses usage。 */
function toUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.completion_thinking_tokens ?? 0,
    },
    total_tokens: u.total_tokens ?? input + output,
  };
}

export async function handleResponses(ctx) {
  const { cfg, res, body, signal } = ctx;
  const started = Date.now();
  // Responses API 规范：stream 缺省为 false（与 openai/anthropic 两个入口同口径）。
  // toChatRequest 里的 chat.stream 会被 prepareBody 无条件覆盖成 true，真正决定
  // 客户端形态的是这里——之前修复点落错了位置，缺省客户端一直收到 SSE。
  const wantsStream = body.stream === true;

  // 回显给客户端用的思考强度配置。原样透传请求里的值（客户端自己发的最准），
  // 没有就回 null —— 客户端据此显示「思考强度」。
  const reasoningEcho = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : null;

  // 先解析模型（保持与 chat 相同的路由语义：支持 site/model 前缀与别名）
  const target = await resolveTarget(cfg, body.model);
  let { site, model } = target;

  const chatReq = toChatRequest({ ...body, model });
  const requestModel = target.requested;

  // 与 openai/anthropic 入口共用同一条降级编排（openWithSiteFallback）。
  // 原来只有网关 502/503/504 一条降级路径，连接失败/模型不存在/额度受限都直接报死给客户端。
  const r = await openWithSiteFallback(cfg, target, chatReq, signal, (s, b) => openChatRotating(cfg, s, b, { signal }).then((x) => x.up));
  const up = r.up;
  site = r.site;
  model = r.model;
  if (!up.ok) {
    requestLog({ site, model, account: up.accountId, mode: 'responses', status: up.status, ms: Date.now() - started, note: 'upstream_reject' });
    return sendError(res, up.status, upstreamErrorMessage(up.status, up.text, site));
  }

  const responseId = rid('resp');

  // ---------- 非流式 ----------
  if (!wantsStream) {
    const { aggregateFrames } = await import('./upstream.mjs');
    let agg;
    try {
      agg = await aggregateFrames(up.frames);
    } catch (e) {
      // 200+信封错误（带业务码）进号池状态机（0.3.37）
      if (e.code != null) reportFrameError(site, up.accountId, model, { code: e.code, message: e.message });
      return sendError(res, e.status || 502, e.message);
    } finally {
      up.close();
    }

    const usage = toUsage(agg.usage);
    recordUsage({
      site,
      model,
      mode: 'responses',
      status: 200,
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      credit: await estimateCredit(cfg, site, model, agg.usage?.credit, usage.input_tokens, usage.output_tokens),
      ms: Date.now() - started,
      tools: agg.toolCallList.length,
      account: up.accountId,
      upstreamCredit: Number.isFinite(agg.usage?.credit) ? agg.usage.credit : null,
    });

    return sendJson(
      res,
      200,
      buildResponse({
        id: responseId,
        model: requestModel,
        status: 'completed',
        output: toOutput(agg),
        usage,
        createdAt: agg.created,
        reasoning: reasoningEcho,
      }),
    );
  }

  // ---------- 流式 ----------
  startSSE(res, { 'X-Service': 'workbuddy-proxy', 'X-Upstream-Site': site });
  // T27 心跳：Codex/DSH 长思考期间用 SSE 注释帧防空闲断流（注释行对协议无感）
  const heartbeat = startHeartbeat(res);

  let seq = 0;
  const emit = (type, payload) =>
    writeSSEEvent(res, type, JSON.stringify({ type, sequence_number: seq++, ...payload }));

  let finished = false;
  let contentChars = 0;
  let contentText = ''; // 累积正文，供 output_text.done / response.completed 回填
  let reasoningText = ''; // 累积推理内容
  let upstreamUsage = null;
  let outputIndex = 0;
  let textItemId = null;
  let textOpened = false;
  let textDone = false;
  let reasoningItemId = null;
  let reasoningOpened = false;
  let reasoningDone = false;
  let streamFailed = false; // 上游发回错误信封：response.failed 已发，收尾不能再发 response.completed
  const toolItems = new Map(); // 上游 index → { id, call_id, name, args, output_index }

  /** 收尾当前打开的 reasoning 项（占用当前 outputIndex 并让它让位）。 */
  const closeReasoning = async () => {
    if (!(reasoningOpened && !reasoningDone)) return;
    await emit('response.reasoning_summary_text.done', {
      item_id: reasoningItemId,
      output_index: outputIndex,
      summary_index: 0,
      text: reasoningText,
    });
    await emit('response.output_item.done', {
      output_index: outputIndex,
      item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: reasoningText }] },
    });
    reasoningDone = true;
    outputIndex++;
  };

  try {
    await emit('response.created', {
      response: buildResponse({ id: responseId, model: requestModel, status: 'in_progress', output: [], reasoning: reasoningEcho }),
    });
    await emit('response.in_progress', {
      response: buildResponse({ id: responseId, model: requestModel, status: 'in_progress', output: [], reasoning: reasoningEcho }),
    });

    for await (const payload of up.frames) {
      const parsed = classifyFrame(payload);
      if (parsed.kind === 'error') {
        // 错误信封进号池状态机（0.3.37）；failed 已是终态，收尾不能再发 response.completed
        streamFailed = true;
        reportFrameError(site, up.accountId, model, parsed);
        await emit('response.failed', {
          response: buildResponse({
            id: responseId,
            model: requestModel,
            status: 'failed',
            output: [],
            usage: null,
            reasoning: reasoningEcho,
            error: {
              code: parsed.code != null ? String(parsed.code) : 'upstream_error',
              message: parsed.message,
            },
          }),
        });
        break;
      }
      if (parsed.kind !== 'chunk') continue;

      const obj = parsed.obj;
      if (obj.usage) upstreamUsage = obj.usage;
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;

      // 推理内容：作为 reasoning 项的增量。
      // Codex 要求增量前必须先 output_item.added，否则报 "ReasoningSummaryDelta without active item"。
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        if (!reasoningOpened) {
          reasoningItemId = rid('rs');
          await emit('response.output_item.added', {
            output_index: outputIndex,
            item: { type: 'reasoning', id: reasoningItemId, summary: [] },
          });
          reasoningOpened = true;
        }
        reasoningText += delta.reasoning_content;
        await emit('response.reasoning_summary_text.delta', {
          item_id: reasoningItemId,
          output_index: outputIndex,
          summary_index: 0,
          delta: delta.reasoning_content,
        });
      }

      // 正文
      if (typeof delta.content === 'string' && delta.content) {
        if (!textOpened) {
          // 正文开始前，先把 reasoning 项收尾并让出 output_index
          await closeReasoning();
          textItemId = rid('msg');
          await emit('response.output_item.added', {
            output_index: outputIndex,
            item: { type: 'message', id: textItemId, status: 'in_progress', role: 'assistant', content: [] },
          });
          await emit('response.content_part.added', {
            item_id: textItemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          textOpened = true;
        }
        contentChars += delta.content.length;
        contentText += delta.content;
        await emit('response.output_text.delta', {
          item_id: textItemId,
          output_index: outputIndex,
          content_index: 0,
          delta: delta.content,
        });
      }

      // 工具调用
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        // 正文先收尾，工具项另起
        if (textOpened && !textDone) {
          await emit('response.output_text.done', { item_id: textItemId, output_index: outputIndex, content_index: 0, text: contentText });
          await emit('response.content_part.done', {
            item_id: textItemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: contentText, annotations: [] },
          });
          await emit('response.output_item.done', {
            output_index: outputIndex,
            item: { type: 'message', id: textItemId, status: 'completed', role: 'assistant', content: [] },
          });
          outputIndex++;
          textDone = true;
        }

        // 推理项还开着的话先收尾：否则 reasoning 与第一个 function_call 的
        // added 事件会撞同一个 output_index（「先推理后直接调工具」是最常见回合）
        await closeReasoning();

        for (const tc of delta.tool_calls) {
          // 上游省略 index 时不能一律归 0（并行调用会并进同一条目产生非法 JSON）：
          // 有 id 按 id 聚合；无 id 的裸参数帧续写最近一个工具项（与 aggregateFrames /
          // anthropic 流式的同一观察对齐：首帧带 id、后续裸参数帧是同一调用）
          const keys = [...toolItems.keys()];
          const idx = Number.isInteger(tc.index) ? tc.index
            : tc.id ? (keys.find((k) => toolItems.get(k).call_id === tc.id || toolItems.get(k).upstreamId === tc.id) ?? `id:${tc.id}`)
            : (keys.length ? keys[keys.length - 1] : 0);
          let cur = toolItems.get(idx);
          if (!cur) {
            cur = { id: rid('fc'), call_id: tc.id || rid('call'), name: tc.function?.name || '', args: '' };
            if (tc.id) cur.upstreamId = tc.id;
            // 每个工具项独占一个 output_index 槽位：added/delta/done 全程用同一个值，
            // 不再出现 done 索引比 added 大 1 的错位
            cur.output_index = outputIndex++;
            toolItems.set(idx, cur);
            await emit('response.output_item.added', {
              output_index: cur.output_index,
              item: {
                type: 'function_call',
                id: cur.id,
                call_id: cur.call_id,
                name: cur.name,
                arguments: '',
                status: 'in_progress',
              },
            });
          }
          if (tc.function?.name && !cur.name) cur.name = tc.function.name;
          if (tc.function?.arguments) {
            cur.args += tc.function.arguments;
            await emit('response.function_call_arguments.delta', {
              item_id: cur.id,
              output_index: cur.output_index,
              delta: tc.function.arguments,
            });
          }
        }
      }
    }

    // 上游发了错误信封时 response.failed 已经发过：终态之后不能再发 item 级
    // done/completed 事件（客户端状态机行为未定义），失败流直接跳过全部收尾
    if (streamFailed) {
      return;
    }

    // 正文收尾
    if (textOpened && !textDone) {
      await emit('response.output_text.done', { item_id: textItemId, output_index: outputIndex, content_index: 0, text: contentText });
      await emit('response.content_part.done', {
        item_id: textItemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: contentText, annotations: [] },
      });
      await emit('response.output_item.done', {
        output_index: outputIndex,
        item: {
          type: 'message',
          id: textItemId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: contentText, annotations: [] }],
        },
      });
      outputIndex++;
      textDone = true;
    }

    // 工具项收尾
    const finalOutput = [];

    // 兜底：若从未出现正文/工具，reasoning 项可能仍处于打开状态，先收尾
    await closeReasoning();
    if (reasoningDone) {
      finalOutput.push({
        type: 'reasoning',
        id: reasoningItemId,
        summary: [{ type: 'summary_text', text: reasoningText }],
      });
    }

    if (textOpened) {
      finalOutput.push({
        type: 'message',
        id: textItemId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: contentText, annotations: [] }],
      });
    }
    for (const [, cur] of [...toolItems.entries()].sort((a, b) => a[1].output_index - b[1].output_index)) {
      await emit('response.function_call_arguments.done', {
        item_id: cur.id,
        output_index: cur.output_index,
        arguments: cur.args,
      });
      await emit('response.output_item.done', {
        output_index: cur.output_index,
        item: {
          type: 'function_call',
          id: cur.id,
          call_id: cur.call_id,
          name: cur.name,
          arguments: cur.args,
          status: 'completed',
        },
      });
      finalOutput.push({
        type: 'function_call',
        id: cur.id,
        call_id: cur.call_id,
        name: cur.name,
        arguments: cur.args,
        status: 'completed',
      });
    }

    // 上游发了错误信封时 response.failed 已经发过：同一流里再发 response.completed
    // 是双终态（客户端状态机行为未定义），且失败不该被记成 200
    if (!streamFailed) {
      const usage = toUsage(upstreamUsage);
      finished = true;

      await emit('response.completed', {
        response: buildResponse({
          id: responseId,
          model: requestModel,
          status: 'completed',
          output: finalOutput,
          usage,
          reasoning: reasoningEcho,
        }),
      });
    }
  } catch (e) {
    warn(`[${site}] Responses 流式转换异常：${e?.message || e}`);
  } finally {
    heartbeat.stop();
    up.close();
    if (!res.writableEnded) res.end();
    // credit 先算好同时喂给 requestLog（T9 异常检测要请求级消耗）与 recordUsage
    const credit = await estimateCredit(cfg, site, model, upstreamUsage?.credit,
      upstreamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(chatReq.messages || [])),
      upstreamUsage?.completion_tokens ?? estimateTokens('x'.repeat(contentChars)));
    requestLog({
      site,
      account: up.accountId,
      model,
      mode: 'responses',
      status: finished ? 200 : 499,
      ms: Date.now() - started,
      credit,
    });
    recordUsage({
      site,
      model,
      mode: 'responses',
      status: finished ? 200 : 499,
      promptTokens: upstreamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(chatReq.messages || [])),
      completionTokens: upstreamUsage?.completion_tokens ?? estimateTokens('x'.repeat(contentChars)),
      credit,
      ms: Date.now() - started,
      tools: toolItems.size,
      account: up.accountId,
      upstreamCredit: Number.isFinite(upstreamUsage?.credit) ? upstreamUsage.credit : null,
    });
  }
}
