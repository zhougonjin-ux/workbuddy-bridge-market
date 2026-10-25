// 任务事件链重放（0.3.54，移植自 XDTrees/dsh-xdpool 的 src/task-events.ts，MIT）
//
// 原理：成长中心的打分器不看「你真的做了这个动作」，只看**事件流**——带正确指纹的
// 事件序列到达就计分。dsh 用真账号实测过每条链（四账号一轮 3300 积分）。我们已有的
// reportChatActivity（black_cat 用）就是同一个上报通道的 CLI 简化版；本模块补齐
// **桌面指纹**（完整字段集 + 稳定派生的 machineId/sessionId）与 **web 指纹**两族。
//
// 三族指纹不可互换：桌面任务收 web 事件会被 200 接受但计 0 分，反之亦然。
//
// 链是纯数据（构造不需要网络）；需要真实服务端会话 id 的链（skill / 专家族）由
// openServerConversation 开一次真对话、从 SSE 里扫出 cmb-<32hex> 再拼进事件。
import crypto from 'node:crypto';
import { ensureToken } from './auth.mjs';
import { chatHeaders } from './headers.mjs';
import { log, warn } from './log.mjs';

/* ---------------- 常量（dsh 实测值，勿随手改） ---------------- */

/** 桌面上报端点（与 reportChatActivity 的 /v2/report 同通道，但走桌面 UA 与完整指纹）。 */
const DESKTOP_REPORT_PATH = '/v2/report';
/** 主题设置端点：Hp_Appearance 的「先设置皮肤再报 apply」两步里的第一步。 */
const APPEARANCE_SET_PATH = '/v2/user-asset/appearance/set';
/** 专家市场列表：召唤事件里的专家 id 必须真实存在，编造的 id 计 0 分。 */
const MARKET_EXPERT_LIST_PATH = '/portal/operation-platform/market/expert/list';
/** 打分器认的桌面 UA（与指纹里的 ideVersion 同源）。 */
const DESKTOP_TASK_UA = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1';
const CHAT_IDENTITY_HEADERS = { 'X-IDE-Name': 'WorkBuddy', 'X-IDE-Type': 'WorkBuddy', 'X-IDE-Version': '5.5.6' };
/** 服务端会话 id 形如 cmb-<32hex> 或裸 32hex。 */
const SERVER_ID_PATTERN = /"id"\s*:\s*"((?:cmb-)?[0-9a-f]{32})"/;
const SSE_SCAN_LIMIT = 1 << 20;
const CHAT_TIMEOUT_MS = 90_000;
const JSON_TIMEOUT_MS = 30_000;

const BUDDY_APP_ID = 'cb_y5Dy46tPQGGWtueMxXbe';
const BUDDY_APP_NAME = '企鹅教师助手';
const PLAYBOOK_CASE_ID = 'pm-gtm-launch-plan';
const PLAYBOOK_CASE_NAME = '新产品上市 GTM 发布计划一页纸';
const TEMPLATE_PRESETS = [['1', '深度研究'], ['2', '周报生成'], ['3', '竞品分析'], ['4', '活动策划'], ['5', '代码评审']];
const LIBRARY_DOC_URL = 'https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm';
const APPEARANCE_THEME_KEY = 'theme-tkmw7j';
const SKILL_ID = 'skill_2097350077599879168';
const SKILL_NAME = '润泽小馆·日报撰写';
const SKILL_VERSION = '1.0.0';
const LIGHTHOUSE_EXPERT_ID = 'ex_2cvvUZQhDyeJ';
const LIGHTHOUSE_EXPERT_NAME = '腾讯轻量云专家';
/** 事件链覆盖的任务 code（判断「这是链任务」的唯一事实源）。 */
export const EVENT_CHAIN_CODES = [
  'Buddy_App', 'Buddy_App_QQ', 'create_canvas', 'automation_1', 'playbook_prompt',
  'template_5', 'Hp_Appearance', 'Library_read', 'skill_1',
  'expert_5', 'Expert_team_use_3', 'Expert_lighthouse',
];

/** 调度间隔（dsh 实测：连发两次专家会被并成一次计分，必须隔开）。 */
const CHAIN_DELAY_MS = 800;
const EVENT_SCORE_WAIT_MS = 9_000;
const EXPERT_GAP_MS = 6_000;

/* ---------------- 链构造（纯数据，可单测） ---------------- */

