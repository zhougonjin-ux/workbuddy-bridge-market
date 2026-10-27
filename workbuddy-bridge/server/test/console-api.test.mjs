// 控制台 API 的结构守卫：console-api.mjs 是一个 2000 行级的单函数分发器，
// 新增端点时最容易犯的错是「同一 path+method 写了两个分支」——先命中的赢，
// 后一个永远不执行，表现为「点了没反应但也没报错」。
//
// 这里不重构（大拆分需要 e2e 保护），只加一道零成本的一致性检查：
//   1. 不出现重复的路由键
//   2. 端点数不低于一个下限（防止误删整段）
//   3. 每个分支都能找到对应的 sendJson/sendError 返回（防止「忘了回包」导致请求挂起）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(here, '..', 'src', 'console-api.mjs');
const src = fs.readFileSync(SRC_PATH, 'utf8');

/** 提取 `if (p === '/x' && method === 'GET')` 形式的路由键。 */
function extractRoutes(code) {
  const out = [];
  const re = /p === '([^']+)'(?:\s*&&\s*method === '([A-Z]+)')?/g;
  for (const m of code.matchAll(re)) {
    out.push({ path: m[1], method: m[2] || 'ANY', index: m.index });
  }
  return out;
}

test('console-api：不存在重复的 path+method 分支', () => {
  const routes = extractRoutes(src);
  const seen = new Map();
  const dup = [];
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) dup.push(key);
    else seen.set(key, r.index);
  }
  assert.deepEqual(dup, [], `重复路由（后写的分支永远不会执行）：${dup.join(', ')}`);
});

test('console-api：端点数不低于下限（防误删整段）', () => {
  const routes = extractRoutes(src);
  assert.ok(routes.length >= 40, `只解析到 ${routes.length} 个端点，疑似分发器被截断`);
});

test('console-api：每个路由分支内都有返回（sendJson/sendError/return）', () => {
  // 粗略检查：从分支起点到下一个分支起点之间，必须出现一次 sendJson / sendError /
  // res.end / return。只防「忘了回包」，不校验返回内容。
  const routes = extractRoutes(src).sort((a, b) => a.index - b.index);
  const missing = [];
  for (let i = 0; i < routes.length; i++) {
    const from = routes[i].index;
    const to = i + 1 < routes.length ? routes[i + 1].index : src.length;
    const block = src.slice(from, to);
    if (!/sendJson|sendError|res\.end|return /.test(block)) {
      missing.push(`${routes[i].method} ${routes[i].path}`);
    }
  }
  assert.deepEqual(missing, [], `这些分支没有回包：${missing.join(', ')}`);
});