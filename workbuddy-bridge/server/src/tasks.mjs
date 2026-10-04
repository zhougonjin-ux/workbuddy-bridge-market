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
import crypto from 'node:crypto';
import { siteKeys, getConfigDir } from './config.mjs';
import { listAccounts, getAccount, setAccountLabel, updateCreditDetail, markExhausted } from './pool.mjs';
import { queryCredit, openChat, aggregateFrames, upstreamErrorMessage, reportChatActivity } from './upstream.mjs';
import { billingHeaders } from './headers.mjs';
import { getAuth, ensureToken } from './auth.mjs';
import { log, warn } from './log.mjs';
import { recordEvent } from './events.mjs';
import { notify, notifyTask } from './notify.mjs';
import { withRetryOnce } from './util.mjs';

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
  if (!state.travel) state.travel = {};   // uid → { date, ok, action, msg }
  if (!state.streak) state.streak = {};   // T50 连登管家：uid → { date, ok, days, redeemed, draws, msg, ... }
  if (!state.history) state.history = []; // 最近 200 条运行记录
  if (!state.checkinDays) state.checkinDays = {}; // T15 签到日历：'YYYY-MM-DD' → [uid,...]
  if (!state.gainedTotal) state.gainedTotal = { credit: 0, checkins: 0, claims: 0, travels: 0 }; // T15 累计白嫖
  if (state.gainedTotal.streaks == null) state.gainedTotal.streaks = 0; // T50 连登收益次数（旧文件兼容）
  return state;
}

function saveState() {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (e) {
    warn('tasks-state.json 写入失败：', e.message);
  }
}

const KIND_LABEL = { checkin: '每日签到', growth: '成长任务', travel: '猫猫旅行', streak: '连登管家', 'growth-manual': '任务操作' };

