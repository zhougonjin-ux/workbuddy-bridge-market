// SessionStart hook：确保本地 WorkBuddy 代理在运行（幂等，绝不阻塞会话）。
//
// 行为：
//   1) 读数据目录（~/.zcode/workbuddy-bridge）里的 config.json 拿端口（没有就用默认 8788）
//   2) GET /health 探测；活着就直接退出
//   3) 没活着 → 后台拉起 server/server.mjs（分离进程，不随会话退出）
//   4) 数据目录放 autostart.json {"enabled":false} 可永久关闭自动拉起
// 任何异常都静默退出（exit 0），绝不影响 ZCode 会话启动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const main = async () => {
  const __dbg=(...a)=>console.error('[dbg]',...a);__dbg('main start');
  try {
    const dataDir = process.env.WB_CONFIG_DIR || path.join(os.homedir(), '.zcode', 'workbuddy-bridge');

    // 自动拉起开关（默认开）
    try {
      const gate = JSON.parse(fs.readFileSync(path.join(dataDir, 'autostart.json'), 'utf8'));
      if (gate.enabled === false) return;
    } catch {
      /* 没有开关文件 = 默认开 */
    }

    let port = 8788;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      if (Number.isInteger(cfg.port) && cfg.port > 0) port = cfg.port;
    } catch {
      /* 还没生成过配置，用默认端口 */
    }

    // 活着就退出（1.5 秒超时，健康检查必须快）
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      __dbg('health res.ok =',res.ok);if (res.ok) return;
    } catch (e) { __dbg('health failed:',e.cause?.code||e.message); }

    const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
    const serverEntry = path.join(serverDir, 'server.mjs');
    __dbg('serverEntry =',serverEntry,fs.existsSync(serverEntry));if (!fs.existsSync(serverEntry)) return;

    // 子进程输出落到数据目录 server.log：拉起失败时可以查原因，不再静默消失
    let stdio = 'ignore';
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      stdio = fs.openSync(path.join(dataDir, 'server.log'), 'a');
      fs.writeSync(stdio, `\n===== hook 拉起 ${new Date().toLocaleString()} =====\n`);
    } catch {
      /* 打不开日志文件就退回 ignore */
    }

    const child = spawn(process.execPath, [serverEntry], {
      cwd: serverDir,
      detached: true,
      stdio: ['ignore', stdio, stdio],
      env: { ...process.env, WB_CONFIG_DIR: dataDir, WB_HOOK_SPAWN: '1' },
      windowsHide: true,
    });
    child.on('error', () => {}); // 拉起失败也不报错——用户可手动 /wbp-start
    __dbg('spawned pid=',child.pid);child.unref();
  } catch {
    /* 吞掉一切，hook 失败不该影响会话 */
  } finally {
    process.exit(0);
  }
};

main();
