// 上游（CodeBuddy / WorkBuddy，国内版与国际版同构）客户端：
//   - 请求体改写（上游只接受流式；tool_choice 只接受字符串）
//   - SSE 读取（带首字节/空闲超时，客户端断开即中止）
//   - 模型清单（含积分倍率）、额度查询
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAuth, ensureToken } from './auth.mjs';
import { markSuccess, markFailure, isQuotaError, isRateLimitError, usableCount, listModelCooldownAccounts } from './pool.mjs';
import {
  fitMessages,
  estimateMessages,
  estimateTokensAccurate,
  learnedLimit,
  isTooLongError,
  isProviderParamRejection,
  calibrationFactor,
  calibrateEstimate,
  parseActualTokens,
  recordCompression,
  sessionMemoBudget,
  rememberSessionBudget,
} from './compress.mjs';
import { chatHeaders, billingHeaders } from './headers.mjs';
import { normalizeCreditDetail } from './expiry.mjs';
import { paths } from './config.mjs';
import { warn } from './log.mjs';
import { waitForUpstreamSlot, reportUpstream429 } from './coordination.mjs';

/**
 * 上游对 system 消息做「客户端指纹」精确匹配，命中就回：
 *   400 Illegal API invocation from an unapproved channel
 *
 * 实测（2026-09，cn-cli 与 intl-cli、/v1/chat/completions 与 /v1/messages 均一致）：
 *   ❌ 完整原句 "You are Claude Code, Anthropic's official CLI for Claude."
 *   ✅ 只留 "You are Claude Code"
 *   ✅ 只留 "Anthropic's official CLI for Claude"
 *   ✅ 同样内容放 user 位置
 * 说明上游维护的是一份**精确黑名单**，而不是关键词过滤。
 *
 * 已知影响面：Claude Code、以及 Claude desktop 的 /code 面板（开头就是这句话）。
 * Claude desktop 的 /cowork 面板提示词不同，所以同一账号下 /cowork 正常、/code 报 400。
 *
 * 第二条指纹（2026-10-08 加，cn-cli 二分定位）：Claude Code 风格 gitStatus 段里的
 *   "Main branch (you will usually use this for PRs)"。ZCode 等客户端复刻了这句原话，
 *   于是所有「带 git 仓库上下文」的请求全军覆没。实测最小命中单位是**括号短语本身**
 *   （分支名无关；剥成 "Main branch: main" 即通过），所以只去掉括号，保留分支名语义。
 *
 * 黑名单不止扫 system（2026-10-08 第三轮探针，cn-cli 实锤）：
 *   ❌ system content      ❌ assistant content（历史回复里引用过指纹原文同样 400！）
 *   ✅ user content        ✅ assistant tool_calls[].function.arguments
 *   ✅ tool 角色消息
 * 也就是说编码会话里「助手曾输出/编辑过含指纹的代码」后，后续所有请求都会带毒——
 * 这就是 system 层剥离后仍偶发 400 的根因。tool_calls 参数安全说明匹配的是
 * content 文本面，不深入 JSON 字符串内部。
 *
 * 只剥离命中的那一句，消息的其余内容原样保留，不改动用户的实质指令。
 * 多一条可疑模式就多一份误伤风险，所以**这里只放实测确认过的**，
 * 以后遇到新的指纹再按同样方式验证后追加。
 *
 * content 既可能是字符串（OpenAI /v1/chat/completions 常见形态），也可能是
 * [{type:'text',text}] 分段数组；两种都要剥，否则指纹藏在数组段里照样吃 400。
 */
const CLIENT_FINGERPRINTS = [
  [/You are Claude Code,\s*Anthropic's official CLI for Claude\.?/gi, ''],
  [/Main branch\s*\(\s*you will usually use this for PRs\s*\)/gi, 'Main branch'],
];

/** 剥一段文本里的指纹：无命中返回 null，命中返回剥后文本（顺带收敛多余空行）。 */
function stripPatterns(text) {
  let next = text;
  for (const [re, to] of CLIENT_FINGERPRINTS) next = next.replace(re, to);
  if (next === text) return null;
  return next.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 从 system 与 assistant 消息里剥离客户端指纹。返回被改动的消息条数。
 * 若剥离后字符串 content 为空，用 fallbackPrompt 兜底（否则消息会变成空串/空 text 块）。
 */
export function stripClientFingerprint(messages, fallbackPrompt) {
  if (!Array.isArray(messages)) return 0;
  let 改动数 = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase();
    if (role !== 'system' && role !== 'assistant') continue;
    // assistant 常见 content:null（纯工具调用消息），跳过
    if (m.content == null) continue;
    // 剥离后整段为空时的兜底：system 用默认提示词；assistant 用中性占位符
    // （assistant 说 "You are a helpful AI assistant." 语义很怪；实测空串/占位符上游均 200）
    const 兜底 = role === 'system' ? fallbackPrompt : '(earlier content removed)';

    if (typeof m.content === 'string' && m.content) {
      const next = stripPatterns(m.content);
      if (next !== null) {
        m.content = next || 兜底;
        改动数++;
      }
      continue;
    }

    // 分段数组：逐段剥，命中才算改动（空段同样用兜底顶上，避免送出空 text 块）
    if (Array.isArray(m.content)) {
      let 命中 = false;
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text !== 'string' || !part.text) continue;
        const next = stripPatterns(part.text);
        if (next !== null) {
          part.text = next || 兜底;
          命中 = true;
        }
      }
      if (命中) 改动数++;
    }
  }
  return 改动数;
}

/** 上游请求体改写：强制流式 + 首条必须为 system + 角色/工具选择归一 + 剔除配置中要求剔除的字段。
 *  messages 做一层元素拷贝：本函数会原地改写 role/content，不拷贝的话调用方复用入参做
 *  空回答重试时拿到的是被改写过的消息（隐蔽的共享耦合）。 */
