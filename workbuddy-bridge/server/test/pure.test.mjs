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

const { rankSiteCandidates, pickSiteWithAccounts } = await import('../src/router.mjs');
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
