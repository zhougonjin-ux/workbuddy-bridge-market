// 事件时间线（workbuddy-bridge 新增）：把「值得回看」的事件汇成一条统一时间线，
// 供控制台「事件」页展示。与 log.mjs 的自由文本日志互补：
//   - 日志：给人排障看的流水（含请求行），滚动覆盖，重启即清；
//   - 事件：结构化条目（kind/site/accountId/text），落盘 events.json，重启不丢。
//
// kind 约定（控制台按它过滤/着色）：
//   system  服务启动/退出
//   task    签到/成长任务/猫猫旅行运行结果
//   policy  调度策略切换
//   account 账号请求失败/额度耗尽
//   credit  积分刷新失败
//   login   账号登录成功
//   health  模型健康巡检结果
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.mjs';
import { warn } from './log.mjs';
import { writeJsonFileAtomic } from './util.mjs';

const MAX_EVENTS = 300;
const SAVE_DELAY_MS = 3000;

const file = () => path.join(paths.root, 'events.json');

let events = null; // 旧 → 新
let loadedFrom = null;
let dirty = false;
let timer = null;

/** 惰性加载（配置目录可能在运行期被切换，与 usage.mjs 同一套约定）。 */
function ensureLoaded() {
  const f = file();
  if (loadedFrom === f) return;
  loadedFrom = f;
  try {
    if (fs.existsSync(f)) events = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    warn('events.json 读取失败，事件时间线重新开始：', e.message);
  }
  if (!Array.isArray(events)) events = [];
}

function saveNow() {
  dirty = false;
  try {
    writeJsonFileAtomic(file(), events);
  } catch (e) {
    warn('events.json 写入失败：', e.message);
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

/** 进程退出前刷盘（server.mjs 优雅退出时调用）。 */
export function flushEvents() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (dirty) saveNow();
}

/**
 * 记一条事件。extra 里的 site/accountId 等标识字段会原样透传给前端做映射。
 * 任何布线点的失败都不能影响主流程，所以这里只吞自己的错。
 */
export function recordEvent(kind, text, extra = {}) {
  try {
    const t = String(text || '').trim();
    if (!t) return;
    ensureLoaded();
    events.push({ at: new Date().toISOString(), kind: String(kind || 'system'), text: t.slice(0, 300), ...extra });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    scheduleSave();
  } catch {
    /* 时间线是旁观者，绝不能绊倒主流程 */
  }
}

/** 最近事件（新→旧）。kind 传非空值时只返回该类。 */
export function recentEvents({ limit = 120, kind = null } = {}) {
  ensureLoaded();
  const list = kind ? events.filter((e) => e.kind === kind) : events.slice();
  return list.slice(-limit).reverse();
}
