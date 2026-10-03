// Windows 桌面通知（workbuddy-bridge 新增，T11）：签到失败 / 猫猫归来 / 账号登录态失效
// 这类「不看控制台就错过」的事，弹一个系统 toast。
//
// 实现：零依赖，走 Windows 自带的 PowerShell + System.Windows.Forms.NotifyIcon
// 气泡通知（Win10/11 均可用，无需 BurntToast 模块）。要点：
//   - spawn 分离进程（detached + unref），通知的生命周期不占本服务，也不阻塞调用方；
//   - 参数经 stdin 传 JSON（命令行传中文在 cmd/chcp 65001 之外的终端会乱码）；
//   - 全程吞错：通知是锦上添花，绝不能绊倒任务主流程；
//   - 节流：同一 key（如 "account-401-acc_x"）5 分钟内只弹一次，防止上游持续 401
//     时每 30 秒积分刷新都弹一遍。
// 非 Windows 平台静默跳过；notify.enabled=false（config）关闭。
import { spawn } from 'node:child_process';
import { log, warn } from './log.mjs';

const THROTTLE_MS = 5 * 60_000;
const lastFired = new Map(); // key → 时间戳
let psBusy = false;          // 上一条通知还没吐完时丢弃新的（气泡本来就最多同屏几条）

/** 纯函数便于单测：节流判断 + 过期键清理。 */
export function shouldNotify(key, now = Date.now(), store = lastFired) {
  const last = store.get(key) || 0;
  if (now - last < THROTTLE_MS) return false;
  store.set(key, now);
  if (store.size > 100) {
    for (const [k, t] of store) if (now - t > THROTTLE_MS) store.delete(k);
  }
  return true;
}

function firePS(title, text) {
  if (process.platform !== 'win32') return false;
  if (psBusy) return false;
  psBusy = true;
  try {
    // -NoProfile 加速启动；STA 是 NotifyIcon 的要求；stdin 喂参数避免命令行中文乱码
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', `
$input_json = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(8000, $input_json.title, $input_json.text, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 9
$n.Dispose()
`], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.stdin.end(JSON.stringify({ title: String(title).slice(0, 60), text: String(text).slice(0, 180) }));
    child.on('error', () => { psBusy = false; });
    child.on('exit', () => { psBusy = false; });
    child.unref?.();
    return true;
  } catch (e) {
    psBusy = false;
    warn('桌面通知发送失败：', e.message);
    return false;
  }
}

/**
 * 发一条桌面通知。key 相同的 5 分钟内只发一次；opts:{ key, force } 可去重/强发。
 * 返回是否真的发出了（供测试断言；测试可注入 fake fire）。
 */
export function notify(cfg, title, text, { key = null, force = false, _fire = firePS } = {}) {
  try {
    if (cfg?.notify?.enabled === false) return false;
    if (process.platform !== 'win32') return false;
    if (!force && key && !shouldNotify(key)) return false;
    const ok = _fire(title, text);
    if (ok) log(`桌面通知：${title} — ${String(text).slice(0, 80)}`);
    return ok;
  } catch {
    return false;
  }
}

/** 便捷包装：任务类通知（自动带任务 key 去重）。cfg 缺省时用空配置（仍受平台限制）。 */
export function notifyTask(cfg, title, text, keySuffix = '') {
  return notify(cfg, title, text, { key: `task-${title}-${keySuffix}` });
}

/** 测试隔离：清空节流表。 */
export function resetNotifyThrottle() {
  lastFired.clear();
}
