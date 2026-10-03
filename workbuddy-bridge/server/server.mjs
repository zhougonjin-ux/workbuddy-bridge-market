// 本地反代服务入口（workbuddy-bridge）：把 WorkBuddy（CodeBuddy）账号能力暴露为
//   - OpenAI 兼容：/v1/models、/v1/chat/completions
//   - Anthropic 兼容：/v1/messages、/v1/messages/count_tokens
//   - 控制台：/console（本机网页控制台）
//   - 桥接管理：/admin/bridge、/admin/policy、/admin/credit/refresh、/admin/tasks（MCP/命令用）
// 仅供本机（默认 127.0.0.1）使用，不读写数据目录以外的任何文件。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, getLastConfigIssues, paths, siteKeys, authKeys, primaryKey, ROOT } from './src/config.mjs';
import { getAuth, isLoggedIn } from './src/auth.mjs';
import { handleChatCompletions, handleModels } from './src/openai.mjs';
import { handleResponses } from './src/responses.mjs';
import { handleMessages, handleCountTokens } from './src/anthropic.mjs';
import { queryCredit, supportsCreditQuery } from './src/upstream.mjs';
import { handleConsoleApi } from './src/console-api.mjs';
import { flushUsage } from './src/usage.mjs';
import { flushLearned } from './src/compress.mjs';
import { flushEvents, recordEvent } from './src/events.mjs';
import { flushPool } from './src/pool.mjs';
import { createRateLimiter } from './src/ratelimit.mjs';
import { readJsonBody, sendJson, sendJsonWith, sendError } from './src/util.mjs';
import { log, warn, error } from './src/log.mjs';
import { bridgeStatus, setPolicy, refreshCreditsAll, startCreditLoop, stopCreditLoop, scheduleCreditRefreshSoon } from './src/scheduler.mjs';
import { runTasks, taskStatus, startTaskLoop, stopTaskLoop } from './src/tasks.mjs';
import { startHealthLoop, stopHealthLoop } from './src/health.mjs';
import { importLocalAccounts } from './src/localimport.mjs';
import { startProviderConfigSync, stopProviderConfigSync, triggerProviderConfigSyncNow } from './src/pickersync.mjs';

// 配置读不出来时要给出可读提示，而不是抛一串裸栈。
// 尤其是 JSON 语法错误——用户手改 config.json 很容易漏个逗号。
let cfg;
let configIssues = [];
try {
  cfg = loadConfig();
  // loadConfig 内部已完成校验与降级，并记录了发现的问题（getLastConfigIssues）
  configIssues = getLastConfigIssues();
} catch (e) {
  error('读取 config.json 失败，服务无法启动：');
  error(`  ${e.message}`);
  if (e.code === 'INVALID_CONFIG_JSON') {
    error(`  文件位置：${paths.config}`);
    error('  常见原因：手改时漏了逗号、多了逗号，或用了单引号（JSON 只认双引号）。');
    error('  可以用 node -e "JSON.parse(require(\'fs\').readFileSync(\'config.json\',\'utf8\'))" 检查语法。');
    error('  修好后重新启动；若想回到默认配置，可先备份再删除该文件。');
  }
  process.exit(1);
}

// 控制台会话 token：每次启动随机生成，注入到控制台页面里；避免把 apiKey 暴露在浏览器中
const CONSOLE_TOKEN = crypto.randomBytes(16).toString('hex');
const CONSOLE_DIR = path.join(ROOT, 'console');

// ---- 控制台访问 PIN（T23）----
// 启用方式：config.json 设 consolePin: "1234"（4-12 位数字），或控制台「安全」卡直接设置。
// 设了之后：
//   - GET /console 返回锁屏页而不是真页面，输入 PIN → POST /console/api/unlock；
//   - 校验通过发会话 token（同时种 HttpOnly cookie，解锁后的 API 调用与页面刷新都免重输）；
//   - /console/api/* 照旧要求 token/apiKey —— 锁屏挡的是「别人坐在这台电脑前打开控制台」，
//     不是替代接口鉴权。
// 每次请求现读 cfg（控制台改 PIN 立即生效，无需重启）；校验失败 1 秒延迟 + 最多 20 次，防爆破。
const pinAttempts = { count: 0, lastAt: 0 };

function consoleLocked() {
  const pin = cfg.consolePin;
  return typeof pin === 'string' && pin.trim().length > 0;
}

function consolePinValue() {
  return String(cfg.consolePin || '').trim();
}

