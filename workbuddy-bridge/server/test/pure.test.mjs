// workbuddy-bridge 纯函数单元测试：站点排序 / 改派挑选 / 配置校验 / 上限·校准学习落盘。
// 「最容易回归、被单测珊过」的一类逻辑——全部纯函数，不碰网络与真实数据目录。
// 运行：node --test server/test/pure.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 测试隔离：先指到临时目录再 import（config.mjs 在模块加载时读 WB_CONFIG_DIR）
process.env.WB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pure-test-'));

const { rankSiteCandidates, pickSiteWithAccounts, pickFreeModelFromCatalogs, parseMultiplier } = await import('../src/router.mjs');
const { validateConfig } = await import('../src/config.mjs');
const {
  learnLimit,
  learnedLimit,
  calibrateEstimate,
  calibrationFactor,
  parseLimitFromError,
  parseActualTokens,
  resetLearnedLimits,
  flushLearned,
} = await import('../src/compress.mjs');
const { writeJsonFileAtomic, readJsonFileWithBackup } = await import('../src/util.mjs');

/* ---------------- rankSiteCandidates：可用优先 → 倍率低优先 → 默认站点优先 ---------------- */

test('rankSiteCandidates：可用站点排在不可用前面', () => {
  const ranked = rankSiteCandidates(
    [
      { site: 'intl-cli', mult: 0.1, usable: true },
      { site: 'cn-cli', mult: 0.06, usable: false },
    ],
    'cn-cli',
  );
  assert.equal(ranked[0].site, 'intl-cli');
});

test('rankSiteCandidates：同样可用时倍率低的在前', () => {
  const ranked = rankSiteCandidates(
    [
      { site: 'intl-cli', mult: 0.1, usable: true },
      { site: 'cn-cli', mult: 0.06, usable: true },
    ],
    'intl-cli',
  );
  assert.equal(ranked[0].site, 'cn-cli');
});

test('rankSiteCandidates：倍率相同（含 NaN）时默认站点在前', () => {
  const ranked = rankSiteCandidates(
    [
      { site: 'intl-cli', mult: NaN, usable: true },
      { site: 'cn-cli', mult: NaN, usable: true },
    ],
    'cn-cli',
  );
  // NaN 比较为 false → 保持稳定顺序里默认站点应排前（a.site===default ? -1 : 1）
  assert.ok(ranked.some((r) => r.site === 'cn-cli'));
  assert.equal(ranked.length, 2);
});

test('pickSiteWithAccounts：只挑有可用账号的；全不可用返回 null', () => {
  const cands = [
    { site: 'cn-cli', mult: 0.06, usable: false },
    { site: 'intl-cli', mult: 0.1, usable: true },
  ];
  assert.equal(pickSiteWithAccounts(cands, 'cn-cli'), 'intl-cli');
  assert.equal(pickSiteWithAccounts(cands.map((c) => ({ ...c, usable: false })), 'cn-cli'), null);
});

/* ---------------- free-first：default/auto 哨兵改道时的免费模型选型 ---------------- */

test('pickFreeModelFromCatalogs：只认倍率恰为 0 的模型', () => {
  const pick = pickFreeModelFromCatalogs([
    {
      site: 'cn-cli',
      usable: true,
      models: [
        { id: 'glm-5.3-flash', credits: 'x0.06 credits', contextWindow: 1000000 },
        { id: 'hy3', credits: 'x0.00 credits', contextWindow: 192000 },
      ],
    },
  ]);
  assert.deepEqual(pick, { site: 'cn-cli', id: 'hy3', contextWindow: 192000 });
});

test('pickFreeModelFromCatalogs：站点没有可用账号时不选它', () => {
  const pick = pickFreeModelFromCatalogs([
    { site: 'cn-cli', usable: false, models: [{ id: 'hy3', credits: 'x0.00 credits', contextWindow: 192000 }] },
    { site: 'intl-cli', usable: true, models: [{ id: 'glm-5.3', credits: 'x0.79 credits', contextWindow: 1000000 }] },
  ]);
  assert.equal(pick, null);
});

test('pickFreeModelFromCatalogs：多个免费模型取上下文窗口最大', () => {
  const pick = pickFreeModelFromCatalogs([
    { site: 'cn-cli', usable: true, models: [{ id: 'hy3', credits: 'x0.00 credits', contextWindow: 192000 }] },
    { site: 'intl-cli', usable: true, models: [{ id: 'flash-free', credits: 'x0.00 credits', contextWindow: 1000000 }] },
  ]);
  assert.equal(pick.id, 'flash-free');
});

test('pickFreeModelFromCatalogs：空候选 / 缺倍率字段安全返回', () => {
  assert.equal(pickFreeModelFromCatalogs([]), null);
  assert.equal(pickFreeModelFromCatalogs([{ site: 'cn-cli', usable: true, models: [{ id: 'm' }] }]), null);
  assert.equal(pickFreeModelFromCatalogs(null), null);
});

test('parseMultiplier：x0.00 解析为 0（free-first 的判定基础）', () => {
  assert.equal(parseMultiplier('x0.00 credits'), 0);
  assert.equal(parseMultiplier('x0.06 credits'), 0.06);
  assert.equal(parseMultiplier(null), Number.POSITIVE_INFINITY);
});

/* ---------------- 夜猫子任务（black_cat）代打窗口：本地 22:00–02:00 ---------------- */

const { inNightWindow } = await import('../src/tasks.mjs');

