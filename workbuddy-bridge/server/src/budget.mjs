// 每日积分预算（workbuddy-bridge 新增，T13）：今日累计消耗（估算口径，与用量页同源）
// 超过预警线时提醒一次；到 100% 后按 mode 采取动作：
//   warn（默认）—— 只提醒
//   free（T13）  —— default/auto 请求自动改道免费模型（复用 free-first 的 findFreeModel）
//   pause（T37） —— 直接拒绝新请求（429），防失控烧积分
//
// 设计约束：
//   - budgetStatus 每个请求都会被路由调用，只读内存统计（usageSnapshot），不打上游；
//   - 预警/超限事件与通知每天最多发一次（warnedDay），不刷屏；
//   - 默认关闭（budget.enabled=false），重度消耗者才需要护栏。
import { usageSnapshot, todayAccountCredit } from './usage.mjs';
import { recordEvent } from './events.mjs';
import { notify } from './notify.mjs';

const BUDGET_MODES = ['warn', 'free', 'pause'];

let warnedDay = null;
let accountWarnedDay = {}; // T63：accountId → 已提醒日期（内存记忆，重启后最多重提一次）

/** 今日预算状态：{ enabled, mode, spent, budget, percent, warn, exceeded }。未启用时 enabled=false。 */
export function budgetStatus(cfg) {
  const b = cfg?.budget;
  if (!b || b.enabled !== true) return { enabled: false };
  const spent = Math.round((Number(usageSnapshot(1).today?.credit) || 0) * 100) / 100;
  const budget = Number(b.dailyCredits) || 0;
  const percent = budget > 0 ? Math.min(999, Math.round((spent / budget) * 100)) : 0;
  const mode = BUDGET_MODES.includes(b.mode) ? b.mode : 'warn';
  return {
    enabled: true,
    mode,
    spent,
    budget,
    percent,
    warn: percent >= (Number(b.warnPercent) || 80),
    exceeded: budget > 0 && spent >= budget,
  };
}

/**
 * 预警检查 + 每天最多一次的提醒（事件时间线 + 桌面通知）。
 * 路由热路径调用；本函数只做读统计与节流，绝不能抛错（调用方也会兜一层）。
 */
export function budgetCheckAndAnnounce(cfg) {
  const st = budgetStatus(cfg);
  if (!st.enabled) return st;
  const today = new Date().toISOString().slice(0, 10);
  if (st.warn && warnedDay !== today) {
    warnedDay = today;
    const action = st.mode === 'pause' ? '，新请求将被拒绝' : st.mode === 'free' ? '，default/auto 已改道免费模型' : '';
    const msg = `今日积分已消耗 ${st.spent}/${st.budget}（${st.percent}%）${st.exceeded ? '，已超限' : ''}${action}`;
    try {
      recordEvent('credit', `预算${st.exceeded ? '超限' : '预警'}：${msg}`);
      notify(cfg, st.exceeded ? '每日积分预算超限 🔴' : '每日积分预算预警 🟠', msg, { key: `budget-${today}` });
    } catch {
      /* 旁观者不绊倒主流程 */
    }
  }
  return st;
}

/**
 * 路由改道判定（纯函数便于单测）：预算超限且 mode=free 时，default/auto 哨兵
 * 改道免费模型。mode 取当前配置（改道与否是「现在的策略」，不能跟着注入状态走），
 * 消耗状态可注入（测试/调用方已有状态时免重复统计）。
 */
export function budgetRedirectActive(cfg, st = null) {
  const s = st || budgetStatus(cfg);
  const mode = cfg?.budget?.mode === 'free' ? 'free' : 'warn';
  return Boolean(s.enabled && mode === 'free' && s.exceeded);
}

/**
 * T37 预算拦截：超限且 mode=pause 时为真，路由据此拒绝新请求。
 *
 * 与 budgetRedirectActive 一样取「当前配置的 mode」而非注入状态——pause 是
 * 用户当下的护栏选择，必须跟着 config 走。
 *
 * 注意：pause 拦的是**所有**模型请求（包括显式指定模型），这是它与 free 的
 * 根本区别——free 只改道 default/auto，pause 是「今天到此为止」。所以调用方
 * 需要给它一个逃生阀，见 router.mjs 里对 /health、/console、/admin 的豁免
 * （那些路径根本不经过这里），以及 usageSnapshot 口径只统计已发生消耗这一事实。
 */
