// 进程生命周期注册表：把 server.mjs 里的交棒重启/停止逻辑暴露给 console-api 等模块用，
// 避免 console-api → server.mjs 的循环 import（server.mjs 已经 import 了 console-api）。
// server.mjs 启动时 setRestartHandler / setStopHandler 注册；未注册时调用方拿到 503。
let restartHandler = null;
let stopHandler = null;

export function setRestartHandler(fn) {
  restartHandler = fn;
}

export function setStopHandler(fn) {
  stopHandler = fn;
}

/** 触发交棒重启；返回 { pid, waiting, active }，抛错时带 status 供 HTTP 层透传。 */
export function requestRestart() {
  if (!restartHandler) {
    throw Object.assign(new Error('重启处理器未就绪（服务还在启动中）'), { status: 503 });
  }
  return restartHandler();
}

/**
 * 请求停止服务（B2）。走 gracefulExit 完整流程：停后台循环 + 刷 usage/events/learned，
 * 并在有活跃请求时等待它们跑完——直接 process.exit 会掐断在途模型请求。
 */
export function requestStop({ force = false } = {}) {
  if (!stopHandler) {
    throw Object.assign(new Error('停止处理器未就绪（服务还在启动中）'), { status: 503 });
  }
  return stopHandler({ force });
}

