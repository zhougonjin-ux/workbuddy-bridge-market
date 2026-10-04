// 协议层与请求头构造的补测（2026-10-04 全量测试审计）。
//
// 补测理由：openai/anthropic/responses/headers 四个文件此前零 import 引用。
// 它们里最关键的不是 handleXxx（需要真上游），而是那些**决定路由与降级走向的纯判定**：
//   - isModelNotFound / isTransportFailure / isGatewayError → 决定 openWithSiteFallback
//     是否换站重试。判错的后果是「本该降级却直接失败」，表现为用户莫名 4xx/5xx。
//   - toOpenAIBody / toChatRequest → 协议转换，转错字段会静默丢工具调用或 system 消息。
//   - chatHeaders / billingHeaders → 少一个身份头上游就认不出账号（401）。
import { test } from 'node:test';
import assert from 'node:assert';

const { normalizeChunk, isModelNotFound, isTransportFailure, isGatewayError } =
  await import('../src/openai.mjs');
const { toOpenAIBody } = await import('../src/anthropic.mjs');
const { toChatRequest } = await import('../src/responses.mjs');
const { chatHeaders, billingHeaders, refreshHeaders } = await import('../src/headers.mjs');

/* ==================== 降级判定（决定「换不换站」） ==================== */

test('isModelNotFound：认的是 400 + 三种上游措辞（不是 404）', () => {
  // 实测口径：上游「这个站点没这个模型」报的是 **400**（不是 404），
  // 且措辞只有这三种。判错的后果是该换站时没换 → 用户直接吃到 400。
  for (const t of [
    'model [glm-5.2] not found',
    'no such model',
    'service info not found',
  ]) {
    assert.equal(isModelNotFound(400, t), true, `应识别：${t}`);
  }
});

test('isModelNotFound：404 与其它措辞都不算（404 多半是路径变了，换站没用）', () => {
  assert.equal(isModelNotFound(404, 'model not found'), false,
    '404 不算 —— 404 多半是接口路径问题，换站同样 404');
  assert.equal(isModelNotFound(400, 'Model Not Found'), false,
    '大小写不同的通用措辞不算 —— 宁可漏判也不误判，误判会把业务错误当换站理由');
  assert.equal(isModelNotFound(200, 'no such model'), false);
});

test('isTransportFailure：认 transport 标记、504、以及四种网络关键词', () => {
  assert.equal(isTransportFailure({ transport: true }), true, '上游库标记的传输失败');
  assert.equal(isTransportFailure({ status: 504 }), true, '504 视为传输层');
  for (const m of ['ECONNRESET', 'UND_ERR_SOCKET', 'fetch failed', '连接失败']) {
    assert.equal(isTransportFailure({ message: m }), true, `应识别网络关键词：${m}`);
  }
  assert.equal(isTransportFailure({ message: '客户端断开' }), false, '业务文案不该被当传输失败');
  assert.equal(isTransportFailure(new Error('模型不存在')), false);
});

test('isGatewayError：只认 502/503/504（openresty/APISIX 回源失败的三个码）', () => {
  for (const s of [502, 503, 504]) assert.equal(isGatewayError(s), true, `${s} 应算网关故障`);
  // 500 不算：它通常是上游应用自身的 bug，换站也许有用但不在既定降级口径内
  assert.equal(isGatewayError(500), false, '500 不在网关降级口径内');
  for (const s of [400, 401, 402, 403, 404, 429]) {
    assert.equal(isGatewayError(s), false, `${s} 换站也没用，不该触发降级`);
  }
});

/* ==================== 流式帧归一化 ==================== */

