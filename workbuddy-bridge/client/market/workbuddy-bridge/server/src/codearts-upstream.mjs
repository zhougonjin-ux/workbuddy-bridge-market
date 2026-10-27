// CodeArts 站点的上游调用层（0.3.66）：对齐 upstream.mjs 的 openChat 契约
//（返回 { ok, status, site, accountId, payload, frames, close } / { ok:false, status, text }），
// 但走华为云 AK/SK 签名而不是 Bearer token，401/403 触发 STS 刷新而非 refreshToken。
// 账号轮换复用 openChatRotating 的语义（本模块只做单次 openChat；轮换在上层）。
import { createHash } from 'node:crypto';
import { log, warn } from './log.mjs';
import { recordEvent } from './events.mjs';
import { markSuccess, updateTokens, listAccounts, getAccount } from './pool.mjs';
import {
  signRequestHuawei, wireHeadersFromSigned,
  CODEARTS_CHAT_BASE, CODEARTS_OPENGW_CONFIG_URL, CODEARTS_SNAP_BUILTIN_URL,
  codeartsNormalizeModelId, codeartsContextWindow, codeartsFetchCatalog,
  codeartsExchangeRefreshToken, codeartsRefreshExpiresAt, codeartsExpiresFromCredential,
} from './codearts.mjs';

const MAX_OUTPUT_TOKENS = 65_536; // 上游实测：65536 可用，131072 触发空流被拒（上游注释实证）

/** 华为上游对 function.name 的硬限制（实测报错 InferHub.001001017.413：maximum is 64）。 */
export const MAX_TOOL_NAME_LEN = 64;

/**
 * ZCode 的 MCP 工具名普遍超长，例如
 *   mcp__plugin_workbuddy-bridge_workbuddy-bridge__wb_refresh_credits（70 字符）
 * 直接发给 CodeArts 会被整条请求拒绝（用户看到的就是「模型不通 / reason=unknown」）。
 *
 * 这里在发上游前把超长名字压成 `t_<工具名>_<hash6>`，并保留 短名→原名 映射；
 * 回包的 tool_calls.function.name 再还原成原名——客户端完全无感。
 * 只改 tools 定义、tool_choice，以及 messages 里历史 tool_calls 的 name。
 */
export function compactToolNames(body) {
  const origByShort = new Map();
  const shortByOrig = new Map();
  const used = new Set();
  const shorten = (name) => {
    if (typeof name !== 'string' || name.length <= MAX_TOOL_NAME_LEN) return name;
    if (shortByOrig.has(name)) return shortByOrig.get(name);
    const tail = (name.split('__').pop() || 'tool').replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
    const hash = createHash('sha1').update(name).digest('hex').slice(0, 6);
    let short = `t_${tail.slice(-44)}_${hash}`;
    if (short.length > MAX_TOOL_NAME_LEN) short = `t_${tail.slice(-40)}_${hash}`;
    let n = 0;
    while (used.has(short)) {
      n += 1;
      short = `t_${tail.slice(-38)}_${hash}${n}`;
      if (short.length > MAX_TOOL_NAME_LEN) short = `t_${hash}${n}`;
    }
    used.add(short);
    shortByOrig.set(name, short);
    origByShort.set(short, name);
    return short;
  };

  const out = { ...body };
  if (Array.isArray(body?.tools)) {
    out.tools = body.tools.map((t) => (t?.function
      ? { ...t, function: { ...t.function, name: shorten(t.function.name) } }
      : t));
  }
  if (body?.tool_choice?.function?.name) {
    out.tool_choice = {
      ...body.tool_choice,
      function: { ...body.tool_choice.function, name: shorten(body.tool_choice.function.name) },
    };
  }
  if (Array.isArray(body?.messages)) {
    out.messages = body.messages.map((m) => {
      let msg = m;
      if (Array.isArray(m?.tool_calls)) {
        msg = {
          ...msg,
          tool_calls: m.tool_calls.map((tc) => (tc?.function?.name
            ? { ...tc, function: { ...tc.function, name: shorten(tc.function.name) } }
            : tc)),
        };
      }
      if (m?.role === 'tool' && typeof m.name === 'string') {
        msg = { ...msg, name: shorten(m.name) };
      }
      return msg;
    });
  }
  return { body: out, origByShort };
}

