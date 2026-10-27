// Node 运行时守卫：版本过低时给出可操作的中文提示，而不是让用户面对
// 「fetch is not defined」「AbortSignal.timeout is not a function」这类裸报错。
//
// 为什么最低 20：Node 18 已于 2025-04 结束维护，且本项目依赖稳定的
// node:test / fetch / AbortSignal.timeout / structuredClone。继续声称支持 18
// 只会把「升级 Node」这件小事拖成一次排障。
export const MIN_NODE_MAJOR = 20;

export function nodeMajor(version = process.versions.node) {
  return Number(String(version || '').split('.')[0]) || 0;
}

/**
 * 校验当前 Node 版本；不满足时打印一段人能读懂的说明。
 * @param {{ exit?: boolean, logger?: (msg: string) => void }} opts
 * @returns {{ ok: boolean, major: number, version: string }}
 */
export function assertNodeVersion({ exit = true, logger = console.error } = {}) {
  const version = process.versions.node;
  const major = nodeMajor(version);
  if (major >= MIN_NODE_MAJOR) return { ok: true, major, version };

  logger('');
  logger(`✗ 需要 Node.js ${MIN_NODE_MAJOR} 或更高版本，当前是 v${version}。`);
  logger('  原因：代理服务依赖 fetch / AbortSignal.timeout / node:test 等稳定能力，');
  logger('  低版本会以各种「莫名其妙的 API 报错」出现，而不是直接说版本不对。');
  logger('  Node 18 已于 2025-04 结束维护，请到 https://nodejs.org/ 安装 LTS（20/22/24 均可）。');
  logger('  装好后重开终端确认：node -v');
  logger('');
  if (exit) process.exit(1);
  return { ok: false, major, version };
}