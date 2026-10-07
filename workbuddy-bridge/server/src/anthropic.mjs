// Anthropic 兼容路由：/v1/messages、/v1/messages/count_tokens
// Trae 的「Claude 型自定义模型」走 Anthropic Messages 协议，这里做双向转换。
import { openChat, openChatRotating, aggregateFrames, classifyFrame, upstreamErrorMessage, newId, reportFrameError } from './upstream.mjs';
import { resolveTarget } from './router.mjs';
import { openWithSiteFallback } from './openai.mjs';
import { recordUsage, estimateCredit } from './usage.mjs';
import { startSSE, writeSSEEvent, sendJson, sendError, writeAsync, estimateTokens, startHeartbeat } from './util.mjs';
import { requestLog, warn } from './log.mjs';

const stopReasonMap = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

function textFromBlocks(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('');
}

/** Anthropic Messages 请求 → OpenAI Chat Completions 请求 */
export function toOpenAIBody(a) {
  const messages = [];
  const system = typeof a.system === 'string' ? a.system : textFromBlocks(a.system);
  if (system && system.trim()) messages.push({ role: 'system', content: system });

  for (const m of a.messages || []) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = textFromBlocks(blocks);
      const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
      const msg = { role: 'assistant', content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t, i) => ({
          id: t.id || `call_${i}`,
          type: 'function',
          function: { name: t.name, arguments: typeof t.input === 'string' ? t.input : JSON.stringify(t.input ?? {}) },
        }));
      }
      messages.push(msg);
      continue;
    }

    // user：可能同时含 tool_result 与普通内容，工具结果必须先于后续用户文本
    const parts = [];
    const toolResults = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image' && b.source) {
        const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url;
        parts.push({ type: 'image_url', image_url: { url } });
      } else if (b.type === 'tool_result') toolResults.push(b);
    }
    for (const r of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: r.tool_use_id,
        content: typeof r.content === 'string' ? r.content : textFromBlocks(r.content) || JSON.stringify(r.content ?? ''),
      });
    }
    if (parts.length) {
      const onlyText = parts.length === 1 && parts[0].type === 'text';
      messages.push({ role: 'user', content: onlyText ? parts[0].text : parts });
    }
  }

  const body = {
    model: a.model,
    messages,
    stream: a.stream !== false,
  };
  if (a.max_tokens) body.max_tokens = a.max_tokens;
  if (a.temperature !== undefined) body.temperature = a.temperature;
  if (a.top_p !== undefined) body.top_p = a.top_p;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) body.stop = a.stop_sequences;
  if (Array.isArray(a.tools) && a.tools.length) {
    body.tools = a.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
      }));
  }
  if (a.tool_choice) {
    const tc = a.tool_choice;
    if (tc.type === 'any') body.tool_choice = 'required';
    else if (tc.type === 'tool' && tc.name) body.tool_choice = tc.name;
    else if (tc.type === 'none') body.tool_choice = 'none';
    else body.tool_choice = 'auto';
  }
  return body;
}