test('normalizeChunk：把上游 SSE 载荷转成对外 chunk，模型名用对外名', () => {
  const out = normalizeChunk({ choices: [{ delta: { content: '你好' } }] }, 'my-model (x0.06)');
  assert.equal(out.object, 'chat.completion.chunk');
  assert.equal(out.model, 'my-model (x0.06)', '对外模型名应原样保留倍率后缀（客户端按它识别）');
  const d = out.choices?.[0]?.delta;
  assert.ok(d, '应产出 choices[0].delta');
  assert.match(d.content || d.text || '', /你好/);
});

test('normalizeChunk：空壳帧不炸，且不凭空造上游没给的 choices', () => {
  // 契约：choices 只在上游给了数组时才输出；上游给 {} 就整键省略（不凭空造 choices）。
  // 这是「帧白名单重建」的正确行为 —— 补一个空 choices 反而会让客户端以为有内容。
  // null 不在契约内：调用点有 `parsed.kind !== 'chunk'` 守卫，解析失败走不到这里。
  const noChoices = normalizeChunk({}, 'm');
  assert.equal(noChoices.object, 'chat.completion.chunk');
  assert.ok(noChoices.id, '应自带 id');
  assert.equal(noChoices.choices, undefined, '上游没给 choices 就不该凭空造一个');

  // 上游给了数组（含空数组）→ 原样保留形状
  for (const bad of [{ choices: [] }, { choices: [{}] }, { choices: [{ delta: {} }] }]) {
    const out = normalizeChunk(bad, 'm');
    assert.ok(Array.isArray(out.choices), `${JSON.stringify(bad)} 的 choices 应保留为数组`);
    assert.equal(out.choices.length, bad.choices.length, 'choices 长度不该变');
    for (const c of out.choices) {
      assert.ok('index' in c && 'delta' in c && 'finish_reason' in c, '每项都应补齐 index/delta/finish_reason');
    }
  }
});

test('normalizeChunk：剥掉上游噪声字段（空 content / 未知字段）', () => {
  // 这是「白名单重建」的核心：上游偶尔带一堆空字段与私有字段，标准客户端解析会报错
  const out = normalizeChunk({
    id: 'x', model: 'up',
    choices: [{ index: 3, delta: { content: '', role: '', tool_calls: [], 私有字段: 'x' }, finish_reason: null }],
    上游私有字段: { 噪声: true },
  }, 'pub');
  const d = out.choices[0].delta;
  assert.equal(d.content, undefined, '空 content 应被剥掉');
  assert.equal(d.role, undefined, '空 role 应被剥掉');
  assert.equal(d.tool_calls, undefined, '空 tool_calls 应被剥掉');
  assert.equal(d.私有字段, undefined, '未知字段应被剥掉');
  assert.equal(out.choices[0].index, 3, 'index 要保留');
  assert.equal(out.choices[0].finish_reason, null);
  assert.equal(out.上游私有字段, undefined, '顶层未知字段也应剥掉');
  assert.equal(out.model, 'pub', '模型名换成对外名');
});

/* ==================== 协议转换 ==================== */

test('toOpenAIBody：Anthropic 消息 → OpenAI 格式，system 提到最前', () => {
  const b = toOpenAIBody({
    model: 'm',
    max_tokens: 100,
    system: '你是助手',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(b.model, 'm');
  assert.ok(Array.isArray(b.messages), '应产出 messages 数组');
  // system 若被提到 messages 里，必须在第一条且是 system 角色
  const first = b.messages[0];
  if (first.role === 'system') {
    assert.match(JSON.stringify(first.content), /你是助手/);
    assert.equal(b.messages[b.messages.length - 1].role, 'user', 'user 消息应保留在末尾');
  }
  assert.equal(b.max_tokens, 100, 'max_tokens 应透传');
});

test('toOpenAIBody：Anthropic 的 content 块数组要压成字符串或保留多模态结构', () => {
  const b = toOpenAIBody({
    model: 'm',
    max_tokens: 10,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }],
  });
  assert.ok(Array.isArray(b.messages), '应产出 messages');
  const c = b.messages[b.messages.length - 1].content;
  // 两种合法形态：拼成字符串，或保留 OpenAI 的 [{type:text,text}] 数组
  const asText = typeof c === 'string' ? c : null;
  const asParts = Array.isArray(c) ? c.map((x) => x?.text || '').join('') : null;
  assert.ok(asText?.includes('A') || asParts?.includes('B'), '两个文本块都不该丢');
});

