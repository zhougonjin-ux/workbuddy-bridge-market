// 冒烟：pickAccount 在真实配置链路（config.json → pool.policy）下的到期优先选号。
// 用临时 WB_CONFIG_DIR，不碰真实数据目录。
import fs from 'node:fs';
import path from 'node:path';
import { pickAccount } from '../src/pool.mjs';
import { loadConfig, getConfigDir } from '../src/config.mjs';

const cfg = loadConfig();
console.log('data dir =', getConfigDir());
console.log('policy   =', cfg.pool.policy);
console.log('apiKey   =', (cfg.apiKey || '').slice(0, 9) + '…');

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
