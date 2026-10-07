// 账号池：同一个站点下维护多个账号，额度耗尽或请求失败时自动换号。
//
// 存储：auth.<site>.pool.json
//   {
//     "version": 1,
//     "nextLabel": 2,
//     "accounts": [
//       { "id": "acc_1a2b3c4d", "label": "账号1",
//         "accessToken": "...", "refreshToken": "...", "expiresAt": 123,
//         "uid": "...", "nickname": "...", "domain": "...",
//         "enabled": true,
//         "exhaustedAt": null,     // 检测到额度耗尽的时间戳
//         "cooldownUntil": null,   // 失败退避截止时间
//         "failCount": 0,          // 连续失败次数
//         "lastUsedAt": null,      // 上次被选中的时间（用于轮询分摊）
//         "lastError": null,       // 最近一次失败原因（给控制台看）
//         "addedAt": "2026-..." }
//     ]
//   }
//
// 兼容：池文件不存在时，自动把旧的单账号 auth.<site>.json 当作「唯一账号」
//       （id = DEFAULT_ACCOUNT_ID）。此时读写仍然落在旧文件上，
//       所以不迁移也不影响原有行为。一旦池里加入了第 2 个账号，
//       就会把默认账号并入池文件统一管理。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfigDir, authPathFor, loadConfig } from './config.mjs';
import { orderAccounts, EXHAUST_TTL_MS } from './expiry.mjs';
import { warn } from './log.mjs';
import { writeJsonFileAtomic, readJsonFileWithBackup } from './util.mjs';
import { recordEvent } from './events.mjs';

/** 池文件里代表「旧版单账号凭证」的固定 id。 */
export const DEFAULT_ACCOUNT_ID = 'default';

/**
 * 模型级限流的缺省冷却时长（Retry-After 头缺失时兜底）。
 * 60 秒：与 Go 参考实现的 SoftCooldown 默认值同档——实测上游 429 后
 * 约 40 秒换号即恢复，60 秒足够覆盖一次「模型繁忙」窗口。
 */
const MODEL_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** 失败退避阶梯：连续失败 n 次后冷却多久。 */
const COOLDOWN_STEPS_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

/**
 * 上游限流（14003）的冷却时长：固定短窗，不随失败次数增长。
 *
 * 限流是「此刻太密」，不是「这个号坏了」——叠加重增长的阶梯会让一次流量高峰
 * 把账号雪藏半小时。真正的兜底是 coordination.mjs 的全局冷静窗（指数退避到 30s 上限），
 * 这里只需让开单账号一小会儿即可。
 */
const RATE_LIMIT_COOLDOWN_MS = 30_000;

export function poolPathFor(site) {
  return path.join(getConfigDir(), `auth.${site}.pool.json`);
}

// 缓存键必须带上配置目录：配置目录是可变状态（测试隔离会切换它），
// 只用 site 做键的话，切目录后仍会命中上一个目录的缓存，
// 表现为「单独跑通过、全量跑随机失败」。
const cache = new Map(); // `${dir}\0${site}` → { mtime, pool }

const cacheKey = (site) => `${getConfigDir()}\u0000${site}`;

/**
 * 「旧单账号兼容视图」的内存态覆盖层。
 *
 * 背景：兼容模式下一个站点只有一个账号，没有可轮换的对象，所以 markFailure /
 * markExhausted 刻意不落盘——否则控制台轮询这类只读场景会凭空建出池文件。
 * 但副作用是**耗尽状态彻底丢失**：账号被上游 429 之后 usableCount 仍然恒为 1，
 * 路由与降级选站都把它当成健康站点，于是每个请求都要先去撞一次 429，
 * 甚至「降级」也照着同一个错误前提挑目标（实测会换到另一个同样耗尽的站点）。
 *
 * 这里把这类状态记在内存里：不写盘、不建池文件，但 isUsable / usableCount /
 * pickAccount 都能看到，路由因此能避开已耗尽的单账号站点。
 * 进程重启即失效——额度本来就可能已经重置，正好。
 *
 * 覆盖层里带凭证指纹：重新登录换了账号时旧状态自动失效，
 * 否则新号会被上一个号的耗尽标记连坐 6 小时。
 */
const legacyState = new Map(); // `${dir}\0${site}` → { fp, patch }

const legacyKey = (site) => `${getConfigDir()}\u0000${site}`;