export function budgetBlockActive(cfg, st = null) {
  const s = st || budgetStatus(cfg);
  // mode 取当前配置而非注入状态：pause 是用户当下的护栏选择，改配置必须立刻生效，
  // 不能被一份注入的旧状态带偏（与 budgetRedirectActive 同一口径）。
  const mode = BUDGET_MODES.includes(cfg?.budget?.mode) ? cfg.budget.mode : 'warn';
  return Boolean(s.enabled && mode === 'pause' && s.exceeded);
}

/** 拦截时给用户看的错误（带 status 让 server.mjs 的 catch 直接转 429）。 */
export function budgetBlockError(st) {
  const e = new Error(
    `每日积分预算已用尽（今日 ${st.spent}/${st.budget} 积分）。`
    + '预算超限动作设为「暂停新请求」，已拒绝本次调用。'
    + '可在控制台「自动任务 → 每日积分预算」调高预算、切换动作，或关掉预算。',
  );
  e.status = 429;
  e.type = 'budget_exceeded';
  e.code = 429;
  return e;
}

/** 测试隔离：重置「今天已提醒」状态。 */
export function resetBudgetAnnounce() {
  warnedDay = null;
  accountWarnedDay = {};
}

/* ---------------- T63：按账号每日预算 ----------------
 * 全局预算（T13）管总量，这里管单账号：多账号场景下「这个小号每天最多烧 N」。
 * 语义边界（刻意从窄）：只做提醒 + 控制台展示，**不改道也不拦截**——路由在
 * resolveTarget 阶段还不知道最终选中哪个账号（pickAccount 在其后），要拦就得把
 * 预算检查塞进请求热路径深处，误伤面大。全局 pause（T37）才是硬护栏。
 */

/** 某账号的每日预算（cfg.budget.accounts[accountId]），未设/非法返回 null。 */
export function accountBudgetOf(cfg, accountId) {
  const m = cfg?.budget?.accounts;
  if (!m || typeof m !== 'object') return null;
  const v = Number(m[accountId]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 某账号今日预算状态；未设预算返回 null。
 * spentMap 可注入（'site/accountId' → credit，todayAccountCredit 的返回形状），
 * 匹配 'accountId' 或 'site/accountId' 两种键——调用方不必关心键形态。
 */
export function accountBudgetStatus(cfg, accountId, spentMap = null) {
  const daily = accountBudgetOf(cfg, accountId);
  if (daily == null) return null;
  const map = spentMap || todayAccountCredit();
  let spent = 0;
  for (const [k, v] of Object.entries(map)) {
    if (k === accountId || k.endsWith('/' + accountId)) spent += Number(v) || 0;
  }
  spent = Math.round(spent * 100) / 100;
  const percent = Math.min(999, Math.round((spent / daily) * 100));
  return {
    daily,
    spent,
    percent,
    exceeded: spent >= daily,
    warn: percent >= (Number(cfg?.budget?.warnPercent) || 80),
  };
}

/**
 * 全部启用账号的预算状态（/bridge 每 20s 调用：返回值下发前端，超限顺带每天提醒一次）。
 * accounts 形如 [{ site, id, label }]；spentMap 可注入（单测/调用方已有数据时免重读）。
 * 门控是「配置了至少一条按账号预算」而非 budget.enabled——两个开关独立：
 * 全局预算关着、单账号护栏照样要生效（否则账号卡徽标与预警条口径不一致）。
 */
export function accountBudgetCheckAndAnnounce(cfg, accounts, { spentMap = null } = {}) {
  const m = cfg?.budget?.accounts;
  if (!m || typeof m !== 'object' || !Object.keys(m).length) return [];
  const map = spentMap || todayAccountCredit();
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const { site, id, label } of accounts || []) {
    const st = accountBudgetStatus(cfg, id, map);
    if (!st) continue;
    out.push({ id, site, label: label || id, ...st });
    if (st.exceeded && accountWarnedDay[id] !== today) {
      accountWarnedDay[id] = today;
      try {
        recordEvent('credit', `账号预算超限：${label || id} 今日 ${st.spent}/${st.daily}（${st.percent}%）`);
        notify(cfg, '账号每日预算超限 🔴', `${label || id}：今日已消耗 ${st.spent}/${st.daily} 积分（按账号预算）`, { key: `budget-acct-${id}` });
      } catch { /* 旁观者不绊倒主流程 */ }
    }
  }
  return out;
}
