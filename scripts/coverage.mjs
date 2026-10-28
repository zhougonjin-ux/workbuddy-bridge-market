// 覆盖率门禁（0.4.0）：在原有覆盖率报告上加最低阈值，CI 里低于阈值直接失败。
// 阈值刻意留了余量（当前行覆盖约 55%、分支约 71%），目的是拦住「大幅删测试」这类退化，
// 而不是逼着每个小改动都补测试。
// 临时跳过：WB_MIN_LINES=0 WB_MIN_BRANCHES=0 node scripts/coverage.mjs
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
  console.error('no test/*.test.mjs found');
  process.exit(1);
}

const MIN_LINES = Number(process.env.WB_MIN_LINES ?? 45);
const MIN_BRANCHES = Number(process.env.WB_MIN_BRANCHES ?? 60);

const args = [
  '--test',
  '--experimental-test-coverage',
  '--test-reporter=spec',
  ...files,
];
if (Number.isFinite(MIN_LINES) && MIN_LINES > 0) args.splice(2, 0, `--test-coverage-lines=${MIN_LINES}`);
if (Number.isFinite(MIN_BRANCHES) && MIN_BRANCHES > 0) args.splice(2, 0, `--test-coverage-branches=${MIN_BRANCHES}`);

console.log(`coverage gate: lines>=${MIN_LINES}% branches>=${MIN_BRANCHES}% (${files.length} test files)`);
const r = spawnSync(process.execPath, args, { cwd: SERVER, stdio: 'inherit' });
process.exit(r.status ?? 1);