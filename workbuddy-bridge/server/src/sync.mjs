// 多端同步（0.3.64）：把账号池/配置/统计经 WebDAV 在多台设备间互推。
// 设计：远端只存一个快照文档（workbuddy-bridge-sync.json），每台设备有 deviceId，
// 推送带上自己的 deviceId 与 updatedAt；拉取按「字段级合并」而不是整包覆盖——
// 账号池按 uid 取 expiresAt 新者胜，config 只补缺（本机显式改过的键不被远端盖掉），
// usage/tasks/events 取结构化更新的一方。冲突不弹窗，合并不了的全量记进返回值由事件时间线留痕。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { paths } from './config.mjs';
import { writeJsonFileAtomic } from './util.mjs';
import { recordEvent } from './events.mjs';
import { log, warn } from './log.mjs';

const syncConfigPath = () => path.join(paths.root, 'sync.json');
const syncStatePath = () => path.join(paths.root, 'sync-state.json');

let syncCfg = null;
export function syncConfig() {
  if (syncCfg) return syncCfg;
  try {
    syncCfg = JSON.parse(fs.readFileSync(syncConfigPath(), 'utf8'));
  } catch {
    syncCfg = { enabled: false, url: '', username: '', password: '', remoteFile: 'workbuddy-bridge-sync.json', autoPushTimes: ['09:00'] };
  }
  return syncCfg;
}

export function saveSyncConfig(patch) {
  const c = syncConfig();
  if (patch.url !== undefined) c.url = String(patch.url || '').trim().replace(/\/+$/, '');
  if (patch.username !== undefined) c.username = String(patch.username || '');
  if (patch.password !== undefined && String(patch.password || '') !== '') c.password = String(patch.password);
  if (patch.remoteFile !== undefined && String(patch.remoteFile || '').trim()) c.remoteFile = String(patch.remoteFile).trim();
  if (patch.autoPushTimes !== undefined) c.autoPushTimes = patch.autoPushTimes;
  if (patch.enabled !== undefined) c.enabled = patch.enabled === true;
  writeJsonFileAtomic(syncConfigPath(), c);
  syncCfg = c;
  return c;
}

/** deviceId：本机标识（hostname+数据目录哈希前 8 位），随推送记录来源。 */
export function deviceId() {
  const raw = os.hostname() + '|' + paths.root;
  return os.hostname() + '-' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
}

function loadSyncState() {
  try {
    return JSON.parse(fs.readFileSync(syncStatePath(), 'utf8'));
  } catch {
    return { lastPushAt: 0, lastPullAt: 0, lastPushError: '', lastPullError: '', remoteUpdatedAt: 0, remoteDevice: '' };
  }
}

function saveSyncState(s) {
  writeJsonFileAtomic(syncStatePath(), s);
}

/** WebDAV PUT/GET，返回 { ok, status, text | json }。Basic auth，15s 超时。 */
async function dav(method, c, relFile, body) {
  const url = c.url.replace(/\/+$/, '') + '/' + encodeURIComponent(relFile);
  const headers = {};
  const auth = Buffer.from(c.username + ':' + c.password).toString('base64');
  headers.Authorization = 'Basic ' + auth;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（GET 404 的 HTML 等） */ }
  return { ok: res.ok, status: res.status, text, json };
}

/* ---------------- 字段级合并 ---------------- */

function newerExpiry(a, b) {
  const ea = Number(a?.expiresAt) || Number(a?.expires_at) || 0;
  const eb = Number(b?.expiresAt) || Number(b?.expires_at) || 0;
  return ea >= eb ? a : b;
}

/** 账号池合并：同 uid 取 expiresAt 新的一方（该账号最近一次登录/刷新的凭据）。 */
export function mergePool(local, remote) {
  const out = { ...remote };
  let picked = 0;
  for (const [uid, la] of Object.entries(local || {})) {
    const ra = out[uid];
    if (!ra) { out[uid] = la; picked++; continue; }
    const win = newerExpiry(la, ra);
    if (win === la) { out[uid] = la; picked++; }
  }
  return { merged: out, picked };
}

/** config 合并：两边都有的键以本机为准（本机是操作者）；远端只补本机没有的键。 */
export function mergeConfig(local, remote) {
  const out = { ...local };
  let added = 0;
  for (const [k, v] of Object.entries(remote || {})) {
    if (!(k in out)) { out[k] = v; added++; }
  }
  return { merged: out, added };
}

/** 标量/文档类合并：updatedAt 新者胜。 */
export function newerDoc(local, remote, key = 'updatedAt') {
  const la = Number(local?.[key]) || 0;
  const ra = Number(remote?.[key]) || 0;
  return la > ra ? local : remote;
}

/* ---------------- 打包与落盘 ---------------- */

