// 插件一键自更新（0.4.0）：下载市场仓库的 tarball → 校验版本 → 备份 → 覆盖安装。
//
// 设计取舍：
//   - 不用 git（用户机器未必装/未必有权限），走 GitHub tarball 的多个镜像源；
//   - 解压用系统自带 bsdtar（Windows 10 1803+ / macOS / Linux 都有 tar），零依赖；
//   - 覆盖前把插件根整个备份到 <root>.bak-<时间戳>，失败可人工回滚；
//   - 覆盖只拷贝插件运行所需目录，跳过 .git / node_modules / client/market / .opencode。
//     正在运行的 Node 进程不会锁 .mjs（读入即关闭句柄），覆盖安全；
//     但新代码要等重启服务才生效——由调用方（客户端）负责重启。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './config.mjs';
import { localVersion, compareVersions } from './updatecheck.mjs';
import { log } from './log.mjs';

const REPO = 'zhougonjin-ux/workbuddy-bridge-market';
const TARBALL_URLS = [
  `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`,
  `https://api.github.com/repos/${REPO}/tarball/main`,
  `https://ghproxy.net/https://github.com/${REPO}/archive/refs/heads/main.tar.gz`,
  `https://hub.gitmirror.com/https://github.com/${REPO}/archive/refs/heads/main.tar.gz`,
];
const SKIP_DIRS = new Set(['.git', 'node_modules', '.opencode', 'market', '.zcode-plugin.bak']);
const MAX_TARBALL_BYTES = 80 * 1024 * 1024;

/** 插件根目录（server 的上一级）。 */
export function pluginRoot() {
  return path.resolve(ROOT, '..');
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function downloadTarball(dest) {
  let lastErr = null;
  for (const url of TARBALL_URLS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), 60_000);
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error(`内容过小（${buf.length} 字节）`);
      if (buf.length > MAX_TARBALL_BYTES) throw new Error(`包过大（${buf.length} 字节）`);
      // GitHub tarball 是 gzip：1f 8b 开头。返回 HTML（拦截页）时直接判失败。
      if (!(buf[0] === 0x1f && buf[1] === 0x8b)) throw new Error('返回的不是 gzip 包（可能是拦截页）');
      fs.writeFileSync(dest, buf);
      return { url, bytes: buf.length };
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('所有更新源都不可达');
}

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.platform === 'win32' ? 'tar.exe' : 'tar', args, { cwd, windowsHide: true });
    let err = '';
    // tar 偶发卡死（杀毒软件扫包 / 磁盘卡顿）会让 selfUpdate 的 Promise 永不落定，
    // 控制台请求悬死——60 秒兜底杀掉。
    const timer = setTimeout(() => {
      try { p.kill(); } catch { /* 已退出 */ }
      reject(new Error('tar 解压超时（60 秒）'));
    }, 60_000);
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`tar 退出码 ${code}：${err.slice(0, 300)}`));
    });
  });
}

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (SKIP_DIRS.has(name)) continue;
      copyRecursive(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function rmSafe(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

/** 找出解压目录里的仓库根（tarball 顶层是 <repo>-main/）。 */
function findExtractRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const e of entries) {
    const candidate = path.join(dir, e.name);
    if (fs.existsSync(path.join(candidate, 'workbuddy-bridge', 'server', 'package.json'))) return candidate;
  }
  return null;
}

/**
 * 执行更新。
 * @param {{ force?: boolean }} opts force=true 时即使版本号不更新也重装（用于修复装坏的副本）
 * @returns {Promise<object>} { ok, updated, from, to, backup?, url?, error? }
 */
export async function selfUpdate({ force = false } = {}) {
  const from = localVersion();
  const tmpBase = path.join(pluginRoot(), '.tmp-selfupdate');
  const tarball = path.join(tmpBase, 'pkg.tar.gz');
  const extractDir = path.join(tmpBase, 'x');
  rmSafe(tmpBase);
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const dl = await downloadTarball(tarball);
    await runTar(['-xzf', tarball, '-C', extractDir], extractDir);
    const repoRoot = findExtractRoot(extractDir);
    if (!repoRoot) throw new Error('解压后找不到 workbuddy-bridge/server/package.json');

    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'workbuddy-bridge', 'server', 'package.json'), 'utf8'));
    const to = String(pkg.version || '');
    if (!to) throw new Error('新包缺少 version 字段');
    if (!force && compareVersions(to, from) <= 0) {
      return { ok: true, updated: false, from, to, note: '已是最新版本' };
    }

    // 备份整个插件根（排除临时目录自身），出问题可手动回滚
    const backup = `${pluginRoot()}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyRecursive(pluginRoot(), backup);
    rmSafe(path.join(backup, '.tmp-selfupdate'));

    // 覆盖：解压目录里的插件内容整体拷回插件根
    const srcPlugin = path.join(repoRoot, 'workbuddy-bridge');
    const dstPlugin = pluginRoot();
    for (const name of fs.readdirSync(srcPlugin)) {
      if (name === 'client') continue; // 客户端是独立分发的 exe，不在插件目录内
      copyRecursive(path.join(srcPlugin, name), path.join(dstPlugin, name));
    }
    // 仓库根的其他文件（marketplace.json / README）不属于插件运行时，跳过
    log(`自更新完成：v${from} → v${to}（备份 ${backup}），重启服务后生效`);
    return { ok: true, updated: true, from, to, backup, url: dl.url, bytes: dl.bytes, restartRequired: true };
  } catch (e) {
    return { ok: false, updated: false, from, to: null, error: String(e.message || e).slice(0, 400) };
  } finally {
    rmSafe(tmpBase);
  }
}

/** 兜底：确认插件根解析正确（避免把文件写到错误位置）。 */
export function pathsInsideRoot() {
  return isInside(path.resolve(ROOT, '..'), ROOT);
}