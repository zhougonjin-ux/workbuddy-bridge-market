// 桌面客户端安装/卸载/状态（0.3.46）：网页控制台「帮助」页的安装按钮走这里。
// 与 client/Setup.exe 的差别：Setup 给「只有 exe 的用户」双击安装用；本模块给
// 「已装插件的机器」从网页控制台一键装——服务端自己就是版本与位置的权威，
// 直接复制 client/ 预编译产物到 %LOCALAPPDATA%\WorkBuddyBridge 并注册系统入口。
//
// 全部子进程调用用参数数组（spawnSync），不经过 shell 拼接——中文/空格路径无转义问题。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { log, warn } from './log.mjs';

const APP_NAME = 'WorkBuddy 积分桥';
const REG_UNINSTALL = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddyBridge';
const REG_RUN = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
const EXE_NAME = 'WorkBuddyBridgeTray.exe';

const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const clientInstallDir = () => path.join(localAppData(), 'WorkBuddyBridge');
const clientSourceDir = () => path.join(ROOT, '..', 'client');

function pluginVersion() {
  try {
    const json = fs.readFileSync(path.join(ROOT, '..', '.zcode-plugin', 'plugin.json'), 'utf8');
    const m = /"version"\s*:\s*"([^"]+)"/.exec(json);
    if (m) return m[1];
  } catch { /* 回落 package.json */ }
  try {
    const json = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const m = /"version"\s*:\s*"([^"]+)"/.exec(json);
    if (m) return m[1];
  } catch { /* 都读不到就算了 */ }
  return '0.0.0';
}

/** 客户端安装状态：installed=安装目录存在且托盘 exe 在；canInstall=插件分发里有预编译产物。 */
export function clientStatus() {
  const dir = clientInstallDir();
  const exe = path.join(dir, EXE_NAME);
  let installed = false, installedVersion = null, bridgePath = null;
  try {
    installed = fs.existsSync(exe);
    if (installed) {
      try { installedVersion = fs.readFileSync(path.join(dir, 'version.txt'), 'utf8').trim(); } catch { }
      try { bridgePath = fs.readFileSync(path.join(dir, 'bridge-path.txt'), 'utf8').trim(); } catch { }
    }
  } catch { }
  const canInstall = fs.existsSync(path.join(clientSourceDir(), EXE_NAME)) && process.platform === 'win32';
  return {
    installed,
    canInstall,
    installDir: installed ? dir : null,
    version: installed ? (installedVersion || null) : null,
    bridgePath: installed ? (bridgePath || null) : null,
    pluginVersion: pluginVersion(),
    appName: APP_NAME,
  };
}

/** PowerShell 建 .lnk（参数数组传递，中文路径无编码问题）。 */
function createShortcut(lnkPath, target, workDir) {
  if (fs.existsSync(lnkPath)) { try { fs.unlinkSync(lnkPath); } catch { /* 覆盖失败就让它指向旧位置 */ } }
  const script = `$ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}'); `
    + `$lnk.TargetPath = '${target.replace(/'/g, "''")}'; $lnk.WorkingDirectory = '${workDir.replace(/'/g, "''")}'; `
    + `$lnk.Description = '${APP_NAME.replace(/'/g, "''")}'; $lnk.Save()`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 20_000, windowsHide: true,
  });
}

/** 注册表 Uninstall 键（控制面板「应用和功能」入口）。 */
function writeUninstallRegistry(installDir) {
  const reg = (kv) => {
    for (const [name, type, value] of kv) {
      execFileSync('reg', ['add', REG_UNINSTALL, '/v', name, '/t', type, '/d', value, '/f'], {
        timeout: 10_000, windowsHide: true,
      });
    }
  };
  reg([
    ['DisplayName', 'REG_SZ', APP_NAME],
    ['DisplayVersion', 'REG_SZ', pluginVersion()],
    ['Publisher', 'REG_SZ', 'workbuddy-bridge'],
    ['DisplayIcon', 'REG_SZ', path.join(installDir, EXE_NAME)],
    ['InstallLocation', 'REG_SZ', installDir],
    ['UninstallString', 'REG_SZ', '"' + path.join(installDir, 'uninstall.exe') + '" --uninstall'],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
  ]);
}

