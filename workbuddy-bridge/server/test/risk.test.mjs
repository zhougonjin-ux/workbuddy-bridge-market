// 0.4.3：风控识别 + 账号级故障处置 + 三段式降级选号 + 聚合 key 熔断
// （移植 dsh-xdpool 2.7.1 #127 的分类与 rankedPool 三带设计）。
// 隔离纪律与 modelsync.test.mjs 同款：先指到临时目录再 import，绝不碰生产数据目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.WB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-risk-test-'));

const { classifyAccountFault, markFailure, markSuccess, pickAccount, savePool, listAccounts } = await import('../src/pool.mjs');
const { nextAggregateKey, reportAggregateKey } = await import('../src/aggregate.mjs');

/* ==================== classifyAccountFault：分类 ==================== */

test('classifyAccountFault：403+11140 三种 JSON 形态都判风控', () => {
  assert.equal(classifyAccountFault(403, '{"code":11140,"msg":"账号已被标记"}'), 'risk_blocked');
  assert.equal(classifyAccountFault(403, '{"code": 11140}'), 'risk_blocked');
  assert.equal(classifyAccountFault(403, '{"code":"11140"}'), 'risk_blocked');
  assert.equal(classifyAccountFault(403, '{"code":11141}'), 'risk_blocked');
});

test('classifyAccountFault：200 业务信封里嵌 11140 也算风控（信封比状态码具体）', () => {
  assert.equal(classifyAccountFault(0, '{"code":11140,"msg":"risk"}'), 'risk_blocked');
});

test('classifyAccountFault：账号级故障关键词 → account_fault', () => {
  assert.equal(classifyAccountFault(400, 'request illegal'), 'account_fault');
  assert.equal(classifyAccountFault(0, 'session not found'), 'account_fault');
  assert.equal(classifyAccountFault(200, '{"code":12153,"msg":"…"}'), 'account_fault');
});

test('classifyAccountFault：限流/额度/正常体 → null（交给限流/额度分类裁决）', () => {
  assert.equal(classifyAccountFault(429, '{"code":14003,"msg":"too many requests"}'), null);
  assert.equal(classifyAccountFault(402, 'insufficient credit'), null);
  assert.equal(classifyAccountFault(200, '正常回复'), null);
  assert.equal(classifyAccountFault(500, 'internal error'), null);
});

/* ==================== markFailure：风控/故障处置 ==================== */

function seedPool(site, accounts) {
  fs.writeFileSync(path.join(process.env.WB_CONFIG_DIR, `auth.${site}.pool.json`), JSON.stringify({
    version: 1,
    nextLabel: 1,
    accounts,
  }));
}

test('markFailure：风控 → 账号级冷却 30 分钟 + riskBlockedAt 标记', () => {
  const site = 'riskt1';
  seedPool(site, [{ id: 'acc_r1', label: 'R1', enabled: true, accessToken: 'tk' }]);
  const t0 = Date.now();
  markFailure(site, 'acc_r1', { status: 403, message: '{"code":11140,"msg":"账号已被标记"}' });
  const a = listAccounts(site).find((x) => x.id === 'acc_r1');
  assert.ok(a.riskBlockedAt >= t0, '应记风控时间戳');
  // 30 分钟 ± 5 秒（测试执行耗时容差）
  assert.ok(a.cooldownUntil >= t0 + 30 * 60_000 - 5_000 && a.cooldownUntil <= t0 + 30 * 60_000 + 5_000,
    `冷却应约 30 分钟，实际 ${Math.round((a.cooldownUntil - t0) / 1000)}s`);
});

test('markFailure：账号级故障 → 长冷却 6 小时 + accountFaultAt 标记', () => {
  const site = 'riskt2';
  seedPool(site, [{ id: 'acc_f1', label: 'F1', enabled: true, accessToken: 'tk' }]);
  const t0 = Date.now();
  markFailure(site, 'acc_f1', { status: 400, message: 'request illegal' });
  const a = listAccounts(site).find((x) => x.id === 'acc_f1');
  assert.ok(a.accountFaultAt >= t0);
  assert.ok(a.cooldownUntil >= t0 + 6 * 3600_000 - 5_000, `冷却应约 6 小时，实际 ${Math.round((a.cooldownUntil - t0) / 60000)}min`);
});