/** 凭证指纹：token 变了就说明账号换了。 */
function credFingerprint(auth) {
  return crypto
    .createHash('sha1')
    .update(String(auth?.accessToken || ''))
    .digest('hex')
    .slice(0, 16);
}

/** 读取某站点在兼容模式下的内存态覆盖；凭证已换则丢弃旧状态。 */
function legacyPatch(site, auth) {
  const hit = legacyState.get(legacyKey(site));
  if (!hit) return null;
  if (hit.fp !== credFingerprint(auth)) {
    legacyState.delete(legacyKey(site));
    return null;
  }
  return { ...hit.patch };
}

/** 写入内存态覆盖。 */
function setLegacyPatch(site, auth, patch) {
  legacyState.set(legacyKey(site), { fp: credFingerprint(auth), patch });
}

/**
 * 清空所有内存态覆盖。供测试隔离使用；
 * 生产路径不需要调用——换了凭证指纹会自动作废，迁移到池文件时会随账户一起落盘。
 */
export function clearLegacyState() {
  legacyState.clear();
}

/**
 * 在兼容模式下改账号状态：只改内存，绝不落盘。
 * 语义与磁盘路径对齐：账号对不上（没登录 / id 不匹配）时返回 null。
 */
function mutateLegacy(site, id, fn) {
  const legacy = readLegacyAuth(site);
  if (!legacy) return null;
  if (DEFAULT_ACCOUNT_ID !== id) return null;
  const patch = legacyPatch(site, legacy.auth) || {};
  fn(patch);
  setLegacyPatch(site, legacy.auth, patch);
  return patch;
}

function emptyPool() {
  return { version: 1, nextLabel: 1, accounts: [] };
}

function newId() {
  return 'acc_' + crypto.randomBytes(4).toString('hex');
}

/** 读取池文件；文件不存在时返回 null（由调用方决定是否回落到旧单账号文件）。 */
function readPoolFile(site) {
  const file = poolPathFor(site);
  const key = cacheKey(site);
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(key);
    return null;
  }
  const hit = cache.get(key);
  if (hit && hit.mtime === mtime) return hit.pool;
  // 解析失败时 readJsonFileWithBackup 会把坏文件改名备份（用户还能手工抢救），
  // 返回 null —— 这里按「空池」继续，但数据没被静默覆盖掉。
  const parsed = readJsonFileWithBackup(file);
  let pool = parsed ?? emptyPool();
  if (parsed === null) warn(`[${site}] 账号池文件解析失败（已备份），视作空池`);
  if (!Array.isArray(pool.accounts)) pool.accounts = [];
  if (!Number.isFinite(pool.nextLabel)) pool.nextLabel = pool.accounts.length + 1;
  cache.set(key, { mtime, pool });
  return pool;
}

function writePool(site, pool) {
  const file = poolPathFor(site);
  // 原子写：写一半被杀只损失 .tmp，不再把整池凭证截成半截 JSON
  writeJsonFileAtomic(file, pool, { mode: 0o600 });
  cache.set(cacheKey(site), { mtime: fs.statSync(file).mtimeMs, pool });
  // 状态已经落到池文件，内存态覆盖不再需要。
  // 这里不会丢状态：调用方的 pool 来自 loadPool，而 loadPool 已经把覆盖合并进账户了。
  legacyState.delete(legacyKey(site));
  return pool;
}

