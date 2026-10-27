// 华为云 CodeArts 站点适配（0.3.66）：协议移植自 MIT 开源 dsh-codearts-auth
//（https://gitee.com/iJetLi/deepseek-harness-codearts，吸收提交 345f0a0），
// 按本插件架构重写为无宿主依赖的纯函数/单例模块。判据与踩坑记录均来自上游实测：
//
// 1. 登录：OAuth + PKCE（code_challenge_method 必须写 "SHA-256" 而非 S256，portal
//    以此识别新流程，错值回退旧 ticket 流）+ DPoP（ES256 dpop+jwt）。本地回调端口
//    必须 ≥10000（低端口 portal 拒绝）。回调可能带 code（新流程）或 secret（旧流程
//    回退，需轮询 ticket 端点）。
// 2. 凭据：华为 STS /v1/oauth2/tokens 换 AK/SK/ST（access 2h，refresh_token JWT
//    exp = 登录时刻 + 30 天，续期不延长）。401/403 触发刷新，刷新是幂等纯读。
// 3. 请求签名：SDK-HMAC-SHA256（signRequestHuawei）；benefit 免费额度模型必须带
//    maas_type: benefit 头（参与签名），否则 404 model not registered。
// 4. 目录：两个独立端点——opengw gateway/config（benefit 模型）+ snap-access
//    /v1/model/builtin（常规模型）；/model-gateway/v1/models 恒 404，别拼。
// 5. 对话：POST snap-access /api/v2/chat/completions，OpenAI 兼容 SSE；HTTP 200 +
//    SSE 内嵌 error_code 是排队/限流/额度的真实形态；model id 必须去日期后缀。
// 6. 上下文窗口上游不下发，用本地静态表 + 具名兜底 524288（上游实测最小窗口）。

import crypto from 'node:crypto';
import http from 'node:http';

/* ---------------- 华为云 SDK-HMAC-SHA256 签名 ---------------- */

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/**
 * 签名一个华为云请求；返回需随请求发送的头映射（host/x-sdk-* 除外——它们由
 * fetch 自己带，但 x-security-token 与 Authorization 必须发）。
 * extraHeaders（如 maas_type: benefit）参与 canonical 计算，必须原样随请求发送。
 */
export function signRequestHuawei(ak, sk, securityToken, method, urlStr, body, extraHeaders) {
  const url = new URL(urlStr);
  let uri = url.pathname;
  if (!uri.endsWith('/')) uri += '/';
  const query = url.search.slice(1);
  const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const payloadHash = sha256Hex(body);

  const headers = new Map();
  headers.set('host', url.host);
  headers.set('x-sdk-date', dateStamp);
  headers.set('x-sdk-content-sha256', payloadHash);
  headers.set('x-security-token', securityToken);
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json');

  const signedHeaders = [...headers.keys()].sort();
  const canonicalRequest = [
    method, uri, query,
    signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`).join('\n'), '',
    signedHeaders.join(';'), payloadHash,
  ].join('\n');
  const canonicalHash = sha256Hex(canonicalRequest);
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`;
  const signature = hmacSha256Hex(sk, stringToSign);
  headers.set('Authorization', `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`);
  // host 头 fetch 会自动带，x-sdk-content-sha256 只参与签名不重发也可（实测带上最稳）
  return headers;
}

/** 挑出真正要随 fetch 发送的头（host 由 Node fetch 自动生成，不能手动设）。 */
export function wireHeadersFromSigned(signed) {
  const out = {};
  for (const [k, v] of signed.entries()) {
    if (k === 'host' || k === 'content-type') continue; // content-type 由调用方设
    out[k] = v;
  }
  return out;
}

/* ---------------- PKCE + DPoP（OAuth 登录）---------------- */

export const CODEARTS_CLIENT_ID = 'codearts-agent';
export const CODEARTS_STS_ENDPOINT = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
export const CODEARTS_PORTAL_AUTHORIZE = 'https://codearts.huaweicloud.com/portal/authorize';
export const CODEARTS_PORTAL_LOGIN = 'https://codearts.huaweicloud.com/portal/login';
export const CODEARTS_CREDENTIAL_TICKET = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket';
const LOGIN_PLUGIN_NAME = 'snap_AIIDE';
const LOGIN_PLUGIN_VERSION = '5.2.0';
const OAUTH_CALLBACK_TIMEOUT_MS = 180_000;
const MIN_CALLBACK_PORT = 10_000;

export function generatePkcePair() {
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function generateDpopKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = (pub) => ({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y });
  const pubJwk = jwk(publicKey.export({ format: 'jwk' }));
  const privJwk = { ...pubJwk, d: privateKey.export({ format: 'jwk' }).d };
  return { privateKeyJwk: privJwk, publicKeyJwk: pubJwk };
}

/** 用持久化的 DPoP 私钥 JWK 签 dpop+jwt（htm=方法，htu=完整 URL）。 */
export function signDpopJws(privateKeyJwk, htm, htu) {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: { kty: privateKeyJwk.kty, crv: privateKeyJwk.crv, x: privateKeyJwk.x, y: privateKeyJwk.y } };
  const payload = { htm, htu, iat: Math.floor(Date.now() / 1000), jti: crypto.randomBytes(32).toString('hex') };
  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64u(header)}.${b64u(payload)}`;
  const key = crypto.createPrivateKey({ key: privateKeyJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${sig.toString('base64url')}`;
}

