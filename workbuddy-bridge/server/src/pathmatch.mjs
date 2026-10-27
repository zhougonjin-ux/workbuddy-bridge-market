// 路径分段匹配：server.mjs 的「模型请求计数」与「协议分派」共用同一套口径。
//
// 之前 hasSeg 在 server.mjs 里写了两遍（isModelPath 内一次、主路由一次），
// 两处必须永远一致——TraeWork 会拼出 /v1/messages/chat/completions 这类路径，
// 一处漏判就会把模型请求当成后台请求（重启时被掐断）或反之。

/** 把 pathname 切成非空段。 */
export function pathSegments(pathname) {
  return String(pathname || '').split('/').filter(Boolean);
}

/** 在段序列里找「连续匹配 want」的位置（不是子串匹配：/v1/models2 不算 models）。 */
export function hasSegments(segs, ...want) {
  for (let i = 0; i + want.length <= segs.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (segs[i + j] !== want[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** 路径便捷版（内部自己切段）。 */
export function hasPathSegments(pathname, ...want) {
  return hasSegments(pathSegments(pathname), ...want);
}

/**
 * 是否「模型调用」——只有这类请求算活跃请求（掐断它 = 用户会话断线）。
 *
 * 覆盖：OpenAI 兼容（/v1/*）、根路径的协议端点（Anthropic 与 responses 在根路径）、
 * 以及 GET /v1/models（客户端启动时拉模型列表，掐断等于会话连不上）。
 * 其余（/health、/console/**、/admin/**、/status 等后台与发现类接口）都不计入。
 */
export function isModelPath(pathname) {
  if (pathname === '/health' || pathname === '/healthz') return false;
  if (pathname.startsWith('/console') || pathname.startsWith('/admin')) return false;
  if (pathname === '/status') return false;
  const segs = pathSegments(pathname);
  return (
    hasSegments(segs, 'models') ||
    hasSegments(segs, 'chat', 'completions') ||
    hasSegments(segs, 'completions') ||
    hasSegments(segs, 'messages') ||
    hasSegments(segs, 'responses') ||
    hasSegments(segs, 'embeddings')
  );
}