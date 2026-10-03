// 进程生命周期注册表：把 server.mjs 里的交棒重启逻辑暴露给 console-api 等模块用，
// 避免 console-api → server.mjs 的循环 import（server.mjs 已经 import 了 console-api）。
// server.mjs 启动时 setRestartHandler 注册；未注册时调用方拿到 503。
let restartHandler = null;

export function setRestartHandler(fn) {
  restartHandler = fn;
}

/** 触发交棒重启；返回 { pid, waiting, active }，抛错时带 status 供 HTTP 层透传。 */
export function requestRestart() {
  if (!restartHandler) {
    throw Object.assign(new Error('重启处理器未就绪（服务还在启动中）'), { status: 503 });
  }
  return restartHandler();
}
