// 0.3.66 CodeArts 站点适配的纯函数回归：签名、模型归一化、窗口表、凭据解析、目录解析
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.WB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-codearts-test-'));
const {
  signRequestHuawei, wireHeadersFromSigned, generatePkcePair, generateDpopKeyPair,
  signDpopJws, codeartsNormalizeModelId, codeartsContextWindow, codeartsFetchCatalog,
  codeartsRefreshExpiresAt, codeartsExpiresFromCredential, CODEARTS_BENEFIT_FALLBACK,
} = await import('../src/codearts.mjs');
import test from 'node:test';
import assert from 'node:assert/strict';

test('SDK-HMAC-SHA256 签名：Authorization 形态正确，benefit 头参与签名且随请求发送', async () => {
  const url = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions';
  const signed = signRequestHuawei('AKTEST', 'SKTEST', 'STTOKEN', 'POST', url, new TextEncoder().encode('{"a":1}'), { maas_type: 'benefit' });
  const auth = signed.get('Authorization');
  assert.match(auth, /^SDK-HMAC-SHA256 Access=AKTEST,SignedHeaders=/);
  // host/content-type/x-sdk-* 都在 SignedHeaders 里
  assert.match(auth, /SignedHeaders=content-type;host;maas_type;x-sdk-content-sha256;x-sdk-date;x-security-token/);
  assert.equal(signed.get('maas_type'), 'benefit');
  assert.equal(signed.get('x-security-token'), 'STTOKEN');
  // wire 头：host 不能手动设（fetch 自己带），maas_type/x-security-token/Authorization 必须带
  const wire = wireHeadersFromSigned(signed);
  assert.equal(wire.host, undefined);
  assert.equal(wire.maas_type, 'benefit');
  assert.ok(wire.Authorization.startsWith('SDK-HMAC-SHA256 '));
  // 无 extraHeaders 的 GET：无 content-type
  const g = signRequestHuawei('AK', 'SK', 'ST', 'GET', 'https://opengw.example.com/api/v1/gateway/config', new Uint8Array());
  assert.equal(g.get('content-type'), undefined);
});

test('PKCE + DPoP：challenge 是 verifier 的 S256；DPoP JWS 三段且头部带 jwk', () => {
  const pkce = generatePkcePair();
  const expect = crypto2.createHash('sha256').update(pkce.codeVerifier).digest('base64url');
  assert.equal(pkce.codeChallenge, expect);
  const kp = generateDpopKeyPair();
  assert.equal(kp.privateKeyJwk.crv, 'P-256');
  assert.ok(kp.privateKeyJwk.d);
  const jws = signDpopJws(kp.privateKeyJwk, 'POST', 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens');
  const parts = jws.split('.');
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  assert.equal(header.alg, 'ES256');
  assert.equal(header.typ, 'dpop+jwt');
  assert.equal(header.jwk.x, kp.publicKeyJwk.x);
  const crypto2mod = crypto2;
  void crypto2mod;
});

import crypto2 from 'node:crypto';

test('模型 id 归一化与窗口表：-0731 去后缀、benefit 模型不被误改、窗口查不到用兜底', () => {
  assert.equal(codeartsNormalizeModelId('deepseek-v4-flash-0731'), 'deepseek-v4-flash');
  assert.equal(codeartsNormalizeModelId('glm-5.3-flash'), 'glm-5.3-flash'); // flash 不是日期后缀
  assert.equal(codeartsNormalizeModelId('GLM-5.2'), 'GLM-5.2');
  assert.equal(codeartsContextWindow('GLM-5.2'), 1_048_576);
  assert.equal(codeartsContextWindow('openpangu-2.0-pro'), 524_288);
  assert.equal(codeartsContextWindow('never-heard-of-it'), 524_288); // 具名兜底
  assert.ok(CODEARTS_BENEFIT_FALLBACK.includes('glm-5.3-flash'));
});

test('refresh_token JWT exp 读取：秒级转毫秒、坏 token 返回 undefined', () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const ms = codeartsRefreshExpiresAt({ refresh_token: jwt });
  assert.ok(Math.abs(ms - exp * 1000) < 2000);
  assert.equal(codeartsRefreshExpiresAt({ refresh_token: 'garbage' }), undefined);
  assert.equal(codeartsRefreshExpiresAt({}), undefined);
});

test('凭据过期时刻：expires_at 可解析用真值，否则 +24h 回退', () => {
  const t = codeartsExpiresFromCredential({ expires_at: '2026-11-01T00:00:00Z' });
  assert.equal(t, Date.parse('2026-11-01T00:00:00Z'));
  const t2 = codeartsExpiresFromCredential({});
  assert.ok(t2 > Date.now() + 86_000_000 && t2 < Date.now() + 87_000_000);
});

test('目录拉取：benefit 模型标记 + 常规模型合并 + VL 过滤（fetch 注入）', async () => {
  const gatewayJson = JSON.stringify({ result: { models: [
    { model_id: 'glm-5.3-flash', model_name: 'GLM-5.3-Flash' },
    { model_id: 'deepseek-v4-flash-0731', model_name: 'DeepSeek-V4-Flash-0731' },
    { model_id: 'Qwen3-VL-235B', model_name: 'Qwen3-VL' },
  ] } });
  const snapJson = JSON.stringify({ builtinModels: [
    { model_id: 'GLM-5.2', model_name: 'GLM-5.2', credit: [{ ratio: '0.05', ratio_display: '0.7x' }] },
  ] });
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    return { ok: true, text: async () => (String(url).includes('opengw') ? gatewayJson : snapJson) };
  };
  const out = await codeartsFetchCatalog(
    { access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST' },
    { fetcher: fakeFetch },
  );
  assert.equal(out.gatewayOk, true);
  assert.equal(out.builtinOk, true);
  const ids = out.models.map((m) => m.id);
  assert.ok(ids.includes('glm-5.3-flash'));
  assert.ok(ids.includes('deepseek-v4-flash')); // 已去后缀
  assert.ok(!ids.includes('Qwen3-VL-235B')); // VL 过滤
  const glm = out.models.find((m) => m.id === 'glm-5.3-flash');
  assert.equal(glm.benefit, 'yes'); // benefit 标记 → chat 带 maas_type
  assert.equal(out.models.find((m) => m.id === 'GLM-5.2').benefit, 'no');
  assert.equal(calls.length, 2);
});

test('凭据缺失时目录返回空且两来源都算失败（残缺不缓存的前置）', async () => {
  const out = await codeartsFetchCatalog({}, { fetcher: async () => { throw new Error('should not be called'); } });
  assert.equal(out.models.length, 0);
  assert.equal(out.gatewayOk, false);
  assert.equal(out.builtinOk, false);
});