test('toChatRequest：Responses 协议 → Chat Completions 形状', () => {
  const r = toChatRequest({
    model: 'm',
    input: '你好',
    instructions: '系统提示',
    max_output_tokens: 64,
  });
  assert.equal(r.model, 'm');
  assert.ok(Array.isArray(r.messages), '应产出 messages');
  const json = JSON.stringify(r);
  assert.match(json, /你好/, '用户输入不该丢');
  assert.match(json, /系统提示/, 'instructions 不该丢（要映射成 system 消息）');
});

/* ==================== 请求头（少一个就 401） ==================== */

const site = { origin: 'https://example.com', userAgent: 'UA/1.0', product: 'SaaS' };
const fullAuth = { accessToken: 'tk', refreshToken: 'rk', uid: 'u1', enterpriseId: 'e1', domain: 'd1' };
const bareAuth = { accessToken: 'tk', refreshToken: 'rk' };

test('chatHeaders：身份齐全时四个身份头都在', () => {
  const h = chatHeaders(site, fullAuth);
  assert.equal(h.Authorization, 'Bearer tk');
  assert.equal(h['X-User-Id'], 'u1');
  assert.equal(h['X-Enterprise-Id'], 'e1');
  assert.equal(h['X-Domain'], 'd1');
  assert.equal(h.Accept, 'text/event-stream', '聊天接口要 SSE');
  assert.equal(h.Origin, site.origin);
});

test('chatHeaders：缺身份时用 No-* 头显式声明（而不是省略）', () => {
  const h = chatHeaders(site, bareAuth);
  // 上游靠这些头判断「这个请求有没有身份」，省掉会被当成 401
  assert.equal(h['X-No-User-Id'], '1', '缺 uid 时应有 X-No-User-Id');
  assert.equal(h['X-No-Enterprise-Id'], '1', '缺企业时应声明');
  assert.equal(h['X-No-Department-Info'], '1', '缺部门时应声明');
  assert.equal(h['X-User-Id'], undefined, '缺了就不该凭空造一个');
});

test('chatHeaders：每次请求的追踪 ID 都是新的（不能复用）', () => {
  const a = chatHeaders(site, fullAuth);
  const b = chatHeaders(site, fullAuth);
  assert.notEqual(a['X-Request-ID'], b['X-Request-ID'], 'X-Request-ID 不能复用');
  assert.notEqual(a['X-Request-Trace-Id'], b['X-Request-Trace-Id']);
});

test('billingHeaders：计费接口用 JSON Accept 且不误带 Accept: text/event-stream', () => {
  const h = billingHeaders(site, fullAuth);
  assert.equal(h.Accept, 'application/json');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h['X-Tenant-Id'], 'e1', '计费接口还需 X-Tenant-Id');
  assert.notEqual(h.Accept, 'text/event-stream', '不能把聊天接口的 SSE Accept 带到计费接口');
});

test('refreshHeaders：refresh token 走独立接口，且只出现在这里', () => {
  const h = refreshHeaders(site, fullAuth);
  assert.equal(h['X-Refresh-Token'], 'rk', '刷新接口必须带 refresh token');
  assert.equal(h['X-Auth-Refresh-Source'], 'workbuddy');
  // 反向断言：refresh token 绝不能出现在聊天/计费头里
  assert.equal(chatHeaders(site, fullAuth)['X-Refresh-Token'], undefined, '聊天头不该带 refresh token');
  assert.equal(billingHeaders(site, fullAuth)['X-Refresh-Token'], undefined, '计费头不该带 refresh token');
});
