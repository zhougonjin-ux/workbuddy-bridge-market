// 每日积分预算（workbuddy-bridge 新增，T13）：今日累计消耗（估算口径，与用量页同源）
// 超过预警线时提醒一次；到 100% 且 mode=free 时，default/auto 请求自动改道免费模型
// （复用 free-first 的 findFreeModel 选型，router.mjs 调用）。
//
// 设计约束：
//   - budgetStatus 每个请求都会被路由调用，只读内存统计（usageSnapshot），不打上游；
//   - 预警/超限事件与通知每天最多发一次（warnedDay），不刷屏；
//   - 默认关闭（budget.enabled=false），重度消耗者才需要护栏。
import { usageSnapshot } from './usage.mjs';
import { recordEvent } from './events.mjs';
import { notify } from './notify.mjs';

let warnedDay = null;

/** 今日预算状态：{ enabled, spent, budget, percent, warn, exceeded }。未启用时 enabled=false。 */
export function budgetStatus(cfg) {
  const b = cfg?.budget;
  if (!b || b.enabled !== true) return { enabled: false };
  const spent = Math.round((Number(usageSnapshot(1).today?.credit) || 0) * 100) / 100;
  const budget = Number(b.dailyCredits) || 0;
  const percent = budget > 0 ? Math.min(999, Math.round((spent / budget) * 100)) : 0;
  return {
    enabled: true,
    mode: b.mode === 'free' ? 'free' : 'warn',
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
    const msg = `今日积分已消耗 ${st.spent}/${st.budget}（${st.percent}%）${st.exceeded ? '，已超限' : ''}`;
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

/** 测试隔离：重置「今天已提醒」状态。 */
export function resetBudgetAnnounce() {
  warnedDay = null;
}