/** 锁屏页（真页面不落盘给未解锁的浏览器）。 */
function consoleLockPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>WorkBuddy 控制台 · 已锁定</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1017;color:#e8eaf0;font:15px/1.6 system-ui,'Segoe UI','Microsoft YaHei',sans-serif}
  .box{width:320px;padding:34px 30px;border:1px solid #232a3a;border-radius:14px;background:#12161f;text-align:center}
  h1{font-size:17px;margin:0 0 4px}.muted{color:#8a93a8;font-size:12.5px;margin:0 0 18px}
  input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #2a3347;border-radius:9px;background:#0a0c10;color:#e8eaf0;font-size:20px;letter-spacing:8px;text-align:center;outline:none}
  input:focus{border-color:#4d7cfe}
  button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;background:#4d7cfe;color:#fff;font-size:14.5px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .err{color:#ff6b6b;font-size:12.5px;min-height:18px;margin-top:10px}
</style></head><body>
<div class="box">
  <h1>🔒 WorkBuddy 控制台</h1>
  <p class="muted">此控制台已开启访问 PIN，请输入解锁</p>
  <form id="f">
    <input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="••••" autofocus>
    <button id="go" type="submit">解锁</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
'use strict';
const f=document.getElementById('f'),pin=document.getElementById('pin'),err=document.getElementById('err'),go=document.getElementById('go');
f.onsubmit=async(e)=>{e.preventDefault();err.textContent='';go.disabled=true;go.textContent='校验中…';
  try{
    const r=await fetch('/console/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pin.value})});
    const j=await r.json().catch(()=>({}));
    if(r.ok&&j.ok&&j.token){sessionStorage.setItem('wbConsoleToken',j.token);location.reload();}
    else{err.textContent=j.error||('校验失败（HTTP '+r.status+'）');pin.value='';pin.focus();}
  }catch(ex){err.textContent='请求失败：'+ex.message;}
  go.disabled=false;go.textContent='解锁';};
pin.focus();
</script></body></html>`;
}


// ---- 限流 ----
// 服务只绑 127.0.0.1，所以要挡的不是远程攻击，而是：
//   - 客户端 bug 造成的失控重试循环
//   - 重端点被反复触发（/console/api/probe 一次最多 60 次上游调用 + 至少 15 秒）
// 放在**鉴权与路由之前**：这样未授权的请求也能被廉价拒掉，
// 而不是先做完鉴权才发现对方在刷。
// 默认值刻意放宽，正常单用户使用（含编码 agent 的工具调用突发）远达不到。
const 限流配置 = cfg.rateLimit || {};
const 限流开启 = 限流配置.enabled !== false;
const 全局限流 = 限流开启
  ? createRateLimiter({ windowMs: 限流配置.windowMs, max: 限流配置.max })
  : null;
// /probe 单独一档，阈值更严
const 探测限流 = 限流开启 ? createRateLimiter({ windowMs: 限流配置.windowMs, max: 限流配置.probeMax }) : null;

/** 请求来源标识：本机服务下基本恒为回环地址，但仍按 IP 记，绑 0.0.0.0 时才有区分度。 */
function 来源标识(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function consoleAuthorized(req) {
  if ((req.headers['x-console-token'] || '') === CONSOLE_TOKEN) return true;
  // T23：PIN 解锁后发的会话 cookie（值即 token）。锁屏页判断「是否已解锁」用它——
  // 解锁后刷新 /console 不能又弹锁屏。HttpOnly + SameSite=Strict，脚本读不到、跨站不带。
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)wbConsoleToken=([^;]+)/.exec(cookie);
  if (m && m[1] === CONSOLE_TOKEN) return true;
  return authorized(req); // 也允许直接用 apiKey 调控制台接口（方便脚本）
}

/**
 * 本机来源校验（用于 /console 页面与控制台接口）。
 *
 * 为什么需要：服务虽只监听 127.0.0.1，但本机服务对「用户浏览器里打开的任意网页」同样可达。
 * 跨站页面发起 fetch('http://127.0.0.1:8788/console') 时，源是恶意页面、目标是本机，
 * 若响应带 ACAO:* 且页面无需鉴权，对方就能读走内联在 HTML 里的会话 token，
 * 进而调用控制台接口（切模型 / 删凭证 / 停服）。因此这里必须校验来源。
 *
 * 判定规则：
 *   - 无 Origin（curl / ask.mjs / stop.mjs 等本机工具，以及同源导航）→ 放行
 *   - Origin 的 host 属于本机回环地址（localhost / 127.x / [::1]）→ 放行
 *   - 其他一律拒绝
 * 同时校验 Host 头，抵御 DNS rebinding（恶意域名重绑定到 127.0.0.1 时 Host 仍是外部域名）。
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  // 127.0.0.0/8 整个网段都视作本机
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** 请求的 Host 是否指向本机（挡 DNS rebinding）。 */
function hostIsLocal(req) {
  const host = req.headers.host || '';
  if (!host) return true; // HTTP/1.0 等无 Host 的场景，交由 Origin 判定
  try {
    const { hostname } = new URL(`http://${host}`);
    return isLoopbackHostname(hostname);
  } catch {
    return false;
  }
}

/** 控制台来源是否可信。 */
function consoleOriginAllowed(req) {
  if (!hostIsLocal(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // 同源导航 / 本机工具：不带 Origin
  try {
    const { hostname } = new URL(origin);
    return isLoopbackHostname(hostname);
  } catch {
    return false;
  }
}

/** 汇总各站点登录状态。 */
function siteState(cfgIn) {
  return siteKeys(cfgIn).map((site) => {
    const a = getAuth(site);
    return {
      site,
      label: cfgIn.sites[site].label,
      apiBase: cfgIn.sites[site].apiBase,
      logged_in: isLoggedIn(site),
      uid: a.uid ? String(a.uid).slice(0, 8) + '…' : null,
      nickname: a.nickname || null,
      token_expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
    };
  });
}

function clientKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.headers['x-api-key'] || '').toString().trim() || auth.trim();
}

function authorized(req) {
  // 注意：密钥为空时必须视为「未配置密钥」而不是「放行」。
  // 原本的 !cfg.apiKey 会让被误清空的配置变成完全无鉴权，这里显式判定。
  // apiKey 可以是字符串或字符串数组，数组里每个都有效（见 config.mjs 的 authKeys）。
  const keys = authKeys(cfg);
  if (!keys.length) return true; // 未配置密钥则不校验（仅建议本机场景）
  return keys.includes(clientKey(req));
}

// ---- 不可断线保护（activeRequests / 交棒重启）----
// 本服务承载 ZCode 会话自身的模型连接：进程退出 = 会话断线。因此：
//   1) /admin/shutdown 在有活跃请求时拒绝（除非 force=1）；
//   2) /admin/restart 用「交棒」重启：先把新实例拉起来排队等端口，本实例等
//      activeRequests 归零（完全空闲）后才退出交出端口 —— 进行中的请求不受影响。
// 实现体在 lifecycle-impl.mjs（console-api 的 /service/restart 也要走同一条路径，
// 拆出去避免 console-api → server.mjs 的循环 import）；这里只持有计数与依赖注入。
import { bootLifecycle, drainWaiters, gracefulExit, doRestart, doStop } from './src/lifecycle-impl.mjs';
import { setRestartHandler, setStopHandler } from './src/lifecycle.mjs';
let activeRequests = 0;

/**
 * 判定一个路径是不是「模型调用」——只有这类请求算活跃请求（掐断它 = 用户会话断线）。
 *
 * 覆盖：OpenAI 兼容（/v1/*）、根路径的协议端点（Anthropic 与 responses 在根路径）、
 * 以及 GET /v1/models（客户端启动时拉模型列表，掐断等于会话连不上）。
 * 其余（/health、/console/**、/admin/**、/status 等后台与发现类接口）都不计入。
 *
 * 用「路径分段里出现连续匹配」而不是整串正则，与下方协议分派的 hasSeg 同一套口径 ——
 * 否则 TraeWork 那种 `/v1/messages/chat/completions` 的拼接写法会被漏判成非模型请求。
 */
function isModelPath(pathname) {
  if (pathname === '/health' || pathname === '/healthz') return false;
  if (pathname.startsWith('/console') || pathname.startsWith('/admin')) return false;
  if (pathname === '/status') return false;
  const segs = pathname.split('/').filter(Boolean);
  const hasSeg = (...want) => {
    for (let i = 0; i + want.length <= segs.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (segs[i + j] !== want[j]) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  };
  return (
    hasSeg('models') ||
    hasSeg('chat', 'completions') ||
    hasSeg('completions') ||
    hasSeg('messages') ||
    hasSeg('responses') ||
    hasSeg('embeddings')
  );
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // ---- 活跃请求计数（不可断线保护）----
  // 本服务的模型流量承载着 ZCode 会话自身的模型连接：shutdown/restart 若在
  // 会话请求进行中执行，等于掐断自己的模型通道，会话当场死亡。
  // 因此凡可能退出进程的路径都必须先看 activeRequests；/health 不计数（hook 探测要用，
  // 且它不碰模型流量）。
  //
  // 只统计「模型调用」（/v1/* 与根路径的协议端点）。控制台与后台接口不算：
  //   - 控制台每 20 秒轮询一次、还有一条 SSE 长连接，res 的 close 事件可能几十分钟
  //     都不触发（旧标签页常年开着），一旦计入就会让活跃数永久 ≥ 1，交棒重启永远等
  //     不到空闲、老实例永不退出、新实例 30 秒后放弃 —— 表现为「改了代码却没生效」
  //     但 health 一切正常，极难排查；
  //   - 这些请求本来就与用户会话生死无关（掐断最多让控制台面板闪一下）。
  if (isModelPath(pathname)) {
    activeRequests++;
    res.on('close', () => { activeRequests--; drainWaiters(); });
  }

  const isConsolePath = pathname === '/console' || pathname.startsWith('/console/');

  // 控制台相关路径：绝不设置 ACAO:*，否则任意网页都能跨域读走页面内的会话 token
  // （页面无需鉴权即可访问，token 明文中内联在 HTML 里）。同时禁止被 iframe 嵌入。
  if (isConsolePath) {
    res.setHeader('Vary', 'Origin');
    if (consoleOriginAllowed(req)) {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Console-Token, Authorization, X-Api-Key');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      }
    } else {
      warn(`拒绝来自非本机来源的控制台请求：${req.method} ${pathname} origin=${req.headers.origin || '-'} host=${req.headers.host || '-'}`);
      return sendError(res, 403, '控制台仅允许本机访问', 'console_forbidden');
    }
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  } else {
    // 对话接口需要跨域（浏览器内的客户端），保持原有宽松策略
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ---- 限流 ----
  // 位置：OPTIONS 之后（预检不计入）、鉴权与路由之前（未授权洪泛也能被廉价拒掉）。
  // 两级：全局一档；/console/api/probe 另有一档更严的阈值。
  if (全局限流) {
    const ip = 来源标识(req);
    const 全局结果 = 全局限流.hit(ip);
    const 是重端点 = pathname.startsWith('/console/api/probe');
    const 重端点结果 = 是重端点 && 探测限流 ? 探测限流.hit(ip) : null;
    if (全局结果.limited || 重端点结果?.limited) {
      const 等待毫秒 = Math.max(全局结果.retryAfterMs || 0, 重端点结果?.retryAfterMs || 0);
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(等待毫秒 / 1000))));
      warn(
        `请求过于频繁已限流：${req.method} ${pathname} ip=${ip}`
        + `${重端点结果?.limited ? '（重端点额度用尽）' : ''}`,
      );
      return sendError(res, 429, '请求过于频繁，请稍后再试', 'rate_limited');
    }
  }

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort(new Error('client closed'));
  });

  try {
    // 无需鉴权：健康检查
    if (pathname === '/health' || pathname === '/healthz') {
      const sites = siteState(cfg);
      return sendJson(res, 200, {
        status: sites.some((s) => s.logged_in) ? 'ok' : 'not_logged_in',
        service: 'workbuddy-proxy',
        sites,
        logged_in: sites.some((s) => s.logged_in),
      });
    }

    // 控制台页面（本机可达；页面内注入会话 token，不含 apiKey）。
    // T23：开启 consolePin 时先回锁屏页，PIN 校验通过（/console/api/unlock）才发真页面。
    if ((pathname === '/console' || pathname === '/console/') && req.method === 'GET') {
      if (consoleLocked()) {
        // 已带有效凭证（解锁过/脚本带 apiKey）的请求直接给真页面，避免刷新又锁一次
        if (consoleAuthorized(req)) {
          // fallthrough 到下面的真页面逻辑
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(consoleLockPage());
        }
      }
      const file = path.join(CONSOLE_DIR, 'index.html');
      if (!fs.existsSync(file)) return sendError(res, 500, '控制台文件缺失：console/index.html');
      let html = fs.readFileSync(file, 'utf8');
      html = html.replace('<head>', `<head>\n<script>window.__WB_TOKEN__=${JSON.stringify(CONSOLE_TOKEN)};</script>`);
      // B1：随真页面下发会话 cookie。这是 EventSource 唯一可用的鉴权通道——
      // EventSource 不支持自定义请求头，而 consoleAuthorized 认的 cookie 只在 PIN
      // 解锁时种，PIN 默认关闭 → 浏览器里的 SSE 永远 401，T29 推送从未真正生效。
      // 安全性没有新增暴露面：cookie 值就是同一枚 CONSOLE_TOKEN，而它本来就
      // 明文内联在刚下发的这份 HTML 里给前端用；HttpOnly + SameSite=Strict 让
      // 脚本读不到、跨站请求不带，与 X-Console-Token 头同级。
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `wbConsoleToken=${CONSOLE_TOKEN}; Path=/; SameSite=Strict; HttpOnly`,
      });
      return res.end(html);
    }

    // 控制台静态资源（/console/xxx → console/xxx；仅限 console 目录内的真实文件，
    // resolve + 前缀校验防目录穿越）。二维码库等资源从这里出。
    if (req.method === 'GET' && pathname.startsWith('/console/') && !pathname.startsWith('/console/api/')) {
      const rel = decodeURIComponent(pathname.slice('/console/'.length));
      const file = path.resolve(CONSOLE_DIR, rel);
      if ((file === path.resolve(CONSOLE_DIR) || file.startsWith(path.resolve(CONSOLE_DIR) + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(file));
      }
      return sendError(res, 404, '控制台资源不存在');
    }

    // T23：控制台 PIN 解锁。放在 /console/api/* 统一鉴权之前——锁屏状态下的浏览器
    // 还没有 token，正是要靠这个接口换 token。校验失败延迟 1 秒（拖垮爆破脚本）。
    if (pathname === '/console/api/unlock' && req.method === 'POST') {
      if (!consoleOriginAllowed(req)) return sendError(res, 403, '控制台仅允许本机访问', 'console_forbidden');
      if (!consoleLocked()) return sendJson(res, 200, { ok: true, token: CONSOLE_TOKEN, note: '未设置 PIN，无需解锁' });
      // 简单爆破防护：每个进程最多受理 20 次失败尝试，超出后一律拒绝（重启服务才能重置）
      if (pinAttempts.count >= 20) {
        warn(`控制台 PIN 已连续失败 ${pinAttempts.count} 次，拒绝继续尝试（重启服务重置）`);
        return sendJson(res, 429, { ok: false, error: '失败次数过多，请重启服务后再试' });
      }
      const body = await readJsonBody(req);
      const given = String(body?.pin || '').trim();
      if (given !== consolePinValue()) {
        pinAttempts.count++;
        pinAttempts.lastAt = Date.now();
        warn(`控制台 PIN 校验失败（第 ${pinAttempts.count} 次）`);
        await new Promise((r) => setTimeout(r, 1000));
        return sendJson(res, 401, { ok: false, error: 'PIN 不正确' });
      }
      pinAttempts.count = 0;
      log('控制台 PIN 校验通过，已发放会话 token');
      // 会话 cookie：值即控制台 token，两个作用——① 刷新 /console 时识别「已解锁」不再弹锁屏；
      // ② 浏览器后续的 /console/api 请求经 consoleAuthorized 直接通过（省得前端再存一份）。
      // HttpOnly + SameSite=Strict：脚本读不到、跨站请求不会携带，安全性与 token 头同级。
      return sendJsonWith(res, 200, { ok: true, token: CONSOLE_TOKEN }, {
        'Set-Cookie': `wbConsoleToken=${CONSOLE_TOKEN}; Path=/; SameSite=Strict; HttpOnly`,
      });
    }

    // 控制台 API（用会话 token 或 apiKey 鉴权）
    if (pathname.startsWith('/console/api/')) {
      if (!consoleAuthorized(req)) {
        warn(`控制台接口鉴权失败：${req.method} ${pathname}`);
        return sendError(res, 401, '控制台会话失效：请刷新页面重开 /console', 'invalid_console_token');
      }
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      return await handleConsoleApi({ cfg, req, res, url, body });
    }

    // 只读「发现类」接口：放行免鉴权。
    // 原因：不少客户端（如 CCSM / Codex 配置向导）会裸探基础地址与模型目录来做「同步模型」，
    // 不带 Authorization。这里只返回模型名与服务信息，不含任何密钥 / token，
    // 且服务只监听本机，因此免鉴权是安全的。
    if (req.method === 'GET' && pathname.endsWith('/models')) {
      res.setHeader('X-Service', 'workbuddy-proxy');
      return await handleModels({ cfg, req, res });
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/v1' || pathname === '/v1/')) {
      res.setHeader('X-Service', 'workbuddy-proxy');
      if (pathname !== '/') {
        // 基础地址被当成模型目录请求时，直接给一份 OpenAI 风格的模型列表
        return await handleModels({ cfg, req, res });
      }
      return sendJson(res, 200, {
        service: 'workbuddy-proxy',
        console: `http://${cfg.host}:${cfg.port}/console`,
        endpoints: ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/messages/count_tokens', '/status', '/health', '/console'],
        sites: siteKeys(cfg),
        default_site: cfg.defaultSite,
        default_model: cfg.defaultModel,
        config: paths.config,
      });
    }

    if (!authorized(req)) {
      warn(`未授权的请求被拒绝：${req.method} ${pathname} key=${clientKey(req).slice(0, 6)}…`);
      return sendError(res, 401, 'API Key 不正确：请在请求头携带 Authorization: Bearer <config.json 里的 apiKey>', 'invalid_api_key');
    }

    // 各站点登录态 + 剩余积分（国际版计费口径不同，查询失败只返回错误信息）
    if (pathname === '/status') {
      const only = url.searchParams.get('site');
      const keys = siteKeys(cfg).filter((s) => !only || s === only);
      const out = [];
      for (const site of keys) {
        const a = getAuth(site);
        let credit = null;
        // 没有配置 billingBase 的站点不走计费接口，
        // 这里直接跳过，避免把「不适用」误报成查询失败。
        const creditSupported = supportsCreditQuery(cfg, site);
        if (isLoggedIn(site) && creditSupported) {
          try {
            credit = await queryCredit(cfg, site);
          } catch (e) {
            credit = { error: e.message };
          }
        }
        out.push({
          site,
          label: cfg.sites[site].label,
          apiBase: cfg.sites[site].apiBase,
          logged_in: isLoggedIn(site),
          uid: a.uid ? String(a.uid).slice(0, 8) + '…' : null,
          nickname: a.nickname || null,
          domain: a.domain || null,
          token_expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
          credit,
          credit_supported: creditSupported,
        });
      }
      return sendJson(res, 200, { sites: out, default_site: cfg.defaultSite });
    }

    // ---- workbuddy-bridge 管理面（MCP 工具 / 斜杠命令共用；需要本地 API Key）----
    if (pathname === '/admin/bridge' && req.method === 'GET') {
      return sendJson(res, 200, bridgeStatus(cfg));
    }
    if (pathname === '/admin/policy' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = setPolicy(cfg, body);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (pathname === '/admin/credit/refresh' && req.method === 'POST') {
      const results = await refreshCreditsAll(cfg);
      return sendJson(res, 200, { ok: true, results });
    }
    if (pathname === '/admin/tasks' && req.method === 'GET') {
      return sendJson(res, 200, taskStatus());
    }
    if (pathname === '/admin/tasks/run' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const kind = ['checkin', 'growth', 'all'].includes(body.kind) ? body.kind : 'all';
      const site = body.site ? String(body.site) : null;
      const results = await runTasks(cfg, kind, site);
      return sendJson(res, 200, { ok: true, kind, results });
    }
    if (pathname === '/admin/local/import' && req.method === 'POST') {
      const result = await importLocalAccounts(cfg);
      return sendJson(res, 200, { ok: true, ...result });
    }

    // 手动同步模型池进 ZCode 选择器（控制台「手动同步」按钮用）。
    // 自动循环已降到 30 分钟一次，上游加了模型/改了倍率时点这里立即生效。
    if (pathname === '/admin/pool/sync' && req.method === 'POST') {
      const r = await triggerProviderConfigSyncNow();
      const ok = r.result === 'written' || r.result === 'unchanged';
      return sendJson(res, ok ? 200 : 409, { ok, ...r });
    }

    // 优雅停止（供 stop.cmd / stop.mjs 调用；需要本地 API Key，避免被误触）。
    // 不可断线保护：本服务的模型流量承载着 ZCode 会话自身的模型连接，
    // 会话请求进行中停服 = 会话断线。因此有活跃请求时默认拒绝，明确 force=1 才放行。
    if (pathname === '/admin/shutdown' && req.method === 'POST') {
      const url2 = new URL(req.url, 'http://x');
      const force = url2.searchParams.get('force') === '1';
      // B2：与控制台的 /service/stop 共用 doStop，保证「停服」只有一条实现——
      // 完整刷盘 + 活跃请求保护，不会再有某条路径裸 process.exit 掐断会话流量。
      try {
        const r = doStop({ force });
        sendJson(res, 200, {
          ok: true,
          message: r.waiting ? `等 ${r.active} 个请求完成后退出` : '正在保存数据并停止服务',
        });
      } catch (e) {
        sendJson(res, e.status || 500, {
          ok: false,
          error: e.status === 409 ? 'busy' : 'shutdown failed',
          message: e.status === 409
            ? `${e.activeRequests} 个请求进行中，拒绝停服。强制请加 ?force=1，或改用 POST /admin/restart（等空闲后交棒重启，不断线）`
            : String(e.message || e),
          activeRequests: e.activeRequests || 0,
        });
      }
      return;
    }

    // 交棒重启：先拉起新实例（端口被占时它自动重试绑定），本实例等活跃请求全部
    // 完成后退出交出端口。整个过程模型连接不断——进行中的请求照常跑完，
    // 新请求由接管端口的新实例服务。会话内调用安全，这是 /admin/shutdown 的替代品。
    if (pathname === '/admin/restart' && req.method === 'POST') {
      try {
        const r = doRestart();
        sendJson(res, 200, { ok: true, message: r.waiting ? `新实例已拉起，本实例等 ${r.active} 个请求完成后交棒` : '新实例即将接管端口' });
      } catch (e) {
        sendJson(res, e.status || 500, { ok: false, error: e.message || 'restart failed' });
      }
      return;
    }

    // 路径容错：不同客户端拼接方式不同（如 TraeWork 会拼成 /v1/messages/chat/completions），
    // 这里按「路径中是否包含某段完整路径段」来判断，只要语义明确就命中对应处理器。
    //
    // 注意：用路径段（按 '/' 切分）匹配而不是裸 includes 子串，避免
    //   - 任意含 "messages" 子串的路径（如 /v1/mymessagesfoo）被误判
    //   - 仅后缀相似的路径（如 /v1/models2）被误判
    // 同时必须保留 TraeWork 那种「/v1/messages/chat/completions」的拼接容错，
    // 因此判定顺序为：responses → count_tokens → chat → messages（后者最宽，放最后）。
    //
    // 注：GET /v1/models 已在上面「免鉴权发现类接口」处提前处理，此处不再重复判断。
    const segs = pathname.split('/').filter(Boolean);
    const hasSeg = (...want) => {
      // 在 segments 里找连续匹配 want 的位置
      for (let i = 0; i + want.length <= segs.length; i++) {
        let ok = true;
        for (let j = 0; j < want.length; j++) {
          if (segs[i + j] !== want[j]) { ok = false; break; }
        }
        if (ok) return true;
      }
      return false;
    };
    const isCountTokens =
      req.method === 'POST' && (hasSeg('count_tokens') || hasSeg('count-tokens'));
    const isChat = req.method === 'POST' && hasSeg('chat', 'completions');
    const isMessages = req.method === 'POST' && hasSeg('messages');
    // Responses 协议（Codex 专用）：新增分支，不影响上面几条既有判断
    const isResponses = req.method === 'POST' && hasSeg('responses');

    if (isChat || isMessages) log(`→ ${req.method} ${pathname}${clientKey(req) ? '' : '（无 Key）'}`);

    if (isResponses) {
      const body = await readJsonBody(req);
      const out = await handleResponses({ cfg, req, res, body, signal: ac.signal, pathname });
      scheduleCreditRefreshSoon(cfg); // 对话结束后尽快让控制台余额跟上真实消耗
      return out;
    }

    if (isCountTokens) {
      const body = await readJsonBody(req);
      return handleCountTokens({ cfg, req, res, body });
    }

    if (isChat) {
      const body = await readJsonBody(req);
      const out = await handleChatCompletions({ cfg, req, res, body, signal: ac.signal, pathname });
      scheduleCreditRefreshSoon(cfg);
      return out;
    }

    if (isMessages) {
      const body = await readJsonBody(req);
      const out = await handleMessages({ cfg, req, res, body, signal: ac.signal, pathname });
      scheduleCreditRefreshSoon(cfg);
      return out;
    }

    warn(`收到未知路径请求：${req.method} ${pathname}（可选路径见 GET /）`);
    return sendError(
      res,
      404,
      `未知路径 ${req.method} ${pathname}。可用：/v1/chat/completions（OpenAI 格式）、/v1/responses（Codex 格式）、/v1/messages（Anthropic 格式）、/v1/models`,
      'not_found',
    );
  } catch (e) {
    const status = e.status || 500;
    if (ac.signal.aborted) {
      // 客户端已经断开，上游请求是被我们主动中止的 ——
      // 上面 res.on('close') 里 abort 的原因就是「client closed」，
      // 所以报错尾部的 client closed 不是上游的问题，是"没人等了"。
      //
      // 这既不是服务故障，也没人在等结果。之前按 status>=500 记成
      // ERROR「处理失败」，会把人引向错误方向（看起来像程序坏了）。
      // 客户端超时/取消时这条很常见，降级为 WARN 并写清真实原因。
      warn(`${req.method} ${pathname} 客户端已断开，上游请求已中止（不是服务故障）`);
    } else if (status >= 500) {
      error(`${req.method} ${pathname} 处理失败：`, e.stack || e.message);
    }
    // 响应已断开就别再写了（对端已销毁，写入没有意义）
    if (!res.headersSent && !res.writableEnded && !res.destroyed) sendError(res, status, e.message || 'internal error');
    else if (!res.writableEnded && !res.destroyed) res.end();
  } finally {
    if (pathname !== '/health') {
      // 记录非健康检查请求的耗时（流式请求由各自 handler 记录明细）
      void started;
    }
  }
});

