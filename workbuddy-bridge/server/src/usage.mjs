// 用量统计：按天 / 站点 / 模型累计调用次数、token 与 credit 消耗，落盘到 usage.json。
// 只在本项目目录内读写；写入做了节流，避免每次请求都打盘。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.mjs';
import { warn } from './log.mjs';
import { getCatalog, parseMultiplier, setObservedCostProvider } from './router.mjs';

// 观测成本注入（0.3.33）：router 的 free-first 选型与后缀展示需要读观测数据，
// 但 router→budget→usage→router 成环——模块顶层注册会撞 router 侧 `let` 的 TDZ
// （usage 先于 router 求值完成）。改为首次调用时惰性注册：那时所有模块都已初始化。

/**
 * credit 统计：上游流式帧的 usage 里通常没有 credit 字段（只有非流式聚合偶尔带），
 * 直接 `?? 0` 会让「积分消耗」曲线恒为 0。这里在上游没报时用
 * 模型倍率（parseMultiplier）× tokens 估算一个近似值。
 *
 * 口径：倍率 x0.06 表示每 token 扣 0.06 credit，所以 credit ≈ (prompt+completion) × mult。
 * 估算值只进用量统计，不代表上游真实扣费；目录拉不到（Infinity）时不估，如实记 0。
 *
 * ⚠️ 0 是有效实报（0.3.34 修）：上游对夜间免费/限时免费模型实扣就是 0——
 * 旧守卫 `> 0` 把真 0 当「没报」再用倍率估算，观测成本、后缀翻转与用量统计
 * 全部被估算值污染（实测：hy4-preview 夜间上游实报 0，桥接记成估算 0.02）。
 * 只有「没报」（undefined/null/NaN）才回落估算。
 */
export async function estimateCredit(cfg, site, model, upstreamCredit, promptTokens, completionTokens) {
  if (Number.isFinite(upstreamCredit)) return upstreamCredit;
  try {
    const cat = await getCatalog(cfg, site);
    const info = cat.models.get(model);
    const mult = parseMultiplier(info?.credits);
    if (!Number.isFinite(mult)) return 0;
    return (promptTokens + completionTokens) * mult;
  } catch {
    return 0;
  }
}

// 与 config.json 同目录（跟随 setConfigDir / WB_CONFIG_DIR 变化，不冻结路径）
const file = () => path.join(paths.root, 'usage.json');
const SAVE_DELAY_MS = 3000;

let data = { days: {}, balance: {} };
let dirty = false;
let timer = null;
let loadedFrom = null;

/**
 * 「今天」的键（YYYY-MM-DD）。
 * 必须用本地日期：toISOString() 给的是 UTC 日期，东八区下一天的边界会落在早上 8 点，
 * 凌晨 0~8 点的用量会被记进前一天，「用量统计」的日切就错位了。
 */
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 确保已从当前配置目录加载过 usage.json。
 * 之所以做成惰性 + 记住来源路径：配置目录可能在运行期被切换（测试隔离），
 * 冻结在模块加载时会导致写到旧目录。
 */
function ensureLoaded() {
  const f = file();
  if (loadedFrom === f) return;
  loadedFrom = f;
  try {
    if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8'));
    else data = { days: {}, balance: {} };
  } catch (e) {
    warn('usage.json 读取失败，重新开始统计：', e.message);
    data = { days: {}, balance: {} };
  }
  if (!data.days) data.days = {};
  if (!data.balance) data.balance = {};
}
ensureLoaded();

function saveNow() {
  dirty = false;
  try {
    fs.writeFileSync(file(), JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (e) {
    warn('usage.json 写入失败：', e.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (dirty) saveNow();
  }, SAVE_DELAY_MS);
  timer.unref?.();
}

export function flushUsage() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (dirty) saveNow();
}

function dayOf(key = todayKey()) {
  ensureLoaded();
  if (!data.days[key]) data.days[key] = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0, hours: {}, models: {}, accounts: {} };
  // 老数据（在 accounts 维度上线前落的盘）就地补，不动已有字段
  if (!data.days[key].accounts) data.days[key].accounts = {};
  return data.days[key];
}

