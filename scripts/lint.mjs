#!/usr/bin/env node
// 零依赖语法检查：对插件内所有 .js / .mjs 跑 `node --check`。
//
// 为什么不用 ESLint：本项目坚持「装插件不需要 npm install」。语法错误是
// 最便宜也最致命的一类（一个漏括号能让 MCP 整个起不来），内置检查足够兜住。
// 前端 app.js / shell.js 也在这里，避免只有后端被测试覆盖、前端写错才在浏览器里发现。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
  path.join(ROOT, 'workbuddy-bridge', 'server'),
  path.join(ROOT, 'workbuddy-bridge', 'mcp'),
  path.join(ROOT, 'workbuddy-bridge', 'hooks'),
  path.join(ROOT, 'scripts'),
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin']);
// 第三方压缩库不检查（不是我们的代码，报错也无意义）
const SKIP_FILES = new Set(['qrcode.min.js']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name) && !SKIP_FILES.has(entry.name)) out.push(full);
  }
  return out;
}

const files = TARGETS.flatMap((d) => walk(d));
const failed = [];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed.push({ file: path.relative(ROOT, file), err: (r.stderr || r.stdout || '').trim().split('\n').slice(0, 4).join('\n') });
  }
}

if (failed.length) {
  console.error(`✗ 语法检查失败（${failed.length}/${files.length}）：`);
  for (const f of failed) console.error(`\n  ${f.file}\n  ${f.err.replace(/\n/g, '\n  ')}`);
  process.exit(1);
}
console.log(`✓ 语法检查通过（${files.length} 个文件）`);