function parseArgs(str) {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

function usageOf(usage, fallbackIn, fallbackOut) {
  return {
    input_tokens: usage?.prompt_tokens ?? fallbackIn ?? 0,
    output_tokens: usage?.completion_tokens ?? fallbackOut ?? 0,
  };
}

export async function handleMessages(ctx) {
  const { cfg, res, body, signal } = ctx;
  const publicModel = body.model || cfg.defaultModel;
  const wantsStream = body.stream === true; // 与 Anthropic 规范一致：缺省为非流式
  const started = Date.now();
  const target = await resolveTarget(cfg, publicModel);
  let { site, model } = target;
  const openaiBody = toOpenAIBody({ ...body, model });
  if (openaiBody.max_tokens === undefined) openaiBody.max_tokens = cfg.defaultMaxTokens;

  // 与 openai/responses 入口共用同一条降级编排（openWithSiteFallback）：
  // 连接失败 / 模型不存在 / 网关 5xx / 额度 429·402 四条路径在这里统一处理，
  // 补齐了原实现缺的「额度层换站」——429/402 是 return 不是 throw，原来根本进不了降级。
  const r = await openWithSiteFallback(
    cfg,
    target,
    openaiBody,
    signal,
    (s, b) => openChatRotating(cfg, s, b, { signal }).then((x) => x.up)
  );
  const up = r.up;
  site = r.site;
  model = r.model;
  if (!up.ok) {
    requestLog({ site, model, account: up.accountId, mode: wantsStream ? 'anthropic-stream' : 'anthropic-json', status: up.status, ms: Date.now() - started, note: 'upstream_reject' });
    return sendError(res, up.status, upstreamErrorMessage(up.status, up.text, site), 'api_error');
  }

  if (!wantsStream) {
    let agg;
    try {
      agg = await aggregateFrames(up.frames);
    } catch (e) {
      // 200+信封错误（带业务码）进号池状态机（0.3.37）
      if (e.code != null) reportFrameError(site, up.accountId, model, { code: e.code, message: e.message });
      return sendError(res, e.status || 502, e.message, 'api_error');
    } finally {
      up.close();
    }
    // 兜底：max_tokens 过小导致空回答时放大预算重试一次。
    // 加 frames/finish 守卫：零帧空流（上游异常）重试也是空流，白打一次计费请求
    const askedMax = Number(body.max_tokens ?? 0);
    if (!agg.content && agg.toolCallList.length === 0 && (agg.finishReason === 'length' || agg.frames > 0) && askedMax > 0 && askedMax < 1024) {
      warn(`[${site}] 空回答（finish=${agg.finishReason}，max_tokens=${askedMax}），放大到 1024 重试一次`);
      const up2 = await openChat(cfg, site, { ...openaiBody, max_tokens: Math.max(1024, askedMax * 4) }, { signal });
      if (up2.ok) {
        try {
          agg = await aggregateFrames(up2.frames);
        } catch {
          /* 保留原结果 */
        } finally {
          up2.close();
        }
      } else {
        up2.close?.();
      }
    }
    const content = [];
    if (agg.content) content.push({ type: 'text', text: agg.content });
    for (const tc of agg.toolCallList) {
      content.push({ type: 'tool_use', id: tc.id || newId('toolu'), name: tc.function.name, input: parseArgs(tc.function.arguments) });
    }
    // credit 先算好同时喂给 requestLog（T9 异常检测要请求级消耗）与 recordUsage；
    // token 兜底用本地估算，recordUsage 的 upstreamCredit 只收上游实报（估算 0 不进观测样本）
    const credit = await estimateCredit(cfg, site, model, agg.usage?.credit,
      agg.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages || [])),
      agg.usage?.completion_tokens ?? estimateTokens(agg.content));
    requestLog({ site, model, account: up.accountId, mode: 'anthropic-json', status: 200, ms: Date.now() - started, credit });
    recordUsage({
      site,
      model,
      mode: 'anthropic-json',
      status: 200,
      promptTokens: agg.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages || [])),
      completionTokens: agg.usage?.completion_tokens ?? estimateTokens(agg.content),
      credit,
      ms: Date.now() - started,
      tools: agg.toolCallList.length,
      account: up.accountId,
      upstreamCredit: Number.isFinite(agg.usage?.credit) ? agg.usage.credit : null,
    });
    return sendJson(res, 200, {
      id: newId('msg'),
      type: 'message',
      role: 'assistant',
      model: publicModel,
      content: content.length ? content : [{ type: 'text', text: '' }],
      // 上游异常地以 stop/null 结束但带着工具调用时，按 tool_use 终态回给客户端
      stop_reason: stopReasonMap[agg.finishReason] || (agg.toolCallList.length ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: usageOf(agg.usage, estimateTokens(JSON.stringify(body.messages || [])), estimateTokens(agg.content)),
    });
  }

  // 流式：把 OpenAI 增量翻译成 Anthropic SSE 事件序列
  startSSE(res, { 'X-Service': 'workbuddy-proxy', 'X-Upstream-Site': site });
  // T27 心跳：Anthropic 协议里 SSE 注释行同样合法且被客户端忽略
  const heartbeat = startHeartbeat(res);
  const msgId = newId('msg');
  let blockIndex = -1; // 当前打开的内容块
  let textBlockOpened = false;
  let nextBlock = 0;
  const toolBlocks = new Map(); // 上游 tool_call 聚合键（index 或 id）→ anthropic block index
  let lastToolKey = null; // 最近打开的工具块聚合键（无 index/无 id 的裸参数帧续写它）
  let finishReason = null;
  let usage = null;
  let textLen = 0;
  let closed = false;

  const emit = (event, data) => writeSSEEvent(res, event, JSON.stringify(data));

  const closeBlock = async () => {
    if (blockIndex >= 0) {
      await emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex = -1;
    }
  };

  try {
    await emit('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: publicModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: estimateTokens(JSON.stringify(body.messages || [])), output_tokens: 0 },
      },
    });

      for await (const payload of up.frames) {
        const parsed = classifyFrame(payload);
        if (parsed.kind === 'error') {
          // 200 + 错误信封也要进号池状态机：否则同一账号既不轮换也不冷却（0.3.37）
          reportFrameError(site, up.accountId, model, parsed);
          await emit('error', { type: 'error', error: { type: 'api_error', message: parsed.message } });
          closed = true;
          break;
        }
      if (parsed.kind !== 'chunk') continue;
      const chunk = parsed.obj;
      if (chunk.usage) usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      if (typeof delta.content === 'string' && delta.content) {
        if (!textBlockOpened) {
          await closeBlock();
          blockIndex = nextBlock++;
          textBlockOpened = true;
          await emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
        }
        textLen += delta.content.length;
        await emit('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          // 上游省略 index 时不能一律归 0（并行调用的参数会拼进同一条目）：
          // 有 id 按 id 聚合；无 id 的裸参数帧续写最近打开的工具块。
          // 开新工具块意味着当前文本块（若有）已关闭——必须复位 textBlockOpened，
          // 否则其后再来正文增量会以 text_delta 写进工具块（块类型错乱）
          const key = Number.isInteger(tc.index) ? `i${tc.index}`
            : tc.id ? `id:${tc.id}`
            : (lastToolKey ?? 'i0');
          let bi = toolBlocks.get(key);
          if (bi === undefined) {
            await closeBlock();
            textBlockOpened = false;
            bi = nextBlock++;
            toolBlocks.set(key, bi);
            lastToolKey = key;
            blockIndex = bi;
            await emit('content_block_start', {
              type: 'content_block_start',
              index: bi,
              content_block: { type: 'tool_use', id: tc.id || newId('toolu'), name: tc.function?.name || '' },
            });
          }
          const args = tc.function?.arguments;
          if (args) {
            await emit('content_block_delta', {
              type: 'content_block_delta',
              index: bi,
              delta: { type: 'partial_json', partial_json: args },
            });
          }
        }
      }
    }

    if (!closed) {
      await closeBlock();
      await emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReasonMap[finishReason] || (toolBlocks.size ? 'tool_use' : 'end_turn'), stop_sequence: null },
        usage: { output_tokens: usage?.completion_tokens ?? Math.max(1, Math.ceil(textLen / 3)) },
      });
      await emit('message_stop', { type: 'message_stop' });
    }
  } catch (e) {
    warn('Anthropic 流式转发异常：', e.message);
    if (!res.writableEnded) {
      await emit('error', { type: 'error', error: { type: 'api_error', message: e.message } }).catch(() => {});
    }
  } finally {
    heartbeat.stop();
    up.close();
    if (!res.writableEnded) res.end();
    // credit 先算好同时喂给 requestLog（T9 异常检测要请求级消耗）与 recordUsage；
    // token 兜底用本地估算，recordUsage 的 upstreamCredit 只收上游实报（估算 0 不进观测样本）
    const credit = await estimateCredit(cfg, site, model, usage?.credit,
      usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages || [])),
      usage?.completion_tokens ?? Math.max(1, Math.ceil(textLen / 3)));
    requestLog({ site, model, account: up.accountId, mode: 'anthropic-stream', status: closed ? 502 : 200, ms: Date.now() - started, blocks: nextBlock, credit });
    recordUsage({
      site,
      model,
      mode: 'anthropic-stream',
      status: closed ? 502 : 200,
      promptTokens: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages || [])),
      completionTokens: usage?.completion_tokens ?? Math.max(1, Math.ceil(textLen / 3)),
      credit,
      ms: Date.now() - started,
      tools: toolBlocks.size,
      account: up.accountId,
      upstreamCredit: Number.isFinite(usage?.credit) ? usage.credit : null,
    });
  }
}

export function handleCountTokens(ctx) {
  const { body, res } = ctx;
  // base64 图片数据按「3 字符 ≈ 1 token」估会膨胀几个数量级（1MB 图 ≈ 33 万 tok）。
  // 剔掉 data 字段按纯文本估，每张图补固定 1600 tok（约 1092px 方图，Anthropic 口径的量级）。
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const imageCount = msgs.reduce(
    (s, m) => s + (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'image').length : 0),
    0,
  );
  const stripped = JSON.parse(JSON.stringify(msgs).replace(/"data"\s*:\s*"[A-Za-z0-9+/=]+"/g, '"data":""'));
  const text = JSON.stringify(body.system || '') + JSON.stringify(stripped) + JSON.stringify(body.tools || '');
  sendJson(res, 200, { input_tokens: estimateTokens(text) + imageCount * 1600 });
}
