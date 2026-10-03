// 交棒重启的实现体：从 server.mjs 拆出来，让 console-api（经 lifecycle.mjs 注册表）
// 也能触发同一条安全重启路径。拆分原因见 lifecycle.mjs 头注释（循环 import）。
// 依赖 server.mjs 启动时注入的 activeRequests 计数与路由表，通过 boot() 传入。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, paths } from './config.mjs';
import { error, log } from './log.mjs';
import { recordEvent } from './events.mjs';
import { flushUsage } from './usage.mjs';
import { flushPool } from './pool.mjs';
import { flushLearned } from './compress.mjs';
import { flushEvents } from './events.mjs';
import { stopCreditLoop } from './scheduler.mjs';
import { stopTaskLoop } from './tasks.mjs';
import { stopHealthLoop } from './health.mjs';
import { stopProviderConfigSync } from './pickersync.mjs';

let state = { activeRequestsRef: null, draining: false, exiting: false, pendingExits: [], stoppers: [], flushers: [] };

/** server.mjs 启动时注入依赖：活跃计数 getter、各后台循环的 stop 函数、各刷盘函数。 */
export function bootLifecycle({ activeRequestsRef, stoppers = [], flushers = [] }) {
  state = {
    ...state,
    activeRequestsRef,
    stoppers,
    flushers,
    draining: false,
    exiting: false,
    pendingExits: [],
  };
}

/** 请求结束时调用：活跃数归零且处于 draining 状态就执行挂起的退出。 */
export function drainWaiters() {
  if (!state.draining || state.activeRequestsRef() > 0) return;
  const fns = state.pendingExits.splice(0);
  for (const fn of fns) fn();
}

/**
 * 优雅退出：刷盘 → 停后台循环 → close 服务器。
 * waitIdle=true 时等活跃请求归零再退出（交棒场景）；期间新到的 /v1/* 请求照常服务。
 * 返回 { waiting, active }；close 回调由 server.mjs 传入（进程退出动作留在 server.mjs）。
 *
 * 交棒时序（2026-10-03 16:49 断线事故后梳理）：Windows 下新旧实例不能共存绑定同一端口，
 * 所以「零空窗」靠的是——老实例等空闲立即退出交端口，新实例在 server.mjs 的 EADDRINUSE
 * 重试循环里排队（0.5 秒一跳，绑定成功才允许进程存活），老实例一放手新实例 0.5 秒内接住。
 * 新实例起不来的兜底是 ZCode 下次会话的 hook 拉起；老实例绝不能等新实例就绪再退
 * （那反而把每次交棒都拖成必有一次空窗）。
 */
export function gracefulExit({ waitIdle = false, reason = 'stop', onClose = null } = {}) {
  const finish = () => {
    if (state.exiting) return;
    state.exiting = true;
    log(`正在保存用量统计并关闭服务（${reason}）`);
    recordEvent('system', `服务退出（${reason}）`);
    for (const s of state.stoppers) { try { s(); } catch { /* 退出路径不互相绊 */ } }
    for (const f of state.flushers) { try { f(); } catch { /* 同上 */ } }
    if (onClose) onClose();
    else {
      // 没传 onClose 的调用方（交棒路径）走兜底：5 秒后强退
      setTimeout(() => process.exit(0), 5000).unref?.();
    }
  };
  if (waitIdle && state.activeRequestsRef() > 0) {
    state.draining = true;
    log(`${reason}：${state.activeRequestsRef()} 个请求进行中，等全部完成后退出`);
    state.pendingExits.push(finish);
    return { waiting: true, active: state.activeRequestsRef() };
  }
  finish();
  return { waiting: false };
}

/** 以分离进程拉起一个新 server 实例（交棒重启用）。 */
export function spawnReplacement() {
  const serverEntry = path.join(ROOT, 'server.mjs');
  if (!fs.existsSync(serverEntry)) {
    error(`交棒重启失败：找不到 ${serverEntry}`);
    return null;
  }
  let stdio = 'ignore';
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    stdio = fs.openSync(path.join(paths.root, 'server.log'), 'a');
    fs.writeSync(stdio, `\n===== 交棒重启 ${new Date().toLocaleString()} =====\n`);
  } catch { /* 打不开日志就退回 ignore */ }
  const child = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', stdio, stdio],
    env: { ...process.env, WB_HOOK_SPAWN: '1' },
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

/** 交棒重启入口（/admin/restart 与 /console/api/service/restart 共用）。 */
export function doRestart() {
  if (state.exiting) throw Object.assign(new Error('已在退出流程中'), { status: 409 });
  if (state.draining) throw Object.assign(new Error('交棒重启已在进行中，请稍候'), { status: 409 });
  const pid = spawnReplacement();
  if (!pid) throw Object.assign(new Error('拉起新实例失败（见服务日志）'), { status: 500 });
  log(`交棒重启：新实例 PID=${pid} 已拉起（排队等端口），本实例等空闲后退出`);
  const r = gracefulExit({ waitIdle: true, reason: '交棒重启' });
  return { pid, ...r };
}
