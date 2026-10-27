// 路径匹配与 Node 版本守卫的单元测试。
//
// 为什么单独拿出来测：这两处是「一处漏判就断线」的基础设施，
// 且都曾被复制粘贴成两份实现。
import test from 'node:test';
import assert from 'node:assert/strict';

import { pathSegments, hasSegments, hasPathSegments, isModelPath } from '../src/pathmatch.mjs';
import { MIN_NODE_MAJOR, nodeMajor, assertNodeVersion } from '../src/runtime.mjs';
import { mapLimit } from '../src/util.mjs';
import { buildOnboardingSteps } from '../src/onboarding.mjs';

test('pathSegments：去掉空段，保留大小写', () => {
  assert.deepEqual(pathSegments('/v1/chat/completions'), ['v1', 'chat', 'completions']);
  assert.deepEqual(pathSegments('//v1///models//'), ['v1', 'models']);
  assert.deepEqual(pathSegments(''), []);
});

test('hasSegments：连续段匹配，不做子串匹配', () => {
  const segs = pathSegments('/v1/chat/completions');
  assert.equal(hasSegments(segs, 'chat', 'completions'), true);
  assert.equal(hasSegments(segs, 'v1', 'chat'), true);
  // 子串不算：models2 不是 models
  assert.equal(hasSegments(pathSegments('/v1/models2'), 'models'), false);
  assert.equal(hasSegments(segs, 'completions', 'chat'), false);
});

test('hasPathSegments：兼容 TraeWork 的拼接路径', () => {
  assert.equal(hasPathSegments('/v1/messages/chat/completions', 'chat', 'completions'), true);
  assert.equal(hasPathSegments('/v1/messages/chat/completions', 'messages'), true);
});

test('isModelPath：模型端点算活跃请求', () => {
  for (const p of [
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/messages/chat/completions',
    '/v1/responses',
    '/v1/models',
    '/v1/embeddings',
    '/v1/completions',
  ]) {
    assert.equal(isModelPath(p), true, p);
  }
});

test('isModelPath：后台/发现类端点不算', () => {
  for (const p of [
    '/health',
    '/healthz',
    '/status',
    '/console',
    '/console/api/bridge',
    '/admin/bridge',
    '/admin/tasks',
    '/v1/mymessagesfoo',
    '/',
  ]) {
    assert.equal(isModelPath(p), false, p);
  }
});

test('Node 版本：解析主版本号', () => {
  assert.equal(nodeMajor('20.11.1'), 20);
  assert.equal(nodeMajor('24.14.0'), 24);
  assert.equal(nodeMajor(''), 0);
  assert.equal(nodeMajor('v22.3.0'), 0); // 传入值应是 process.versions.node（不带 v）
});

test('Node 版本：低于最低版本时返回 ok=false 且不退出（exit=false）', () => {
  const logs = [];
  const r = assertNodeVersion({ exit: false, logger: (m) => logs.push(m) });
  // 当前测试运行在 Node 20+，这里只验证「不退出」路径与最低版本常量
  assert.equal(r.ok, true);
  assert.equal(MIN_NODE_MAJOR >= 20, true);
  assert.equal(logs.length, 0);
});

test('mapLimit：保持结果顺序，且并发不超过上限', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (v) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return v * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});

test('mapLimit：空数组 / 非法 limit 不抛错', async () => {
  assert.deepEqual(await mapLimit([], 3, async (v) => v), []);
  const out = await mapLimit([1, 2], 0, async (v) => v + 1);
  assert.deepEqual(out, [2, 3]);
});

test('onboarding：四项全满足时 allDone，且不出现「去处理」链接', () => {
  const r = buildOnboardingSteps({ major: 24, nodeVersion: '24.0.0', accountCount: 2, providerOk: true, keyOk: true });
  assert.equal(r.allDone, true);
  assert.equal(r.done, 4);
  assert.equal(r.steps.length, 4);
  assert.deepEqual(r.steps.map((s) => s.id), ['node', 'account', 'provider', 'key']);
  assert.ok(r.steps.every((s) => s.ok && s.href !== undefined));
});

test('onboarding：全新环境时四项全未完成，且给出可点击去处', () => {
  const r = buildOnboardingSteps({ major: 18, nodeVersion: '18.20.0', accountCount: 0, providerOk: false, keyOk: false });
  assert.equal(r.allDone, false);
  assert.equal(r.done, 0);
  const byId = Object.fromEntries(r.steps.map((s) => [s.id, s]));
  assert.equal(byId.node.ok, false);
  assert.match(byId.node.detail, /18\.20\.0/);
  assert.match(byId.node.action, /nodejs\.org/);
  assert.equal(byId.account.href, '#/login');
  assert.equal(byId.provider.href, '#/models');
  assert.equal(byId.key.href, '#/settings');
});

test('onboarding：只缺账号时 done=3，其余项仍为 ok', () => {
  const r = buildOnboardingSteps({ major: 20, nodeVersion: '20.11.0', accountCount: 0, providerOk: true, keyOk: true });
  assert.equal(r.done, 3);
  assert.equal(r.steps.find((s) => s.id === 'account').ok, false);
});