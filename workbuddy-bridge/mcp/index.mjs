// workbuddy-bridge MCP 服务器（零依赖，stdio）。
//
// 职责：把本地反代（server/server.mjs）的管理面暴露成 ZCode 可调用的工具。
// 管理面与本 MCP 分离：代理是唯一事实源，MCP 只做 HTTP 转发与结果排版；
// 代理没启动时返回可操作的引导信息，而不是报一堆 ECONNREFUSED。
//
// 协议：MCP stdio（换行分隔的 JSON-RPC 2.0）。日志一律走 stderr，stdout 只发协议帧。
import { loadConfig, primaryKey } from '../server/src/config.mjs';
import { ensureProxyRunning } from '../server/src/autostart.mjs';
import { readFileSync } from 'node:fs';

// 版本号以 server/package.json 为唯一事实源（serverInfo 版本号会报告给客户端）。
// 曾硬编码 '0.1.0' 而 server 已是 0.3.2，两端版本号对不上。
let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8')).version || VERSION;
} catch {
  // 读不到就保持兜底值，不影响协议运行
}

/* ---------------- 本地代理 HTTP 客户端 ---------------- */

function baseOf(cfg) {
  return `http://${cfg.host}:${cfg.port}`;
}

/** 从 fetch 的异常里挖出网络错误码：cause 可能是带 code 的 Error，也可能是 AggregateError。 */
function errorCode(e) {
  const c = e?.cause;
  return c?.code || c?.errors?.[0]?.code || '';
}

