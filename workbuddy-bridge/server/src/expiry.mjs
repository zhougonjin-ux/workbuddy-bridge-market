// 积分到期时间解析与调度排序（workbuddy-bridge 新增能力）。
//
// 数据来源：
//   - 上游 /v2/billing/meter/get-user-resource 返回的每个资源包（Account）里，
//     到期时间字段的口径有三代：ExpiredTime / PackageEndTime / CycleEndTime，
//     实测国内版真实下发的是 CycleEndTime（"YYYY-MM-DD HH:mm:ss"，本机时区）。
//     这里三个都读，谁有值用谁；解析失败视为「无到期信息」。
//   - 用户也可以在账号池文件（auth.<site>.pool.json）里给账号手填
//     manualExpireAt（ISO 字符串或毫秒时间戳）作为兜底——接口拿不到到期
//     时间时它生效；接口有明细时两者取更早的。
//
// 调度策略（config.json → pool.policy）：
//   expiry-first  默认。优先使用「最早到期且有余额」的账号，把快过期的积分先消耗掉
//   balance-first 余额多的账号先用
//   round-robin   最久未用的先用（上游开源代理的默认行为）
//   pinned        固定使用 pool.pinnedAccountId 指定的账号，不可用时回落 expiry-first

/** 上游到期时间候选字段（按优先级）。 */
const UPSTREAM_END_FIELDS = ['CycleEndTime', 'PackageEndTime', 'ExpiredTime', 'EndTime'];

/**
 * 解析上游的到期时间字符串。
 * 兼容 "2026-10-15 00:00:00"（本机时区）、"2026-10-15"、ISO 8601 与毫秒时间戳。
 * 解析失败返回 null，绝不抛错（调度不能因为脏数据挂掉）。
 */
export function parseUpstreamDateTime(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 纯数字：可能是秒或毫秒时间戳。按量级判断，10^12 以下视为秒。
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  // "2026-10-15 00:00:00" → 按本机时区解析。注意纯日期 "2026-10-15" 若直接交给
  // Date.parse 会按 ES 规范解析成 **UTC 零点**（东八区等于早上 8 点），所以
  // 日期与日期时间都要显式补全成带 T 的本地时间形态再解析。
  let iso = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s + 'T00:00:00';
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) iso = s.replace(' ', 'T');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 从一个上游资源包对象里提取到期毫秒值；拿不到返回 null。 */
export function packageExpireAt(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  for (const f of UPSTREAM_END_FIELDS) {
    if (pkg[f] !== undefined && pkg[f] !== null && String(pkg[f]).trim() !== '') {
      const t = parseUpstreamDateTime(pkg[f]);
      if (t) return t;
    }
  }
  return null;
}

/** 把上游 get-user-resource 的 Accounts 数组规整成本地批次明细。 */
export function normalizeCreditDetail(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  return list.map((a) => {
    const cycleSize = Number(a?.CycleCapacitySize) || 0;
    const rawRemain = cycleSize > 0 ? a?.CycleCapacityRemain : a?.CapacityRemain;
    const remain = Math.max(0, Number(rawRemain) || 0);
    return {
      package: a?.PackageName ?? null,
      remain,
      used: a?.CycleCapacityUsed ?? a?.CapacityUsed ?? null,
      expireAt: packageExpireAt(a),
      expireAtRaw: UPSTREAM_END_FIELDS.map((f) => a?.[f]).find((v) => v !== undefined && v !== null && String(v).trim() !== '') ?? null,
    };
  });
}

/**
 * 账号当前有效余额：creditDetail 各批 remain 之和（无明细时回退 creditRemain 缓存）。
 */
export function accountRemaining(a) {
  if (a && Array.isArray(a.creditDetail) && a.creditDetail.length) {
    return a.creditDetail.reduce((s, b) => s + (Number(b.remain) || 0), 0);
  }
  return Number.isFinite(Number(a?.creditRemain)) ? Number(a.creditRemain) : null;
}

/**
 * 账号的「最早未过期批次」到期时刻。
 * 优先 API 明细（remain>0 且未过期批次里最早的 expireAt）；
 * manualExpireAt 手填值与明细取更早者（手填表示「这批积分到期要优先用掉」）。
 * 无任何到期信息返回 null。
 */
