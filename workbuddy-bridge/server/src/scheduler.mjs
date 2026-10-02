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

/** 启动积分刷新循环（启动时先跑一次，之后按 creditRefreshMinutes 间隔）。 */
export function startCreditLoop(cfg) {
  if (timers.credit) return;
  const tick = async () => {
    try {
      await refreshCreditsAll(cfg);
    } catch (e) {
      warn('积分刷新循环异常：', e.message);
    }
  };
  // 启动 15 秒后先刷一轮，避免和启动期的登录刷新挤在一起
  const boot = setTimeout(tick, 15_000);
  boot.unref?.();
  const ms = Math.max(5, Number(cfg.creditRefreshMinutes) || 30) * 60_000;
  timers.credit = setInterval(tick, ms);
  timers.credit.unref?.();
  log(`积分/到期明细刷新已启动：每 ${Math.round(ms / 60000)} 分钟一次`);
}

export function stopCreditLoop() {
  if (timers.credit) clearInterval(timers.credit);
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
    if (!['expiry-first', 'balance-first', 'round-robin', 'pinned'].includes(patch.policy)) {
      issues.push(`未知策略：${patch.policy}（可用：expiry-first / balance-first / round-robin / pinned）`);
    } else {
      cfg.pool.policy = patch.policy;
    }
  }
  if (patch.pinnedAccountId !== undefined) {
    cfg.pool.pinnedAccountId = patch.pinnedAccountId ? String(patch.pinnedAccountId) : null;
  }
  if (!issues.length) saveConfig(cfg);
  return { ok: issues.length === 0, issues, policy: cfg.pool.policy, pinnedAccountId: cfg.pool.pinnedAccountId };
}

/** 全站点的桥接状态：账号、到期明细、当前策略、建议消耗顺序。 */
export function bridgeStatus(cfg) {
  const sites = [];
  for (const site of siteKeys(cfg)) {
    const accounts = listAccounts(site).map((a) => ({ ...a }));
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
    tasks: cfg.tasks,
    sites,
  };
}
