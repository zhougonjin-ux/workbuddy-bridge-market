// 配置与路径：所有文件（配置、凭证、日志）一律限定在数据目录内，绝不读写目录以外的任何文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJsonFileAtomic } from './util.mjs';

// 用 fileURLToPath + dirname 而不是 import.meta.dirname：
// 后者要 Node ≥ 20.11，会让 README 声明的「≥ 18」变成假的
// （Node 18 上 import.meta.dirname 是 undefined，path.resolve 直接抛 TypeError，
//   服务根本起不来）。等价的写法从 Node 12 起就能用。
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 配置目录：默认 ~/.zcode/workbuddy-bridge —— 配置与账号池和插件代码分离，
// 插件升级/重装不会丢账号。WB_CONFIG_DIR 环境变量可覆盖（测试隔离用它指向临时目录）。
//
// 注意用「可变状态 + 取值函数」而不是把路径冻结成常量：
// 同一进程里可能先后加载多个测试文件，冻结的常量会让后设置的目录失效
// （曾出现测试文件把凭证写进仓库根目录的问题）。
let configDir = process.env.WB_CONFIG_DIR
  ? path.resolve(process.env.WB_CONFIG_DIR)
  : path.join(os.homedir(), '.zcode', 'workbuddy-bridge');

/** 当前配置目录。 */
export function getConfigDir() {
  return configDir;
}

/**
 * 重设配置目录（主要供测试隔离使用）。
 * 返回还原函数，便于在 after() 里恢复。
 */
export function setConfigDir(dir) {
  const prev = configDir;
  configDir = dir ? path.resolve(dir) : ROOT;
  return () => { configDir = prev; };
}

/**
 * 在指定目录下执行一段逻辑（同步或异步），执行前切换、结束后还原。
 *
 * 用途：测试里需要「本次调用一定读写我自己的临时目录」，
 * 且不能被同进程其他测试文件的目录切换干扰。
 * 用法：await withConfigDir(tmp, () => loadConfig())
 */
export async function withConfigDir(dir, fn) {
  const restore = setConfigDir(dir);
  try {
    return await fn();
  } finally {
    restore();
  }
}

export const paths = {
  get root() { return configDir; },
  get config() { return path.join(configDir, 'config.json'); },
  get legacyAuth() { return path.join(configDir, 'auth.json'); }, // 旧版单站点凭证（国内版），仍兼容读取
  get loginState() { return path.join(configDir, '.login-state.json'); },
};

/** 单个站点的凭证文件：auth.<site>.json */
export function authPathFor(site) {
  return path.join(configDir, `auth.${site}.json`);
}

// 上游站点预设：国内版与国际版协议同构，仅域名 / 身份头不同。
export const SITE_PRESETS = {
  'cn-cli': {
    label: '国内版 CLI（copilot.tencent.com）',
    enabled: true,
    apiBase: 'https://copilot.tencent.com',
    billingBase: 'https://www.codebuddy.cn',
    origin: 'https://www.codebuddy.cn',
    userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
    product: 'SaaS',
  },
  'intl-cli': {
    label: '国际版 CLI（codebuddy.ai）',
    enabled: true,
    apiBase: 'https://www.codebuddy.ai',
    billingBase: 'https://www.codebuddy.ai',
    origin: 'https://www.codebuddy.ai',
    userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
    product: 'SaaS',
    // 国际版控制台目录接口不稳定（常 500），这里内置一份实测可用清单兜底。
    // 该清单只影响「裸模型名自动选站点」与 /v1/models 展示，不影响实际调用。
    seedModels: [
      { id: 'auto', name: 'Auto（上游自动路由）' },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra（上游偶发不可用）' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol（上游偶发不可用）' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex' },
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash（实测 0 扣费）' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'kimi-k3', name: 'Kimi-K3' },
      { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
      { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
      { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
      { id: 'minimax-m3', name: 'MiniMax-M3' },
      { id: 'hy3', name: 'Hy3' },
    ],
  },
  'intl-work': {
    label: '国际版 WorkBuddy（workbuddy.ai）',
    enabled: true,
    apiBase: 'https://www.workbuddy.ai',
    billingBase: 'https://www.workbuddy.ai',
    origin: 'https://www.workbuddy.ai',
    userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
    product: 'SaaS',
    // 这个站点拉不到动态目录（catalog_source 恒为 seed），所以内置清单就是它的全部目录。
    // 只放 `auto` 会踩两个坑：
    //   1) 配了 allowModels（如只留 glm-* / deepseek-v4*）时 auto 被过滤掉 → 目录变成 0 个模型，
    //      裸模型名既选不中它、它也不会被选为降级目标；
    //   2) 没有 contextWindow → 压缩模块拿不到上限 → 预压缩完全不生效，
    //      每个长请求都要先撞一次 400 再重试，白等 20~30 秒。
    // 下面是实测可用的清单（上限来自上游报的 "… > 1048576 maximum"）。
    seedModels: [
      { id: 'auto', name: 'Auto（上游自动路由）' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576 },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1048576 },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1048576 },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1048576 },
    ],
  },
};

