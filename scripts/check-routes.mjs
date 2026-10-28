// 前后端路由一致性检查（0.4.0）：
//   服务端定义的路由 = console-api.mjs 里 `p === '/xxx'` + server.mjs 里的固定路径；
//   调用方 = 控制台前端（console/*.js）与桌面客户端（client/*.cs）。
// 任何调用方用到、服务端却没实现的 /console/api/* 路径都会在这里被抓出来——
// 这类拼写漂移在运行时表现为「404 但页面只是静默失败」，很难靠人工回归发现。
//
// 用法：node scripts/check-routes.mjs [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'workbuddy-bridge', 'server');
const VERBOSE = process.argv.includes('--verbose');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

// ---- 1) 服务端路由集合 ----
const apiSrc = read(path.join(SERVER, 'src', 'console-api.mjs'));
const defined = new Set();
for (const m of apiSrc.matchAll(/p === '([^']+)'/g)) defined.add(m[1]);
// 动态前缀（如 /account/xxx）以集合形式登记；这里没有，保持简单

// ---- 2) 调用方：前端 + 客户端 ----
const callers = [];
const consoleDir = path.join(SERVER, 'console');
for (const f of fs.readdirSync(consoleDir)) {
  if (!f.endsWith('.js')) continue;
  callers.push({ file: path.join('workbuddy-bridge', 'server', 'console', f), text: read(path.join(consoleDir, f)) });
}
const clientDir = path.join(ROOT, 'workbuddy-bridge', 'client');
for (const f of fs.readdirSync(clientDir)) {
  if (!f.endsWith('.cs')) continue;
  callers.push({ file: path.join('workbuddy-bridge', 'client', f), text: read(path.join(clientDir, f)) });
}

const missing = new Map(); // path -> Set(file)
for (const c of callers) {
  const re = /\/console\/api\/([a-zA-Z0-9_\-/]+)/g;
  for (const m of c.text.matchAll(re)) {
    const route = '/' + m[1].replace(/\/+$/, '');
    // 允许前缀参数（如 /account/export?site=）已在上面的字符集里截断
    if (defined.has(route)) continue;
    // 有些调用是拼出来的（'/console/api/usage' + '/filter'），前缀命中即放过
    const asPrefix = [...defined].some((d) => d.startsWith(route));
    if (asPrefix) continue;
    if (!missing.has(route)) missing.set(route, new Set());
    missing.get(route).add(c.file);
  }
}

if (VERBOSE) {
  console.log(`SERVER ROUTES ${defined.size}:${[...defined].sort().join(' ')}`);
}

if (missing.size) {
  console.log(`FAIL: ${missing.size} route(s) used by callers but not defined:`);
  for (const [route, files] of missing) {
    console.log(`  ${route}  ←  ${[...files].join(', ')}`);
  }
  process.exit(1);
}
console.log(`OK: routes consistent (server ${defined.size}, no unknown caller paths)`);