test('markSuccess：清空风控/故障标记与冷却', () => {
  const site = 'riskt3';
  seedPool(site, [{ id: 'acc_s1', label: 'S1', enabled: true, accessToken: 'tk' }]);
  markFailure(site, 'acc_s1', { status: 403, message: '{"code":11140}' });
  markSuccess(site, 'acc_s1');
  const a = listAccounts(site).find((x) => x.id === 'acc_s1');
  assert.equal(a.riskBlockedAt, null);
  assert.equal(a.cooldownUntil, null);
  assert.equal(a.failCount, 0);
});

/* ==================== pickAccount：三段式降级 ==================== */

test('pickAccount fallback：冷却按恢复时间升序优先，耗尽其次，账号故障垫底，保留线排除', () => {
  const site = 'riskt4';
  const now = Date.now();
  seedPool(site, [
    { id: 'acc_A', label: 'A 风控', enabled: true, accessToken: 'tk', cooldownUntil: now + 30 * 60_000, riskBlockedAt: now },
    { id: 'acc_B', label: 'B 短冷却', enabled: true, accessToken: 'tk', cooldownUntil: now + 10_000 },
    { id: 'acc_C', label: 'C 耗尽', enabled: true, accessToken: 'tk', exhaustedAt: now - 3600_000 },
    { id: 'acc_D', label: 'D 账号故障', enabled: true, accessToken: 'tk', cooldownUntil: now + 5 * 3600_000, accountFaultAt: now },
    { id: 'acc_E', label: 'E 保留线', enabled: true, accessToken: 'tk', minRemain: 100, creditRemain: 50 },
  ]);
  // 无可用账号 → 降级：B（纯冷却、恢复最早）> A（风控 30 分钟）> C（耗尽）> D（账号故障）；E 被保留线排除
  const order = [];
  const exclude = [];
  for (let i = 0; i < 4; i++) {
    const picked = pickAccount(site, { exclude, fallback: true, now });
    assert.ok(picked, `第 ${i + 1} 个降级候选不应为空`);
    order.push(picked.id);
    exclude.push(picked.id);
  }
  assert.deepEqual(order, ['acc_B', 'acc_A', 'acc_C', 'acc_D'], `降级顺序应为 冷却(按恢复时间)→耗尽→账号故障，实际 ${order.join(' → ')}`);
  // E 是用户保留线挡掉的：不在降级名单里
  const last = pickAccount(site, { exclude, fallback: true, now });
  assert.equal(last?.id, 'acc_E', '全员被保留线挡住时的最后手段才轮到它');
});

/* ==================== 聚合 key 熔断 ==================== */

test('aggregate key：连败 3 次熔断 5 分钟，轮换跳过熔断中的 key，成功即清零', () => {
  const provider = { name: 'cir-test', baseUrl: 'https://x.example', apiKeys: ['k1', 'k2', 'k3'] };
  // 记不清初始游标——先排空一轮拿到确定序列
  const seq = [nextAggregateKey(provider), nextAggregateKey(provider), nextAggregateKey(provider)];
  assert.equal(new Set(seq).size, 3, '三把 key 轮换各出现一次');
  // k1 连败 3 次 → 熔断
  reportAggregateKey('cir-test', 'k1', false);
  reportAggregateKey('cir-test', 'k1', false);
  reportAggregateKey('cir-test', 'k1', false);
  for (let i = 0; i < 6; i++) {
    const k = nextAggregateKey(provider);
    assert.notEqual(k, 'k1', '熔断中的 key 不应被选中');
  }
  // 成功一次即清零：k1 重新可用（先排空 k2/k3 再看 k1 回归）
  reportAggregateKey('cir-test', 'k1', true);
  const seen = new Set();
  for (let i = 0; i < 3; i++) seen.add(nextAggregateKey(provider));
  assert.ok(seen.has('k1'), '成功清零后 k1 应回到轮换');
});
