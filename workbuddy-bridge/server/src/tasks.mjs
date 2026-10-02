// 自动任务（workbuddy-bridge 新增）：每日签到 + 成长任务（自动报名 + 达标领奖）。
//
// 上游端点（国内版实测口径，协议同 workbuddy2api-panel）：
//   签到      POST {billingBase}/v2/billing/meter/daily-checkin
//   任务列表  GET  {apiBase}/v2/activity/growth/tasks          → data.tasks[]
//   任务报名  POST {apiBase}/v2/activity/growth/tasks/accept   {"task_codes":[...]}
//   领取奖励  POST {claimBase}/activity/growth/tasks/<code>/claim（x-client-platform: web）
//   小程序限定任务（X-Client-Platform: miniprogram）v0.1 暂不处理。
//
// 调度：每 10 分钟检查一次是否到点（tasks.checkinHours / growthHours），每天每类
// 任务最多触发一次；账号粒度再按「今天已成功即跳过」兜底（tasks-state.json），
// 所以重复触发是幂等的。所有失败只记日志与状态，不影响对话主链路。
import fs from 'node:fs';
import path from 'node:path';
import { siteKeys, getConfigDir } from './config.mjs';
import { listAccounts, updateCreditDetail, markExhausted } from './pool.mjs';
import { queryCredit } from './upstream.mjs';
import { billingHeaders } from './headers.mjs';
import { getAuth, ensureToken } from './auth.mjs';
import { log, warn } from './log.mjs';

/* ---------------- 状态落盘 ---------------- */

const statePath = () => path.join(getConfigDir(), 'tasks-state.json');

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let state = null;
function loadState() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    state = {};
  }
  if (!state.checkin) state.checkin = {}; // uid → { date, ok, msg }
  if (!state.growth) state.growth = {};   // uid → { date, ok, accepted, claimed, msg }
  if (!state.history) state.history = []; // 最近 200 条运行记录
  return state;
}

function saveState() {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (e) {
    warn('tasks-state.json 写入失败：', e.message);
  }
}

function record(kind, uid, entry) {
  const s = loadState();
  s[kind][uid] = { date: todayKey(), ...entry };
  s.history.unshift({ kind, uid, at: new Date().toISOString(), ...entry });
  if (s.history.length > 200) s.history.length = 200;
  saveState();
}

/** 该账号今天这一类任务是否已经跑成功过。 */
function doneToday(kind, uid) {
  const s = loadState();
  const e = s[kind][uid];
  return Boolean(e && e.date === todayKey() && e.ok);
}

/* ---------------- 上游调用 ---------------- */

