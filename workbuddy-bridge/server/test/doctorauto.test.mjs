// T67 每日自动体检：调度语义（时点/补跑/当天一次）与通知触发条件（有 fail 才响）。
// 全部依赖注入（diagnose/sendNotify/fireEvent/stateFile/hasAccount 指向临时目录与假件），
// 绝不碰生产数据目录、绝不发真实通知或上游请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doctorAutoTick } from '../src/doctor.mjs';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-doctor-'));

// 星期锚点：2026-10-07 是周三；D('2026-10-07T09:59') → 时点 10:00 前一分钟
const D = (s) => new Date(s);
const baseCfg = (times = ['10:00']) => ({ port: 8788, tasks: { doctorTimes: times } });

const report = (levels) => ({
  at: '2026-10-07T10:00:00.000Z',
  version: '0.0.0-test',
  summary: {
    pass: levels.filter((l) => l === 'pass').length,
    warn: levels.filter((l) => l === 'warn').length,
    fail: levels.filter((l) => l === 'fail').length,
  },
  checks: levels.map((l, i) => ({ name: `检查${i}`, level: l, detail: `详情${i}` })),
});

test('doctorTimes 空数组 = 关闭', async () => {
  const r = await doctorAutoTick(baseCfg([]), D('2026-10-07T10:05:00'), { hasAccount: () => true });
  assert.equal(r.skipped, 'disabled');
});

test('没有任何账号时跳过（裸服务不该天天误报）', async () => {
  const r = await doctorAutoTick(baseCfg(), D('2026-10-07T10:05:00'), { hasAccount: () => false });
  assert.equal(r.skipped, 'no-account');
});

test('时点未到不跑；恰好到点（>=）就跑', async () => {
  const early = await doctorAutoTick(baseCfg(), D('2026-10-07T09:59:00'), { hasAccount: () => true });
  assert.equal(early.skipped, 'not-time');
  const fired = [];
  const onTime = await doctorAutoTick(baseCfg(), D('2026-10-07T10:00:00'), {
    hasAccount: () => true,
    diagnose: async () => report(['pass', 'pass']),
    fireEvent: (kind, text) => fired.push(text),
    stateFile: path.join(mkTmp(), 'doctor.json'),
  });
  assert.equal(onTime.ok, true);
  assert.match(fired[0], /每日体检通过/);
});

test('时点已过 + 今天没跑过 → 补跑；有 fail 项才通知，正文列出异常项', async () => {
  const file = path.join(mkTmp(), 'doctor.json');
  const notes = [];
  const events = [];
  const r = await doctorAutoTick(baseCfg(), D('2026-10-07T14:00:00'), {
    hasAccount: () => true,
    diagnose: async () => report(['pass', 'fail', 'warn', 'fail']),
    sendNotify: (cfg, title, text) => notes.push({ title, text }),
    fireEvent: (kind, text) => events.push(text),
    stateFile: file,
  });
  assert.equal(r.ok, true);
  assert.equal(r.notified, true);
  assert.deepEqual(r.fails, ['检查1', '检查3']);
  assert.match(notes[0].title, /每日体检 🔴 2 项异常/);
  assert.match(notes[0].text, /检查1：详情1；检查3：详情3/);
  assert.match(events[0], /每日体检：2\/4 项异常/);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(st.lastRun, '2026-10-07');
  assert.deepEqual(st.failNames, ['检查1', '检查3']);
});

test('同一天不重复跑（不重复通知）；昨天跑过今天没跑 → 正常补跑', async () => {
  const dir = mkTmp();
  const file = path.join(dir, 'doctor.json');
  const diagnose = async () => report(['pass']);
  let notes = 0;
  const deps = {
    hasAccount: () => true,
    diagnose,
    sendNotify: () => { notes++; },
    fireEvent: () => {},
    stateFile: file,
  };
  const first = await doctorAutoTick(baseCfg(), D('2026-10-07T10:00:00'), deps);
  assert.equal(first.ok, true);
  const second = await doctorAutoTick(baseCfg(), D('2026-10-07T18:00:00'), deps);
  assert.equal(second.skipped, 'already-run');
  assert.equal(notes, 0); // 全绿不通知
  // 换一天（状态文件还在）：时点已过 → 再次执行
  const nextDay = await doctorAutoTick(baseCfg(), D('2026-10-08T10:01:00'), deps);
  assert.equal(nextDay.ok, true);
});

test('有 fail 的那天，第二次 tick（already-run）也不再重复通知', async () => {
  const file = path.join(mkTmp(), 'doctor.json');
  let notes = 0;
  const deps = {
    hasAccount: () => true,
    diagnose: async () => report(['fail']),
    sendNotify: () => { notes++; },
    fireEvent: () => {},
    stateFile: file,
  };
  await doctorAutoTick(baseCfg(), D('2026-10-07T10:00:00'), deps);
  await doctorAutoTick(baseCfg(), D('2026-10-07T10:01:00'), deps);
  assert.equal(notes, 1);
});

test('通知抛错不绊倒体检（状态照常落盘）', async () => {
  const file = path.join(mkTmp(), 'doctor.json');
  const r = await doctorAutoTick(baseCfg(), D('2026-10-07T10:00:00'), {
    hasAccount: () => true,
    diagnose: async () => report(['fail']),
    sendNotify: () => { throw new Error('boom'); },
    fireEvent: () => {},
    stateFile: file,
  });
  assert.equal(r.ok, true);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(st.lastRun, '2026-10-07');
});
