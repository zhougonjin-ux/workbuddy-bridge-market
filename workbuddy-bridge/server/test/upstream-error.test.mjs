// openChat 上游错误路径的集成级回归测试（0.3.37 补，全量审查发现的最高危盲区）。
//
// 背景：openChat 对「输入太长」以外的上游错误（401/402/429/5xx）会把读掉的 body
// 还原成合成响应对象再统一处理。0.3.36 及之前该对象丢失了 headers，导致
// `res.headers.get('retry-after')` 对所有非 200-太长错误抛 TypeError——
// markFailure / Retry-After 模型冷却 / 账号轮换 / 换站降级整条链路被短路。
// 旧测试只覆盖纯函数（parseRetryAfter / classifyFrame），够不着这条路径，
// 这里用 mock fetch 补上：**上游任何非 200 都必须返回 { ok:false } 而不是抛异常**。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { setConfigDir } = await import('../src/config.mjs');
const { addAccount } = await import('../src/pool.mjs');
const { openChat } = await import('../src/upstream.mjs');

const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-openchat-err-'));
const restoreDir = setConfigDir(iso);

const cfg = {
  defaultSite: 'errtest',
  defaultMaxTokens: 64,
  upstreamRetry: { attempts: 1, backoffMs: [0] },
  timeouts: { headerMs: 5000, idleMs: 5000, metaMs: 5000 },
  pool: {},
  sites: {
    errtest: {
      label: '错误路径测试站',
      enabled: true,
      apiBase: 'https://upstream.errtest.invalid',
      billingBase: 'https://upstream.errtest.invalid',
      origin: 'https://upstream.errtest.invalid',
      userAgent: 'wb-test/1.0',
      product: 'SaaS',
    },
  },
};

test.after(() => { restoreDir?.(); });

/** mock 一次上游响应后调 openChat，返回其结果（或捕获异常供断言）。 */
async function withUpstream(status, headers, body) {
  const realFetch = global.fetch;
  global.fetch = async () => new Response(body, { status, headers });
  try {
    return { ok: true, value: await openChat(cfg, 'errtest', { messages: [{ role: 'user', content: 'hi' }] }) };
  } catch (e) {
    return { ok: false, error: e };
  } finally {
    global.fetch = realFetch;
  }
}

test('前置：测试站点有登录态（不触发刷新）', () => {
  addAccount('errtest', { accessToken: 'tk-test', expiresAt: Date.now() + 3600_000, label: 'err-acc' });
});

test('openChat：429 + Retry-After 返回失败对象并带出冷却秒数（不抛 TypeError）', async () => {
  const r = await withUpstream(429, { 'Content-Type': 'application/json', 'Retry-After': '30' },
    JSON.stringify({ code: 14003, msg: 'rate limited' }));
  assert.equal(r.ok, true, `不应抛异常：${r.error?.stack || ''}`);
  assert.equal(r.value.ok, false);
  assert.equal(r.value.status, 429);
  assert.equal(r.value.retryAfter, 30, 'Retry-After 必须从 headers 读出——合成响应丢 headers 时这里会先 TypeError');
});

test('openChat：401 返回失败对象（token 刷新/换号链路能接住它）', async () => {
  const r = await withUpstream(401, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 1001, msg: 'unauthorized' }));
  assert.equal(r.ok, true, `不应抛异常：${r.error?.stack || ''}`);
  assert.equal(r.value.ok, false);
  assert.equal(r.value.status, 401);
});

test('openChat：5xx 返回失败对象（网关降级链路能接住它）', async () => {
  const r = await withUpstream(502, { 'Content-Type': 'text/html' }, '<html>Bad Gateway</html>');
  assert.equal(r.ok, true, `不应抛异常：${r.error?.stack || ''}`);
  assert.equal(r.value.ok, false);
  assert.equal(r.value.status, 502);
});

test('openChat：200 正常流不受影响', async () => {
  const sse = [
    'data: {"id":"1","choices":[{"delta":{"role":"assistant","content":"你"}}]}',
    'data: {"id":"1","choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    'data: [DONE]',
    '',
  ].join('\n');
  const r = await withUpstream(200, { 'Content-Type': 'text/event-stream' }, sse);
  assert.equal(r.ok, true, `不应抛异常：${r.error?.stack || ''}`);
  assert.equal(r.value.ok, true);
  const frames = [];
  for await (const f of r.value.frames) frames.push(f);
  assert.ok(frames.length >= 2, '应透出上游帧');
  r.value.close();
});
