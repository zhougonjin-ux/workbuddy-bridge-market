// 上游 429 全局限流协调（T30）：
//
// 背景：上游的限流是「账号维度」的（同一账号短时间高频对话必 429），而桥接侧的
// 重试/降级/账号轮换是「请求维度」的——一个客户端的失控重试循环会带着几个账号
// 轮流撞 429，把整池账号都拖进冷却（pool.mjs 的冷却阶梯挡不住跨请求的洪峰）。
//
// 做法：进程级共享一个「上游冷静窗」——任何一个账号吃 429，全体上游对话请求
// 在短时间内（指数退避，1s 起步、上限 30s）排队等待；窗口内已排队的请求依次放行。
// 池子的账号冷却逻辑保持不变，这里只协调「并发撞墙」，让冷却有时间生效。
//
// 设计约束：
//   - 只对「上游对话请求」生效（openChat），控制台/余额/任务接口不受影响；
//   - 客户端主动取消（signal 已 abort）不等待，直接放行让上游路径自己发现；
//   - 纯内存、零依赖；等待通过 Promise 排队（不占 CPU），进程退出无残留定时器。
//
// 结构：penaltyUntil（触顶时间戳）+ waiters（排队队列）+ 通知链。
let penaltyUntil = 0;
let penaltyMs = 0;
const waiters = []; // { resolve, signal, onWait }
let pumping = false;

const BASE_MS = 1000;
const MAX_MS = 30_000;

/** 记一次上游 429：全体上游请求进入冷静窗（指数退避）。 */
export function reportUpstream429() {
  const now = Date.now();
  penaltyMs = now < penaltyUntil ? Math.min(MAX_MS, penaltyMs * 2) : BASE_MS;
  penaltyUntil = now + penaltyMs;
  return penaltyMs;
}

/** 当前是否在冷静窗内（测试用）。 */
export function upstreamCoolingDown(now = Date.now()) {
  return now < penaltyUntil;
}

/** 测试隔离：清空惩罚状态与等待队列。 */
export function resetUpstreamCoordination() {
  penaltyUntil = 0;
  penaltyMs = 0;
  for (const w of waiters.splice(0)) w.resolve();
}

/**
 * 请求放行闸门：在冷静窗内时排队等待，窗开或被更晚的 429 顺延后依次放行。
 * signal 在等待期间被取消 → 立即返回（调用方 openChat 的 ac.signal 会发现客户端已断开）。
 * 返回实际等待的毫秒数（0 = 没等）。
 */
export async function waitForUpstreamSlot(signal = null) {
  const now = Date.now();
  if (now >= penaltyUntil) return 0;
  const waitMs = penaltyUntil - now;
  return new Promise((resolve) => {
    const entry = {
      resolve: () => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        // 放行后 abort 监听已完成使命：不移除的话监听器悬挂到请求对象 GC
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve(waitMs);
      },
    };
    let onAbort = null;
    waiters.push(entry);
    if (signal) {
      onAbort = () => entry.resolve();
      if (signal.aborted) { entry.resolve(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    schedulePump();
  });
}

/** 到点放行队列（单飞：同一时刻只有一个 pump 在跑）。 */
function schedulePump() {
  if (pumping) return;
  pumping = true;
  setTimeout(() => {
    pumping = false;
    const now = Date.now();
    if (now < penaltyUntil) { schedulePump(); return; } // 被更晚的 429 顺延，继续等
    for (const w of waiters.splice(0)) w.resolve();
  }, Math.max(1, penaltyUntil - Date.now())).unref?.();
}

/** 供诊断：当前惩罚状态。 */
export function coordinationStatus() {
  return { coolingDown: upstreamCoolingDown(), until: penaltyUntil || null, waiters: waiters.length };
}
