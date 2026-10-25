// 0.3.57 今日收益按来源分账的回归测试
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.WB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-gainedtoday-test-'));
const { gainedTodayFrom, taskStatus } = await import('../src/tasks.mjs');
import test from 'node:test';
import assert from 'node:assert/strict';

const T = new Date().toISOString().slice(0, 10); // 与 todayKey() 同为本地日期的近似——本地时区晚间 UTC 会差一天，
// 所以用「今天的时间戳构造条目」再传同一 today 键，保证纯函数口径一致
const Y = '2000-01-01';

test('gainedTodayFrom：按来源分账、跨天只算今天、失败条目不计', () => {
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const history = [
    { kind: 'checkin', uid: 'a', at: nowIso, ok: true },
    { kind: 'checkin', uid: 'b', at: nowIso, ok: true },
    { kind: 'growth', uid: 'a', at: nowIso, ok: true, creditGained: 120, claimed: 3 },
    { kind: 'travel', uid: 'a', at: nowIso, ok: true, credit: 60 },
    { kind: 'travel', uid: 'b', at: nowIso, ok: true, credit: 0 }, // 领了但 0 积分：计 credit 不计次数
    { kind: 'streak', uid: 'a', at: nowIso, ok: true, creditGained: 70 },
    { kind: 'growth', uid: 'a', at: nowIso, ok: false, creditGained: 999 }, // 失败不计
    { kind: 'growth', uid: 'a', at: Y + 'T01:00:00.000Z', ok: true, creditGained: 500 }, // 别的日期不计
  ];
  const g = gainedTodayFrom(history, today);
  assert.equal(g.checkins, 2);
  assert.equal(g.growthCredit, 120);
  assert.equal(g.travelCredit, 60);
  assert.equal(g.streakCredit, 70);
  assert.equal(g.credit, 250);
  assert.equal(g.travels, 1);
  assert.equal(g.claims, 3);
});

test('gainedTodayFrom：空/畸形 history 全零不抛错', () => {
  const g = gainedTodayFrom(null, T);
  assert.equal(g.credit, 0);
  const g2 = gainedTodayFrom([null, {}, { kind: 'growth', at: 'x' }], T);
  assert.equal(g2.credit, 0);
});

test('taskStatus 暴露 gainedToday（与 history 同源推导）', () => {
  const st = taskStatus();
  assert.ok(st.gainedToday && typeof st.gainedToday.credit === 'number');
});
