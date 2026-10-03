// 任务中心列表缓存测试（0.3.22）：每日三次预取 + 手动刷新的服务端语义。
//
// 背景：列表原先被控制台 30s 轮询 + SSE 推送两条路实时拉上游（每次都整页重建，
// 用户侧表现为页面一直闪），现在只在 listTimes 预取 / TTL 过期按需拉 / force 手动刷
// 三处真正请求上游。本文件只测缓存语义（fetcher 注入，零网络）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 测试隔离：先指到临时目录再 import（config.mjs 在模块加载时读 WB_CONFIG_DIR）
process.env.WB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tc-test-'));

const { taskCenterView } = await import('../src/tasks.mjs');

let calls = 0;
const fetcher = async () => {
  calls++;
  return [{ code: 'chat_5', title: '聊天 5 次', current: calls, target: 5, autoplayable: true }];
};
const cfg = { tasks: { listTimes: ['09:00', '15:00', '21:00'] } };

test('taskCenterView：TTL 内直接回缓存，force 强制重拉', async () => {
  const a = await taskCenterView(cfg, 'cn-cli', 'acc_t1', { fetcher });
  assert.equal(a.fromCache, false);
  assert.equal(calls, 1);
  const b = await taskCenterView(cfg, 'cn-cli', 'acc_t1', { fetcher });
  assert.equal(b.fromCache, true);
  assert.equal(b.cachedAt, a.cachedAt, 'TTL 内必须原样返回同一份快照（不打上游）');
  assert.equal(b.tasks[0].current, 1, '缓存里的数据不被后续 fetch 改写');
  const c = await taskCenterView(cfg, 'cn-cli', 'acc_t1', { force: true, fetcher });
  assert.equal(c.fromCache, false);
  assert.ok(c.cachedAt >= a.cachedAt);
  assert.equal(c.tasks[0].current, 2, 'force 后拿到的是新数据');
});

test('taskCenterView：缓存按 site|accountId 隔离', async () => {
  const before = calls;
  const x = await taskCenterView(cfg, 'cn-cli', 'acc_t2', { fetcher });
  assert.equal(calls, before + 1, '另一账号首次查看要真实拉取');
  const y = await taskCenterView(cfg, 'intl-cli', 'acc_t2', { fetcher });
  assert.equal(y.fromCache, false, '同 id 不同站点也算不同键');
  const z = await taskCenterView(cfg, 'cn-cli', 'acc_t2', { fetcher });
  assert.equal(z.fromCache, true);
  assert.equal(z.cachedAt, x.cachedAt);
});

test('validateConfig：listTimes 非法回退默认、合法补零（与 checkinTimes 同规则）', async () => {
  const { validateConfig } = await import('../src/config.mjs');
  const bad = { tasks: { listTimes: ['9:0', '25:00', 'abc'] } };
  validateConfig(bad);
  assert.deepEqual(bad.tasks.listTimes, ['09:00', '15:00', '21:00'], '非法时点整体回退默认三次');
  const good = { tasks: { listTimes: ['9:00', '21:30'] } };
  validateConfig(good);
  assert.deepEqual(good.tasks.listTimes, ['09:00', '21:30']);
  const none = {};
  validateConfig(none);
  assert.deepEqual(none.tasks.listTimes, ['09:00', '15:00', '21:00'], '缺省补默认');
});