// 默认模型清单（config.json 缺失时的兜底；真实可用清单以 GET /v1/models 实时拉取为准）
export const DEFAULT_MODELS = [
  { id: 'hy3', name: 'Hy3' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
  { id: 'auto', name: 'Auto（上游自动路由）' },
];

export function defaultConfig() {
  return {
    host: '127.0.0.1', // 仅本机可访问，不对局域网暴露
    port: 8788,
    apiKey: 'sk-wb-' + crypto.randomBytes(12).toString('hex'),
    defaultSite: 'cn-cli',
    defaultModel: 'deepseek-v4-pro',
    defaultMaxTokens: 16384,
    // 上游（尤其是国际版）要求 messages 首条必须是 system，客户端没给时用这句补上
    defaultSystemPrompt: 'You are a helpful AI assistant.',
    // 出站请求体里需要剔除的字段（一般留空）
    stripFields: [],
    // 上游对 system 消息做「客户端指纹」精确匹配，命中就回
    // 400 Illegal API invocation from an unapproved channel。
    // Claude Code、以及 Claude desktop 的 /code 面板会命中（其开场白被列入黑名单）；
    // 剥离后即可正常使用。设为 false 可关闭。
    stripClientFingerprint: true,
    // 模型白名单 / 黑名单（支持 `*` 通配符；站点级也能配 allowModels / excludeModels）
    // allowModels 非空时只保留命中的模型，excludeModels 命中即剔除。
    allowModels: [],
    excludeModels: [],
    // 是否在 /v1/models 里额外暴露 `站点/模型` 变体（默认关闭：部分客户端不认带斜杠的 ID）
    exposeSitePrefixed: false,
    // 站点表：国内版 / 国际版可分别启停，也可自行新增
    sites: structuredClone(SITE_PRESETS),
    // 模型 → 站点 的显式路由（可选），例如 { "claude-4.5": "intl-cli" }
    modelRoutes: {},
    timeouts: {
      headerMs: 90000, // 上游首字节（响应头）超时
      idleMs: 300000, // 流中空闲超时
      metaMs: 30000, // 元数据接口（模型清单 / 额度查询）总时长超时
    },
    // 上游「连接级」失败的重试策略（国际版 codebuddy.ai 实测约有 17% 的连接抖动）
    upstreamRetry: { attempts: 3, backoffMs: [400, 1000] },
    // 上下文压缩：输入超过模型上限时自动裁剪，避免客户端收到裸的
    // "prompt is too long: N > M maximum"（实测 glm-5.1 上限 100000）
    context: {
      enabled: true,
      reserveForOutput: 4096, // 给模型回复预留的 token
      minKeepMessages: 4, // 至少保留最近 N 条消息（system 不计入）
      safetyRatio: 0.95, // 按上限的 95% 算，给 token 估算误差留余量
    },
    // 账号池：同一站点下多个账号，额度耗尽或请求失败时自动换号
    pool: {
      // 单次请求最多尝试几个账号（含第一个）。调大更抗耗尽，但会拖慢失败请求。
      maxAccountsPerRequest: 3,
      // 本站点账号全耗尽时，是否降级到备用站点（该站点也有这个模型时）
      switchSiteOnExhausted: true,
      // workbuddy-bridge 调度策略：
      //   expiry-first  积分最早到期且有余量的账号先用（默认，把快过期的先消耗掉）
      //   balance-first 余额多的先用
      //   round-robin   最久未用的先用（原上游代理默认行为）
      //   pinned        固定用 pinnedAccountId 指定的账号，不可用时回落 expiry-first
      //   free-first    default/auto 请求自动改道到「真免费」（倍率 x0）的模型；没有免费模型则维持默认
      policy: 'expiry-first',
      pinnedAccountId: null,
    },
    // 每个账号积分/到期明细的后台刷新间隔（分钟）。切换账号前不强刷——
    // 用缓存的到期序即可，接口抖动不该拖慢对话请求。
    creditRefreshMinutes: 30,
    // ZCode 模型选择器里是否把调用倍率编码进模型 ID（如 "glm-5.3-flash (x0.06)"）。
    // 关掉后选择器只显示裸 ID。调用时带不带后缀都能路由（自动剥离）。
    pickerMultiplierSuffix: true,
    // 模型池自动同步间隔（分钟）：定期把上游模型清单写进 ZCode 的个人供应商配置，
    // 上游加/删模型或倍率变动时，选择器无需重启会话即可跟上。
    providerSyncMinutes: 30,
    // 自动签到与成长任务（任务中心自动报名 + 达标领奖）
    tasks: {
      enabled: true,
      checkin: true,          // 每日签到（/v2/billing/meter/daily-checkin）
      growth: true,           // 成长任务（/v2/activity/growth/tasks*）
      checkinHours: [9, 21],  // 签到尝试时点（本地小时；已签到的账号自动跳过）
      growthHours: [1, 13],   // 成长任务扫描时点
      checkinTimes: [],       // 精确时点 ["HH:MM"]；非空时优先于 checkinHours
      growthTimes: [],        // 同上，精确到分钟
      travelTimes: ['09:00', '15:00', '21:00'], // 猫猫旅行巡逻时点（状态机幂等，一天可多次）
      listTimes: ['09:00', '15:00', '21:00'],  // 控制台任务中心列表的每日自动刷新时点（预取缓存）
      doctorTimes: ['10:00'], // 每日自动体检时点：有 fail 项推通知，全绿只记时间线；空数组=关闭
      travelLocationId: 4,    // 派出地点（参考实现实测 4 个地点收益/时长区间相同）
      jitterMinutes: 30,      // 时点上的随机延迟（分钟），避开整点高峰
      autoComplete: true,     // 成长任务里的「对话体验类」由桥接代打极小请求点亮进度
      maxChatsPerTask: 5,     // 单任务单次扫描最多代打次数（控制成本）
    },
    // 按时段路由（T20）：default 请求在本地时间 dayStart–nightStart 走 dayModel，
    // 其余（含跨零点）走 nightModel。默认关闭；改 dayModel/nightModel 即时生效（每次请求现读）。
    // 与 free-first / 预算切免费同走哨兵改道，但优先级最高（时段是更明确的用户意图）。
    scheduleRouter: {
      enabled: false,
      dayStart: '08:00',      // 白天起点（含）
      nightStart: '23:00',    // 夜间起点（含）；dayStart < nightStart 为常规写法，> 则支持跨零点
      dayModel: '',           // 留空表示该时段不改道（保持 defaultModel）
      nightModel: '',
    },
    // 模型健康巡检（T8）：定时对全部模型发 max_tokens=1 的极小请求测可用性/延迟。
    // 默认关闭——巡检是真实消耗，17 模型一轮 ≈0.1~0.5 积分；由用户显式开启或手动触发。
    // T35 省钱模式：only 白名单（支持 * 前缀通配）与 onlyFree（只探 x0 免费模型），
    // 两者可叠加；都不设 = 全量。想省钱就把这两个用起来。
    healthCheck: {
      enabled: false,
      times: [],              // ["HH:MM"] 定时巡检时点，每天最多一次（首个命中时点）
      only: [],               // 只巡检这些模型（空 = 全部）
      onlyFree: false,        // true = 只巡检倍率 0 的免费模型
    },
    // 用量周报（T46）：每周一在这些时点把上周用量汇总推送到通知通道（桌面气泡 + T33 多通道）。
    // 纯读数零消耗；每周最多一次（状态落数据目录 weekly.json，重启不重复发）。
    weekly: {
      enabled: true,
      times: ['09:00'],       // ["HH:MM"]，周一命中即发
    },
    // 数据自动备份（T58）：每天在这些时点把 config + 账号池 + 状态文件打包存到
    // 数据目录 backups/（同一天只备一次，滚动保留 keep 份）。账号池里是上游 token，
    // 丢了就得全部重扫——每天备一次，最多丢当天的增量。
    backup: {
      enabled: true,
      times: ['09:00'],       // ["HH:MM"]，每天命中第一个时点即备
      keep: 4,                // 滚动保留份数
    },
    // 桌面通知（T11）：签到失败/猫猫归来/账号登录态失效弹 Windows toast。默认开。
    // channels（T33）：把同一条通知并行推到手机，fire-and-forget。
    //   webhook    POST JSON { title, text }
    //   bark       GET <url>/<title>/<body>（Bark 的设备 key 写在 url 里）
    //   serverchan POST <url>，表单 title= & desp=
    // 不预置——用户填自己的地址，不配就完全不联网。
    notify: {
      enabled: true,
      channels: [],
    },
    // 顶栏预警阈值（T34）：原先写死在前端（200 / 7 / 500），挪进配置让用户按自己的
    // 积分规模调。改完即时生效（预警条每 60s 拉一次 /bridge）。
    alerts: {
      lowBalance: 200,       // 任一账号余额 ≤ 此值 → 红「余额不足」
      expiryDays: 7,         // 批次在此天数内到期
      expiryMinAmount: 500,  // 且余量 > 此值才提醒（余量太小的不值得占位）
    },
    // 每日积分预算（T13）：今日累计消耗（估算口径，与用量页同源）超过 budget 比例时
    // 预警；到 100% 后按 mode 动作。默认关闭——单用户白嫖场景一般用不到，重度消耗者才需要护栏。
    budget: {
      enabled: false,
      dailyCredits: 100,      // 每日预算（积分，估算口径）
      warnPercent: 80,        // 达到该比例时预警（控制台预警条 + 事件）
      mode: 'warn',           // warn=只预警 | free=超限后 default/auto 改道免费模型（T13）| pause=超限直接拒绝新请求（T37）
      accounts: {},           // T63 按账号预算：{ accountId: 每日积分 }，只提醒+展示不改道（见 budget.mjs）
    },
    // 限流：服务只绑 127.0.0.1，所以要挡的不是远程攻击，而是
    //   1) 客户端 bug 导致的失控重试循环
    //   2) 重端点被反复触发（/console/api/probe 一次最多 60 次上游调用）
    // 默认值刻意放宽 —— 正常单用户使用（含编码 agent 的工具调用突发）远达不到。
    rateLimit: {
      enabled: true,
      windowMs: 10_000, // 滑动窗口长度
      max: 600, // 每窗口每来源 IP 的总请求上限（≈60 次/秒）
      probeMax: 3, // 其中 /probe 更严（它一次最多 60 次上游调用 + 至少 15 秒）
    },
    // 控制台访问 PIN（T23）：设为 4-12 位数字字符串时，打开 /console 页面需要先输 PIN；
    // 服务端校验通过才发会话 token（token 只存内存，重启后重新输一次）。
    // null/空串 = 不启用（默认，保持原有「本机即信任」行为）。
    consolePin: null,
    models: DEFAULT_MODELS,
    modelAliases: {},
  };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base !== 'object' || base === null || typeof over !== 'object' || over === null) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    // JSON.parse 产出的自有 __proto__ 键经赋值会触发原型 setter，把 cfg 的原型换掉
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

/** 旧版 `upstream` 字段 → sites['cn-cli']，保证老配置继续可用。 */
function migrateLegacy(raw) {
  if (!raw.upstream || raw.sites) return {};
  const u = raw.upstream;
  return {
    sites: {
      'cn-cli': {
        apiBase: u.apiBase,
        billingBase: u.billingBase,
        origin: u.origin,
        userAgent: u.userAgent,
      },
    },
  };
}

/* ============================================================
   配置校验
   ------------------------------------------------------------
   目的：config.json 是用户手改的文件，写错类型时原先会让服务以难懂的方式崩掉：
     timeouts: null            → openChat 抛 "Cannot read properties of null"
     port: null / "abc"        → listen 失败或监听意外端口
     sites: null               → 站点静默消失
     apiKey: ""                → 鉴权被完全跳过（已在 server.mjs 兜底警告）
   这里统一做「类型校验 + 回退默认值 + 记录问题」，保证：
     - 合法配置：行为与之前完全一致（不触发任何修复）
     - 非法配置：降级为安全默认值并可读地告知，而不是崩溃
   ============================================================ */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';

/** T33 认可的外部通知通道类型（与 notify.mjs 的 CHANNEL_TYPES 保持一致）。 */
export const NOTIFY_CHANNEL_TYPES = ['webhook', 'bark', 'serverchan', 'feishu', 'dingtalk', 'telegram'];

/** 正整数端口。不允许 0（随机端口）：hooks/status/stop 全部按固定端口探测，
 *  配 0 会让会话钩子每次都认为服务没起、再拉一个新实例，进程无限堆积。 */
function isPort(v) {
  return Number.isInteger(v) && v >= 1 && v <= 65535;
}
const PORT_HINT = 'port 必须是 1-65535 的整数（不允许 0：钩子按固定端口探测）';

function isPositiveMs(v) {
  return Number.isFinite(v) && v > 0;
}

/**
 * 校验并就地修复配置。返回问题描述数组（为空表示配置完全合法）。
 * 修复策略：能安全回退到默认值的回退，无法回退的删除该项。
 */
export function validateConfig(cfg, defaults = defaultConfig()) {
  const issues = [];
  const fix = (msg) => issues.push(msg);

  // ---- 监听地址 ----
  if (!isStr(cfg.host) || !cfg.host.trim()) {
    fix(`host 必须是字符串，已回退为 ${defaults.host}`);
    cfg.host = defaults.host;
  }
  if (!isPort(cfg.port)) {
    fix(`${PORT_HINT}（当前 ${JSON.stringify(cfg.port)}），已回退为 ${defaults.port}`);
    cfg.port = defaults.port;
  }

  // ---- 密钥：可以是字符串，也可以是字符串数组。数组里每个都有效，方便同时给
  //      多个客户端（或演示环境）发不同的密钥，而不用来回改 + 重启。
  //      空串、类型错误、全空数组都视为"未配置"（由服务层决定是否放行并告警）。----
  if (Array.isArray(cfg.apiKey)) {
    const 清理后 = [];
    for (const k of cfg.apiKey) {
      if (!isStr(k) || !k.trim()) {
        fix('apiKey 数组里必须是非空字符串，已忽略其中一项');
        continue;
      }
      const t = k.trim();
      if (!清理后.includes(t)) 清理后.push(t);
    }
    cfg.apiKey = 清理后;
  } else if (!isStr(cfg.apiKey)) {
    fix('apiKey 必须是字符串或字符串数组，已回退为空（服务将不做鉴权）');
    cfg.apiKey = '';
  }

  // ---- 模型与站点 ----
  if (!isStr(cfg.defaultModel) || !cfg.defaultModel.trim()) {
    fix(`defaultModel 必须是非空字符串，已回退为 ${defaults.defaultModel}`);
    cfg.defaultModel = defaults.defaultModel;
  }
  if (!isStr(cfg.defaultSite) || !cfg.defaultSite.trim()) {
    fix(`defaultSite 必须是非空字符串，已回退为 ${defaults.defaultSite}`);
    cfg.defaultSite = defaults.defaultSite;
  }

  // ---- 数值字段 ----
  if (!Number.isInteger(cfg.defaultMaxTokens) || cfg.defaultMaxTokens <= 0) {
    fix(`defaultMaxTokens 必须是正整数，已回退为 ${defaults.defaultMaxTokens}`);
    cfg.defaultMaxTokens = defaults.defaultMaxTokens;
  }

  // ---- 提示词 ----
  if (cfg.defaultSystemPrompt !== undefined && !isStr(cfg.defaultSystemPrompt)) {
    fix('defaultSystemPrompt 必须是字符串，已回退为默认提示语');
    cfg.defaultSystemPrompt = defaults.defaultSystemPrompt;
  }

  // ---- 数组 / 对象字段 ----
  if (!Array.isArray(cfg.stripFields)) {
    fix('stripFields 必须是数组，已回退为 []');
    cfg.stripFields = [];
  } else if (cfg.stripFields.some((f) => !isStr(f))) {
    const kept = cfg.stripFields.filter(isStr);
    fix(`stripFields 含非字符串项，已剔除 ${cfg.stripFields.length - kept.length} 项`);
    cfg.stripFields = kept;
  }

  // ---- 客户端指纹剥离（布尔开关；写错类型时回退为默认的 true）----
  if (typeof cfg.stripClientFingerprint !== 'boolean') {
    if (cfg.stripClientFingerprint !== undefined) {
      fix(`stripClientFingerprint 必须是布尔值，已回退为 ${defaults.stripClientFingerprint}`);
    }
    cfg.stripClientFingerprint = defaults.stripClientFingerprint;
  }

  if (!isPlainObject(cfg.modelRoutes)) {
    fix('modelRoutes 必须是对象，已回退为 {}');
    cfg.modelRoutes = {};
  }
  if (!isPlainObject(cfg.modelAliases)) {
    fix('modelAliases 必须是对象，已回退为 {}');
    cfg.modelAliases = {};
  }
  if (!Array.isArray(cfg.models)) {
    fix('models 必须是数组，已回退为默认清单');
    cfg.models = defaults.models;
  }

  // ---- 模型白/黑名单与站点前缀暴露 ----
  for (const field of ['allowModels', 'excludeModels']) {
    if (!Array.isArray(cfg[field])) {
      fix(`${field} 必须是数组，已回退为 []`);
      cfg[field] = [];
    } else if (cfg[field].some((v) => !isStr(v))) {
      const kept = cfg[field].filter(isStr);
      fix(`${field} 含非字符串项，已剔除 ${cfg[field].length - kept.length} 项`);
      cfg[field] = kept;
    }
  }
  if (cfg.exposeSitePrefixed !== undefined && !isBool(cfg.exposeSitePrefixed)) {
    fix('exposeSitePrefixed 必须是布尔值，已回退为 false');
    cfg.exposeSitePrefixed = Boolean(defaults.exposeSitePrefixed);
  }

  // ---- 上游连接级重试策略 ----
  if (!isPlainObject(cfg.upstreamRetry)) {
    fix('upstreamRetry 必须是对象，已回退为默认值');
    cfg.upstreamRetry = structuredClone(defaults.upstreamRetry);
  } else {
    if (!Number.isInteger(cfg.upstreamRetry.attempts) || cfg.upstreamRetry.attempts <= 0) {
      fix(`upstreamRetry.attempts 必须是正整数，已回退为 ${defaults.upstreamRetry.attempts}`);
      cfg.upstreamRetry.attempts = defaults.upstreamRetry.attempts;
    }
    if (!Array.isArray(cfg.upstreamRetry.backoffMs)
      || cfg.upstreamRetry.backoffMs.some((v) => !Number.isFinite(v) || v < 0)) {
      fix('upstreamRetry.backoffMs 必须是非负数数组，已回退为默认值');
      cfg.upstreamRetry.backoffMs = [...defaults.upstreamRetry.backoffMs];
    }
  }

  // ---- 上下文压缩 ----
  if (!isPlainObject(cfg.context)) {
    fix('context 必须是对象，已回退为默认值');
    cfg.context = structuredClone(defaults.context);
  } else {
    if (typeof cfg.context.enabled !== 'boolean') cfg.context.enabled = defaults.context.enabled;
    if (!Number.isInteger(cfg.context.reserveForOutput) || cfg.context.reserveForOutput < 0) {
      fix(`context.reserveForOutput 必须是非负整数，已回退为 ${defaults.context.reserveForOutput}`);
      cfg.context.reserveForOutput = defaults.context.reserveForOutput;
    }
    if (!Number.isInteger(cfg.context.minKeepMessages) || cfg.context.minKeepMessages < 0) {
      fix(`context.minKeepMessages 必须是非负整数，已回退为 ${defaults.context.minKeepMessages}`);
      cfg.context.minKeepMessages = defaults.context.minKeepMessages;
    }
    if (!Number.isFinite(cfg.context.safetyRatio) || cfg.context.safetyRatio <= 0 || cfg.context.safetyRatio > 1) {
      fix(`context.safetyRatio 必须是 (0,1] 之间的小数，已回退为 ${defaults.context.safetyRatio}`);
      cfg.context.safetyRatio = defaults.context.safetyRatio;
    }
  }

  // ---- 账号池 ----
  if (!isPlainObject(cfg.pool)) {
    fix('pool 必须是对象，已回退为默认值');
    cfg.pool = structuredClone(defaults.pool);
  } else {
    if (!Number.isInteger(cfg.pool.maxAccountsPerRequest) || cfg.pool.maxAccountsPerRequest <= 0) {
      fix(`pool.maxAccountsPerRequest 必须是正整数，已回退为 ${defaults.pool.maxAccountsPerRequest}`);
      cfg.pool.maxAccountsPerRequest = defaults.pool.maxAccountsPerRequest;
    }
    if (typeof cfg.pool.switchSiteOnExhausted !== 'boolean') {
      cfg.pool.switchSiteOnExhausted = defaults.pool.switchSiteOnExhausted;
    }
    if (!['expiry-first', 'balance-first', 'round-robin', 'pinned', 'free-first'].includes(cfg.pool.policy)) {
      fix(`pool.policy 必须是 expiry-first/balance-first/round-robin/pinned/free-first 之一（当前 ${JSON.stringify(cfg.pool.policy)}），已回退为 ${defaults.pool.policy}`);
      cfg.pool.policy = defaults.pool.policy;
    }
    if (cfg.pool.pinnedAccountId !== undefined && cfg.pool.pinnedAccountId !== null && !isStr(cfg.pool.pinnedAccountId)) {
      fix('pool.pinnedAccountId 必须是字符串或 null，已回退为 null');
      cfg.pool.pinnedAccountId = null;
    }
  }

  // ---- 积分明细刷新间隔 ----
  if (!Number.isFinite(cfg.creditRefreshMinutes) || cfg.creditRefreshMinutes <= 0) {
    fix(`creditRefreshMinutes 必须是正数，已回退为 ${defaults.creditRefreshMinutes}`);
    cfg.creditRefreshMinutes = defaults.creditRefreshMinutes;
  }

  // ---- 选择器倍率开关 ----
  if (cfg.pickerMultiplierSuffix !== undefined && typeof cfg.pickerMultiplierSuffix !== 'boolean') {
    fix(`pickerMultiplierSuffix 必须是布尔值，已回退为 ${defaults.pickerMultiplierSuffix}`);
    cfg.pickerMultiplierSuffix = defaults.pickerMultiplierSuffix;
  }

  // ---- 模型池自动同步间隔 ----
  if (!Number.isFinite(cfg.providerSyncMinutes) || cfg.providerSyncMinutes <= 0) {
    fix(`providerSyncMinutes 必须是正数，已回退为 ${defaults.providerSyncMinutes}`);
    cfg.providerSyncMinutes = defaults.providerSyncMinutes;
  }

  // ---- 自动任务 ----
  if (!isPlainObject(cfg.tasks)) {
    fix('tasks 必须是对象，已回退为默认值');
    cfg.tasks = structuredClone(defaults.tasks);
  } else {
    for (const k of ['enabled', 'checkin', 'growth']) {
      if (typeof cfg.tasks[k] !== 'boolean') cfg.tasks[k] = defaults.tasks[k];
    }
    for (const k of ['checkinHours', 'growthHours']) {
      if (!Array.isArray(cfg.tasks[k]) || !cfg.tasks[k].every((h) => Number.isInteger(h) && h >= 0 && h <= 23)) {
        fix(`tasks.${k} 必须是 0-23 的整数数组，已回退为默认值`);
        cfg.tasks[k] = defaults.tasks[k];
      }
    }
    // 精确时点 ["HH:MM"]：非空时优先于 *Hours
    for (const k of ['checkinTimes', 'growthTimes', 'travelTimes', 'listTimes', 'doctorTimes']) {
      if (cfg.tasks[k] === undefined) { cfg.tasks[k] = defaults.tasks[k]; continue; }
      if (!Array.isArray(cfg.tasks[k])) cfg.tasks[k] = structuredClone(defaults.tasks[k]);
      else {
        const ok = cfg.tasks[k].every((s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s).trim()));
        if (!ok) {
          fix(`tasks.${k} 必须是 "HH:MM" 字符串数组（如 ["09:00","21:30"]），已回退为默认值`);
          cfg.tasks[k] = structuredClone(defaults.tasks[k]);
        } else {
          cfg.tasks[k] = cfg.tasks[k].map((s) => String(s).trim().padStart(5, '0'));
        }
      }
    }
    if (!Number.isInteger(cfg.tasks.travelLocationId) || cfg.tasks.travelLocationId < 1 || cfg.tasks.travelLocationId > 99) {
      cfg.tasks.travelLocationId = defaults.tasks.travelLocationId;
    }
    if (typeof cfg.tasks.autoComplete !== 'boolean') cfg.tasks.autoComplete = defaults.tasks.autoComplete;
    if (!Number.isInteger(cfg.tasks.maxChatsPerTask) || cfg.tasks.maxChatsPerTask < 1 || cfg.tasks.maxChatsPerTask > 20) {
      cfg.tasks.maxChatsPerTask = defaults.tasks.maxChatsPerTask;
    }
    if (!Number.isFinite(cfg.tasks.jitterMinutes) || cfg.tasks.jitterMinutes < 0) {
      cfg.tasks.jitterMinutes = defaults.tasks.jitterMinutes;
    }
  }

  // ---- 模型健康巡检 ----
  if (!isPlainObject(cfg.healthCheck)) {
    if (cfg.healthCheck !== undefined) fix('healthCheck 必须是对象，已回退为默认值');
    cfg.healthCheck = structuredClone(defaults.healthCheck);
  } else {
    if (typeof cfg.healthCheck.enabled !== 'boolean') cfg.healthCheck.enabled = defaults.healthCheck.enabled;
    if (cfg.healthCheck.times === undefined) { cfg.healthCheck.times = defaults.healthCheck.times; }
    else if (!Array.isArray(cfg.healthCheck.times)
      || !cfg.healthCheck.times.every((s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s).trim()))) {
      fix('healthCheck.times 必须是 "HH:MM" 字符串数组（如 ["08:00"]），已回退为 []');
      cfg.healthCheck.times = [];
    } else {
      cfg.healthCheck.times = cfg.healthCheck.times.map((s) => String(s).trim().padStart(5, '0'));
    }
    // T35 省钱模式：only 白名单 + onlyFree（都不设 = 全量）
    if (cfg.healthCheck.only === undefined) { cfg.healthCheck.only = defaults.healthCheck.only; }
    else if (!Array.isArray(cfg.healthCheck.only) || cfg.healthCheck.only.some((s) => !isStr(s))) {
      fix('healthCheck.only 必须是字符串数组（模型名，支持 * 前缀通配），已回退为 []');
      cfg.healthCheck.only = [];
    } else {
      cfg.healthCheck.only = cfg.healthCheck.only.map((s) => s.trim()).filter(Boolean);
    }
    if (typeof cfg.healthCheck.onlyFree !== 'boolean') cfg.healthCheck.onlyFree = defaults.healthCheck.onlyFree;
  }

  // ---- 用量周报（T46）----
  if (!isPlainObject(cfg.weekly)) {
    if (cfg.weekly !== undefined) fix('weekly 必须是对象，已回退为默认值');
    cfg.weekly = structuredClone(defaults.weekly);
  } else {
    if (typeof cfg.weekly.enabled !== 'boolean') cfg.weekly.enabled = defaults.weekly.enabled;
    if (cfg.weekly.times === undefined) { cfg.weekly.times = defaults.weekly.times; }
    else if (!Array.isArray(cfg.weekly.times)
      || !cfg.weekly.times.every((s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s).trim()))) {
      fix('weekly.times 必须是 "HH:MM" 字符串数组（如 ["09:00"]），已回退为默认值');
      cfg.weekly.times = structuredClone(defaults.weekly.times);
    } else {
      cfg.weekly.times = cfg.weekly.times.map((s) => String(s).trim().padStart(5, '0'));
    }
  }

  // ---- 数据自动备份（T58）----
  if (!isPlainObject(cfg.backup)) {
    if (cfg.backup !== undefined) fix('backup 必须是对象，已回退为默认值');
    cfg.backup = structuredClone(defaults.backup);
  } else {
    if (typeof cfg.backup.enabled !== 'boolean') cfg.backup.enabled = defaults.backup.enabled;
    if (cfg.backup.times === undefined) { cfg.backup.times = structuredClone(defaults.backup.times); }
    else if (!Array.isArray(cfg.backup.times)
      || !cfg.backup.times.every((s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s).trim()))) {
      fix('backup.times 必须是 "HH:MM" 字符串数组（如 ["09:00"]），已回退为默认值');
      cfg.backup.times = structuredClone(defaults.backup.times);
    } else {
      cfg.backup.times = cfg.backup.times.map((s) => String(s).trim().padStart(5, '0'));
    }
    if (cfg.backup.keep === undefined) cfg.backup.keep = defaults.backup.keep;
    else {
      const n = Number(cfg.backup.keep);
      if (!Number.isInteger(n) || n < 1 || n > 52) {
        fix('backup.keep 必须是 1-52 的整数（滚动保留份数），已回退为默认值');
        cfg.backup.keep = defaults.backup.keep;
      } else cfg.backup.keep = n;
    }
  }

  // ---- 桌面通知（T11）+ 外部通知通道（T33）----
  if (cfg.notify !== undefined && !isPlainObject(cfg.notify)) {
    fix('notify 必须是对象，已回退为默认值');
    cfg.notify = structuredClone(defaults.notify);
  } else if (cfg.notify) {
    if (typeof cfg.notify.enabled !== 'boolean') cfg.notify.enabled = defaults.notify.enabled;
    // channels 逐条校验：类型不认识或没 url 的直接丢掉（留着只会静默失败，不如报错）
    if (cfg.notify.channels === undefined) {
      cfg.notify.channels = [];
    } else if (!Array.isArray(cfg.notify.channels)) {
      fix('notify.channels 必须是数组，已回退为空');
      cfg.notify.channels = [];
    } else {
      const kept = [];
      for (const c of cfg.notify.channels) {
        if (!isPlainObject(c) || !NOTIFY_CHANNEL_TYPES.includes(String(c.type))) {
          fix(`notify.channels 里的 ${JSON.stringify(c?.type)} 不是 webhook/bark/serverchan，已丢弃该条`);
          continue;
        }
        if (!isStr(c.url) || !c.url.trim()) {
          fix(`notify.channels 里的 ${c.type} 通道缺少 url，已丢弃该条`);
          continue;
        }
        kept.push({ type: c.type, url: c.url.trim(), enabled: c.enabled !== false });
      }
      cfg.notify.channels = kept;
    }
  }

  // ---- 顶栏预警阈值（T34）----
  if (cfg.alerts !== undefined && !isPlainObject(cfg.alerts)) {
    fix('alerts 必须是对象，已回退为默认值');
    cfg.alerts = structuredClone(defaults.alerts);
  } else if (cfg.alerts) {
    for (const [k, min] of [['lowBalance', 0], ['expiryDays', 1], ['expiryMinAmount', 0]]) {
      const n = Number(cfg.alerts[k]);
      if (!Number.isFinite(n) || n < min) {
        fix(`alerts.${k} 必须是 ≥${min} 的数，已回退为 ${defaults.alerts[k]}`);
        cfg.alerts[k] = defaults.alerts[k];
      }
    }
  }

  // ---- 按时段路由（T20）----
  if (cfg.scheduleRouter !== undefined && !isPlainObject(cfg.scheduleRouter)) {
    fix('scheduleRouter 必须是对象，已回退为默认值');
    cfg.scheduleRouter = structuredClone(defaults.scheduleRouter);
  } else if (cfg.scheduleRouter) {
    if (typeof cfg.scheduleRouter.enabled !== 'boolean') cfg.scheduleRouter.enabled = defaults.scheduleRouter.enabled;
    for (const k of ['dayStart', 'nightStart']) {
      const v = String(cfg.scheduleRouter[k] ?? '').trim();
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) {
        fix(`scheduleRouter.${k} 必须是 "HH:MM"（当前 ${JSON.stringify(cfg.scheduleRouter[k])}），已回退为 ${defaults.scheduleRouter[k]}`);
        cfg.scheduleRouter[k] = defaults.scheduleRouter[k];
      } else {
        cfg.scheduleRouter[k] = v.padStart(5, '0');
      }
    }
    for (const k of ['dayModel', 'nightModel']) {
      if (cfg.scheduleRouter[k] !== undefined && !isStr(cfg.scheduleRouter[k])) {
        fix(`scheduleRouter.${k} 必须是字符串，已回退为空（该时段不改道）`);
        cfg.scheduleRouter[k] = '';
      }
    }
  }

  // ---- 每日积分预算（T13）----
  if (cfg.budget !== undefined && !isPlainObject(cfg.budget)) {
    fix('budget 必须是对象，已回退为默认值');
    cfg.budget = structuredClone(defaults.budget);
  } else if (cfg.budget) {
    if (typeof cfg.budget.enabled !== 'boolean') cfg.budget.enabled = defaults.budget.enabled;
    if (!Number.isFinite(cfg.budget.dailyCredits) || cfg.budget.dailyCredits <= 0) {
      fix(`budget.dailyCredits 必须是正数，已回退为 ${defaults.budget.dailyCredits}`);
      cfg.budget.dailyCredits = defaults.budget.dailyCredits;
    }
    if (!Number.isFinite(cfg.budget.warnPercent) || cfg.budget.warnPercent <= 0 || cfg.budget.warnPercent >= 100) {
      fix(`budget.warnPercent 必须是 (0,100) 之间的数，已回退为 ${defaults.budget.warnPercent}`);
      cfg.budget.warnPercent = defaults.budget.warnPercent;
    }
    if (!['warn', 'free', 'pause'].includes(cfg.budget.mode)) {
      fix(`budget.mode 必须是 warn/free/pause 之一，已回退为 ${defaults.budget.mode}`);
      cfg.budget.mode = defaults.budget.mode;
    }
    // T63 按账号预算：{ accountId: 每日积分预算 }；值非法的条目剔除而不是整段回退
    if (cfg.budget.accounts === undefined) cfg.budget.accounts = {};
    else if (!isPlainObject(cfg.budget.accounts)) {
      fix('budget.accounts 必须是对象（accountId → 每日积分预算），已重置为空');
      cfg.budget.accounts = {};
    } else {
      for (const [k, v] of Object.entries(cfg.budget.accounts)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
          fix(`budget.accounts.${k} 必须是正数，已剔除该条目`);
          delete cfg.budget.accounts[k];
        } else {
          cfg.budget.accounts[k] = n;
        }
      }
    }
  }

  // ---- 限流 ----
  if (!isPlainObject(cfg.rateLimit)) {
    fix('rateLimit 必须是对象，已回退为默认值');
    cfg.rateLimit = structuredClone(defaults.rateLimit);
  } else {
    if (typeof cfg.rateLimit.enabled !== 'boolean') {
      cfg.rateLimit.enabled = defaults.rateLimit.enabled;
    }
    for (const k of ['windowMs', 'max', 'probeMax']) {
      if (!Number.isInteger(cfg.rateLimit[k]) || cfg.rateLimit[k] <= 0) {
        fix(`rateLimit.${k} 必须是正整数，已回退为 ${defaults.rateLimit[k]}`);
        cfg.rateLimit[k] = defaults.rateLimit[k];
      }
    }
  }

  // ---- 控制台访问 PIN（T23）：4-12 位数字；空值 = 关闭。写错类型回退关闭而不是锁死控制台 ----
  {
    const pin = cfg.consolePin;
    if (pin === undefined || pin === null || String(pin).trim() === '') {
      cfg.consolePin = null;
    } else if (!/^\d{4,12}$/.test(String(pin).trim())) {
      fix('consolePin 必须是 4-12 位数字（或 null 关闭），已回退为关闭');
      cfg.consolePin = null;
    } else {
      cfg.consolePin = String(pin).trim();
    }
  }

  // ---- 超时（原先 timeouts:null 会让所有对话请求 500）----
  if (!isPlainObject(cfg.timeouts)) {
    fix('timeouts 必须是对象，已回退为默认值');
    cfg.timeouts = { ...defaults.timeouts };
  } else {
    for (const [k, dv] of Object.entries(defaults.timeouts)) {
      if (!isPositiveMs(cfg.timeouts[k])) {
        fix(`timeouts.${k} 必须是正数（当前 ${JSON.stringify(cfg.timeouts[k])}），已回退为 ${dv}`);
        cfg.timeouts[k] = dv;
      }
    }
  }

  // ---- 站点表（null / 非对象会让站点静默消失）----
  if (!isPlainObject(cfg.sites)) {
    fix('sites 必须是对象，已回退为内置站点预设');
    cfg.sites = structuredClone(defaults.sites);
  } else {
    for (const [key, site] of Object.entries(cfg.sites)) {
      if (!isPlainObject(site)) {
        fix(`sites.${key} 必须是对象，已移除该站点`);
        delete cfg.sites[key];
        continue;
      }
      // apiBase / origin 是构造上游请求与请求头的必需项
      for (const field of ['apiBase', 'origin']) {
        if (!isStr(site[field]) || !site[field].trim()) {
          fix(`sites.${key}.${field} 必须是非空字符串，已回退为默认值`);
          site[field] = defaults.sites[key]?.[field] ?? '';
        }
      }
      // billingBase 可选：并非所有站点都使用 CodeBuddy 的计费接口，
      // 预设里可能本就没有该字段，不能因为「缺失」就报问题；
      // 仅在「给了但值不合法」时修正。
      if (site.billingBase !== undefined && (!isStr(site.billingBase) || !site.billingBase.trim())) {
        const fallback = defaults.sites[key]?.billingBase;
        if (fallback) {
          fix(`sites.${key}.billingBase 必须是非空字符串，已回退为默认值`);
          site.billingBase = fallback;
        } else {
          fix(`sites.${key}.billingBase 必须是字符串，已移除该字段`);
          delete site.billingBase;
        }
      }
      if (site.enabled !== undefined && !isBool(site.enabled)) {
        fix(`sites.${key}.enabled 必须是布尔值，已回退为 true`);
        site.enabled = true;
      }
      if (site.seedModels !== undefined && !Array.isArray(site.seedModels)) {
        fix(`sites.${key}.seedModels 必须是数组，已回退为 []`);
        site.seedModels = [];
      }
    }
    // 站点全被移除时兜底回默认，避免服务无站点可用
    if (!Object.keys(cfg.sites).length) {
      fix('sites 校验后为空，已回退为内置站点预设');
      cfg.sites = structuredClone(defaults.sites);
    }
  }

  // ---- defaultSite 必须指向一个真实存在的站点 ----
  if (!cfg.sites[cfg.defaultSite] || cfg.sites[cfg.defaultSite].enabled === false) {
    const fallback = Object.keys(cfg.sites).find((k) => cfg.sites[k]?.enabled !== false);
    if (fallback) {
      fix(`defaultSite "${cfg.defaultSite}" 不存在或已禁用，已改用 "${fallback}"`);
      cfg.defaultSite = fallback;
    } else {
      fix('所有站点都已禁用：服务将空转，请在控制台启用至少一个站点');
    }
  }

  // ---- 别名/路由里引用的站点必须存在（否则会静默走到默认站点）----
  for (const [alias, target] of Object.entries(cfg.modelAliases)) {
    if (!isStr(target)) {
      fix(`modelAliases.${alias} 的值必须是字符串，已移除该别名`);
      delete cfg.modelAliases[alias];
    }
  }
  for (const [model, site] of Object.entries(cfg.modelRoutes)) {
    if (!isStr(site) || !cfg.sites[site]) {
      fix(`modelRoutes.${model} 指向不存在的站点 "${site}"，已移除该路由`);
      delete cfg.modelRoutes[model];
    }
  }

  return issues;
}

