// T46 用量周报：周一起点/聚合/文案/调度语义（含每周一次与 force 绕过）。
// 全部依赖注入（loadDays/fireEvent/sendNotify/stateFile 指向临时目录），绝不碰生产数据目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mondayOf, lastWeekRange, weeklySummary, renderWeeklyText, weeklyTick } from '../src/weekly.mjs';
import { validateConfig } from '../src/config.mjs';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-weekly-'));
// 星期锚点：2026-09-27 周日 · 2026-09-28 周一 · 2026-10-03 周六 · 2026-10-04 也是周六
const D = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const lkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('mondayOf：周一返回当天，周日回退到本周一', () => {
  assert.equal(lkey(mondayOf(D('2026-09-28'))), '2026-09-28');
  assert.equal(lkey(mondayOf(D('2026-09-27'))), '2026-09-21'); // 周日 → 本周一（前一周一）
  assert.equal(lkey(mondayOf(D('2026-09-30'))), '2026-09-28'); // 周三 → 本周一
});

test('lastWeekRange：上周一到上周日，恰好 7 天', () => {
  const a = lastWeekRange(D('2026-10-04')); // 周六：本周一 09-28，上周 09-21~09-27
  assert.equal(lkey(a.from), '2026-09-21');
  assert.equal(lkey(a.to), '2026-09-27');
  const b = lastWeekRange(D('2026-09-28')); // 周一当天：上周同样是 09-21~09-27
  assert.equal(lkey(b.from), '2026-09-21');
  assert.equal(lkey(b.to), '2026-09-27');
});

test('weeklySummary：只聚合范围内日期，模型/账号维度正确排序', () => {
  const days = {
    '2026-09-28': { calls: 10, errors: 1, promptTokens: 100, completionTokens: 200, credit: 1.5, models: { 'cn-cli/glm-a': { site: 'cn-cli', model: 'glm-a', calls: 10, credit: 1.5 } }, accounts: { 'cn-cli/acc1': { site: 'cn-cli', account: 'acc1', calls: 10, credit: 1.5 } } },
    '2026-09-29': { calls: 5, errors: 0, promptTokens: 50, completionTokens: 80, credit: 2.5, models: { 'cn-cli/glm-b': { site: 'cn-cli', model: 'glm-b', calls: 5, credit: 2.5 } }, accounts: { 'cn-cli/acc2': { site: 'cn-cli', account: 'acc2', calls: 5, credit: 2.5 } } },
    '2026-10-05': { calls: 99, errors: 9, promptTokens: 999, completionTokens: 999, credit: 99, models: {}, accounts: {} }, // 范围外（下周一）
  };
  const s = weeklySummary(days, { from: D('2026-09-28'), to: D('2026-10-04') });
  assert.equal(s.daysWithData, 2);
  assert.equal(s.totals.calls, 15);
  assert.equal(s.totals.errors, 1);
  assert.equal(s.totals.credit, 4);
  assert.equal(s.topModels[0].id, 'glm-b'); // 按积分降序
  assert.equal(s.byAccount.length, 2);
});

test('weeklySummary：空范围如实返回零值（不误报）', () => {
  const s = weeklySummary({}, { from: D('2026-09-28'), to: D('2026-10-04') });
  assert.equal(s.daysWithData, 0);
  assert.deepEqual(s.totals, { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0 });
  assert.equal(s.topModels.length, 0);
});

test('renderWeeklyText：包含汇总行与 Top5 结构', () => {
  const s = weeklySummary({
    '2026-09-28': { calls: 3, errors: 0, credit: 0.5, models: { 'cn-cli/glm-a': { site: 'cn-cli', model: 'glm-a', calls: 3, credit: 0.5 } }, accounts: {} },
  }, { from: D('2026-09-28'), to: D('2026-10-04') });
  const text = renderWeeklyText(s);
  assert.match(text, /2026-09-28 ~ 2026-10-04/);
  assert.match(text, /调用 3 次 · 请求错误 0 次 · 消耗 0\.5 积分/);
  assert.match(text, /按模型 Top5/);
  assert.match(text, /1\. glm-a（cn-cli）3 次 \/ 0\.5 分/);
});

