// 后台调度（workbuddy-bridge 新增）：
//   1) 积分/到期明细刷新：定期逐账号查询 get-user-resource，把每个积分包的
//      余额与到期时间写进账号池条目（creditDetail），供到期优先调度选号用
//   2) 桥接状态视图与策略设置：/admin/* 与 MCP 工具共用
//
// 设计约束：刷新循环里的任何单账号失败都不影响其他账号，也不影响主服务；
// 所有上游调用走 upstream.mjs 现有封装（token 刷新、超时、错误分类都复用）。
import { siteKeys, saveConfig } from './config.mjs';
import { listAccounts, updateCreditDetail, markExhausted, pickAccount } from './pool.mjs';
import { queryCredit, supportsCreditQuery } from './upstream.mjs';
import { suggestedPlan } from './expiry.mjs';
import { log, warn } from './log.mjs';
import { recordEvent } from './events.mjs';
import { notify } from './notify.mjs';

const timers = { credit: null, soon: null };
let lastSoonRun = 0;

/**
 * 调用后尽快刷新一次积分（节流：最多每 60 秒跑一次）。
 *
 * 背景：常规刷新循环是 30 分钟一档，用户在控制台看到的余额长时间不动，
 * 会以为调用没有记账。每次对话结束后排一个几秒后的快速刷新，
 * 让「账号与积分」面板在半分钟内跟上真实消耗（控制台本身 30 秒轮询一次）。
 */
export function scheduleCreditRefreshSoon(cfg, delayMs = 4000) {
  bumpCreditActivity(); // T31：告诉自适应刷新循环「刚有真实消耗」（活跃时下轮按最短间隔）
  if (timers.soon) return; // 已有排程在等
  if (Date.now() - lastSoonRun < 60_000) return; // 刚刷过，别频繁打上游
  timers.soon = setTimeout(async () => {
    timers.soon = null;
    lastSoonRun = Date.now();
    try {
      await refreshCreditsAll(cfg);
    } catch (e) {
      warn('调用后积分刷新失败：', e.message);
    }
  }, delayMs);
  timers.soon.unref?.();
}

/**
 * 立即刷新一个站点所有启用账号的积分/到期明细。
 * 返回 { results: [{id, label, ok, remain?, error?}] }。
 */
export async function refreshCreditsOnce(cfg, site) {
  const results = [];
  if (!supportsCreditQuery(cfg, site)) return results;
  for (const a of listAccounts(site)) {
    if (a.enabled === false || !a.accessToken) continue;
    try {
      const credit = await queryCredit(cfg, site, a.id);
      updateCreditDetail(site, a.id, credit);
      if (typeof credit.remain === 'number' && credit.remain <= 0) {
        markExhausted(site, a.id, '余额为 0');
      }
      results.push({ id: a.id, label: a.label || a.id, ok: true, remain: credit.remain });
    } catch (e) {
      results.push({ id: a.id, label: a.label || a.id, ok: false, error: String(e.message || e).slice(0, 160) });
      // 事件时间线（T6）：刷新失败通常意味着 401 登录态失效或上游异常，值得在时间线上回看
      recordEvent('credit', `积分刷新失败：${a.label || a.id}：${String(e.message || e).slice(0, 140)}`, { site, accountId: a.id });
      // T11 通知：登录态失效（401/refresh_token 缺失）需要用户重新扫码，弹一次（节流）
      const errText = String(e.message || e);
      if (/\b401\b|refresh_token|登录态|unauthorized/i.test(errText)) {
        notify(cfg, '账号登录态失效 🔴', `${a.label || a.id}（${site}）：${errText.slice(0, 100)}——请重新 /wbp-login 扫码或导入本机登录态`, { key: `account-401-${a.id}` });
      }
    }
  }
  return results;
}

/** 刷新所有站点的积分明细。 */
export async function refreshCreditsAll(cfg) {
  const out = {};
  for (const site of siteKeys(cfg)) {
    try {
      out[site] = await refreshCreditsOnce(cfg, site);
    } catch (e) {
      warn(`[${site}] 积分刷新失败：`, e.message);
      out[site] = [{ ok: false, error: String(e.message || e).slice(0, 160) }];
    }
  }
  return out;
}

/** 对话出口调用：告诉刷新循环「刚有真实消耗，缓存该跟紧一点」（T31）。
 *  startCreditLoop 启动后重绑为「记活跃时间」；未启动时是空操作。 */
let bumpCreditActivity = () => {};
export { bumpCreditActivity };
/** 启动积分刷新循环：自适应 TTL（T31）。
 *  基础间隔 = creditRefreshMinutes（默认 30 分钟）；但「用得越凶，缓存越快变陈」——
 *  最近 10 分钟里发过模型请求时按 minInterval（默认 5 分钟）刷新，连续 30 分钟无请求
 *  则回落基础间隔并逐级放慢（最多 3 倍基础值，空闲时少打上游）。
 *  纯计时器实现：每次 tick 现算下一个间隔（clearInterval + setTimeout 链）。 */