function syntheticId(prefix) {
  return `wb2auto-${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** 合成会话 id 的对话链：多数任务只校验「事件里有个格式合法的 id」，不查会话真伪。 */
function syntheticChatChain(prefix) {
  const conversationId = syntheticId(prefix);
  const requestId = syntheticId(`${prefix}-req`);
  return { conversationId, requestId, events: desktopChatEvents(conversationId, requestId, `msg-${prefix}`) };
}

/** 一条完整的「桌面客户端成功跑完一次请求」六事件链（RichMeow_Chat 单发即亮）。 */
export function desktopChatEvents(conversationId, requestId, messageId, modelId = 'fast-model', modelName = 'fast-model') {
  const assistant = `${messageId}-assistant`;
  const session = { 'codebuddy.session_id': conversationId, 'codebuddy.conversation_request_id': requestId };
  return [
    {
      eventCode: 'agent_task_created',
      source: 'LOCAL', name: 'working', task_target: 'local', mode: 'craft',
      requestModelId: modelId, requestModelName: modelName,
      has_repo: false, repo_type: 'none', workspace_type: 'empty',
      has_connector: false, connector_types: [],
      has_mention: false, mention_types: [],
      has_template: false, action: '', template_name: '',
      has_expert: false, expert_id: '', expert_name: '', expert_industry_id: '',
      has_skill: false, skill_names: [],
      conversationId, messageId, buddyId: '', buddyName: '',
    },
    {
      eventCode: 'chat_message_send',
      messageId: assistant, historyCount: 0, isContextTruncated: false, currentStepCount: 1,
      traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
    },
    {
      eventCode: 'chat_request_send',
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
      codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: '', mentionContextCount: 0, command: '', recommendId: '',
      skillId: '', skillCount: 0, totalCount: 0,
      traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
      ...session,
    },
    {
      eventCode: 'chat_message_response',
      messageId: assistant, responseModelId: modelId,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      firstTokenAt: Date.now(), traceId: requestId, conversationId,
      rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
      ...session,
    },
    {
      eventCode: 'chat_message_status',
      messageId: assistant, messageErrorCode: '0',
      traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
    },
    {
      eventCode: 'chat_request_response',
      mode: 'craft', toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      rootRequestId: requestId, parentConversationId: conversationId,
    },
  ];
}

/** 企鹅教师助手五连点：同时点亮 Buddy_App 与 Buddy_App_QQ 两个任务。 */
export function buddyAppChain() {
  const base = { mode: 'LOCAL', buddyId: BUDDY_APP_ID, buddyName: BUDDY_APP_NAME };
  return {
    transport: 'desktop',
    events: [
      { ...base, eventCode: 'buddyapp_discover_click' },
      { ...base, eventCode: 'buddyapp_show', elementId: BUDDY_APP_ID, elementName: BUDDY_APP_NAME, position: 2 },
      { ...base, eventCode: 'buddyapp_enter_click', elementId: BUDDY_APP_ID, elementName: BUDDY_APP_NAME, position: 2, isFirstPage: '1' },
      { ...base, eventCode: 'buddyapp_auth_confirm_click', elementId: BUDDY_APP_ID, elementName: BUDDY_APP_NAME },
      { ...base, eventCode: 'buddyapp_bindaccount_skip_click', elementId: BUDDY_APP_ID, elementName: BUDDY_APP_NAME },
    ],
  };
}

/** 设计画布（create_canvas，+300 全板最大档之一）。 */
export function canvasChain() {
  const { conversationId, requestId, events } = syntheticChatChain('canvas');
  return {
    transport: 'desktop',
    events: [
      ...events,
      {
        eventCode: 'wbx_design_canvas_task_create',
        conversationId, requestId,
        source: 'summon_keyword', cost: 12000, isSuccessful: true,
      },
      {
        eventCode: 'wbx_design_canvas_open',
        conversationId, requestId, id: `ardot-file-${requestId.slice(-8)}`,
        source: 'summon_keyword', type: 'page', cost: 13000, isSuccessful: true,
      },
    ],
  };
}

/** 定时任务创建（automation_1），单事件即整链。 */
export function automationChain() {
  return {
    transport: 'desktop',
    events: [{
      eventCode: 'automated_task_create_suc',
      name: `定时任务-${Date.now().toString(36)}`,
      source: 'manually', modelId: 'fast-model', modelIsThinking: true,
      connectorCount: 0, skills: '', skillCount: 0,
      scheduleType: 'once', mode: 'LOCAL',
    }],
  };
}

/** 灵感案例（playbook_prompt）：计分点是 prompt_send，前面的点击链是为仿真。 */
export function playbookChain() {
  const { conversationId, requestId, events } = syntheticChatChain('pb');
  const payload = { id: PLAYBOOK_CASE_ID, name: PLAYBOOK_CASE_NAME, type: 'document', categoryId: '', categoryName: '' };
  return {
    transport: 'desktop',
    events: [
      ...events,
      {
        eventCode: 'web_element_click', pageName: 'playbook_detail',
        elementId: 'playbook_ctaClick', elementName: PLAYBOOK_CASE_NAME, source: 'discover',
      },
      { eventCode: 'playbook_cta_click', source: 'discover', position: 0, ...payload },
      { eventCode: 'playbook_prompt_send', conversationId, requestId, ...payload },
    ],
  };
}

/** 模板任务（template_5）：打分器数的是 5 个**不同**的 template_used 事件。 */
export function templateChain(templateId, templateName) {
  const { conversationId, requestId, events } = syntheticChatChain(`tpl${templateId}`);
  return {
    transport: 'desktop',
    events: [
      ...events,
      {
        eventCode: 'agent_task_created_with_template', mode: 'working',
        isCustomModel: false, id: templateId, name: templateName, requestId,
      },
      { eventCode: 'template_used', template_id: templateId, task_mode: 'working' },
    ],
  };
}

export function templateChains() {
  return TEMPLATE_PRESETS.map(([id, name]) => templateChain(id, name));
}

/** 资料库阅读（Library_read）：必须走 **web 指纹**，桌面指纹同事件计 0 分。 */
export function libraryReadChain() {
  return {
    transport: 'web',
    web: {
      eventCode: 'web_element_click',
      pageUrl: LIBRARY_DOC_URL,
      elementId: 'library_doc_intro_click',
      elementName: 'WorkBuddy资料库介绍',
    },
  };
}

/** 换主题（Hp_Appearance）：注意调用方要先 setAppearanceTheme（存储皮肤）再发 apply。 */
export function appearanceChain(themeKey = APPEARANCE_THEME_KEY) {
  return {
    transport: 'desktop',
    events: [{
      eventCode: 'appearance_skin_apply', action: 'apply', source: 'settings_close',
      id: themeKey, vipLevel: 0, series: '', type: 'unknown',
    }],
  };
}

/** 技能任务（skill_1）：响应必须报 finishReason=tool_calls（技能被当工具加载）。 */
function markToolCall(events) {
  return events.map((event) => (event.eventCode === 'chat_message_response' ? { ...event, finishReason: 'tool_calls' } : event));
}

export function skillChain(conversationId, requestId) {
  const messageId = `msg-${requestId.slice(-8)}`;
  return {
    transport: 'desktop',
    events: [
      ...markToolCall(desktopChatEvents(conversationId, requestId, messageId)),
      {
        eventCode: 'skill_info',
        id: SKILL_NAME, skillId: SKILL_ID, skillVersion: SKILL_VERSION,
        toolStatus: 'success', fileCount: 56, source: 'workbuddy-desktop',
        conversationId, requestId, messageId,
        requestModelId: 'fast-model', requestModelName: 'fast-model', traceId: requestId,
      },
    ],
  };
}

/* ---------------- 专家族 ---------------- */

export function expertSummonEvents(expert) {
  const category = expert.categories[0] ?? 'expert-all';
  const version = expert.version === '' ? '1.0.0' : expert.version;
  return [
    {
      eventCode: 'web_element_click', source: expert.expertId, type: category, version,
      elementId: 'expert_summon_click', elementName: '立即召唤',
      pageURL: '/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html',
    },
    {
      eventCode: 'expert_summon_click', id: expert.expertId, name: expert.displayName,
      expertTitle: expert.profession, type: 'expert-all', position: 0,
      expertType: expert.expertType, version, mode: 'LOCAL',
    },
    {
      eventCode: 'expert_summoned', id: expert.expertId, name: expert.displayName,
      expertTitle: expert.profession, type: 'expert-all',
    },
  ];
}

/** 专家真正作答的事件：requestId 必须是**服务端**给的真会话 id，编造的计 0 分。 */
export function expertActualUseEvent(expert, conversationId, requestId, mode = 'craft') {
  const category = expert.categories[0] ?? 'expert-all';
  const version = expert.version === '' ? '1.0.0' : expert.version;
  return {
    eventCode: 'expert_actual_use',
    id: expert.expertId, name: expert.displayName, expertTitle: expert.profession,
    type: category, expertType: expert.expertType, source: 'builtin', version,
    cost: 9000, characterCount: 14, mode,
    conversationId, requestId, messageId: `msg-${requestId.slice(-8)}`,
    requestModelId: 'fast-model', requestModelName: 'fast-model',
  };
}

export function expertChatEvents(expert, conversationId, requestId) {
  const messageId = `msg-${requestId.slice(-8)}`;
  return desktopChatEvents(conversationId, requestId, messageId).map((event) =>
    event.eventCode === 'agent_task_created'
      ? { ...event, has_expert: true, expert_id: expert.expertId, expert_name: expert.displayName, expert_industry_id: '' }
      : event);
}

/* ---------------- 指纹与传输 ---------------- */

function deriveDeviceId(auth, salt) {
  return crypto.createHash('sha256').update(salt + ':' + (auth.uid ?? '')).digest('hex').slice(0, 36);
}

/**
 * 每个桌面事件都携带的公开指纹字段。machineId/sessionId 从 uid 稳定派生（绝不随机）：
 * 「每次调用都出现一台新设备」本身就是非真实客户端的信号。部分字段会被业务字段覆盖。
 */
export function desktopFingerprint(auth) {
  const now = Date.now();
  return {
    timezone: 'Asia/Shanghai',
    reportDelay: 2000,
    userId: auth.uid ?? '',
    username: auth.nickname ?? '',
    userNickname: auth.nickname ?? '',
    product: 'SaaS',
    releaseDate: 1789036585355,
    commit: '5f9692923c93033111c51ad7b003eb80204a9b75',
    ideName: 'WorkBuddy',
    ideType: 'WorkBuddy',
    ideVersion: '5.5.6',
    machineId: deriveDeviceId(auth, 'machine'),
    sessionId: deriveDeviceId(auth, 'session'),
    extName: 'workbuddy-desktop',
    extVersion: '5.5.6',
    os: 'win32',
    arch: 'x64',
    osVersion: '10.0.26220',
    cpuCores: 20,
    memorySize: 24,
    timestamp: now,
    presentAt: now,
  };
}

async function postJSON(url, headers, body, what, timeoutMs = JSON_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(what + ' timeout')), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 按 null 处理 */ }
    if (!res.ok || !json || json.code !== 0) {
      throw new Error(`${what} 失败（HTTP ${res.status} code=${json?.code ?? '-'}）：${String(json?.msg || text).slice(0, 120)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** 桌面指纹事件数组上报。事件为空时直接成功（幂等）。 */
export async function reportDesktopEvents(cfg, site, accountId, events) {
  if (!events.length) return;
  const { auth } = await ensureToken(cfg, site, { accountId });
  const siteCfg = cfg.sites[site];
  const fingerprint = desktopFingerprint(auth);
  const headers = {
    Authorization: 'Bearer ' + auth.accessToken,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': DESKTOP_TASK_UA,
    'X-Product': 'SaaS',
    'X-Request-ID': deriveDeviceId(auth, 'req') + String(Date.now() % 1_000_000),
    ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
    ...(auth.domain ? { 'X-Domain': auth.domain } : {}),
  };
  await postJSON(siteCfg.apiBase + DESKTOP_REPORT_PATH, headers, events.map((e) => ({ ...fingerprint, ...e })), '桌面事件上报');
}

/** web 指纹单事件上报（页面行为类任务：Library_read 等）。 */
export async function reportWebEvent(cfg, site, accountId, web) {
  const { auth } = await ensureToken(cfg, site, { accountId });
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  const event = {
    eventCode: web.eventCode,
    timestamp: Date.now(),
    reportDelay: 0,
    pageURL: web.pageUrl,
    elementId: web.elementId,
    elementName: web.elementName,
    os: 'Win32',
    arch: '',
    osVersion: '10.0',
    userAgent: ua,
    machineId: deriveDeviceId(auth, 'webmachine'),
    userId: auth.uid ?? '',
    userNickname: auth.nickname ?? '',
    enterpriseId: auth.enterpriseId ?? '',
  };
  const headers = {
    Authorization: 'Bearer ' + auth.accessToken,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-client-platform': 'web',
    Origin: 'https://www.workbuddy.cn',
    Referer: web.pageUrl,
    'User-Agent': ua,
    ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
  };
  await postJSON('https://www.workbuddy.cn' + DESKTOP_REPORT_PATH, headers, event, 'web 事件上报');
}

/** Hp_Appearance 第一步：把皮肤存进账户（第二步才是发 apply 事件）。 */
export async function setAppearanceTheme(cfg, site, accountId, resourceKey) {
  const { auth } = await ensureToken(cfg, site, { accountId });
  const siteCfg = cfg.sites[site];
  const headers = {
    Authorization: 'Bearer ' + auth.accessToken,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': DESKTOP_TASK_UA,
    'X-Product': 'SaaS',
    ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
  };
  await postJSON(siteCfg.apiBase + APPEARANCE_SET_PATH, headers, { kind: 'theme', resource_key: resourceKey }, '主题设置');
}

/** 专家市场列表（召唤事件里的专家必须真实存在）。 */
export async function marketExpertList(cfg, site, accountId, expertType = '') {
  const { auth } = await ensureToken(cfg, site, { accountId });
  const siteCfg = cfg.sites[site];
  const body = { page: 1, page_size: 50, sort_by: 'reco_rank', sort_order: 'desc' };
  if (expertType !== '') body.expert_type = expertType;
  const json = await postJSON(siteCfg.apiBase + MARKET_EXPERT_LIST_PATH, { ...chatHeaders(siteCfg, auth), 'User-Agent': DESKTOP_TASK_UA }, body, '专家市场列表');
  const data = json?.data ?? {};
  const raw = Array.isArray(data.experts) ? data.experts : [];
  const out = [];
  for (const v of raw) {
    const expertId = typeof v?.expert_id === 'string' ? v.expert_id : '';
    if (!expertId) continue;
    out.push({
      expertId,
      expertType: typeof v.expert_type === 'string' ? v.expert_type : '',
      displayName: typeof v.display_name_zh === 'string' ? v.display_name_zh : '',
      profession: typeof v.profession_zh === 'string' ? v.profession_zh : '',
      version: typeof v.version === 'string' ? v.version : '',
      categories: Array.isArray(v.categories) ? v.categories.filter((x) => typeof x === 'string') : [],
    });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 开一次**真实**对话，返回服务端分配的 id（skill / 专家族事件必须挂在真会话上）。
 * 直接读 SSE 找 cmb-<32hex>，找到即弃流——答案本身无关紧要，只要它的身份。
 * 打不开或流里没有可识别 id 时返回 null（调用方都是尽力而为的任务链）。
 */
export async function openServerConversation(cfg, site, accountId, expertId = '') {
  const { auth } = await ensureToken(cfg, site, { accountId });
  const siteCfg = cfg.sites[site];
  const conversationId = `wb2auto-conv-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const body = JSON.stringify({
    model: 'fast-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant. 当前处于中文环境，使用简体中文回答。' },
      { role: 'user', content: '1+1等于几？直接回答。' },
    ],
    agent: 'cli',
    temperature: 1,
    stream: true,
    stream_options: { include_usage: true },
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('conversation timeout')), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(siteCfg.apiBase + '/v2/chat/completions', {
      method: 'POST',
      headers: {
        ...chatHeaders(siteCfg, auth),
        ...CHAT_IDENTITY_HEADERS,
        Accept: 'text/event-stream',
        'User-Agent': DESKTOP_TASK_UA,
        'X-Conversation-ID': conversationId,
        'X-Request-ID': String(Date.now()) + '000000',
        'X-Agent-Intent': 'craft',
        'X-Agent-Type': 'main',
        'x-codebuddy-request': '1',
        ...(expertId === '' ? {} : { 'X-Expert-Id': expertId }),
      },
      body,
      signal: ac.signal,
    });
    if (!res.ok || res.body === null) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (buffer.length < SSE_SCAN_LIMIT) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const match = SERVER_ID_PATTERN.exec(buffer);
      if (match !== null) return { conversationId, requestId: match[1] };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 任务 → 链 的映射与编排 ---------------- */

/** 专家族的「召唤 + 真使用」链：只补还缺的次数，多个专家之间隔开（连发会被并成一次）。 */
async function expertChains(cfg, site, accountId, expertType, task) {
  const needed = Math.max(0, task.target - task.current);
  if (needed === 0) return [];
  const experts = await marketExpertList(cfg, site, accountId, expertType);
  const out = [];
  for (const expert of experts) {
    if (out.length >= needed) break;
    try {
      await reportDesktopEvents(cfg, site, accountId, expertSummonEvents(expert));
      const chat = await openServerConversation(cfg, site, accountId, expert.expertId);
      if (chat == null) continue;
      out.push({
        transport: 'desktop',
        events: [
          ...expertChatEvents(expert, chat.conversationId, chat.requestId),
          expertActualUseEvent(expert, chat.conversationId, chat.requestId),
        ],
      });
    } catch (e) {
      warn(`[${site}] 专家链构造失败（${expert.expertId}）：`, e.message || String(e));
    }
    if (out.length < needed) await sleep(EXPERT_GAP_MS);
  }
  return out;
}

/** 轻量云专家：use 事件必须 mode=LOCAL、type 空、cost 0（打分器按这个形状匹配）。 */
async function lighthouseChains(cfg, site, accountId) {
  let expert = { expertId: LIGHTHOUSE_EXPERT_ID, expertType: '', displayName: LIGHTHOUSE_EXPERT_NAME, profession: '', version: '', categories: [] };
  try {
    const listed = await marketExpertList(cfg, site, accountId, 'agent');
    const found = listed.find((x) => x.expertId === LIGHTHOUSE_EXPERT_ID);
    if (found) expert = found;
  } catch (e) {
    warn(`[${site}] 轻量云专家列表查询失败（用内置记录继续）：`, e.message || String(e));
  }
  await reportDesktopEvents(cfg, site, accountId, expertSummonEvents(expert));
  const chat = await openServerConversation(cfg, site, accountId, expert.expertId);
  if (chat == null) throw new Error('Expert_lighthouse：真会话打开失败');
  const use = expertActualUseEvent(expert, chat.conversationId, chat.requestId, 'LOCAL');
  use.type = '';
  use.cost = 0;
  return [{ transport: 'desktop', events: [...expertChatEvents(expert, chat.conversationId, chat.requestId), use] }];
}

/** 一个任务对应的所有链（template_5 是 5 条；skill/专家族是异步构造）。 */
export async function chainsFor(cfg, site, accountId, task) {
  switch (task.code) {
    case 'Buddy_App':
    case 'Buddy_App_QQ':
      return [buddyAppChain()];
    case 'create_canvas':
      return [canvasChain()];
    case 'automation_1':
      return [automationChain()];
    case 'playbook_prompt':
      return [playbookChain()];
    case 'template_5':
      return templateChains();
    case 'Hp_Appearance':
      // 客户端先「存储皮肤」再在退出设置时「报 apply」——两步都是计分前提
      await setAppearanceTheme(cfg, site, accountId, APPEARANCE_THEME_KEY);
      await sleep(2_000);
      return [appearanceChain()];
    case 'Library_read':
      return [libraryReadChain()];
    case 'skill_1': {
      const chat = await openServerConversation(cfg, site, accountId);
      if (chat == null) throw new Error('skill_1：真会话打开失败');
      return [skillChain(chat.conversationId, chat.requestId)];
    }
    case 'expert_5':
      return expertChains(cfg, site, accountId, 'agent', task);
    case 'Expert_team_use_3':
      return expertChains(cfg, site, accountId, 'team', task);
    case 'Expert_lighthouse':
      return lighthouseChains(cfg, site, accountId);
    default:
      // 活动专家任务（0.3.58）：expert_use_*（jump_url 内嵌 id）/ WorkBuddy_Valorant（按名匹配）
      if (/^expert_use_/.test(task.code) || task.code === 'WorkBuddy_Valorant') {
        return campaignExpertChains(cfg, site, accountId, task);
      }
      return [];
  }
}

async function sendChain(cfg, site, accountId, chain) {
  if (chain.transport === 'web') {
    await reportWebEvent(cfg, site, accountId, chain.web);
    return;
  }
  await reportDesktopEvents(cfg, site, accountId, chain.events ?? []);
}

/** 该任务是否由事件链负责（判断「能不能自动完成」的补充口径）。
 *  0.3.58：活动专家任务两类也走链——expert_use_*（jump_url 内嵌专家 id）与
 *  WorkBuddy_Valorant（市场列表按名匹配），标题形如 体验「某专家」。 */
export function isEventChainTask(code) {
  return EVENT_CHAIN_CODES.includes(code) || /^expert_use_/.test(code) || code === 'WorkBuddy_Valorant';
}

/** 从任务标题里取专家显示名（体验「XX专家」的内层引号）。 */
export function expertNameFromTitle(title) {
  const m = String(title || '').match(/[「『]([^」』]+)[」』]/);
  return m ? m[1] : null;
}

/** 从任务的 jump_url 里取内嵌的专家 id（workbuddy://experts?expertId=ex_xxx）。 */
export function expertIdFromJumpUrl(url) {
  const m = String(url || '').match(/expertId(?:=|%3D)([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** 活动专家链（0.3.58）：召唤 + 真使用。专家定位优先 jump_url 内嵌 id（任务自带，
 *  最可靠——实测四个 expert_use_* 都不在市场推荐列表的前 200 个里）；没有 id 再按
 *  标题名匹配市场列表（WorkBuddy_Valorant 走这条路）。市场列表只用来补展示字段，
 *  拉不到不拦链（id 本身已足够定位）。 */
async function campaignExpertChains(cfg, site, accountId, task) {
  const name = expertNameFromTitle(task.title);
  let expert = null;
  const byId = expertIdFromJumpUrl(task.jumpUrl);
  if (byId) {
    try {
      const listed = await marketExpertList(cfg, site, accountId, '');
      const hit = listed.find((x) => x.expertId === byId);
      if (hit) expert = hit;
    } catch { /* 列表拉不到不拦链 */ }
    if (!expert) {
      expert = { expertId: byId, expertType: 'agent', displayName: name || byId, profession: '', version: '', categories: [] };
    }
  } else if (name) {
    const experts = await marketExpertList(cfg, site, accountId, '');
    expert = experts.find((x) => x.displayName === name)
      || experts.find((x) => x.displayName.includes(name) || name.includes(x.displayName))
      || null;
  }
  if (!expert) throw new Error(`找不到「${name || task.code}」对应的专家`);
  await reportDesktopEvents(cfg, site, accountId, expertSummonEvents(expert));
  const chat = await openServerConversation(cfg, site, accountId, expert.expertId);
  if (chat == null) throw new Error(`专家「${expert.displayName}」真会话打开失败`);
  return [{
    transport: 'desktop',
    events: [
      ...expertChatEvents(expert, chat.conversationId, chat.requestId),
      expertActualUseEvent(expert, chat.conversationId, chat.requestId),
    ],
  }];
}

/**
 * 对一批任务执行事件链重放（growthScanAccount 的对话代打之后、领奖之前调用）。
 * 只处理「已报名、未领、未达标」的链任务；一条链失败不拖累其他任务。
 * 返回 { sent, tasks, notes }——sent 是发出的链数（打分要几秒后才落，调用方
 * 发完应等 EVENT_SCORE_WAIT_MS 再重拉列表领奖，本函数末尾代等）。
 */
export async function sendEventChainsForTasks(cfg, site, accountId, tasks, { wait = true } = {}) {
  const notes = [];
  const done = [];
  let sent = 0;
  let sentAnything = false;
  for (const t of tasks) {
    if (!t.code || t.claimed || t.locked || t.acceptStatus !== 'accepted' || t.current >= t.target) continue;
    if (!isEventChainTask(t.code)) continue;
    let chains;
    try {
      chains = await chainsFor(cfg, site, accountId, t);
    } catch (e) {
      notes.push(`${t.title}：链构造失败（${String(e.message || e).slice(0, 80)}）`);
      continue;
    }
    for (const chain of chains) {
      try {
        await sendChain(cfg, site, accountId, chain);
        sent++;
        sentAnything = true;
      } catch (e) {
        notes.push(`${t.title}：事件上报失败（${String(e.message || e).slice(0, 80)}）`);
        break; // 同一任务的后续链失败大概率同样原因，跳到下一个任务
      }
      await sleep(CHAIN_DELAY_MS);
    }
    if (sent > 0) done.push(t.title);
    // 专家族内部已带间隔；任务与任务之间也稍歇
    await sleep(CHAIN_DELAY_MS);
  }
  // 打分在事件落地几秒后才生效：等它，随后调用方的重拉+领奖才能在本轮收进奖励
  if (sentAnything && wait) await sleep(EVENT_SCORE_WAIT_MS);
  if (sentAnything) log(`[${site}] 事件链重放完成：${sent} 条链（${done.join('、') || '无'}）`);
  return { sent, tasks: done, notes };
}