async function callJSON(cfg, url, { method = 'GET', body = null, headers, what } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), 20_000);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${what}：HTTP ${res.status} 非 JSON 响应 ${text.slice(0, 120)}`);
    }
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

/** 上游统一信封：code===0 视为成功；「已签到」类提示按成功处理（幂等）。 */
function unwrap(json, what) {
  if (!json || typeof json !== 'object') throw new Error(`${what}：响应不是 JSON 对象`);
  if (json.code !== 0) {
    const msg = String(json.msg || '').slice(0, 120);
    if (what === '签到' && /已签|already/i.test(msg)) return { already: true, msg };
    throw new Error(`${what}：code=${json.code} ${msg}`);
  }
  return json.data ?? {};
}

/**
 * 每日签到。已签到也算成功（幂等）。
 */
export async function checkinAccount(cfg, site, accountId) {
  await ensureToken(cfg, site, { accountId });
  const auth = getAuth(site);
  const siteCfg = cfg.sites[site];
  const headers = billingHeaders(siteCfg, auth);
  const { json } = await callJSON(cfg, siteCfg.billingBase + '/v2/billing/meter/daily-checkin', {
    method: 'POST',
    headers,
    body: {},
    what: '签到',
  });
  const data = unwrap(json, '签到');
  const msg = String(data?.msg || data?.message || (data?.already ? '今日已签到' : '签到完成'));
  return { ok: true, msg };
}

/** 成长任务列表（宽松解析：progress 可能是对象或平铺字段）。 */
export async function listGrowthTasks(cfg, site, accountId) {
  await ensureToken(cfg, site, { accountId });
  const auth = getAuth(site);
  const siteCfg = cfg.sites[site];
  const headers = billingHeaders(siteCfg, auth);
  const { json } = await callJSON(cfg, siteCfg.apiBase + '/v2/activity/growth/tasks', {
    headers,
    what: '任务列表',
  });
  const data = unwrap(json, '任务列表');
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  return tasks.map((t) => {
    let cur = Number(t.current) || 0;
    let tgt = Number(t.target) || 0;
    if (t.progress && typeof t.progress === 'object') {
      cur = Number(t.progress.current) || cur;
      tgt = Number(t.progress.target) || tgt;
    }
    const claimed = t.accept_status === 'claimed';
    return {
      code: String(t.task_code || ''),
      title: String(t.title || t.task_code || ''),
      credit: Number(t.reward_credit) || 0,
      locked: Boolean(t.locked),
      acceptStatus: String(t.accept_status || ''),
      status: String(t.status || ''),
      current: cur,
      target: tgt,
      claimable: !claimed && tgt > 0 && cur >= tgt,
      claimed,
    };
  });
}

async function acceptTasks(cfg, site, auth, siteCfg, codes) {
  if (!codes.length) return;
  const headers = billingHeaders(siteCfg, auth);
  const { json } = await callJSON(cfg, siteCfg.apiBase + '/v2/activity/growth/tasks/accept', {
    method: 'POST',
    headers,
    body: { task_codes: codes },
    what: '任务报名',
  });
  unwrap(json, '任务报名');
}

async function claimReward(cfg, site, auth, siteCfg, taskCode) {
  // 领奖走 Web 域（task_code 在路径里），带 x-client-platform: web —— CLI 域的
  // reward/claim 端点不存在（上游 400 "task not completed"）。
  const base = siteCfg.claimBase || 'https://www.workbuddy.cn';
  const headers = billingHeaders(siteCfg, auth);
  headers['x-client-platform'] = 'web';
  headers.Origin = base;
  headers.Referer = base + '/profile/growth-center';
  const { json } = await callJSON(cfg, `${base}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, {
    method: 'POST',
    headers,
    what: '领奖',
  });
  const data = unwrap(json, '领奖');
  if (data?.already_claimed) return { credit: 0, energy: 0, already: true };
  return { credit: Number(data?.credit) || 0, energy: Number(data?.energy) || 0, already: false };
}

/**
 * 成长任务扫描：报名所有可报名任务 + 领取所有达标奖励。
 * 进度类任务（对话 N 次）靠真实使用点亮，这里只做报名与领奖。
 */
export async function growthScanAccount(cfg, site, accountId) {
  const tasks = await listGrowthTasks(cfg, site, accountId);
  const auth = getAuth(site);
  const siteCfg = cfg.sites[site];

  const toAccept = tasks.filter((t) => !t.locked && t.code && t.acceptStatus === 'not_accepted').map((t) => t.code);
  let accepted = 0;
  if (toAccept.length) {
    try {
      await acceptTasks(cfg, site, auth, siteCfg, toAccept);
      accepted = toAccept.length;
    } catch (e) {
      warn(`[${site}] 任务报名失败（${toAccept.join(',')}）：`, e.message);
    }
  }

  let claimed = 0;
  let creditGained = 0;
  const claimables = tasks.filter((t) => t.claimable && t.code);
  for (const t of claimables) {
    try {
      const r = await claimReward(cfg, site, auth, siteCfg, t.code);
      claimed += 1;
      creditGained += r.credit || 0;
      log(`[${site}] 领奖成功：${t.title} +${r.credit} 积分`);
    } catch (e) {
      warn(`[${site}] 领奖失败（${t.title}）：`, e.message);
    }
  }
  return { ok: true, accepted, claimed, creditGained, tasks: tasks.length };
}

/** 领奖后顺手刷新余额（积分到账要反映到调度缓存里）。 */
async function refreshAfterGain(cfg, site, accountId) {
  try {
    const c = await queryCredit(cfg, site, accountId);
    updateCreditDetail(site, accountId, c);
    if (typeof c.remain === 'number' && c.remain <= 0) markExhausted(site, accountId, '余额为 0');
  } catch {
    /* 刷新失败不影响任务结果 */
  }
}

/* ---------------- 批量执行 ---------------- */