function record(kind, uid, entry) {
  const s = loadState();
  if (!s[kind]) s[kind] = {}; // 手动操作（growth-manual）等非预置 kind 也能落状态
  s[kind][uid] = { date: todayKey(), ...entry };
  s.history.unshift({ kind, uid, at: new Date().toISOString(), ...entry });
  if (s.history.length > 200) s.history.length = 200;
  // T15 签到日历 + 累计白嫖统计：签到成功按天记；领到的积分（travel claimed / growth 领奖 /
  // 签到本身成功）累计。只统计 ok 的正向事件。
  if (entry.ok) {
    if (kind === 'checkin') {
      const day = todayKey();
      if (!s.checkinDays[day]) s.checkinDays[day] = [];
      if (!s.checkinDays[day].includes(uid)) s.checkinDays[day].push(uid);
      s.gainedTotal.checkins += 1;
    } else if (kind === 'growth' && (entry.creditGained || 0) > 0) {
      s.gainedTotal.credit += entry.creditGained;
      s.gainedTotal.claims += entry.claimed || 0;
    } else if (kind === 'travel' && (entry.credit || 0) > 0) {
      s.gainedTotal.credit += entry.credit;
      s.gainedTotal.travels += 1;
    } else if (kind === 'streak') {
      // T50 连登管家：领到的积分（礼包/补偿/兑换档位/抽奖奖品）进白嫖统计；
      // streaks 计数只记「有实际收益」的扫描（补签/兑换/礼包/补偿/抽奖任一命中），
      // 空跑（三档全 locked、无 chances）不算，否则一天多跑会把计数吹起来。
      if ((entry.creditGained || 0) > 0) s.gainedTotal.credit += entry.creditGained;
      if (entry.actions > 0) s.gainedTotal.streaks += 1;
    }
    // 签到日历最多留 120 天（约 4 个月，一屏放得下）
    const days = Object.keys(s.checkinDays).sort();
    while (days.length > 120) {
      delete s.checkinDays[days.shift()];
    }
  }
  saveState();
  // 事件时间线（T6）：任务结果进入统一时间线。成长任务没有一句话 msg，现场拼一条摘要
  recordEvent('task', `${KIND_LABEL[kind] || kind} ${entry.ok ? '✓' : '✗'} ${
    entry.msg || (kind === 'growth'
      ? `报名 ${entry.accepted ?? 0} · 代打 ${entry.autoChats ?? 0} · 领奖 ${entry.claimed ?? 0} · +${entry.creditGained ?? 0} 积分`
      : '') || (entry.error ?? '')
  }`, { site: entry.site, accountId: uid });
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
 * 成长任务扫描：报名所有可报名任务 + 代打「对话体验类」任务 + 领取所有达标奖励。
 *
 * 代打范围（实测上游按真实对话计数）：code 为 Model_chat_<模型>（体验指定模型）、
 * chat_<N>（聊天 N 次）、RichMeow_Chat（桌面端对话）这类任务，进度由真实对话点亮，
 * 桥接发极小对话请求（max_tokens 16）即可完成，成本可忽略（x0.06 倍率 ≈ 0.01 积分/次）。
 * 其余类型（公众号关注、体验客户端功能）无法从服务端代打，保持只报名+领奖。
 */
function normalizeId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 从任务 code 反推要打的模型 id（GLM5.2 → glm-5.2/glm5.2/...），匹配不到用默认模型。 */
function guessChatModel(suffix, cfg, site) {
  const want = normalizeId(suffix);
  const candidates = new Set();
  for (const m of cfg.models || []) candidates.add(typeof m === 'string' ? m : m?.id);
  // 懒加载目录太重，这里只用 cfg.models + 别名表；匹配不到就落到 defaultModel
  let exact = null, partial = null;
  for (const id of candidates) {
    if (!id || id === 'auto') continue;
    const n = normalizeId(id);
    if (n === want) { exact = id; break; }
    if (!partial && (n.includes(want) || want.includes(n))) partial = id;
  }
  return exact || partial || cfg.defaultModel;
}

/**
 * 活动代打规则注册表（T16 扩展框架）：
 * 每个「可通过真实对话点亮进度」的活动声明一条规则：
 *   { test: (code) => 匹配?, suffix: (match) => 模型后缀或 null, window?: (d) => bool, note?: string }
 * - test/code 匹配的任务才会被代打；
 * - suffix 返回非空时用 guessChatModel 反推指定模型（如 Model_chat_GLM5.2）；
 * - window 限定代打时段（如夜猫子 22:00–02:00），窗口外跳过并记说明；
 * - 新活动类型（官方以后新增的活动任务）在这里 registerAutoplayRule 一条即可接入，
 *   autoCompleteChatTasks / runSingleTask / growthTasksView 全部自动识别。
 */
const AUTOPLAY_RULES = [
  { name: 'model_chat', test: (code) => /^Model_chat_(.+)$/i.exec(code), suffix: (m) => m[1] },
  { name: 'chat_n', test: (code) => /^chat_\d+$/i.test(code), suffix: () => null },
  { name: 'richmeow', test: (code) => /^RichMeow_Chat$/i.test(code), suffix: () => null },
  {
    name: 'black_cat',
    test: (code) => code === 'black_cat',
    // black_cat 只认 glm-5.2 的对话（上游按模型判定），不能用 defaultModel ——
    // 2026-10-03 实测：用 glm-5.3-flash 代打 3 次，进度恒为 0/3。
    // 用 fixedModel 而非 suffix：glm-5.2 一般不在用户的 cfg.models 白名单里，
    // 走 guessChatModel 会静默回落到 defaultModel。
    fixedModel: 'glm-5.2',
    window: (d) => inNightWindow(d),
    note: '夜猫子任务只在 23:00–08:00 窗口内代打（且必须用 glm-5.2 + 上报对话事件）',
  },
];

/** 注册新活动规则（插件未来扩展用；运行期注册，重启后回到内置表）。 */
export function registerAutoplayRule(rule) {
  if (rule && typeof rule.test === 'function') AUTOPLAY_RULES.push(rule);
}

function ruleFor(code) {
  if (!code) return null;
  for (const r of AUTOPLAY_RULES) {
    const m = r.test(code);
    if (m) return { rule: r, match: m };
  }
  return null;
}

/**
 * 判断任务此刻是否可代打。返回 { autoplayable, model, why }：
 * why 非空时表示「类型支持但当前不可代打」的原因（时段窗口等）。
 */
function judgeTask(t, cfg, site, now = new Date()) {
  const hit = ruleFor(t.code);
  if (!hit) return { autoplayable: false, why: null };
  const { rule, match } = hit;
  if (rule.window && !rule.window(now)) return { autoplayable: false, why: rule.note || '不在代打时段窗口内' };
  const suffix = rule.suffix ? rule.suffix(match) : null;
  // fixedModel 供「上游只认特定模型」的任务用：直接用字面名，不走 guessChatModel ——
  // 后者只在 cfg.models（用户白名单）里找，night-cat 用的 glm-5.2 通常不在白名单里，
  // 会静默回落到 defaultModel，那正是「代打成功但进度不涨」的第二个原因。
  const model = rule.fixedModel || (suffix ? guessChatModel(suffix, cfg, site) : cfg.defaultModel);
  return { autoplayable: true, model, why: null };
}

/**
 * 夜猫子任务（black_cat，夜间折扣活动）的代打窗口：本地时间 23:00–08:00。
 * 窗口跨零点，所以用「小时 ≥23 或 <8」而不是区间比较；抽成纯函数便于单测。
 *
 * 口径来自 .ref 参考实现（WorkBuddy-Daily 实测 + 该网关验证）：black_cat 的进度
 * **只在 23:00–08:00 窗口内累计**，窗口外的对话不计分。
 * 早先实现成 22:00–02:00 是错的 —— 那样 02:00–08:00 段的对话白打，
 * 而 22:00–23:00 反而会在非计数时段里空跑。
 */
export function inNightWindow(d = new Date()) {
  const h = d.getHours();
  return h >= 23 || h < 8;
}

/**
 * 对未达标的对话类任务代打极小请求。
 * 返回 { chats, tasks, notes }（tasks 是代打过的任务标题，notes 是给人看的跳过/异常说明）。
 *
 * 代打规则走 T16 活动注册表（AUTOPLAY_RULES）：对话体验类 + 夜猫子（black_cat，
 * 22:00–02:00 窗口）都由 judgeTask 判定；growth 扫描落在窗口外时跳过并记说明，
 * 不额外为夜猫子安排定时器；次数上限 maxChatsPerTask。
 */
async function autoCompleteChatTasks(cfg, site, accountId, tasks, now = new Date()) {
  const cap = Number(cfg.tasks?.maxChatsPerTask) || 5;
  const notes = [];
  const todo = [];
  for (const t of tasks) {
    if (!t.code || t.claimed || t.acceptStatus !== 'accepted' || t.current >= t.target) continue;
    const j = judgeTask(t, cfg, site, now);
    if (!j.autoplayable) {
      if (j.why) notes.push(`${t.title}：${j.why}，本轮跳过`);
      continue;
    }
    todo.push({ task: t, attempts: Math.min(t.target - t.current, cap), model: j.model });
  }
  let chats = 0;
  const touched = [];
  for (const { task: t, attempts, model } of todo) {
    const r = await autoplayChats(cfg, site, accountId, t, attempts, model, notes);
    chats += r.chats;
    if (r.chats) touched.push(`${t.title}×${r.chats}`);
    if (r.error && !touched.includes(t.title)) notes.push(`${t.title} 代打失败：${r.error}`);
  }
  return { chats, tasks: touched, notes };
}

/**
 * 给单个任务代打 N 次极小对话（T14 单任务代打与扫描共用）。
 * 返回 { chats, error }——chats 是成功次数，error 是第一次失败的摘要。
 * notes 传入时会把「事件上报失败」这类非致命问题也记给人看。
 */
async function autoplayChats(cfg, site, accountId, task, attempts, model, notes = null) {
  let chats = 0;
  let error = null;
  for (let i = 0; i < attempts; i++) {
    try {
      // openChat 返回的是**扁平**结构 { ok, status, frames, close }，没有 up 这层包装。
      // 原代码写成 r.up.frames，r.up 恒为 undefined —— 于是「消费帧」这行必抛 TypeError，
      // 也就是说 T5/T14 的对话代打**从来没有真正成功过一次**，只要执行就炸，
      // 而且错误信息是「Cannot read properties of undefined (reading 'frames')」，
      // 把上游真正拒绝的原因（额度不足/401/502）整个盖掉。
      // 2026-10-03 23:35 夜猫子窗口内首次暴露：控制台两条 growth-manual 记录都是它。
      const r = await openChat(cfg, site, {
        model,
        messages: [{ role: 'user', content: '回复"ok"两个字母即可' }],
        max_tokens: 64,
        stream: false,
      }, { accountId });
      if (!r?.ok) {
        error = upstreamErrorMessage(r?.status || 502, r?.text || '', site);
        warn(`[${site}] 任务代打被上游拒绝（${task.title} 第 ${i + 1} 次，HTTP ${r?.status ?? '-'}）：`, error);
        break;
      }
      // 消费完帧再关，保证上游把这次对话计数（这行以前从没真正执行过）
      for await (const _f of r.frames) { void _f; }
      r.close();
      chats++;
      // 对话事件上报：black_cat 这类任务**不看你真发了对话，只看事件链**。
      // 缺这一步，对话返回 200、chats 计数 +1，但任务进度恒为 0
      // （2026-10-03 实测：代打「成功」3 次，进度仍是 0/3）。
      // chat_5 等其它对话类任务由上游自行记录，只有 black_cat 需要我们补报。
      //
      // 上报包在独立 try 里：它是「计数」这一步而非「对话」本身，失败不该让
      // 剩下的几次代打一起中止（第一版就因为上报抛错把 3 次打成 1 次）。
      if (task.code === 'black_cat') {
        try {
          const ok = await reportChatActivity(cfg, site, { accountId, modelId: model, modelName: model });
          if (!ok && notes) notes.push(`${task.title}：对话已发出但事件上报失败，上游可能不计入进度`);
        } catch (e) {
          warn(`[${site}] 对话事件上报异常（不影响已完成的对话）：`, e.message || String(e));
          if (notes) notes.push(`${task.title}：事件上报异常 ${String(e.message || e).slice(0, 60)}`);
        }
      }
    } catch (e) {
      error = String(e.message || e).slice(0, 120);
      warn(`[${site}] 任务代打失败（${task.title} 第 ${i + 1} 次）：`, error);
      break;
    }
  }
  return { chats, error };
}

/**
 * 成长任务扫描：报名所有可报名任务 → 代打「对话体验类」任务 → 领取所有达标奖励。
 * 非对话类任务（公众号关注、体验客户端功能等）无法服务端代打，保持只报名+领奖。
 */
export async function growthScanAccount(cfg, site, accountId) {
  let tasks = await listGrowthTasks(cfg, site, accountId);
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

  // 对话体验类任务代打（可关）；打过之后重新拉一次列表，让新达标的奖励在本轮就被领走
  let autoChats = 0;
  let autoTasks = [];
  let autoNotes = [];
  if (cfg.tasks?.autoComplete !== false) {
    try {
      ({ chats: autoChats, tasks: autoTasks, notes: autoNotes } = await autoCompleteChatTasks(cfg, site, accountId, tasks));
      if (autoChats > 0) tasks = await listGrowthTasks(cfg, site, accountId);
    } catch (e) {
      warn(`[${site}] 对话类任务代打异常：`, e.message);
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
  invalidateTaskCenter(site, accountId); // 扫描可能报名/代打/领奖，缓存的进度视图已过期
  return { ok: true, accepted, autoChats, autoTasks, autoNotes, claimed, creditGained, tasks: tasks.length };
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

/* ---------------- 派猫猫旅行 ---------------- */
//
// 端点（协议同 workbuddy2api-panel 的 travel.go；chatBase = apiBase，BillingHeaders 鉴权）：
//   GET  {apiBase}/activity/growth/buddy/info            → data.buddy（null = 还没有猫）
//   GET  {apiBase}/activity/growth/buddy/travel/status   → data { state: idle|traveling|arrived,
//          daily_limit_reached, record_id, reward_credit }
//   POST {apiBase}/activity/growth/buddy/travel/depart   {location_id}   （每日 1 次，自然日重置）
//   POST {apiBase}/activity/growth/buddy/travel/claim    {record_id}     → data.reward_credit
//
// 巡逻状态机幂等：每次巡逻最多一个动作（领奖 / 派出 / 跳过），所以一天可以巡逻多次。
// 无猫时的领养链路（上报对话 → agreement → buddy/first）依赖客户端行为，这里只提示不代养。

async function growthJSON(cfg, site, auth, siteCfg, method, path, body, what = '猫猫旅行') {
  const headers = billingHeaders(siteCfg, auth);
  const { json } = await callJSON(cfg, siteCfg.apiBase + path, { method, body, headers, what });
  return unwrap(json, what);
}

/** billing 域请求（T51 礼包/补偿等 www.codebuddy.cn 端点；与 growth 域同款鉴权头）。 */
async function billingJSON(cfg, site, auth, siteCfg, path, body, what) {
  const headers = billingHeaders(siteCfg, auth);
  const { json } = await callJSON(cfg, siteCfg.billingBase + path, { method: 'POST', body, headers, what });
  return unwrap(json, what);
}

export async function travelScanAccount(cfg, site, accountId) {
  await ensureToken(cfg, site, { accountId });
  const auth = getAuth(site);
  const siteCfg = cfg.sites[site];

  const info = await growthJSON(cfg, site, auth, siteCfg, 'GET', '/activity/growth/buddy/info', null);
  if (!info?.buddy) {
    return { ok: true, action: 'no_buddy', msg: '还没有猫猫，先在客户端成长中心领养一只' };
  }

  const st = await growthJSON(cfg, site, auth, siteCfg, 'GET', '/activity/growth/buddy/travel/status', null);
  const state = String(st?.state || '');

  if (state === 'arrived') {
    const rid = Number(st?.record_id) || 0;
    if (!rid) return { ok: true, action: 'arrived_no_record', msg: '猫猫已到站但缺少 record_id，本轮跳过' };
    const r = await growthJSON(cfg, site, auth, siteCfg, 'POST', '/activity/growth/buddy/travel/claim', { record_id: rid });
    const credit = Number(r?.reward_credit) || Number(st?.reward_credit) || 0;
    return { ok: true, action: 'claimed', msg: `旅行归来，领到 ${credit} 积分`, credit };
  }
  if (state === 'idle') {
    if (st?.daily_limit_reached) return { ok: true, action: 'daily_limit', msg: '今天已派出过，明天再来' };
    const loc = Number(cfg.tasks?.travelLocationId) || 4;
    await growthJSON(cfg, site, auth, siteCfg, 'POST', '/activity/growth/buddy/travel/depart', { location_id: loc });
    return { ok: true, action: 'departed', msg: `猫猫已派出旅行（地点 ${loc}）` };
  }
  if (state === 'traveling') {
    return { ok: true, action: 'traveling', msg: '旅行进行中，到站后再巡逻领奖' };
  }
  return { ok: true, action: 'unknown', msg: `未知旅行状态：${state || '(空)'}` };
}

/* ---------------- 连登管家（T50+T51） ----------------
 *
 * 成长中心连登体系（协议同 .ref/workbuddy2api-panel 的 streak.go / blackcat.go，
 * 端点组 2026-10-05 已用真实账号只读实测 200）：
 *   GET  {apiBase}/activity/growth/streak        → 连登天数/三档状态/补签卡
 *   POST {apiBase}/activity/growth/redeem        {tier,client_token}  未解锁 403「连续登录天数不足」
 *   GET  {apiBase}/activity/growth/lottery/summary → {chances, module.enabled}
 *   POST {apiBase}/activity/growth/lottery/draw  {client_token}      每次耗 1 chance
 *   GET  {apiBase}/activity/growth/heatmap       → cells[] {date,score,has_new_buddy}
 *   POST {apiBase}/activity/growth/makeup-cards/use {target_date}   补签保连登
 *   POST {billingBase}/billing/meter/claim-gift         {} 新手礼包（每号一次）
 *   POST {billingBase}/billing/meter/claim-compensation {} 活动补偿（有则领）
 *
 * client_token 是前端 randomUUID 同款幂等令牌。流程照抄参考实现 scheduler/streak.go：
 * 补签保连登 → 礼包/补偿 → 逐档兑换（locked/claimed 跳过）→ 按 chances 抽完。
 * 全程幂等，一天可多跑（挂在签到扫描同轮，也可手动触发）。
 *
 * ⚠️ 验收纪律（0.3.20/0.3.21 血泪）：不能只看请求 200——兑换要看 redemption_status
 * 从可兑变 claimed、抽奖要看 chances 递减、补签要看 heatmap/makeup 变化。
 */

/** 幂等令牌（前端 randomUUID 同款语义）。 */
function clientToken() {
  return crypto.randomUUID();
}

/** 昨天 'YYYY-MM-DD'（本地时区；补签口径与 heatmap cell date 一致）。 */
function yesterdayKey(d = new Date()) {
  const y = new Date(d);
  y.setDate(y.getDate() - 1);
  return todayKey(y);
}

/**
 * 从 streak 完整响应里挑出可兑换的档位（纯函数，单测用）。
 * status ∈ locked/可兑/claimed；locked 与 claimed 跳过，其余（可兑/未知值）尝试兑换——
 * 未知值尝试是刻意的：上游新增状态时宁可多发一次幂等请求（403 静默），也不漏兑。
 */
export function redeemableTiers(full) {
  const rs = full?.redemption_status || {};
  const statusOf = {
    '7d': rs.tier_7d_status,
    '14d': rs.tier_14d_status,
    '28d': rs.tier_28d_status,
  };
  const tiers = Array.isArray(rs.tiers) ? rs.tiers : [];
  return tiers.filter((t) => {
    const st = statusOf[t?.tier];
    return st !== 'locked' && st !== 'claimed';
  });
}

/** 官方热力图 cells 的宽松解析（纯函数，单测用）：date 截前 10 位，score 归一为数字。 */
export function parseHeatmapCells(data) {
  const cells = Array.isArray(data?.cells) ? data.cells : [];
  return cells
    .map((c) => ({ date: String(c?.date || '').slice(0, 10), score: Number(c?.score) || 0, hasNewBuddy: Boolean(c?.has_new_buddy) }))
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date));
}

/**
 * T52：官方打卡热力图（权威全历史，从账号注册日起算；本地 checkinDays 只从插件启用日起）。
 * 6h 内存缓存（同 taskCenterView 模式）；补签成功后失效。
 */
const HEATMAP_TTL_MS = 6 * 3600_000;
const hmCache = new Map(); // 'site|accountId' → { at, cells }

export async function heatmapView(cfg, site, accountId, { force = false } = {}) {
  const key = `${site}|${accountId}`;
  const hit = hmCache.get(key);
  if (!force && hit && Date.now() - hit.at < HEATMAP_TTL_MS) {
    return { cells: hit.cells, cachedAt: hit.at, fromCache: true };
  }
  await ensureToken(cfg, site, { accountId });
  const auth = getAuth(site);
  const data = await growthJSON(cfg, site, auth, cfg.sites[site], 'GET', '/activity/growth/heatmap', null, '官方热力图');
  const cells = parseHeatmapCells(data);
  hmCache.set(key, { at: Date.now(), cells });
  return { cells, cachedAt: Date.now(), fromCache: false };
}

/**
 * T50+T51 连登管家单账号扫描。返回 { ok, actions, makeupUsed, makeupDate, giftCredit,
 * compCredit, redeemed, draws, creditGained, prizes, notes, days, nextTier, ... }。
 * 礼包/补偿/兑换/抽奖失败都只记 notes 不中断——一次扫描里能拿的尽量拿。
 */
export async function streakScanAccount(cfg, site, accountId) {
  await ensureToken(cfg, site, { accountId });
  const auth = getAuth(site);
  const siteCfg = cfg.sites[site];
  const notes = [];
  let creditGained = 0;
  let actions = 0;

  // 0. 补签保连登：昨日漏签且有补签卡则补上（连登一断要重攒 7 天）。
  let makeupUsed = 0;
  let makeupDate = null;
  try {
    const hm = await growthJSON(cfg, site, auth, siteCfg, 'GET', '/activity/growth/heatmap', null, '连登管家');
    const cells = parseHeatmapCells(hm);
    const yKey = yesterdayKey();
    const missed = cells.some((c) => c.date === yKey && c.score === 0);
    if (missed) {
      const full0 = await growthJSON(cfg, site, auth, siteCfg, 'GET', '/activity/growth/streak', null, '连登管家');
      if ((Number(full0?.makeup_cards?.balance) || 0) > 0) {
        try {
          await growthJSON(cfg, site, auth, siteCfg, 'POST', '/activity/growth/makeup-cards/use', { target_date: yKey }, '连登管家');
          makeupUsed = 1;
          makeupDate = yKey;
          actions += 1;
          notes.push(`已用补签卡补签 ${yKey}（保连登）`);
          hmCache.delete(`${site}|${accountId}`); // 补签改变了热力图，缓存已过期
        } catch (e) {
          notes.push(`补签 ${yKey} 失败：${String(e.message || e).slice(0, 80)}`);
        }
      } else {
        notes.push(`昨日（${yKey}）漏签且补签卡为 0，连登将中断`);
      }
    }
  } catch (e) {
    notes.push(`连登状态查询失败：${String(e.message || e).slice(0, 80)}`);
  }

  // 0.5 T51 新手礼包/活动补偿（billing 域，每号一次；无则业务错误静默跳过）。
  let giftCredit = 0;
  let compCredit = 0;
  try {
    const d = await billingJSON(cfg, site, auth, siteCfg, '/billing/meter/claim-gift', {}, '新手礼包');
    giftCredit = Number(d?.credit) || 0;
    creditGained += giftCredit;
    actions += 1;
    notifyTask(cfg, '🎊 新手礼包', `${site}：领到 ${giftCredit} 积分`, accountId);
  } catch { /* 已领过/活动未开放——预期路径，静默 */ }
  try {
    const d = await billingJSON(cfg, site, auth, siteCfg, '/billing/meter/claim-compensation', {}, '活动补偿');
    compCredit = Number(d?.credit) || 0;
    creditGained += compCredit;
    actions += 1;
    notifyTask(cfg, '🎊 活动补偿', `${site}：领到 ${compCredit} 积分`, accountId);
  } catch { /* 没有补偿——预期路径，静默 */ }

  // 1. 拉连登完整状态（上面补签时若已查过一次也无妨，再查一次拿最新档位状态）。
  let full = null;
  try {
    full = await growthJSON(cfg, site, auth, siteCfg, 'GET', '/activity/growth/streak', null, '连登管家');
  } catch (e) {
    notes.push(`连登档位查询失败：${String(e.message || e).slice(0, 80)}`);
  }

  // 2. 逐档兑换（status 非 locked/claimed 就 redeem；未解锁 403 属预期，静默）。
  const redeemed = [];
  if (full) {
    for (const tier of redeemableTiers(full)) {
      try {
        await growthJSON(cfg, site, auth, siteCfg, 'POST', '/activity/growth/redeem',
          { tier: tier.tier, client_token: clientToken() }, '连登兑换');
        redeemed.push(tier.tier);
        creditGained += Number(tier.credit) || 0;
        actions += 1;
      } catch (e) {
        const msg = String(e.message || e);
        if (!/403|连续登录/.test(msg)) notes.push(`兑换 ${tier.tier} 档失败：${msg.slice(0, 80)}`);
      }
    }
    if (redeemed.length) {
      notifyTask(cfg, '★ 连登兑换', `${site}：${redeemed.join('/')} 档已兑换（+${creditGained - giftCredit - compCredit} 积分）`, accountId);
    }
  }

  // 3. 抽奖：按当前 chances 全抽完（兑换刚发的次数已在服务端累加）。上限 20 防异常值。
  let chances = 0;
  let draws = 0;
  const prizes = [];
  try {
    const ls = await growthJSON(cfg, site, auth, siteCfg, 'GET', '/activity/growth/lottery/summary', null, '抽奖次数');
    chances = Number(ls?.chances) || 0;
    if (ls?.module && ls.module.enabled === false) chances = 0; // 活动下线时不打 draw
    for (let i = 0; i < Math.min(chances, 20); i++) {
      try {
        const p = await growthJSON(cfg, site, auth, siteCfg, 'POST', '/activity/growth/lottery/draw',
          { client_token: clientToken() }, '抽奖');
        draws += 1;
        actions += 1;
        // prize 形状由活动期决定，宽松取 credit；原始载荷裁剪进 prizes 供记录/展示
        const pc = Number(p?.credit ?? p?.prize?.credit) || 0;
        creditGained += pc;
        prizes.push(JSON.stringify(p).slice(0, 160));
      } catch (e) {
        notes.push(`第 ${i + 1} 抽失败：${String(e.message || e).slice(0, 80)}`);
        break;
      }
    }
  } catch (e) {
    notes.push(`抽奖次数查询失败：${String(e.message || e).slice(0, 80)}`);
  }

  // 4. 给 UI 的状态快照（兑换/抽奖后的最新值；consoles 从 tasks-state.streak 读）。
  const s = full?.streak || {};
  const mc = full?.makeup_cards || {};
  const rs = full?.redemption_status || {};
  return {
    ok: true,
    actions,
    makeupUsed,
    makeupDate,
    giftCredit,
    compCredit,
    redeemed,
    draws,
    chances,
    chancesLeft: Math.max(0, chances - draws),
    prizes,
    creditGained,
    notes,
    days: Number(s.days) || 0,
    nextTier: String(s.next_tier || ''),
    nextTierRemaining: Number(s.next_tier_remaining) || 0,
    makeupBalance: Number(mc.balance) || 0,
    makeupMax: Number(mc.max) || 0,
    tier7d: String(rs.tier_7d_status || ''),
    tier14d: String(rs.tier_14d_status || ''),
    tier28d: String(rs.tier_28d_status || ''),
  };
}

/**
 * T53 账号昵称同步（只在用户手动触发时调用，绝不进定时轮询）。
 *
 * GET {billingBase}/console/account（Bearer + x-client-platform: web + Origin/Referer
 * www.workbuddy.cn，profile.go 同款，实测 200）。
 *
 * ⚠️ 隐私边界（强制）：响应含 phoneNumber/wechatOpenId 等敏感字段——只解析 uid 与
 * nickname 两个字段，其余不解析、不落日志、不透传。uid 与池内账号不一致报错防串号。
 * 成功用官方昵称更新显示名并落池。
 */
export function parseAccountProfile(json) {
  // 响应可能带 {code,data} 信封（Go 参考的 doJSON 就是剥信封后解析）；两种形态都兼容。
  // 唯一的解析出口：敏感字段在这里就被丢弃，调用方拿不到。
  const d = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : json;
  return { uid: String(d?.uid || ''), nickname: String(d?.nickname || '') };
}

export async function syncAccountNickname(cfg, site, accountId) {
  const acct = getAccount(site, accountId);
  if (!acct) throw Object.assign(new Error(`账号不存在：${accountId}`), { status: 404 });
  await ensureToken(cfg, site, { accountId });
  const auth = getAuth(site);
  const siteCfg = cfg.sites[site];
  const headers = billingHeaders(siteCfg, auth);
  headers['x-client-platform'] = 'web';
  headers.Origin = 'https://www.workbuddy.cn';
  headers.Referer = 'https://www.workbuddy.cn/profile/account-settings';
  const { json } = await callJSON(cfg, siteCfg.billingBase + '/console/account', {
    headers,
    what: '账号资料',
  });
  const { uid, nickname } = parseAccountProfile(json);
  if (!nickname) throw new Error('上游没有返回昵称');
  if (uid && acct.uid && uid !== acct.uid) {
    throw new Error(`uid 不一致（上游 ${uid.slice(0, 6)}… ≠ 池内 ${String(acct.uid).slice(0, 6)}…），已中止防串号`);
  }
  const old = acct.label || '';
  if (old === nickname) return { ok: true, nickname, changed: false, msg: `显示名已是「${nickname}」，无需更新` };
  setAccountLabel(site, accountId, nickname);
  recordEvent('account', `账号「${old || accountId}」显示名已同步为官方昵称「${nickname}」`, { site, accountId: uid || accountId });
  return { ok: true, nickname, changed: true, msg: `显示名已更新为「${nickname}」` };
}

/* ---------------- 批量执行 ---------------- */

/** 对一个站点的所有账号跑一类任务。travel/streak 是幂等扫描（一天可多次），checkin/growth 每天一次。 */
async function runForSite(cfg, site, kind) {
  const out = [];
  for (const a of listAccounts(site)) {
    if (a.enabled === false || !a.accessToken) continue;
    if (kind !== 'travel' && kind !== 'streak' && doneToday(kind, a.uid || a.id)) {
      out.push({ id: a.id, label: a.label || a.id, skipped: true, ok: true });
      continue;
    }
    try {
      const uid = a.uid || a.id;
      // T12：任务失败自动重试一次（签到/领奖这类操作重试成本为零，上游抖动不该让它失败）
      let result;
      if (kind === 'checkin') {
        result = await withRetryOnce(() => checkinAccount(cfg, site, a.id));
        record('checkin', uid, { ok: true, site, msg: result.msg });
      } else if (kind === 'travel') {
        // T11 通知：猫猫到站领奖值得弹（旅行要数小时，不看控制台根本不知道）
        result = await travelScanAccount(cfg, site, a.id);
        record('travel', uid, { ok: true, site, action: result.action, msg: result.msg, credit: result.credit });
        if (result.action === 'claimed') {
          notifyTask(cfg, '猫猫归来 🐾', `${a.label || a.id}：${result.msg}`, a.id);
        }
      } else if (kind === 'streak') {
        // T50 连登管家：补签 → 礼包/补偿 → 兑换 → 抽奖，全程幂等（dayStreak 可一天多跑）
        result = await withRetryOnce(() => streakScanAccount(cfg, site, a.id));
        // 主摘要 + 连登天数快照；notes（补签失败/兑换异常等）拼在后面
        const bits = [
          result.makeupUsed ? `补签 ${result.makeupDate}` : null,
          result.giftCredit ? `新手礼包 +${result.giftCredit}` : null,
          result.compCredit ? `补偿 +${result.compCredit}` : null,
          (result.redeemed || []).length ? `兑换 ${(result.redeemed).join('/')}` : null,
          result.draws ? `抽奖 ${result.draws} 次` : null,
        ].filter(Boolean);
        const msg = `连登 ${result.days ?? 0} 天${bits.length ? '：' + bits.join(' · ') : '，无待处理项（档位未解锁/无抽奖次数）'}`
          + (result.notes?.length ? '。' + result.notes.join('；') : '');
        record('streak', uid, { ok: true, site, msg, ...result });
        if ((result.creditGained || 0) > 0) await refreshAfterGain(cfg, site, a.id);
      } else {
        result = await withRetryOnce(() => growthScanAccount(cfg, site, a.id));
        const { tasks, ...rest } = result;
        record('growth', uid, { ok: true, site, ...rest });
        if (result.claimed > 0) await refreshAfterGain(cfg, site, a.id);
      }
      out.push({ id: a.id, label: a.label || a.id, ...result });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      record(kind, a.uid || a.id, { ok: false, site, msg });
      out.push({ id: a.id, label: a.label || a.id, ok: false, error: msg });
      // T11 通知：任务失败弹一次（节流 5 分钟，同账号同任务不刷屏）
      notifyTask(cfg, `${KIND_LABEL[kind] || kind}失败 ✗`, `${a.label || a.id}：${msg.slice(0, 120)}`, a.id);
    }
  }
  return out;
}

/** 手动/调度共用的任务入口。kind: 'checkin' | 'growth' | 'travel' | 'streak' | 'all' */
export async function runTasks(cfg, kind = 'all', site = null) {
  const sites = site ? [site] : siteKeys(cfg);
  const result = {};
  const wantStreak = kind === 'streak' || kind === 'all';
  const wantCheckin = kind === 'checkin' || kind === 'all';
  for (const s of sites) {
    if (!cfg.sites[s]) continue;
    if (wantCheckin && cfg.tasks?.checkin !== false) {
      result[`checkin:${s}`] = await runForSite(cfg, s, 'checkin');
    }
    // T50 连登管家搭签到同一轮（签到可能补上连登链），也支持 kind='streak' 单独触发。
    // 一天内跟每次 checkin/all 触发重跑一遍（幂等），不设独立时点配置。
    if ((wantStreak || (kind === 'checkin' && cfg.tasks?.checkin !== false)) && cfg.tasks?.enabled !== false) {
      result[`streak:${s}`] = await runForSite(cfg, s, 'streak');
    }
    if ((kind === 'growth' || kind === 'all') && cfg.tasks?.growth !== false) {
      result[`growth:${s}`] = await runForSite(cfg, s, 'growth');
    }
    if ((kind === 'travel' || kind === 'all') && cfg.tasks?.travel !== false) {
      result[`travel:${s}`] = await runForSite(cfg, s, 'travel');
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
    travel: s.travel,
    streak: s.streak, // T50 连登管家（含给 UI 用的 days/makeup/chances 快照）
    history: s.history.slice(0, 30),
    // T15：签到日历（'YYYY-MM-DD' → 当天签到的 uid 数组）与累计白嫖统计
    checkinDays: s.checkinDays || {},
    gainedTotal: s.gainedTotal || { credit: 0, checkins: 0, claims: 0, travels: 0, streaks: 0 },
    stateFile: statePath(),
  };
}

/* ---------------- 成长任务中心（T14）：视图 + 单任务代打/领奖 ---------------- */

/**
 * 实时拉取某账号的成长任务列表，并标注「能否代打」（T16 规则判定）。
 * 控制台「任务中心」用：每个任务一条进度条 + 代打/领奖按钮。
 */
export async function growthTasksView(cfg, site, accountId) {
  const tasks = await listGrowthTasks(cfg, site, accountId);
  const now = new Date();
  return tasks.map((t) => {
    const j = judgeTask(t, cfg, site, now);
    return {
      ...t,
      autoplayable: cfg.tasks?.autoComplete !== false && j.autoplayable && t.current < t.target,
      autoplayModel: j.model || null,
      autoplayBlockedReason: j.why || null,
      remain: Math.max(0, t.target - t.current),
    };
  });
}

/* ---------------- 任务中心列表缓存（0.3.22）----------------
 * 任务列表原先由控制台轮询实时拉上游（30s 轮询 + SSE 推送两条路都会触发），页面整页
 * 重建导致明显闪烁，对上游也是无意义的重复请求。现在列表只在三处被真正拉取：
 *   1) 调度循环在 tasks.listTimes（默认 09:00/15:00/21:00）各预取一次全部启用账号；
 *   2) 打开任务页且缓存超过 TTL（6 小时）时按需拉一次；
 *   3) 用户点「手动刷新」或代打/领奖完成后（refresh=1）。
 * 缓存仅在内存（重启即清，首次打开按需拉取补上）；fetcher 参数仅供单测注入。
 */
const TC_TTL_MS = 6 * 3600_000;
const tcCache = new Map(); // 'site|accountId' → { at, tasks }

export async function taskCenterView(cfg, site, accountId, { force = false, fetcher = growthTasksView } = {}) {
  const key = `${site}|${accountId}`;
  const hit = tcCache.get(key);
  if (!force && hit && Date.now() - hit.at < TC_TTL_MS) {
    return { tasks: hit.tasks, cachedAt: hit.at, fromCache: true };
  }
  const tasks = await fetcher(cfg, site, accountId);
  tcCache.set(key, { at: Date.now(), tasks });
  return { tasks, cachedAt: Date.now(), fromCache: false };
}

/** 调度预取：所有已登录站点的启用账号各刷一次（已在 TTL 内的跳过）。返回实际拉取的账号数。 */
export async function prewarmTaskCenter(cfg) {
  let n = 0;
  for (const sk of siteKeys(cfg)) {
    if (!cfg.sites[sk]?.logged_in) continue;
    for (const a of listAccounts(sk)) {
      if (a.enabled === false) continue;
      try {
        const r = await taskCenterView(cfg, sk, a.id);
        if (!r.fromCache) n++;
      } catch (e) {
        warn(`任务列表自动刷新失败（${a.label || a.id}）：`, String(e.message || e).slice(0, 120));
      }
    }
  }
  if (n) log(`任务中心列表已自动刷新（${n} 个账号）`);
  return n;
}

/** 代打/领奖等改变上游进度的操作之后调用：丢弃该账号的缓存视图，下次查看时重新拉取。 */
function invalidateTaskCenter(site, accountId) {
  tcCache.delete(`${site}|${accountId}`);
}

/**
 * 单任务手动代打：按需补齐到 target（受 maxChatsPerTask 上限约束），打完重拉进度。
 * 与扫描代打共用 autoplayChats，行为一致。
 */
export async function runSingleTask(cfg, site, accountId, taskCode, { times = null } = {}) {
  const tasks = await listGrowthTasks(cfg, site, accountId);
  const t = tasks.find((x) => x.code === taskCode);
  if (!t) throw Object.assign(new Error(`任务不存在：${taskCode}`), { status: 404 });
  if (t.claimed) return { ok: true, chats: 0, msg: '奖励已领取', task: t };
  const j = judgeTask(t, cfg, site);
  if (!j.autoplayable) {
    return { ok: false, chats: 0, msg: j.why || '该任务类型不支持代打（人工任务）', task: t };
  }
  const cap = Number(cfg.tasks?.maxChatsPerTask) || 5;
  const attempts = Math.max(0, Math.min(Number(times) || (t.target - t.current), cap, t.target - t.current));
  if (!attempts) return { ok: true, chats: 0, msg: '进度已达标，可直接领奖', task: t };
  const r = await autoplayChats(cfg, site, accountId, t, attempts, j.model);
  // 打完重拉进度，前端立即看到新进度
  const fresh = (await listGrowthTasks(cfg, site, accountId)).find((x) => x.code === taskCode) || t;
  invalidateTaskCenter(site, accountId); // 进度已变，丢弃缓存视图（前端随即 force 重拉）
  record('growth-manual', accountId, {
    ok: r.chats > 0, site,
    msg: `手动代打「${t.title}」${r.chats} 次${r.error ? `，失败：${r.error}` : ''}`,
  });
  return {
    ok: r.chats > 0,
    chats: r.chats,
    error: r.error || null,
    msg: r.chats > 0 ? `代打 ${r.chats} 次完成，进度 ${fresh.current}/${fresh.target}` : `代打失败：${r.error}`,
    task: fresh,
  };
}

/** 单任务领奖（T14；与扫描领奖同一 claimReward 路径）。 */
export async function claimSingleTask(cfg, site, accountId, taskCode) {
  const tasks = await listGrowthTasks(cfg, site, accountId);
  const t = tasks.find((x) => x.code === taskCode);
  if (!t) throw Object.assign(new Error(`任务不存在：${taskCode}`), { status: 404 });
  if (!t.claimable) return { ok: false, msg: t.claimed ? '奖励已领取过' : `进度未达标（${t.current}/${t.target}）`, task: t };
  const auth = getAuth(site);
  const r = await claimReward(cfg, site, auth, cfg.sites[site], t.code);
  invalidateTaskCenter(site, accountId);
  record('growth-manual', accountId, { ok: true, site, msg: `手动领奖「${t.title}」+${r.credit} 积分`, credit: r.credit });
  if (r.credit > 0) await refreshAfterGain(cfg, site, accountId);
  return { ok: true, credit: r.credit, msg: `已领取「${t.title}」+${r.credit} 积分`, task: t };
}

/* ---------------- 定时循环 ---------------- */

const timers = { tasks: null };
const firedDay = { checkin: null, growth: null };

function hoursHit(hours) {
  return Array.isArray(hours) && hours.includes(new Date().getHours());
}

/**
 * 判断此刻是否到点：优先用精确时点 ["HH:MM"]（checkinTimes/growthTimes/travelTimes/listTimes），
 * 未配置时回落到旧的小时数组（checkinHours/growthHours，整点语义；仅签到/成长/旅行有旧语义）。
 */
function scheduledNow(cfg, kind, d = new Date()) {
  const t = cfg.tasks || {};
  const times = kind === 'checkin' ? t.checkinTimes
    : kind === 'growth' ? t.growthTimes
    : kind === 'travel' ? t.travelTimes
    : t.listTimes;
  if (Array.isArray(times) && times.length) {
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return times.includes(hhmm);
  }
  if (kind === 'checkin' || kind === 'growth') return hoursHit(kind === 'checkin' ? t.checkinHours : t.growthHours);
  if (kind === 'travel') return hoursHit(t.growthHours); // 与旧行为一致：travelTimes 留空时回退成长任务整点
  return false; // listTimes 留空 = 关闭任务列表自动预取，仅剩手动刷新与打开页面按需拉取
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

/** 启动任务调度循环（每分钟检查到点；支持 ["HH:MM"] 精确时点与旧的小时数组；
 *  签到/成长每天每类最多一次，猫猫旅行是巡逻状态机（幂等），同一时点只跑一次但一天可多次）。 */
export function startTaskLoop(cfg) {
  if (timers.tasks) return;
  if (cfg.tasks?.enabled === false) {
    log('自动签到/成长任务已关闭（tasks.enabled=false）');
    return;
  }
  let lastTravelMs = 0;
  let lastListMs = 0;
  timers.tasks = setInterval(async () => {
    try {
      const today = todayKey();
      // 0.3.22：任务中心列表每日 listTimes 各预取一次（与签到/成长/旅行互不影响、不占 kind 名额）
      if (scheduledNow(cfg, 'list') && Date.now() - lastListMs > 10 * 60_000) {
        lastListMs = Date.now();
        void prewarmTaskCenter(cfg);
      }
      let kind = scheduledNow(cfg, 'checkin') && firedDay.checkin !== today
        ? 'checkin'
        : scheduledNow(cfg, 'growth') && firedDay.growth !== today
          ? 'growth'
          : null;
      if (!kind && cfg.tasks?.travel !== false && scheduledNow(cfg, 'travel') && Date.now() - lastTravelMs > 10 * 60_000) {
        kind = 'travel';
        lastTravelMs = Date.now();
      }
      if (!kind) return;
      if (kind !== 'travel') firedDay[kind] = today;
      // 首次触发带随机延迟，避开整点高峰；延迟期间再来 tick 也不会重复触发（firedDay 已记）
      const jitterMs = Math.round(Math.random() * Math.max(0, Number(cfg.tasks?.jitterMinutes) || 0) * 60_000);
      if (jitterMs) setTimeout(() => void runAndLog(cfg, kind), jitterMs).unref?.();
      else await runAndLog(cfg, kind);
    } catch (e) {
      warn('任务循环异常：', e.message);
    }
  }, 60_000);
  timers.tasks.unref?.();
  log('自动任务调度已启动（签到/连登/成长/猫猫旅行巡逻，支持 HH:MM 精确时点）');
}

async function runAndLog(cfg, kind) {
  const label = { checkin: '每日签到', growth: '成长任务扫描', travel: '猫猫旅行巡逻' }[kind] || kind;
  log(`执行${label}…`);
  const r = await runTasks(cfg, kind);
  log(`${label}完成：`, JSON.stringify(summarize(r)));
}

export function stopTaskLoop() {
  if (timers.tasks) clearInterval(timers.tasks);
  timers.tasks = null;
}
