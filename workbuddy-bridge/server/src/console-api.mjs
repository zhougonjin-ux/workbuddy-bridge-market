// 控制台后端 API：状态总览 / 模型清单 / 一键切换默认模型 / 日志 / 用量 / 探测 / 登录 / 停服
// 仅本机可用（服务只监听 127.0.0.1），鉴权用控制台会话 token 或 config.json 的 apiKey。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, siteKeys, saveConfig, paths, authPathFor, authKeys, primaryKey } from './config.mjs';
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
import { getCatalog, mergedModels, parseMultiplier } from './router.mjs';
import { openChat, queryCredit, classifyFrame, upstreamErrorMessage, supportsCreditQuery } from './upstream.mjs';
import { startLogin, pollLogin } from './device-login.mjs';
import { usageSnapshot, resetUsage, flushUsage, recordBalance } from './usage.mjs';
import { recentLogs, log } from './log.mjs';
import { sendJson } from './util.mjs';
import { bridgeStatus, setPolicy, refreshCreditsAll } from './scheduler.mjs';
import { runTasks, taskStatus } from './tasks.mjs';
import { importLocalAccounts } from './localimport.mjs';

const startedAt = Date.now();
const loginStates = new Map(); // site → { state, authUrl, at }

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

/** 探测单个模型是否可用（不消耗或极少消耗额度）。 */
async function probeModel(cfg, site, model) {
  const t0 = Date.now();
  try {
    const up = await openChat(cfg, site, {
      model,
      stream: true,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }, {});
    if (!up.ok) {
      return { model, site, status: up.status, ok: false, msg: upstreamErrorMessage(up.status, up.text, site), ms: Date.now() - t0 };
    }
    let first = null;
    try {
      for await (const payload of up.frames) {
        const parsed = classifyFrame(payload);
        first = parsed;
        break;
      }
    } finally {
      up.close();
    }
    if (first?.kind === 'error') return { model, site, status: 502, ok: false, msg: first.message, ms: Date.now() - t0 };
    return { model, site, status: 200, ok: true, msg: '可用', ms: Date.now() - t0 };
  } catch (e) {
    return { model, site, status: 0, ok: false, msg: e.message, ms: Date.now() - t0 };
  }
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
    const list = merged.map((m) => ({
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
    }));
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

  // ---- 一键切换默认模型（Trae 侧只配 model=default） ----
  if (p === '/default-model' && method === 'POST') {
    const body = ctx.body || {};
    const model = String(body.model || '').trim();
    if (!model) return sendJson(res, 400, { error: '缺少 model' });
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
    if (Array.isArray(body.seedModels)) cfg.sites[site].seedModels = body.seedModels;
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, site: cfg.sites[site] });
  }

  // ---- 别名管理 ----
  if (p === '/aliases' && method === 'POST') {
    const body = ctx.body || {};
    const aliases = body.aliases;
    if (!aliases || typeof aliases !== 'object') return sendJson(res, 400, { error: '缺少 aliases 对象' });
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
          // 余额为 0 且活动仍开启 → 直接标记耗尽，下次请求就会跳过它
          if (c.remain <= 0) markExhausted(site, a.id, '余额为 0');
        } catch (e) {
          a.credit_error = e.message.slice(0, 160);
        }
      }
    }
    return sendJson(res, 200, { site, accounts, supports_credit: supportsCreditQuery(cfg, site) });
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
    return sendJson(res, 200, bridgeStatus(cfg));
  }
  if (p === '/credit/refresh' && method === 'POST') {
    const results = await refreshCreditsAll(cfg);
    return sendJson(res, 200, { ok: true, results });
  }

  // ---- workbuddy-bridge：自动任务（签到/成长任务）----
  if (p === '/tasks' && method === 'GET') {
    return sendJson(res, 200, taskStatus());
  }
  if (p === '/tasks/run' && method === 'POST') {
    const body = ctx.body || {};
    const kind = ['checkin', 'growth', 'travel', 'all'].includes(body.kind) ? body.kind : 'all';
    const site = body.site ? String(body.site) : null;
    const results = await runTasks(cfg, kind, site);
    return sendJson(res, 200, { ok: true, kind, results });
  }

  // 保存自动任务设置：精确时点（"HH:MM" 逗号分隔，空串=回退到旧的小时数组）、
  // 对话体验类任务代打开关与单任务代打上限。立即落盘 config.json（调度循环热读取）。
  if (p === '/tasks/config' && method === 'POST') {
    const body = ctx.body || {};
    const parseTimes = (v) => String(v ?? '')
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.padStart(5, '0'));
    const norm = { checkinTimes: parseTimes(body.checkinTimes), growthTimes: parseTimes(body.growthTimes), travelTimes: parseTimes(body.travelTimes) };
    for (const [k, arr] of Object.entries(norm)) {
      if (arr.some((s) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(s))) {
        return sendJson(res, 400, { ok: false, error: `${k} 里有非法时点（应为 HH:MM，如 09:30）：${arr.join(',')}` });
      }
    }
    cfg.tasks.checkinTimes = norm.checkinTimes;
    cfg.tasks.growthTimes = norm.growthTimes;
    if (norm.travelTimes) cfg.tasks.travelTimes = norm.travelTimes;
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
    return sendJson(res, 200, {
      ok: true,
      saved: {
        checkinTimes: cfg.tasks.checkinTimes,
        growthTimes: cfg.tasks.growthTimes,
        autoComplete: cfg.tasks.autoComplete,
        maxChatsPerTask: cfg.tasks.maxChatsPerTask,
      },
    });
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
    const after = Number(url.searchParams.get('after') || 0);
    return sendJson(res, 200, recentLogs(after));
  }

  // ---- 用量统计 ----
  if (p === '/usage' && method === 'GET') {
    const days = Number(url.searchParams.get('days') || 7);
    return sendJson(res, 200, usageSnapshot(days));
  }
  if (p === '/usage/reset' && method === 'POST') {
    resetUsage();
    return sendJson(res, 200, { ok: true });
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

  // ---- 服务控制 ----
  if (p === '/service/stop' && method === 'POST') {
    sendJson(res, 200, { ok: true, message: 'shutting down' });
    flushUsage();
    setTimeout(() => process.exit(0), 200);
    return;
  }

  return sendJson(res, 404, { error: `未知控制台接口 ${method} ${p}` });
}