/** 读取配置并校验；返回 { cfg, issues }。 */
export function loadConfigChecked(opts) {
  const cfg = loadConfig();
  const issues = validateConfig(cfg);
  return { cfg, issues };
}

// 记录最近一次 loadConfig 发现的问题，供服务启动时提示。
// 之所以要单独存：loadConfig 内部已经把坏值修好了，外部再调一次 validateConfig
// 只会看到"已经合法"的配置，什么问题都报不出来。
let lastIssues = [];

/** 最近一次配置加载中发现的问题（已自动修复的项）。 */
export function getLastConfigIssues() {
  return lastIssues.slice();
}

/**
 * 读取 config.json；缺失时用默认配置落盘（含随机生成的本地 API Key）。
 *
 * @param {string} [dir] 可选：显式指定配置目录。
 *   传入时会临时切到该目录读取（读完还原），使调用不受进程内其他代码
 *   切换全局目录的影响——测试里应该用这个，而不是依赖 beforeEach 设置全局态。
 */
export function loadConfig(dir) {
  if (!dir) return loadConfigFrom(configDir);
  const restore = setConfigDir(dir);
  try {
    return loadConfigFrom(configDir);
  } finally {
    restore();
  }
}

function loadConfigFrom(dir) {
  const configFile = path.join(dir, 'config.json');
  if (!fs.existsSync(configFile)) {
    // workbuddy-bridge：数据目录默认在 ~/.zcode/workbuddy-bridge，首次运行时还不存在，
    // 必须先建目录（原版写项目根目录天然存在，没有这一步会在首启时 ENOENT 崩掉）
    fs.mkdirSync(dir, { recursive: true });
    const cfg = defaultConfig();
    // 原子写：写一半被杀会留下坏 JSON，下次启动直接 INVALID_CONFIG_JSON 硬错误
    writeJsonFileAtomic(configFile, cfg);
    lastIssues = [];
    return cfg;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (e) {
    // 配置不是合法 JSON：不静默重置用户文件（可能只是手改漏了个逗号），
    // 而是报错并让调用方决定，避免覆盖掉用户内容。
    const err = new Error(`config.json 不是合法 JSON：${e.message}`);
    err.code = 'INVALID_CONFIG_JSON';
    throw err;
  }
  const merged = deepMerge(defaultConfig(), migrateLegacy(raw));
  const cfg = deepMerge(merged, raw);
  delete cfg.upstream; // 已迁移到 sites
  lastIssues = validateConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  // 原子写：config.json 存着 apiKey/站点开关等运行配置，写一半被杀不该留半截文件
  writeJsonFileAtomic(paths.config, cfg);
}

/** 已启用且在册的站点键列表。 */
export function siteKeys(cfg) {
  return Object.keys(cfg.sites || {}).filter((k) => cfg.sites[k]?.enabled !== false);
}

export function getSite(cfg, site) {
  const s = cfg.sites?.[site];
  if (!s) throw Object.assign(new Error(`未知站点：${site}（可用：${siteKeys(cfg).join(', ')}）`), { status: 400 });
  return s;
}

/**
 * 所有有效的 API 密钥。
 * `apiKey` 可以是字符串，也可以是字符串数组；数组形式下每个密钥都同样有效。
 * 空串 / 非字符串 / 全空数组一律返回空数组，调用方据此判断「未配置密钥」。
 */
export function authKeys(cfg) {
  const raw = cfg?.apiKey;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const k of list) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 「主密钥」—— 需要单个密钥的场景用它：本项目的脚本自己发请求时的
 * `Authorization` 头、控制台的掩码展示、启动横幅。
 * 配了多个时取第一个；未配置时返回空串。
 */
export function primaryKey(cfg) {
  return authKeys(cfg)[0] || '';
}
