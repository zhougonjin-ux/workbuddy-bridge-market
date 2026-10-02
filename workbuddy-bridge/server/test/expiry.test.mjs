// workbuddy-bridge 调度单元测试：到期解析 + 各策略选号排序。
// 运行：node --test server/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUpstreamDateTime,
  packageExpireAt,
  normalizeCreditDetail,
  accountEarliestExpiry,
  accountRemaining,
  orderAccounts,
  suggestedPlan,
} from '../src/expiry.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-02T12:00:00');

test('parseUpstreamDateTime：上游 "YYYY-MM-DD HH:mm:ss"（本机时区）', () => {
  const t = parseUpstreamDateTime('2026-10-15 00:00:00');
  assert.equal(t, new Date(2026, 9, 15, 0, 0, 0).getTime());
});

test('parseUpstreamDateTime：纯日期 / ISO / 秒与毫秒时间戳', () => {
  assert.equal(parseUpstreamDateTime('2026-10-15'), new Date(2026, 9, 15).getTime());
  assert.equal(parseUpstreamDateTime('2026-10-15T08:30:00Z'), Date.parse('2026-10-15T08:30:00Z'));
  assert.equal(parseUpstreamDateTime(1_800_000_000), 1_800_000_000_000); // 秒
  assert.equal(parseUpstreamDateTime('1800000000000'), 1_800_000_000_000); // 毫秒串
});

test('parseUpstreamDateTime：脏数据一律返回 null，绝不抛错', () => {
  for (const bad of ['', '   ', 'abc', null, undefined, '2026-13-99 00:00:00x']) {
    assert.equal(parseUpstreamDateTime(bad), null, String(bad));
  }
});

test('packageExpireAt：CycleEndTime 优先，PackageEndTime 兜底', () => {
  const a = packageExpireAt({ CycleEndTime: '2026-10-10 00:00:00', PackageEndTime: '2026-12-01 00:00:00' });
  assert.equal(a, new Date(2026, 9, 10).getTime());
  const b = packageExpireAt({ PackageEndTime: '2026-12-01 00:00:00' });
  assert.equal(b, new Date(2026, 11, 1).getTime());
  assert.equal(packageExpireAt({}), null);
});

test('normalizeCreditDetail：字段规整 + 余额', () => {
  const d = normalizeCreditDetail([
    { PackageName: '月度礼包', CycleCapacitySize: 100, CycleCapacityRemain: 60, CycleCapacityUsed: 40, CycleEndTime: '2026-10-10 00:00:00' },
    { PackageName: '存量包', CapacityRemain: 5 },
  ]);
  assert.equal(d.length, 2);
  assert.deepEqual([d[0].remain, d[1].remain], [60, 5]);
  assert.ok(d[0].expireAt);
  assert.equal(d[1].expireAt, null);
});

test('accountEarliestExpiry：未来批次取最早，过期批次忽略，manualExpireAt 更早则用它', () => {
  const future1 = NOW + 3 * DAY;
  const future2 = NOW + 10 * DAY;
  const a = {
    creditDetail: [
      { remain: 50, expireAt: future2 },
      { remain: 30, expireAt: future1 },
      { remain: 20, expireAt: NOW - DAY }, // 已过期 → 不算
      { remain: 0, expireAt: NOW + DAY },  // 余额 0 → 不算
    ],
  };
  assert.equal(accountEarliestExpiry(a, NOW), future1);

  const b = { creditDetail: [{ remain: 50, expireAt: future2 }], manualExpireAt: NOW + DAY };
  assert.equal(accountEarliestExpiry(b, NOW), NOW + DAY);

  assert.equal(accountEarliestExpiry({}, NOW), null);
  assert.equal(accountEarliestExpiry({ creditDetail: [{ remain: 5 }] }, NOW), null);
});

test('accountRemaining：批次求和，无明细时回退缓存', () => {
  assert.equal(accountRemaining({ creditDetail: [{ remain: 1 }, { remain: 2 }] }), 3);
  assert.equal(accountRemaining({ creditRemain: 7 }), 7);
  assert.equal(accountRemaining({}), null);
});

