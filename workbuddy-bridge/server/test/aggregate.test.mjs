// 0.3.58 聚合渠道泳道 + 活动专家链的回归测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateProviders, nextAggregateKey } from '../src/aggregate.mjs';
import { resolveTarget } from '../src/router.mjs';
import { validateConfig } from '../src/config.mjs';
import { expertIdFromJumpUrl, expertNameFromTitle, isEventChainTask } from '../src/taskevents.mjs';

const AGG_CFG = {
  aggregate: {
    providers: [
      { name: 'demo', baseUrl: 'https://api.example.com/v1', apiKeys: ['sk-111111', 'sk-222222'], enabled: true },
      { name: 'off', baseUrl: 'https://off.example.com/v1', apiKeys: ['sk-x'], enabled: false },
      { name: 'nokey', baseUrl: 'https://nk.example.com/v1', apiKeys: [] },
    ],
  },
};

test('aggregateProviders：三要素齐且未停用才算有效', () => {
  const list = aggregateProviders(AGG_CFG);
  assert.deepEqual(list.map((x) => x.name), ['demo']);
});

test('nextAggregateKey：多 key 轮换、单 key 恒定', () => {
  const p = AGG_CFG.aggregate.providers[0];
  const seq = [nextAggregateKey(p), nextAggregateKey(p), nextAggregateKey(p)];
  assert.deepEqual(seq, ['sk-111111', 'sk-222222', 'sk-111111']);
  assert.equal(nextAggregateKey(AGG_CFG.aggregate.providers[1]), 'sk-x');
});

test('resolveTarget：agg: 前缀走聚合泳道（成功/未知渠道/坏格式）', async () => {
  const t = await resolveTarget(AGG_CFG, 'agg:demo/gpt-9-mini');
  assert.equal(t.site, 'aggregate');
  assert.equal(t.model, 'gpt-9-mini');
  assert.deepEqual(t.aggregate, { provider: 'demo', model: 'gpt-9-mini' });
  await assert.rejects(() => resolveTarget(AGG_CFG, 'agg:nosuch/m'), (e) => e.status === 404);
  await assert.rejects(() => resolveTarget(AGG_CFG, 'agg:demo'), (e) => e.status === 400);
  await assert.rejects(() => resolveTarget(AGG_CFG, 'agg:off/m'), (e) => e.status === 404, '停用的渠道按不存在处理');
});

test('validateConfig：aggregate.providers 清洗（非法名/非法 URL/无 key 移除，尾斜杠剥掉）', () => {
  const input = { aggregate: { providers: [
    { name: 'bad name!', baseUrl: 'https://a.com/v1', apiKeys: ['k'] },
    { name: 'ok', baseUrl: 'https://ok.com/v1/', apiKeys: ['k1', ' '] },
    { name: 'nourl', baseUrl: 'ftp://x', apiKeys: ['k'] },
    { name: 'nokey2', baseUrl: 'https://b.com/v1', apiKeys: [] },
  ] } };
  validateConfig(input);
  const names = input.aggregate.providers.map((p) => p.name);
  assert.deepEqual(names, ['ok']);
  assert.equal(input.aggregate.providers[0].baseUrl, 'https://ok.com/v1');
});

test('活动专家任务（0.3.58）：jump_url 取 id、标题取名、链任务判定扩围', () => {
  assert.equal(expertIdFromJumpUrl('https://www.workbuddy.cn/work/launch/?deeplink=workbuddy%3A%2F%2Fexperts%3FexpertId%3Dex_GDl31WahyIH0&buddy_type=workbuddy'), 'ex_GDl31WahyIH0');
  assert.equal(expertIdFromJumpUrl('workbuddy://expert'), null);
  assert.equal(expertNameFromTitle('体验「抖音策略师」'), '抖音策略师');
  assert.equal(expertNameFromTitle('无引号标题'), null);
  assert.ok(isEventChainTask('expert_use_maidehao'));
  assert.ok(isEventChainTask('expert_use_anything_new'));
  assert.ok(isEventChainTask('WorkBuddy_Valorant'));
  assert.equal(isEventChainTask('Model_chat_GLM5.2'), false);
});
