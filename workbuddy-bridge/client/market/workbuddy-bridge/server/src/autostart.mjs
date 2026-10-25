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

/** 探测代理是否存活（默认 1.5 秒超时，健康检查必须快）。 */
export async function isProxyAlive(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 分离进程拉起代理（不随宿主退出），返回是否成功发起。
 * 子进程输出落到数据目录 server.log（带来源标注）：拉起失败时可以查原因，不再静默消失。
 */
export function spawnProxy(source = 'unknown') {
  if (!fs.existsSync(SERVER_ENTRY)) return false;
  let stdio = 'ignore';
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    stdio = fs.openSync(path.join(dataDir(), 'server.log'), 'a');
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