const acc = (id, extra = {}) => ({ id, label: id, failCount: 0, lastUsedAt: 0, ...extra });

test('expiry-first：最早到期的账号排最前；无到期信息的排最后', () => {
  const soon = acc('soon', { creditDetail: [{ remain: 10, expireAt: NOW + DAY }] });
  const mid = acc('mid', { creditDetail: [{ remain: 100, expireAt: NOW + 5 * DAY }] });
  const none = acc('none', {});
  const manual = acc('manual', { manualExpireAt: NOW + 2 * DAY });
  const ordered = orderAccounts([none, mid, manual, soon], { policy: 'expiry-first', now: NOW });
  assert.deepEqual(ordered.map((a) => a.id), ['soon', 'manual', 'mid', 'none']);
});

test('expiry-first：同到期时间时先耗余额少的', () => {
  const small = acc('small', { creditDetail: [{ remain: 5, expireAt: NOW + DAY }] });
  const big = acc('big', { creditDetail: [{ remain: 50, expireAt: NOW + DAY }] });
  const ordered = orderAccounts([big, small], { policy: 'expiry-first', now: NOW });
  assert.deepEqual(ordered.map((a) => a.id), ['small', 'big']);
});

test('任何策略：耗尽/失败多的账号都排后面', () => {
  const dead = acc('dead', { exhaustedAt: NOW - 1000, creditDetail: [{ remain: 1, expireAt: NOW + DAY }] });
  const flaky = acc('flaky', { failCount: 3, creditDetail: [{ remain: 1, expireAt: NOW + DAY }] });
  const ok = acc('ok', { creditDetail: [{ remain: 1, expireAt: NOW + 30 * DAY }] });
  for (const policy of ['expiry-first', 'balance-first', 'round-robin']) {
    const ordered = orderAccounts([dead, flaky, ok], { policy, now: NOW });
    assert.equal(ordered[ordered.length - 1].id, 'dead', policy);
    assert.equal(ordered[ordered.length - 2].id, 'flaky', policy);
  }
});

test('pinned：固定账号排最前（即使到期更晚）；未配置 pinned 时回落 expiry-first', () => {
  const a = acc('a', { creditDetail: [{ remain: 10, expireAt: NOW + DAY }] });
  const b = acc('b', { creditDetail: [{ remain: 10, expireAt: NOW + 10 * DAY }] });
  assert.deepEqual(orderAccounts([a, b], { policy: 'pinned', pinnedAccountId: 'b', now: NOW }).map((x) => x.id), ['b', 'a']);
  assert.deepEqual(orderAccounts([a, b], { policy: 'pinned', pinnedAccountId: null, now: NOW }).map((x) => x.id), ['a', 'b']);
});

test('balance-first：余额多的先用；余额未知的排最后', () => {
  const a = acc('a', { creditDetail: [{ remain: 20 }] });
  const b = acc('b', { creditDetail: [{ remain: 80 }] });
  const c = acc('c', {});
  const ordered = orderAccounts([c, a, b], { policy: 'balance-first', now: NOW });
  assert.deepEqual(ordered.map((x) => x.id), ['b', 'a', 'c']);
});

test('round-robin：最久未用的先用', () => {
  const a = acc('a', { lastUsedAt: NOW - 1000 });
  const b = acc('b', { lastUsedAt: 0 });
  assert.deepEqual(orderAccounts([a, b], { policy: 'round-robin', now: NOW }).map((x) => x.id), ['b', 'a']);
});

test('suggestedPlan：按最早到期排序，禁用/耗尽靠后', () => {
  const a = acc('a', { creditDetail: [{ remain: 10, expireAt: NOW + 2 * DAY }] });
  const b = acc('b', { creditDetail: [{ remain: 10, expireAt: NOW + DAY }] });
  const c = acc('c', { enabled: false, creditDetail: [{ remain: 10, expireAt: NOW - DAY }] });
  const plan = suggestedPlan([c, a, b], { now: NOW });
  assert.deepEqual(plan.map((x) => x.id), ['b', 'a', 'c']);
  assert.equal(plan[0].earliestExpiry, NOW + DAY);
});
