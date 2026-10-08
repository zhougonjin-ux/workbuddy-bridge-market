// 0.3.33：促销徽标解析 / 模型级限流冷却 / 观测成本 / 有效倍率后缀 / Retry-After 解析。
// 隔离纪律与 ratelimit.test.mjs 同款：setConfigDir 指向临时目录，绝不碰生产数据目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBadges, parseRetryAfter } from '../src/upstream.mjs';
import { markFailure, markSuccess, listModelCooldownAccounts, isModelRateLimited, getAccount } from '../src/pool.mjs';
import { recordUsage, observedCostByModel, usageDays, estimateCredit } from '../src/usage.mjs';
import { effectiveSuffixText } from '../src/router.mjs';
import { setConfigDir } from '../src/config.mjs';

/* ==================== 促销徽标解析 ==================== */

test('parseBadges：badge:<文案>:<色> 取文案，非 badge 前缀跳过', () => {
  assert.deepEqual(
    parseBadges(['craft', 'badge:限时免费:#FF0000']),
    ['限时免费'],
  );
  assert.deepEqual(
    parseBadges(['craft', 'badge:夜间免费:#FF0000', 'badge:错峰使用:#00FF00']),
    ['夜间免费', '错峰使用'],
  );
  assert.deepEqual(parseBadges(['craft']), [], '无 badge 项 → 空数组');
  assert.deepEqual(parseBadges(null), [], 'tags 缺失 → 空数组');
  assert.deepEqual(parseBadges(undefined), [], 'tags undefined → 空数组');
  assert.deepEqual(parseBadges(['badge:']), [], '空文案的 badge 项跳过');
});

test('parseBadges：异常数据最多收 4 条，防撑爆展示', () => {
  const tags = Array.from({ length: 10 }, (_, i) => `badge:P${i}:#FFF`);
  assert.equal(parseBadges(tags).length, 4);
});

/* ==================== 模型级限流冷却 ==================== */

// 池逻辑读写数据目录：切临时目录（与生产池零接触，2026-10-03 污染事故的教训）
function withTempPool(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mcool-'));
  const restore = setConfigDir(dir);
  try {
    fn(dir);
    return null;
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedPool(dir, site = 'testmc') {
  fs.writeFileSync(path.join(dir, `auth.${site}.pool.json`), JSON.stringify({
    accounts: [
      { id: 'acc_a', label: 'A', enabled: true, accessToken: 'tk', failCount: 0 },
      { id: 'acc_b', label: 'B', enabled: true, accessToken: 'tk', failCount: 0 },
    ],
  }));
}

const RATE_LIMIT_BODY = '{"code":14003,"msg":"too many requests"}';

test('markFailure 带 model：限流类失败记 (账号,模型) 冷却，缺省 60s', () => {
  withTempPool((dir) => {
    seedPool(dir);
    const t0 = Date.now();
    markFailure('testmc', 'acc_a', { status: 429, message: RATE_LIMIT_BODY, model: 'hy4-preview' });
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'auth.testmc.pool.json'), 'utf8')).accounts[0];
    assert.ok(a.modelCooldowns?.['hy4-preview'], '模型冷却条目必须存在');
    const until = a.modelCooldowns['hy4-preview'].until;
    assert.ok(until >= t0 + 59_000 && until <= t0 + 61_000, `缺省 60s（实际 ${until - t0}ms）`);
    // 账号级冷却同时生效（0.3.32 行为保留）
    assert.ok(a.cooldownUntil > t0, '账号级短冷却仍在');
    assert.equal(a.exhaustedAt ?? null, null, '限流不打额度耗尽');
  });
});

test('markFailure 带 modelCooldownMs：Retry-After 优先于缺省值', () => {
  withTempPool((dir) => {
    seedPool(dir);
    const t0 = Date.now();
    markFailure('testmc', 'acc_a', { status: 429, message: RATE_LIMIT_BODY, model: 'm1', modelCooldownMs: 120_000 });
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'auth.testmc.pool.json'), 'utf8')).accounts[0];
    const until = a.modelCooldowns.m1.until;
    assert.ok(until >= t0 + 119_000 && until <= t0 + 121_000, `Retry-After 的 120s 生效（实际 ${until - t0}ms）`);
  });
});

test('listModelCooldownAccounts：只列冷却中的账号，支持 exclude', () => {
  withTempPool((dir) => {
    seedPool(dir);
    markFailure('testmc', 'acc_a', { status: 429, message: RATE_LIMIT_BODY, model: 'hy4-preview' });
    assert.deepEqual(listModelCooldownAccounts('testmc', 'hy4-preview'), ['acc_a'],
      '只有吃到限流的 acc_a 在冷却');
    assert.deepEqual(listModelCooldownAccounts('testmc', 'hy4-preview', ['acc_a']), [],
      '已试过的账号被 exclude');
    assert.deepEqual(listModelCooldownAccounts('testmc', 'other-model'), [],
      '其他模型不受影响（限流是 (账号,模型) 维度）');
    assert.deepEqual(listModelCooldownAccounts('testmc', ''), [], '空 model 直接返回空');
  });
});

