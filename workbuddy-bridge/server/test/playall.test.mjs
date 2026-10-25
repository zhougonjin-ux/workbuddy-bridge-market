// 0.3.40 三个功能的纯逻辑单测：一键代打的 cap 口径 + 模型限制摘要拼装 + 本机导入签名。
//
// playAllTasks / modelLimitSuffix 的完整链路依赖上游与账号池，走临时目录试启验证；
// 这里只钉住三段可独立验证的核心逻辑：
//  - effectiveChatCap：一键代打放开 maxChatsPerTask 后的防失控护栏（1..200）；
//  - buildLimitSummary：错误消息里模型限制摘要的字段取舍（只说目录事实，空则省略）；
//  - localImportSignature：客户端续期重扫依据的 mtime 签名（两次调用必须稳定）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 测试隔离：先指到临时目录再 import（config.mjs 在模块加载时读 WB_CONFIG_DIR）
process.env.WB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-playall-test-'));

const { effectiveChatCap } = await import('../src/tasks.mjs');
const { buildLimitSummary } = await import('../src/router.mjs');
const { localImportSignature, startLocalImportWatch } = await import('../src/localimport.mjs');
const { terminalQR } = await import('../src/termqr.mjs');
const { isUsable } = await import('../src/pool.mjs');

test('effectiveChatCap：默认回落 maxChatsPerTask（缺省 5）', () => {
  assert.equal(effectiveChatCap({}, null), 5);
  assert.equal(effectiveChatCap({ tasks: { maxChatsPerTask: 8 } }, null), 8);
  // 配置非法也回落 5
  assert.equal(effectiveChatCap({ tasks: { maxChatsPerTask: 'abc' } }, null), 5);
  assert.equal(effectiveChatCap({}, undefined), 5);
});

test('effectiveChatCap：cap 覆盖生效，护栏 1..200', () => {
  assert.equal(effectiveChatCap({}, 50), 50);
  assert.equal(effectiveChatCap({ tasks: { maxChatsPerTask: 5 } }, '30'), 30, '字符串数字也认（控制台表单直传）');
  assert.equal(effectiveChatCap({}, 9999), 200, '防失控护栏');
  assert.equal(effectiveChatCap({}, -3), 1, '负数夹到下限 1');
  assert.equal(effectiveChatCap({}, 0), 1, '0 无意义，夹到 1');
  assert.equal(effectiveChatCap({}, 'abc'), 1, '非法字符串夹到 1（显式传了 cap 就按覆盖口径处理）');
});

test('buildLimitSummary：全字段 / 空信息 / 免费模型 / 429 指引', () => {
  const full = {
    contextWindow: 128000, maxTokens: 16000, credits: 'x0.79 credits',
    supportsImages: true, supportsToolCall: true, supportsReasoning: false,
  };
  const s = buildLimitSummary(full, 'cn-cli', 'glm-5.3-flash');
  assert.ok(s.includes('[模型限制] glm-5.3-flash（cn-cli）'));
  assert.ok(s.includes('上下文 128K'));
  assert.ok(s.includes('最大输出 16K'));
  assert.ok(s.includes('倍率 x0.79'));
  assert.ok(s.includes('支持图片输入/工具调用'));
  assert.ok(!s.includes('推理'), 'false 的能力不写（Boolean 化无法区分未标记）');
  assert.equal(s.startsWith('\n'), true, '以换行开头，方便直接拼在错误文本尾部');

  // 空对象/空字段：没有任何可说的事实 → 空串（不输出只有标题的废话行）
  assert.equal(buildLimitSummary({}, 'cn-cli', 'm'), '');
  assert.equal(buildLimitSummary(null, 'cn-cli', 'm'), '');
  assert.equal(buildLimitSummary({ contextWindow: 0, maxTokens: null, credits: null }, 'cn-cli', 'm'), '');

  // 免费模型
  assert.ok(buildLimitSummary({ credits: 'x0.00 credits' }, 'cn-cli', 'hy3').includes('免费（x0）'));

  // 429 附限流指引
  const r429 = buildLimitSummary(full, 'cn-cli', 'm', 429);
  assert.ok(r429.includes('429'), '429 要附限流指引');
  assert.ok(!buildLimitSummary(full, 'cn-cli', 'm', 400).includes('429'), '非 429 不附');
});

test('localImportSignature：同一目录内容下两次调用稳定（无 .codebuddy 时为空串）', () => {
  const a = localImportSignature();
  const b = localImportSignature();
  assert.equal(a, b, '文件没变签名必须一致 —— 这是续期重扫的判据');
  assert.equal(typeof a, 'string');
});

test('startLocalImportWatch：autoRescan=false 时不启动且返回可调用的 stop', () => {
  const stop = startLocalImportWatch({ localImport: { autoRescan: false } });
  assert.equal(typeof stop, 'function');
  stop(); // 幂等：没启动时调用也不该抛
});

