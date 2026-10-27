// 0.3.64 数据看板（对齐 dsh-xdpool）：轮次/上游调用/轮失败统计口径 + /dashboard 聚合
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.WB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dash-test-'));
const { recordRound, recordRoundFailure, recordUpstreamCall, recordUsage, usageSnapshot, resetUsage } = await import('../src/usage.mjs');
const { requestLog, recentRequests, clearRequests } = await import('../src/log.mjs');
import test from 'node:test';
import assert from 'node:assert/strict';

test('看板口径：轮次/上游调用/轮失败 进当日与 totals，老数据缺字段不炸', () => {
  // 一次提问 → 1 轮 + 2 次上游调用（换号）+ 最终成功
  recordRound();
  recordUpstreamCall();
  recordUpstreamCall();
  recordUsage({ site: 'cn-cli', model: 'glm-5.3-flash', mode: 'stream', status: 200, promptTokens: 300, completionTokens: 60, account: 'acc_x' });
  // 另一轮失败
  recordRound();
  recordUpstreamCall();
  recordRoundFailure();
  recordUsage({ site: 'cn-cli', model: 'glm-5.3-flash', mode: 'json', status: 502, promptTokens: 0, completionTokens: 0, account: 'acc_y' });

  const snap = usageSnapshot(1);
  assert.equal(snap.today.rounds, 2);
  assert.equal(snap.today.upstreamCalls, 3);
  assert.equal(snap.today.roundFailures, 1);
  assert.equal(snap.totals.rounds, 2);
  assert.equal(snap.totals.upstreamCalls, 3);
  assert.equal(snap.totals.roundFailures, 1);
  assert.equal(snap.today.calls, 2);
  assert.equal(snap.today.errors, 1);
  resetUsage();
});

test('recentRequests 内存环：requestLog 入环、clearRequests 清空，不影响 usage 统计', () => {
  clearRequests();
  requestLog({ site: 'cn-cli', model: 'glm-5.3-flash', mode: 'stream', status: 200, ms: 1200, tok_s: '42.0', credit: 0.5, account: 'acc_x' });
  requestLog({ site: 'cn-cli', model: 'hy3', mode: 'json', status: 502, ms: 300, note: 'upstream_reject' });
  const list = recentRequests(50);
  assert.equal(list.length, 2);
  assert.equal(list[0].model, 'hy3'); // 新 → 旧
  assert.equal(list[0].note, 'upstream_reject');
  clearRequests();
  assert.equal(recentRequests(50).length, 0);
  resetUsage();
});