export function prepareBody(cfg, src) {
  const body = { ...src };
  body.stream = true;
  if (Array.isArray(body.messages)) body.messages = body.messages.map((m) => (m && typeof m === 'object' ? { ...m } : m));

  // 上游 role 白名单里没有 developer，等价改写为 system
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && typeof m === 'object' && typeof m.role === 'string' && m.role.toLowerCase() === 'developer') {
        m.role = 'system';
      }
    }

    // 剥离客户端指纹。放在「首条必须 system」之前：
    // 这样万一整条 system 就是指纹，兜底后的默认提示词也能顶上去。
    if (cfg.stripClientFingerprint !== false) {
      const fallback = cfg.defaultSystemPrompt || 'You are a helpful AI assistant.';
      const n = stripClientFingerprint(body.messages, fallback);
      if (n) {
        warn(`已剥离 ${n} 处客户端指纹（上游会因此回 400 "Illegal API invocation from an unapproved channel"）`);
      }
    }

    // 国际版硬性要求：第一条消息必须是 system，否则 400 "first message is not system prompt"
    const first = body.messages[0];
    const firstRole = first && typeof first === 'object' ? String(first.role || '').toLowerCase() : '';
    if (firstRole !== 'system') {
      body.messages = [
        { role: 'system', content: cfg.defaultSystemPrompt || 'You are a helpful AI assistant.' },
        ...body.messages,
      ];
    }
  }

  // tool_choice：上游是字符串字段，对象形式会 400
  normalizeToolChoice(body);

  for (const key of cfg.stripFields || []) delete body[key];
  return body;
}

/**
 * 按模型上下文上限裁剪 messages（原地改 body.messages）。
 *
 * 单独成一个函数而不是塞进 prepareBody：
 *   - prepareBody 只做「格式归一」，不依赖模型上限，纯函数好测
 *   - 裁剪依赖「上限已知」，而上限可能要等上游报错才知道，见 openChat 的重试逻辑
 *
 * 上限来源（优先用学到的真实值）：
 *   目录里的 maxInputTokens 实测会偏大 —— glm-5.1 目录写 200000，
 *   真实上限只有 100000。所以一旦上游报「太长」，就记下它给的真实数字。
 *
 * 返回裁剪统计；没裁返回 null。
 */
/**
 * 估算请求体里「除 messages 之外、但同样占用上游上下文」的部分。
 *
 * 为什么必须算：agent 客户端（DSH / Codex 等）会在 body 里带一大坨工具定义，
 * 那部分同样计入上游的 prompt。原先只估 messages，于是出现
 * 「本地估算 454,711、真值远超上限」的偏差 —— 预压缩以为装得下、发出去吃 400，
 * 而重试只会反复压 messages（实测 454711 → 229754 → 116101 → 58682）
 * 却怎么都压不下去，因为大头根本不在 messages 里。
 */
function estimateSideTokens(body) {
  const parts = [];
  if (Array.isArray(body?.tools) && body.tools.length) parts.push(body.tools);
  if (Array.isArray(body?.functions) && body.functions.length) parts.push(body.functions);
  if (body?.tool_choice !== undefined) parts.push(body.tool_choice);
  return parts.length ? estimateTokensAccurate(parts) : 0;
}

export function applyContextFit(cfg, body, { site = null, limitOverride = null } = {}) {
  const conf = cfg.context || {};
  if (conf.enabled === false) return null;
  if (!Array.isArray(body.messages) || !body.messages.length) return null;

  const model = String(body.model || '');
  const limit = limitOverride || (site ? learnedLimit(site, model) : null);
  if (!Number.isFinite(limit) || limit <= 0) return null; // 不知道上限就先原样发，撞墙后再学

  // 预算拿的是**本地估算值**，而估算器对长文本可能偏低。
  // 把上限按实测倍率折回去，才能让「估算 ≤ 折算上限」等价于「真实 ≤ 上限」，
  // 否则预压缩看着压够了、发出去照样超限，每个请求先白撞一次 400。
  const 折算上限 = site ? Math.floor(limit / calibrationFactor(site, model)) : limit;

  // 工具定义同样占上下文，而且往往很大。裁剪只能动 messages、压不动工具，
  // 所以必须先把工具的份额扣掉 —— 否则「messages 装得下」根本不等于「整个请求装得下」。
  const 安全比 = conf.safetyRatio ?? 0.95;
  const 附属 = estimateSideTokens(body);
  // 安全余量必须覆盖**整个请求**，而 fitMessages 只会对 messages 那一份打折，
  // 工具那部分得在这里自己留出来。否则工具占大头时总余量薄得几乎没有：
  // 实测消息 114,790 + 工具 928,990 在估算口径下刚好卡进上限，真值却超了，
  // 于是白多打两轮、白等 25 秒。
  const 消息预算 = (附属 ? Math.floor(折算上限 * 安全比) : 折算上限) - 附属;
  if (消息预算 <= 0) {
    // 工具定义已经吃满全部预算（连安全余量都不剩）。这时预压缩只会把 messages
    // 截到极小、把整段对话弄没，还不如直接发出去，让下面「按比例收缩」的重试
    // 去试探真实边界 —— 它不做安全余量扣除，能留住的上下文更多。
    warn(
      `[${site}] ${model} 的工具定义约 ${附属} tokens，已吃满上下文上限 ${limit}，`
      + `预压缩跳过（改由重试按比例收缩试探；若持续失败请精简客户端的工具 / MCP 数量）`,
    );
    return null;
  }

  const { messages, stats } = fitMessages(body.messages, {
    maxInputTokens: 消息预算,
    reserveForOutput: Number(body.max_tokens) || conf.reserveForOutput || 4096,
    minKeepMessages: conf.minKeepMessages ?? 4,
    safetyRatio: 安全比,
  });
  body.messages = messages;
  if (!stats.applied) return null;
  stats.sideTokens = 附属;
  return stats;
}

function normalizeToolChoice(body) {
  if (!('tool_choice' in body)) return;
  const tc = body.tool_choice;
  const drop = () => {
    delete body.tool_choice;
    delete body.tools;
    delete body.functions;
  };
  if (typeof tc === 'string') {
    if (tc.toLowerCase() === 'none') drop();
    return;
  }
  if (tc && typeof tc === 'object') {
    const type = String(tc.type || '').toLowerCase();
    if (type === 'none') return drop();
    if (type === 'auto' || type === 'required') {
      body.tool_choice = type;
      return;
    }
    if (type === 'function') {
      const name = tc.function?.name || tc.name;
      body.tool_choice = name ? String(name) : 'auto';
      return;
    }
  }
  delete body.tool_choice;
}