/** 读取旧版单账号凭证文件（auth.<site>.json，cn-cli 还兼容 auth.json）。 */
function readLegacyAuth(site) {
  const candidates = [authPathFor(site)];
  if (site === 'cn-cli') candidates.push(path.join(getConfigDir(), 'auth.json'));
  for (const f of candidates) {
    try {
      const a = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (a && a.accessToken) return { auth: a, file: f };
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 取该站点的账号池（会做旧单账号兼容）。
 * 返回值里的 accounts 都是副本，调用方改完需要自己 save。
 */
export function loadPool(site) {
  const pool = readPoolFile(site);
  if (pool) return pool;

  const legacy = readLegacyAuth(site);
  if (!legacy) return emptyPool();
  // 不落盘：让只读场景（如控制台轮询）不产生写入副作用
  const account = {
    ...legacy.auth,
    id: DEFAULT_ACCOUNT_ID,
    label: legacy.auth.nickname || '默认账号',
    enabled: true,
    legacyFile: legacy.file,
  };
  // 叠加内存态：兼容模式下的「额度耗尽 / 冷却」只存在内存里（见 legacyState 说明）。
  // 少了这一步，单账号站点永远显示为可用，路由与降级选站就避不开已经死掉的站点。
  const patch = legacyPatch(site, legacy.auth);
  if (patch) Object.assign(account, patch);
  return { ...emptyPool(), accounts: [account] };
}

/** 是否已经在用池文件（false 表示当前只是旧单账号的兼容视图）。 */
export function hasPoolFile(site) {
  return fs.existsSync(poolPathFor(site));
}

/**
 * 保存池。若当前还处在「旧单账号兼容视图」，写入前先把该账号并进池文件，
 * 这样第一次改动（登录新账号 / 改状态）就会自动完成迁移，用户无感。
 */
export function savePool(site, pool) {
  const clean = {
    version: 1,
    nextLabel: pool.nextLabel,
    accounts: pool.accounts.map((a) => {
      const { legacyFile, ...rest } = a; // 不把来源路径写进文件
      return rest;
    }),
  };
  return writePool(site, clean);
}

/** 列出账号（副本），带脱敏视图。 */
export function listAccounts(site) {
  return loadPool(site).accounts.map((a) => ({ ...a }));
}

/** 按 id 取账号。 */
export function getAccount(site, id) {
  return loadPool(site).accounts.find((a) => a.id === id) || null;
}

/** 账号是否处于「可用」状态（启用 + 没冷却 + 没被判额度耗尽）。 */
export function isUsable(a, now = Date.now()) {
  if (!a || a.enabled === false) return false;
  if (!a.accessToken) return false;
  if (a.cooldownUntil && now < a.cooldownUntil) return false;
  if (a.exhaustedAt && now - a.exhaustedAt < EXHAUST_TTL_MS) return false;
  return true;
}

/**
 * 选一个账号。
 *
 * workbuddy-bridge：选号顺序由 config.json → pool.policy 决定：
 *   expiry-first  默认。最早到期且有余量的账号先用（到期明细由后台积分刷新写入账号条目，
 *                 手填 manualExpireAt 可覆盖；都没有到期信息时先耗余额少的，再按最久未用）
 *   balance-first 余额多的先用
 *   round-robin   最久未用的先用（原版行为）
 *   pinned        固定用 pool.pinnedAccountId，不可用时回落 expiry-first
 * 所有策略都保留原版的保守约束：未耗尽的优先于已耗尽、失败少的优先于失败多的。
 * exclude 里的 id 会被跳过（用于「这个号刚失败，换一个」）。
 *
 * fallback 为 true 时：若没有任何「可用」账号，退而返回一个「已耗尽/冷却中」的账号。
 * 这样上游能给最终答案，好过本地直接失败——额度可能已经重置了。
 */
export function pickAccount(site, { exclude = [], now = Date.now(), fallback = false } = {}) {
  const pool = loadPool(site);
  const skip = new Set(exclude);
  const candidates = pool.accounts.filter((a) => !skip.has(a.id) && a.enabled !== false && a.accessToken);
  const usable = candidates.filter((a) => isUsable(a, now));
  const 池 = usable.length || !fallback ? usable : candidates;
  if (!池.length) return null;

  let policy = 'expiry-first';
  let pinnedAccountId = null;
  try {
    const cfg = loadConfig();
    policy = cfg.pool?.policy || policy;
    pinnedAccountId = cfg.pool?.pinnedAccountId || null;
  } catch {
    /* 配置读不出来就按默认策略，选号不能被配置问题卡死 */
  }
  const sorted = orderAccounts(池, { policy, pinnedAccountId, now });
  return sorted[0] || null;
}

/** 把一次积分查询结果写进账号条目（到期明细 / 余额缓存），供到期优先调度使用。 */
export function updateCreditDetail(site, id, credit) {
  if (!credit || typeof credit !== 'object') return null;
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.creditDetail = Array.isArray(credit.detail) ? credit.detail : [];
    a.creditRemain = Number.isFinite(Number(credit.remain)) ? Number(credit.remain) : null;
    a.creditCheckedAt = Date.now();
    return a;
  }, { immediate: false });
}

/** 池里还有多少个「现在可用」的账号（可排除已试过的 id）。 */
export function usableCount(site, now = Date.now(), exclude = []) {
  const skip = new Set(exclude);
  return loadPool(site).accounts.filter((a) => !skip.has(a.id) && isUsable(a, now)).length;
}

/* ---------------- 状态变更（都会落盘） ---------------- */

/**
 * 改动池并落盘。
 *
 * immediate=false 时改为「延迟合并写」：markSuccess 在每个成功请求上都会调用，
 * 每次都同步写盘会给每个请求加上一次磁盘 IO；而且单账号（兼容模式）下
 * lastUsedAt 毫无意义，却会因为这一次写入而凭空建出池文件。
 * 因此热路径用节流写，且没有池文件时直接跳过。
 */
function mutate(site, fn, { immediate = true } = {}) {
  const pool = loadPool(site);
  const r = fn(pool);
  if (immediate) savePool(site, pool);
  else scheduleSave(site);
  return r;
}

/**
 * 延迟合并写：同一站点的多次改动合并成一次磁盘写。
 *
 * fire 时重读而不是捕获调度时的 pool 对象：login.mjs / 控制台是独立进程，
 * 会直接改写池文件——用 2 秒前的内存快照落盘会把那些改动整体回滚
 * （实测：扫码加号后新账号凭据从磁盘上静默消失）。loadPool 返回的是共享
 * 缓存对象，本进程内的改动天然都在；重读只为了接住跨进程的写入。
 * 没有池文件时保持跳过（只读场景不产生写副作用，见 mutate 注释）。
 */
const saveTimers = new Map();
const SAVE_DELAY_MS = 2000;

function scheduleSave(site) {
  const key = cacheKey(site);
  if (saveTimers.has(key)) return;
  const t = setTimeout(() => {
    saveTimers.delete(key);
    try {
      if (!hasPoolFile(site)) return;
      savePool(site, loadPool(site));
    } catch (e) {
      warn(`[${site}] 账号池写入失败：`, e.message);
    }
  }, SAVE_DELAY_MS);
  t.unref?.();
  saveTimers.set(key, t);
}

/** 立即把待写的池刷盘（进程退出前调用）。 */
export function flushPool() {
  for (const [key, t] of saveTimers) {
    clearTimeout(t);
    const site = key.slice(key.indexOf('\u0000') + 1);
    try {
      // 与 scheduleSave 的 fire 路径同口径：没有池文件就不写（只读场景不产生写副作用）
      if (!hasPoolFile(site)) continue;
      savePool(site, loadPool(site));
    } catch {
      /* 忽略 */
    }
  }
  saveTimers.clear();
}

/**
 * 把「一次失败」应用到账号对象上。
 * 磁盘池与兼容模式的内存态覆盖共用这一套规则，避免两处逻辑漂移。
 *
 * model/modelCooldownMs（0.3.33）：上游限流是「账号 × 模型」维度的——同一个账号
 * 换个模型往往就能用（14003 的 displayMsg 原话「模型繁忙，请换模型或稍后重试」）。
 * 所以限流类失败除了账号级短冷却，再记一条 (账号, 模型) 粒度的 modelCooldowns，
 * 轮换选号时把「该模型正在冷却」的账号排到后面。modelCooldownMs 由调用方传入
 * （Retry-After 头优先，缺省 MODEL_RATE_LIMIT_COOLDOWN_MS）。
 */
function applyFailure(a, { status = 0, message = '', model = '', modelCooldownMs = 0 } = {}) {
  a.failCount = (a.failCount || 0) + 1;
  a.lastError = String(message || status || '').slice(0, 200);
  a.lastErrorAt = Date.now();
  a.lastUsedAt = Date.now();
  if (isRateLimitError(status, message)) {
    // 限流：账号没坏，只是此刻太密。短窗冷却，不打额度耗尽标记。
    a.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    if (model) {
      if (!a.modelCooldowns || typeof a.modelCooldowns !== 'object') a.modelCooldowns = {};
      // 顺手清掉已过期的旧条目，防止长期运行的池子里堆死数据
      const now = Date.now();
      for (const k of Object.keys(a.modelCooldowns)) {
        if (!(a.modelCooldowns[k]?.until > now)) delete a.modelCooldowns[k];
      }
      a.modelCooldowns[model] = {
        until: now + (modelCooldownMs > 0 ? modelCooldownMs : MODEL_RATE_LIMIT_COOLDOWN_MS),
        at: now,
      };
    }
  } else if (isQuotaError(status, message)) {
    // 真·额度/配额不足：长时间不再选它，等余额轮询或 TTL 到期再恢复。
    a.exhaustedAt = Date.now();
    a.cooldownUntil = null;
  } else {
    const step = COOLDOWN_STEPS_MS[Math.min(a.failCount, COOLDOWN_STEPS_MS.length - 1)];
    a.cooldownUntil = step ? Date.now() + step : null;
  }
  return a;
}

/** 该账号的某个模型是否正在限流冷却中（未过期才算）。 */
export function isModelRateLimited(a, model, now = Date.now()) {
  const entry = a?.modelCooldowns?.[model];
  return Boolean(entry && entry.until > now);
}

/**
 * 列出「该模型的限流还没恢复」的账号 id（启用 + 有 token + 不在 exclude 里）。
 * 轮换选号用它把冷却中的 (账号, 模型) 对排到后面；调用方负责 usableCount 守卫——
 * 全池都在冷却时不能全排除，否则没号可选。
 */
export function listModelCooldownAccounts(site, model, excludeIds = [], now = Date.now()) {
  if (!model) return [];
  const skip = new Set(excludeIds);
  return loadPool(site).accounts
    .filter((a) => a.enabled !== false && a.accessToken && !skip.has(a.id) && isModelRateLimited(a, model, now))
    .map((a) => a.id);
}

/**
 * 记录一次成功：清掉失败计数与冷却，并解除「额度耗尽」标记。
 * model（0.3.33）：传入时顺带解除该模型的限流冷却——一次成功即证明
 * 这个 (账号, 模型) 对此刻可用，比等到期更准确。
 *
 * 兼容模式（还没有池文件）下改写内存态覆盖：不能落盘（否则会凭空建出池文件），
 * 但「成功即证明额度可用」这条信息必须留下，否则一次误判的耗尽标记会一直挂到 TTL。
 */
export function markSuccess(site, id, model = '') {
  const clear = (a) => {
    a.failCount = 0;
    a.cooldownUntil = null;
    a.lastError = null;
    if (a.exhaustedAt) a.exhaustedAt = null;
    if (model && a.modelCooldowns) delete a.modelCooldowns[model];
    a.lastUsedAt = Date.now();
  };
  if (!hasPoolFile(site)) {
    return mutateLegacy(site, id, clear);
  }
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    clear(a);
    return a;
  }, { immediate: false });
}