/** 记录一次调用。account = 实际出力的账号 id（T36 报表的账号维度；缺失时记 'unknown'）。 */
export function recordUsage({ site, model, mode, status, promptTokens = 0, completionTokens = 0, credit = 0, ms = 0, tools = 0, account = null }) {
  const day = dayOf();
  const ok = status >= 200 && status < 400;
  day.calls += 1;
  if (!ok) day.errors += 1;
  day.promptTokens += promptTokens || 0;
  day.completionTokens += completionTokens || 0;
  day.credit += credit || 0;
  day.ms = (day.ms || 0) + (ms || 0); // 供「平均输出速度」= Σcompletion / Σms 计算
  // 小时分布（T7）：本地小时为键，控制台「今日小时分布」柱状图用。
  // 旧版本落盘的 day 可能没有 hours 字段，这里就地补。
  if (!day.hours) day.hours = {};
  const hk = String(new Date().getHours());
  if (!day.hours[hk]) day.hours[hk] = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0 };
  const h = day.hours[hk];
  h.calls += 1;
  if (!ok) h.errors += 1;
  h.promptTokens += promptTokens || 0;
  h.completionTokens += completionTokens || 0;
  h.credit += credit || 0;
  h.ms += ms || 0;
  const key = `${site}/${model}`;
  if (!day.models[key]) day.models[key] = { site, model, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0, tools: 0 };
  const m = day.models[key];
  m.calls += 1;
  if (!ok) m.errors += 1;
  m.promptTokens += promptTokens || 0;
  m.completionTokens += completionTokens || 0;
  m.credit += credit || 0;
  m.ms += ms || 0;
  m.tools += tools || 0;
  // 观测成本（0.3.33）：记**最近一次**的实际计费与时间。不能用日均值当观测信号——
  // 白天 x0.29 和夜间免费混在一起平均就不为 0 了；「最近一次实付」配上 TTL
  // 才是「这个模型现在免不免费」的正确依据（时段性促销不跨窗，TTL 6h）。
  m.lastCredit = credit || 0;
  m.lastAt = Date.now();
  // 账号维度（T36）：同一个模型可能被多个账号轮流服务，报表要能按账号归集消耗。
  // 键用 站点/账号id —— 账号 id 全局唯一，但带上站点在导出时更直观。
  const ak = `${site}/${account || 'unknown'}`;
  if (!day.accounts) day.accounts = {};
  if (!day.accounts[ak]) day.accounts[ak] = { site, account: account || null, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0 };
  const a = day.accounts[ak];
  a.calls += 1;
  if (!ok) a.errors += 1;
  a.promptTokens += promptTokens || 0;
  a.completionTokens += completionTokens || 0;
  a.credit += credit || 0;
  a.ms += ms || 0;
  scheduleSave();
}

/** 记录一次余额快照（用于画余额趋势）。 */
export function recordBalance(site, remain) {
  if (typeof remain !== 'number' || !Number.isFinite(remain)) return;
  ensureLoaded();
  const list = data.balance[site] || (data.balance[site] = []);
  const last = list[list.length - 1];
  const now = Date.now();
  // 值没变化就没必要记（去掉无意义的重复点）
  if (last && last.v === remain) return;
  // 节流：60 秒内不重复采样，避免控制台轮询（20s 一次）把数组刷满
  if (last && now - last.t < 60_000) return;
  list.push({ t: now, v: remain });
  if (list.length > 500) list.splice(0, list.length - 500);
  scheduleSave();
}

/** T46 用量周报：把原始 days map（'YYYY-MM-DD' → 当日统计）暴露给 weekly.mjs 按自然周聚合。 */
export function usageDays() {
  ensureLoaded();
  return data.days;
}