test('terminalQR：确定性输出 + 固定定位角图案', () => {
  const a = terminalQR('https://example.com/login?state=abc');
  const b = terminalQR('https://example.com/login?state=abc');
  assert.equal(a, b, '同输入必须同输出（渲染是纯函数）');
  assert.notEqual(terminalQR('https://example.com/login?state=xyz'), a, '不同内容不能撞出同一张码');
  const lines = a.split('\n');
  assert.ok(lines.length >= 12 && lines.length <= 40, `行数应在合理区间（实得 ${lines.length}）`);
  // QR 三个定位角是规范固定图案（7×7 环）：首行必然出现左上+右上两个（左侧静区缩进用计数匹配）
  const finders = (lines[0].match(/█▀▀▀▀▀█/g) || []).length;
  assert.ok(finders >= 2, `首行应含左上+右上两个定位角（实得 ${finders}）：${JSON.stringify(lines[0])}`);
  for (const l of lines) assert.ok(!/\s$/.test(l), '行尾不得留空格（终端渲染干净）');
});

test('isUsable：保留积分下限（minRemain，借鉴 dsh 的「保留积分」）', () => {
  const base = { enabled: true, accessToken: 'tok' };
  assert.equal(isUsable(base), true);
  // 余额低于下限 → 不派活
  assert.equal(isUsable({ ...base, minRemain: 200, creditRemain: 100 }), false);
  // 余额高于下限 → 可用
  assert.equal(isUsable({ ...base, minRemain: 200, creditRemain: 300 }), true);
  // 余额未知（null / 没查过）不拦——查询失败不应误伤可用账号
  assert.equal(isUsable({ ...base, minRemain: 200, creditRemain: null }), true);
  assert.equal(isUsable({ ...base, minRemain: 200 }), true);
  // 未设下限 / 下限为 0 → 不拦
  assert.equal(isUsable({ ...base, creditRemain: 0 }), true);
  assert.equal(isUsable({ ...base, minRemain: 0, creditRemain: 0 }), true);
  // 下限不改变其余可用性判定（禁用仍禁用）
  assert.equal(isUsable({ ...base, minRemain: 1, enabled: false }), false);
});

test('stickyKeyOf：多轮对话的首条 user 消息给出稳定会话键', async () => {
  const { stickyKeyOf } = await import('../src/pool.mjs');
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: '帮我写个爬虫' }];
  const k1 = stickyKeyOf(msgs);
  const k2 = stickyKeyOf([...msgs, { role: 'assistant', content: '好的' }, { role: 'user', content: '继续' }]);
  assert.equal(k1, k2, '多轮对话追加消息后键必须不变');
  assert.equal(stickyKeyOf([{ role: 'user', content: '另一个任务' }]) === k1, false);
  assert.equal(stickyKeyOf([]), null);
  assert.equal(stickyKeyOf(undefined), null);
});

test('stickyPick/stickyRemember：TTL 内命中、候选外重选、滑动续期', async () => {
  const { stickyPick, stickyRemember } = await import('../src/pool.mjs');
  const cands = [{ id: 'acc_a' }, { id: 'acc_b' }];
  stickyRemember('cn-cli', 'k1', 'acc_a', 1000);
  assert.equal(stickyPick('cn-cli', 'k1', cands, 2000).id, 'acc_a');
  assert.equal(stickyPick('cn-cli', 'k1', [{ id: 'acc_b' }], 3000), null, '绑定账号不在候选里 → 解除绑定');
  stickyRemember('cn-cli', 'k2', 'acc_b', 1000);
  assert.equal(stickyPick('cn-cli', 'k2', cands, 1000 + 30 * 60_000 + 1), null, 'TTL 过期解除');
});

test('orderAccounts：balanced 加权随机偏向闲置久（rand 注入）', async () => {
  const { orderAccounts } = await import('../src/expiry.mjs');
  const now = 10 * 60_000;
  const idle = { id: 'idle', lastUsedAt: 0 };          // 闲置 10 分钟
  const busy = { id: 'busy', lastUsedAt: now - 30_000 }; // 刚用过（0.5 分钟）
  // 加权随机：idle 闲置 10 分钟权重 11/21（大头），busy 刚用过权重 10/21。
  // rand=0 → roll=0 落在第一个累计区间（idle，权重最大的排前面）；rand≈1 → 落到最后（busy）。
  const r0 = orderAccounts([idle, busy], { policy: 'balanced', now, rand: () => 0 });
  const r9 = orderAccounts([idle, busy], { policy: 'balanced', now, rand: () => 0.99 });
  assert.equal(r0[0].id, 'idle', 'roll=0 命中权重最大的闲置久账号');
  assert.equal(r9[0].id, 'busy', 'roll≈1 落在最小权重区间（刚用过的）');
  assert.equal(r0.length, 2, '不丢账号');
});
