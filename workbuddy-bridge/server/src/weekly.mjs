// 用量周报（T46）：每周一早上（可配 HH:MM，默认 09:00）把上周（周一 00:00 ~ 周日 24:00）
// 的用量汇总成一条通知，走 notify.mjs 的多通道（T33 webhook/bark/serverchan）+ 桌面气泡推出去。
//
// 设计约束：
//   - 纯读数零消耗：只聚合 usage.json 已有的 day 数据，不打上游、不产生任何模型请求；
//   - 重启不重复发：状态落数据目录 weekly.json（lastSent=本周一的日期键），
//     不放内存也不搭车 events（events 只有 300 条环形，一周就可能被冲掉）；
//   - 依赖全部可注入（loadDays/fireEvent/sendNotify/stateFile），纯函数 + 单测友好，
//     单测里绝不触发真实通知或写生产数据目录。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.mjs';
import { log } from './log.mjs';
import { recordEvent } from './events.mjs';
import { notify } from './notify.mjs';
import { usageDays } from './usage.mjs';

const p2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** 本周的周一（含今天；周一返回今天本身）。 */
export function mondayOf(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // getDay(): 0=周日 → 转成周一=0
  return x;
}

/** 上周（相对 now）的 [from, to] Date，from=上周一 00:00，to=上周日。 */
export function lastWeekRange(now = new Date()) {
  const from = mondayOf(now);
  from.setDate(from.getDate() - 7);
  const to = new Date(from);
  to.setDate(to.getDate() + 6);
  return { from, to };
}

/**
 * 聚合一段日期的用量（纯函数）。
 * days: usage.json 的 days map（'YYYY-MM-DD' → {calls,errors,promptTokens,completionTokens,credit,models:{},accounts:{}}）
 * from/to: Date（含两端）。返回 totals + topModels（按积分降序前 5）+ byAccount。
 */
export function weeklySummary(days, { from, to }) {
  const keys = [];
  for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) keys.push(dateKey(d));
  const totals = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0 };
  const byModel = new Map();
  const byAccount = new Map();
  let daysWithData = 0;
  for (const k of keys) {
    const day = days[k];
    if (!day) continue;
    daysWithData++;
    totals.calls += day.calls || 0;
    totals.errors += day.errors || 0;
    totals.promptTokens += day.promptTokens || 0;
    totals.completionTokens += day.completionTokens || 0;
    totals.credit += day.credit || 0;
    for (const [mid, m] of Object.entries(day.models || {})) {
      // days 的键是 "站点/模型" 复合键；报表里显示纯模型名（m.model），键只作归并
      const cur = byModel.get(mid) || { id: m.model || mid, site: m.site, calls: 0, credit: 0 };
      cur.calls += m.calls || 0;
      cur.credit += m.credit || 0;
      byModel.set(mid, cur);
    }
    for (const [ak, a] of Object.entries(day.accounts || {})) {
      const cur = byAccount.get(ak) || { key: ak, site: a.site, account: a.account, calls: 0, credit: 0 };
      cur.calls += a.calls || 0;
      cur.credit += a.credit || 0;
      byAccount.set(ak, cur);
    }
  }
  const topModels = [...byModel.values()].sort((x, y) => y.credit - x.credit || y.calls - x.calls).slice(0, 5);
  const byAccountList = [...byAccount.values()].sort((x, y) => y.credit - x.credit || y.calls - x.calls);
  return {
    from: dateKey(from),
    to: dateKey(to),
    daysWithData,
    totals: { ...totals, credit: Math.round(totals.credit * 100) / 100 },
    topModels,
    byAccount: byAccountList,
  };
}

/** 周报文案（纯函数）：多行纯文本，直接进通知通道。 */
export function renderWeeklyText(s) {
  const fmt = (n) => String(Math.round(n * 100) / 100);
  const lines = [
    `上周（${s.from} ~ ${s.to}）用量汇总：`,
    `调用 ${s.totals.calls} 次 · 请求错误 ${s.totals.errors} 次 · 消耗 ${fmt(s.totals.credit)} 积分`,
  ];
  if (s.topModels.length) {
    lines.push('按模型 Top5：');
    s.topModels.forEach((m, i) => lines.push(`${i + 1}. ${m.id}（${m.site}）${m.calls} 次 / ${fmt(m.credit)} 分`));
  } else {
    lines.push('上周没有模型调用记录。');
  }
  if (s.byAccount.length) {
    lines.push('按账号：');
    for (const a of s.byAccount) lines.push(`- ${a.account || a.key}（${a.site}）${a.calls} 次 / ${fmt(a.credit)} 分`);
  }
  return lines.join('\n');
}

const defaultStateFile = () => path.join(paths.root, 'weekly.json');

function loadState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}

function saveState(stateFile, st) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
  } catch (e) { log('周报状态写入失败：', e.message); }
}

/**
 * 调度 tick：周一且时点命中时生成并发送上周周报（每周最多一次，lastSent 记本周一日期键）。
 * force=true 手动触发（控制台按钮/验证用），无视周几与时点、无视已发送。
 * 全部依赖可注入：loadDays/fireEvent/sendNotify 换假件即可离线单测。
 */
export async function weeklyTick(cfg, now = new Date(), {
  force = false,
  loadDays = usageDays,
  fireEvent = recordEvent,
  sendNotify = notify,
  stateFile = null,
} = {}) {
  const w = cfg.weekly || {};
  if (w.enabled === false) return { ok: false, skipped: 'disabled' };
  const file = stateFile || defaultStateFile();
  const thisMonday = dateKey(mondayOf(now));
  if (!force) {
    if (now.getDay() !== 1) return { ok: false, skipped: 'not-monday' };
    const times = Array.isArray(w.times) && w.times.length ? w.times : ['09:00'];
    const hhmm = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
    if (!times.includes(hhmm)) return { ok: false, skipped: 'not-time' };
    const st = loadState(file);
    if (st.lastSent === thisMonday) return { ok: false, skipped: 'already-sent' };
  }
  const { from, to } = lastWeekRange(now);
  const summary = weeklySummary(loadDays(), { from, to });
  const text = renderWeeklyText(summary);
  fireEvent('system', `用量周报已生成：上周调用 ${summary.totals.calls} 次 / 错误 ${summary.totals.errors} 次 / 消耗 ${summary.totals.credit} 积分`);
  try { sendNotify(cfg, '📊 WorkBuddy 用量周报', text, { key: 'weekly' }); }
  catch (e) { log('周报通知发送失败：', e.message); }
  saveState(file, { lastSent: thisMonday, at: Date.now(), totals: summary.totals });
  log('用量周报已生成并发送（上周 ', summary.from, '~', summary.to, '）');
  return { ok: true, summary, text };
}

let timer = null;

/** 启动周报调度循环（60s tick，与任务/巡检循环同节奏；非周一/未到时点立即返回）。 */
export function startWeeklyLoop(cfg) {
  if (timer) return;
  timer = setInterval(() => {
    void weeklyTick(cfg).catch((e) => log('用量周报调度异常：', e.message));
  }, 60_000);
  timer.unref?.();
}

export function stopWeeklyLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