/**
 * 记录一次失败。
 * status 用于区分处理方式：
 *   - 429/额度类：直接判定额度耗尽，长时间不再选它
 *   - 401/403：凭证失效，需要重新登录
 *   - 5xx/网络：退避冷却，过一会儿还能用
 *
 * model/modelCooldownMs（0.3.33）：限流类失败时顺带记 (账号, 模型) 粒度冷却，
 * modelCooldownMs 由调用方按 Retry-After 头计算（无头时省略 → 用缺省 60s）。
 *
 * 兼容模式只有一个账号、没有可轮换的对象，也不必为它建池文件；
 * 但状态仍要记进内存态覆盖——否则 usableCount 永远说「可用」，
 * 路由就会一直把已经 429 的单账号站点当成健康站点（详见 legacyState 说明）。
 */
export function markFailure(site, id, { status = 0, message = '', model = '', modelCooldownMs = 0 } = {}) {
  // 事件时间线（T6）：账号失败/冷却进时间线。冷却阶梯会挡住连续重试，
  // 所以正常情况下不会刷屏；真刷屏本身就是「该账号在持续失败」的信号。
  recordEvent(
    'account',
    `账号请求失败${status ? `（HTTP ${status}）` : ''}：${String(message || '未知原因').slice(0, 140)}`
      + (isQuotaError(status, message) ? '，判定额度耗尽' : ''),
    { site, accountId: id },
  );
  const extra = { status, message, model, modelCooldownMs };
  if (!hasPoolFile(site)) return mutateLegacy(site, id, (a) => applyFailure(a, extra));
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    return applyFailure(a, extra);
  });
}

