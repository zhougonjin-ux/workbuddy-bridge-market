#!/usr/bin/env node
// 覆盖率运行器：自动发现 server/test/*.test.mjs，显式排除 *.smoke.mjs。
//
// 为什么不直接 `node --test test/`：目录模式会把 pick.smoke / admin.smoke 一起跑，
// 而 smoke 会起服务、写临时目录，甚至（隔离失效时）碰真实账号池。README 已警告
// 过这件事，这里用文件白名单把它固化成脚本，避免下一个人再踩。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'workbuddy-bridge', 'server');
const TEST_DIR = path.join(SERVER, 'test');

const files = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join('test', f));

if (!files.length) {
  console.error('✗ 没有找到 test/*.test.mjs');
  process.exit(1);
}

const r = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  '--test-reporter=spec',
  ...files,
], { cwd: SERVER, stdio: 'inherit' });

process.exit(r.status ?? 1);