/** 从持久化私钥 JWK 恢复签名函数所需的形态（公开键从 x/y 重建）。 */
export function dpopPublicFromPrivate(privateKeyJwk) {
  return { kty: privateKeyJwk.kty, crv: privateKeyJwk.crv, x: privateKeyJwk.x, y: privateKeyJwk.y };
}

/** 向 STS 端点发起带 DPoP 的 token 请求。refresh 失效（invalid_grant/ExpiredRefreshToken）抛终态错。 */
export async function codeartsRequestToken(body, privateKeyJwk, fetcher = fetch) {
  const dpop = signDpopJws(privateKeyJwk, 'POST', CODEARTS_STS_ENDPOINT);
  let res;
  try {
    res = await fetcher(CODEARTS_STS_ENDPOINT, {
      method: 'POST',
      headers: { DPoP: dpop, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error(`CodeArts token 请求网络错误：${e.message || e}`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || !data?.credentials) {
    const message = `CodeArts token 请求失败：HTTP ${res.status}${data ? ' ' + JSON.stringify(data).slice(0, 200) : ''}`;
    const code = String(data?.error_code ?? '');
    if (data?.error === 'invalid_grant' || code.includes('ExpiredRefreshToken')) {
      const err = new Error(message);
      err.terminal = true; // 只能人工重新登录
      throw err;
    }
    throw new Error(message);
  }
  return data;
}

export function codeartsCredentialFromTokenResponse(token, pkce, privateKeyJwk) {
  const c = token.credentials ?? {};
  return {
    access_key_id: c.access_key_id ?? '',
    secret_access_key: c.secret_access_key ?? '',
    security_token: c.security_token ?? '',
    expires_at: c.expiration ?? '',
    refresh_token: token.refresh_token ?? '',
    code_verifier: pkce.codeVerifier,
    dpop_private_key_jwk: privateKeyJwk,
  };
}

export function codeartsExchangeAuthorizationCode(code, codeVerifier, port, privateKeyJwk, fetcher) {
  return codeartsRequestToken({
    client_id: CODEARTS_CLIENT_ID, code, code_verifier: codeVerifier,
    grant_type: 'authorization_code', redirect_uri: `http://127.0.0.1:${port}/oauth/callback`,
  }, privateKeyJwk, fetcher);
}

export function codeartsExchangeRefreshToken(refreshToken, codeVerifier, privateKeyJwk, fetcher) {
  return codeartsRequestToken({
    client_id: CODEARTS_CLIENT_ID, code_verifier: codeVerifier,
    grant_type: 'refresh_token', refresh_token: refreshToken,
  }, privateKeyJwk, fetcher);
}

/** refresh_token JWT 的 exp（毫秒）；恒 = 登录时刻 + 30 天，续期不延长（上游实测）。 */
export function codeartsRefreshExpiresAt(credential) {
  const token = credential?.refresh_token;
  if (typeof token !== 'string' || !token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch { /* 形状不对按读不到处理 */ }
  return undefined;
}

/* ---------------- OAuth 登录流程（本地回调服务器）---------------- */

/**
 * 启动 CodeArts OAuth 登录：起本地回调服务器（端口 ≥10000）、返回登录 URL。
 * 返回 { loginUrl, port, waitForResult, close }；waitForResult resolve 出凭据对象。
 * 用户在浏览器里完成华为云登录授权后，portal 回调本地 /oauth/callback。
 */
export function startCodeArtsOAuthFlow({ fetcher = fetch } = {}) {
  const ticketId = crypto.randomBytes(32).toString('hex');
  const pkce = generatePkcePair();
  const keyPair = generateDpopKeyPair();

  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/oauth/callback')) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    // 旧流程回退：portal 给 secret → 轮询 ticket 端点换凭据
    const secret = url.searchParams.get('secret');
    if (secret) {
      res.writeHead(307, { Location: `${CODEARTS_PORTAL_LOGIN}?result=succeeded` }).end();
      pollCodeArtsTicket(ticketId, secret, { fetcher }).then(resolveResult, rejectResult);
      return;
    }
    const code = url.searchParams.get('code');
    if (code) {
      codeartsExchangeAuthorizationCode(code, pkce.codeVerifier, port, keyPair.privateKeyJwk, fetcher).then(
        (token) => {
          res.writeHead(307, { Location: `${CODEARTS_PORTAL_LOGIN}?result=succeeded` }).end();
          resolveResult(codeartsCredentialFromTokenResponse(token, pkce, keyPair.privateKeyJwk));
        },
        (error) => {
          res.writeHead(307, { Location: `${CODEARTS_PORTAL_LOGIN}?result=failed` }).end();
          rejectResult(error);
        },
      );
      return;
    }
    res.writeHead(400).end('Missing authorization code or secret');
  });

  const listen = new Promise((resolve, reject) => {
    const tryListen = (p) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => {
        const assigned = server.address()?.port ?? 0;
        if (assigned >= MIN_CALLBACK_PORT) { resolve(assigned); return; }
        server.close(() => tryListen(Math.floor(Math.random() * (65_536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT));
      });
    };
    tryListen(0);
  });

  let port = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch { /* 已关 */ }
  };
  const timeout = setTimeout(() => { close(); rejectResult(new Error('CodeArts 登录等待超时（3 分钟）')); }, OAUTH_CALLBACK_TIMEOUT_MS);
  timeout.unref?.();
  result.then(() => clearTimeout(timeout), () => clearTimeout(timeout)).finally(close);

  const loginUrl = `${CODEARTS_PORTAL_AUTHORIZE}?theme=2&locale=zh-cn`
    + `&uri_scheme=${CODEARTS_CLIENT_ID}&client_id=${CODEARTS_CLIENT_ID}&port=${'{{PORT}}'}`
    + `&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256`
    + `&ticket_id=${ticketId}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`;

  return {
    async getLoginUrl() {
      port = await listen;
      return loginUrl.replace('{{PORT}}', String(port));
    },
    waitForResult: () => result,
    close,
  };
}

/** 旧 ticket 流：轮询凭据端点（瞬时失败跳过，120 次 × 1s）。 */
export async function pollCodeArtsTicket(ticketId, secret, { fetcher = fetch, maxAttempts = 120 } = {}) {
  const url = `${CODEARTS_CREDENTIAL_TICKET}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    let res;
    try {
      res = await fetcher(url, { headers: { 'plugin-name': LOGIN_PLUGIN_NAME, 'plugin-version': LOGIN_PLUGIN_VERSION }, signal: AbortSignal.timeout(10_000) });
    } catch { continue; }
    if (!res.ok) continue;
    let data = null;
    try { data = await res.json(); } catch { continue; }
    const cred = parseTicketCredential(data);
    if (cred) return cred;
  }
  throw new Error('CodeArts 凭据轮询超时');
}

/** 归一化 ticket 响应（两种形态：credential/access 或 result/accessKey）。 */
function parseTicketCredential(data) {
  if (data?.credential) {
    const access = data.credential.access ?? '';
    const st = data.credential.securitytoken ?? data.credential.securityToken ?? '';
    if (access && st) {
      return {
        access_key_id: access,
        secret_access_key: data.credential.secret ?? '',
        security_token: st,
        expires_at: data.credential.expires_at ?? data.credential.expiresAt ?? '',
        refresh_token: '', code_verifier: '', dpop_private_key_jwk: null,
      };
    }
  }
  if (data?.result) {
    const ak = data.result.accessKeyId ?? '';
    const st = data.result.securityToken ?? '';
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: data.result.secretAccessKey ?? '',
        security_token: st,
        expires_at: data.result.expiration ?? data.result.expiresAt ?? '',
        refresh_token: '', code_verifier: '', dpop_private_key_jwk: null,
      };
    }
  }
  return null;
}

/** 凭据过期时刻；解析不出回退 +24h（与上游同口径）。 */
export function codeartsExpiresFromCredential(credential) {
  if (credential?.expires_at) {
    const parsed = Date.parse(credential.expires_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now() + 86_400_000;
}

/* ---------------- 模型目录与 benefit 判定 ---------------- */

export const CODEARTS_OPENGW_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config';
export const CODEARTS_SNAP_BUILTIN_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin';
export const CODEARTS_CHAT_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2';
export const CODEARTS_SNAP_ENGINE_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com';
export const CODEARTS_PACKAGE_INFO_PATH = '/snap-manager/v1/statistics/plugin';
export const CODEARTS_OPS_DELIVERY_PATH = '/v1/ops/delivery';
export const CODEARTS_OPS_CLAIM_PATH = '/v1/ops/claim';
export const CODEARTS_OPS_CONFIRM_PATH = '/v1/ops/confirm';

/** benefit（免费额度）模型兜底集合：chat 时必须带 maas_type: benefit。 */
export const CODEARTS_BENEFIT_FALLBACK = ['glm-5.3-flash', 'deepseek-v4.1-flash'];

/** 去掉末尾日期后缀：deepseek-v4-flash-0731 → deepseek-v4-flash（chat 只认无后缀 id）。 */
export function codeartsNormalizeModelId(id) {
  if (id.length > 5) {
    const suffix = id.slice(-5);
    if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) return id.slice(0, -5);
  }
  return id;
}

/** 静态上下文窗口表（权威来源 = CodeArts IDE 内核配置，上游端点不下发）。 */
const CODEARTS_CONTEXT_WINDOWS = new Map([
  ['GLM-5.2', 1_048_576], ['glm-5.3', 1_048_576], ['glm-5.3-flash', 1_048_576],
  ['glm-5.2-sft-harmony', 202_752],
  ['openpangu-2.0-flash', 524_288], ['openpangu-2.0-pro', 524_288],
  ['deepseek-v4-flash', 1_048_576], ['deepseek-v4-pro', 1_048_576],
  ['deepseek-v4.1-flash', 1_048_576],
]);
/** 查不到时的具名兜底：上游目录实测最小窗口（宁小勿大——偏大是上游溢出报错）。 */
export const CODEARTS_FALLBACK_CONTEXT_WINDOW = 524_288;

export function codeartsContextWindow(model) {
  return CODEARTS_CONTEXT_WINDOWS.get(model) ?? CODEARTS_FALLBACK_CONTEXT_WINDOW;
}

/** 目录条目里的倍率展示串（ratio_display 不同量纲于 ratio，绝不用数值拼）。 */
function codeartsRateLabel(item, nowMs = Date.now()) {
  const credit = item.credit;
  if (!Array.isArray(credit) || credit.length === 0) return null;
  const entries = credit.filter((c) => c && typeof c === 'object');
  if (!entries.length) return null;
  // 按时段选档：off_peak（错峰，6 段 cron 的时分 + 小时窗口）优先生效
  const slots = item.time_slots;
  let picked = entries[0];
  if (slots && typeof slots === 'object') {
    for (const entry of entries) {
      const slot = slots[entry.time_slot_id];
      if (!slot || typeof slot !== 'object') continue;
      const schedule = typeof slot.schedule === 'string' ? slot.schedule.trim() : '';
      const parts = schedule.split(/\s+/);
      const hour = Number(parts[2]);
      const minute = Number(parts[1]);
      const duration = Number(slot.duration);
      if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(duration) || duration <= 0 || slot.timeunit !== 'hour') continue;
      const shanghaiMinutes = Math.floor((nowMs + 8 * 3600_000) / 60_000) % (24 * 60);
      const offset = (shanghaiMinutes - (hour * 60 + minute) + 24 * 60) % (24 * 60);
      if (offset < duration * 60) { picked = entry; break; }
    }
  }
  const display = picked?.ratio_display;
  return typeof display === 'string' && display ? display : null;
}

function parseCatalogModel(m, seen, nowMs) {
  const rawId = m?.model_id;
  if (typeof rawId !== 'string' || !rawId) return null;
  const id = codeartsNormalizeModelId(rawId);
  if (id.includes('-VL-') || id.endsWith('-VL')) return null; // 视觉模型上下文小、无工具调用，隐藏
  if (seen.has(id)) return null;
  seen.add(id);
  const rawName = typeof m.model_name === 'string' && m.model_name ? m.model_name : id;
  const rateLabel = codeartsRateLabel(m, nowMs);
  return { id, name: codeartsNormalizeModelId(rawName), ...(rateLabel ? { rateLabel } : {}), benefit: rawId === id ? 'unknown' : 'no' };
}

/**
 * 拉远端目录（两来源合并去重）。返回 { models, gatewayOk, builtinOk, benefitIds }。
 * 完整性由调用方判断：只有两个来源都成功才值得长期缓存。
 */
export async function codeartsFetchCatalog(credential, { fetcher = fetch, nowMs = Date.now() } = {}) {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential ?? {};
  if (!ak || !sk) return { models: [], gatewayOk: false, builtinOk: false, benefitIds: [] };
  const models = [];
  const seen = new Set();
  const benefitIds = [];
  const signedGet = async (url, extraUnsigned) => {
    const signed = signRequestHuawei(ak, sk, st, 'GET', url, new Uint8Array());
    const headers = wireHeadersFromSigned(signed);
    Object.assign(headers, extraUnsigned ?? {});
    try {
      const res = await fetcher(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return undefined;
      return await res.text();
    } catch { return undefined; }
  };
  const jsonArray = (text, path) => {
    try {
      let v = JSON.parse(text);
      for (const k of path) { if (!v || typeof v !== 'object') return undefined; v = v[k]; }
      return Array.isArray(v) ? v : undefined;
    } catch { return undefined; }
  };
  // 1. opengw gateway/config — benefit 模型（成功判据 = 形状可识别，空数组也合法）
  const gwText = await signedGet(CODEARTS_OPENGW_CONFIG_URL);
  const gwArr = gwText === undefined ? undefined : jsonArray(gwText, ['result', 'models']);
  const gatewayOk = gwArr !== undefined;
  if (gatewayOk) {
    for (const item of gwArr) {
      if (!item || typeof item !== 'object') continue;
      const rawId = typeof item.model_id === 'string' ? item.model_id : '';
      const mi = parseCatalogModel(item, seen, nowMs);
      if (mi) {
        // 只记录未被去后缀改写的 id（被改写的是另一个模型，benefit 属性相反）
        if (rawId && codeartsNormalizeModelId(rawId) === rawId) { mi.benefit = 'yes'; benefitIds.push(mi.id); }
        models.push(mi);
      }
    }
  }
  // 2. snap-access /v1/model/builtin — 常规模型
  const snapText = await signedGet(CODEARTS_SNAP_BUILTIN_URL, { 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' });
  const snapArr = snapText === undefined ? undefined : jsonArray(snapText, ['builtinModels']);
  const builtinOk = snapArr !== undefined;
  if (builtinOk) {
    for (const item of snapArr) {
      if (!item || typeof item !== 'object') continue;
      const mi = parseCatalogModel(item, seen, nowMs);
      if (mi) { if (mi.benefit === 'unknown') mi.benefit = 'no'; models.push(mi); }
    }
  }
  return { models, gatewayOk, builtinOk, benefitIds };
}

/* ---------------- 积分 / 签到 ---------------- */

const CODEARTS_CREDIT_METRIC_LABELS = {
  usageTotalPackageCredit: '积分总量',
  usageBasicPackageCredit: '基础积分包',
  usageBonusPackageCredit: '赠送积分包',
  usageOnDemandPackageCredit: '按需包',
};

/**
 * 查积分账户（snap-manager/v1/statistics/plugin）。
 * 返回 { total, packageName, packages: [{name, amount, used, remain, expiring}] } 或抛错。
 */
export async function codeartsFetchCredits(credential, { fetcher = fetch } = {}) {
  const url = `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_PACKAGE_INFO_PATH}`;
  const text = await codeartsSignedBody('GET', url, null, credential, fetcher);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('CodeArts 积分响应非 JSON'); }
  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
  const packages = [];
  let total = null;
  let expiringTotal;
  for (const item of metrics) {
    if (!item || typeof item !== 'object') continue;
    const name = item.name;
    const label = CODEARTS_CREDIT_METRIC_LABELS[name];
    if (!label) continue;
    const pkg = {
      name: label,
      amount: Number(item.package_credit_amount) || 0,
      used: Number(item.package_credit_used) || 0,
      remain: Number(item.package_credit_remain) || 0,
    };
    if (name === 'usageTotalPackageCredit') {
      total = pkg.remain;
      const expiring = Number(item.package_credit_expiring_amount);
      if (Number.isFinite(expiring) && expiring > 0) expiringTotal = expiring; // 只在总额上取一次
    }
    packages.push(pkg);
  }
  return { total, expiring: expiringTotal ?? 0, packageName: data?.package?.package_name_cn || data?.package?.package_name_en || '', packages };
}

/** 带 AK/SK 签名的 JSON 请求（GET/POST），返回响应文本；非 2xx 抛错。
 *  ⚠️ Agent-Type/X-Language 必须**签名后追加**、不进 canonical：进签名会 401
 *  APIG.0301 验签失败（上游实测教训），但服务端路由又需要这两个头（TM.00001001）。 */
async function codeartsSignedBody(method, url, bodyObj, credential, fetcher) {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential ?? {};
  if (!ak || !sk) throw new Error('CodeArts 凭据缺失');
  const body = bodyObj == null ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(bodyObj));
  const signed = signRequestHuawei(ak, sk, st, method, url, body);
  const headers = wireHeadersFromSigned(signed);
  if (method.toUpperCase() !== 'GET') headers['Content-Type'] = 'application/json';
  headers['Agent-Type'] = 'PromptCenter';
  headers['X-Language'] = 'zh-cn';
  const res = await fetcher(url, { method, headers, body: body.length ? body : undefined, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`CodeArts HTTP ${res.status}：${text.slice(0, 160)}`);
  return text;
}

/**
 * 每日签到：活动列表找 type=USER_LOGIN 且 claimable 的活动 → claim → confirm。
 * 三步全幂等（已领过时 claim 返回无活动或 status 非 null，调用方按文案提示）。
 * 返回 { claimed: boolean, message }。
 */
export async function codeartsDailyCheckin(credential, { fetcher = fetch } = {}) {
  const listUrl = `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_DELIVERY_PATH}?channel=IDE`;
  const listText = await codeartsSignedBody('GET', listUrl, null, credential, fetcher);
  let activities;
  try { activities = JSON.parse(listText); } catch { throw new Error('CodeArts 活动列表非 JSON'); }
  const list = Array.isArray(activities) ? activities : Array.isArray(activities?.activities) ? activities.activities : [];
  const daily = list.find((a) => a && a.type === 'USER_LOGIN');
  if (!daily) return { claimed: false, message: '没有「每日登录领取」活动（未开启或已结束）' };
  if (!daily.claimable) return { claimed: false, message: `今日已签到（${daily.title || '每日登录'}）` };
  const amount = Number(daily.benefitAmount) || Number(daily.amount) || Number(daily.creditAmount) || 0;
  const claimUrl = `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_CLAIM_PATH}`;
  const claimText = await codeartsSignedBody('POST', claimUrl, { campaignId: daily.campaignId }, credential, fetcher);
  let claim;
  try { claim = JSON.parse(claimText); } catch { claim = {}; }
  const claimId = claim?.id ?? claim?.claimId ?? null;
  if (claimId !== null && claimId !== undefined) {
    // confirm 漏掉会让积分停在「待确认」不入账（IDE 行为）
    try {
      await codeartsSignedBody('POST', `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_CONFIRM_PATH}`, { id: claimId }, credential, fetcher);
    } catch { /* confirm 失败不推翻领取结果 */ }
  }
  return { claimed: true, message: `签到成功 +${amount} 积分` };
}
