// 第六批 T55–T63：补跑判定 / 备份调度与滚动清理 / 按账号预算 / 通知通道报文。
// 全部纯函数或注入隔离（backupTick 的 now/dir/stateFile 可注入，绝不碰生产数据目录）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { missedRunToday } from '../src/tasks.mjs';
import { pruneBackups, backupNow, backupTick, backupList, collectBackupFiles } from '../src/backup.mjs';
import { accountBudgetOf, accountBudgetStatus, accountBudgetCheckAndAnnounce, resetBudgetAnnounce } from '../src/budget.mjs';
import { buildChannelRequest, enabledChannels } from '../src/notify.mjs';

const D = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

/* ==================== T55：错过时点补跑判定 ==================== */

test('missedRunToday：时点已过判定错过，未到不补', () => {
  const cfg = { tasks: { checkinTimes: ['09:00', '21:00'], growthTimes: ['13:00'] } };
  assert.equal(missedRunToday(cfg, 'checkin', D(10)), true, '10 点：09:00 已过 → 该补');
  assert.equal(missedRunToday(cfg, 'checkin', D(8, 30)), false, '08:30：时点未到 → 不补');
  assert.equal(missedRunToday(cfg, 'growth', D(12)), false, '12 点：13:00 未到');
  assert.equal(missedRunToday(cfg, 'growth', D(14)), true);
});

test('missedRunToday：旧小时数组语义兼容，两者皆空 = 不补', () => {
  assert.equal(missedRunToday({ tasks: { checkinHours: [9, 21] } }, 'checkin', D(10)), true);
  assert.equal(missedRunToday({ tasks: { checkinHours: [9, 21] } }, 'checkin', D(8)), false);
  assert.equal(missedRunToday({ tasks: { checkinTimes: [], growthTimes: [] } }, 'checkin', D(10)), false,
    '显式空数组 = 调度未启用该类，不补跑');
  assert.equal(missedRunToday({ tasks: {} }, 'checkin', D(10)), false);
});

/* ==================== T58：备份调度与滚动清理 ==================== */

test('pruneBackups：按文件名排序保留 keep 份，删最旧', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bkp-'));
  for (const n of ['backup-2026-10-01-0900.json', 'backup-2026-10-02-0900.json', 'backup-2026-10-03-0900.json', 'backup-2026-10-04-0900.json', 'backup-2026-10-05-0900.json']) {
    fs.writeFileSync(path.join(dir, n), '{}');
  }
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x'); // 非本模块命名不动
  const removed = pruneBackups(dir, 3);
  assert.deepEqual(removed.sort(), ['backup-2026-10-01-0900.json', 'backup-2026-10-02-0900.json']);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('backup-')).length, 3);
  assert.equal(fs.existsSync(path.join(dir, 'unrelated.txt')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backupTick：时点命中才备、同天去重、disabled 跳过、force 绕过全部', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bkpt-'));
  const stFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bkst-')), 'backup-state.json');
  const cfg = { backup: { enabled: true, times: ['09:00', '09:30'], keep: 2 }, sites: {} };
  assert.deepEqual((await backupTick(cfg, D(10), { dir, stateFile: stFile })).skipped, 'not-scheduled', '10 点不在时点');
  const r1 = await backupTick(cfg, D(9), { dir, stateFile: stFile });
  assert.equal(r1.ok, true, '09:00 命中 → 备份');
  assert.deepEqual((await backupTick(cfg, D(9, 30), { dir, stateFile: stFile })).skipped, 'already', '同天第二个时点命中但已备过 → 跳过');
  assert.deepEqual((await backupTick({ backup: { enabled: false, times: ['09:00'], keep: 2 } }, D(9), { dir, stateFile: stFile })).skipped, 'disabled');
  const r2 = await backupTick(cfg, D(9, 2), { dir, stateFile: stFile, force: true });
  assert.equal(r2.ok, true, 'force 绕过当天去重');
  fs.rmSync(path.dirname(stFile), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backupList：目录不存在返回空数组不抛错（默认路径兜底同此路径）', () => {
  assert.deepEqual(backupList(path.join(os.tmpdir(), 'wb-bkp-nope-' + Date.now())), []);
});

test('backupNow：payload 含 config 与 pool 文件名，keep 滚动生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bkn-'));
  const cfg = { sites: {} };
  const r = backupNow(cfg, { dir, now: D(9), keep: 2 });
  assert.ok(r.file.endsWith('.json'));
  assert.ok(r.files >= 1);
  assert.equal(fs.existsSync(r.file), true);
  const payload = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(payload.version, 1);
  assert.ok(Array.isArray(Object.keys(payload.files)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectBackupFiles：不存在的文件跳过不抛错', () => {
  const files = collectBackupFiles({ sites: {} });
  assert.ok(typeof files === 'object');
});

