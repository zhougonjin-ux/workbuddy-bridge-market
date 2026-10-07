// 控制台后端 API：状态总览 / 模型清单 / 一键切换默认模型 / 日志 / 用量 / 探测 / 登录 / 停服
// 仅本机可用（服务只监听 127.0.0.1），鉴权用控制台会话 token 或 config.json 的 apiKey。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, siteKeys, saveConfig, paths, authPathFor, authKeys, primaryKey, NOTIFY_CHANNEL_TYPES } from './config.mjs';
import { getAuth, isLoggedIn, accountSnapshot } from './auth.mjs';
import {
  poolPathFor,
  getAccount,
  removeAccount,
  setAccountEnabled,
  setAccountLabel,
  setAccountManualExpiry,
  resetAccountState,
  markExhausted,
  updateCreditDetail,
} from './pool.mjs';
import { getCatalog, mergedModels } from './router.mjs';
import { queryCredit, supportsCreditQuery } from './upstream.mjs';
import { probeModel, runHealthScan, healthStatus, reloadHealthState } from './health.mjs';
import { startLogin, pollLogin } from './device-login.mjs';
import { usageSnapshot, resetUsage, flushUsage, recordBalance, todayAvgCreditByModel, usageCsv, reloadUsage } from './usage.mjs';
import { recentLogs, recentRequests } from './log.mjs';
import { recentEvents, recordEvent, reloadEvents } from './events.mjs';
import { compressionStats, reloadLearned } from './compress.mjs';
import { sendJson, writeJsonFileAtomic } from './util.mjs';
import { bridgeStatus, setPolicy, refreshCreditsAll } from './scheduler.mjs';
import { runTasks, taskStatus, taskCenterView, runSingleTask, claimSingleTask, startTaskLoop, stopTaskLoop, heatmapView, syncAccountNickname, reloadTasksState } from './tasks.mjs';
import { importLocalAccounts } from './localimport.mjs';
import { budgetStatus, budgetCheckAndAnnounce, accountBudgetCheckAndAnnounce, accountBudgetStatus } from './budget.mjs';
import { backupList, backupNow, startBackupLoop, stopBackupLoop } from './backup.mjs';
import { testChannels } from './notify.mjs';
import { runProtocolCheck, protocolCheckBrief } from './protocol.mjs';
import { weeklyTick } from './weekly.mjs';
import { burnoutReport, predictAccount } from './burnout.mjs';
import { recentDailyCreditAvg } from './usage.mjs';
import { checkForUpdate } from './updatecheck.mjs';
import { runDiagnostics, startDoctorLoop } from './doctor.mjs';
import { flushLearned } from './compress.mjs';
import { flushEvents } from './events.mjs';

const startedAt = Date.now();
const loginStates = new Map(); // site → { state, authUrl, at }

const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 读版本号：优先取插件清单（.zcode-plugin/plugin.json）——那是插件市场里
 * 显示和更新的同一来源；直接跑 server 时退回 server/package.json。
 *
 * 之前只读 package.json，插件升到 0.3.x 后控制台还显示 v0.1.0，
 * 排查问题时对着版本号看会误导。读不到时返回 'unknown' 而不是抛错——
 * 控制台不该因为读不到版本号就打不开。
 */
let cachedVersion = null;
function pkgVersion() {
  if (cachedVersion) return cachedVersion;
  for (const p of [
    path.join(ROOT, '..', '.zcode-plugin', 'plugin.json'),
    path.join(ROOT, 'package.json'),
  ]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.version) { cachedVersion = j.version; break; }
    } catch {
      /* 试下一个来源 */
    }
  }
  cachedVersion ||= 'unknown';
  return cachedVersion;
}

function maskKey(k) {
  if (!k) return '';
  return k.length <= 10 ? '***' : k.slice(0, 6) + '…' + k.slice(-4);
}

async function siteSummary(cfg, site) {
  const a = getAuth(site);
  const s = cfg.sites[site];
  const cat = await getCatalog(cfg, site);
  const accounts = accountSnapshot(site);
  return {
    site,
    label: s.label,
    apiBase: s.apiBase,
    enabled: s.enabled !== false,
    logged_in: isLoggedIn(site),
    uid: a.uid || null,
    nickname: a.nickname || null,
    domain: a.domain || null,
    token_expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
    model_count: cat.models.size,
    catalog_source: cat.source || null,
    catalog_error: cat.error || null,
    // 号池概览：控制台据此显示「3 个账号，2 个可用」
    account_count: accounts.length,
    account_usable: accounts.filter((x) => x.usable).length,
    accounts,
  };
}

/** 探测单个模型是否可用：实现上移到 health.mjs（/probe 与巡检共用同一套逻辑）。 */

/**
 * 收集「(站点, 账号)」对，供 T32 耗尽预测遍历。
 * 只看启用且有批次明细的账号——没刷过积分明细的账号没有批次，预测无意义。
 */
function siteAccountPairs(cfg) {
  const out = [];
  for (const s of siteKeys(cfg)) {
    for (const a of accountSnapshot(s)) {
      if (a.enabled === false) continue;
      if (!Array.isArray(a.creditDetail) || !a.creditDetail.length) continue;
      out.push({ site: s, account: a });
    }
  }
  return out;
}

/**
 * T32：给 /bridge 用的精简版耗尽预测（只回需要上预警条的风险项）。
 * 全量数据走 /burnout，这里每 20 秒轮询一次，必须轻。
 */
function burnoutBrief(cfg) {
  const dailyAvg = recentDailyCreditAvg(7);
  const report = burnoutReport(siteAccountPairs(cfg), { dailyAvg });
  return { dailyAvg: report.dailyAvg, riskCount: report.riskCount, totalWaste: report.totalWaste, risks: report.accounts.filter((a) => a.riskCount > 0).map((a) => ({ site: a.site, id: a.id, label: a.label, totalWaste: a.totalWaste, batches: a.batches.filter((b) => b.burnout.willExpireUnused).map((b) => ({ package: b.package, remain: b.remain, expireAt: b.expireAt, advice: b.burnout.advice, wasteCredits: b.burnout.wasteCredits, daysLeft: b.burnout.daysLeft })) })) };
}

/**
 * T34：顶栏预警阈值的读取与归一。
 * 前端原先把 200 / 7 / 500 写死，现在从 config.alerts 下发；缺项或被改坏时回落到
 * 与旧硬编码相同的默认值，行为不倒退。
 */