async function callLocal(cfg, path, { method = 'GET', body = null, timeoutMs = 60_000, retried = false } = {}) {
  const headers = { Accept: 'application/json' };
  const key = primaryKey(cfg);
  if (key) headers.Authorization = 'Bearer ' + key;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(baseOf(cfg) + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 超时和连接被拒是两回事：超时说明代理活着但活儿没干完（服务端会继续跑完），
    // 文案混在「请先启动代理」里会把排障方向带偏
    if (e?.name === 'TimeoutError') {
      throw new Error(`代理响应超时（${Math.round(timeoutMs / 1000)}s）：请求已受理、服务端会继续执行，稍后可用 wb_tasks_status 查看结果。`);
    }
    // 连接被拒（代理没起）→ 自愈：拉起代理并等就绪后重试一次。
    // 钩子链路万一失效（hook 未注册/被禁用/新机器异常），工具调用本身就是兜底启动路径。
    // cause 的形态不定：字面 IP 直连是带 code 的 Error；主机名解析到多地址时是 AggregateError
    // （code 为空，各分支错误在 errors[] 里），所以两处都取。
    const code = errorCode(e);
    if (!retried && (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'EACCES')) {
      const r = await ensureProxyRunning({ waitMs: 5000, source: 'mcp-selfheal' });
      // alive = 探测时已被别的链路拉起；spawned = 本次拉起并等到就绪。两种都值得重试。
      if (r.ok && (r.action === 'spawned' || r.action === 'alive')) {
        return callLocal(cfg, path, { method, body, timeoutMs, retried: true });
      }
    }
    const hint = [
      `本地 WorkBuddy 代理没有响应（${code || e.name || e.message}）。`,
      `请先启动代理：/wbp-start 命令，或运行  node "${process.env.WB_BRIDGE_SERVER_DIR || '<插件目录>'}/server/server.mjs"`,
    ].join('\n');
    throw new Error(hint);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`代理返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = json?.error || json?.msg || text.slice(0, 200);
    throw new Error(`代理 HTTP ${res.status}：${msg}`);
  }
  return json;
}

/* ---------------- 结果排版 ---------------- */

const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—');
const fmtDate = (t) => {
  if (!t) return '无到期信息';
  const d = new Date(t);
  const days = Math.round((t - Date.now()) / 86_400_000);
  return `${d.toLocaleDateString()}（${days <= 0 ? '已到期' : `${days} 天后`}）`;
};

function renderBridge(b, { planOnly = false } = {}) {
  const lines = [];
  if (!planOnly) {
    lines.push(`调度策略：${b.policy}${b.policy === 'pinned' ? `（固定账号 ${b.pinnedAccountId || '未设置'}）` : ''}`);
    lines.push(`积分明细刷新：每 ${b.creditRefreshMinutes} 分钟 | 自动任务：${b.tasks?.enabled === false ? '关' : `开（签到 ${b.tasks?.checkin !== false ? '开' : '关'} / 成长任务 ${b.tasks?.growth !== false ? '开' : '关'}）`}`);
  }
  for (const s of b.sites || []) {
    lines.push('');
    lines.push(`■ ${s.site}  ${s.label}`);
    if (!s.accounts.length) {
      lines.push('    （无账号。用 /wb-login 或 wb_login 工具添加）');
      continue;
    }
    for (const row of s.plan) {
      const a = s.accounts.find((x) => x.id === row.id) || {};
      const mark = row.exhausted ? ' [额度耗尽]' : a.enabled === false ? ' [已禁用]' : '';
      lines.push(`  · ${row.label}${mark}`);
      lines.push(`      余额：${row.remain === null ? '未知（还没刷新过）' : row.remain}   最早到期：${fmtDate(row.earliestExpiry)}`);
      for (const bt of row.batches || []) {
        lines.push(`      - ${bt.package || '积分包'}：余 ${bt.remain}，${bt.expireAt ? '到期 ' + fmtDate(bt.expireAt) : '无到期信息'}`);
      }
    }
  }
  return lines.join('\n');
}

function renderTasks(t) {
  const lines = [`今天：${t.today}   状态文件：${t.stateFile}`];
  const one = (label, map) => {
    lines.push('');
    lines.push(`${label}：`);
    const entries = Object.entries(map || {});
    if (!entries.length) return lines.push('  （还没有记录）');
    for (const [uid, e] of entries) {
      lines.push(`  · ${uid}  ${e.date}  ${e.ok ? '✅' : '❌'}  ${e.msg || (e.claimed != null ? `报名 ${e.accepted} 领奖 ${e.claimed}（+${e.creditGained} 积分）` : '')}`);
    }
  };
  one('签到', t.checkin);
  one('连登管家（T50）', t.streak);
  one('成长任务', t.growth);
  return lines.join('\n');
}

/* ---------------- 工具定义 ---------------- */

const TOOLS = [
  {
    name: 'wb_status',
    description: '查看 WorkBuddy 桥接状态：所有账号的积分余额、每批积分的到期时间、当前调度策略。查询积分/到期情况时用它。',
    inputSchema: { type: 'object', properties: {} },
    run: async (cfg) => renderBridge(await callLocal(cfg, '/admin/bridge')),
  },
  {
    name: 'wb_credit_plan',
    description: '查看积分建议消耗顺序（按最早到期时间排序的账号/积分包列表）。只关心先用哪个积分时用它。',
    inputSchema: { type: 'object', properties: {} },
    run: async (cfg) => renderBridge(await callLocal(cfg, '/admin/bridge'), { planOnly: true }),
  },
  {
    name: 'wb_switch',
    description: '切换 WorkBuddy 账号调度策略或固定某个账号。policy 取值：expiry-first（最早到期优先，默认）/ balance-first（余额优先）/ round-robin（轮询）/ pinned（固定账号，需给 accountId）/ free-first（有 0 倍率免费站点的模型优先走免费站点）。',
    inputSchema: {
      type: 'object',
      properties: {
        policy: { type: 'string', enum: ['expiry-first', 'balance-first', 'round-robin', 'pinned', 'free-first'], description: '调度策略' },
        accountId: { type: 'string', description: 'pinned 策略下固定使用的账号 id（wb_status 里可查）' },
      },
      required: ['policy'],
    },
    run: async (cfg, args) => {
      const r = await callLocal(cfg, '/admin/policy', {
        method: 'POST',
        body: { policy: args.policy, pinnedAccountId: args.accountId ?? null },
      });
      return `已切换：策略=${r.policy}${r.policy === 'pinned' ? `（${r.pinnedAccountId || '未设置，请再传 accountId'}）` : ''}`;
    },
  },
  {
    name: 'wb_models',
    description: '列出 WorkBuddy 账号可用的模型清单（含积分倍率）。',
    inputSchema: { type: 'object', properties: {} },
    run: async (cfg) => {
      const r = await callLocal(cfg, '/console/api/models');
      const lines = [`默认模型：${r.default_model}（站点 ${r.default_site}）`];
      for (const m of r.data || []) {
        lines.push(`  · ${m.id}  ${m.name}${m.multiplier != null ? `  倍率 x${m.multiplier}` : ''}${m.free ? '（0 扣费）' : ''}${m.pending_login ? '（站点未登录）' : ''}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'wb_login_start',
    description: '添加 WorkBuddy 账号（第一步）：发起设备授权登录，返回一个授权链接，请用户在浏览器打开并登录。',
    inputSchema: {
      type: 'object',
      properties: { site: { type: 'string', enum: ['cn-cli', 'intl-cli', 'intl-work'], description: '站点，默认 cn-cli（国内版）' } },
    },
    run: async (cfg, args) => {
      const r = await callLocal(cfg, '/console/api/login/start', { method: 'POST', body: { site: args?.site || 'cn-cli' } });
      if (r.authUrl) return `请在浏览器打开下面的链接并登录 WorkBuddy：\n${r.authUrl}\n\n登录完成后用 wb_login_poll 轮询结果（state=${r.state}）。`;
      return `已发起：${JSON.stringify(r).slice(0, 300)}`;
    },
  },
  {
    name: 'wb_login_poll',
    description: '添加 WorkBuddy 账号（第二步）：查询设备授权登录是否完成；完成后账号自动入池。',
    inputSchema: {
      type: 'object',
      properties: { site: { type: 'string', description: '站点，与 wb_login_start 一致' }, state: { type: 'string', description: 'wb_login_start 返回的 state' } },
      required: ['state'],
    },
    run: async (cfg, args) => {
      const site = args?.site || 'cn-cli';
      const r = await callLocal(cfg, `/console/api/login/poll?site=${encodeURIComponent(site)}&state=${encodeURIComponent(args.state)}`);
      return r.done ? `登录成功 ✅ 账号「${r.auth?.label || r.auth?.nickname || r.auth?.id}」已入池。` : `尚未完成：${r.msg || '等待用户在浏览器确认'}`;
    },
  },
  {
    name: 'wb_refresh_credits',
    description: '立即刷新所有账号的积分余额与到期明细（平时每 30 分钟自动刷一次）。',
    inputSchema: { type: 'object', properties: {} },
    run: async (cfg) => {
      const r = await callLocal(cfg, '/admin/credit/refresh', { method: 'POST' });
      const lines = [];
      for (const [site, list] of Object.entries(r.results || {})) {
        for (const x of list) lines.push(`  · [${site}] ${x.label}: ${x.ok ? `余 ${x.remain}` : `失败 ${x.error}`}`);
      }
      return `刷新完成\n${lines.join('\n')}`;
    },
  },
  {
    name: 'wb_import_local',
    description: '自动导入本机已登录的 WorkBuddy/CodeBuddy 客户端账号（从 ~/.codebuddy 客户端配置提取登录态，免扫码）。服务每次启动也会自动尝试一次。',
    inputSchema: { type: 'object', properties: {} },
    run: async (cfg) => {
      const r = await callLocal(cfg, '/admin/local/import', { method: 'POST' });
      const lines = (r.found || []).map((f) => `  · [${f.status === 'imported' ? '新增' : f.status === 'updated' ? '更新' : '跳过'}] ${f.nickname || f.uid}（${f.site}）${f.reason ? '：' + f.reason : ''}${f.exp ? '，token 有效期至 ' + new Date(f.exp).toLocaleDateString() : ''}`);
      return `扫描 ${r.scannedFiles} 个配置文件：新增 ${r.imported}，更新 ${r.updated}，跳过 ${r.skipped}\n${lines.join('\n') || '（没有发现可导入的登录态）'}`;
    },
  },
  {
    name: 'wb_tasks_run',
    description: '立即执行自动任务：kind=checkin（每日签到+连登管家）/ growth（成长任务报名+领奖）/ travel（猫猫巡逻）/ streak（仅连登管家：补签+兑换+抽奖）/ all。',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['checkin', 'growth', 'travel', 'streak', 'all'], description: '任务类型，默认 all' } },
    },
    run: async (cfg, args) => {
      // all 会跑 checkin+streak+growth+travel：多账号 × 每任务最多 5 次代打（真实上游 LLM
      // 往返），轻松超过 60s 工具默认超时——这里给 4 分钟，超时后提示查状态而不是误导排障。
      // busy 对象在 results 字段里（server 把 runTasks 的返回整个塞进 results）
      const r = await callLocal(cfg, '/admin/tasks/run', { method: 'POST', body: { kind: args?.kind || 'all' }, timeoutMs: 240_000 });
      if (r.results?.busy) return `任务执行：${r.results.msg}`;
      return `任务执行结果：\n${JSON.stringify(r.results, null, 2).slice(0, 2000)}`;
    },
  },
  {
    name: 'wb_tasks_status',
    description: '查看自动任务的今日执行状态与历史记录。',
    inputSchema: { type: 'object', properties: {} },
    run: async (cfg) => renderTasks(await callLocal(cfg, '/admin/tasks')),
  },
  {
    name: 'wb_travel_patrol',
    description: '派猫猫旅行巡逻（立即跑一轮）：到站领奖 / 空闲则派出 / 旅行中则报告进度。状态机幂等，一天可多次。',
    inputSchema: { type: 'object', properties: {} },
    run: async (cfg) => {
      const r = await callLocal(cfg, '/admin/tasks/run', { method: 'POST', body: { kind: 'travel' } });
      if (r.results?.busy) return `猫猫巡逻：${r.results.msg}`;
      const lines = [];
      for (const [key, list] of Object.entries(r.results || {})) {
        if (!Array.isArray(list)) continue; // busy 形态或异常形状不炸迭代
        for (const x of list) lines.push(`  · [${key}] ${x.label || x.id}: ${x.msg || x.error || (x.skipped ? '今日已跑过' : '完成')}`);
      }
      return `猫猫巡逻结果：\n${lines.join('\n') || '（没有账号）'}`;
    },
  },
  {
    name: 'wb_recent_requests',
    description: '查看最近的模型请求明细（最多 50 条，新→旧）：时间/模型/模式/耗时/tok/s/消耗积分，含异常消耗标注。排查速度与费用时用它。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数，默认 20，最大 50' } },
    },
    run: async (cfg, args) => {
      const n = Math.min(50, Math.max(1, Number(args?.limit) || 20));
      const r = await callLocal(cfg, `/console/api/recent-requests`);
      const list = (r.requests || []).slice(0, n);
      if (!list.length) return '还没有请求记录。';
      const lines = list.map((x) => {
        const t = new Date(x.at).toLocaleTimeString();
        const tok = x.tok_s ? `${x.tok_s} tok/s` : x.completion != null ? `${x.completion} tok` : '';
        return `  · ${t}  ${x.model}（${x.site}）${x.mode} ${x.status}${tok ? `  ${tok}` : ''}${x.ms ? `  ${x.ms}ms` : ''}${x.credit != null ? `  ${x.credit}分` : ''}${x.anomaly ? '  ⚠️异常消耗' : ''}${x.note ? `  ${x.note}` : ''}`;
      });
      return `最近 ${list.length} 条请求：\n${lines.join('\n')}`;
    },
  },
  {
    name: 'wb_task_play',
    description: '单任务代打/领奖（成长任务中心）：对指定任务手动代打几次极小对话或领取已达标的奖励。先用 wb_tasks_status 或控制台任务中心看任务 code。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'claim'], description: 'play=代打几次对话点亮进度；claim=领取达标奖励' },
        accountId: { type: 'string', description: '账号 id（wb_status 里可查）；缺省用第一个可用账号' },
        code: { type: 'string', description: '任务 code（如 Model_chat_GLM5.2、black_cat）' },
        times: { type: 'string', description: 'play 时代打次数（默认补齐到 target，受单任务上限约束）' },
      },
      required: ['action', 'code'],
    },
    run: async (cfg, args) => {
      const code = String(args.code || '').trim();
      if (!code) return '缺少任务 code（先在控制台任务中心或 wb_tasks_status 里看任务列表）。';
      let site = null, accountId = String(args.accountId || '');
      if (accountId) {
        // 从桥接状态反查账号所在站点
        const b = await callLocal(cfg, '/admin/bridge');
        for (const s of b.sites || []) {
          if ((s.accounts || []).some((a) => a.id === accountId)) { site = s.site; break; }
        }
        if (!site) return `找不到账号 ${accountId}（wb_status 里可查账号 id）。`;
      } else {
        const b = await callLocal(cfg, '/admin/bridge');
        for (const s of b.sites || []) {
          const usable = (s.accounts || []).find((a) => a.enabled !== false && !a.exhaustedAt);
          if (usable) { site = s.site; accountId = usable.id; break; }
        }
        if (!site) return '没有可用账号，先添加账号。';
      }
      if (args.action === 'claim') {
        const r = await callLocal(cfg, '/console/api/task-center/claim', { method: 'POST', body: { site, accountId, code } });
        return r.ok ? `已领取：${r.msg}` : `领不了：${r.msg}`;
      }
      const body = { site, accountId, code };
      // times 原样透传（字符串 "0"/负数等语义由服务端校验并给出明确报错）
      if (args.times != null) body.times = args.times;
      const r = await callLocal(cfg, '/console/api/task-center/play', { method: 'POST', body });
      return `${r.ok ? '✅' : '✗'} ${r.msg}${r.error ? `（${r.error}）` : ''}`;
    },
  },
];