/** 明确标记某账号额度耗尽（由额度查询/业务码驱动）。 */
export function markExhausted(site, id, message = '额度不足') {
  // 事件时间线（T6）：只在「可用 → 耗尽」的转变时记一条——余额轮询会对已耗尽的
  // 账号反复调用这里，不判转变的话时间线每 30 秒就被刷一条重复事件。
  const announce = (a) => {
    if (!a.exhaustedAt) {
      recordEvent('account', `账号额度耗尽：${String(message).slice(0, 140)}`, { site, accountId: id });
    }
  };
  if (!hasPoolFile(site)) {
    return mutateLegacy(site, id, (a) => {
      announce(a);
      a.exhaustedAt = Date.now();
      a.cooldownUntil = null;
      a.lastError = String(message).slice(0, 200);
      a.lastErrorAt = Date.now();
    });
  }
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    announce(a);
    a.exhaustedAt = Date.now();
    a.cooldownUntil = null;
    a.lastError = String(message).slice(0, 200);
    a.lastErrorAt = Date.now();
    return a;
  });
}

/** 手动解除耗尽/冷却（控制台「重置状态」用）。 */
export function resetAccountState(site, id) {
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.exhaustedAt = null;
    a.cooldownUntil = null;
    a.failCount = 0;
    a.lastError = null;
    // 「重置」就该重置干净：模型级限流冷却不清的话，该账号在这些模型上
    // 仍会被避让到冷却自然过期（≤60s，带 Retry-After 时更长）
    if (a.modelCooldowns && typeof a.modelCooldowns === 'object') {
      for (const k of Object.keys(a.modelCooldowns)) delete a.modelCooldowns[k];
    }
    return a;
  });
}

