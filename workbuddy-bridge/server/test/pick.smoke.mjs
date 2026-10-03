// 冒烟：pickAccount 在真实配置链路（config.json → pool.policy）下的到期优先选号。
//
// ⚠️ 隔离是生死线（2026-10-03 事故）：本脚本曾经直接读写真实数据目录，把夹具账号
// acc_aaa/acc_bbb（假 token）覆盖写进生产账号池，8788 上的会话当场全部掉线。
// 根因：注释说「用临时 WB_CONFIG_DIR」但代码从没设置过它；且 ESM 的 import 提升
// 让顶层 import 拿到的 configDir 在任何顶层赋值之前就已固化。
// 因此：WB_CONFIG_DIR 必须在 node 加载本文件之前就位 —— 用 cross-env 不可靠，
// 直接拒绝在未隔离时运行（process.env 检查）+ 自我删除真实池文件做不到，
// 唯一可靠的做法是【显式启动】：npm run smoke 会带 env 启动一个子进程跑本文件，
// 本文件只负责校验隔离已生效，没生效就立刻退出。
//
// 用法：npm run smoke（在 server/ 下）——package.json 已配好 WB_CONFIG_DIR。
if (!process.env.WB_CONFIG_DIR || process.env.WB_CONFIG_DIR.includes('.zcode')) {
  console.error('SMOKE-ABORT：WB_CONFIG_DIR 未设置为隔离目录。请用 `npm run smoke` 运行（会自动设置临时目录），切勿直接 node 本文件。');
  process.exit(2);
}
import fs from 'node:fs';
import path from 'node:path';
import { pickAccount } from '../src/pool.mjs';
import { loadConfig, getConfigDir } from '../src/config.mjs';

const cfg = loadConfig();
console.log('data dir =', getConfigDir());
console.log('policy   =', cfg.pool.policy);

const pool = {
  version: 1,
  nextLabel: 3,
  accounts: [
    { id: 'acc_aaa', label: '快到期号', accessToken: 't1', enabled: true, creditDetail: [{ package: '签到包', remain: 50, expireAt: Date.now() + 2 * 86400_000 }] },
    { id: 'acc_bbb', label: '长到期号', accessToken: 't2', enabled: true, creditDetail: [{ package: '年包', remain: 5000, expireAt: Date.now() + 300 * 86400_000 }] },
  ],
};
fs.writeFileSync(path.join(getConfigDir(), 'auth.cn-cli.pool.json'), JSON.stringify(pool, null, 2));

const first = pickAccount('cn-cli');
const second = pickAccount('cn-cli', { exclude: ['acc_aaa'] });
console.log('first pick =', first?.id, `(期望 acc_aaa，最早到期优先)`);
console.log('second pick =', second?.id, `(排除第一个后轮到 acc_bbb)`);

// 切到 pinned 后再选
cfg.pool.policy = 'pinned';
cfg.pool.pinnedAccountId = 'acc_bbb';
const { saveConfig } = await import('../src/config.mjs');
saveConfig(cfg);
console.log('pinned pick =', pickAccount('cn-cli')?.id, `(期望 acc_bbb)`);

const fail = first?.id !== 'acc_aaa' || second?.id !== 'acc_bbb' || pickAccount('cn-cli')?.id !== 'acc_bbb';
console.log(fail ? 'SMOKE-FAIL' : 'SMOKE-OK');
process.exit(fail ? 1 : 0);