test('markSuccess 带 model：一次成功即解除该模型的限流冷却', () => {
  withTempPool((dir) => {
    seedPool(dir);
    markFailure('testmc', 'acc_a', { status: 429, message: RATE_LIMIT_BODY, model: 'hy4-preview' });
    markSuccess('testmc', 'acc_a', 'hy4-preview');
    assert.equal(isModelRateLimited({ modelCooldowns: { 'hy4-preview': { until: Date.now() + 60_000 } } }, 'hy4-preview'), true,
      'isModelRateLimited 基本判定（未过期 → true）');
    // markSuccess 是延迟落盘（2s 节流），断言内存态而不是磁盘文件
    const a = getAccount('testmc', 'acc_a');
    assert.equal(a.modelCooldowns?.['hy4-preview'] ?? null, null, '成功后冷却解除（内存态）');
    assert.deepEqual(listModelCooldownAccounts('testmc', 'hy4-preview'), []);
  });
});

test('applyFailure：标记新冷却时顺手清掉已过期的旧条目（防池子堆死数据）', () => {
  withTempPool((dir) => {
    seedPool(dir);
    // 直接种一条已过期的旧冷却
    const poolPath = path.join(dir, 'auth.testmc.pool.json');
    const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    pool.accounts[0].modelCooldowns = { old: { until: Date.now() - 1000, at: Date.now() - 61_000 } };
    fs.writeFileSync(poolPath, JSON.stringify(pool));
    markFailure('testmc', 'acc_a', { status: 429, message: RATE_LIMIT_BODY, model: 'new' });
    const a = JSON.parse(fs.readFileSync(poolPath, 'utf8')).accounts[0];
    assert.equal(a.modelCooldowns.old ?? null, null, '过期条目被清');
    assert.ok(a.modelCooldowns.new, '新条目存在');
  });
});

/* ==================== 观测成本 ==================== */

