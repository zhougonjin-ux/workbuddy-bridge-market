// 模型健康巡检（workbuddy-bridge 新增）：对目录里的全部模型发 max_tokens=1 的极小请求，
// 实测每个模型的可用性与首帧延迟，并给出「性价比榜」（倍率低优先、同倍率延迟低优先）。
//
// 成本口径：一次探测 ≈ 十几个输入 token + 1 个输出 token，按模型倍率计费
// （x0.06 档 ≈ 0.01 积分/个），17 个模型一轮 ≈ 0.2 积分；但这是真实消耗，
// 所以定时巡检默认关闭（healthCheck.enabled=false），控制台可随时手动触发单次。
//
// 结果落盘 health.json（数据目录），重启不丢；扫描完成写一条 health 事件进时间线。
import path from 'node:path';
import { paths } from './config.mjs';
import { mergedModels } from './router.mjs';
import { isLoggedIn } from './auth.mjs';
import { openChat, classifyFrame, upstreamErrorMessage } from './upstream.mjs';
import { recordEvent } from './events.mjs';
import { log, warn } from './log.mjs';
import { writeJsonFileAtomic, readJsonFileWithBackup } from './util.mjs';

/**
 * 探测单个模型是否可用（消耗极小：max_tokens=1）。原在 console-api.mjs（/probe 用），
 * 巡检（/health/scan）需要同一套逻辑，上移到这里共用。
 */
export async function probeModel(cfg, site, model) {
  const t0 = Date.now();
  try {
    const up = await openChat(cfg, site, {
      model,
      stream: true,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }, {});
    if (!up.ok) {
      return { model, site, status: up.status, ok: false, msg: upstreamErrorMessage(up.status, up.text, site), ms: Date.now() - t0 };
    }
    let first = null;
    try {
      for await (const payload of up.frames) {
        const parsed = classifyFrame(payload);
        first = parsed;
        break;
      }
    } finally {
      up.close();
    }
    if (first?.kind === 'error') return { model, site, status: 502, ok: false, msg: first.message, ms: Date.now() - t0 };
    return { model, site, status: 200, ok: true, msg: '可用', ms: Date.now() - t0 };
  } catch (e) {
    return { model, site, status: 0, ok: false, msg: e.message, ms: Date.now() - t0 };
  }
}

// ---------------- 巡检结果落盘 ----------------

const file = () => path.join(paths.root, 'health.json');

let state = null;
function loadState() {
  if (state) return state;
  const disk = readJsonFileWithBackup(file());
  state = disk && typeof disk === 'object' ? disk : {};
  if (!Array.isArray(state.results)) state.results = [];
  if (!Array.isArray(state.history)) state.history = [];
  // scanning 只是「本进程正在巡检」的内存锁，却一直跟着 saveState 落盘。
  // 进程若在巡检途中被重启（交棒重启 / 崩溃 / 断电），盘上就留下 scanning:true，
  // 而 loadState 会把它读回来 —— 于是「巡检进行中」被永久锁死，再也跑不了
  // （2026-10-03 实测：health.json 里躺着一份 10-02 的残留锁，用户点巡检永远转圈）。
  // 加载时无条件清掉：此刻本进程确实没在巡检，锁本来就该是干净的。
  state.scanning = false;
  return state;
}

function saveState() {
  try {
    // scanning 是进程内的瞬时锁，不该落盘（落盘就会在重启后变成永久锁，见 loadState）
    const { scanning, ...rest } = state;
    writeJsonFileAtomic(file(), { ...rest, scanning: false });
  } catch (e) {
    warn('health.json 写入失败：', e.message);
  }
}

/** 供控制台「恢复备份」在写回 health.json 后强制重读（否则内存旧态会把恢复内容覆盖回去）。 */
export function reloadHealthState() {
  state = null;
}

/**
 * T35 巡检省钱模式的候选筛选（纯函数，便于单测）。
 *
 * 巡检是真实消耗，17 个模型一轮 ≈0.1~0.5 积分。用户只想知道「我要用的那几个还能用吗」时，
 * 不该为无关模型付钱：
 *   - onlyFree:true  → 只探倍率 0 的模型（完全免费的那一批）
 *   - only:[ids]     → 只探白名单里的模型（支持 * 前缀通配，与 allowModels 同一套语义）
 * 两者叠加（白名单里再筛免费）；都不设 = 全量（保持原行为）。
 *
 * mult 为 null 表示目录没报倍率（拉不到），按「不是免费」处理——「只探免费」时不该
 * 因为倍率未知就把一堆付费模型探一遍。
 */
export function selectScanTargets(targets, cfg) {
  const hc = cfg?.healthCheck || {};
  const only = Array.isArray(hc.only) ? hc.only.map((s) => String(s).trim()).filter(Boolean) : [];
  const onlyFree = hc.onlyFree === true;
  if (!only.length && !onlyFree) return targets;
  const hit = (p, v) => (p.endsWith('*') ? String(v).startsWith(p.slice(0, -1)) : p === v);
  return targets.filter((t) => {
    if (only.length && !only.some((p) => hit(p, t.id))) return false;
    if (onlyFree && !(Number.isFinite(t.mult) && t.mult === 0)) return false;
    return true;
  });
}