/** 汇总：今天 / 最近 N 天 / 按模型排行 / 余额趋势 / 今日小时分布。 */
export function usageSnapshot(days = 7) {
  ensureLoaded();
  const today = todayKey();
  const t = data.days[today] || { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, models: {} };
  // 今日小时分布（T7）：固定 24 桶（本地时区），旧数据没有 hours 字段时全为 0
  const todayHours = [];
  for (let i = 0; i < 24; i++) {
    const b = (t.hours || {})[String(i)] || {};
    todayHours.push({ hour: i, calls: b.calls || 0, errors: b.errors || 0, credit: b.credit || 0, completionTokens: b.completionTokens || 0 });
  }
  const keys = Object.keys(data.days).sort().slice(-days);
  const recent = keys.map((k) => ({ date: k, ...data.days[k], models: undefined }));
  const totals = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0 };
  const byModel = new Map();
  for (const k of Object.keys(data.days)) {
    const d = data.days[k];
    totals.calls += d.calls;
    totals.errors += d.errors;
    totals.promptTokens += d.promptTokens;
    totals.completionTokens += d.completionTokens;
    totals.credit += d.credit;
    totals.ms += d.ms || 0;
    for (const [mid, m] of Object.entries(d.models || {})) {
      const cur = byModel.get(mid) || { id: mid, site: m.site, model: m.model, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0 };
      cur.calls += m.calls;
      cur.errors += m.errors;
      cur.promptTokens += m.promptTokens;
      cur.completionTokens += m.completionTokens;
      cur.credit += m.credit;
      cur.ms += m.ms || 0;
      byModel.set(mid, cur);
    }
  }
  return {
    today: { date: today, ...t, hours: undefined, models: undefined },
    todayHours,
    todayByModel: Object.values(t.models || {}).sort((a, b) => b.calls - a.calls),
    recent,
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.credit - a.credit || b.calls - a.calls),
    balance: data.balance,
    since: Object.keys(data.days).sort()[0] || today,
  };
}

/** T63：今日按账号的消耗（键 = `${site}/${accountId}`，与 day.accounts 维度同源）。
 *  按账号预算的消耗读取口；无数据返回空对象，绝不抛错。 */
export function todayAccountCredit() {
  const t = data.days[todayKey()];
  const out = {};
  for (const [ak, a] of Object.entries(t?.accounts || {})) out[ak] = a.credit || 0;
  return out;
}

export function resetUsage() {
  data = { days: {}, balance: {} };
  dirty = true;
  loadedFrom = file(); // 标记为已加载，避免下次调用又把旧文件读回来
  saveNow();
}

/**
 * 今日各「site/model」的平均单次 credit 消耗（credit 异常检测的基线，T9）。
 * 按模型而不是全站均值：不同模型倍率差一个数量级，混在一起基线就失真了。
 * calls=0 或 credit=0（免费模型）的不返回——没有基线就不判异常。
 */
export function todayAvgCreditByModel() {
  ensureLoaded();
  const out = {};
  const t = data.days[todayKey()];
  if (!t) return out;
  for (const m of Object.values(t.models || {})) {
    if (m.calls > 0 && m.credit > 0) out[`${m.site}/${m.model}`] = m.credit / m.calls;
  }
  return out;
}

let observedRegistered = false;
function ensureRegistered() {
  if (observedRegistered) return;
  observedRegistered = true;
  try {
    setObservedCostProvider(() => observedCostByModel());
  } catch { /* router 未就绪就放弃注入：选型/后缀回落纯目录行为 */ }
}

/**
 * 观测成本（0.3.33）：每个 (站点/模型) **最近一次实际计费**的值与时间。
 *
 * 数据来自 recordUsage 的 day.models（credit 是上游实报折算后的最终值），
 * lastAt 供时段性促销判定新鲜度。TTL 语义与 Go 参考实现的 modelCostTTL 同款：
 * 默认 6 小时——「夜间免费」这类时段优惠的观测不得跨时段生效。
 * 允许跨天读：23:50 的观测在 00:10 读仍新鲜（扫描今天 + 昨天，TTL 自己淘汰过期项）。
 */
export function observedCostByModel(maxAgeMs = 6 * 60 * 60 * 1000) {
  ensureRegistered();
  ensureLoaded();
  const out = {};
  const cutoff = Date.now() - maxAgeMs;
  const keys = Object.keys(data.days).sort().slice(-2);
  for (const k of keys) {
    const t = data.days[k];
    for (const m of Object.values(t?.models || {})) {
      if (!m.calls || m.lastAt == null || m.lastAt < cutoff) continue;
      const key = `${m.site}/${m.model}`;
      const prev = out[key];
      if (!prev || m.lastAt > prev.at) {
        out[key] = { credit: m.lastCredit ?? 0, at: m.lastAt, calls: m.calls };
      }
    }
  }
  return out;
}