test('observedCostByModel：最近一次实际计费（不是日均值）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-obs-'));
  const restore = setConfigDir(dir);
  try {
    // 0.3.37：只有上游实报（upstreamCredit，含 0）才进观测样本；估算值不写 lastCredit
    recordUsage({ site: 'cn-cli', model: 'hy4-preview', status: 200, promptTokens: 10, completionTokens: 1, credit: 0.29, account: 'acc_a', upstreamCredit: 0.29 });
    // 夜间免费时段再来一发：日均值会被稀释成 ~0.19，观测值必须是最近一次的 0
    recordUsage({ site: 'cn-cli', model: 'hy4-preview', status: 200, promptTokens: 10, completionTokens: 1, credit: 0, account: 'acc_a', upstreamCredit: 0 });
    recordUsage({ site: 'cn-cli', model: 'hy3', status: 200, promptTokens: 5, completionTokens: 1, credit: 0, account: 'acc_a', upstreamCredit: 0 });
    // 无实报（上游没发 usage 帧）→ 估算 0 不得污染观测样本
    recordUsage({ site: 'cn-cli', model: 'hy5-estimated', status: 200, promptTokens: 10, completionTokens: 1, credit: 0, account: 'acc_a' });

    const obs = observedCostByModel();
    assert.equal(obs['cn-cli/hy4-preview'].credit, 0, '观测取最近一次实付（0），不是日均值');
    assert.equal(obs['cn-cli/hy3'].credit, 0);
    assert.equal(obs['cn-cli/hy5-estimated'], undefined, '估算 0 不是实报，不进观测');
    assert.ok(obs['cn-cli/hy4-preview'].at > Date.now() - 60_000, '带观测时间');
    assert.equal(obs['cn-cli/不存在'], undefined);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observedCostByModel：TTL 之外的观测被淘汰（时段促销不跨窗）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-obs2-'));
  const restore = setConfigDir(dir);
  try {
    recordUsage({ site: 'cn-cli', model: 'paid-model', status: 200, promptTokens: 10, completionTokens: 1, credit: 0, account: 'acc_a', upstreamCredit: 0 });
    // 把内存态的 lastAt 拨回 7 小时前（模拟「上次观测在另一个时段」）——
    // 直接改 usageDays() 的活对象：落盘是 2 秒节流延迟写，读盘断言会撞空。
    const days = usageDays();
    const dayKey = Object.keys(days).pop();
    days[dayKey].models['cn-cli/paid-model'].lastAt = Date.now() - 7 * 3600e3;
    const obs = observedCostByModel();
    assert.equal(obs['cn-cli/paid-model'], undefined, '7h 前的观测超过 6h TTL → 不再采信');
    assert.equal(observedCostByModel(8 * 3600e3)['cn-cli/paid-model'].credit, 0, '放大 TTL 后可见（参数生效）');
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ==================== 有效倍率后缀 ==================== */

test('effectiveSuffixText：观测免费只在「目录倍率>0」时采信（防 estimate-0 误判）', () => {
  // 目录说付费（x0.29）+ 实测 0 → 夜间免费，后缀 (免费)
  assert.equal(effectiveSuffixText(0.29, { credit: 0, at: Date.now() }), ' (免费)');
  // 目录本来就是 0 → 恒 (免费)
  assert.equal(effectiveSuffixText(0, null), ' (免费)');
  assert.equal(effectiveSuffixText(0, { credit: 0.5, at: Date.now() }), ' (免费)', '目录 0 优先于观测');
  // 无观测 → 目录倍率原样
  assert.equal(effectiveSuffixText(0.29, null), ' (x0.29)');
  // 目录倍率未知（Infinity，estimateCredit 目录拉不到时也记 0）→ 不采信观测 0
  assert.equal(effectiveSuffixText(Number.POSITIVE_INFINITY, { credit: 0, at: Date.now() }), '');
});

/* ==================== estimateCredit：0 是有效实报（0.3.34 修） ==================== */

test('estimateCredit：上游实报 0 必须原样返回（夜间免费实扣就是 0，不得回落估算）', async () => {
  assert.equal(await estimateCredit({}, 's', 'm', 0, 10, 1), 0, '实报 0 → 0（旧守卫 >0 会估算出 2.9）');
  assert.equal(await estimateCredit({}, 's', 'm', 0.02, 10, 1), 0.02, '实报 0.02 原样返回');
  assert.equal(await estimateCredit({}, 's', 'm', undefined, 10, 1) >= 0, true, '没报 → 回落估算路径（不抛错）');
  assert.equal(await estimateCredit({}, 's', 'm', null, 10, 1) >= 0, true);
});

/* ============ estimateCredit：观测单价口径（0.3.40 修虚高 750 倍） ============ */
// 旧实现把目录倍率 x0.06 当「每 token 0.06 credit」估算，大 prompt 请求虚高 ~750 倍
// （2026-10-08 实录：两笔 38K tokens 各记 2280 分，当日 4574 分里 99.7% 是虚的）。
// 新口径：同模型当日 Σ实报credit ÷ Σtokens；无样本记 0。

test('estimateCredit：无观测样本时记 0，不再用倍率瞎猜', async () => {
  // 'no-sample-model' 当日没有任何 recordUsage 记录 → 无单价 → 必须记 0
  assert.equal(await estimateCredit({}, 'cn-cli', 'no-sample-model', undefined, 1_000_000, 1), 0);
});

test('estimateCredit：有实报样本后按观测单价估算', async () => {
  // 建立 10 笔实报样本：每笔 100 tokens 实报 0.01 → 单价 1e-4 credit/token
  for (let i = 0; i < 10; i++) {
    recordUsage({ site: 'cn-cli', model: 'unit-price-model', status: 200, promptTokens: 100, completionTokens: 0, credit: 0.01, account: 'acc_a', upstreamCredit: 0.01 });
  }
  // 一笔 50,000 tokens 的请求上游没报 usage → 50000 × 1e-4 = 5.0
  const est = await estimateCredit({}, 'cn-cli', 'unit-price-model', undefined, 50_000, 0);
  assert.ok(Math.abs(est - 5.0) < 1e-9, `观测单价估算 5.0（实际 ${est}）`);
  // 旧口径会是 50000 × 0.06 = 3000 —— 虚高 600 倍
});

test('estimateCredit：全 0 实报样本（夜间免费）单价仍为 0，不猜正值', async () => {
  for (let i = 0; i < 5; i++) {
    recordUsage({ site: 'cn-cli', model: 'free-model', status: 200, promptTokens: 100, completionTokens: 0, credit: 0, account: 'acc_a', upstreamCredit: 0 });
  }
  assert.equal(await estimateCredit({}, 'cn-cli', 'free-model', undefined, 10_000, 0), 0);
});

/* ==================== Retry-After 解析 ==================== */

test('parseRetryAfter：秒数 / HTTP 日期 / 非法值', () => {
  assert.equal(parseRetryAfter('30'), 30);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('soon'), null);
  const future = new Date(Date.now() + 10_000).toUTCString();
  const v = parseRetryAfter(future);
  assert.ok(v >= 8 && v <= 10, `HTTP 日期折算成秒（实际 ${v}）`);
  const past = new Date(Date.now() - 10_000).toUTCString();
  assert.equal(parseRetryAfter(past), 0, '过去的日期收敛为 0');
});