server.keepAliveTimeout = 120000;
server.requestTimeout = 0; // 流式长连接不设总时长上限

/** 把配置校验问题打出来（启动成功与否都要能看到）。 */
function reportConfigIssues() {
  if (!configIssues.length) return;
  warn(`config.json 有 ${configIssues.length} 处问题已自动回退（原值可能被忽略）：`);
  for (const msg of configIssues) warn(`  · ${msg}`);
}

// 端口被占用等情况要给出可操作的提示，而不是抛一串裸栈
// ⚠️ 2026-10-03 16:49 断线事故：本段曾有两个 bug 叠加，交棒重启后端口空置 73 分钟——
//   (1) 重试 interval 被 unref()，绑定成功前它是进程唯一的存活持有者，Node 静默退出；
//   (2) 重试期间后续 bind 失败会再次触发 error 事件、落进下面的通用分支 process.exit(1)。
// 修复：unref 去掉（绑定成功才允许进程安眠）；hookRetryStarted 之后的 error 一律吞掉继续重试。
let hookRetryStarted = false;
server.on('error', (e) => {
  // 拉起模式（hook 拉起 / 交棒新实例）：上个实例退出时 socket 可能仍在 TIME_WAIT，
  // 立刻 bind 会 EADDRINUSE —— 自动重试绑定，而不是静默退出导致「hook 跑了服务却没起来」。
  if (e.code === 'EADDRINUSE' && process.env.WB_HOOK_SPAWN === '1') {
    if (hookRetryStarted) return; // 已在重试循环里：吞掉后续 bind 失败，别掉进通用分支自杀
    hookRetryStarted = true;
    let retries = 0;
    warn(`端口 ${cfg.port} 暂被占用（等上个实例退出），每 0.5 秒重试绑定…`);
    // 监听成功即清掉本 interval：留着下一跳会对已监听的 server 重复 listen() 抛
    // ERR_SERVER_ALREADY_LISTEN，把刚接管的进程崩掉。也不 unref：绑定成功前它是
    // 本进程唯一的存活持有者（2026-10-03 16:49 断线事故：unref 后 Node 静默退出）。
    let retry = null;
    const stopRetry = () => { if (retry) clearInterval(retry); };
    server.once('listening', stopRetry);
    server.once('close', stopRetry);
    retry = setInterval(() => {
      retries++;
      if (retries > 60) {
        clearInterval(retry);
        error(`端口重试 60 次（30 秒）仍被占用，放弃`);
        process.exit(1);
      }
      server.listen(cfg.port, cfg.host);
    }, 500);
    return;
  }
  error(`服务启动失败：${e.code || e.message}`);
  if (e.code === 'EADDRINUSE') {
    error(`  端口 ${cfg.port} 已被占用。可能已经有一个实例在运行：`);
    error('    · 查看状态：node status.mjs');
    error('    · 停止旧实例：node stop.mjs   或双击 stop.cmd');
    error(`    · 或改 config.json 里的 port 换一个端口`);
  } else if (e.code === 'EACCES') {
    error(`  没有权限监听 ${cfg.host}:${cfg.port}（1024 以下端口通常需要管理员权限）`);
  }
  reportConfigIssues();
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  log('WorkBuddy 反代已启动（国内版 + 国际版多站点）');
  log(`  控制台：http://${cfg.host}:${cfg.port}/console   ← 建议用桌面快捷方式打开`);
  log(`  监听地址：http://${cfg.host}:${cfg.port}   （仅本机可达）`);
  const keys = authKeys(cfg);
  if (!keys.length) {
    warn('  config.json 未配置 apiKey，服务当前不做鉴权（任何本机程序均可调用）。建议补一个随机密钥。');
  } else {
    // 不打印完整密钥，避免被日志文件/控制台历史泄露
    const first = primaryKey(cfg);
    const extra = keys.length > 1 ? `（另有 ${keys.length - 1} 个密钥同样有效）` : '';
    log(`  API Key：${first.slice(0, 6)}…${first.slice(-4)}${extra}（完整值见 config.json）`);
  }
  log(`  默认站点/模型：${cfg.defaultSite} / ${cfg.defaultModel}    配置文件：${paths.config}`);
  reportConfigIssues();
  for (const s of siteState(cfg)) {
    log(`  站点 ${s.site.padEnd(9)} ${s.logged_in ? `已登录 uid=${s.uid}` : '未登录'}   ${s.apiBase}`);
  }
  log('  未登录的站点可在控制台「账号登录」里点一下，或运行：node login.mjs --site <站点名>');
  log(`  OpenAI 客户端：Base URL = http://${cfg.host}:${cfg.port}/v1`);
  // workbuddy-bridge 后台循环：积分/到期明细刷新 + 自动签到/成长任务 + 模型池自动同步 + 定时模型巡检
  recordEvent('system', `服务启动（监听 ${cfg.host}:${cfg.port}，PID ${process.pid}）`);
  flushEvents();
  startCreditLoop(cfg);
  startTaskLoop(cfg);
  startHealthLoop(cfg);
  startProviderConfigSync(cfg, (e) => warn('模型池自动同步失败：', e.message));
  // 生命周期依赖注入：交棒重启（/admin/restart、/console/api/service/restart 共用）
  // 需要活跃计数与各循环的 stop/flush 函数；onClose 走 server.close → 进程退出。
  bootLifecycle({
    activeRequestsRef: () => activeRequests,
    stoppers: [stopCreditLoop, stopTaskLoop, stopHealthLoop, stopProviderConfigSync],
    flushers: [flushUsage, flushPool, flushLearned, flushEvents],
  });
  setRestartHandler(doRestart);
  // B2：停止服务也走注册表，控制台的「停止」与 /admin/shutdown 落到同一条 gracefulExit 路径
  setStopHandler(doStop);
  // 自动导入本机已登录客户端的账号（静默；客户端续期 token 后重启服务即自动跟进）
  importLocalAccounts(cfg, { silent: true }).catch((e) => warn('本机账号自动导入失败：', e.message));
});

process.on('SIGINT', () => {
  // 与 /admin/restart 同一条优雅退出路径：活跃请求没跑完就等（不主动断模型流量），
  // 全部跑完（或 close 超时兜底）才退出。
  gracefulExit({
    waitIdle: true,
    reason: '收到退出信号',
    onClose: () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref?.();
    },
  });
});
process.on('unhandledRejection', (e) => error('未处理的 Promise 异常：', e));
