// OpenAI 兼容路由：/v1/models、/v1/chat/completions（流式 + 非流式，支持工具调用）
// 多站点：请求里的 model 可写裸 ID（自动选站点），也可写 `站点/模型` 显式指定。
import { openChat, openChatRotating, aggregateFrames, classifyFrame, upstreamErrorMessage, newId } from './upstream.mjs';
import { ensureToken } from './auth.mjs';
import { isQuotaError } from './pool.mjs';
import { resolveTarget, mergedModels, parseMultiplier, isExcluded, multiplierSuffixText, effectiveSuffixText } from './router.mjs';
import { recordUsage, estimateCredit, observedCostByModel } from './usage.mjs';
import { startSSE, writeSSE, sendJson, sendError, estimateTokens, startHeartbeat } from './util.mjs';
import { requestLog, warn } from './log.mjs';

/** 帧白名单重建：剥掉上游噪声（空 content、空 tool_calls、未知字段），保证标准客户端可解析。 */
export function normalizeChunk(obj, publicModel) {
  const out = {};
  for (const k of ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier']) {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  }
  if (!out.object) out.object = 'chat.completion.chunk';
  if (!out.id) out.id = newId();
  if (publicModel) out.model = publicModel;

  if (Array.isArray(obj.choices)) {
    out.choices = obj.choices.map((c) => {
      const delta = {};
      const d = c.delta || {};
      if (typeof d.role === 'string' && d.role) delta.role = d.role;
      if (typeof d.content === 'string' && d.content) delta.content = d.content;
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) delta.reasoning_content = d.reasoning_content;
      if (typeof d.refusal === 'string' && d.refusal) delta.refusal = d.refusal;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) delta.tool_calls = d.tool_calls;
      return { index: c.index ?? 0, delta, finish_reason: c.finish_reason || null };
    });
  }
  out.usage = obj.usage !== undefined ? obj.usage : null;
  return out;
}

/**
 * 发起上游请求（含账号轮换）。账号层面的处理全在 openChatRotating 里：
 * 401 先原地刷 token，仍失败则换号；这里只负责把结果交给上层做站点降级。
 */
async function openWithRetry(cfg, site, body, signal, opts = {}) {
  const r = await openChatRotating(cfg, site, body, { signal, ...opts });
  return r.up;
}

/** 判断上游错误是否为「该站点没有这个模型」，据此触发站点降级。 */
export function isModelNotFound(status, text) {
  return status === 400 && /service info not found|model \[[^\]]+\] .*not found|no such model/i.test(String(text || ''));
}

/** 判断是否为「连接级失败」（网络抖动、连接被重置），同样触发站点降级。 */
export function isTransportFailure(e) {
  return e?.transport === true || e?.status === 504 || /ECONNRESET|UND_ERR_SOCKET|fetch failed|连接失败/i.test(String(e?.message || ''));
}

/**
 * 判断是否为「上游网关故障」：openresty / APISIX 在回源失败时直接返回的 HTTP 502/503/504。
 * 这类错误是「响应级」的——openChat 正常返回 { ok:false, status }，不抛异常，
 * 因此走不到上面 isTransportFailure 的异常分支；但同样属于站点级故障，必须触发降级。
 */
export function isGatewayError(status) {
  return status === 502 || status === 503 || status === 504;
}

/**
 * 三协议（OpenAI / Anthropic / Responses）共用的站点降级编排。
 *
 * 为什么抽出来：这四条降级路径原本在 openai / anthropic / responses 三个入口各复制一份，
 * 已经出过一次微妙的 bug（openWithFallback 曾返回 { up } 包装而 anthropic 的复制版直接
 * 用裸 up，两边语义悄悄分叉），抽成一处后新增降级路径（比如额度层换站）只改这里。
 *
 * 首次打开用调用方给的 opener；四条路径按固定顺序检查，命中即换备用站点重试一次：
 *   1. 连接级失败（异常抛出）—— opener 抛错时判定
 *   2. 钉站点没有该模型（400 model not found）
 *   3. 网关 502/503/504
 *   4. 额度层 402/quota 文案（受 pool.switchSiteOnExhausted 开关控制）
 *
 * 第 4 条不再包含裸 429：上游的 429 是「限流/模型繁忙」（14003），换站治不了限流，
 * 真正的兜底是 coordination.mjs 的全局冷静窗。带额度文案的 429 仍会命中。
 *
 * 返回 { up, site, model }；up.ok=false 时错误文案里同时带原站点与备用站点的原因。
 * 每条路径只重试一次：已降到备用站点后（site === fallback.site）不再重复触发。
 */
