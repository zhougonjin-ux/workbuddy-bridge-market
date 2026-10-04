// T50–T54 第五批：连登管家纯函数 / 官方热力图解析 / 昵称隐私边界 / v3/config 签名。
// 全部为无网络纯判定（streakScanAccount 本体走真上游，在线验证做）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { redeemableTiers, parseHeatmapCells, parseAccountProfile } from '../src/tasks.mjs';
import { PROTOCOL_SIGNATURES, evaluateSignatures } from '../src/protocol.mjs';

/* ==================== T50：连登档位兑换判定 ==================== */

const full = (statuses, tiers) => ({
  redemption_status: {
    tier_7d_status: statuses[0], tier_14d_status: statuses[1], tier_28d_status: statuses[2],
    tiers,
  },
});

test('redeemableTiers：locked 与 claimed 跳过，可兑档保留', () => {
  const f = full(['locked', 'claimable', 'claimed'], [
    { tier: '7d', credit: 0 },
    { tier: '14d', credit: 50 },
    { tier: '28d', credit: 150 },
  ]);
  const out = redeemableTiers(f);
  assert.deepEqual(out.map((t) => t.tier), ['14d']);
});

test('redeemableTiers：未知状态值也尝试兑换（上游加新状态时宁可幂等重发也不漏兑）', () => {
  const f = full(['new_state', 'claimable', 'claimed'], [{ tier: '7d' }, { tier: '14d' }, { tier: '28d' }]);
  assert.deepEqual(redeemableTiers(f).map((t) => t.tier), ['7d', '14d']);
});

test('redeemableTiers：状态字段缺失时按「尝试」处理（空 tiers 返回空）', () => {
  assert.deepEqual(redeemableTiers({ redemption_status: {} }), []);
  assert.deepEqual(redeemableTiers(null), []);
});

/* ==================== T52：官方热力图解析 ==================== */

test('parseHeatmapCells：宽松解析 + 非法日期剔除', () => {
  const cells = parseHeatmapCells({
    cells: [
      { date: '2026-10-04T00:00:00+08:00', score: 3, has_new_buddy: true },
      { date: '2026-10-03', score: '5' },
      { date: '', score: 9 },
      null,
      { score: 1 },
    ],
  });
  assert.equal(cells.length, 2);
  assert.deepEqual(cells[0], { date: '2026-10-04', score: 3, hasNewBuddy: true });
  assert.deepEqual(cells[1], { date: '2026-10-03', score: 5, hasNewBuddy: false });
});

test('parseHeatmapCells：cells 缺失/非数组时返回空（不抛错）', () => {
  assert.deepEqual(parseHeatmapCells(null), []);
  assert.deepEqual(parseHeatmapCells({}), []);
  assert.deepEqual(parseHeatmapCells({ cells: 'x' }), []);
});

/* ==================== T53：昵称同步隐私边界 ==================== */

test('parseAccountProfile：只出 uid/nickname，手机号等敏感字段必须被丢弃', () => {
  const out = parseAccountProfile({
    uid: 'u-123',
    nickname: '公瑾',
    phoneNumber: '13800000000',
    wechatOpenId: 'wx-sensitive',
    email: 'a@b.c',
  });
  assert.deepEqual(out, { uid: 'u-123', nickname: '公瑾' });
  // 返回对象上不允许出现任何敏感键（防以后有人改成 spread 透传）
  assert.equal(Object.keys(out).length, 2);
  assert.equal('phoneNumber' in out, false);
  assert.equal('wechatOpenId' in out, false);
});

test('parseAccountProfile：缺字段时不炸（返回空串由调用方报错）', () => {
  assert.deepEqual(parseAccountProfile(null), { uid: '', nickname: '' });
  assert.deepEqual(parseAccountProfile({}), { uid: '', nickname: '' });
});

test('parseAccountProfile：{code,data} 信封形态也解析（上游实际响应是信封包裹）', () => {
  const out = parseAccountProfile({
    code: 0,
    msg: 'ok',
    data: { uid: 'u-9', nickname: '周火火', phoneNumber: '13900000000', wechatOpenId: 'wx-x' },
  });
  assert.deepEqual(out, { uid: 'u-9', nickname: '周火火' });
  assert.equal('phoneNumber' in out, false);
});

/* ==================== T54：v3/config 协议签名 ==================== */

test('PROTOCOL_SIGNATURES 含 v3config.cli.models 签名', () => {
  assert.ok(PROTOCOL_SIGNATURES.some((s) => s.key === 'v3config.cli.models'));
});

test('v3config 签名：cli models 非空且含默认模型 → 通过', () => {
  const r = evaluateSignatures({
    v3config: {
      code: 0,
      data: { agents: [{ name: 'cli', models: ['glm-5.3-flash', 'glm-5.2'] }, { name: 'ide', models: ['x'] }] },
      __wantModel: 'glm-5.3-flash',
    },
  });
  const v3 = r.results.find((x) => x.key === 'v3config.cli.models');
  assert.equal(v3.ok, true, v3.detail);
});

test('v3config 签名：cli 目录不再含默认模型 → 漂移告警', () => {
  const r = evaluateSignatures({
    v3config: { code: 0, data: { agents: [{ name: 'cli', models: ['other-model'] }] }, __wantModel: 'glm-5.3-flash' },
  });
  const v3 = r.results.find((x) => x.key === 'v3config.cli.models');
  assert.equal(v3.ok, false);
  assert.match(v3.detail, /默认模型/);
});

test('v3config 签名：agents/cli 条目消失或 models 变非数组 → 漂移', () => {
  for (const sample of [
    { code: 0, data: {} },
    { code: 0, data: { agents: [{ name: 'ide', models: ['x'] }] } },
    { code: 0, data: { agents: [{ name: 'cli', models: 'glm-5.2' }] } },
    null,
  ]) {
    const r = evaluateSignatures({ v3config: sample });
    const v3 = r.results.find((x) => x.key === 'v3config.cli.models');
    assert.equal(v3.ok, false, `样本 ${JSON.stringify(sample).slice(0, 60)} 应判漂移`);
  }
});

test('v3config 签名：无 v3config 样本时判漂移（探针失败会带 error 记录，不静默通过）', () => {
  const r = evaluateSignatures({});
  const v3 = r.results.find((x) => x.key === 'v3config.cli.models');
  assert.equal(v3.ok, false);
});