const ALERT_DEFAULTS = { lowBalance: 200, expiryDays: 7, expiryMinAmount: 500 };
function alertThresholds(cfg) {
  const a = cfg?.alerts || {};
  const num = (v, d, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  return {
    lowBalance: num(a.lowBalance, ALERT_DEFAULTS.lowBalance, 0),
    expiryDays: num(a.expiryDays, ALERT_DEFAULTS.expiryDays, 1),
    expiryMinAmount: num(a.expiryMinAmount, ALERT_DEFAULTS.expiryMinAmount, 0),
  };
}

/** T32：把预测结果挂到 /pool 返回的账号快照上，账号卡批次行据此显示「预计用不完」。 */
function attachBurnoutToAccounts(cfg, site, accounts, dailyAvg) {
  for (const a of accounts) {
    const p = predictAccount(a, { dailyAvg });
    a.burnout = { dailyAvg: p.dailyAvg, riskCount: p.riskCount, totalWaste: p.totalWaste, batches: p.batches };
    // T63：按账号预算状态挂在账号上，账号卡余额旁显示「今日 N/M」
    a.budget = accountBudgetStatus(cfg, a.id);
  }
  return accounts;
}

export async function handleConsoleApi(ctx) {
  const { cfg, req, res, url } = ctx;
  const p = url.pathname.replace(/^\/console\/api/, '') || '/';
  const method = req.method;

  // ---- 状态总览 ----
  if (p === '/state' && method === 'GET') {
    const sites = [];
    for (const s of siteKeys(cfg)) {
      const info = await siteSummary(cfg, s);
      // 没有配置 billingBase 的站点不走计费接口，
      // 跳过查询而不是报错，前端会显示「—」。
      if (info.logged_in && supportsCreditQuery(cfg, s)) {
        try {
          const credit = await queryCredit(cfg, s);
          info.credit = credit.remain;
          info.credit_detail = credit.detail;
          if (typeof credit.remain === 'number') recordBalance(s, credit.remain);
        } catch (e) {
          info.credit_error = e.message.slice(0, 160);
        }
      }
      sites.push(info);
    }
    return sendJson(res, 200, {
      version: pkgVersion(),
      uptime_ms: Date.now() - startedAt,
      node: process.version,
      platform: process.platform,
      default_site: cfg.defaultSite,
      default_model: cfg.defaultModel,
      api_key_masked: maskKey(primaryKey(cfg)),
      api_key_count: authKeys(cfg).length,
      base_url: `http://${cfg.host}:${cfg.port}/v1`,
      full_url: `http://${cfg.host}:${cfg.port}/v1/chat/completions`,
      sites,
    });
  }

  // ---- workbuddy-bridge：ZCode 接入配置（一键复制用）----
  // 控制台仅本机可达且经会话 token/apiKey 鉴权，与「停服/删账号」同级敏感度，
  // 这里允许读出完整 apiKey 以支持「点一下复制全部接入配置」。
  if (p === '/zcode-config' && method === 'GET') {
    return sendJson(res, 200, {
      base_url: `http://${cfg.host}:${cfg.port}/v1`,
      api_key: primaryKey(cfg),
      model: 'default',
      default_model_hint: cfg.defaultModel,
      note: 'ZCode 里模型 ID 填 default：以后切模型在管理台/会话里做即可，不用再进 ZCode 设置',
    });
  }

  // ---- 模型清单（含 default 虚拟模型） ----
  if (p === '/models' && method === 'GET') {
    const merged = await mergedModels(cfg);
    // 0.3.33：徽标（上游促销，真实计费规则）+ 观测成本（最近一次实际计费）
    // + 模型级限流状态（哪些账号的这个模型正在冷却、何时恢复），模型页展示用。
    const { listAccounts, isModelRateLimited } = await import('./pool.mjs');
    const { observedCostByModel } = await import('./usage.mjs');
    const obs = observedCostByModel();
    const list = merged.map((m) => {
      const observed = obs?.[`${m.site}/${m.id}`] || null;
      const cooling = (listAccounts(m.site) || [])
        .filter((a) => isModelRateLimited(a, m.id))
        .map((a) => ({ id: a.id, label: a.label || a.id, until: a.modelCooldowns?.[m.id]?.until || 0 }))
        .sort((x, y) => x.until - y.until);
      return {
        id: m.id,
        site: m.site,
        name: m.info?.name || m.id,
        credits: m.info?.credits || null,
        multiplier: Number.isFinite(m.mult) ? m.mult : null,
        context: m.info?.contextWindow || null,
        max_output: m.info?.maxTokens || null,
        alias_of: m.aliasOf || null,
        free: m.mult === 0,
        // workbuddy-bridge：能力标记（图片输入/工具调用/推理模式），控制台可视化用
        supportsImages: Boolean(m.info?.supportsImages),
        supportsToolCall: Boolean(m.info?.supportsToolCall),
        supportsReasoning: Boolean(m.info?.supportsReasoning),
        // 0.3.33：促销徽标 / 实测计费 / 限流恢复时间（仅在有时出现，省得前端判空）
        ...(m.info?.badges?.length ? { badges: m.info.badges } : {}),
        ...(observed ? { observed: { credit: observed.credit, at: observed.at, calls: observed.calls } } : {}),
        ...(cooling.length ? { rate_limit: { until: cooling[0].until, accounts: cooling } } : {}),
      };
    });
    // 未登录站点的内置清单也列出来，方便用户知道有哪些可登
    for (const s of siteKeys(cfg)) {
      if (isLoggedIn(s)) continue;
      for (const m of cfg.sites[s].seedModels || []) {
        if (!list.some((x) => x.id === m.id && x.site === s)) {
          list.push({ id: `${s}/${m.id}`, site: s, name: `${m.name}（${s} 未登录）`, credits: null, multiplier: null, pending_login: true });
        }
      }
    }
    return sendJson(res, 200, {
      default_model: cfg.defaultModel,
      default_site: cfg.defaultSite,
      aliases: cfg.modelAliases || {},
      model_routes: cfg.modelRoutes || {},
      data: list,
    });
  }

  // ---- 手动同步上游模型池（0.3.33）：绕过 5 分钟目录缓存强拉各站点，
  // 顺带把最新目录写进 ZCode 选择器。上游目录分钟级闪变，这给用户一个
  // 「立刻对齐」的入口，而不用等下一轮自动采样。 ----
  if (p === '/models/refresh' && method === 'POST') {
    const { getCatalog } = await import('./router.mjs');
    const results = [];
    for (const s of siteKeys(cfg)) {
      if (!isLoggedIn(s)) {
        results.push({ site: s, skipped: true, reason: '未登录' });
        continue;
      }
      try {
        const cat = await getCatalog(cfg, s, { force: true });
        results.push({ site: s, models: cat.models.size, source: cat.source, error: cat.error || null });
      } catch (e) {
        results.push({ site: s, models: 0, error: String(e.message || e).slice(0, 140) });
      }
    }
    let picker = null;
    try {
      const { triggerProviderConfigSyncNow } = await import('./pickersync.mjs');
      picker = await triggerProviderConfigSyncNow();
    } catch (e) {
      picker = { error: String(e.message || e).slice(0, 140) };
    }
    return sendJson(res, 200, { ok: true, results, picker });
  }

  // ---- 一键切换默认模型（Trae 侧只配 model=default） ----
  if (p === '/default-model' && method === 'POST') {
    const body = ctx.body || {};
    const model = String(body.model || '').trim();
    if (!model) return sendJson(res, 400, { error: '缺少 model' });
    // 校验模型确实存在（含别名解析后的目录），防止把任意字符串写成默认模型导致后续请求全部路由失败。
    // 别名本身也是合法的默认模型值（路由层 expandAlias 会解析），不能只对目录 id 校验
    const catalog = await mergedModels(cfg);
    const known = model === 'default' || catalog.some((m) => m.id === model) || (cfg.modelAliases && cfg.modelAliases[model] != null);
    if (!known) return sendJson(res, 400, { error: `未知模型 ${model}（可用：${catalog.slice(0, 8).map((m) => m.id).join('、')}…）` });
    cfg.defaultModel = model;
    if (body.site) cfg.defaultSite = String(body.site);
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, default_model: cfg.defaultModel, default_site: cfg.defaultSite });
  }

  // ---- 站点启停 ----
  if (p === '/site' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (typeof body.enabled === 'boolean') cfg.sites[site].enabled = body.enabled;
    if (body.label) cfg.sites[site].label = String(body.label);
    if (Array.isArray(body.seedModels)) {
      // 只保留 {id,name,contextWindow} 白名单字段：contextWindow 是压缩上限学习的种子数据，剥掉会退化
      cfg.sites[site].seedModels = body.seedModels
        .filter((m) => m && typeof m.id === 'string' && m.id.trim())
        .map((m) => ({
          id: m.id.trim(),
          name: typeof m.name === 'string' && m.name ? m.name : m.id.trim(),
          ...(Number.isFinite(Number(m.contextWindow)) && Number(m.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
        }));
    }
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, site: cfg.sites[site] });
  }

  // ---- 别名管理 ----
  if (p === '/aliases' && method === 'POST') {
    const body = ctx.body || {};
    const aliases = body.aliases;
    if (!isPlainObj(aliases)) return sendJson(res, 400, { error: '缺少 aliases 对象' });
    cfg.modelAliases = aliases;
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, aliases: cfg.modelAliases });
  }

  // ---- 号池：列出某站点所有账号（含各自余额） ----
  if (p === '/pool' && method === 'GET') {
    const site = String(url.searchParams.get('site') || cfg.defaultSite);
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    const withCredit = url.searchParams.get('credit') !== '0';
    const accounts = accountSnapshot(site);
    if (withCredit && supportsCreditQuery(cfg, site)) {
      // 逐个查余额。串行执行——并发打上游容易被限流。
      for (const a of accounts) {
        if (!a.enabled) continue;
        try {
          const c = await queryCredit(cfg, site, a.id);
          a.credit = c.remain;
          a.credit_detail = c.detail;
          if (typeof c.remain === 'number') recordBalance(`${site}/${a.label}`, c.remain);
          // workbuddy-bridge：把含到期时间的明细写进账号池条目，供到期优先调度选号
          updateCreditDetail(site, a.id, c);
          // 余额为 0 且活动仍开启 → 直接标记耗尽，下次请求就会跳过它。
          // 明细为空（上游计费接口偶发返回空列表）时 remain 恒为 0，不能据此判耗尽。
          if (Array.isArray(c.detail) && c.detail.length > 0 && c.remain <= 0) markExhausted(site, a.id, '余额为 0');
        } catch (e) {
          a.credit_error = e.message.slice(0, 160);
        }
      }
    }
    return sendJson(res, 200, { site, accounts: attachBurnoutToAccounts(cfg, site, accounts, recentDailyCreditAvg(7)), supports_credit: supportsCreditQuery(cfg, site) });
  }

  // ---- workbuddy-bridge：调度策略查看/切换 ----
  if (p === '/policy' && method === 'GET') {
    const b = bridgeStatus(cfg);
    return sendJson(res, 200, { policy: b.policy, pinnedAccountId: b.pinnedAccountId, creditRefreshMinutes: b.creditRefreshMinutes });
  }
  if (p === '/policy' && method === 'POST') {
    const body = ctx.body || {};
    const r = setPolicy(cfg, { policy: body.policy, pinnedAccountId: body.pinnedAccountId });
    return sendJson(res, r.ok ? 200 : 400, r);
  }
  if (p === '/bridge' && method === 'GET') {
    // B3：轮询通道（20s 一次）同样脱敏。此前只有 SSE 通道 redact，这个接口每 20 秒
    // 把两个账号的 accessToken/refreshToken 明文发给浏览器——前端对这两个字段零消费
    // （接入页复制的是 apiKey，不是账号 token），直接抹掉不影响任何功能。
    // /backup 保留明文：导出的用途本就是把账号整套搬走。
    const b = bridgeStatus(cfg, { redact: true });
    b.budget = budgetCheckAndAnnounce(cfg); // T13：预警条数据源 + 每天一次的预算提醒
    // T63：按账号预算（每 20s 轮询下发 + 超限每天提醒一次）
    const bAccs = [];
    for (const s of b.sites || []) {
      for (const a of s.accounts || []) {
        if (a.enabled === false) continue;
        bAccs.push({ site: s.site, id: a.id, label: a.label || a.nickname || a.id });
      }
    }
    b.perAccountBudget = accountBudgetCheckAndAnnounce(cfg, bAccs);
    b.burnout = burnoutBrief(cfg); // T32：预警条的「预计用不完」项
    b.alerts = alertThresholds(cfg); // T34：预警阈值（原先写死在前端，现由配置下发）
    return sendJson(res, 200, b);
  }
  if (p === '/credit/refresh' && method === 'POST') {
    const results = await refreshCreditsAll(cfg);
    return sendJson(res, 200, { ok: true, results });
  }

  // ---- T32 积分耗尽预测：全量报告（控制台「积分预测」卡 + /wbp 面板消费）----
  // ?days=7 换统计窗口；?avg= 直接注入日均消耗（便于对比不同速率下的预测）。
  if (p === '/burnout' && method === 'GET') {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
    const avgRaw = url.searchParams.get('avg');
    const avg = avgRaw === null ? null : Math.max(0, Number(avgRaw) || 0);
    return sendJson(res, 200, burnoutReport(siteAccountPairs(cfg), { dailyAvg: avg, days }));
  }

  // ---- workbuddy-bridge：自动任务（签到/成长任务）----
  if (p === '/tasks' && method === 'GET') {
    return sendJson(res, 200, taskStatus());
  }
  if (p === '/tasks/run' && method === 'POST') {
    const body = ctx.body || {};
    const kind = ['checkin', 'growth', 'travel', 'streak', 'all'].includes(body.kind) ? body.kind : 'all';
    const site = body.site ? String(body.site) : null;
    const results = await runTasks(cfg, kind, site);
    return sendJson(res, 200, { ok: true, kind, results });
  }

  // 保存自动任务设置：精确时点（"HH:MM" 逗号分隔，空串=回退到旧的小时数组）、
  // 对话体验类任务代打开关与单任务代打上限。立即落盘 config.json（调度循环热读取）。
  // T42：新增 enabled/checkin/growth 三个开关（大屏与任务页可切）。
  //   时点类字段只在请求体里带了才更新——开关类操作是单字段 POST，
  //   若沿袭「没带就置空」的旧语义，切个开关会把时点配置一并清掉。
  if (p === '/tasks/config' && method === 'POST') {
    const body = ctx.body || {};
    const enabledBefore = cfg.tasks.enabled !== false;
    const parseTimes = (v) => String(v ?? '')
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.padStart(5, '0'));
    const norm = {
      checkinTimes: body.checkinTimes !== undefined ? parseTimes(body.checkinTimes) : null,
      growthTimes: body.growthTimes !== undefined ? parseTimes(body.growthTimes) : null,
      travelTimes: body.travelTimes !== undefined ? parseTimes(body.travelTimes) : null,
      listTimes: body.listTimes !== undefined ? parseTimes(body.listTimes) : null,
      doctorTimes: body.doctorTimes !== undefined ? parseTimes(body.doctorTimes) : null,
    };
    for (const [k, arr] of Object.entries(norm)) {
      if (arr === null) continue;
      if (arr.some((s) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(s))) {
        return sendJson(res, 400, { ok: false, error: `${k} 里有非法时点（应为 HH:MM，如 09:30）：${arr.join(',')}` });
      }
      cfg.tasks[k] = arr;
    }
    for (const k of ['enabled', 'checkin', 'growth']) {
      if (typeof body[k] === 'boolean') cfg.tasks[k] = body[k];
    }
    if (body.travelLocationId !== undefined) {
      const loc = Number(body.travelLocationId);
      if (!Number.isInteger(loc) || loc < 1 || loc > 99) return sendJson(res, 400, { ok: false, error: 'travelLocationId 须为 1-99 整数' });
      cfg.tasks.travelLocationId = loc;
    }
    if (typeof body.autoComplete === 'boolean') cfg.tasks.autoComplete = body.autoComplete;
    if (body.maxChatsPerTask !== undefined) {
      const n = Number(body.maxChatsPerTask);
      if (!Number.isInteger(n) || n < 1 || n > 20) return sendJson(res, 400, { ok: false, error: 'maxChatsPerTask 须为 1-20 整数' });
      cfg.tasks.maxChatsPerTask = n;
    }
    saveConfig(cfg);
    // T42：总开关热生效。startTaskLoop 只在启动时判断一次 enabled（之后每分钟 tick 现读
    // checkin/growth 分类开关，分类开关天然热生效），所以只有总开关真的变了才停/起循环——
    // 每次保存都重启会把循环闭包里「今天已触发/巡逻防抖」的记忆清零。
    if (enabledBefore !== (cfg.tasks.enabled !== false)) {
      stopTaskLoop();
      if (cfg.tasks.enabled !== false) startTaskLoop(cfg);
    }
    // T67：doctorTimes 从 [] 改回非空时补挂体检循环（幂等；tick 内每分钟现读时点，
    // 其余改动天然热生效；时点非空时启动循环、空数组由 tick 判 disabled）
    if (body.doctorTimes !== undefined) startDoctorLoop(cfg);
    return sendJson(res, 200, {
      ok: true,
      saved: {
        enabled: cfg.tasks.enabled,
        checkin: cfg.tasks.checkin,
        growth: cfg.tasks.growth,
        checkinTimes: cfg.tasks.checkinTimes,
        growthTimes: cfg.tasks.growthTimes,
        travelTimes: cfg.tasks.travelTimes,
        listTimes: cfg.tasks.listTimes,
        doctorTimes: cfg.tasks.doctorTimes,
        autoComplete: cfg.tasks.autoComplete,
        maxChatsPerTask: cfg.tasks.maxChatsPerTask,
      },
    });
  }

  // ---- workbuddy-bridge：成长任务中心（T14）----
  // 任务列表视图：默认读缓存（每日 listTimes 自动预取 + 打开页面 TTL 过期才拉），
  // ?refresh=1 强制实时拉取（手动刷新按钮/代打领奖后）。响应带 cachedAt/fromCache 供前端标注数据时间。
  if (p === '/task-center' && method === 'GET') {
    const site = String(url.searchParams.get('site') || cfg.defaultSite);
    const accountId = String(url.searchParams.get('accountId') || '');
    const force = url.searchParams.get('refresh') === '1';
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (!accountId) return sendJson(res, 400, { error: '缺少 accountId' });
    if (!getAccount(site, accountId)) return sendJson(res, 404, { error: `账号不存在：${accountId}` });
    try {
      const v = await taskCenterView(cfg, site, accountId, { force });
      return sendJson(res, 200, {
        ok: true, site, accountId, tasks: v.tasks,
        cachedAt: v.cachedAt, fromCache: v.fromCache, listTimes: cfg.tasks?.listTimes || [],
      });
    } catch (e) {
      return sendJson(res, 502, { error: `拉取任务列表失败：${String(e.message || e).slice(0, 160)}` });
    }
  }
  // 单任务手动代打（body: { site?, accountId, code, times? }）
  if (p === '/task-center/play' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    const accountId = String(body.accountId || '');
    const code = String(body.code || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (!getAccount(site, accountId)) return sendJson(res, 404, { error: `账号不存在：${accountId}` });
    if (!code) return sendJson(res, 400, { error: '缺少 code' });
    try {
      const n = body.times != null ? Number(body.times) : null;
      if (n != null && !Number.isFinite(n)) return sendJson(res, 400, { error: 'times 必须是数字' });
      const r = await runSingleTask(cfg, site, accountId, code, { times: n });
      return sendJson(res, 200, r);
    } catch (e) {
      // 参数错误（400）不该被映射成 502「上游故障」，那会把排障方向带偏
      return sendJson(res, e.status === 404 ? 404 : e.status === 400 ? 400 : 502, { error: String(e.message || e).slice(0, 160) });
    }
  }
  // 单任务领奖（body: { site?, accountId, code }）
  if (p === '/task-center/claim' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    const accountId = String(body.accountId || '');
    const code = String(body.code || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (!getAccount(site, accountId)) return sendJson(res, 404, { error: `账号不存在：${accountId}` });
    if (!code) return sendJson(res, 400, { error: '缺少 code' });
    try {
      const r = await claimSingleTask(cfg, site, accountId, code);
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e).slice(0, 160) });
    }
  }

  // ---- T52：官方打卡热力图（权威全历史，从账号注册日起算；6h 服务端缓存）----
  // ?refresh=1 强拉；与本地 checkinDays 日历（插件启用日起算）并存，前端注明口径差异。
  if (p === '/heatmap' && method === 'GET') {
    const site = String(url.searchParams.get('site') || cfg.defaultSite);
    const accountId = String(url.searchParams.get('accountId') || '');
    const force = url.searchParams.get('refresh') === '1';
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (!accountId) return sendJson(res, 400, { error: '缺少 accountId' });
    if (!getAccount(site, accountId)) return sendJson(res, 404, { error: `账号不存在：${accountId}` });
    try {
      const v = await heatmapView(cfg, site, accountId, { force });
      return sendJson(res, 200, { ok: true, site, accountId, cells: v.cells, cachedAt: v.cachedAt, fromCache: v.fromCache });
    } catch (e) {
      return sendJson(res, 502, { error: `拉取热力图失败：${String(e.message || e).slice(0, 160)}` });
    }
  }

  // ---- T53：账号昵称同步（只在用户手动点「同步昵称」时调用，绝不进定时轮询）----
  // 上游响应含手机号等敏感字段，服务端只解析 uid/nickname 两个字段（见 tasks.mjs），
  // uid 与池内账号不一致直接报错防串号。
  if (p === '/sync-nickname' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    // 前端账号卡按钮统一带 data-id，这里 id/accountId 都认（与 /pool/account、/task-center 两种形参对齐）
    const accountId = String(body.accountId || body.id || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (!getAccount(site, accountId)) return sendJson(res, 404, { error: `账号不存在：${accountId}` });
    try {
      const r = await syncAccountNickname(cfg, site, accountId);
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, e.status === 404 ? 404 : 502, { error: String(e.message || e).slice(0, 160) });
    }
  }

  // ---- T58：数据自动备份（列表 / 立即备份 / 配置 enabled/times/keep）----
  if (p === '/backups' && method === 'GET') {
    return sendJson(res, 200, { ok: true, config: cfg.backup, list: backupList(), state: (() => { try { return JSON.parse(fs.readFileSync(path.join(paths.root, 'backup-state.json'), 'utf8')); } catch { return {}; } })() });
  }
  if (p === '/backups/run' && method === 'POST') {
    try {
      const r = backupNow(cfg);
      return sendJson(res, 200, { ok: true, ...r, message: `已备份 ${r.files} 个文件到 ${path.basename(r.file)}（滚动保留 ${r.kept} 份）` });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e.message || e).slice(0, 160) });
    }
  }
  if (p === '/backups/config' && method === 'POST') {
    const body = ctx.body || {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
      cfg.backup.enabled = body.enabled;
    }
    if (body.times !== undefined) {
      const times = String(body.times ?? '')
        .split(/[,，;；\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.padStart(5, '0'));
      if (times.some((s) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(s))) {
        return sendJson(res, 400, { ok: false, error: `times 里有非法时点（应为 HH:MM，如 09:00）：${times.join(',')}` });
      }
      cfg.backup.times = times;
    }
    if (body.keep !== undefined) {
      const n = Number(body.keep);
      if (!Number.isInteger(n) || n < 1 || n > 52) return sendJson(res, 400, { ok: false, error: 'keep 必须是 1-52 的整数' });
      cfg.backup.keep = n;
    }
    saveConfig(cfg);
    // 启动时 disabled 的备份循环从未建过定时器，这里必须重启循环，控制台里的开关才真正生效
    stopBackupLoop();
    startBackupLoop(cfg);
    return sendJson(res, 200, { ok: true, config: cfg.backup });
  }

  // ---- T46：用量周报（状态/预览 + 手动生成一次并推送）----
  if (p === '/weekly' && method === 'GET') {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(path.join(paths.root, 'weekly.json'), 'utf8')); } catch { /* 没发过 */ }
    return sendJson(res, 200, { ok: true, config: cfg.weekly, state });
  }
  if (p === '/weekly/run' && method === 'POST') {
    const r = await weeklyTick(cfg, new Date(), { force: true });
    if (r.skipped) return sendJson(res, 200, { ok: false, skipped: r.skipped });
    return sendJson(res, 200, { ok: true, summary: r.summary, text: r.text });
  }

  // ---- workbuddy-bridge：导入本机已登录客户端的账号 ----
  if (p === '/local/import' && method === 'POST') {
    const result = await importLocalAccounts(cfg);
    return sendJson(res, 200, { ok: true, ...result });
  }

  // 手动同步模型池进 ZCode 选择器（模型页「手动同步」按钮；自动循环 30 分钟一次，这里立即触发）
  if (p === '/pool-sync' && method === 'POST') {
    const { triggerProviderConfigSyncNow } = await import('./pickersync.mjs');
    const r = await triggerProviderConfigSyncNow();
    if (r.result === 'busy') return sendJson(res, 409, { ok: false, message: '上一次同步还在进行中，稍后再试' });
    return sendJson(res, 200, { ok: true, result: r.result, models: r.models });
  }

  // 最近请求的结构化记录（/wbp 面板与控制台「用量」页显示 tok/s 用；agent 带 apiKey 即可调）。
  // T9：对照「该模型今日平均单次消耗」标注异常——单次 > 均值 ×5 且 ≥1 积分才算
  // （低倍率模型 0.0x 积分的自然波动不标；无基线/无 credit 的请求不标）。
  if (p === '/recent-requests' && method === 'GET') {
    const avg = todayAvgCreditByModel();
    const requests = recentRequests(50).map((r) => {
      const base = r.credit != null ? avg[`${r.site}/${r.model}`] : null;
      if (base != null && base > 0 && r.credit > base * 5 && r.credit >= 1) {
        return { ...r, creditAvg: Math.round(base * 100) / 100, anomaly: true };
      }
      return r;
    });
    return sendJson(res, 200, { ok: true, requests });
  }

  // 事件时间线（T6）：系统/任务/账号/策略等结构化事件的统一视图，前端过滤 kind
  if (p === '/events' && method === 'GET') {
    // 缺参 ≠ 0：Number(null)===0，直接 clamp 会把缺省 300 钳成 1（回归过一次）
    const raw = url.searchParams.get('limit');
    const n = raw == null || raw === '' ? NaN : Number(raw);
    const limit = Math.min(300, Math.max(1, Number.isFinite(n) ? Math.trunc(n) : 300));
    return sendJson(res, 200, { ok: true, events: recentEvents({ limit }) });
  }

  // 上下文压缩统计（T10）：累计总量 + 最近事件
  if (p === '/compressions' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...compressionStats() });
  }

  // ---- T39：协议漂移自检（只读探针端点，不消耗积分）----
  if (p === '/protocol' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...protocolCheckBrief(cfg) });
  }
  if (p === '/protocol/check' && method === 'POST') {
    const r = await runProtocolCheck(cfg, { force: true });
    return sendJson(res, 200, { ok: true, ...r });
  }

  // 模型健康巡检（T8）：查结果 / 手动跑一轮（同步，模型多时需等 10~30 秒）/ 保存定时设置
  if (p === '/health' && method === 'GET') {
    return sendJson(res, 200, healthStatus(cfg));
  }
  if (p === '/health/scan' && method === 'POST') {
    const r = await runHealthScan(cfg);
    return sendJson(res, r.ok ? 200 : 409, r);
  }
  if (p === '/health/config' && method === 'POST') {
    const body = ctx.body || {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
      cfg.healthCheck.enabled = body.enabled;
    }
    if (body.times !== undefined) {
      const times = String(body.times ?? '')
        .split(/[,，;；\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.padStart(5, '0'));
      if (times.some((s) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(s))) {
        return sendJson(res, 400, { ok: false, error: `times 里有非法时点（应为 HH:MM，如 08:00）：${times.join(',')}` });
      }
      cfg.healthCheck.times = times;
    }
    // T35 省钱模式：只巡检白名单模型 / 只巡检免费模型
    if (body.only !== undefined) {
      const list = Array.isArray(body.only)
        ? body.only
        : String(body.only ?? '').split(/[,，;；\s]+/);
      if (!list.every((s) => typeof s === 'string')) {
        return sendJson(res, 400, { ok: false, error: 'only 必须是模型名数组或逗号分隔的字符串' });
      }
      cfg.healthCheck.only = list.map((s) => s.trim()).filter(Boolean);
    }
    if (body.onlyFree !== undefined) {
      if (typeof body.onlyFree !== 'boolean') return sendJson(res, 400, { ok: false, error: 'onlyFree 必须是布尔值' });
      cfg.healthCheck.onlyFree = body.onlyFree;
    }
    saveConfig(cfg);
    // 定时开关/时点立即生效：先停旧循环再按新配置启动（startHealthLoop 对重复调用幂等）
    const { stopHealthLoop, startHealthLoop } = await import('./health.mjs');
    stopHealthLoop();
    startHealthLoop(cfg);
    return sendJson(res, 200, { ok: true, config: healthStatus(cfg).config });
  }

  // ---- workbuddy-bridge：每日积分预算（T13）----
  if (p === '/budget' && method === 'GET') {
    return sendJson(res, 200, budgetStatus(cfg));
  }
  if (p === '/budget' && method === 'POST') {
    const body = ctx.body || {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
      cfg.budget.enabled = body.enabled;
    }
    if (body.dailyCredits !== undefined) {
      const n = Number(body.dailyCredits);
      if (!Number.isFinite(n) || n <= 0) return sendJson(res, 400, { ok: false, error: 'dailyCredits 必须是正数' });
      cfg.budget.dailyCredits = n;
    }
    if (body.warnPercent !== undefined) {
      const n = Number(body.warnPercent);
      if (!Number.isFinite(n) || n <= 0 || n >= 100) return sendJson(res, 400, { ok: false, error: 'warnPercent 必须是 (0,100) 之间的数' });
      cfg.budget.warnPercent = n;
    }
    if (body.mode !== undefined) {
      if (!['warn', 'free', 'pause'].includes(body.mode)) return sendJson(res, 400, { ok: false, error: 'mode 必须是 warn/free/pause' });
      cfg.budget.mode = body.mode;
    }
    // T63 按账号预算：{ accountId: 每日积分 }，整包替换（前端每次提交全量）；非法值剔除
    if (body.accounts !== undefined) {
      if (!isPlainObj(body.accounts)) return sendJson(res, 400, { ok: false, error: 'accounts 必须是对象（accountId → 每日积分）' });
      const kept = {};
      for (const [k, v] of Object.entries(body.accounts)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) kept[k] = n;
      }
      cfg.budget.accounts = kept;
    }
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, budget: budgetStatus(cfg) });
  }

  // ---- T34：顶栏预警阈值 ----
  if (p === '/alerts' && method === 'GET') {
    return sendJson(res, 200, { ok: true, alerts: alertThresholds(cfg) });
  }
  if (p === '/alerts' && method === 'POST') {
    const body = ctx.body || {};
    if (body.lowBalance !== undefined) {
      const n = Number(body.lowBalance);
      if (!Number.isFinite(n) || n < 0) return sendJson(res, 400, { ok: false, error: 'lowBalance 必须是 ≥0 的数（积分）' });
      cfg.alerts.lowBalance = n;
    }
    if (body.expiryDays !== undefined) {
      const n = Number(body.expiryDays);
      if (!Number.isFinite(n) || n < 1) return sendJson(res, 400, { ok: false, error: 'expiryDays 必须是 ≥1 的整数（天）' });
      cfg.alerts.expiryDays = Math.round(n);
    }
    if (body.expiryMinAmount !== undefined) {
      const n = Number(body.expiryMinAmount);
      if (!Number.isFinite(n) || n < 0) return sendJson(res, 400, { ok: false, error: 'expiryMinAmount 必须是 ≥0 的数（积分）' });
      cfg.alerts.expiryMinAmount = n;
    }
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, alerts: alertThresholds(cfg) });
  }

  // ---- T33：通知通道配置 + 测试 ----
  // 回显时把 url 的密钥段打码：Server酱 SendKey / Bark 设备 key 都在 url 里，
  // 控制台是本机页面但日志/截图都可能流出去，展示时只留头尾。
  const maskChannelUrl = (u) => {
    const s = String(u || '');
    return s.length <= 16 ? s : `${s.slice(0, 10)}…${s.slice(-4)}`;
  };
  if (p === '/notify' && method === 'GET') {
    const n = cfg.notify || {};
    return sendJson(res, 200, {
      ok: true,
      enabled: n.enabled !== false,
      channels: (n.channels || []).map((c) => ({ ...c, url: maskChannelUrl(c.url) })),
    });
  }
  if (p === '/notify' && method === 'POST') {
    const body = ctx.body || {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
      cfg.notify.enabled = body.enabled;
    }
    if (body.channels !== undefined) {
      if (!Array.isArray(body.channels)) return sendJson(res, 400, { ok: false, error: 'channels 必须是数组' });
      const kept = [];
      for (const c of body.channels) {
        const type = String(c?.type || '').trim();
        if (!NOTIFY_CHANNEL_TYPES.includes(type)) {
          return sendJson(res, 400, { ok: false, error: `未知通道类型 ${type || '(空)'}，只支持 webhook/bark/serverchan` });
        }
        // 前端回显的是打码值；打码值原样回传视为「没改这个字段」，保留原 url
        const url = String(c?.url || '').trim();
        if (!url) return sendJson(res, 400, { ok: false, error: `${type} 通道缺少 url` });
        kept.push({ type, url, enabled: c.enabled !== false });
      }
      cfg.notify.channels = kept;
    }
    saveConfig(cfg);
    return sendJson(res, 200, {
      ok: true,
      enabled: cfg.notify.enabled !== false,
      channels: (cfg.notify.channels || []).map((c) => ({ ...c, url: maskChannelUrl(c.url) })),
    });
  }
  if (p === '/notify/test' && method === 'POST') {
    // 等每个通道的真实投递结果再回（原先只数"发起了几个"，投递失败也报成功 ——
    // 用户等不到手机推送，只当通道配错了）。超时上限由 deliver 的 10s 兜底。
    const r = await testChannels(cfg);
    if (!r.total) {
      return sendJson(res, 200, { ok: false, sent: 0, total: 0, results: [], note: '没有已启用的通道——先添加一个并保存' });
    }
    const failed = r.results.filter((x) => !x.ok);
    const note = failed.length
      ? `失败 ${failed.length}/${r.total}：${failed.map((f) => `${f.type} — ${f.error}`).join('；')}`
      : `全部 ${r.total} 个通道投递成功，去手机上看看`;
    return sendJson(res, 200, { ok: failed.length === 0, sent: r.ok, total: r.total, results: r.results, note });
  }

  // ---- 号池：启用/禁用、重置状态、删除、改标签 ----
  if (p === '/pool/account' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    const id = String(body.id || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (!getAccount(site, id)) return sendJson(res, 404, { error: `账号不存在：${id}` });

    if (typeof body.enabled === 'boolean') setAccountEnabled(site, id, body.enabled);
    if (body.reset) resetAccountState(site, id);
    if (typeof body.label === 'string' && body.label.trim()) setAccountLabel(site, id, body.label.trim());
    if (body.manualExpireAt !== undefined) setAccountManualExpiry(site, id, body.manualExpireAt);
    return sendJson(res, 200, { ok: true, account: accountSnapshot(site).find((a) => a.id === id) || null });
  }

  if (p === '/pool/account/remove' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    const id = String(body.id || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    const ok = removeAccount(site, id);
    if (!ok) return sendJson(res, 404, { error: `账号不存在：${id}` });
    return sendJson(res, 200, { ok: true, remaining: accountSnapshot(site).length });
  }

  // ---- 日志 ----
  if (p === '/logs' && method === 'GET') {
    const n = Number(url.searchParams.get('after'));
    const after = Number.isFinite(n) ? n : 0;
    return sendJson(res, 200, recentLogs(after));
  }

  // ---- 用量统计 ----
  if (p === '/usage' && method === 'GET') {
    const raw = url.searchParams.get('days'); // 缺参 ≠ 0（Number(null)===0 的坑，见 /events）
    const n = raw == null || raw === '' ? NaN : Number(raw);
    const days = Math.min(365, Math.max(1, Number.isFinite(n) ? Math.trunc(n) : 7));
    return sendJson(res, 200, usageSnapshot(days));
  }
  if (p === '/usage/reset' && method === 'POST') {
    resetUsage();
    return sendJson(res, 200, { ok: true });
  }
  // ---- T36：用量报表导出 CSV（浏览器直接下载，Content-Disposition 触发保存）----
  if (p === '/usage/export' && method === 'GET') {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 7));
    // 账号维度用用户自己起的名字（accountSnapshot 已做白名单投影，不含 token）
    const names = new Map();
    for (const s of siteKeys(cfg)) {
      for (const a of accountSnapshot(s)) names.set(`${s}/${a.id}`, a.label || a.nickname || a.id);
    }
    const csv = usageCsv(days, { accountLabel: (site, id) => names.get(`${site}/${id}`) });
    const fname = `workbuddy-usage-${new Date().toISOString().slice(0, 10)}-${days}d.csv`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  // ---- 模型探测（顺序执行，避免打爆上游） ----
  if (p === '/probe' && method === 'POST') {
    const body = ctx.body || {};
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, 60) : [];
    const results = [];
    for (const t of targets) {
      const site = String(t.site || cfg.defaultSite);
      const model = String(t.model || '');
      if (!model || !cfg.sites[site]) continue;
      results.push(await probeModel(cfg, site, model));
      await new Promise((r) => setTimeout(r, 250));
    }
    return sendJson(res, 200, { ok: true, count: results.length, results });
  }

  // ---- 账号登录（设备授权） ----
  if (p === '/login/start' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    const r = await startLogin(cfg, site);
    loginStates.set(site, { ...r, label: body.label ? String(body.label).slice(0, 40) : null });
    return sendJson(res, 200, r);
  }

  if (p === '/login/poll' && method === 'GET') {
    const site = String(url.searchParams.get('site') || cfg.defaultSite);
    const st = loginStates.get(site);
    if (!st) return sendJson(res, 400, { error: '请先点击「开始登录」' });
    const r = await pollLogin(cfg, site, st.state, { label: st.label || null });
    if (r.done) {
      loginStates.delete(site);
      return sendJson(res, 200, {
        done: true,
        account_id: r.auth.id,
        label: r.auth.label,
        uid: r.auth.uid,
        nickname: r.auth.nickname,
        expires_at: r.auth.expiresAt,
        account_count: accountSnapshot(site).length,
      });
    }
    return sendJson(res, 200, { done: false, msg: r.msg });
  }

  /**
   * 登出。带 id 时只删该账号；不带 id 时——为兼容旧行为——删掉该站点账号池，
   * 但保留账号记录（置为未登录）会更让人困惑，所以这里明确按「删账号」处理。
   */
  if (p === '/login/logout' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    const id = body.id ? String(body.id) : null;
    if (id) {
      if (!getAccount(site, id)) return sendJson(res, 404, { error: `账号不存在：${id}` });
      removeAccount(site, id);
      return sendJson(res, 200, { ok: true, site, removed: id, remaining: accountSnapshot(site).length });
    }
    // 没指定账号 → 清空整个站点（旧版语义）
    try {
      fs.rmSync(poolPathFor(site), { force: true });
      fs.rmSync(authPathFor(site), { force: true });
      if (site === 'cn-cli') fs.rmSync(paths.legacyAuth, { force: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
    return sendJson(res, 200, { ok: true, site, remaining: 0 });
  }

  // ---- T18：多 apiKey 管理（列表 / 新增 / 删除）----
  // 注意 apiKey 是数组或字符串两种形态，统一走 authKeys() 规范化成数组再操作，
  // 保存时永远写回数组（loadConfig 对数组形态有校验，字符串形态只是向后兼容）。
  if (p === '/keys' && method === 'GET') {
    const keys = authKeys(cfg);
    return sendJson(res, 200, { ok: true, keys: keys.map((k, i) => ({ index: i, masked: maskKey(k), isPrimary: i === 0, hint: k === primaryKey(cfg) ? '控制台复制接入配置时显示的就是这把' : '' })) });
  }
  if (p === '/keys/add' && method === 'POST') {
    const body = ctx.body || {};
    // 不带 key 时自动生成一把（控制台「添加 Key」按钮的默认路径）
    const raw = String(body.key || '').trim() || 'sk-wb-' + crypto.randomBytes(12).toString('hex');
    if (!/^sk-wb-/.test(raw)) return sendJson(res, 400, { error: 'key 须以 sk-wb- 开头（与本服务密钥风格一致，防手粘错别的服务的 key）' });
    const keys = authKeys(cfg);
    if (keys.includes(raw)) return sendJson(res, 409, { error: '该 key 已存在' });
    keys.push(raw);
    cfg.apiKey = keys;
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, count: keys.length, masked: maskKey(raw), key: raw, generated: !body.key });
  }
  if (p === '/keys/remove' && method === 'POST') {
    const body = ctx.body || {};
    const raw = String(body.key || '').trim();
    const keys = authKeys(cfg);
    if (raw === primaryKey(cfg)) return sendJson(res, 400, { error: '主密钥不能删除（它出现在接入配置里）；要换主密钥请先删到只剩它之外的 key 再手动调整顺序，或直接改 config.json' });
    const next = keys.filter((k) => k !== raw);
    if (next.length === keys.length) return sendJson(res, 404, { error: 'key 不存在' });
    if (!next.length) return sendJson(res, 400, { error: '不能删掉最后一把 key（删了服务就不做鉴权了）' });
    cfg.apiKey = next;
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, count: next.length });
  }

  // ---- T19：路由规则（别名 + 模型→站点钉死路由 + 全局白/黑名单）----
  if (p === '/routes' && method === 'GET') {
    const m = await mergedModels(cfg);
    return sendJson(res, 200, {
      aliases: cfg.modelAliases || {},
      routes: cfg.modelRoutes || {},
      allowModels: cfg.allowModels || [],
      excludeModels: cfg.excludeModels || [],
      models: m.map((x) => ({ id: x.id, site: x.site, aliasOf: x.aliasOf || null })),
    });
  }
  if (p === '/routes' && method === 'POST') {
    const body = ctx.body || {};
    // 每个子项独立合并：前端一次只改一块，也允许整包提交
    if (body.aliases !== undefined) {
      if (!isPlainObj(body.aliases)) return sendJson(res, 400, { error: 'aliases 必须是对象（别名 → 模型 或 站点/模型）' });
      for (const [k, v] of Object.entries(body.aliases)) {
        if (!k.trim() || typeof v !== 'string' || !v.trim()) return sendJson(res, 400, { error: `别名 ${k} 的键值都不能为空` });
      }
      cfg.modelAliases = body.aliases;
    }
    if (body.routes !== undefined) {
      if (!isPlainObj(body.routes)) return sendJson(res, 400, { error: 'routes 必须是对象（模型 → 站点）' });
      for (const [k, v] of Object.entries(body.routes)) {
        if (!k.trim() || !cfg.sites[v]) return sendJson(res, 400, { error: `路由 ${k} 指向的站点 "${v}" 不存在或未启用` });
      }
      cfg.modelRoutes = body.routes;
    }
    for (const field of ['allowModels', 'excludeModels']) {
      if (body[field] !== undefined) {
        if (!Array.isArray(body[field]) || body[field].some((s) => typeof s !== 'string')) {
          return sendJson(res, 400, { error: `${field} 必须是字符串数组（支持 * 通配符）` });
        }
        cfg[field] = body[field].map((s) => s.trim()).filter(Boolean);
      }
    }
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, aliases: cfg.modelAliases, routes: cfg.modelRoutes, allowModels: cfg.allowModels, excludeModels: cfg.excludeModels });
  }

  // ---- T19：模型清单过滤（白/黑名单预览：保存前看看哪些模型会被剔除）----
  if (p === '/models-filter' && method === 'POST') {
    const body = ctx.body || {};
    const patch = {};
    for (const field of ['allowModels', 'excludeModels']) {
      if (Array.isArray(body[field])) patch[field] = body[field];
    }
    const { isExcluded } = await import('./router.mjs');
    const trial = { ...cfg, ...patch };
    const m = await mergedModels(cfg);
    const rows = m.map((x) => ({ id: x.id, site: x.site, kept: !isExcluded(trial, x.site, x.id) }));
    return sendJson(res, 200, { ok: true, total: rows.length, kept: rows.filter((r) => r.kept).length, rows });
  }

  // ---- T20：按时段路由 ----
  if (p === '/schedule-router' && method === 'GET') {
    return sendJson(res, 200, { ok: true, scheduleRouter: cfg.scheduleRouter, defaultModel: cfg.defaultModel });
  }
  if (p === '/schedule-router' && method === 'POST') {
    const body = ctx.body || {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
      cfg.scheduleRouter.enabled = body.enabled;
    }
    const parseTimes = (v) => String(v ?? '').trim().padStart(5, '0');
    for (const [k, key] of [['dayStart', 'dayStart'], ['nightStart', 'nightStart']]) {
      if (body[k] !== undefined) {
        const v = parseTimes(body[k]);
        if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) return sendJson(res, 400, { ok: false, error: `${k} 必须是 HH:MM` });
        cfg.scheduleRouter[k] = v;
      }
    }
    for (const k of ['dayModel', 'nightModel']) {
      if (body[k] !== undefined) {
        if (typeof body[k] !== 'string') return sendJson(res, 400, { ok: false, error: `${k} 必须是字符串（留空表示该时段不改道）` });
        cfg.scheduleRouter[k] = body[k].trim();
      }
    }
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, scheduleRouter: cfg.scheduleRouter });
  }

  // ---- T21：配置备份导出/导入（config + 账号池 + learned/usage/tasks/events/health）----
  // 凭证敏感（pool 里是上游 token），所以本接口与 /zcode-config 同级：仅本机 + 鉴权后才可调。
  if (p === '/backup' && method === 'GET') {
    const files = {};
    const want = ['config.json', 'learned.json', 'usage.json', 'tasks-state.json', 'events.json', 'health.json'];
    for (const name of want) {
      try {
        const f = path.join(paths.root, name);
        if (fs.existsSync(f)) files[name] = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch { /* 单个文件坏了跳过，别拖垮整个备份 */ }
    }
    // 账号池：auth.<site>.pool.json
    for (const site of siteKeys(cfg)) {
      try {
        const f = poolPathFor(site);
        if (fs.existsSync(f)) files[`auth.${site}.pool.json`] = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch { /* 同上 */ }
    }
    return sendJson(res, 200, {
      ok: true,
      version: 1,
      exportedAt: new Date().toISOString(),
      pluginVersion: pkgVersion(),
      files,
    });
  }
  if (p === '/backup/restore' && method === 'POST') {
    const body = ctx.body || {};
    const files = body.files;
    if (!isPlainObj(files) || !Object.keys(files).length) return sendJson(res, 400, { error: '缺少 files 对象（用 /backup 的返回体原样 POST 回来即可）' });
    const known = new Set(['config.json', 'learned.json', 'usage.json', 'tasks-state.json', 'events.json', 'health.json']);
    for (const site of siteKeys(cfg)) known.add(`auth.${site}.pool.json`);
    const accepted = [], skipped = [];
    for (const [name, val] of Object.entries(files)) {
      if (!known.has(name)) { skipped.push(name); continue; }
      if (val === null || typeof val !== 'object') { skipped.push(name); continue; }
      try {
        const f = name.startsWith('auth.') ? poolPathFor(name.replace(/^auth\.(.*)\.pool\.json$/, '$1')) : path.join(paths.root, name);
        // usage/events/learned 是模块级内存态 + 防抖回写，恢复顺序必须是：
        // ① flush 把内存态落盘（.prestore 副本才有恢复前的完整数据）→
        // ② 拷 .prestore 备份 → ③ 写入恢复内容 → ④ reload 强制重读。
        // 顺序错了 flush 会把刚写进去的恢复内容用旧内存态原样盖掉（假生效）。
        if (name === 'usage.json') flushUsage();
        else if (name === 'events.json') flushEvents();
        else if (name === 'learned.json') flushLearned();
        if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.prestore-${Date.now()}`);
        writeJsonFileAtomic(f, val, { mode: name.startsWith('auth.') ? 0o600 : undefined });
        accepted.push(name);
        if (name === 'usage.json') reloadUsage();
        else if (name === 'events.json') reloadEvents();
        else if (name === 'learned.json') reloadLearned();
        else if (name === 'tasks-state.json') reloadTasksState();
        else if (name === 'health.json') reloadHealthState();
      } catch (e) {
        skipped.push(`${name}（${String(e.message || e).slice(0, 60)}）`);
      }
    }
    return sendJson(res, 200, { ok: accepted.length > 0, accepted, skipped, note: '恢复的 config.json 需重启服务生效（下方「重启服务」按钮）；账号池与统计类文件已即时重载生效' });
  }

  // ---- T22：插件自更新检查 ----
  if (p === '/update-check' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...(await checkForUpdate()) });
  }

  // ---- 交棒重启（T21 恢复 config 后用；与 /admin/restart 同一条安全路径）----
  if (p === '/service/restart' && method === 'POST') {
    const { requestRestart } = await import('./lifecycle.mjs');
    try {
      const r = requestRestart();
      return sendJson(res, 200, { ok: true, pid: r.pid, message: r.waiting ? `新实例 ${r.pid} 排队中，本实例等 ${r.active} 个请求完成后交棒（连接不断）` : `新实例 ${r.pid} 即将接管端口` });
    } catch (e) {
      return sendJson(res, e.status || 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ---- 服务控制 ----
  // B2：原来这里直接 process.exit(0) —— 会掐断在途模型请求（可能正是发这个请求的
  // 用户会话自己）并跳过 gracefulExit 的刷盘。现改走与 /admin/shutdown 同源的
  // requestStop：完整刷盘 + 有活跃请求时 409 拒绝（force=1 放行）。
  if (p === '/service/stop' && method === 'POST') {
    const { requestStop } = await import('./lifecycle.mjs');
    const force = String(ctx.body?.force ?? url.searchParams.get('force') ?? '') === '1';
    try {
      const r = requestStop({ force });
      return sendJson(res, 200, {
        ok: true,
        waiting: Boolean(r.waiting),
        activeRequests: r.active || 0,
        message: r.waiting
          ? `已受理停止：等 ${r.active} 个在途请求完成后退出（数据已刷盘）`
          : '正在保存数据并停止服务',
      });
    } catch (e) {
      if (e.status === 409) {
        return sendJson(res, 409, {
          ok: false,
          error: 'busy',
          activeRequests: e.activeRequests || 0,
          message: `有 ${e.activeRequests} 个请求进行中，已拒绝停止（掐断它们会连带断掉会话）。等它们跑完再停，或用 force=1 强制停止。`,
        });
      }
      return sendJson(res, e.status || 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ---- T23：控制台访问 PIN（控制台里的设置卡片；PIN 值永远不回传，只回是否已启用）----
  if (p === '/security' && method === 'GET') {
    return sendJson(res, 200, { ok: true, pinEnabled: Boolean(cfg.consolePin) });
  }
  if (p === '/security' && method === 'POST') {
    const body = ctx.body || {};
    // 已启用时改动需先验证当前 PIN（防旁人趁 unlocked 页面顺手关掉）；未启用时直接设
    if (cfg.consolePin && String(body.currentPin ?? '').trim() !== String(cfg.consolePin).trim()) {
      return sendJson(res, 403, { ok: false, error: '当前 PIN 不正确' });
    }
    const next = String(body.pin ?? '').trim();
    if (next === '') {
      cfg.consolePin = null; // 清空 = 关闭锁屏
      saveConfig(cfg);
      recordEvent('system', '控制台访问 PIN 已关闭');
      return sendJson(res, 200, { ok: true, pinEnabled: false });
    }
    if (!/^\d{4,12}$/.test(next)) return sendJson(res, 400, { ok: false, error: 'PIN 必须是 4-12 位数字' });
    cfg.consolePin = next;
    saveConfig(cfg);
    recordEvent('system', '控制台访问 PIN 已启用/更新');
    return sendJson(res, 200, { ok: true, pinEnabled: true });
  }

  // ---- T24：一键诊断（/wbp-doctor 与控制台「诊断」共用同一份体检逻辑）----
  if (p === '/doctor' && method === 'GET') {
    const d = await runDiagnostics(cfg);
    return sendJson(res, 200, { ok: true, ...d });
  }

  // ---- T29：控制台推送流（SSE）----
  // 把账号/任务/用量三类高频轮询（原来前端各挂一个 setInterval 30~60s）合并成一条
  // 服务端推送：bridge 每 20s、tasks 每 30s、usage 每 60s 各发一个具名事件；
  // 前端 EventSource 按事件名分发。轮询代码保留作降级（SSE 建不上时自动回落）。
  if (p === '/stream' && method === 'GET') {
    const { startSSE, writeSSEEvent } = await import('./util.mjs');
    startSSE(res, { 'X-Console-Stream': 'workbuddy-bridge' });
    let closed = false;
    res.on('close', () => { closed = true; });
    const push = async (event, text) => {
      if (closed || res.writableEnded) return false;
      try { await writeSSEEvent(res, event, text); return true; }
      catch { closed = true; return false; }
    };
    // T43：数据没变就不发帧。bridge/tasks/usage 本就是低频变化的数据，固定节奏推送的
    // 大多数轮次是纯重复流量；用 JSON 序列化串当哈希（等价于深比较，省得写浅 hash 还
    // 漏嵌套字段），每个连接独立记账。ping 保活帧不参与——它的职责就是每 15 秒证明连接活着。
    const lastSent = new Map(); // event → 上次发送的 payload 序列化串
    const pushIfChanged = async (event, data) => {
      const text = JSON.stringify(data);
      if (lastSent.get(event) === text) return true;
      lastSent.set(event, text);
      return push(event, text);
    };
    // 首帧立即给，前端建流后不用再等一个周期
    await pushIfChanged('bridge', bridgeStatus(cfg, { redact: true }));
    await pushIfChanged('tasks', taskStatus());
    await pushIfChanged('usage', usageSnapshot(7));
    const jobs = [
      ['bridge', () => bridgeStatus(cfg, { redact: true }), 20_000],
      ['tasks', () => taskStatus(), 30_000],
      ['usage', () => usageSnapshot(7), 60_000],
      ['ping', () => ({ at: Date.now() }), 15_000, true], // 保活帧（也兼作服务存活探测），每次都发
    ];
    for (const [event, make, ms, always] of jobs) {
      const t = setInterval(async () => {
        if (closed) { clearInterval(t); return; }
        try {
          const ok = always ? await push(event, JSON.stringify(make())) : await pushIfChanged(event, make());
          if (!ok) clearInterval(t);
        } catch { clearInterval(t); }
      }, ms);
      t.unref?.();
    }
    return; // SSE 常开，不落入 JSON 返回
  }

  return sendJson(res, 404, { error: `未知控制台接口 ${method} ${p}` });
}