/** 与 backup.mjs 同口径收集，外加各站点账号池。 */
function collectSyncFiles(cfg) {
  const files = {};
  const want = ['config.json', 'learned.json', 'usage.json', 'tasks-state.json', 'events.json', 'health.json', 'weekly.json'];
  for (const name of want) {
    try {
      const f = path.join(paths.root, name);
      if (fs.existsSync(f)) files[name] = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { /* 坏文件跳过 */ }
  }
  for (const site of Object.keys(cfg.sites || {})) {
    try {
      const f = path.join(paths.root, `auth.${site}.pool.json`);
      if (fs.existsSync(f)) files[`auth.${site}.pool.json`] = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { /* 同上 */ }
  }
  return files;
}

/** 推送：打包上传。返回 { ok, pushedAt, bytes } 或 { ok:false, error }。 */
export async function syncPush(cfg) {
  const c = syncConfig();
  if (!c.enabled || !c.url) return { ok: false, error: '同步未启用或未配置 WebDAV 地址' };
  const state = loadSyncState();
  const doc = {
    schema: 1,
    device: deviceId(),
    updatedAt: Date.now(),
    files: collectSyncFiles(cfg),
  };
  const r = await dav('PUT', c, c.remoteFile || 'workbuddy-bridge-sync.json', doc);
  if (!r.ok) {
    state.lastPushError = `HTTP ${r.status}: ${r.text.slice(0, 120)}`;
    saveSyncState(state);
    return { ok: false, error: state.lastPushError };
  }
  state.lastPushAt = Date.now();
  state.lastPushError = '';
  state.remoteUpdatedAt = doc.updatedAt;
  state.remoteDevice = doc.device;
  saveSyncState(state);
  recordEvent('system', `同步推送完成（${Object.keys(doc.files).length} 个文件 → ${c.remoteFile}）`);
  return { ok: true, pushedAt: state.lastPushAt, files: Object.keys(doc.files).length };
}

/** 拉取：下载远端并按字段合并落盘。返回 { ok, applied:[...], skipped:[...] }。 */
export async function syncPull(cfg) {
  const c = syncConfig();
  if (!c.enabled || !c.url) return { ok: false, error: '同步未启用或未配置 WebDAV 地址' };
  const state = loadSyncState();
  const r = await dav('GET', c, c.remoteFile || 'workbuddy-bridge-sync.json');
  if (r.status === 404) return { ok: false, error: '远端还没有同步文档（先在另一台设备推送一次）' };
  if (!r.ok || !r.json?.files) {
    state.lastPullError = `HTTP ${r.status}`;
    saveSyncState(state);
    return { ok: false, error: state.lastPullError };
  }
  const remote = r.json;
  const applied = [];
  const skipped = [];
  for (const [name, rdata] of Object.entries(remote.files || {})) {
    const localPath = path.join(paths.root, name);
    let ldata = null;
    try {
      ldata = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    } catch { /* 本机没有或坏了 → 直接用远端 */ }
    let merged = rdata;
    if (ldata != null) {
      if (name.startsWith('auth.') && name.endsWith('.pool.json')) {
        merged = mergePool(ldata, rdata).merged;
      } else if (name === 'config.json') {
        merged = mergeConfig(ldata, rdata).merged;
      } else {
        merged = newerDoc(ldata, rdata);
        if (merged === ldata) { skipped.push(name); continue; }
      }
    }
    try {
      writeJsonFileAtomic(localPath, merged);
      applied.push(name);
    } catch (e) {
      skipped.push(name + '（写入失败：' + (e.message || e) + '）');
    }
  }
  state.lastPullAt = Date.now();
  state.lastPullError = '';
  state.remoteUpdatedAt = remote.updatedAt || 0;
  state.remoteDevice = remote.device || '';
  saveSyncState(state);
  recordEvent('system', `同步拉取完成（应用 ${applied.length}、跳过 ${skipped.length}，来源 ${remote.device}）`);
  // 拉进来的账号池/配置由调用方刷新运行时 cfg（console-api 拿到 applied 后重 loadConfig 字段替换）
  return { ok: true, applied, skipped, from: remote.device };
}

export function syncStatus() {
  const c = syncConfig();
  const s = loadSyncState();
  return {
    enabled: c.enabled,
    url: c.url,
    username: c.username,
    passwordMasked: c.password ? c.password.slice(0, 3) + '…' : '',
    remoteFile: c.remoteFile,
    autoPushTimes: c.autoPushTimes,
    device: deviceId(),
    lastPushAt: s.lastPushAt || 0,
    lastPullAt: s.lastPullAt || 0,
    lastPushError: s.lastPushError || '',
    lastPullError: s.lastPullError || '',
    remoteUpdatedAt: s.remoteUpdatedAt || 0,
    remoteDevice: s.remoteDevice || '',
  };
}

/** 定时推送（autoPushTimes 时点，每天一次）。 */
export function syncAutoTick(cfg, now = new Date()) {
  const c = syncConfig();
  if (!c.enabled || !c.url) return null;
  if (!Array.isArray(c.autoPushTimes) || c.autoPushTimes.length === 0) return null;
  const state = loadSyncState();
  const day = now.toISOString().slice(0, 10);
  if (state.lastPushDay === day) return null;
  const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const hit = c.autoPushTimes.some((t) => {
    const [th, tm] = String(t).split(':').map((x) => parseInt(x, 10));
    const [nh, nm] = hm.split(':').map((x) => parseInt(x, 10));
    return nh * 60 + nm >= th * 60 + (tm || 0);
  });
  if (!hit) return null;
  state.lastPushDay = day;
  saveSyncState(state);
  return syncPush(cfg);
}

/* ---------------- 定时循环（60s tick；模式同 weekly/doctor） ---------------- */
let syncTimer = null;
export function startSyncLoop(cfg) {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    try { syncAutoTick(cfg)?.catch?.((e) => warn('[sync] 定时推送失败：', e.message || e)); } catch { /* 循环内吞错 */ }
  }, 60_000);
  syncTimer.unref?.();
}
export function stopSyncLoop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}