test('weeklyTick：非周一 / 时点未命中 / 已发送 都跳过', async () => {
  const dir = mkTmp();
  const file = path.join(dir, 'weekly.json');
  const cfg = { weekly: { enabled: true, times: ['09:00'] } };
  const noop = () => {};
  const wed = D('2026-09-30'); wed.setHours(9, 0, 0, 0);
  assert.equal((await weeklyTick(cfg, wed, { stateFile: file, fireEvent: noop, sendNotify: noop })).skipped, 'not-monday');
  const monEarly = D('2026-09-28'); monEarly.setHours(8, 0, 0, 0);
  assert.equal((await weeklyTick(cfg, monEarly, { stateFile: file, fireEvent: noop, sendNotify: noop })).skipped, 'not-time');
  const mon = D('2026-09-28'); mon.setHours(9, 0, 0, 0);
  const r1 = await weeklyTick(cfg, mon, { stateFile: file, fireEvent: noop, sendNotify: noop });
  assert.equal(r1.ok, true);
  assert.equal((await weeklyTick(cfg, mon, { stateFile: file, fireEvent: noop, sendNotify: noop })).skipped, 'already-sent');
});

test('weeklyTick：周一错过时点（服务那一刻没活着）→ 下一个 tick 补发（0.3.37）', async () => {
  const dir = mkTmp();
  const file = path.join(dir, 'weekly.json');
  const cfg = { weekly: { enabled: true, times: ['09:00'] } };
  const noop = () => {};
  // 周一 09:07：09:00 的 tick 没赶上，但今天没发过 → 应补发而不是丢一周
  const monLate = D('2026-09-28'); monLate.setHours(9, 7, 0, 0);
  const r = await weeklyTick(cfg, monLate, { stateFile: file, fireEvent: noop, sendNotify: noop });
  assert.equal(r.ok, true, '已过时点且未发送应补发');
  // 补发后本周不再重复
  const again = D('2026-09-28'); again.setHours(18, 0, 0, 0);
  assert.equal((await weeklyTick(cfg, again, { stateFile: file, fireEvent: noop, sendNotify: noop })).skipped, 'already-sent');
});

test('weeklyTick：disabled 关闭 / force 绕过周几与时点 / 通知与事件被调用', async () => {
  const dir = mkTmp();
  const file = path.join(dir, 'weekly.json');
  assert.equal((await weeklyTick({ weekly: { enabled: false, times: [] } }, D('2026-09-28'), { stateFile: file, force: true })).skipped, 'disabled');
  const fired = [];
  const sat = D('2026-10-03'); sat.setHours(23, 10, 0, 0); // 周六深夜，force 也应照发
  const r = await weeklyTick({ weekly: { enabled: true, times: ['09:00'] } }, sat, {
    stateFile: file,
    force: true,
    loadDays: () => ({ '2026-09-28': { calls: 2, errors: 0, credit: 0.2, models: {}, accounts: {} } }),
    fireEvent: (kind, text) => fired.push(['event', kind, text]),
    sendNotify: (c, title, text) => fired.push(['notify', title, text]),
  });
  assert.equal(r.ok, true);
  assert.equal(fired.filter((x) => x[0] === 'event').length, 1);
  assert.equal(fired.filter((x) => x[0] === 'notify').length, 1);
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).lastSent, /^2026-\d\d-\d\d$/);
});

test('validateConfig：weekly.times 非法值回退为默认，合法值原样保留', () => {
  const bad = { weekly: { enabled: true, times: ['9点'] } };
  validateConfig(bad);
  assert.deepEqual(bad.weekly.times, ['09:00']);
  const ok = { weekly: { enabled: true, times: ['07:05', '21:00'] } };
  validateConfig(ok);
  assert.deepEqual(ok.weekly.times, ['07:05', '21:00']);
});