/** 静默安装桌面客户端（网页控制台一键）。返回 { ok, installDir, error? }。 */
export function installClient() {
  if (process.platform !== 'win32') return { ok: false, error: '桌面客户端仅支持 Windows' };
  const src = clientSourceDir();
  const traySrc = path.join(src, EXE_NAME);
  const setupSrc = path.join(src, 'WorkBuddyBridgeSetup.exe');
  if (!fs.existsSync(traySrc)) return { ok: false, error: '插件分发里没有预编译的客户端产物（client/' + EXE_NAME + ' 缺失）' };

  const dir = clientInstallDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(traySrc, path.join(dir, EXE_NAME));
  if (fs.existsSync(setupSrc)) fs.copyFileSync(setupSrc, path.join(dir, 'WorkBuddyBridgeSetup.exe'));
  // uninstall.exe：优先用 Setup 产物（完整卸载逻辑）；没有 Setup 就用 --uninstall 副本占位
  if (fs.existsSync(setupSrc)) fs.copyFileSync(setupSrc, path.join(dir, 'uninstall.exe'));
  fs.writeFileSync(path.join(dir, 'bridge-path.txt'), ROOT);
  fs.writeFileSync(path.join(dir, 'version.txt'), pluginVersion());

  const menuDir = path.join(process.env.APPDATA || path.join(localAppData(), 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_NAME);
  fs.mkdirSync(menuDir, { recursive: true });
  createShortcut(path.join(menuDir, APP_NAME + '.lnk'), path.join(dir, EXE_NAME), dir);
  createShortcut(path.join(menuDir, '卸载 ' + APP_NAME + '.lnk'), path.join(dir, 'uninstall.exe'), dir);
  try {
    createShortcut(path.join(os.homedir(), 'Desktop', APP_NAME + '.lnk'), path.join(dir, EXE_NAME), dir);
  } catch { /* 桌面路径异常不拦安装 */ }
  writeUninstallRegistry(dir);
  log(`桌面客户端已安装：${dir}`);
  return { ok: true, installDir: dir, version: pluginVersion() };
}

/** 卸载（控制台可选入口）：停托盘、清快捷方式与注册表，保留账号数据。 */
export function uninstallClient() {
  const dir = clientInstallDir();
  try {
    // 停托盘进程（不碰代理服务——服务由插件自己管理）
    try { execFileSync('taskkill', ['/F', '/IM', 'WorkBuddyBridgeTray.exe'], { timeout: 10_000, windowsHide: true }); } catch { /* 没在跑 */ }
    const menuDir = path.join(process.env.APPDATA || path.join(localAppData(), 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_NAME);
    try { fs.rmSync(menuDir, { recursive: true, force: true }); } catch { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { warn('客户端目录删除失败（文件可能被占用）：', e.message); }
    for (const key of [REG_UNINSTALL, REG_RUN]) {
      // Run 键只删本应用的值，整键删除会伤及他人——用 reg delete 指定 /va 不行，这里逐值处理太繁，
      // Run 键的删除交给 reg delete 带值名：WorkBuddyBridge
      try { execFileSync('reg', ['delete', key, '/v', APP_NAME, '/f'], { timeout: 10_000, windowsHide: true }); } catch { /* 值不存在 */ }
    }
    try { execFileSync('reg', ['delete', REG_UNINSTALL, '/f'], { timeout: 10_000, windowsHide: true }); } catch { /* 键不存在 */ }
    log('桌面客户端已卸载：' + dir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

/** 未安装时的一次性气泡提醒（每天最多一次；客户端安装后永不再弹）。 */
let notifiedDay = null;
export function maybeNotifyClientAvailable(cfg, notifyFn) {
  if (process.platform !== 'win32') return;
  if (clientStatus().installed) return;
  const today = new Date().toISOString().slice(0, 10);
  if (notifiedDay === today) return;
  notifiedDay = today;
  try {
    notifyFn(cfg, '桌面客户端可安装', '网页控制台 → 帮助页 → 「桌面客户端」一键安装（托盘常驻，双击即用）');
  } catch { /* 提醒失败不影响主流程 */ }
}