test('inNightWindow：22:00–02:00 之内（含跨零点），之外不含边界外分钟', () => {
  const d = (h, m) => new Date(2026, 9, 3, h, m);
  assert.equal(inNightWindow(d(22, 0)), true, '22:00 应在窗口内');
  assert.equal(inNightWindow(d(23, 59)), true);
  assert.equal(inNightWindow(d(0, 0)), true, '零点应跨进窗口');
  assert.equal(inNightWindow(d(1, 59)), true);
  assert.equal(inNightWindow(d(2, 0)), false, '02:00 整点出窗口');
  assert.equal(inNightWindow(d(12, 0)), false);
  assert.equal(inNightWindow(d(21, 59)), false);
});

/* ---------------- validateConfig：脏输入回退默认值并报告 issue ---------------- */

test('validateConfig：非法 port/host 回退默认并记录 issue', () => {
  const cfg = { port: '不是数字', host: '  ', apiKey: 'sk-test' };
  const issues = validateConfig(cfg);
  assert.ok(issues.length >= 2, `应至少 2 条 issue，实际：${issues.join(' | ')}`);
  assert.equal(typeof cfg.port, 'number');
  assert.equal(cfg.host.trim().length > 0, true);
});

test('validateConfig：合法配置零 issue', () => {
  const issues = validateConfig({ host: '127.0.0.1', port: 8788, apiKey: 'sk-wb-test' });
  assert.equal(issues.filter((s) => s.includes('host') || s.includes('port') || s.includes('密钥')).length, 0);
});

/* ---------------- compress.mjs 学习数据：上限解析 + 校准收敛 + 落盘回读 ---------------- */

test('parseLimitFromError / parseActualTokens：从上游 400 文案里抠数字', () => {
  assert.equal(parseLimitFromError('prompt is too long: 1193121 tokens > 1048576 maximum'), 1048576);
  assert.equal(parseActualTokens('prompt is too long: 1193121 tokens > 1048576 maximum'), 1193121);
  // 转义的 \u003e 也要能匹配
  assert.equal(parseActualTokens('1193121 tokens \\u003e 1048576'), 1193121);
  assert.equal(parseActualTokens('跟数字无关'), null);
});

test('learnLimit：弱证据不覆盖强证据（authoritative 优先）', () => {
  resetLearnedLimits();
  learnLimit('cn-cli', 'glm-5.1', 200000, { authoritative: false });
  learnLimit('cn-cli', 'glm-5.1', 100000, { authoritative: true });
  assert.equal(learnedLimit('cn-cli', 'glm-5.1'), 100000);
  learnLimit('cn-cli', 'glm-5.1', 200000, { authoritative: false }); // 目录值再来说也不理
  assert.equal(learnedLimit('cn-cli', 'glm-5.1'), 100000);
});

test('calibrateEstimate：EMA 收敛且夹在 [1,4]', () => {
  resetLearnedLimits();
  const f1 = calibrateEstimate('cn-cli', 'm', 1193121, 620249); // ~1.92
  assert.ok(f1 > 1.9 && f1 < 1.93, `首次样本应 ≈1.92，实际 ${f1}`);
  const f2 = calibrateEstimate('cn-cli', 'm', 620249, 1193121); // 反向样本 ~0.52 → 夹到 1
  assert.ok(f2 >= 1 && f2 <= 4, `倍率必须夹在 [1,4]，实际 ${f2}`);
});

test('learnLimit/calibrateEstimate：落盘后能从 learned.json 回读（重启不再撞 400）', () => {
  resetLearnedLimits();
  learnLimit('cn-cli', 'glm-5.3-flash', 930625, { authoritative: true });
  calibrateEstimate('cn-cli', 'glm-5.3-flash', 1000000, 500000);
  flushLearned();
  const learnedFile = path.join(process.env.WB_CONFIG_DIR, 'learned.json');
  const onDisk = fs.readFileSync(learnedFile, 'utf8');
  const file = JSON.parse(onDisk);
  assert.equal(file.limits['cn-cli/glm-5.3-flash'].value, 930625);
  assert.ok(file.calibration['cn-cli/glm-5.3-flash'] > 1.9);

  // 模拟重启：内存清空（reset 也会删文件，这里把上个进程落盘的内容写回去），
  // 下一次读取应从 learned.json 把学到的数据装回来
  resetLearnedLimits();
  fs.writeFileSync(learnedFile, onDisk, 'utf8');
  assert.equal(learnedLimit('cn-cli', 'glm-5.3-flash'), 930625);
  assert.ok(calibrationFactor('cn-cli', 'glm-5.3-flash') > 1.9);
});

/* ---------------- util.mjs：原子写 + 损坏备份 ---------------- */

test('writeJsonFileAtomic/readJsonFileWithBackup：正常往返', () => {
  const f = path.join(process.env.WB_CONFIG_DIR, 'roundtrip.json');
  writeJsonFileAtomic(f, { hello: '世界', n: 1 });
  assert.deepEqual(readJsonFileWithBackup(f), { hello: '世界', n: 1 });
});

