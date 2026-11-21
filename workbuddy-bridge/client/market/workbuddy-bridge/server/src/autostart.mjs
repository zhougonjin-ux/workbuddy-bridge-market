// 自动拉起本地代理的共享实现：探测 /health → 不通就分离进程拉起 server.mjs。
//
// 三条链路共用同一份逻辑，任何一条失效，其余仍是兜底：
//   1) SessionStart hook（hooks/ensure-server.mjs）—— 打开会话时拉起
//   2) MCP 入口（mcp/index.mjs）—— 启动时拉起；工具调用遇到连接拒绝时自愈重试
//   3) /wbp-startup 计划任务 —— 开机拉起（用户可选装）
//
// 行为约定：幂等（活着就不动）、绝不抛错（失败返回状态对象）、
// 分离进程拉起（不随宿主退出）、autostart.json 开关可永久关闭。
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件在 server/src/ 下，server 入口就在上一级
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.mjs');

/** 数据目录（WB_CONFIG_DIR 环境变量优先，默认 ~/.zcode/workbuddy-bridge）。 */
export function dataDir() {
  return process.env.WB_CONFIG_DIR
    ? path.resolve(process.env.WB_CONFIG_DIR)
    : path.join(os.homedir(), '.zcode', 'workbuddy-bridge');
}

/** 从数据目录 config.json 读端口，没生成过配置或非法值都用默认 8788。 */
export function readPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
    if (Number.isInteger(cfg.port) && cfg.port > 0) return cfg.port;
  } catch {
    /* 还没生成过配置，用默认端口 */
  }
  return 8788;
}

/** autostart.json 开关：{"enabled":false} 表示用户永久关闭了自动拉起。 */
export function autostartDisabled() {
  try {
    const gate = JSON.parse(fs.readFileSync(path.join(dataDir(), 'autostart.json'), 'utf8'));
    return gate.enabled === false;
  } catch {
    return false; // 没有开关文件 = 默认开
  }
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** server.log 超过阈值时改名成 .1（覆盖上一份），任何失败都静默跳过。 */
function rotateLogIfLarge(file) {
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return;
    try { fs.rmSync(file + '.1', { force: true }); } catch { /* 旧文件被占用就放弃本轮 */ }
    fs.renameSync(file, file + '.1');
  } catch {
    /* 文件不存在 / 无权限：继续追加即可 */
  }
}

/**
 * 探测代理是否存活（默认 1.5 秒超时，健康检查必须快）。 */
export async function isProxyAlive(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 端口上有没有活进程在监听（原始 TCP 连接，几十毫秒出结果）。
 *
 * 与 isProxyAlive 的区别：/health 是 HTTP 层探测，事件循环被大请求（如百万 token
 * 会话的压缩）卡住时会超时，但端口仍被活实例占着——这时再拉新实例只会
 * EADDRINUSE 重试 30 秒后放弃，除了刷日志毫无作用（2026-11-16 全天事故）。
 * TCP 能连上 = 有 LISTENER = 一定不要拉起。TIME_WAIT 不影响 connect，不会误报。
 */
export function tcpReachable(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      clearTimeout(t);
      try { s.destroy(); } catch { /* 已销毁 */ }
      resolve(v);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * 分离进程拉起代理（不随宿主退出），返回是否成功发起。
 * 子进程输出落到数据目录 server.log（带来源标注）：拉起失败时可以查原因，不再静默消失。
 * 超过 5 MB 时轮转为 server.log.1（只保留一份）：常驻服务每天重启会无限追加，
 * 半年后 server.log 能到几十 MB，控制台「日志」页反而更难用。
 */
export function spawnProxy(source = 'unknown') {
  if (!fs.existsSync(SERVER_ENTRY)) return false;
  let stdio = 'ignore';
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const logFile = path.join(dataDir(), 'server.log');
    rotateLogIfLarge(logFile);
    stdio = fs.openSync(logFile, 'a');
    fs.writeSync(stdio, `\n===== 自动拉起（${source}，${new Date().toLocaleString()}） =====\n`);
  } catch {
    /* 打不开日志文件就退回 ignore */
  }
  try {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      detached: true,
      stdio: ['ignore', stdio, stdio],
      env: { ...process.env, WB_CONFIG_DIR: dataDir(), WB_HOOK_SPAWN: '1' },
      windowsHide: true,
    });
    child.on('error', () => {}); // 拉起失败也不报错——调用方按返回值处理
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保代理在运行（幂等）。返回状态对象，绝不抛错：
 *   { ok:true,  action:'alive'|'spawned'|'disabled', port? }
 *   { ok:false, action:'missing'|'spawn-failed'|'timeout'|'error', port?, error? }
 *
 * waitMs > 0 时拉起后轮询等 /health 就绪（MCP 自愈用）；
 * 传 0（hook 链路）则拉起即返回，绝不阻塞会话。
 */
export async function ensureProxyRunning({ waitMs = 0, source = 'unknown' } = {}) {
  try {
    if (autostartDisabled()) return { ok: true, action: 'disabled' };
    const port = readPort();
    if (await isProxyAlive(port)) return { ok: true, action: 'alive', port };
    // /health 不通但 TCP 能连上：有活实例占着端口（多半是事件循环被大请求暂时卡住）。
    // 拉新实例注定 EADDRINUSE，只会白刷 30 秒端口重试日志——按「活着」处理，不拉。
    if (await tcpReachable(port)) return { ok: true, action: 'alive', port, note: 'health-timeout-port-busy' };
    if (!fs.existsSync(SERVER_ENTRY)) return { ok: false, action: 'missing', port };
    if (!spawnProxy(source)) return { ok: false, action: 'spawn-failed', port };
    if (waitMs > 0) {
      const deadline = Date.now() + waitMs;
      while (Date.now() <= deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (await isProxyAlive(port, 1000)) return { ok: true, action: 'spawned', port };
      }
      return { ok: false, action: 'timeout', port };
    }
    return { ok: true, action: 'spawned', port };
  } catch (e) {
    return { ok: false, action: 'error', error: e?.message };
  }
}