/** 把上游回包里的短工具名还原成原名（流式逐帧做，聚合走同一 generator）。 */
export function restoreToolNames(frames, origByShort) {
  if (!origByShort || origByShort.size === 0) return frames;
  return (async function* restore() {
    for await (const raw of frames) {
      let out = raw;
      try {
        const obj = JSON.parse(raw);
        let changed = false;
        for (const ch of obj?.choices || []) {
          const lists = [ch?.delta?.tool_calls, ch?.message?.tool_calls].filter(Array.isArray);
          for (const list of lists) {
            for (const tc of list) {
              const n = tc?.function?.name;
              if (n && origByShort.has(n)) {
                tc.function.name = origByShort.get(n);
                changed = true;
              }
            }
          }
        }
        if (changed) out = JSON.stringify(obj);
      } catch { /* 错误信封/非 JSON：原样透传 */ }
      yield out;
    }
  })();
}

/** 鉴权失效判定：401/403，或华为 APIG 对过期 STS 返回的 400 + APIG.0602。 */
export function isAuthDeadResponse(status, text = '') {
  return status === 401 || status === 403
    || /APIG\.0602|security token (?:has )?expired|token[^"]*expired|invalid\s+token/i.test(String(text || ''));
}

/**
 * 排队/限流判定（借鉴 dsh channel-pack 的 isQueueError / isSseQueueErrorCode）。
 *
 * 覆盖两种形态：
 *   - HTTP 400 纯文本：TM.00001041「并发会话数已达上限」、peak hours 等
 *   - HTTP 200 + SSE 内嵌 error_code：同样的码 + 429 家族
 * 这些错误等一会儿就会好，应该排队重试而不是把 502 丢给用户。
 */
export function isQueueErrorCode(code = '', message = '') {
  const s = `${code || ''} ${message || ''}`;
  return /TM\.00001041|81111|TPM|(^|[^0-9])429([^0-9]|$)|rate.?limit|too.?many.?requests|排队|限流|peak\s+usage|try\s+again\s+after|peak\s+hours|high\s+demand/i.test(s);
}

/** 额度耗尽判定：排队救不了，应换号/换站或直接告诉用户。 */
export function isQuotaErrorCode(code = '', message = '') {
  return /4291|insufficient[\s_-]+quota/i.test(`${code || ''} ${message || ''}`);
}

/**
 * tool_choice 规范化（对齐 dsh channel-pack 的 normalizeToolChoice）。
 *
 * 华为上游只接受字符串形态；对象形式会报 InferHub.001001005.400。注意
 * `{type:'function', function:{name}}` 应转成「具名工具字符串」而不是
 * required —— required 会放宽成「可以调别的工具」，语义变了。
 */
export function normalizeToolChoice(body) {
  const tc = body?.tool_choice;
  if (tc === undefined) return body;
  const suppressTools = () => {
    delete body.tools;
    delete body.functions;
  };
  if (typeof tc === 'string') {
    if (tc.toLowerCase().trim() === 'none') {
      delete body.tool_choice;
      suppressTools();
    }
    return body;
  }
  if (tc && typeof tc === 'object') {
    const type = String(tc.type || '').toLowerCase().trim();
    if (type === 'none') {
      delete body.tool_choice;
      suppressTools();
    } else if (type === 'auto' || type === 'required') {
      body.tool_choice = type;
    } else if (type === 'function') {
      // dsh 的 normalizeToolChoice 会转成具名工具字符串；但 CodeArts 实测
      // （2026-10-27 16:06）连 "t_wb_..." 也报 InferHub.001001005.400，
      // 只接受 auto/none/required。退回 required：语义是「必须调工具」，
      // 比丢弃 tool_choice 更接近原意，且实测可用。
      body.tool_choice = 'required';
    } else {
      delete body.tool_choice;
    }
    return body;
  }
  delete body.tool_choice;
  return body;
}

function clampMaxTokens(v) {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n > 0 ? Math.min(n, MAX_OUTPUT_TOKENS) : undefined;
}

/** CodeArts 账号凭据形态：{ access_key_id, secret_access_key, security_token, ... } 存在账号池的 accessToken 字段（JSON 串）。 */
export function codeartsCredOf(account) {
  try {
    const raw = typeof account?.accessToken === 'string' && account.accessToken.startsWith('{')
      ? JSON.parse(account.accessToken)
      : account?.credential;
    if (raw && raw.access_key_id && raw.secret_access_key) return raw;
  } catch { /* 非 JSON 凭据 */ }
  return null;
}

/** CodeArts 站点的凭据是否已登录（access+secret 在，即视为可用）。 */
export function codeartsIsLoggedIn(site) {
  if (site !== 'codearts') return false;
  return listAccounts(site).some((a) => a.enabled !== false && codeartsCredOf(a));
}

/**
 * 刷新一个 CodeArts 账号的 STS 凭据（幂等纯读语义——刷新不轮换 refresh_token 本体，
 * 但每次拿到新的 AK/SK/ST）。凭据无 refresh_token（ticket 流导入）时直接失败。
 */
export async function codeartsRefreshCredential(cfg, site, accountId) {
  const a = getAccount(site, accountId);
  if (!a) throw new Error(`[${site}] 账号不存在：${accountId}`);
  const cred = codeartsCredOf(a);
  if (!cred) throw new Error(`[${site}] 账号 ${accountId} 没有 CodeArts 凭据`);
  if (!cred.refresh_token || !cred.code_verifier || !cred.dpop_private_key_jwk) {
    throw new Error(`[${site}] 账号 ${accountId} 凭据不可刷新（缺 refresh_token/verifier/DPoP），请重新登录`);
  }
  const token = await codeartsExchangeRefreshToken(cred.refresh_token, cred.code_verifier, cred.dpop_private_key_jwk);
  const next = codeartsCredentialFromTokenResponse0(token, cred);
  const expiresAt = codeartsRefreshExpiresAt(cred) ?? codeartsExpiresFromCredential(next);
  updateTokens(site, accountId, { accessToken: JSON.stringify(next), refreshToken: 'codearts', expiresAt });
  log(`[${site}] STS 凭据已刷新（${accountId}），有效期至 ${new Date(expiresAt).toISOString()}`);
  return next;
}

function codeartsCredentialFromTokenResponse0(token, prev) {
  const c = token.credentials ?? {};
  return {
    access_key_id: c.access_key_id ?? '',
    secret_access_key: c.secret_access_key ?? '',
    security_token: c.security_token ?? '',
    expires_at: c.expiration ?? '',
    refresh_token: token.refresh_token || prev.refresh_token,
    code_verifier: prev.code_verifier,
    dpop_private_key_jwk: prev.dpop_private_key_jwk,
  };
}

/**
 * CodeArts 目录（带内存缓存）。远端两来源都成功才缓存 2 小时；残缺只展示不缓存
 *（上游 IKJVTF 同款教训）。ctx 覆盖窗口与倍率展示串。
 */
let caCatalogCache = { at: 0, models: [], complete: false };
export async function codeartsCatalog(cfg, { force = false } = {}) {
  const fresh = Date.now() - caCatalogCache.at < 2 * 3600_000;
  if (!force && fresh && caCatalogCache.complete && caCatalogCache.models.length) return caCatalogCache.models;
  const accounts = listAccounts('codearts').filter((a) => a.enabled !== false);
  const account = accounts.map((a) => ({ a, cred: codeartsCredOf(a) })).find((x) => x.cred);
  if (!account) return caCatalogCache.models.length ? caCatalogCache.models : [];
  // STS 临时凭证只有 2 小时寿命（0.3.66 实测：目录拉取没接刷新逻辑，过期后
  // APIG.0602 security token expired → 「远端目录为空」→ 永远回落 seed 兜底，
  // 选择器里看不到华为最新模型）。鉴权失效自动刷新一次再试。
  let out = await codeartsFetchCatalog(account.cred);
  const authDead = (o) => !o.gatewayOk && !o.builtinOk;
  if (authDead(out)) {
    warn('[codearts] 目录双端点鉴权失效（STS 可能过期），刷新凭据后重试');
    try {
      const fresh2 = await codeartsRefreshCredential(cfg, 'codearts', account.a.id);
      out = await codeartsFetchCatalog(fresh2);
    } catch (e) {
      warn('[codearts] 目录刷新凭据失败：' + (e.message || e));
    }
  }
  if (out.gatewayOk && out.builtinOk && out.models.length) {
    caCatalogCache = { at: Date.now(), models: out.models, complete: true };
  } else if (out.models.length) {
    caCatalogCache.models = out.models; // 残缺：只展示，不落 complete
    caCatalogCache.at = Date.now() - 2 * 3600_000 + 5 * 60_000; // 5 分钟后重试
  }
  return caCatalogCache.models;
}

export function codeartsInvalidateCatalog() {
  caCatalogCache = { at: 0, models: [], complete: false };
}

/**
 * 发起一次 CodeArts 对话（OpenAI 兼容 body 进，OpenAI 兼容 SSE 出）。
 * 返回 upstream.mjs openChat 同款句柄。401/403 自动刷新凭据重试一次。
 */
export async function codeartsOpenChat(cfg, body, { signal, accountId = null } = {}) {
  const site = 'codearts';
  const accounts = listAccounts(site).filter((a) => a.enabled !== false && codeartsCredOf(a));
  if (!accounts.length) {
    const err = new Error('[codearts] 尚未登录：请在控制台「扫码登录」页添加 CodeArts 账号');
    err.code = 'not_logged_in';
    err.status = 401;
    throw err;
  }
  const account = accountId ? accounts.find((a) => a.id === accountId) : accounts[0];
  if (!account) throw new Error(`[codearts] 账号不存在：${accountId}`);

  let cred = codeartsCredOf(account);
  const model = codeartsNormalizeModelId(String(body?.model || ''));
  // 超长 MCP 工具名会被华为上游整条拒绝（maximum is 64）：发前压缩、回包还原。
  const { body: safeBody, origByShort } = compactToolNames(body);
  // benefit 头判定：远端集合优先（目录拉取时已标注），回落静态兜底
  const cat = caCatalogCache.models.find((m) => m.id === model);
  const isBenefit = cat ? cat.benefit === 'yes' : ['glm-5.3-flash', 'deepseek-v4.1-flash'].includes(model);

  const payload = {
    ...safeBody,
    model,
    stream: true,
    prompt_cache_key: crypto.randomUUID(),
    include: ['reasoning.encrypted_content'],
    reasoning_summary: 'auto',
    tool_stream: true,
    max_tokens: clampMaxTokens(body?.max_tokens) ?? MAX_OUTPUT_TOKENS,
  };
  if (safeBody?.reasoningEffort === 'off') payload.thinking = { type: 'disabled' };
  delete payload.reasoningEffort;
  // 华为上游只接受字符串 tool_choice（对象形式 → InferHub.001001005.400）。
  // 规范化规则对齐 dsh：function 对象转「具名工具字符串」，none 连 tools 一起抑制。
  normalizeToolChoice(payload);

  const url = `${CODEARTS_CHAT_BASE}/chat/completions`;
  const bodyText = JSON.stringify(payload);
  let authRefreshed = false;
  let queueAttempts = 0; // TM.00001041 排队重试计数（10s × 180 = 30 分钟上限）

  for (;;) {
    const extra = isBenefit ? { maas_type: 'benefit' } : undefined;
    const signed = signRequestHuawei(cred.access_key_id, cred.secret_access_key, cred.security_token, 'POST', url, new TextEncoder().encode(bodyText), extra);
    const headers = wireHeadersFromSigned(signed);
    headers['Content-Type'] = 'application/json';
    headers['Chat-Id'] = crypto.randomUUID();
    headers['Session-Id'] = crypto.randomUUID();
    headers['lang'] = 'en';

    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: bodyText, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw Object.assign(new Error(`[codearts] 连接失败：${e?.cause?.code || e?.message || e}`), { transport: true, status: 504 });
    }

    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      // 鉴权失效不止 401/403：华为 APIG 对过期 STS 返回 **400 + APIG.0602**
      //（"the security token has expired"）。只认 401/403 时，令牌一过 2 小时
      // 就永久 400 —— 2026-10-27 15:29 实测正是这条，表现为「模型不通」。
      const authDead = isAuthDeadResponse(res.status, text);
      if (authDead) {
        if (!authRefreshed) {
          authRefreshed = true;
          warn(`[codearts] 鉴权失效（HTTP ${res.status}），刷新 STS 凭据后重试`);
          try {
            cred = await codeartsRefreshCredential(cfg, site, account.id);
            continue;
          } catch (e) {
            warn(`[codearts] 凭据刷新失败：${e.message}`);
            return {
              ok: false,
              status: res.status,
              text: `[codearts] 凭据已失效且刷新失败：${e.message}——请在控制台重新扫码登录 CodeArts`,
              site,
              accountId: account.id,
            };
          }
        }
        return { ok: false, status: res.status, text: `[codearts] 凭据已失效：${text.slice(0, 300)}`, site, accountId: account.id };
      }
      // TM.00001041「并发会话数已达上限(N)」= 账号级排队信号（上游实测语义：每账号
      // 最多 3 个并发会话）。移植上游参考实现：等 10 秒直接重发 chat（不轮询状态
      // 端点），上限 30 分钟；排队期间换其它账号接手由外层 openChatRotating 语义
      // 处理——这里只对本账号重试，超限原样返回（轮换层会标记失败换号）。
      // 排队/限流（TM.00001041 并发上限、peak hours、429 家族）：等 10 秒重发。
      // 以前只认 TM.00001041，峰值时段/文案变体仍会直接 502 给用户。
      if ((res.status === 400 || res.status === 429) && isQueueErrorCode('', text)) {
        queueAttempts += 1;
        if (queueAttempts > 180) {
          return { ok: false, status: 400, text: '[codearts] 排队等待超时（30 分钟）——账号并发会话一直占满', site, accountId: account.id };
        }
        if (queueAttempts === 1) warn(`[codearts] 账号 ${account.label || account.id} 并发会话占满，10 秒后重试（最多等 30 分钟）`);
        await new Promise((r) => setTimeout(r, 10_000));
        if (signal?.aborted) return { ok: false, status: 499, text: '[codearts] 客户端已取消（排队等待中）', site, accountId: account.id };
        continue;
      }
      return { ok: false, status: res.status, text: `[codearts] HTTP ${res.status}：${text.slice(0, 400)}`, site, accountId: account.id };
    }

    // 200 也可能是错误信封：CodeArts 用 SSE 内嵌 error_code 表达并发排队/限流/额度。
    // 首帧预读后分流（借鉴 dsh 的 isSseQueueErrorCode / SseQueueRetryError）：
    //   排队 → 取消本次流，等 10 秒重发（与 HTTP 400 分支同一套上界）
    //   鉴权 → 刷新 STS 后重发
    //   额度 → 直接失败（换号/换站才有意义）
    //   其他 → 交给 readCodeArtsSSEFromReader 还原成错误帧
    // 正常内容的首帧原样放行，不改变流式时序。
    const reader = res.body.getReader();
    const first = await peekFirstSSEFrame(reader);
    if (first) {
      let obj = null;
      try { obj = JSON.parse(first.payload); } catch { /* 非 JSON 交给后续解析 */ }
      const code = typeof obj?.error_code === 'string' ? obj.error_code : '';
      const msg = typeof obj?.error_msg === 'string' ? obj.error_msg : '';
      if (code) {
        const cancel = async () => { try { await reader.cancel(); } catch { /* 已断 */ } };
        if (isAuthDeadResponse(200, JSON.stringify(obj))) {
          await cancel();
          if (!authRefreshed) {
            authRefreshed = true;
            warn(`[codearts] 流内鉴权错误 ${code}，刷新 STS 凭据后重试`);
            try {
              cred = await codeartsRefreshCredential(cfg, site, account.id);
              continue;
            } catch (e) {
              return { ok: false, status: 401, text: `[codearts] 凭据已失效且刷新失败：${e.message}——请重新扫码登录 CodeArts`, site, accountId: account.id };
            }
          }
          return { ok: false, status: 401, text: `[codearts] 凭据已失效：${code} ${msg}`.slice(0, 320), site, accountId: account.id };
        }
        if (isQuotaErrorCode(code, msg)) {
          await cancel();
          return { ok: false, status: 402, text: `[codearts] 额度不足：${code} ${msg}`.slice(0, 320), site, accountId: account.id };
        }
        if (isQueueErrorCode(code, msg)) {
          await cancel();
          queueAttempts += 1;
          if (queueAttempts > 180) {
            return { ok: false, status: 429, text: '[codearts] 排队等待超时（30 分钟）——账号并发会话一直占满', site, accountId: account.id };
          }
          if (queueAttempts === 1) warn(`[codearts] 流内排队/限流（${code}），10 秒后重试（最多等 30 分钟）`);
          await new Promise((r) => setTimeout(r, 10_000));
          if (signal?.aborted) return { ok: false, status: 499, text: '[codearts] 客户端已取消（排队等待中）', site, accountId: account.id };
          continue;
        }
      }
    }

    markSuccess(site, account.id, model);
    return {
      ok: true,
      status: res.status,
      site,
      accountId: account.id,
      payload,
      frames: restoreToolNames(readCodeArtsSSEFromReader(reader, signal, first), origByShort),
      close: () => {
        // readCodeArtsSSE 的 reader 已经锁住 res.body，并在 finally 里 cancel 过。
        // 这里再 body.cancel() 会返回一个 rejected Promise（ERR_INVALID_STATE:
        // ReadableStream is locked）；外层 try/catch 抓不到异步 rejection，
        // 于是每次请求结束都冒一条进程级 unhandledRejection（实测 2026-10-27
        // 15:00 的 502 后面就跟了这条，把真实上游错误盖掉了）。
        try {
          const p = res.body?.cancel?.();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch { /* 已断 */ }
      },
    };
  }
}