export function startCreditLoop(cfg) {
  if (timers.credit) return;
  const baseMin = Math.max(5, Number(cfg.creditRefreshMinutes) || 30);
  const minMin = Math.max(2, Math.round(baseMin / 6)); // 高活跃下限（默认 5 分钟）
  let lastRequestAt = 0; // 由 openChat 出口经 bumpCreditActivity 喂进来
  let idleStretch = 1; // 空闲放慢倍率：1 → 2 → 3（封顶）

  const tick = async () => {
    try {
      await refreshCreditsAll(cfg);
    } catch (e) {
      warn('积分刷新循环异常：', e.message);
    }
    // 根据活跃度决定下一轮间隔：10 分钟内有请求 → 下限间隔；否则逐级放慢
    const active = Date.now() - lastRequestAt < 10 * 60_000;
    if (active) idleStretch = 1;
    else if (idleStretch < 3) idleStretch += 1;
    const minutes = active ? minMin : Math.min(baseMin * idleStretch, baseMin * 3);
    scheduleNext(minutes);
  };

  const scheduleNext = (minutes) => {
    if (timers.credit) clearTimeout(timers.credit);
    timers.credit = setTimeout(tick, minutes * 60_000);
    timers.credit.unref?.();
  };

  bumpCreditActivity = () => { lastRequestAt = Date.now(); };
  // 启动 15 秒后先刷一轮，避免和启动期的登录刷新挤在一起
  const boot = setTimeout(tick, 15_000);
  boot.unref?.();
  log(`积分/到期明细刷新已启动（自适应 TTL：活跃 ${minMin} 分钟 / 空闲最多 ${baseMin * 3} 分钟）`);
}

export function stopCreditLoop() {
  if (timers.credit) clearTimeout(timers.credit);
  if (timers.soon) clearTimeout(timers.soon);
  timers.credit = null;
  timers.soon = null;
}

/**
 * 设置调度策略。
 * patch: { policy?, pinnedAccountId? }（pinnedAccountId 传 null 清除）
 */
export function setPolicy(cfg, patch = {}) {
  const issues = [];
  if (patch.policy !== undefined) {
    if (!['expiry-first', 'balance-first', 'round-robin', 'pinned', 'free-first'].includes(patch.policy)) {
      issues.push(`未知策略：${patch.policy}（可用：expiry-first / balance-first / round-robin / pinned / free-first）`);
    } else {
      cfg.pool.policy = patch.policy;
    }
  }
  if (patch.pinnedAccountId !== undefined) {
    cfg.pool.pinnedAccountId = patch.pinnedAccountId ? String(patch.pinnedAccountId) : null;
  }
  if (!issues.length) {
    saveConfig(cfg);
    // 事件时间线（T6）：策略切换（含固定账号）进时间线，回看「当时为什么走了这个号」
    recordEvent('policy', `调度策略 → ${cfg.pool.policy}${cfg.pool.pinnedAccountId ? `（固定 ${cfg.pool.pinnedAccountId}）` : ''}`);
  }
  return { ok: issues.length === 0, issues, policy: cfg.pool.policy, pinnedAccountId: cfg.pool.pinnedAccountId };
}

/**
 * 全站点的桥接状态：账号、到期明细、当前策略、建议消耗顺序。
 * redact=true 时抹掉 accessToken/refreshToken——给 SSE 推送这类不需要凭据的通道用，
 * 避免把凭据按固定周期反复推到长连接上（控制台前端并不读取这两个字段）。
 */
export function bridgeStatus(cfg, { redact = false } = {}) {
  const sites = [];
  for (const site of siteKeys(cfg)) {
    const accounts = listAccounts(site).map((a) => {
      if (!redact) return { ...a };
      const { accessToken, refreshToken, ...rest } = a;
      return rest;
    });
    // 「正在使用」：用与真实调度完全相同的 pickAccount 算出当前策略下哪个账号会被选中，
    // 控制台账号卡上据此标注。纯内存计算，不打上游。默认站点之外的站点没有调度，不标。
    const picked = site === cfg.defaultSite ? pickAccount(site) : null;
    sites.push({
      site,
      label: cfg.sites[site].label,
      policy_applies: site === cfg.defaultSite,
      accounts,
      active_account_id: picked ? picked.id : null,
      plan: suggestedPlan(accounts),
    });
  }
  return {
    policy: cfg.pool?.policy || 'expiry-first',
    pinnedAccountId: cfg.pool?.pinnedAccountId || null,
    creditRefreshMinutes: cfg.creditRefreshMinutes,
    // tasks + budget 一起下发：任务页预算卡（T13/T63）输入框初值要用真实配置——
    // 以前 tasks 里没有 budget，改过 dailyCredits/按账号预算后重开页面输入框永远显示默认值。
    tasks: { ...cfg.tasks, budget: cfg.budget },
    sites,
  };
}
