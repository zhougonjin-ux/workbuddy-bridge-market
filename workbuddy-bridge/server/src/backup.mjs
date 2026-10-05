// 数据自动备份（T58）：每天在 backup.times 时点把 config + 账号池 + 各状态文件
// 打包成单个 JSON 落到 <数据目录>/backups/，滚动保留 keep 份。
//
// 为什么值得做：/backup（T21）是手动导出，没人天天点；而账号池 auth.*.pool.json
// 里是上游 access/refresh token，文件损坏或误删后所有账号都要重新扫码。
// 每天一次自动快照，最坏情况丢当天的增量（任务状态/用量），账号本身不会丢。
//
// 结构与 weekly.mjs 同款：backupTick 纯调度逻辑（now/目录可注入 → 单测零生产接触），
// backupNow/collectBackupFiles/pruneBackups 是可独立调用的纯函数（控制台「立即备份」复用）。
import fs from 'node:fs';
import path from 'node:path';
import { paths, siteKeys } from './config.mjs';
import { poolPathFor } from './pool.mjs';
import { log, warn } from './log.mjs';

const statePath = () => path.join(paths.root, 'backup-state.json');

let state = null;
let stateLoadedFrom = null;
function loadState(overridePath = null) {
  const f = overridePath || statePath();
  if (state && stateLoadedFrom === f) return state;
  try {
    state = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    state = {};
  }
  stateLoadedFrom = f;
  if (typeof state.lastBackupDay !== 'string') state.lastBackupDay = '';
  return state;
}

function saveState(overridePath = null) {
  try {
    fs.writeFileSync(overridePath || statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (e) {
    warn('backup-state.json 写入失败：', e.message);
  }
}

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 备份内容清单（与 /backup 导出同源，外加 protocol-check/weekly/备份状态本身）。 */
export function collectBackupFiles(cfg) {
  const files = {};
  const want = ['config.json', 'learned.json', 'usage.json', 'tasks-state.json', 'events.json', 'health.json', 'protocol-check.json', 'weekly.json'];
  for (const name of want) {
    try {
      const f = path.join(paths.root, name);
      if (fs.existsSync(f)) files[name] = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { /* 单个文件坏了跳过，不拖垮整个备份 */ }
  }
  for (const site of siteKeys(cfg)) {
    try {
      const f = poolPathFor(site);
      if (fs.existsSync(f)) files[`auth.${site}.pool.json`] = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { /* 同上 */ }
  }
  return files;
}

/** 滚动清理：只认本模块的命名 backup-YYYY-MM-DD-HHmm.json，多余的从旧到新删。 */
export function pruneBackups(dir, keep = 4) {
  let list = [];
  try {
    list = fs.readdirSync(dir).filter((f) => /^backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(f)).sort();
  } catch {
    return [];
  }
  const removed = [];
  while (list.length > keep) {
    const old = list.shift();
    try {
      fs.rmSync(path.join(dir, old));
      removed.push(old);
    } catch (e) {
      warn('备份清理失败：', `${old} ${e.message}`);
      break; // 删不动就停手，别把能删的也跳过
    }
  }
  return removed;
}

/** 立即备份一次（调度命中与控制台按钮共用）。返回 { file, files, kept, bytes }。 */
export function backupNow(cfg, { dir = null, now = new Date(), keep = null } = {}) {
  const d = dir || path.join(paths.root, 'backups');
  fs.mkdirSync(d, { recursive: true });
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const file = path.join(d, `backup-${stamp}.json`);
  const payload = { version: 1, exportedAt: now.toISOString(), files: collectBackupFiles(cfg) };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  const removed = pruneBackups(d, keep ?? cfg.backup?.keep ?? 4);
  return { file, files: Object.keys(payload.files).length, kept: keep ?? cfg.backup?.keep ?? 4, removed, bytes: fs.statSync(file).size };
}

/** 列出现有备份（控制台备份卡用，新→旧）。⚠️ 目录变量统一用 d（参数可能为 null）。 */
export function backupList(dir = null) {
  const d = dir || path.join(paths.root, 'backups');
  let list = [];
  try {
    list = fs.readdirSync(d).filter((f) => /^backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(f)).sort().reverse();
  } catch {
    return [];
  }
  return list.map((name) => {
    let bytes = 0;
    let mtime = null;
    try {
      const st = fs.statSync(path.join(d, name));
      bytes = st.size;
      mtime = st.mtime.toISOString();
    } catch { /* 文件刚好被清掉 */ }
    return { name, bytes, mtime };
  });
}

/**
 * 调度 tick：backup.times 命中且今天没备过 → 备一次。
 * force 绕过 enabled/时点/当天去重（控制台「立即备份」走 backupNow，不经这里）。
 */
export async function backupTick(cfg, now = new Date(), { force = false, dir = null, stateFile: stFile = null } = {}) {
  const b = cfg.backup || {};
  if (!force && b.enabled === false) return { skipped: 'disabled' };
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (!force && !(Array.isArray(b.times) && b.times.includes(hhmm))) return { skipped: 'not-scheduled' };
  const s = loadState(stFile);
  const today = todayKey(now);
  if (!force && s.lastBackupDay === today) return { skipped: 'already' };
  const r = backupNow(cfg, { now, dir, keep: b.keep });
  s.lastBackupDay = today;
  saveState(stFile);
  log(`数据备份完成：${path.basename(r.file)}（${r.files} 个文件，滚动后保留 ${r.kept} 份）`);
  return { ok: true, ...r };
}

/* ---------------- 定时循环 ---------------- */

let timer = null;

export function startBackupLoop(cfg) {
  if (timer) return;
  if (cfg.backup?.enabled === false) {
    log('数据自动备份已关闭（backup.enabled=false）');
    return;
  }
  timer = setInterval(async () => {
    try {
      await backupTick(cfg);
    } catch (e) {
      warn('备份循环异常：', e.message);
    }
  }, 60_000);
  timer.unref?.();
  log('数据自动备份已启动（每天 ' + (cfg.backup?.times || ['09:00']).join('/') + '，滚动保留 ' + (cfg.backup?.keep ?? 4) + ' 份）');
}

export function stopBackupLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