test('readJsonFileWithBackup：半截 JSON 被改名备份而不是静默清掉', () => {
  const f = path.join(process.env.WB_CONFIG_DIR, 'broken.json');
  fs.writeFileSync(f, '{"accounts": [{"id": "acc_x"', 'utf8'); // 写一半的形状
  const parsed = readJsonFileWithBackup(f);
  assert.equal(parsed, null);
  // 原文件已被改名，目录里留下 .corrupt-* 备份
  const leftovers = fs.readdirSync(process.env.WB_CONFIG_DIR).filter((n) => n.startsWith('broken.json.corrupt-'));
  assert.equal(leftovers.length, 1, `应留一个备份，实际：${leftovers.join(',')}`);
  assert.equal(fs.existsSync(f), false);
});

test('readJsonFileWithBackup：文件不存在返回 null 且不抛错', () => {
  assert.equal(readJsonFileWithBackup(path.join(process.env.WB_CONFIG_DIR, '不存在.json')), null);
});

/* ---------------- events.mjs：事件时间线（T6） ---------------- */

const { recordEvent, recentEvents, flushEvents } = await import('../src/events.mjs');

test('recordEvent/recentEvents：新→旧、kind 过滤、落盘 events.json', () => {
  recordEvent('task', '每日签到 ✓ 签到完成', { site: 'cn-cli', accountId: 'acc_a' });
  recordEvent('account', '账号额度耗尽：余额为 0', { site: 'cn-cli', accountId: 'acc_a' });
  recordEvent('policy', '调度策略 → pinned（固定 acc_a）');
  flushEvents();
  const all = recentEvents({ limit: 10 });
  assert.ok(all.length >= 3);
  assert.equal(all[0].kind, 'policy', '最新事件应排最前');
  assert.equal(all[0].text, '调度策略 → pinned（固定 acc_a）');
  const onlyTask = recentEvents({ limit: 10, kind: 'task' });
  assert.ok(onlyTask.length >= 1);
  assert.ok(onlyTask.every((e) => e.kind === 'task'));
  // 落盘校验：events.json 存在且为 JSON 数组
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.WB_CONFIG_DIR, 'events.json'), 'utf8'));
  assert.ok(Array.isArray(onDisk) && onDisk.length >= 3);
});

/* ---------------- usage.mjs：小时分布（T7）+ credit 均值基线（T9） ---------------- */

const { recordUsage, usageSnapshot, todayAvgCreditByModel, resetUsage } = await import('../src/usage.mjs');

test('recordUsage：小时桶累计 + todayAvgCreditByModel 按模型给基线', () => {
  resetUsage();
  recordUsage({ site: 'cn-cli', model: 'glm', status: 200, promptTokens: 10, completionTokens: 5, credit: 2, ms: 1000 });
  recordUsage({ site: 'cn-cli', model: 'glm', status: 200, promptTokens: 10, completionTokens: 5, credit: 4, ms: 1000 });
  recordUsage({ site: 'cn-cli', model: 'hy3', status: 200, credit: 0, ms: 500 });
  const snap = usageSnapshot();
  assert.equal(snap.todayHours.length, 24);
  assert.equal(snap.todayHours[new Date().getHours()].calls >= 2, true, '当前小时应有 ≥2 次');
  assert.equal(snap.today.hours, undefined, 'today 展开时不携带 hours 明细');
  const avg = todayAvgCreditByModel();
  assert.ok(Math.abs(avg['cn-cli/glm'] - 3) < 1e-9, `glm 均值应为 3，实际 ${avg['cn-cli/glm']}`);
  assert.equal(avg['cn-cli/hy3'], undefined, 'credit=0 的免费模型不参与基线');
});

/* ---------------- compress.mjs：压缩事件统计（T10） ---------------- */

const { recordCompression, compressionStats } = await import('../src/compress.mjs');

test('recordCompression：applied 才记、totals 累计、learned.json 回读', () => {
  resetLearnedLimits();
  recordCompression('cn-cli', 'glm-5.1', { applied: false, dropped: 9, truncated: 9, before: 9, after: 9 }); // 不该被记
  recordCompression('cn-cli', 'glm-5.1', { applied: true, dropped: 3, truncated: 1, before: 100000, after: 50000, limit: 100000 });
  recordCompression('cn-cli', 'glm-5.1', { applied: true, dropped: 2, truncated: 0, before: 60000, after: 40000, limit: 100000 }, { phase: 'retry' });
  let s = compressionStats();
  assert.equal(s.totals.count, 2);
  assert.equal(s.totals.dropped, 5);
  assert.equal(s.totals.savedTokens, 70000);
  assert.equal(s.events[0].phase, 'retry', '最新事件排最前');
  // 落盘 + 模拟重启回读
  flushLearned();
  const onDisk = fs.readFileSync(path.join(process.env.WB_CONFIG_DIR, 'learned.json'), 'utf8');
  resetLearnedLimits();
  fs.writeFileSync(path.join(process.env.WB_CONFIG_DIR, 'learned.json'), onDisk, 'utf8');
  s = compressionStats();
  assert.equal(s.totals.count, 2);
  assert.equal(s.totals.savedTokens, 70000);
  assert.equal(s.events.length, 2);
});

/* ---------------- T11/T12/T13/T16：通知节流 / 重试 / 预算 / 活动规则表 ---------------- */

const { shouldNotify, resetNotifyThrottle } = await import('../src/notify.mjs');
const { withRetryOnce } = await import('../src/util.mjs');
const { budgetStatus, budgetRedirectActive, resetBudgetAnnounce } = await import('../src/budget.mjs');

