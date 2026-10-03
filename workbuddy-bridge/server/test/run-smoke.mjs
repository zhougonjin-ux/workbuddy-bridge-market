// 冒烟启动器：先把 WB_CONFIG_DIR 指向全新临时目录，再以子进程跑 pick.smoke.mjs。
//
// 为什么需要启动器：pick.smoke.mjs 操作账号池文件，一旦跑在真实数据目录上就会
// 用夹具账号覆盖生产凭证（2026-10-03 事故：8788 全部掉线）。Windows 的 npm scripts
// 里没法直接内联设环境变量（cross-env 是第三方依赖，本项目保持零依赖），
// 所以用 Node 自己拉子进程注入 env。pick.smoke.mjs 里另有「未隔离即拒绝运行」守卫双保险。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'wbbridge-smoke-'));
const target = fileURLToPath(new URL('./pick.smoke.mjs', import.meta.url));
const r = spawnSync(process.execPath, [target], {
  env: { ...process.env, WB_CONFIG_DIR: dir },
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