export function accountEarliestExpiry(a, now = Date.now()) {
  let best = null;
  if (a && Array.isArray(a.creditDetail)) {
    for (const b of a.creditDetail) {
      const t = Number(b?.expireAt);
      const remain = Number(b?.remain) || 0;
      if (!Number.isFinite(t) || remain <= 0 || t <= now) continue;
      if (!best || t < best) best = t;
    }
  }
  const manual = a?.manualExpireAt !== undefined && a?.manualExpireAt !== null && a?.manualExpireAt !== ''
    ? parseUpstreamDateTime(a.manualExpireAt)
    : null;
  if (manual && manual > now && (!best || manual < best)) best = manual;
  return best;
}

/**
 * 依据调度策略给候选账号排序。
 * 输入 accounts 是「已过滤掉禁用/无 token/被排除」后的候选副本数组。
 * 返回排好序的新数组（不改入参）；池为空返回 []。
 *
 * 所有策略都先保证：未耗尽的排在耗尽前面、失败少的排前面（沿用原代理的保守约束），
 * 然后才按策略分序。
 */
export function orderAccounts(accounts, { policy = 'expiry-first', pinnedAccountId = null, now = Date.now() } = {}) {
  const list = Array.isArray(accounts) ? [...accounts] : [];
  if (!list.length) return list;

  const exhaustedRank = (a, t) => (a.exhaustedAt && t - a.exhaustedAt < 6 * 60 * 60 * 1000 ? 1 : 0);

  const byStability = (a, b) => {
    const ea = exhaustedRank(a, now);
    const eb = exhaustedRank(b, now);
    if (ea !== eb) return ea - eb;
    return (a.failCount || 0) - (b.failCount || 0);
  };

  if (policy === 'round-robin') {
    // 最久未用的先用（lastUsedAt 为空视为最久）
    list.sort((a, b) => byStability(a, b) || (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
    return list;
  }

  if (policy === 'balance-first') {
    list.sort((a, b) => {
      const stab = byStability(a, b);
      if (stab) return stab;
      const ra = accountRemaining(a);
      const rb = accountRemaining(b);
      // 余额未知（null）排最后，避免瞎猜压过有数据的账号
      const va = ra === null ? Number.NEGATIVE_INFINITY : ra;
      const vb = rb === null ? Number.NEGATIVE_INFINITY : rb;
      return vb - va || (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
    });
    return list;
  }

  // expiry-first（默认）与 pinned（不可用时也走这套）
  list.sort((a, b) => {
    const stab = byStability(a, b);
    if (stab) return stab;
    const ta = accountEarliestExpiry(a, now);
    const tb = accountEarliestExpiry(b, now);
    // 有到期信息的永远优先于没有信息的；都没有时按余额少→多（先耗小的）→最久未用
    if (ta !== null && tb !== null) {
      if (ta !== tb) return ta - tb;
      const ra = accountRemaining(a);
      const rb = accountRemaining(b);
      if (ra !== null && rb !== null && ra !== rb) return ra - rb;
      return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
    }
    if (ta !== null) return -1;
    if (tb !== null) return 1;
    const ra = accountRemaining(a);
    const rb = accountRemaining(b);
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
  });

  if (policy === 'pinned' && pinnedAccountId) {
    const idx = list.findIndex((a) => a.id === pinnedAccountId);
    if (idx > 0) {
      const [pinned] = list.splice(idx, 1);
      list.unshift(pinned);
    }
  }
  return list;
}

/** 按到期时间给出「建议消耗顺序」（展示用，不过滤禁用态之外的任何账号）。 */
export function suggestedPlan(accounts, { now = Date.now() } = {}) {
  const rows = (Array.isArray(accounts) ? accounts : []).map((a) => ({
    id: a.id,
    label: a.label || a.nickname || a.id,
    enabled: a.enabled !== false,
    remain: accountRemaining(a),
    earliestExpiry: accountEarliestExpiry(a, now),
    batches: (Array.isArray(a.creditDetail) ? a.creditDetail : [])
      .map((b) => ({ package: b.package, remain: Number(b.remain) || 0, expireAt: b.expireAt ?? null }))
      .sort((x, y) => (x.expireAt ?? Infinity) - (y.expireAt ?? Infinity)),
    exhausted: Boolean(a.exhaustedAt),
  }));
  rows.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.exhausted !== b.exhausted) return a.exhausted ? 1 : -1;
    const ta = a.earliestExpiry ?? Infinity;
    const tb = b.earliestExpiry ?? Infinity;
    return ta - tb;
  });
  return rows;
}
