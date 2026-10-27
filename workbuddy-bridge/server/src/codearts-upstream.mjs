// CodeArts 站点的上游调用层（0.3.66）：对齐 upstream.mjs 的 openChat 契约
//（返回 { ok, status, site, accountId, payload, frames, close } / { ok:false, status, text }），
// 但走华为云 AK/SK 签名而不是 Bearer token，401/403 触发 STS 刷新而非 refreshToken。
// 账号轮换复用 openChatRotating 的语义（本模块只做单次 openChat；轮换在上层）。
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
  // benefit 头判定：远端集合优先（目录拉取时已标注），回落静态兜底
  const cat = caCatalogCache.models.find((m) => m.id === model);
  const isBenefit = cat ? cat.benefit === 'yes' : ['glm-5.3-flash', 'deepseek-v4.1-flash'].includes(model);

  const payload = {
    ...body,
    model,
    stream: true,
    prompt_cache_key: crypto.randomUUID(),
    include: ['reasoning.encrypted_content'],
    reasoning_summary: 'auto',
    tool_stream: true,
    max_tokens: clampMaxTokens(body?.max_tokens) ?? MAX_OUTPUT_TOKENS,
  };
  if (body?.reasoningEffort === 'off') payload.thinking = { type: 'disabled' };
  delete payload.reasoningEffort;

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

    if (res.status === 401 || res.status === 403) {
      // 网关侧凭据失效（APIG.0602 等）：刷新 STS 凭据重试一次（同一次 stream 最多一次）
      if (!authRefreshed) {
        authRefreshed = true;
        warn(`[codearts] 网关 ${res.status}，刷新 STS 凭据后重试`);
        try {
          cred = await codeartsRefreshCredential(cfg, site, account.id);
          continue;
        } catch (e) {
          warn(`[codearts] 凭据刷新失败：${e.message}`);
          return { ok: false, status: res.status, text: `[codearts] 凭据已失效：${e.message}`, site, accountId: account.id };
        }
      }
      return { ok: false, status: res.status, text: `[codearts] HTTP ${res.status}：${await res.text().catch(() => '')}`, site, accountId: account.id };
    }

    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      // TM.00001041「并发会话数已达上限(N)」= 账号级排队信号（上游实测语义：每账号
      // 最多 3 个并发会话）。移植上游参考实现：等 10 秒直接重发 chat（不轮询状态
      // 端点），上限 30 分钟；排队期间换其它账号接手由外层 openChatRotating 语义
      // 处理——这里只对本账号重试，超限原样返回（轮换层会标记失败换号）。
      if (res.status === 400 && /TM\.00001041/.test(text)) {
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

    markSuccess(site, account.id, model);
    return {
      ok: true,
      status: res.status,
      site,
      accountId: account.id,
      payload,
      frames: readCodeArtsSSE(res.body, signal),
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
 */
async function* readCodeArtsSSE(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw.startsWith('data:')) continue;
        const payload = raw.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (typeof obj.error_code === 'string' && obj.error_code) {
          // 内嵌错误 → 错误信封形态（classifyFrame 识别 { code }）
          // 记录原始码/文案：以前只把信封交给上层，日志里只剩 status=502，
          // 排障时不知道到底是并发排队、限流还是额度问题。
          warn(`[codearts] 上游内嵌错误 ${obj.error_code}：${String(obj.error_msg || '').slice(0, 160)}`);
          yield JSON.stringify({ code: obj.error_code, msg: obj.error_msg || obj.error_code });
          return;
        }
        yield payload;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已断 */ }
  }
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