/**
 * 近 N 天日均积分消耗（积分耗尽预测的速率基准，T32）。
 *
 * 只统计**有消耗的天**：把没用过的日子算进分母会把速率压低，
 * 预测出「按当前速率用得完」的乐观结论——而那正是这个功能要防的误判。
 * 完全没有消耗记录时返回 0（调用方据此显示「近期无消耗」而不是当成无限速）。
 */
export function recentDailyCreditAvg(days = 7) {
  ensureLoaded();
  const keys = Object.keys(data.days).sort().slice(-days);
  let sum = 0;
  let n = 0;
  for (const k of keys) {
    const c = Number(data.days[k]?.credit) || 0;
    if (c > 0) { sum += c; n += 1; }
  }
  return n > 0 ? sum / n : 0;
}

/* ---------------- T36：用量报表导出 CSV ---------------- */

/** 单个字段的 CSV 转义（纯函数）。含分隔符/引号/换行时用双引号包起来，内部引号翻倍。 */
export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 一行 → 一行 CSV（纯函数）。 */
export function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

const DIM_LABEL = { model: '按模型', account: '按账号', day: '按日期' };

/**
 * 生成用量报表 CSV（T36）。三个维度各自成段，段前空行 + 「# 维度」注释行，
 * 这样单个文件丢进 Excel 也能一眼看出分段。
 *
 * 纯函数（只读 data，不落盘），便于单测断言列头与转义。
 * accountLabel 可选：把 acc_xxx 映射成用户自己起的名字（/usage/export 由 console-api 传入）。
 */
export function usageCsv(days = 7, { accountLabel = null } = {}) {
  ensureLoaded();
  const keys = Object.keys(data.days).sort().slice(-days);
  const out = [];
  const label = (site, id) => (accountLabel ? accountLabel(site, id) : id) || id || 'unknown';

  // ---- 段 1：按模型 × 日期 ----
  out.push(`# ${DIM_LABEL.model}（近 ${days} 天）`);
  out.push(csvRow(['日期', '站点', '模型', '调用', '错误', '输入tok', '输出tok', '积分']));
  for (const k of keys) {
    for (const m of Object.values(data.days[k].models || {})) {
      out.push(csvRow([k, m.site, m.model, m.calls, m.errors, m.promptTokens, m.completionTokens, round2(m.credit)]));
    }
  }

  // ---- 段 2：按账号 × 日期 ----
  out.push('');
  out.push(`# ${DIM_LABEL.account}（近 ${days} 天）`);
  out.push(csvRow(['日期', '站点', '账号', '调用', '错误', '输入tok', '输出tok', '积分']));
  for (const k of keys) {
    for (const a of Object.values(data.days[k].accounts || {})) {
      out.push(csvRow([k, a.site, label(a.site, a.account), a.calls, a.errors, a.promptTokens, a.completionTokens, round2(a.credit)]));
    }
  }

  // ---- 段 3：按日期汇总 ----
  out.push('');
  out.push(`# ${DIM_LABEL.day}（近 ${days} 天）`);
  out.push(csvRow(['日期', '调用', '错误', '输入tok', '输出tok', '积分']));
  let cAll = 0, eAll = 0, pAll = 0, tAll = 0, crAll = 0;
  for (const k of keys) {
    const d = data.days[k];
    cAll += d.calls || 0; eAll += d.errors || 0;
    pAll += d.promptTokens || 0; tAll += d.completionTokens || 0; crAll += d.credit || 0;
    out.push(csvRow([k, d.calls, d.errors, d.promptTokens, d.completionTokens, round2(d.credit)]));
  }
  out.push(csvRow(['合计', cAll, eAll, pAll, tAll, round2(crAll)]));

  // Excel 打开中文 CSV 需要 BOM，否则表头会显示成乱码
  return '﻿' + out.join('\r\n') + '\r\n';
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