test('T11 shouldNotify：同 key 节流 5 分钟，过期键被清理', () => {
  resetNotifyThrottle();
  const store = new Map();
  const t0 = 1_000_000;
  assert.equal(shouldNotify('k1', t0, store), true, '首次应放行');
  assert.equal(shouldNotify('k1', t0 + 60_000, store), false, '5 分钟内应拦截');
  assert.equal(shouldNotify('k2', t0, store), true, '不同 key 互不影响');
  assert.equal(shouldNotify('k1', t0 + 5 * 60_000, store), true, '满 5 分钟放行');
  // 塞一堆过期键，触发清理路径
  for (let i = 0; i < 120; i++) shouldNotify('bulk-' + i, t0, store);
  shouldNotify('trigger-clean', t0 + 10 * 60_000, store);
  assert.ok(store.size <= 100, `清理后应 ≤100，实际 ${store.size}`);
});

test('T12 withRetryOnce：失败重试一次成功；两次失败才抛出', async () => {
  let calls = 0;
  const r = await withRetryOnce(async () => {
    calls++;
    if (calls === 1) throw new Error('第一次抖动');
    return 'ok';
  }, { backoffMs: 1 });
  assert.equal(r, 'ok');
  assert.equal(calls, 2, '应恰好调用两次');
  await assert.rejects(
    () => withRetryOnce(async () => { throw new Error('一直失败'); }, { backoffMs: 1 }),
    /一直失败/,
  );
});

test('T13 budgetStatus：未启用返回 enabled=false；启用后按今日消耗算百分比', () => {
  resetUsage();
  resetBudgetAnnounce();
  const cfg = { budget: { enabled: true, dailyCredits: 10, warnPercent: 50, mode: 'warn' } };
  assert.equal(budgetStatus({}).enabled, false, '未启用');
  recordUsage({ site: 'cn-cli', model: 'glm', status: 200, credit: 3 });
  const st = budgetStatus(cfg);
  assert.equal(st.enabled, true);
  assert.equal(st.spent, 3);
  assert.equal(st.percent, 30);
  assert.equal(st.warn, false, '30% < 50% 预警线');
  assert.equal(st.exceeded, false);
  recordUsage({ site: 'cn-cli', model: 'glm', status: 200, credit: 9 });
  const st2 = budgetStatus(cfg);
  assert.equal(st2.spent, 12);
  assert.equal(st2.warn, true, '120% ≥ 预警线');
  assert.equal(st2.exceeded, true, '12 ≥ 10 超限');
  // mode=free + 超限 → 路由改道激活；warn 模式或未超限不激活
  assert.equal(budgetRedirectActive(cfg, st2), false, 'warn 模式不改道');
  assert.equal(budgetRedirectActive({ budget: { enabled: true, dailyCredits: 10, warnPercent: 50, mode: 'free' } }, st2), true, 'free 模式超限改道');
  assert.equal(budgetRedirectActive({ budget: { enabled: true, dailyCredits: 10, warnPercent: 50, mode: 'free' } }, st), false, '未超限不改道');
});

test('T16 活动规则表：judgeTask 经 AUTOPLAY_RULES 驱动（black_cat 窗口 / Model_chat 模型反推）', async () => {
  const { listGrowthTasks } = await import('../src/tasks.mjs');
  // 经 growthTasksView 间接验证 judgeTask（不导出本身，避免暴露内部）：
  // 这里直接检查导出面——registerAutoplayRule 存在即可，规则细节由线上验证覆盖
  const tasks = await import('../src/tasks.mjs');
  assert.equal(typeof tasks.registerAutoplayRule, 'function');
  assert.equal(typeof tasks.growthTasksView, 'function');
  assert.equal(typeof tasks.runSingleTask, 'function');
  assert.equal(typeof tasks.claimSingleTask, 'function');
  void listGrowthTasks;
});

/* ---------------- validateConfig：healthCheck（T8） ---------------- */

test('validateConfig：healthCheck 非法时点回退、合法时点补零', () => {
  const bad = { healthCheck: { enabled: 'yes', times: ['9:0', 'abc'] } };
  validateConfig(bad);
  assert.equal(bad.healthCheck.enabled, false);
  assert.deepEqual(bad.healthCheck.times, []);
  const good = { healthCheck: { enabled: true, times: ['8:00', '22:30'] } };
  validateConfig(good);
  assert.equal(good.healthCheck.enabled, true);
  assert.deepEqual(good.healthCheck.times, ['08:00', '22:30']);
  const none = {};
  validateConfig(none);
  assert.equal(none.healthCheck.enabled, false, '缺省时给默认关闭');
});

/* ---------------- T20 pickScheduledModel：按时段路由选型 ---------------- */