/* ---------------- MCP stdio 协议 ---------------- */

function reply(id, result) {
  try {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  } catch {
    /* 宿主关掉了管道（EPIPE 同步抛）：吞掉别让未捕获异常刷栈 */
  }
}

function replyError(id, code, message) {
  try {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  } catch {
    /* 同上 */
  }
}

// Windows 的管道写是同步的（上面 catch 能接住）；macOS/Linux 是异步 error 事件，
// 接不住会变成 uncaughtException——插件优先 Windows，这里补一行跨平台兜底
process.stdout.on?.('error', () => {});

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'workbuddy-bridge', version: VERSION },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // 通知无需应答
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) {
          return isNotification ? undefined : replyError(id, -32602, `未知工具：${params?.name}`);
        }
        let cfg;
        try {
          cfg = loadConfig();
        } catch (e) {
          return isNotification ? undefined : reply(id, { content: [{ type: 'text', text: `配置读取失败：${e.message}` }], isError: true });
        }
        try {
          const text = await tool.run(cfg, params?.arguments || {});
          return reply(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          return isNotification ? undefined : reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
        }
      }
      default:
        if (!isNotification) replyError(id, -32601, `未知方法：${method}`);
        return;
    }
  } catch (e) {
    if (!isNotification) replyError(id, -32603, e.message);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');

// MCP 进程起来就拉一次代理（幂等）：SessionStart hook 失效时（未注册/被禁用/新机器异常），
// 首个 MCP 工具调用前的这一步是第二条兜底链路；拉起不阻塞协议握手（waitMs=0）。
ensureProxyRunning({ source: 'mcp-boot' });

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, -32700, 'parse error');
      continue;
    }
    void handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.stderr.write(`[workbuddy-bridge] MCP 服务器已启动（stdio，${TOOLS.length} 个工具）\n`);