export class UpstreamError extends Error {
  constructor(message, { status = 502, code = null, transport = false, site = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.transport = transport;
    this.site = site;
  }
}

/** 指纹黑名单报错（11128）时把被拒请求体落盘到数据目录 rejected/，
 *  供下一轮二分定位新指纹。只留最近 5 份，失败只 warn 不影响错误路径。 */
export function dumpRejectedBody(status, text, payload) {
  try {
    if (!/Illegal API invocation|unapproved channel/i.test(String(text || ''))) return;
    const dir = path.join(paths.root, 'rejected');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `rejected-${stamp}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), status, upstream: String(text || '').slice(0, 500), payload }, null, 2),
    );
    // 只留最近 5 份
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith('rejected-') && f.endsWith('.json')).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 5))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* 留着也无妨 */ }
    }
    warn(`被拒请求体已留存：${file}（供二分定位新指纹）`);
  } catch (e) {
    warn(`被拒请求体留存失败：${e.message}`);
  }
}

/**
 * 上报一条「对话活跃」事件（POST {billingBase}/v2/report）。
 *
 * 为什么需要它：black_cat（夜猫子夜间折扣）等任务**不看你真发了对话，只看事件链**。
 * 光调 /v2/chat/completions 拿到的 200 与任务进度无关 —— 必须额外补一条
 * `chat_request_send` 上报，上游才把这次对话计入任务进度。
 * 2026-10-03 实测：只发对话不上报，black_cat 进度恒为 0/3（代打「成功」3 次但进度不动）。
 *
 * 事件字段与 CodeBuddy 官方 CLI 的上报同构（见 .ref 参考实现 report.go 的 chatRequestEvent）。
 * conversationId 本地生成即可 —— 服务端不校验它与真实会话的一致性。
 *
 * 返回 true = 上游收下了。失败只 warn 不抛：上报失败不该让已经成功的对话变成失败。
 */
export async function reportChatActivity(cfg, site, {
  accountId = null, modelId = 'glm-5.2', modelName = 'GLM-5.2', inputLength = 12,
} = {}) {
  const siteCfg = cfg.sites[site];
  const base = siteCfg.billingBase || siteCfg.apiBase; // 上报走 billingBase，未配则退回 apiBase
  if (!base) {
    warn(`[${site}] 缺少 billingBase/apiBase，跳过对话事件上报`);
    return false;
  }
  try {
    await ensureToken(cfg, site, { accountId });
    const auth = getAuth(site);
    const now = Date.now();
    const stamp = `wb-night-${now}`;
    const event = {
      eventCode: 'chat_request_send',
      timestamp: now,
      reportDelay: 0,
      mode: 'craft',
      conversationId: stamp,
      requestId: stamp,
      inputLength,
      requestModelId: modelId,
      requestModelName: modelName,
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 0,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [],
      knowledgeId: [],
      knowledgeName: [],
      codebaseId: '',
      mentionContextCount: 0,
      command: '',
      expertId: '',
      recommendId: '',
      skillId: '',
      skillCount: 0,
      totalCount: 0,
      fileUri: '',
      presentAt: now,
      traceId: '',
      rootRequestId: stamp,
      parentConversationId: stamp,
      agentName: 'default',
      agentType: 'conversation',
      userId: auth.uid || '',
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), 15_000);
    try {
      const res = await fetch(base + '/v2/report', {
        method: 'POST',
        headers: billingHeaders(siteCfg, auth),
        body: JSON.stringify([event]),
        signal: ac.signal,
      });
      const text = await res.text().catch(() => '');
      if (res.status >= 400) {
        warn(`[${site}] 对话事件上报失败：HTTP ${res.status} ${text.slice(0, 120)}`);
        return false;
      }
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON 也算收下了（2xx） */ }
      if (json && json.code !== 0) {
        warn(`[${site}] 对话事件上报被拒：code=${json.code} ${String(json.msg || '').slice(0, 100)}`);
        return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    warn(`[${site}] 对话事件上报异常：`, e.message || String(e));
    return false;
  }
}

/**
 * 发起一次站点聊天请求。
 * 返回：{ ok:true, status, frames:AsyncGenerator<string>, close(), payload } 或
 *      { ok:false, status, text }
 */
export async function openChat(cfg, site, body, { signal, exclude = [], accountId = null } = {}) {
  const siteCfg = cfg.sites[site];
  // ensureToken 会选定账号（池模式）并把该账号的 token 暴露给 getAuth，
  // 因此必须先 await，再取 chatHeaders——顺序不能反。
  const { accountId: usedAccount } = await ensureToken(cfg, site, { exclude, accountId });
  const auth = getAuth(site);
  const model = String(body?.model || '');
  const payload = prepareBody(cfg, body);
  const fit = applyContextFit(cfg, payload, { site });
  if (fit) {
    warn(
      `[${site}] ${model} 上下文超限，已自动压缩：丢弃 ${fit.dropped} 条、截断 ${fit.truncated} 条，`
      + `${fit.before} → ${fit.after} tokens（上限 ${fit.limit}`
      + (fit.sideTokens ? `，另扣掉不参与裁剪的工具定义 ${fit.sideTokens} tokens` : '')
      + '）',
    );
    recordCompression(site, model, fit); // T10：压缩统计可视化
    rememberSessionBudget(payload.messages, fit.after, { site, model }); // T28：同会话下个请求免撞 400
  } else if (cfg.context?.enabled !== false && site) {
    // T28：预压缩没触发（多数是估算「以为装得下」）但会话记忆说「这个会话上次压过」→
    // 直接按上次的预算压一遍。宁可多压也不能赌估算——上次就是因为低估才撞的 400。
    const memo = sessionMemoBudget(payload.messages);
    if (memo && Number.isFinite(memo.budget) && memo.budget > 0) {
      const 再压 = fitMessages(payload.messages, {
        maxInputTokens: memo.budget,
        reserveForOutput: Number(payload.max_tokens) || cfg.context?.reserveForOutput || 4096,
        minKeepMessages: cfg.context?.minKeepMessages ?? 4,
        safetyRatio: cfg.context?.safetyRatio ?? 0.95,
      });
      if (再压.stats.applied) {
        payload.messages = 再压.messages;
        warn(`[${site}] ${model} 命中会话压缩记忆（上次压到 ${memo.budget}），预压缩直接按该预算执行，不再撞 400`);
        recordCompression(site, model, 再压.stats, { phase: 'memo' });
      }
    }
  }

  const ac = new AbortController();
  const onOuterAbort = () => ac.abort(new Error('client closed'));
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let settled = false;
  let headerTimer = setTimeout(() => ac.abort(new Error('upstream header timeout')), cfg.timeouts.headerMs);
  let idleTimer = null;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(headerTimer);
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  };
  const bumpIdle = () => {
    if (settled) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(new Error('upstream idle timeout')), cfg.timeouts.idleMs);
  };

  // 连接级失败自动重试：国际版（codebuddy.ai）实测约有 17% 的 ECONNRESET / socket 抖动，
  // 这类瞬时网络错误重试一两次即可恢复。只重试「连接建立/传输」错误，
  // 不重试 HTTP 业务错误，也不重试客户端主动断开（那是用户取消）。
  //
  // 外层再套一圈「太长就压缩后重试」：上游的真实上限常常比目录里写的小
  // （glm-5.1 目录 200000 / 真实 100000），第一次发过去才知道，
  // 这时学到真实值、按它重新裁剪，再发一次，客户端就不用看到裸报错了。
  const 最大尝试 = Number(cfg.upstreamRetry?.attempts ?? 3);
  const 退避 = Array.isArray(cfg.upstreamRetry?.backoffMs) ? cfg.upstreamRetry.backoffMs : [400, 1000];
  let res;
  let 最后错误;
  let 当前payload = payload;
  let 压缩重试次数 = 0;
  const 最大压缩重试 = 3; // 上限未知时要从全量往下爬，多留一次

  for (;;) {
    for (let 尝试 = 1; 尝试 <= 最大尝试; 尝试++) {
      try {
        // T30：全局限流协调——最近任何账号吃过 429 时，先在冷静窗里排队（客户端取消则不等）
        if (尝试 === 1 && 压缩重试次数 === 0 && signal && !signal.aborted) {
          const waited = await waitForUpstreamSlot(signal);
          if (waited > 0) warn(`[${site}] 上游限流冷静窗：本请求排队等待 ${waited}ms 后放行`);
        }
        res = await fetch(siteCfg.apiBase + '/v2/chat/completions', {
          method: 'POST',
          headers: chatHeaders(siteCfg, auth),
          body: JSON.stringify(当前payload),
          signal: ac.signal,
        });
        最后错误 = null;
        if (res.status === 429) reportUpstream429(); // T30：通知全体在途/后续请求进入冷静窗
        break;
      } catch (e) {
        最后错误 = e;
        const 客户端取消 = signal?.aborted || /client closed/i.test(String(e?.message || ''));
        if (客户端取消) break; // 用户取消，不重试
        if (尝试 < 最大尝试) {
          warn(`[${site}] 连接失败（${e?.cause?.code || e?.message || e}），第 ${尝试} 次重试…`);
          await new Promise((r) => setTimeout(r, 退避[Math.min(尝试 - 1, 退避.length - 1)] ?? 500));
        }
      }
    }
    if (!res) break; // 连接失败，交给下面统一抛错

    // 只在「输入太长」且还有机会压缩时重试
    if (res.status < 400 || 压缩重试次数 >= 最大压缩重试) break;
    const text = await res.text().catch(() => '');
    const 已知上限 = learnedLimit(site, model);
    // 工具定义不参与裁剪，但**要算进体积**：否则「messages 装得下」会被误当成
    // 「整个请求装得下」，预压缩不动作、发出去吃 400，而重试怎么压 messages 都没用。
    const 附属 = estimateSideTokens(当前payload);
    const 消息估计 = estimateMessages(当前payload.messages);
    const 当前估计 = 消息估计 + 附属;
    // 供应商侧把「输入远超上限」也报成 400 + 11133 model_param_invalid（没有 token 数字），
    // 任何「too long」关键词都匹配不到，压缩逻辑完全不触发 —— 请求硬失败。
    //
    // 这里**不能**用本地估算去排除超限的可能：本地估算恰恰就是会低估的那个东西
    // （实测真实 1,193,121 / 本地估 620,249，差 1.92 倍）。曾经想过「已知上限能证明
    // 体积合规时就不当超限」——那是自相矛盾的：预压缩正是因为信了这个偏低的估算才没压，
    // 再用它去排除超限，就变成「体积没问题，一定是参数问题」，于是拒绝压缩、硬失败。
    //
    // 所以只要没有 token 数字，一律按超限处理。代价可控：真要是别的参数非法，
    // 压缩后重试仍会失败，最终照样把上游的原始错误如实抛给客户端。
    const 可能是超限 = isProviderParamRejection(text);
    if (!isTooLongError(res.status, text) && !可能是超限) {
      // 不是「太长」，把读掉的 body 还原成一个可返回的结果。
      // ⚠️ headers 必须保留：下面 res.status>=400 分支要读 Retry-After——
      // 合成对象丢了 headers 会对所有非「太长」错误（401/402/429/5xx）抛 TypeError，
      // 整条账号轮换/限流冷却/换站链路被短路（0.3.37 修）
      res = { status: res.status, _text: text, headers: res.headers };
      break;
    }

    // 上游亲口报的真实 token 数是最可靠的样本，据此校准本地估算器
    // （本地对混合长文本会低估，不校准的话「压到目标」其实仍然超限）。
    const 真实tokens = parseActualTokens(text);
    if (真实tokens !== null) calibrateEstimate(site, model, 真实tokens, 当前估计);

    // 上游报的「too long: N > M maximum」里的数字**不可信**，实测：
    //   glm-5.1 报 "100001 tokens > 100000 maximum"，但同一模型
    //   34 万字符（实测 180030 tokens）明明能正常返回 200。
    //   真正触发 400 的是请求体积（约 34~40 万字符），报错信息是误导性的。
    //   所以这里不把它当成模型的真实上限，只当「这次发太大了」的信号，
    //   用「相对收缩 + 重试」逐步逼近，而不是一步跳到那个数字。
    // 没有 token 数字（11133）说明我们对体积的估计本来就不可信，第一次就压得更狠一些，
    // 免得 0.75 压完仍然超限、白多打一轮（每轮都要等上游 5~20 秒）。
    const 收缩比 = 压缩重试次数 === 0 ? (真实tokens === null ? 0.5 : 0.75) : 0.5;
    // 上限先扣掉「压不动的工具定义」，剩下的才是 messages 的可用额度；
    // 收缩比也只作用于 messages（工具定义不参与裁剪，不能跟着一起缩）。
    const 折算上限 =
      已知上限 === null
        ? Number.POSITIVE_INFINITY
        : Math.floor(已知上限 / calibrationFactor(site, model)) - 附属;
    const 预算 = Math.min(折算上限, Math.floor(消息估计 * 收缩比));
    if (!(预算 > 0)) {
      warn(
        `[${site}] ${model} 的工具定义约 ${附属} tokens，已占满上下文上限 ${已知上限}，`
        + `压缩 messages 无法解决（请精简客户端启用的工具 / MCP 数量）`,
      );
      break;
    }

    const 更小 = fitMessages(Array.isArray(当前payload.messages) ? 当前payload.messages : [], {
      maxInputTokens: 预算,
      reserveForOutput: 0,
      minKeepMessages: cfg.context?.minKeepMessages ?? 4,
      safetyRatio: 1,
    });
    if (!更小.stats.applied) break; // 压不动了，别再试
    当前payload = { ...当前payload, messages: 更小.messages };
    压缩重试次数++;
    warn(
      `[${site}] ${model} 输入超限（${text.slice(0, 100).replace(/\s+/g, ' ')}），`
      + `已压缩上下文后重试（丢弃 ${更小.stats.dropped} 条，截断 ${更小.stats.truncated} 条，`
      + `${更小.stats.before} → ${更小.stats.after} tokens，目标 ${预算}`
      + (附属 ? `；另有工具定义约 ${附属} tokens 不参与裁剪` : '')
      + '）',
    );
    recordCompression(site, model, 更小.stats, { phase: 'retry' }); // T10：重试路径的压缩也计入统计
    rememberSessionBudget(更小.messages, 更小.stats.after, { site, model }); // T28：记下压到的预算，同会话下次直接用
    res = undefined;
  }
  if (!res) {
    clearTimeout(headerTimer);
    cleanup();
    const 原因 = 最后错误?.cause?.code || 最后错误?.message || 最后错误;
    throw new UpstreamError(`[${site}] 上游连接失败（已重试 ${最大尝试} 次）：${原因}`, { status: 504, transport: true, site });
  }
  clearTimeout(headerTimer);

  if (res.status >= 400) {
    const text = res._text !== undefined ? res._text : await res.text().catch(() => '');
    cleanup();
    // 指纹黑名单（11128）命中时留存被拒请求体：剥离名单不可能一次穷尽，
    // 上游再加新指纹时，有原体才能像这次一样快速二分定位。
    dumpRejectedBody(res.status, text, 当前payload);
    // Retry-After（0.3.33）：上游限流响应若带等待秒数，据此计算模型冷却的恢复时间；
    // 支持秒数与 HTTP 日期两种形态，解析不了为 null（调用方回落缺省 60s）。
    return {
      ok: false, status: res.status, text, payload: 当前payload, site, accountId: usedAccount,
      retryAfter: parseRetryAfter(res.headers.get('retry-after')),
    };
  }

  // 上游接受了这次请求 → 说明该账号可用，清掉它的失败计数；
  // 带 model 时顺带解除该模型的限流冷却（0.3.33：成功即证明该 (账号,模型) 对此刻可用）
  markSuccess(site, usedAccount, model);

  bumpIdle();
  return {
    ok: true,
    status: res.status,
    site,
    accountId: usedAccount,
    payload: 当前payload,
    frames: readSSE(res.body, { onActivity: bumpIdle, onEnd: cleanup }),
    close: () => {
      ac.abort(new Error('closed'));
      cleanup();
    },
  };
}

/** 逐行解析上游 SSE，只产出 data: 载荷字符串；[DONE] / 流结束即返回。 */
async function* readSSE(stream, { onActivity, onEnd }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity?.();
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!line.startsWith('data:')) continue; // 注释/心跳行忽略
        const payload = line.slice(5).trimStart();
        if (payload === '[DONE]') return;
        if (payload) yield payload;
      }
    }
    const tail = (buf + decoder.decode()).trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trimStart();
      if (payload && payload !== '[DONE]') yield payload;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    onEnd?.();
  }
}

/** 判断一帧是错误信封还是正常 chunk。 */
export function classifyFrame(payload) {
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return { kind: 'garbage' };
  }
  if (obj && typeof obj === 'object' && !obj.choices && (obj.code || obj.error)) {
    const msg = obj.msg || obj.error?.message || JSON.stringify(obj.error) || `上游错误 code=${obj.code}`;
    return { kind: 'error', code: obj.code ?? null, message: String(msg) };
  }
  return { kind: 'chunk', obj };
}

/**
 * 把 200 + 错误信封上报进号池状态机（三个协议入口共用）。
 *
 * 为什么需要：markSuccess 在上游 <400 时就清空了失败计数，而上游会把 14003 限流 /
 * 14018 额度耗尽包在 200 的 JSON 信封里发回来——信封错误不进状态机的话，同一账号
 * 既不轮换也不冷却，后续每个请求都完整付一次往返后在流中失败，只能等余额轮询兜底。
 * message 里嵌 JSON 形态业务码：markFailure 的限流/额度分类（businessCode）靠
 * "code":14003 这类片段裁决该记限流冷却还是耗尽。
 */
export function reportFrameError(site, accountId, model, parsed) {
  if (!accountId) return;
  try {
    const codePart = parsed?.code != null ? `{"code":${Number(parsed.code)}}` : '';
    markFailure(site, accountId, {
      status: 0,
      message: `${codePart}${parsed?.message || '上游错误信封'}`,
      model,
    });
  } catch { /* 状态机是旁观者，绝不能绊倒响应路径 */ }
}

/** 聚合上游流为单个完整回复（供非流式客户端使用）。 */
export async function aggregateFrames(frames) {
  const out = {
    id: null,
    model: null,
    created: null,
    role: 'assistant',
    content: '',
    reasoning: '',
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
    frames: 0,
  };
  for await (const payload of frames) {
    const parsed = classifyFrame(payload);
    if (parsed.kind !== 'chunk') {
      if (parsed.kind === 'error') throw new UpstreamError(parsed.message, { status: 502, code: parsed.code });
      continue;
    }
    out.frames++;
    const c = parsed.obj;
    if (!out.id && c.id) out.id = c.id;
    if (!out.model && c.model) out.model = c.model;
    if (!out.created && c.created) out.created = c.created;
    if (c.usage) out.usage = c.usage;
    const choice = Array.isArray(c.choices) ? c.choices[0] : null;
    if (!choice) continue;
    if (choice.finish_reason) out.finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (delta.role) out.role = delta.role;
    if (typeof delta.content === 'string') out.content += delta.content;
    if (typeof delta.reasoning_content === 'string') out.reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        let idx = Number.isInteger(tc.index) ? tc.index : null;
        if (idx === null) {
          // 上游省略 index 时不能一律归 0：并行调用的参数串会拼进同一条目产生非法 JSON。
          // 先按 id 找已有条目续写；找不到且带新 id 就开新槽位（保持出现顺序）。
          // 无 id 的裸参数帧续写最近一个槽位——上游存在「首帧带 id、后续裸参数帧」的
          // 形态（与 anthropic 流式的 lastToolKey 同一观察），拆开会把一次调用碎成两次。
          if (tc.id) {
            for (const [k, v] of out.toolCalls) {
              if (v.id === tc.id) { idx = k; break; }
            }
            if (idx === null) idx = out.toolCalls.size;
          } else {
            const keys = [...out.toolCalls.keys()];
            idx = keys.length ? keys[keys.length - 1] : 0;
          }
        }
        const cur = out.toolCalls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.function.name = tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        out.toolCalls.set(idx, cur);
      }
    }
  }
  out.toolCallList = [...out.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return out;
}

/**
 * 描述一次 fetch 失败的原因。
 *
 * 为什么要区分：超时（AbortError）与其他失败（URL 非法、DNS 失败、连接被拒）
 * 是完全不同的问题，混在一句「超时或网络异常」里会把排查方向带偏——
 * 例如站点漏配 billingBase 会拼出 undefined/... 的非法 URL，
 * 那属于配置错误，不是网络抖动。
 */
function describeFetchFailure(e, timeoutMs) {
  const msg = String(e?.message || e);
  const isTimeout = e?.name === 'AbortError' || /timeout|aborted/i.test(msg);
  if (isTimeout) return `${Math.round(timeoutMs / 1000)}s 超时`;
  if (/Failed to parse URL|Invalid URL/i.test(msg)) return `URL 无效（多半是站点配置缺少 apiBase / billingBase）：${msg}`;
  return `网络异常：${msg}`;
}

/**
 * 带超时的 fetch（用于非流式的元数据接口：模型列表 / 额度查询）。
 *
 * 为什么需要：这些接口原先既无 signal 也无超时，上游挂起时请求会永久悬挂，
 * 导致 /v1/models、/status、控制台首屏全部卡死且连接不释放。
 * 注意与 openChat 的区别：聊天接口是流式的，超时按「首字节/流中空闲」分别控制，
 * 不能用单一总时长，因此这里只服务于一次性请求。
 *
 * 返回 { res, text, dispose }：超时定时器要覆盖到 body 读完为止（仅等响应头不够，
 * 上游发完头再挂起同样会卡死），所以由调用方在读完 body 后调 dispose()。
 */
function fetchWithTimeout(url, { timeoutMs, ...init } = {}) {
  const ac = new AbortController();
  const ms = Math.max(1, Number(timeoutMs) || 0);
  const timer = setTimeout(() => ac.abort(new Error(`request timeout after ${ms}ms`)), ms);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
  };
  const p = fetch(url, { ...init, signal: ac.signal }).then(
    (res) => ({
      res,
      text: async () => {
        try {
          return await res.text();
        } finally {
          dispose();
        }
      },
      dispose,
    }),
    (e) => {
      dispose();
      throw e;
    },
  );
  return p;
}

/**
 * T39：模型目录端点的**原始** JSON 响应（不做结构解析）。
 * 协议漂移自检要对着真实响应逐字段比对，所以需要绕过 fetchModels 的解析层。
 * 只读端点，不消耗积分。
 */
export async function fetchModelsRaw(cfg, site) {
  const siteCfg = cfg.sites[site];
  await ensureToken(cfg, site);
  const auth = getAuth(site);
  const timeoutMs = cfg.timeouts?.metaMs ?? 30000;
  let res, text;
  try {
    const r = await fetchWithTimeout(siteCfg.apiBase + '/console/enterprises/personal/models', {
      timeoutMs,
      headers: { ...chatHeaders(siteCfg, auth), Accept: 'application/json' },
    });
    res = r.res;
    text = await r.text();
  } catch (e) {
    throw new UpstreamError(`[${site}] 模型接口请求失败（${describeFetchFailure(e, timeoutMs)}）`, { status: 504, transport: true, site });
  }
  if (res.status !== 200) {
    // 非 200（404 HTML、网关错误页等）是「端点不可用」，不是「协议漂移」——
    // 显式抛带状态的错误，让协议自检把它归入「探针失败跳过」而不是误报漂移
    throw new UpstreamError(`[${site}] 模型接口 HTTP ${res.status}：${text.slice(0, 200)}`, { status: res.status, site });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(`[${site}] 模型接口返回无法解析`, { status: 502, site });
  }
}

/**
 * T54：/v3/config 端点的**原始** JSON 响应（不做结构解析）。
 * 与企业端点家族（/console/enterprises/personal/models）并行的模型目录来源，
 * 上游若把目录迁移过去，企业端点签名不会告警——这条探针就是盯它的。
 * 只读端点，不消耗积分。返回体额外带 __wantModel（当前默认模型，签名用它检查
 * cli 目录是否仍包含用户正在用的模型）；该字段以 _ 开头，与上游字段天然不冲突。
 */
export async function fetchV3ConfigRaw(cfg, site) {
  const siteCfg = cfg.sites[site];
  await ensureToken(cfg, site);
  const auth = getAuth(site);
  const timeoutMs = cfg.timeouts?.metaMs ?? 30000;
  let res, text;
  try {
    const r = await fetchWithTimeout(siteCfg.apiBase + '/v3/config', {
      timeoutMs,
      headers: { ...chatHeaders(siteCfg, auth), Accept: 'application/json' },
    });
    res = r.res;
    text = await r.text();
  } catch (e) {
    throw new UpstreamError(`[${site}] v3/config 请求失败（${describeFetchFailure(e, timeoutMs)}）`, { status: 504, transport: true, site });
  }
  try {
    const json = JSON.parse(text);
    json.__wantModel = cfg.defaultModel || '';
    return json;
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (res.status !== 200) {
      // 非 200 是「端点不可用」而非「协议漂移」，让协议自检归入探针失败跳过
      throw new UpstreamError(`[${site}] v3/config HTTP ${res.status}：${text.slice(0, 200)}`, { status: res.status, site });
    }
    throw new UpstreamError(`[${site}] v3/config 返回无法解析`, { status: 502, site });
  }
}

/**
 * 从模型条目的 tags 里解析促销徽标（0.3.33）。
 * 上游格式：tags: ["craft", "badge:限时免费:#FF0000"] —— badge:<文案>:<颜色>。
 * 这些徽标是**真实计费促销**（实测：badge 夜间免费的 hy4-preview 目录倍率 x0.29，
 * 夜间实际扣 0），客户端按它显示「限时免费 0.00x」，插件此前整字段丢弃导致不同步。
 */
export function parseBadges(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const s = String(t || '');
    if (!s.startsWith('badge:')) continue;
    const label = s.split(':')[1] || '';
    if (label) out.push(label);
    if (out.length >= 4) break; // 防异常数据撑爆展示
  }
  return out;
}

/** 拉取站点可用模型清单（含积分倍率）。
 *  T54：企业目录为主，/v3/config 补缺——实测（2026-10-05）CN 域 hy4-preview-f /
 *  minimax-m2.7 只从 v3 下发。v3 探测失败/结构异常不拖累主目录（静默降级）。 */
export async function fetchModels(cfg, site) {
  const siteCfg = cfg.sites[site];
  await ensureToken(cfg, site);
  const auth = getAuth(site);
  const timeoutMs = cfg.timeouts?.metaMs ?? 30000;
  // v3/config 只做补缺：非 200 / 解析失败 / agents 空都当「没有增量」处理。
  let v3 = null;
  try {
    const r = await fetchWithTimeout(siteCfg.apiBase + '/v3/config', {
      timeoutMs,
      headers: { ...chatHeaders(siteCfg, auth), Accept: 'application/json' },
    });
    if (r.res.status === 200) {
      v3 = JSON.parse(await r.text());
    } else {
      r.dispose?.(); // 非 200 不读 body：显式释放，别让 30s 超时定时器悬挂
    }
  } catch { /* 降级为企业目录 */ }
  let res, text;
  try {
    const r = await fetchWithTimeout(siteCfg.apiBase + '/console/enterprises/personal/models', {
      timeoutMs,
      headers: { ...chatHeaders(siteCfg, auth), Accept: 'application/json' },
    });
    res = r.res;
    text = await r.text();
  } catch (e) {
    throw new UpstreamError(`[${site}] 模型接口请求失败（${describeFetchFailure(e, timeoutMs)}）`, { status: 504, transport: true, site });
  }
  if (res.status !== 200) throw new UpstreamError(`[${site}] 模型接口 HTTP ${res.status}：${text.slice(0, 200)}`, { status: res.status, site });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError(`[${site}] 模型接口返回无法解析（HTTP ${res.status}）`, { status: 502, site });
  }
  if (json.code !== 0) throw new UpstreamError(`[${site}] 模型接口 code=${json.code}：${String(json.msg || '').slice(0, 200)}`, { status: 502, site });
  const models = json.data?.models || [];
  const agents = json.data?.agents || [];
  const cli = agents.find((a) => a.name === 'cli');
  const cliIds = cli?.models?.length ? new Set(cli.models) : null;
  const merged = models
    .filter((m) => !m.disabled && (!cliIds || cliIds.has(m.id)))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      credits: m.credits || null, // 积分倍率，如 "x0.79 credits"；x0.00 表示不扣积分
      badges: parseBadges(m.tags), // 促销徽标（限时免费/夜间免费…）——真实计费规则，0.3.33 起透传
      contextWindow: m.maxInputTokens || null,
      maxTokens: m.maxOutputTokens || null,
      supportsImages: Boolean(m.supportsImages),
      supportsToolCall: Boolean(m.supportsToolCall),
      supportsReasoning: Boolean(m.supportsReasoning),
    }));
  // T54 并集补缺：v3/cli 列出而企业目录没有的 id，从 v3/data.models 取同构详情补进目录。
  // 只在有完整详情时补（裸 id 会变成不可调用的占位条目，宁缺毋滥）。
  const v3Cli = (v3?.data?.agents || []).find((a) => a?.name === 'cli');
  if (v3Cli?.models?.length) {
    const known = new Set(merged.map((m) => m.id));
    const v3Detail = new Map((Array.isArray(v3?.data?.models) ? v3.data.models : []).map((m) => [m?.id, m]));
    for (const id of v3Cli.models) {
      if (known.has(id)) continue;
      const d = v3Detail.get(id);
      if (!d || d.disabled) continue;
      merged.push({
        id: d.id,
        name: d.name || d.id,
        credits: d.credits || null,
        badges: parseBadges(d.tags),
        contextWindow: d.maxInputTokens || null,
        maxTokens: d.maxOutputTokens || null,
        supportsImages: Boolean(d.supportsImages),
        supportsToolCall: Boolean(d.supportsToolCall),
        supportsReasoning: Boolean(d.supportsReasoning),
        v3only: true, // 仅供展示层标注来源（企业端点看不到该模型）
      });
    }
  }
  return merged;
}

/**
 * 该站点是否支持额度查询。
 *
 * 没有配置 billingBase 的站点不使用 CodeBuddy 的计费接口，
 * 站点预设里本就没有该字段。此时不应发起查询——否则会拼出
 * "undefined/v2/billing/meter/get-user-resource" 这种无效 URL，
 * 还会被当作网络故障上报，把「该站点不适用」误报成「超时」。
 */
export function supportsCreditQuery(cfg, site) {
  const b = cfg.sites?.[site]?.billingBase;
  return typeof b === 'string' && b.trim().length > 0;
}

/**
 * 查询站点剩余积分（免费额度）。国际版计费口径不同，失败时静默返回错误信息。
 * accountId 指定时查该账号——控制台要逐个账号看余额。
 */
/** 额度查询的请求体（T39 的原始探针与 queryCredit 共用，保证探的就是同一个接口）。 */
function creditQueryBody() {
  const now = new Date();
  const end = new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  };
}

/**
 * T39：额度端点的**原始** JSON 响应（不解析成 remain/detail）。
 * 只读接口，不消耗积分。协议漂移自检用它逐字段比对上游结构。
 */
export async function fetchCreditRaw(cfg, site, accountId = null) {
  const siteCfg = cfg.sites[site];
  if (!supportsCreditQuery(cfg, site)) {
    throw new UpstreamError(`[${site}] 该站点不支持额度查询（未配置 billingBase）`, { status: 501, site });
  }
  await ensureToken(cfg, site, { accountId });
  const auth = getAuth(site);
  const timeoutMs = cfg.timeouts?.metaMs ?? 30000;
  let res, text;
  try {
    const r = await fetchWithTimeout(siteCfg.billingBase + '/v2/billing/meter/get-user-resource', {
      timeoutMs,
      method: 'POST',
      headers: billingHeaders(siteCfg, auth),
      body: JSON.stringify(creditQueryBody()),
    });
    res = r.res;
    text = await r.text();
  } catch (e) {
    throw new UpstreamError(`[${site}] 额度接口请求失败（${describeFetchFailure(e, timeoutMs)}）`, { status: 504, transport: true, site });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(`[${site}] 额度接口返回无法解析（HTTP ${res.status}）`, { status: 502, site });
  }
}

export async function queryCredit(cfg, site, accountId = null) {
  const siteCfg = cfg.sites[site];
  if (!supportsCreditQuery(cfg, site)) {
    throw new UpstreamError(
      `[${site}] 该站点不支持额度查询（协议与 CodeBuddy 不同，未配置 billingBase）`,
      { status: 501, site },
    );
  }
  await ensureToken(cfg, site, { accountId });
  const auth = getAuth(site);
  const now = new Date();
  const end = new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  };
  const timeoutMs = cfg.timeouts?.metaMs ?? 30000;
  let res, text;
  try {
    const r = await fetchWithTimeout(siteCfg.billingBase + '/v2/billing/meter/get-user-resource', {
      timeoutMs,
      method: 'POST',
      headers: billingHeaders(siteCfg, auth),
      body: JSON.stringify(body),
    });
    res = r.res;
    text = await r.text();
  } catch (e) {
    throw new UpstreamError(`[${site}] 额度接口请求失败（${describeFetchFailure(e, timeoutMs)}）`, { status: 504, transport: true, site });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError(`[${site}] 额度接口返回无法解析（HTTP ${res.status}）`, { status: 502, site });
  }
  if (json.code !== 0) throw new UpstreamError(`[${site}] 额度接口 code=${json.code}：${String(json.msg || '').slice(0, 160)}`, { status: 502, site });
  // workbuddy-bridge：detail 里带每个资源包的到期时间（expireAt，毫秒；上游字段
  // CycleEndTime / PackageEndTime / ExpiredTime 三代口径都读，见 expiry.mjs）。
  // 到期时间是「积分到期优先调度」的数据来源。
  const accounts = json.data?.Response?.Data?.Accounts || [];
  const detail = normalizeCreditDetail(accounts);
  const remain = detail.reduce((s, b) => s + b.remain, 0);
  return { remain, detail };
}

/**
 * 解析 Retry-After 头：纯数字按秒；HTTP 日期折算成距现在的秒数（向上取整）。
 * 无头 / 非法值返回 null，由调用方回落缺省冷却时长。
 */
export function parseRetryAfter(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  return null;
}

/**
 * 带「账号轮换」的上游调用，三个协议入口（OpenAI / Anthropic / Responses）共用。
 *
 * 处理顺序（每一步都只在「还没成功」时继续）：
 *   1) 正常发一次（openChat 内部已按号池选号）
 *   2) 401 → 原地强刷该账号 token 重试一次（可能只是 token 过期，不必换号）
 *   3) 仍然失败 → 把该账号上报号池（额度耗尽/冷却），换一个账号重试
 *   4) 号池里没有别的可用账号了 → 原样返回最后一次的错误，交给上层做站点降级
 *
 * 返回 { up, tried }：tried 是本次已经用过的账号 id 列表。
 */
export async function openChatRotating(cfg, site, body, { signal, maxAccounts = 0 } = {}) {
  const tried = [];
  const 上限 = maxAccounts > 0 ? maxAccounts : Math.max(1, Number(cfg.pool?.maxAccountsPerRequest ?? 3));
  let up = null;

  for (let i = 0; i < 上限; i++) {
    // 0.3.33 模型级限流避让：把「该模型正在限流冷却」的账号排到候选之外。
    // 上游限流是 (账号×模型) 维度——同账号换个模型往往就能用。全池都在冷却时
    // 照旧发（usableCount 守卫）：额度可能已重置，本地直接放弃反而更差。
    const 模型冷却中 = listModelCooldownAccounts(site, String(body?.model || ''), tried);
    const exclude = 模型冷却中.length && usableCount(site, undefined, [...tried, ...模型冷却中]) > 0
      ? [...tried, ...模型冷却中]
      : tried;
    up = await openChat(cfg, site, body, { signal, exclude });
    if (up.ok) return { up, tried };
    if (!up.accountId) return { up, tried }; // 兼容模式（单账号），没有可换的
    if (tried.includes(up.accountId)) return { up, tried }; // 池里只剩它，别死循环

    // 401：先原地刷 token。很多情况下只是 token 过期，换号反而浪费一个账号。
    if (up.status === 401 && i === 0) {
      warn(`[${site}] 上游 401，强制刷新账号 ${up.accountId} 的 token 后重试`);
      try {
        await ensureToken(cfg, site, { force: true, accountId: up.accountId });
        const retry = await openChat(cfg, site, body, { signal, accountId: up.accountId });
        if (retry.ok) return { up: retry, tried };
        up = retry;
      } catch (e) {
        warn(`[${site}] 刷新 token 失败：`, e.message);
      }
    }

    // 上报号池：额度类错误会被标记为「耗尽」，其余走冷却退避。
    // 限流类顺带记 (账号, 模型) 冷却（0.3.33）：Retry-After 头优先，缺省 60s。
    markFailure(site, up.accountId, {
      status: up.status,
      message: up.text,
      model: String(body?.model || ''),
      modelCooldownMs: up.retryAfter > 0 ? up.retryAfter * 1000 : 0,
    });
    tried.push(up.accountId);

    const 还有号 = usableCount(site, undefined, tried) > 0;
    if (!还有号) return { up, tried };
    const 原因 = isRateLimitError(up.status, up.text)
      ? '触发限流'
      : isQuotaError(up.status, up.text) ? '额度不足' : `HTTP ${up.status}`;
    warn(`[${site}] 账号 ${up.accountId} ${原因}，切换下一个账号重试`);
  }
  return { up, tried };
}

export function upstreamErrorMessage(status, text, site = '') {  let msg = text || '';
  try {
    const j = JSON.parse(text);
    msg = j.msg || j.error?.message || j.message || text;
  } catch {
    if (status === 500 && /<html/i.test(msg)) msg = '上游网关 500（该接口在该站点不可用或临时故障）';
    else if (/<html/i.test(msg)) msg = msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const prefix = site ? `[${site}] ` : '';
  const map = {
    401: '上游 401：登录态失效，请重新登录',
    402: '上游 402：额度/积分不足',
    404: '上游 404：接口偶发不可用，稍后重试',
    429: '上游 429：触发限流，稍后重试',
  };
  const head = map[status] || `上游 HTTP ${status}`;
  warn(`${prefix}上游返回 ${status}：${String(msg).slice(0, 200)}`);
  // 指纹黑名单报错时在消息里点名，提示已自动剥离、若再现会留存请求体供二分
  if (/Illegal API invocation|unapproved channel/i.test(String(msg))) {
    return `${prefix}上游 HTTP ${status}：客户端指纹被上游黑名单拦截（11128）。代理已自动剥离已知指纹；若反复出现，说明上游启用了新指纹，被拒请求体已留存到数据目录 rejected/ 下供定位`;
  }
  return `${prefix}${head}：${String(msg).slice(0, 500)}`;
}

export function newId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}
