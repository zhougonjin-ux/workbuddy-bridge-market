// 限流不再被误判成「额度耗尽」——回归 2026-10-05 真实事故：
// 上游 HTTP 429 + 业务码 14003（too many requests / displayMsg「模型繁忙，请换模型或稍后重试」）
// 曾被 isQuotaError 的 `status === 429` 一律当成额度用完，给账号打上 6 小时 exhaustedAt，
// 在 pinned 策略下把该号雪藏，请求全部落到另一个余额更少的账号上。
//
// 判据原则（与 scheduler.mjs 的 `credit.remain <= 0 → markExhausted` 分工）：
//   限流 = 账号活着，只是此刻太密 → 短窗冷却，不打耗尽标记
//   余额 = 轮询可确证的硬信号   → 由积分轮询判耗尽，不靠错误报文猜
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isQuotaError, isRateLimitError, markFailure, markSuccess, isUsable, getAccount } from '../src/pool.mjs';
import { setConfigDir } from '../src/config.mjs';

/* ==================== 事故原始报文（逐字照抄生产 lastError） ==================== */

const INCIDENT = '{"code":14003,"msg":"too many requests","requestId":"ded36f518f3d98e39ab964e24bd16a7d",'
  + '"displayMsg":{"en":"Model busy. Please switch models or retry later",'
  + '"zh":"模型繁忙，请换模型或稍后重试"}}';

/* ==================== 限流不再判额度耗尽 ==================== */

test('isQuotaError：14003 限流不算额度耗尽（事故根因）', () => {
  assert.equal(isQuotaError(429, INCIDENT), false,
    '余额 4978 的账号被 14003 打成耗尽——这正是本次要修的');
  assert.equal(isQuotaError(429, '{"code":14003,"msg":"too many requests"}'), false);
});

test('isRateLimitError：认得 14003 与 too many requests', () => {
  assert.equal(isRateLimitError(429, INCIDENT), true);
  assert.equal(isRateLimitError(429, 'too many requests'), true);
  assert.equal(isRateLimitError(0, '{"code":14003,"msg":"too many requests"}'), true,
    '上游也会在 200 里回 14003');
  assert.equal(isRateLimitError(429, 'rate limit exceeded'), true);
  assert.equal(isRateLimitError(429, '请求过于频繁'), true);
});

test('isRateLimitError：裸 429 空报文按限流处理', () => {
  assert.equal(isRateLimitError(429, ''), true, '429 无任何额度语义 → 限流');
  assert.equal(isRateLimitError(429, 'upstream busy'), true);
});

test('429 夹带额度措辞仍按限流处理（状态码比文案权威）', () => {
  assert.equal(isQuotaError(429, 'quota exceeded, please wait'), false,
    '上游 429 的 body 常夹带跨计费/限流的措辞，按硬额度会白扔号约 12h');
  assert.equal(isQuotaError(429, '额度不足，请稍后'), false);
});

test('真·额度不足仍被判耗尽（不能误伤）', () => {
  assert.equal(isQuotaError(402, ''), true, '402 是最硬的计费耗尽信号');
  assert.equal(isQuotaError(429, '{"code":14018,"msg":"credits exhausted"}'), true,
    '14018 = 明确的账号积分耗尽，优先于 429 的限流兜底');
  assert.equal(isQuotaError(200, '{"code":14002,"msg":"quota exceeded"}'), true,
    '非 429 状态码的额度措辞仍算耗尽');
  assert.equal(isQuotaError(0, 'quota exceeded'), true);
  assert.equal(isQuotaError(403, '额度不足'), true);
  assert.equal(isQuotaError(402, 'anything'), true, '402 优先于一切文案');
});

test('真·额度不足不会被 isRateLimitError 误摘', () => {
  assert.equal(isRateLimitError(402, ''), false);
  assert.equal(isRateLimitError(429, '{"code":14018,"msg":"credits exhausted"}'), false,
    '14018 是硬额度，不能退化成软限流');
  assert.equal(isRateLimitError(429, '额度不足'), true,
    '裸 429 夹带额度措辞仍按限流——这正是参考实现刻意的取舍');
});