/** 巡检状态视图（/console/api/health 用），带当前配置回显。 */
export function healthStatus(cfg) {
  const s = loadState();
  return {
    lastScanAt: s.lastScanAt || null,
    scanning: s.scanning === true,
    results: s.results,
    history: s.history.slice(-30).reverse(),
    config: {
      enabled: cfg?.healthCheck?.enabled === true,
      times: Array.isArray(cfg?.healthCheck?.times) ? cfg.healthCheck.times : [],
      only: Array.isArray(cfg?.healthCheck?.only) ? cfg.healthCheck.only : [],
      onlyFree: cfg?.healthCheck?.onlyFree === true,
    },
  };
}

/**
 * 跑一轮巡检：目录里每个「已登录站点」的模型各探测一次（串行 + 250ms 间隔），
 * 候选集先经 selectScanTargets 按 T35 省钱模式裁剪。
 * 结果按性价比排序：可用在前 → 倍率低在前 → 延迟低在前。同步返回统计，控制台按钮直接等结果
 * （与 /probe 同一模式；17 个模型正常 10~30 秒）。
 */
export async function runHealthScan(cfg) {
  const s = loadState();
  if (s.scanning) return { ok: false, error: '巡检进行中，请等上一轮结束' };
  s.scanning = true;
  try {
    const merged = await mergedModels(cfg);
    const all = [];
    for (const m of merged) {
      if (m.aliasOf) continue; // 站点前缀别名与本体是同一个上游模型，探一次就够
      if (!isLoggedIn(m.site)) continue;
      all.push({ id: m.id, site: m.site, mult: Number.isFinite(m.mult) ? m.mult : null });
    }
    const targets = selectScanTargets(all, cfg);
    if (!targets.length) {
      const why = `省钱模式过滤后没有可巡检的模型（候选 ${all.length} 个）——检查 healthCheck.only / onlyFree`;
      warn(why);
      return { ok: false, error: why, total: all.length, scanned: 0 };
    }
    const results = [];
    for (const t of targets) {
      const r = await probeModel(cfg, t.site, t.id);
      results.push({ ...r, mult: t.mult });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    results.sort((a, b) =>
      (Number(b.ok) - Number(a.ok))
      || ((a.mult ?? Number.POSITIVE_INFINITY) - (b.mult ?? Number.POSITIVE_INFINITY))
      || (a.ms - b.ms));
    s.results = results;
    s.lastScanAt = new Date().toISOString();
    const okList = results.filter((r) => r.ok);
    const avgMs = okList.length ? Math.round(okList.reduce((sum, r) => sum + r.ms, 0) / okList.length) : 0;
    s.history.push({ at: s.lastScanAt, total: results.length, ok: okList.length, avgMs });
    if (s.history.length > 60) s.history.splice(0, s.history.length - 60);
    saveState();
    log(`模型巡检完成：可用 ${okList.length}/${results.length}${avgMs ? `，平均首帧 ${avgMs} ms` : ''}`);
    recordEvent('health', `模型巡检完成：可用 ${okList.length}/${results.length}${avgMs ? `，平均首帧 ${avgMs} ms` : ''}`);
    return { ok: true, total: results.length, okCount: okList.length };
  } catch (e) {
    warn('模型巡检异常：', e.message);
    return { ok: false, error: String(e.message || e) };
  } finally {
    s.scanning = false;
  }
}

// ---------------- 定时巡检循环 ----------------
// 与自动任务同一套时点语义：["HH:MM"] 精确时点，每天只跑一次（首个命中时点）。
// enabled=false（默认）时循环根本不启动，只有手动巡检。

const timers = { scan: null };
let firedDay = null;

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startHealthLoop(cfg) {
  if (timers.scan) return;
  if (cfg.healthCheck?.enabled !== true) {
    log('模型健康巡检未开启（healthCheck.enabled=false），需要时在控制台「模型」页手动巡检');
    return;
  }
  timers.scan = setInterval(async () => {
    try {
      const times = Array.isArray(cfg.healthCheck.times) ? cfg.healthCheck.times : [];
      if (!times.length) return;
      const d = new Date();
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (!times.includes(hhmm) || firedDay === todayKey(d)) return;
      firedDay = todayKey(d);
      log('定时模型巡检开始…');
      await runHealthScan(cfg);
    } catch (e) {
      warn('定时模型巡检异常：', e.message);
    }
  }, 60_000);
  timers.scan.unref?.();
  log(`模型健康巡检已启动：每天 ${cfg.healthCheck.times.join(' / ')} 自动巡检一次`);
}

export function stopHealthLoop() {
  if (timers.scan) clearInterval(timers.scan);
  timers.scan = null;
}
