// 0.3.56 模型链（借鉴 dsh 路由页）的回归测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { chainCandidates } from '../src/router.mjs';
import { openWithModelChain } from '../src/openai.mjs';
import { validateConfig } from '../src/config.mjs';

test('chainCandidates：剥后缀查表、去重、不含自身、上限 7、无链=单项', () => {
  const cfg = { modelChains: { 'glm-5.3-flash': ['glm-5.2', 'hy3', 'glm-5.3-flash', 'glm-5.2', '', 'kimi', 'a', 'b', 'c'] } };
  assert.deepEqual(chainCandidates(cfg, 'glm-5.3-flash (x0.06)'), ['glm-5.3-flash', 'glm-5.2', 'hy3', 'kimi', 'a', 'b', 'c']);
  assert.deepEqual(chainCandidates(cfg, 'hy3'), ['hy3']);
  assert.deepEqual(chainCandidates({}, 'glm-5.3-flash'), ['glm-5.3-flash']);
  assert.deepEqual(chainCandidates({ modelChains: {} }, 'x'), ['x']);
});

test('openWithModelChain：模型层失败按链换下一个，成功即返回', async () => {
  const cfg = { modelChains: { 'm-a': ['m-b', 'm-c'] } };
  const calls = [];
  const opener = async (site, body) => {
    calls.push(body.model);
    if (body.model === 'm-a') return { ok: false, status: 429, text: 'too many requests' };
    if (body.model === 'm-b') return { ok: false, status: 402, text: 'quota' };
    return { ok: true, status: 200, text: '' };
  };
  const resolve = async (c, m) => ({ site: 'cn-cli', model: m, requested: m });
  const r = await openWithModelChain(cfg, { site: 'cn-cli', model: 'm-a', requested: 'm-a' }, { model: 'm-a', messages: [] }, null, opener, { resolveTarget: resolve });
  assert.equal(r.up.ok, true);
  assert.deepEqual(calls, ['m-a', 'm-b', 'm-c'], '按链顺序逐个尝试');
});

test('openWithModelChain：非模型层错误（401/参数 400）不续链，原样返回首败', async () => {
  const cfg = { modelChains: { 'm-a': ['m-b'] } };
  const calls = [];
  const opener = async (site, body) => { calls.push(body.model); return { ok: false, status: 401, text: '登录态失效' }; };
  const resolve = async (c, m) => ({ site: 'cn-cli', model: m, requested: m });
  const r = await openWithModelChain(cfg, { site: 'cn-cli', model: 'm-a', requested: 'm-a' }, { model: 'm-a' }, null, opener, { resolveTarget: resolve });
  assert.equal(r.up.ok, false);
  assert.equal(r.up.status, 401);
  assert.deepEqual(calls, ['m-a'], '401 换模型救不了，不续链');
});

test('openWithModelChain：全链失败返回最后一败；没配链只试一次', async () => {
  const opener = async () => ({ ok: false, status: 429, text: 'busy' });
  const resolve = async (c, m) => ({ site: 's', model: m, requested: m });
  const r = await openWithModelChain({ modelChains: { 'm-a': ['m-b'] } }, { site: 's', model: 'm-a', requested: 'm-a' }, { model: 'm-a' }, null, opener, { resolveTarget: resolve });
  assert.equal(r.up.status, 429);
  let n = 0;
  const opener2 = async () => { n++; return { ok: false, status: 429, text: 'busy' }; };
  await openWithModelChain({}, { site: 's', model: 'm-a', requested: 'm-a' }, { model: 'm-a' }, null, opener2, { resolveTarget: resolve });
  assert.equal(n, 1, '没配链 = 行为与旧版全等（只打一次）');
});

test('validateConfig：modelChains 清洗（非数组移除、剔自身、去重去空、截 6）', () => {
  const input = { modelChains: { 'a': 'not-array', 'b': ['b'], 'c': [' x ', 'x', 'y'], 'd': ['1', '2', '3', '4', '5', '6', '7', '8'] } };
  const issues = validateConfig(input); // 就地修改，返回 issues
  assert.ok(Array.isArray(issues) && issues.some((s) => String(s).includes('modelChains')), '清洗动作有留痕');
  const cfg = input;
  assert.equal(cfg.modelChains.a, undefined, '非数组移除');
  assert.equal(cfg.modelChains.b, undefined, '只含自身 = 无效链移除');
  assert.deepEqual(cfg.modelChains.c, ['x', 'y'], 'trim+去重');
  assert.equal(cfg.modelChains.d.length, 6, '截到 6 个候选');
});