/** 对一个站点的所有账号跑一类任务。 */
async function runForSite(cfg, site, kind) {
  const out = [];
  for (const a of listAccounts(site)) {
    if (a.enabled === false || !a.accessToken) continue;
    if (doneToday(kind, a.uid || a.id)) {
      out.push({ id: a.id, label: a.label || a.id, skipped: true, ok: true });
      continue;
    }
    try {
      const uid = a.uid || a.id;
      let result;
      if (kind === 'checkin') {
        result = await checkinAccount(cfg, site, a.id);
        record('checkin', uid, { ok: true, site, msg: result.msg });
      } else {
        result = await growthScanAccount(cfg, site, a.id);
        const { tasks, ...rest } = result;
        record('growth', uid, { ok: true, site, ...rest });
        if (result.claimed > 0) await refreshAfterGain(cfg, site, a.id);
      }
      out.push({ id: a.id, label: a.label || a.id, ...result });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      record(kind, a.uid || a.id, { ok: false, site, msg });
      out.push({ id: a.id, label: a.label || a.id, ok: false, error: msg });
    }
  }
  return out;
}

/** 手动/调度共用的任务入口。kind: 'checkin' | 'growth' | 'all' */
export async function runTasks(cfg, kind = 'all', site = null) {
  const sites = site ? [site] : siteKeys(cfg);
  const result = {};
  for (const s of sites) {
    if (!cfg.sites[s]) continue;
    if ((kind === 'checkin' || kind === 'all') && cfg.tasks?.checkin !== false) {
      result[`checkin:${s}`] = await runForSite(cfg, s, 'checkin');
    }
    if ((kind === 'growth' || kind === 'all') && cfg.tasks?.growth !== false) {
      result[`growth:${s}`] = await runForSite(cfg, s, 'growth');
    }
  }
  return result;
}

/** 任务状态视图（/admin/tasks 用）。 */
export function taskStatus() {
  const s = loadState();
  return {
    today: todayKey(),
    checkin: s.checkin,
    growth: s.growth,
    history: s.history.slice(0, 30),
    stateFile: statePath(),
  };
}

/* ---------------- 定时循环 ---------------- */

const timers = { tasks: null };
const firedDay = { checkin: null, growth: null };

function hoursHit(hours) {
  return Array.isArray(hours) && hours.includes(new Date().getHours());
}

function summarize(result) {
  const out = {};
  for (const [k, list] of Object.entries(result || {})) {
    out[k] = {
      ok: list.filter((x) => x.ok && !x.skipped).length,
      skipped: list.filter((x) => x.skipped).length,
      failed: list.filter((x) => x.ok === false).length,
    };
  }
  return out;
}

/** 启动任务调度循环（每 10 分钟检查一次；每天每类任务最多触发一次）。 */
export function startTaskLoop(cfg) {
  if (timers.tasks) return;
  if (cfg.tasks?.enabled === false) {
    log('自动签到/成长任务已关闭（tasks.enabled=false）');
    return;
  }
  timers.tasks = setInterval(async () => {
    try {
      const today = todayKey();
      const kind = hoursHit(cfg.tasks?.checkinHours) && firedDay.checkin !== today
        ? 'checkin'
        : hoursHit(cfg.tasks?.growthHours) && firedDay.growth !== today
          ? 'growth'
          : null;
      if (!kind) return;
      firedDay[kind] = today;
      // 首次触发带随机延迟，避开整点高峰；延迟期间再来 tick 也不会重复触发（firedDay 已记）
      const jitterMs = Math.round(Math.random() * Math.max(0, Number(cfg.tasks?.jitterMinutes) || 0) * 60_000);
      if (jitterMs) setTimeout(() => void runAndLog(cfg, kind), jitterMs).unref?.();
      else await runAndLog(cfg, kind);
    } catch (e) {
      warn('任务循环异常：', e.message);
    }
  }, 10 * 60_000);
  timers.tasks.unref?.();
  log('自动任务调度已启动（签到/成长任务）');
}

async function runAndLog(cfg, kind) {
  log(`执行${kind === 'checkin' ? '每日签到' : '成长任务扫描'}…`);
  const r = await runTasks(cfg, kind);
  log(`${kind === 'checkin' ? '签到' : '成长任务'}完成：`, JSON.stringify(summarize(r)));
}

export function stopTaskLoop() {
  if (timers.tasks) clearInterval(timers.tasks);
  timers.tasks = null;
}