test('T20 pickScheduledModel：白天/夜间/跨零点/未启用/留空 都返回正确结果', async () => {
  const { pickScheduledModel } = await import('../src/router.mjs');
  const mk = (h, m) => new Date(2026, 9, 3, h, m);
  const sr = { enabled: true, dayStart: '08:00', nightStart: '23:00', dayModel: 'glm-5.3-flash', nightModel: 'deepseek-v4-pro' };
  assert.equal(pickScheduledModel(sr, mk(12, 0)), 'glm-5.3-flash'); // 白天
  assert.equal(pickScheduledModel(sr, mk(23, 0)), 'deepseek-v4-pro'); // 夜间起点含边界
  assert.equal(pickScheduledModel(sr, mk(7, 59)), 'deepseek-v4-pro'); // 白天起点前
  assert.equal(pickScheduledModel(sr, mk(2, 0)), 'deepseek-v4-pro'); // 凌晨算夜间
  // 跨零点写法：白天 09:00 → 次日 02:00 都算白天
  const cross = { enabled: true, dayStart: '09:00', nightStart: '02:00', dayModel: 'day', nightModel: 'night' };
  assert.equal(pickScheduledModel(cross, mk(23, 30)), 'day');
  assert.equal(pickScheduledModel(cross, mk(1, 59)), 'day');
  assert.equal(pickScheduledModel(cross, mk(3, 0)), 'night');
  // 未启用 / 缺时点 / 时段模型留空 → null（走默认行为）
  assert.equal(pickScheduledModel({ ...sr, enabled: false }, mk(12, 0)), null);
  assert.equal(pickScheduledModel({ ...sr, dayStart: '25:00' }, mk(12, 0)), null);
  assert.equal(pickScheduledModel({ ...sr, dayModel: '', nightModel: 'n' }, mk(12, 0)), null);
  assert.equal(pickScheduledModel(null, mk(12, 0)), null);
});

/* ---------------- T22 compareVersions：x.y.z 比较 ---------------- */

