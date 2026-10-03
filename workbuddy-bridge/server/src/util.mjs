// HTTP 小工具：请求体读取、响应写出（含背压）、SSE 帧写出。
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BODY = 16 * 1024 * 1024;

/**
 * 原子写文件：先写 `<name>.tmp` 再 rename。
 *
 * 为什么：writeFileSync 写到一半进程被杀（断电/强杀）会留下半截 JSON，
 * 而账号池/配置文件解析失败时的默认行为是「视作空池/重置」——
 * 相当于一个崩溃就把用户全部登录凭证清掉了。rename 在同一目录内是原子的。
 */
export function writeJsonFileAtomic(file, data, { mode } = {}) {
  const tmp = file + '.tmp';
  const opts = mode ? { encoding: 'utf8', mode } : 'utf8';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', opts);
  fs.renameSync(tmp, file);
}

/**
 * 读取 JSON 文件；解析失败时把坏文件改名备份（`<name>.corrupt-<时间戳>`）再返回 null。
 *
 * 为什么备份而不是直接当空文件覆盖：坏文件里往往还有能手工抢救的数据
 * （半截 JSON 的前半段是完整的），直接覆盖 = 数据彻底没了。
 * 返回 null 表示「文件不存在或已损坏（已备份）」，由调用方决定默认值。
 */
export function readJsonFileWithBackup(file) {
  if (!fs.existsSync(file)) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(file, backup);
      console.warn(`[workbuddy-bridge] ${path.basename(file)} 解析失败，已备份为 ${path.basename(backup)} 后按默认值继续`);
    } catch {
      console.warn(`[workbuddy-bridge] ${path.basename(file)} 解析失败，且备份也失败，按默认值继续`);
    }
    return null;
  }
}


export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('请求体过大（上限 16MB）'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 同 sendJson，但允许调用方追加响应头（如 T23 控制台解锁接口的 Set-Cookie）。 */
export function sendJsonWith(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, status, message, type = 'upstream_error') {
  sendJson(res, status, { error: { message, type, code: status } });
}

/** 带背压的写出：客户端读得慢时等待 drain，避免内存堆积。 */
export function writeAsync(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    const ok = res.write(chunk);
    if (ok) resolve(true);
    else res.once('drain', () => resolve(true));
  });
}

export function startSSE(res, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extraHeaders,
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function writeSSE(res, payload) {
  return writeAsync(res, `data: ${payload}\n\n`);
}

export function writeSSEEvent(res, event, payload) {
  return writeAsync(res, `event: ${event}\ndata: ${payload}\n\n`);
}

/**
 * 流式心跳（T27）：上游「长时间只思考不吐字」（deepseek/glm 高强度推理实测可达数分钟）
 * 时，客户端与中间层可能因空闲超时掐断连接（Claude Code、反代、浏览器各有 30~120s 空闲窗）。
 * SSE 注释行（`: ping`）是协议保留的死信通道：任何标准客户端都会忽略，不算数据帧。
 * 返回 setInterval 句柄，调用方在流结束后 clearInterval（stop() 里同时补发一次清缓冲）。
 */
export function startHeartbeat(res, { intervalMs = 15000 } = {}) {
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    res.write(': ping\n\n');
  }, Math.max(3000, intervalMs));
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export function estimateTokens(text) {
  if (!text) return 0;
  // 粗略估算：中英混排按 3 字符 ≈ 1 token
  return Math.max(1, Math.ceil(String(text).length / 3));
}

/**
 * 失败自动重试一次（T12）：fn 抛错时等 backoffMs 再试一次，仍失败才抛出。
 * 只重试一次是有意的：任务类操作（签到/领奖）重试成本为零，但多轮重试会把
 * 「上游暂时抖动」放大成「连续打上游」，退避阶梯已经由账号池的冷却机制负责。
 */
export async function withRetryOnce(fn, { backoffMs = 1500 } = {}) {
  try {
    return await fn();
  } catch (e) {
    if (backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs));
    return fn();
  }
}