/** 启用/禁用账号。 */
export function setAccountEnabled(site, id, enabled) {
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.enabled = Boolean(enabled);
    return a;
  });
}

/** 改账号显示名（控制台里方便区分「小号A」之类）。 */
export function setAccountLabel(site, id, label) {
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.label = String(label).slice(0, 40);
    return a;
  });
}

/**
 * 设置/清除账号的手动到期兜底（manualExpireAt）。
 * 接口拿不到积分到期明细时，调度用它当「最早到期」；值为空串/null 时清除。
 */
export function setAccountManualExpiry(site, id, value) {
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    if (value === null || value === undefined || String(value).trim() === '') delete a.manualExpireAt;
    else a.manualExpireAt = String(value).trim().slice(0, 40);
    return a;
  });
}

/** 上游余额不足的关键词（大小写不敏感子串匹配）。 */
const QUOTA_MARKERS = /insufficient credit|no credit|credit exhausted|credits exhausted|out of credit|quota exceeded|quota exhaust|payment required|credit not enough|not enough credit|insufficient\s+(balance|quota)|额度不足|余额不足|积分不足|积分用完|额度用尽|没有积分/i;

/** 上游限流/节流的关键词。只收明确指向「速率/模型被节流」的措辞。 */
const RATE_MARKERS = /rate[\s-]?limit|too many requests|usage limit|请求过于频繁|限流|模型繁忙/i;

/** 账号级终态关键词：等不来自愈，短冷却救不活，必须让号退场。 */
const ACCOUNT_FAULT_MARKERS = /request illegal|trial not activated|session not found|12153/i;

/** 从报文里取结构化业务码（如 {"code":14003,…}）。 */
function businessCode(m) {
  const hit = /"code"\s*:\s*(\d{4,6})/.exec(m);
  return hit ? hit[1] : '';
}

/**
 * 判断错误是不是「上游限流」——账号还活着，只是此刻请求太密 / 模型繁忙。
 *
 * 分层依据 .ref/workbuddy2api-panel-main 的 Classify（2026-09 逆向，比本插件参考的版本新）：
 * **状态码比文案权威**。上游 429 的 body 高频夹带「quota exceeded」「额度不足」这类
 * 跨计费/限流两界的措辞，若先按关键词判额度，会把一次瞬时限流硬冷却到次日、白扔号约 12h。
 *
 * 必须与 isQuotaError 分开：限流若被当成额度耗尽，会给账号打上 6 小时 exhaustedAt。
 * 本机真实事故——余额 4978、批次明细分毫未动的账号，被一次 14003 打掉，pinned 策略下
 * 请求全部落到另一个余额更少的号上，余额消耗快了一倍多。
 */
export function isRateLimitError(status, message = '') {
  const m = String(message || '');
  const code = businessCode(m);

  // 账号级终态等不来自愈，不能按限流短冷却（继续重试只会反复刷上游风控）。
  if (ACCOUNT_FAULT_MARKERS.test(m)) return false;
  // 14018 = 明确的账号积分耗尽业务码，语义优先于 429 的限流兜底。
  if (code === '14018') return false;
  if (code === '14003') return true;
  // 裸 429：一律按限流处理（状态码比关键词权威）。
  if (status === 429) return true;
  // 非 429 状态码携带限流文案（200 业务信封 / 400 / 403 / 5xx 都出现过）。
  return RATE_MARKERS.test(m) && !QUOTA_MARKERS.test(m);
}