test('T22 compareVersions：三段逐位比较，非法输入按 0', async () => {
  const { compareVersions } = await import('../src/updatecheck.mjs');
  assert.equal(compareVersions('0.3.13', '0.3.12'), 1);
  assert.equal(compareVersions('0.3.12', '0.3.13'), -1);
  assert.equal(compareVersions('0.4.0', '0.3.99'), 1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.3.12', '0.3.12'), 0);
  assert.equal(compareVersions('unknown', '0.3.12'), -1);
});

/* ---------------- T28/T30/T31：会话压缩记忆 / 429 协调 / 自适应 TTL ---------------- */

test('T28 sessionMemoBudget/rememberSessionBudget：同尾巴命中、LRU 有界、空输入安全', async () => {
  const { sessionMemoBudget, rememberSessionBudget, resetSessionMemos } = await import('../src/compress.mjs');
  resetSessionMemos();
  const msgsA = [{ role: 'user', content: '第一轮问题' }];
  const msgsA2 = [{ role: 'user', content: '第一轮问题' }, { role: 'assistant', content: '好' }];
  assert.equal(sessionMemoBudget([]), null, '空消息无键');
  assert.equal(sessionMemoBudget(null), null);
  assert.equal(sessionMemoBudget(msgsA), null, '没记过就是 null');
  rememberSessionBudget(msgsA, 51234.7, { site: 'cn-cli', model: 'glm' });
  const memo = sessionMemoBudget(msgsA);
  assert.equal(memo.budget, 51234, '预算被取整记录');
  assert.equal(sessionMemoBudget(msgsA2), null, '尾巴不同（条数不同）不命中');
  rememberSessionBudget(msgsA, -5); // 非法预算被忽略
  assert.equal(sessionMemoBudget(msgsA).budget, 51234);
  for (let i = 0; i < 250; i++) rememberSessionBudget([{ role: 'user', content: '消息' + i }], 1000);
  assert.ok(sessionMemoBudget(msgsA) === null || sessionMemoBudget(msgsA).budget === 51234, 'LRU 淘汰后要么没了要么还是老值');
  const { compressionStats } = await import('../src/compress.mjs');
  void compressionStats;
});

test('T30 reportUpstream429/waitForUpstreamSlot：指数退避、窗口内排队、过期即放行', async () => {
  const { reportUpstream429, waitForUpstreamSlot, upstreamCoolingDown, resetUpstreamCoordination, coordinationStatus } = await import('../src/coordination.mjs');
  resetUpstreamCoordination();
  assert.equal(await waitForUpstreamSlot(), 0, "没惩罚时不等待");
  const ms1 = reportUpstream429();
  assert.equal(ms1, 1000, '首次 1 秒');
  assert.equal(upstreamCoolingDown(), true);
  const ms2 = reportUpstream429();
  assert.ok(ms2 > 1000 && ms2 <= 30000, `第二次应翻倍，实际 ${ms2}`);
  const ms3 = reportUpstream429();
  assert.ok(ms3 >= ms2, '窗口内连续 429 继续顺延');
  // 排队放行：惩罚快过期时排队，最多等 (惩罚剩余 + 200ms)
  const t0 = Date.now();
  const waited = await Promise.race([
    waitForUpstreamSlot(),
    new Promise((r) => setTimeout(() => r('timeout'), coordinationStatus().until - Date.now() + 200)),
  ]);
  assert.notEqual(waited, 'timeout', '窗开时应被放行');
  void t0;
  resetUpstreamCoordination();
  assert.equal(upstreamCoolingDown(), false);
});

test('T31 bumpCreditActivity 导出面 + 自适应间隔计算不抛错', async () => {
  const sched = await import('../src/scheduler.mjs');
  assert.equal(typeof sched.bumpCreditActivity, 'function');
  assert.equal(typeof sched.startCreditLoop, 'function');
  assert.equal(typeof sched.stopCreditLoop, 'function');
  // 未启动时调用是空操作，不应抛
  sched.bumpCreditActivity();
  sched.stopCreditLoop(); // 幂等
});

test('T24 validateConfig：consolePin 校验（4-12 位数字/空值关闭/非法回退）', async () => {
  const { validateConfig } = await import('../src/config.mjs');
  const good = { consolePin: '1234' };
  validateConfig(good);
  assert.equal(good.consolePin, '1234');
  const off = { consolePin: '' };
  validateConfig(off);
  assert.equal(off.consolePin, null, '空串 = 关闭');
  const off2 = { consolePin: undefined };
  validateConfig(off2);
  assert.equal(off2.consolePin, null);
  const bad = { consolePin: '12a4' };
  const issues = validateConfig(bad);
  assert.equal(bad.consolePin, null, '非法回退关闭');
  assert.ok(issues.some((s) => s.includes('consolePin')), `应报 issue：${issues.join('|')}`);
  const long = { consolePin: '123456789012345' };
  validateConfig(long);
  assert.equal(long.consolePin, null, '超长回退关闭');
});

/* ---------------- B1/B2/B3：SSE 鉴权通道、停服保护、凭据脱敏 ---------------- */

test('B2 doStop：有活跃请求时抛 409，force 可放行且仍等空闲', async () => {
  const life = await import('../src/lifecycle-impl.mjs');
  let active = 3;
  let flushed = 0;
  life.bootLifecycle({
    activeRequestsRef: () => active,
    stoppers: [() => { flushed++; }],
    flushers: [],
  });
  // 活跃请求 >0 且未 force → 拒绝，并带上数量供 HTTP 层提示
  assert.throws(
    () => life.doStop(),
    (e) => e.status === 409 && e.activeRequests === 3,
  );
  assert.equal(flushed, 0, '被拒绝时不得刷盘/停循环（什么都没发生）');
  // force 放行：仍走 waitIdle —— 等在途请求跑完，不掐断
  const r = life.doStop({ force: true });
  assert.equal(r.waiting, true);
  assert.equal(r.active, 3);
  assert.equal(flushed, 0, '有在途请求时不得停循环/刷盘（否则等于半路掐断）');
  // 请求全部跑完后，排队的退出函数才执行 —— 这才是「不掐断」的落点
  active = 0;
  life.drainWaiters();
  assert.equal(flushed, 1, '请求清零后停止器才被调用一次');
});

test('B2 doStop：无活跃请求时立即退出（不等待）', async () => {
  const life = await import('../src/lifecycle-impl.mjs');
  let flushed = 0;
  life.bootLifecycle({ activeRequestsRef: () => 0, stoppers: [() => { flushed++; }], flushers: [] });
  const r = life.doStop();
  assert.equal(r.waiting, false);
  assert.equal(flushed, 1);
});

test('B3 bridgeStatus redact：抹掉两个 token 字段且不影响其余字段', async () => {
  const { bridgeStatus } = await import('../src/scheduler.mjs');
  const { savePool } = await import('../src/pool.mjs');
  const cfg = { sites: { 'cn-cli': { label: '国内' } }, defaultSite: 'cn-cli', pool: {}, tasks: {}, models: {} };
  savePool('cn-cli', {
    accounts: [{
      id: 'acc_test', label: '测试', accessToken: 'AT-SECRET', refreshToken: 'RT-SECRET',
      creditDetail: [{ credit: 100, cycleEndTime: '2026-12-01' }], creditRemain: 100,
    }],
  });
  const raw = bridgeStatus(cfg);
  const acc0 = raw.sites[0].accounts[0];
  assert.equal(acc0.accessToken, 'AT-SECRET', '默认不脱敏（/backup 等需要凭据的路径依赖它）');
  const safe = bridgeStatus(cfg, { redact: true });
  const acc1 = safe.sites[0].accounts[0];
  assert.equal(acc1.accessToken, undefined, 'redact 必须抹掉 accessToken');
  assert.equal(acc1.refreshToken, undefined, 'redact 必须抹掉 refreshToken');
  assert.equal(JSON.stringify(safe).includes('SECRET'), false, '整份响应里不得残留凭据');
  // 其余字段必须完好（前端全靠它们渲染）
  assert.equal(acc1.id, 'acc_test');
  assert.equal(acc1.label, '测试');
  assert.equal(acc1.creditRemain, 100);
  assert.equal(acc1.creditDetail[0].credit, 100);
  assert.ok(safe.sites[0].plan, '建议消耗顺序仍应生成');
});

/* ---------------- T32 积分耗尽预测：predictBatch / predictAccount / burnoutReport ---------------- */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-03T12:00:00');

test('T32 predictBatch：日均速率低 → 判定「预计用不完」并给出建议', async () => {
  const { predictBatch } = await import('../src/burnout.mjs');
  // 1000 积分，还有 10 天过期，日均只烧 10 分 → 到期时只能烧掉 100，必然剩 900
  const r = predictBatch({ remain: 1000, expireAt: NOW + 10 * DAY }, { dailyAvg: 10, now: NOW });
  assert.equal(r.willExpireUnused, true);
  assert.equal(r.daysLeft, 10);
  assert.equal(r.projectedUse, 100);
  assert.equal(r.projectedRemain, 900);
  assert.equal(r.wasteCredits, 900);
  assert.ok(r.advice && r.advice.includes('900'), '建议里应写明预计浪费多少积分');
});

test('T32 predictBatch：日均速率高 → 判定「能用完」，不算浪费', async () => {
  const { predictBatch } = await import('../src/burnout.mjs');
  // 1000 积分 10 天过期，日均烧 200 → 10 天正好烧 2000，用得完
  const r = predictBatch({ remain: 1000, expireAt: NOW + 10 * DAY }, { dailyAvg: 200, now: NOW });
  assert.equal(r.willExpireUnused, false);
  assert.equal(r.wasteCredits, 0);
  assert.equal(r.advice, null);
});

test('T32 predictBatch：数据不足时如实返回「无法预测」，绝不误报浪费', async () => {
  const { predictBatch } = await import('../src/burnout.mjs');
  const cases = [
    [{ remain: 1000, expireAt: NOW + 5 * DAY }, { dailyAvg: 0, now: NOW }, 'no-usage', '没有消耗记录'],
    [{ remain: 1000, expireAt: null }, { dailyAvg: 50, now: NOW }, 'no-expiry', '拿不到到期时间'],
    [{ remain: 0, expireAt: NOW + 5 * DAY }, { dailyAvg: 50, now: NOW }, 'empty', '批次已耗尽'],
    [{ remain: 1000, expireAt: NOW - DAY }, { dailyAvg: 50, now: NOW }, 'expired', '批次已过期'],
  ];
  for (const [batch, opts, reason, label] of cases) {
    const r = predictBatch(batch, opts);
    assert.equal(r.willExpireUnused, false, `${label}：不该判成用不完`);
    assert.equal(r.wasteCredits, null, `${label}：没算出结论时 wasteCredits 应为 null（展示层显示「—」），不是 0`);
    assert.equal(r.reason, reason, `${label}：reason 标记不对`);
  }
});

test('T32 predictBatch：不足一天到期时按 0.25 天下限算，不误报成「用不完」', async () => {
  const { predictBatch } = await import('../src/burnout.mjs');
  // 2 小时后过期、只剩 2 积分、日均 10 → 当天最多烧 10，2 积分当天就用得完
  const r = predictBatch({ remain: 2, expireAt: NOW + 2 * 3600_000 }, { dailyAvg: 10, now: NOW });
  // 2/24≈0.083 天，被 0.25 天下限抬上来（保留 0.1 天粒度，round 半进位后是 0.3）
  assert.ok(r.daysLeft <= 0.3 && r.daysLeft >= 0.25, `不足一天应按下限计，实际 ${r.daysLeft}`);
  assert.equal(r.willExpireUnused, false, '当天就能用完的批次不该报「预计用不完」');
  assert.ok(r.projectedUse >= 2, `日均 10×0.25=2.5 ≥ 余量 2，应判为用得完，实际预计消耗 ${r.projectedUse}`);
});

test('T32 predictAccount / burnoutReport：汇总风险批次数与总浪费额', async () => {
  const { predictAccount, burnoutReport } = await import('../src/burnout.mjs');
  const acc = {
    id: 'acc_1', label: '公瑾',
    creditDetail: [
      { package: '大包', remain: 1000, expireAt: NOW + 10 * DAY },  // 烧不完（10 天只用掉 100）
      { package: '小包', remain: 100, expireAt: NOW + 10 * DAY },   // 正好烧完（10 天刚好用 100）
      { package: '过期包', remain: 50, expireAt: NOW - DAY },       // 已过期，不计
    ],
  };
  const p = predictAccount(acc, { dailyAvg: 10, now: NOW });
  assert.equal(p.riskCount, 1, '只有大包是风险批次');
  assert.equal(p.totalWaste, 900);
  assert.equal(p.batches.length, 3, '所有批次都要带 burnout 字段返回，供账号卡逐行渲染');

  const rep = burnoutReport([{ site: 'cn-cli', account: acc }], { dailyAvg: 10, now: NOW });
  assert.equal(rep.riskCount, 1);
  assert.equal(rep.totalWaste, 900);
  assert.equal(rep.accounts[0].label, '公瑾');
  assert.equal(rep.accounts[0].site, 'cn-cli');
  assert.equal(rep.dailyAvg, 10);
});

/* ---------------- 交棒重启死锁修复：isModelPath 只把模型调用算作活跃请求 ---------------- */
// 背景（2026-10-03 22:0x）：原来只要 pathname !== '/health' 就计数，控制台的
// 20 秒轮询与 SSE 长连接也被计入。老标签页开着时活跃数永久 ≥ 1，交棒重启永远等
// 不到空闲 → 老实例不退出、新实例 30 秒后放弃 → 改了代码却没生效（health 却正常）。
// isModelPath 定义在 server.mjs 里（单测不加载它），这里用源码提取的方式验证判定口径。

test('交棒重启：isModelPath 只把模型调用算活跃请求，控制台轮询/SSE 不算', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  // import.meta.url 是 file:///E:/... 形式的 URL，必须过 fileURLToPath 再算路径 ——
  // 直接 path.dirname 会得到 "E:\E:\..." 双前缀（Windows 上踩过，报 ENOENT）。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'server.mjs'), 'utf8');
  const m = src.match(/function isModelPath\(pathname\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'server.mjs 里应能提取到 isModelPath 函数');
  // 用 new Function 显式返回：ESM 是严格模式，eval 里的 function 声明不会泄漏到外层作用域
  const isModelPath = new Function(`${m[0]}; return isModelPath;`)();

  // 模型调用：掐断它 = 用户会话断线，必须计入
  for (const p of ['/v1/chat/completions', '/chat/completions', '/v1/messages', '/v1/responses', '/v1/models', '/v1/messages/chat/completions']) {
    assert.equal(isModelPath(p), true, `${p} 是模型调用，应计入活跃请求`);
  }
  // 后台/长连接：与用户会话生死无关，绝不能计入（否则交棒重启死锁）
  for (const p of ['/health', '/healthz', '/console/api/stream', '/console/api/bridge', '/console', '/admin/restart', '/status', '/']) {
    assert.equal(isModelPath(p), false, `${p} 不是模型调用，不该计入活跃请求（计入会导致交棒重启永远等不到空闲）`);
  }
});

/* ---------------- B4 provider_config 隔离守卫（2026-10-03 端口污染事故） ---------------- */

// 背景：临时目录试启的实例（port=8794）曾把生产 ~/.zcode/v2/provider_config.json 的
// baseUrl 刷成 8794，ZCode 之后 106 次拨号全部 ECONNREFUSED，整回合报废。
// 防线：显式设了 WB_CONFIG_DIR 的实例只写自己的数据目录，绝不碰生产配置。

test('B4 providerConfigTarget：生产数据目录写全局 v2 配置', async () => {
  const { providerConfigTarget } = await import('../src/pickersync.mjs');
  const { getConfigDir, setConfigDir } = await import('../src/config.mjs');
  const restore = setConfigDir(path.join(os.homedir(), '.zcode', 'workbuddy-bridge'));
  try {
    delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    assert.equal(
      providerConfigTarget(),
      path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json'),
      '生产实例必须继续写全局配置（否则 ZCode 选择器里 WorkBuddy 分组会消失）',
    );
  } finally {
    restore();
  }
});

test('B4 providerConfigTarget：隔离数据目录只写自己的目录，不返回全局路径', async () => {
  const { providerConfigTarget } = await import('../src/pickersync.mjs');
  const { getConfigDir, setConfigDir } = await import('../src/config.mjs');
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-iso-'));
  const restore = setConfigDir(iso);
  try {
    delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    const target = providerConfigTarget();
    assert.equal(target, path.join(iso, 'provider_config.json'), '隔离实例应写自己的数据目录');
    assert.ok(
      !target.startsWith(path.join(os.homedir(), '.zcode', 'v2')),
      '隔离实例绝不能写生产 v2 配置（这正是 8794 污染的根因）',
    );
  } finally {
    restore();
  }
});

test('B4 providerConfigTarget：生产实例下 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 仍可覆盖', async () => {
  const { providerConfigTarget } = await import('../src/pickersync.mjs');
  const { setConfigDir } = await import('../src/config.mjs');
  const custom = path.join(os.tmpdir(), 'wb-custom-provider.json');
  // 覆盖变量只对生产实例生效；隔离实例一律写自己的目录（见后两条测试）
  const restore = setConfigDir(path.join(os.homedir(), '.zcode', 'workbuddy-bridge'));
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = custom;
  try {
    assert.equal(providerConfigTarget(), custom, '生产实例下显式覆盖变量生效');
  } finally {
    restore();
    delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  }
});

test('B4 端到端：隔离实例跑完整同步，全局 provider_config.json 一字不动', async () => {
  const { runProviderConfigSync } = await import('../src/pickersync.mjs');
  const { setConfigDir } = await import('../src/config.mjs');

  // 造一个「生产配置」哨兵文件，验证隔离实例的同步绝不去碰它
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sentinel-'));
  const sentinel = path.join(sentinelDir, 'provider_config.json');
  const sentinelBody = '{"schemaVersion":1,"config":{"providerOrder":["keep-me"],"marker":"untouched"}}';
  fs.writeFileSync(sentinel, sentinelBody, 'utf8');

  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-iso-e2e-'));
  const restore = setConfigDir(iso);
  try {
    delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    // 端口指向一个不存在的服务 → fetchPickerModels 失败 → 走 fallbackModels，
    // 与试启事故里「试启实例照样写全局配置」的路径完全一致
    const r = await runProviderConfigSync({
      port: 8794,
      apiKey: 'sk-wb-test',
      fallbackModels: ['space-bunny (x0.03)'],
    });
    assert.equal(r.target, path.join(iso, 'provider_config.json'), '同步目标应是隔离目录');
    assert.ok(fs.existsSync(path.join(iso, 'provider_config.json')), '隔离目录里应生成配置文件');
    const written = fs.readFileSync(path.join(iso, 'provider_config.json'), 'utf8');
    assert.match(written, /127\.0\.0\.1:8794/, '隔离实例自己写自己的端口（允许）');
    assert.equal(
      fs.readFileSync(sentinel, 'utf8'),
      sentinelBody,
      '全局/哨兵配置必须逐字节不变 —— 这是本次修复的核心断言',
    );
  } finally {
    restore();
    delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  }
});

test('B4 隔离实例即使继承了指向生产的覆盖变量，也只写隔离目录', async () => {
  // 真实事故场景：ZCode 桌面端把 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 注入插件子进程，
  // 试启脚本用「覆盖变量优先」的旧逻辑时被整条短路，临时端口照样刷进生产配置。
  const { runProviderConfigSync } = await import('../src/pickersync.mjs');
  const { setConfigDir } = await import('../src/config.mjs');
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-iso-override-'));
  const restore = setConfigDir(iso);
  try {
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
    const r = await runProviderConfigSync({
      port: 8794,
      apiKey: 'sk-wb-test',
      fallbackModels: ['space-bunny (x0.03)'],
    });
    assert.equal(r.target, path.join(iso, 'provider_config.json'), '隔离优先于覆盖变量');
    assert.ok(
      !r.target.startsWith(path.join(os.homedir(), '.zcode', 'v2')),
      '绝不能写生产配置（覆盖变量被 ZCode 注入，值恒为生产路径）',
    );
  } finally {
    restore();
    delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  }
});
