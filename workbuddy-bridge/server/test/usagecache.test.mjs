// 0.3.55 缓存命中统计（借鉴 dsh 数据看板）的回归测试
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.WB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-usagecache-test-'));
const { recordUsage, usageSnapshot, resetUsage } = await import('../src/usage.mjs');
import test from 'node:test';
import assert from 'node:assert/strict';

test('recordUsage：cacheHitTokens 进当日与模型维度，快照 today/totals/byModel 都暴露', () => {
  recordUsage({ site: 'cn-cli', model: 'glm-5.3-flash', mode: 'stream', status: 200, promptTokens: 1000, completionTokens: 50, cacheHitTokens: 800, account: 'acc_x' });
  recordUsage({ site: 'cn-cli', model: 'glm-5.3-flash', mode: 'stream', status: 200, promptTokens: 500, completionTokens: 20, cacheHitTokens: 300, account: 'acc_x' });
  recordUsage({ site: 'cn-cli', model: 'hy3', mode: 'stream', status: 200, promptTokens: 200, completionTokens: 10, cacheHitTokens: 0, account: 'acc_x' });
  // 不传 cacheHitTokens（老调用点/旧路径）= 0，不产生 NaN
  recordUsage({ site: 'cn-cli', model: 'hy3', mode: 'json', status: 200, promptTokens: 100, completionTokens: 5, account: 'acc_x' });

  const snap = usageSnapshot(1);
  assert.equal(snap.today.cacheHitTokens, 1100);
  const glm = snap.todayByModel.find((m) => m.model === 'glm-5.3-flash');
  assert.equal(glm.cacheHitTokens, 1100);
  const glmAll = snap.byModel.find((m) => m.model === 'glm-5.3-flash');
  assert.equal(glmAll.cacheHitTokens, 1100);
  assert.ok(Number.isFinite(snap.totals.cacheHitTokens));
  // 命中率可由前端口径直接推导：1100 / 1800
  assert.ok(snap.today.promptTokens >= 1800);
  resetUsage();
});
