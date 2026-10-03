// 积分耗尽预测（T32）：expiry-first 只解决「先烧哪批」，没解决「哪批烧不完」。
//
// 场景：用户买了一个月的大额积分包，但这周只用来写短对话，按当前速率
// 到期时还剩 60% 没动——那部分积分到期就白白蒸发了。本模块用
// 「近 7 日日均消耗」推算每个批次到期前还能烧掉多少，标出「预计用不完」
// 并给出可执行建议（提前几天集中跑长任务）。
//
// 设计约束：
//   - 纯计算，不打上游、不写盘——预测只是给用户决策参考，错了不会造成损失；
//   - 纯函数 predictBurnout 便于单测（不依赖 usage.json / config 读取）；
//   - 拿不到到期时间或日均速率为 0 时如实返回「无法预测」，绝不瞎猜一个
//     「用不完」的结论（false positive 会让用户白花力气跑没必要的任务）。
import { recentDailyCreditAvg } from './usage.mjs';

// 判定「用不完」的阈值：到期前预计只能烧掉批次余量的 80% 以下就算用不完。
// 留 20% 余量是因为日均消耗本身有波动（某天赶一个大活就能翻倍），
// 卡太紧会把正常批次误报成浪费。
const WASTE_RATIO = 0.8;

/** 单个批次的耗尽预测（纯函数，可单测）。 */
export function predictBatch(batch, { dailyAvg = 0, now = Date.now() } = {}) {
  const remain = Math.max(0, Number(batch?.remain) || 0);
  const expireAt = Number(batch?.expireAt);
  const base = {
    remain,
    expireAt: Number.isFinite(expireAt) ? expireAt : null,
    dailyAvg: Math.max(0, Number(dailyAvg) || 0),
    daysLeft: null,
    projectedUse: null,
    projectedRemain: null,
    // 字段契约：无法预测（提前 return）时 wasteCredits 为 null（= 没算出来，
    // 展示层应显示「—」而不是 0）；算出结论后，判定「用得完」为 0、
    // 判定「用不完」为预计过期时的剩余量。
    wasteCredits: null,
    willExpireUnused: false,
    advice: null,
    reason: null,
  };

  if (remain <= 0) return { ...base, reason: 'empty' };
  if (!Number.isFinite(expireAt) || expireAt <= 0) return { ...base, reason: 'no-expiry' };
  if (expireAt <= now) return { ...base, reason: 'expired' };
  if (!(base.dailyAvg > 0)) return { ...base, reason: 'no-usage' };

  // 剩余天数。不足一天时按「今天还能用完当天余量」折算成 0.25 天下限，
  // 免得一个还剩 3 小时的批次被算成「0 天 = 烧不掉」而误报。
  const daysLeft = Math.max(0.25, (expireAt - now) / 86_400_000);
  const projectedUse = base.dailyAvg * daysLeft;
  const projectedRemain = Math.max(0, remain - projectedUse);
  const willExpireUnused = projectedRemain > remain * (1 - WASTE_RATIO);

  return {
    ...base,
    daysLeft: Math.round(daysLeft * 10) / 10,
    projectedUse: round1(projectedUse),
    projectedRemain: round1(projectedRemain),
    wasteCredits: willExpireUnused ? round1(projectedRemain) : 0,
    willExpireUnused,
    advice: willExpireUnused ? adviceFor(projectedRemain, daysLeft) : null,
    reason: null,
  };
}

/** 建议文案：越接近到期越紧迫，措辞跟着变。 */
function adviceFor(waste, daysLeft) {
  const w = Math.round(waste);
  if (daysLeft <= 1) return `这批 ${w} 积分今天/明天就过期且用不完，建议今天集中跑长任务消耗掉`;
  if (daysLeft <= 3) return `这批 ${w} 积分还剩 ${Math.round(daysLeft)} 天过期，按当前速率用不完，建议这 2 天内集中跑长任务`;
  return `这批 ${w} 积分到期时预计用不完，建议在 ${Math.round(daysLeft)} 天内集中跑几个长任务消耗掉`;
}

/**
 * 一个账号所有批次的耗尽预测（纯函数）。
 * 返回 { batches: [...], riskCount, totalWaste }，riskCount>0 值得上预警条。
 */
export function predictAccount(account, { dailyAvg = 0, now = Date.now() } = {}) {
  const list = Array.isArray(account?.creditDetail) ? account.creditDetail : [];
  const batches = list.map((b) => ({ ...b, burnout: predictBatch(b, { dailyAvg, now }) }));
  const risks = batches.filter((b) => b.burnout.willExpireUnused);
  return {
    dailyAvg: Math.max(0, Number(dailyAvg) || 0),
    batches,
    riskCount: risks.length,
    totalWaste: round1(risks.reduce((s, b) => s + (b.burnout.wasteCredits || 0), 0)),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * 全账号耗尽预测报告（真实数据入口）。
 * dailyAvg 缺省取 usage.json 的近 7 日日均消耗。
 *
 * 返回 { dailyAvg, accounts: [{site, id, label, ...}], riskCount, totalWaste }
 * —— accounts 里每个都带 batches（已挂 burnout 字段），控制台账号卡直接消费。
 */
export function burnoutReport(siteAccounts, { dailyAvg = null, days = 7, now = Date.now() } = {}) {
  const avg = dailyAvg === null ? recentDailyCreditAvg(days) : Math.max(0, Number(dailyAvg) || 0);
  const accounts = [];
  for (const { site, account } of siteAccounts || []) {
    if (!account) continue;
    const p = predictAccount(account, { dailyAvg: avg, now });
    accounts.push({
      site,
      id: account.id,
      label: account.label || account.nickname || account.id,
      enabled: account.enabled !== false,
      ...p,
    });
  }
  return {
    dailyAvg: round1(avg),
    days,
    accounts,
    riskCount: accounts.reduce((s, a) => s + a.riskCount, 0),
    totalWaste: round1(accounts.reduce((s, a) => s + a.totalWaste, 0)),
  };
}