export async function openWithSiteFallback(cfg, target, upstreamBody, signal, opener, { logMode = 'stream' } = {}) {
  let { site, model } = target;
  let up;
  try {
    up = await opener(site, upstreamBody);
  } catch (e) {
    if (target.fallback && isTransportFailure(e) && !signal?.aborted) {
      const r = await openWithFallback(cfg, target, upstreamBody, signal, `连接失败（${e?.cause?.code || e?.message}）`);
      up = r.up;
      site = r.site;
      model = r.model;
    } else if (cfg.pool?.switchSiteOnExhausted && target.fallback && !signal?.aborted) {
      // 连接级失败且整站账号已耗尽 → 也换站点试一次
      const r = await openWithFallback(cfg, target, upstreamBody, signal, '本站点账号额度不足');
      up = r.up;
      site = r.site;
      model = r.model;
    } else {
      throw e;
    }
  }

  // 路由表把模型钉到了某站点，但那个站点其实没有这个模型 → 换到真正拥有该模型的站点
  if (!up.ok && target.fallback && isModelNotFound(up.status, up.text)) {
    const r = await openWithFallback(cfg, target, upstreamBody, signal, `没有模型 ${model}`);
    up = r.up;
    site = r.site;
    model = r.model;
  }
  // 上游网关故障（openresty/APISIX 回源失败返回 502/503/504）→ 换备用站点。
  // site !== fallback 判断避免降级后对同一站点重复重试。
  if (!up.ok && target.fallback && site !== target.fallback.site && isGatewayError(up.status)) {
    const r = await openWithFallback(cfg, target, upstreamBody, signal, `上游网关 ${up.status}`);
    up = r.up;
    site = r.site;
    model = r.model;
  }
  // 额度层被挡（402 积分不足 / quota 文案 / 带额度语义的 429）→ 换还有额度的备用站点。
  // 注意 openChatRotating 对 HTTP 错误是 return 而不是 throw，这类情况进不了上面的 catch。
  // 裸 429（14003 限流/模型繁忙）刻意不进这里：换站治不了限流，交给上游冷静窗。
  if (!up.ok && target.fallback && site !== target.fallback.site && !signal?.aborted && isQuotaError(up.status, up.text)) {
    if (cfg.pool?.switchSiteOnExhausted !== false) {
      const r = await openWithFallback(cfg, target, upstreamBody, signal, `本站点额度受限（HTTP ${up.status}）`);
      up = r.up;
      site = r.site;
      model = r.model;
    }
  }
  return { up, site, model };
}

/** 换个站点重试同一请求（用于降级）。换站点后账号池也换了一套，因此 exclude 重置。 */
async function openWithFallback(cfg, target, upstreamBody, signal, 原因) {
  const 目标站点 = target.fallback.site;
  warn(`[${target.site}] ${原因}，自动降级到备用站点 ${目标站点} 重试`);
  upstreamBody.model = target.fallback.model;
  try {
    // 注意：openWithRetry 直接返回 up 句柄本身（不是 { up } 包装）。
    // 这里曾写成 `const r = await openWithRetry(...); return { up: r.up, ... }`，
    // 于是 r.up 恒为 undefined，四条降级路径全都在上层的 `up.ok` 处抛
    // TypeError: Cannot read properties of undefined (reading 'ok')。
    const up = await openWithRetry(cfg, 目标站点, upstreamBody, signal);
    return { up, site: 目标站点, model: target.fallback.model };
  } catch (e) {
    // 备用站点自己也没连上。**不能把异常抛出去**：那会越过下面所有 `up.ok` 判断，
    // 变成 handleChatCompletions 未捕获的异常 → 客户端只看到一句「处理失败」，
    // 既不知道原站点为什么失败，也不知道备用站点为什么失败。
    // 这里造一个「失败形态」的 up（字段与上游返回的失败结构一致），
    // 让调用方照常走统一的 !up.ok 分支，错误信息里两个原因都在。
    const 备用原因 = e?.cause?.code || e?.message || String(e);
    warn(`[${目标站点}] 备用站点同样失败：${备用原因}`);
    return {
      up: {
        ok: false,
        status: e?.status || 504,
        text: `降级前：${原因}；备用站点 ${目标站点} 也失败：${备用原因}`,
        site: 目标站点,
      },
      site: 目标站点,
      model: target.fallback.model,
    };
  }
}