/**
 * 判断错误是否属于「这个号没额度了」。
 *
 * 真·耗尽的可靠信号是余额轮询（scheduler.mjs 的 `credit.remain <= 0 → markExhausted`），
 * 这里的报文判定只作补充，刻意从宽——宁可漏判（等轮询确认）也不误判（雪藏 6 小时）。
 */
export function isQuotaError(status, message = '') {
  const m = String(message || '');
  const code = businessCode(m);

  // 402 是最硬、最不可自愈的计费信号，最先判。
  if (status === 402) return true;
  // 14018：429 + 积分耗尽业务码，归硬额度而非可自愈的软限流。
  if (code === '14018') return true;
  // 其余一律交给 isRateLimitError 裁决（限流 / 账号级故障都不算额度耗尽）。
  if (isRateLimitError(status, m)) return false;
  // 非 429 状态码的额度措辞（200 业务信封、403 信封等）。
  return QUOTA_MARKERS.test(m);
}

/* ---------------- 增删账号 ---------------- */

/** 往池里加一个账号（登录成功后调用）。返回新账号。 */
export function addAccount(site, auth, { label } = {}) {
  const pool = loadPool(site);
  const uid = auth.uid ? String(auth.uid) : null;

  // 同一 uid 已存在 → 覆盖更新（重新登录同一个号，不该出现两条）
  const exist = uid ? pool.accounts.find((a) => a.uid && String(a.uid) === uid) : null;
  const base = {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken ?? null,
    expiresAt: auth.expiresAt ?? null,
    domain: auth.domain ?? null,
    savedAt: new Date().toISOString(),
    uid,
    nickname: auth.nickname ?? null,
  };
  if (exist) {
    Object.assign(exist, base, { enabled: true, exhaustedAt: null, cooldownUntil: null, failCount: 0, lastError: null });
    if (label) exist.label = label;
    savePool(site, pool);
    return exist;
  }

  // 首次往池里加账号时，把兼容视图里的旧账号也并进来，
  // 避免「加了新号，原来的号反而消失了」。
  const 已有 = pool.accounts.length;
  if (已有 === 0) {
    const legacy = readLegacyAuth(site);
    if (legacy) {
      pool.accounts.push({
        ...legacy.auth,
        id: DEFAULT_ACCOUNT_ID,
        label: legacy.auth.nickname || '默认账号',
        enabled: true,
        exhaustedAt: null,
        cooldownUntil: null,
        failCount: 0,
        addedAt: new Date().toISOString(),
      });
    }
  }

  const nextLabel = pool.nextLabel || pool.accounts.length + 1;
  const acc = {
    id: newId(),
    label: label || auth.nickname || `账号${nextLabel}`,
    ...base,
    enabled: true,
    exhaustedAt: null,
    cooldownUntil: null,
    failCount: 0,
    lastUsedAt: null,
    lastError: null,
    addedAt: new Date().toISOString(),
  };
  pool.accounts.push(acc);
  pool.nextLabel = nextLabel + 1;
  savePool(site, pool);
  return acc;
}

/** 删除账号。若删的是旧版默认账号，同时删掉旧凭证文件，避免它又被兼容读回来。 */
export function removeAccount(site, id) {
  const pool = loadPool(site);
  const idx = pool.accounts.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  const [removed] = pool.accounts.splice(idx, 1);
  savePool(site, pool);
  if (removed.id === DEFAULT_ACCOUNT_ID) {
    try {
      fs.rmSync(authPathFor(site), { force: true });
    } catch {
      /* 忽略 */
    }
  }
  return true;
}

/** 把账号上刷新后的 token 写回（token 刷新成功后调用）。 */
export function updateTokens(site, id, { accessToken, refreshToken, expiresAt, domain }) {
  return mutate(site, (pool) => {
    const a = pool.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.accessToken = accessToken;
    if (refreshToken) a.refreshToken = refreshToken;
    if (expiresAt !== undefined) a.expiresAt = expiresAt;
    if (domain) a.domain = domain;
    a.savedAt = new Date().toISOString();
    return a;
  });
}