test('账号级终态等不来自愈，不能按限流短冷却', () => {
  assert.equal(isRateLimitError(429, '{"code":14017,"msg":"trial not activated"}'), false,
    '未激活试用等不来，继续重试只会刷风控');
  assert.equal(isRateLimitError(429, 'request illegal'), false);
  assert.equal(isRateLimitError(401, '{"code":12153,"msg":"Offline user session not found"}'), false);
});

/* ==================== 打标副作用：限流不打 exhaustedAt ==================== */

// 池逻辑会读写数据目录，这里切到临时目录，绝不碰生产池（见 2026-10-03 污染事故）。
// 注意 markSuccess 是延迟落盘（SAVE_DELAY_MS=2s），断言内存态而非磁盘文件。
function withTempPool(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rl-'));
  const restore = setConfigDir(dir);
  try {
    fn(dir);
    return getAccount('testrl', 'acc_a');
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedPool(dir) {
  fs.writeFileSync(path.join(dir, 'auth.testrl.pool.json'), JSON.stringify({
    accounts: [{ id: 'acc_a', label: 'A', enabled: true, accessToken: 'tk', failCount: 0 }],
  }));
}

test('markFailure：14003 只短冷却，不写 exhaustedAt', () => {
  const a = withTempPool((dir) => {
    seedPool(dir);
    markFailure('testrl', 'acc_a', { status: 429, message: INCIDENT });
  });

  assert.equal(a.exhaustedAt ?? null, null, '限流不得打额度耗尽标记');
  assert.ok(a.cooldownUntil > Date.now(), '应当进入冷却');
  assert.ok(a.cooldownUntil - Date.now() <= 30_000, '限流冷却是短窗（≤30s），不随失败次数增长');
});

test('markFailure：真·额度不足仍写 exhaustedAt（保留原行为）', () => {
  const a = withTempPool((dir) => {
    seedPool(dir);
    markFailure('testrl', 'acc_a', { status: 402, message: '' });
  });

  assert.ok(a.exhaustedAt, '真耗尽必须打标记');
  assert.equal(a.cooldownUntil ?? null, null, '耗尽走长 TTL，不走冷却阶梯');
});

test('限流冷却到期后账号自动恢复可用（不似耗尽需等 6 小时）', () => {
  const now = Date.now();
  const 限流后 = { enabled: true, accessToken: 'tk', cooldownUntil: now + 30_000, failCount: 1 };
  assert.equal(isUsable(限流后, now), false, '冷却中不可用');
  assert.equal(isUsable(限流后, now + 31_000), true, '冷却一过立刻恢复');

  const 误判耗尽 = { ...限流后, cooldownUntil: null, exhaustedAt: now };
  assert.equal(isUsable(误判耗尽, now + 31_000), false, '耗尽标记要挂满 6 小时 TTL——这正是原 bug 的代价');
  assert.equal(isUsable(误判耗尽, now + 6 * 3600e3 + 1000), true);
});

test('markSuccess：一次成功即解除耗尽与冷却（存量误标可自愈）', () => {
  const a = withTempPool((dir) => {
    seedPool(dir);
    markFailure('testrl', 'acc_a', { status: 429, message: INCIDENT });
    markSuccess('testrl', 'acc_a');
  });

  assert.equal(a.exhaustedAt ?? null, null);
  assert.equal(a.cooldownUntil ?? null, null);
  assert.equal(a.failCount, 0);
  assert.equal(isUsable(a), true);
});

test('存量误标可自愈：带 6h exhaustedAt 的账号被选中成功后清除标记', () => {
  const a = withTempPool((dir) => {
    seedPool(dir);
    markFailure('testrl', 'acc_a', { status: 402, message: '' }); // 先误标成耗尽
    markSuccess('testrl', 'acc_a');
  });

  assert.equal(a.exhaustedAt ?? null, null, '一次成功即证明额度可用，误标必须解除');
  assert.equal(isUsable(a), true);
});