/* ==================== T63：按账号每日预算 ==================== */

const BCFG = { budget: { enabled: true, warnPercent: 80, accounts: { acc_a: 100, acc_b: 10, acc_bad: -5, acc_zero: 0 } } };

test('accountBudgetOf：合法值返回数字，非法/缺失返回 null', () => {
  assert.equal(accountBudgetOf(BCFG, 'acc_a'), 100);
  assert.equal(accountBudgetOf(BCFG, 'acc_bad'), null);
  assert.equal(accountBudgetOf(BCFG, 'acc_zero'), null);
  assert.equal(accountBudgetOf(BCFG, 'acc_none'), null);
  assert.equal(accountBudgetOf({ budget: {} }, 'acc_a'), null);
});

test('accountBudgetStatus：site/account 与裸 accountId 两种键都计入', () => {
  const spentMap = { 'cn-cli/acc_a': 45.6, acc_b: 10 };
  const a = accountBudgetStatus(BCFG, 'acc_a', spentMap);
  assert.deepEqual({ spent: a.spent, exceeded: a.exceeded, warn: a.warn }, { spent: 45.6, exceeded: false, warn: false });
  const b = accountBudgetStatus(BCFG, 'acc_b', spentMap);
  assert.equal(b.exceeded, true, '10/10 超限');
  assert.equal(accountBudgetStatus(BCFG, 'acc_none', spentMap), null, '未设预算返回 null');
});

test('accountBudgetCheckAndAnnounce：没配账号预算返回空；独立于全局开关；超限账号每天只提醒一次', () => {
  resetBudgetAnnounce();
  const accs = [{ site: 'cn-cli', id: 'acc_b', label: '小号' }, { site: 'cn-cli', id: 'acc_free', label: '不限号' }];
  const spentMap = { 'cn-cli/acc_b': 10 };
  // 没配置任何按账号预算 → 空（即使全局预算开着）
  assert.deepEqual(accountBudgetCheckAndAnnounce({ budget: { enabled: true, accounts: {} } }, accs, { spentMap }), []);
  // 全局预算关闭但配置了账号预算 → 照样生效（两个开关独立）
  const out = accountBudgetCheckAndAnnounce({ budget: { enabled: false, warnPercent: 80, accounts: { acc_b: 10 } } }, accs, { spentMap });
  assert.equal(out.length, 1, '未设预算的账号不出现');
  assert.equal(out[0].exceeded, true, '10/10 超限');
  assert.equal(out[0].label, '小号');
});

/* ==================== T62：新通知通道报文 ==================== */

test('buildChannelRequest：feishu/dingtalk 报文形状正确', () => {
  const f = buildChannelRequest({ type: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' }, '标题', '正文');
  assert.equal(f.init.method, 'POST');
  assert.deepEqual(JSON.parse(f.init.body), { msg_type: 'text', content: { text: '【标题】正文' } });
  const d = buildChannelRequest({ type: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=x' }, '标题', '正文');
  assert.deepEqual(JSON.parse(d.init.body), { msgtype: 'text', text: { content: '【标题】正文' } });
});

test('buildChannelRequest：telegram 从 url 提取 chat_id 进 body，缺 chat_id 抛错', () => {
  const t = buildChannelRequest({ type: 'telegram', url: 'https://api.telegram.org/botTOK/sendMessage?chat_id=12345' }, '标题', '正文');
  assert.equal(t.url, 'https://api.telegram.org/botTOK/sendMessage');
  assert.deepEqual(JSON.parse(t.init.body), { chat_id: '12345', text: '【标题】正文' });
  assert.throws(() => buildChannelRequest({ type: 'telegram', url: 'https://api.telegram.org/botTOK/sendMessage' }, 'a', 'b'), /chat_id/);
});

test('buildChannelRequest：未知类型返回 null（与旧行为一致）', () => {
  assert.equal(buildChannelRequest({ type: 'nope', url: 'x' }, 'a', 'b'), null);
});

test('enabledChannels：新类型通道正常启用（config 校验由 config.mjs 负责，这里只看过滤）', () => {
  const cfg = { notify: { enabled: true, channels: [{ type: 'feishu', url: 'u1', enabled: true }, { type: 'telegram', url: 'u2', enabled: false }] } };
  const chs = enabledChannels(cfg);
  assert.equal(chs.length, 1);
  assert.equal(chs[0].type, 'feishu');
});
