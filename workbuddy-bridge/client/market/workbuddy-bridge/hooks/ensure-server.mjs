// SessionStart hook：确保本地 WorkBuddy 代理在运行（幂等，绝不阻塞会话）。
//
// 实现在 server/src/autostart.mjs（三条链路共用：SessionStart hook / MCP 入口 / 开机计划任务）。
// 这里只做 hook 适配：拉起即返回（waitMs=0，不等待就绪），任何异常静默退出（exit 0）。
// 数据目录放 autostart.json {"enabled":false} 可永久关闭自动拉起。
import { ensureProxyRunning } from '../server/src/autostart.mjs';

const main = async () => {
  await ensureProxyRunning({ source: 'session-hook' });
  process.exit(0);
};

main();