/**
 * CodeArts SSE：OpenAI 兼容 chunk 之外，上游用 HTTP 200 + SSE 内嵌 error_code 表达
 * 排队/限流/额度（上游实测形态）。把内嵌错误还原成「错误帧」（classifyFrame 认得的
 * { code, msg } 形态），让三协议入口的既有错误分支统一处理。
 *
 * 0.3.71 起拆成「首帧预读 + 余下读取」两段：调用方要先看首帧是不是排队/鉴权/
 * 额度错误（这些应在代理内部重试，而不是把 502 丢给客户端），再决定是否建流。
 */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** 解析一行 SSE；非 data 行 / 空 payload / [DONE] 返回 null。 */
function parseSSELine(raw) {
  if (!raw.startsWith('data:')) return null;
  const payload = raw.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  return { payload };
}

/**
 * 预读第一个完整 data 帧。返回 { payload, rest, decoder } 或 null（空流）。
 * decoder 要传给后续 reader，否则跨 chunk 的多字节字符会被截断成乱码。
 */
async function peekFirstSSEFrame(reader) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return null;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const line = parseSSELine(raw);
      if (line) return { payload: line.payload, rest: buf, decoder };
    }
  }
}

async function* readCodeArtsSSEFromReader(reader, signal, first = null) {
  const decoder = first?.decoder || new TextDecoder('utf-8');
  let buf = first?.rest || '';
  try {
    if (first) {
      const obj = safeJson(first.payload);
      if (typeof obj?.error_code === 'string' && obj.error_code) {
        warn(`[codearts] 上游内嵌错误 ${obj.error_code}：${String(obj.error_msg || '').slice(0, 160)}`);
        yield JSON.stringify({ code: obj.error_code, msg: obj.error_msg || obj.error_code });
        return;
      }
      yield first.payload;
    }
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const line = parseSSELine(raw);
        if (!line) continue;
        const obj = safeJson(line.payload);
        if (typeof obj?.error_code === 'string' && obj.error_code) {
          // 内嵌错误 → 错误信封形态（classifyFrame 识别 { code }）
          // 记录原始码/文案：以前只把信封交给上层，日志里只剩 status=502，
          // 排障时不知道到底是并发排队、限流还是额度问题。
          warn(`[codearts] 上游内嵌错误 ${obj.error_code}：${String(obj.error_msg || '').slice(0, 160)}`);
          yield JSON.stringify({ code: obj.error_code, msg: obj.error_msg || obj.error_code });
          return;
        }
        yield line.payload;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已断 */ }
  }
}

/** 旧入口（无需预读的调用方）：等价于从头读。 */
export function readCodeArtsSSE(stream, signal) {
  return readCodeArtsSSEFromReader(stream.getReader(), signal, null);
}

/** CodeArts 目录合并进 mergedModels 的条目形态（router.mjs 消费）。 */
export function codeartsModelEntries(models) {
  return (models || []).map((m) => ({
    id: m.id,
    site: 'codearts',
    mult: null,
    info: {
      name: m.name,
      contextWindow: codeartsContextWindow(m.id),
      ...(m.rateLabel ? { badges: [`倍率 ${m.rateLabel}`] } : {}),
      ...(m.benefit === 'yes' ? { badges: ['免费额度'] } : {}),
    },
  }));
}