export async function handleChatCompletions(ctx) {
  const { cfg, res, body, signal } = ctx;
  const target = await resolveTarget(cfg, body.model);
  let { site, model } = target;
  const publicModel = target.requested;
  const wantsStream = body.stream === true;
  const started = Date.now();
  let ttfb = null;
  let tools = 0;
  let contentChars = 0;

  const upstreamBody = { ...body, model };
  if (upstreamBody.max_tokens === undefined && upstreamBody.max_completion_tokens === undefined) {
    upstreamBody.max_tokens = cfg.defaultMaxTokens;
  }

  const r = await openWithSiteFallback(cfg, target, upstreamBody, signal, (s, b) => openWithRetry(cfg, s, b, signal));
  let up = r.up;
  site = r.site;
  model = r.model;
  if (!up.ok) {
    requestLog({ site, model, account: up.accountId, mode: wantsStream ? 'stream' : 'json', status: up.status, ms: Date.now() - started, note: 'upstream_reject' });
    return sendError(res, up.status, upstreamErrorMessage(up.status, up.text, site));
  }

  if (wantsStream) {
    startSSE(res, { 'X-Service': 'workbuddy-proxy', 'X-Upstream-Site': site });
    // T27 心跳：高推理强度模型首字/帧间隔可达数分钟，SSE 注释帧防客户端空闲超时断流
    const heartbeat = startHeartbeat(res);
    let valid = 0;
    let finished = false;
    let upstreamUsage = null;
    try {
      for await (const payload of up.frames) {
        const parsed = classifyFrame(payload);
        if (parsed.kind === 'error') {
          await writeSSE(res, JSON.stringify({ error: { message: parsed.message, type: 'upstream_error' } }));
          break;
        }
        if (parsed.kind !== 'chunk') continue;
        if (parsed.obj.usage) upstreamUsage = parsed.obj.usage;
        if (parsed.obj.choices?.[0]?.delta?.tool_calls) tools++;
        if (ttfb === null) ttfb = Date.now() - started;
        valid++;
        if (parsed.obj.choices?.[0]?.delta?.content) contentChars += parsed.obj.choices[0].delta.content.length;
        await writeSSE(res, JSON.stringify(normalizeChunk(parsed.obj, publicModel)));
      }
      if (valid === 0) {
        await writeSSE(res, JSON.stringify({ error: { message: '上游返回空流', type: 'upstream_error' } }));
      }
      finished = true;
      await writeSSE(res, '[DONE]');
    } finally {
      heartbeat.stop();
      up.close();
      if (!res.writableEnded) res.end();
      const streamMs = Date.now() - started;
      const outTok = upstreamUsage?.completion_tokens ?? estimateTokens('x'.repeat(contentChars));
      // credit 先算好同时喂给 requestLog（T9 异常检测要请求级消耗）与 recordUsage
      const credit = await estimateCredit(cfg, site, model, upstreamUsage?.credit,
        upstreamUsage?.prompt_tokens ?? 0, upstreamUsage?.completion_tokens ?? 0);
      requestLog({
        site,
        account: up.accountId,
        model,
        mode: 'stream',
        status: finished ? 200 : 499,
        ttfb_ms: ttfb ?? '-',
        ms: streamMs,
        tok_s: outTok && streamMs > 0 ? (outTok / (streamMs / 1000)).toFixed(1) : undefined,
        frames: valid,
        credit,
      });
      recordUsage({
        site,
        model,
        mode: 'stream',
        status: finished ? 200 : 499,
        promptTokens: upstreamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages || [])),
        completionTokens: outTok,
        credit,
        ms: streamMs,
        tools,
        account: up.accountId,
      });
    }
    return;
  }

  // 非流式：聚合上游 SSE 后一次性返回
  let agg;
  try {
    agg = await aggregateFrames(up.frames);
  } catch (e) {
    requestLog({ site, model, account: up.accountId, mode: 'json', status: e.status || 502, ms: Date.now() - started, note: 'aggregate_failed' });
    return sendError(res, e.status || 502, e.message);
  } finally {
    up.close();
  }

  // 兜底：客户端 max_tokens 太小（思考型模型把预算全用在思考上）导致空回答时，放大预算重试一次
  const askedMax = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
  const emptyAnswer = !agg.content && agg.toolCallList.length === 0;
  if (emptyAnswer && (agg.finishReason === 'length' || agg.frames > 0) && askedMax > 0 && askedMax < 1024) {
    const bumped = { ...upstreamBody, max_tokens: Math.max(1024, askedMax * 4) };
    delete bumped.max_completion_tokens;
    warn(`[${site}] 空回答（finish=${agg.finishReason}，max_tokens=${askedMax}），放大到 ${bumped.max_tokens} 重试一次`);
    const up2 = await openWithRetry(cfg, site, bumped, signal);
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

  if (agg.frames === 0) {
    requestLog({ site, model, account: up.accountId, mode: 'json', status: 502, ms: Date.now() - started, note: 'empty_stream' });
    return sendError(res, 502, '上游返回空响应');
  }

  const message = { role: agg.role || 'assistant' };
  if (agg.content) message.content = agg.content;
  else message.content = agg.toolCallList.length ? null : '';
  if (agg.reasoning) message.reasoning_content = agg.reasoning;
  if (agg.toolCallList.length) {
    message.tool_calls = agg.toolCallList.map((tc, i) => ({
      id: tc.id || `call_${i}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
    }));
  }

  const usage =
    agg.usage ||
    {
      prompt_tokens: estimateTokens(JSON.stringify(body.messages || [])),
      completion_tokens: estimateTokens(agg.content),
      total_tokens: estimateTokens(JSON.stringify(body.messages || [])) + estimateTokens(agg.content),
    };

  // credit 先算好同时喂给 requestLog（T9 异常检测要请求级消耗）与 recordUsage
  const credit = await estimateCredit(cfg, site, model, usage.credit, usage.prompt_tokens, usage.completion_tokens);

  requestLog({
    site,
    account: up.accountId,
    model,
    mode: 'json',
    status: 200,
    ms: Date.now() - started,
    tok_s: usage.completion_tokens && Date.now() - started > 0 ? (usage.completion_tokens / ((Date.now() - started) / 1000)).toFixed(1) : undefined,
    prompt: usage.prompt_tokens,
    completion: usage.completion_tokens,
    tools: agg.toolCallList.length || undefined,
    credit,
  });

  recordUsage({
    site,
    model,
    mode: 'json',
    status: 200,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    credit,
    ms: Date.now() - started,
    tools: agg.toolCallList.length,
    account: up.accountId,
  });

  sendJson(res, 200, {
    id: agg.id || newId(),
    object: 'chat.completion',
    created: agg.created || Math.floor(Date.now() / 1000),
    model: publicModel,
    choices: [{ index: 0, message, finish_reason: agg.finishReason || 'stop' }],
    usage,
  });
}

export async function handleModels(ctx) {
  const { cfg, res } = ctx;
  const merged = await mergedModels(cfg);
  const obs = observedCostByModel(); // 观测成本（0.3.33）：最近一次实际计费，驱动后缀与实测展示
  const data = [];
  const seen = new Set();

  // 别名：先解析到真实模型，若目标已被白/黑名单剔除，就不要再列进目录
  // （否则客户端会照目录逐个探测，必然失败）
  for (const [alias, targetModel] of Object.entries(cfg.modelAliases || {})) {
    if (seen.has(alias)) continue;
    try {
      const t = await resolveTarget(cfg, alias);
      if (isExcluded(cfg, t.site, t.model)) continue;
    } catch {
      continue; // 解析不了（目标被剔除等）就不列出
    }
    seen.add(alias);
    data.push({ id: alias, object: 'model', created: 1700000000, owned_by: 'workbuddy', name: `${alias} → ${targetModel}` });
  }

  for (const m of merged) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const info = m.info || {};
    const item = {
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: m.site,
      name: info.name || m.id,
      site: m.site,
    };
    let mult;
    if (info.credits) {
      item.credits = info.credits; // 上游原始串，如 "x0.79 credits"
      mult = parseMultiplier(info.credits);
      if (Number.isFinite(mult)) item.credits_multiplier = mult;
    }
    if (info.badges?.length) item.badges = info.badges; // 促销徽标（限时免费/夜间免费…）
    const observed = obs?.[`${m.site}/${m.id}`] || null;
    if (observed) item.observed = { credit: observed.credit, at: observed.at };
    if (info.contextWindow) item.context_window = info.contextWindow;
    if (info.maxTokens) item.max_output_tokens = info.maxTokens;
    if (info.supportsImages) item.supports_images = true;
    if (info.supportsToolCall) item.supports_tools = true;
    if (m.aliasOf) item.alias_of = m.aliasOf;
    // 选择器倍率展示：把倍率编码进 ID 后缀（如 "glm-5.3-flash (x0.06)"），
    // 调用端 resolveTargetInner 会剥掉后缀，所以两种写法都能调。
    // 0.3.33：有新鲜观测且实付 0 时后缀显示 (免费)——夜间免费模型的目录价只是日间价。
    if (cfg.pickerMultiplierSuffix !== false) {
      const suffix = effectiveSuffixText(mult, observed);
      if (suffix) {
        item.id = m.id + suffix;
        item.name = (info.name || m.id) + suffix;
      }
    }
    data.push(item);
  }

  // 目录拉取失败（未登录/接口不可用）时用配置兜底，保证客户端至少能看到可用 ID
  if (!merged.length) {
    for (const m of cfg.models || []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      data.push({ id: m.id, object: 'model', created: 1700000000, owned_by: 'workbuddy', name: m.name || m.id, site: cfg.defaultSite });
    }
  }

  sendJson(res, 200, { object: 'list', data, source: merged.length ? 'upstream' : 'config' });
}
