'use strict';
// T51：服务每次启动都重新生成会话 token，没关的旧标签页手里的这份会永久失效。
// 原先只回 401 让人「刷新页面」，可页面自己拿不到新 token —— 旧页签于是每 2 秒刷一条
// 鉴权失败日志，3 分钟把 server.log 刷成 19/33 行噪声（2026-10-04 手操实测）。
// 现在服务端 401 会带上新 token（响应体 newToken / 响应头 X-WB-New-Token），
// 前端静默续期并重试一次，用户完全无感。
let TOKEN = window.__WB_TOKEN__ || '';
let __renewing = null; // 续期中的 Promise，避免并发请求同时续期（只发一次 unlock）

const $ = (s, el = document) => (el || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* T50 api 微缓存：GET 请求 3.5s 内复用上次结果（stale-while-revalidate：先回缓存再后台刷新）。
 * 切 tab 连点多个分段时不再每次全量等接口——首个渲染立即出，网络慢也有内容。 */
const __apiCache = new Map(); // path -> { t, p }

/**
 * T51：会话 token 续期。服务端 401 会把新 token 带回来（响应体 newToken），
 * 这里换掉 TOKEN 并清掉 GET 缓存，让后续请求用新凭证。
 * 并发请求同时遇到 401 时只发一次续期请求（__renewing 去重），避免风暴。
 */
async function renewToken(res) {
  const nt = (res.headers.get('X-WB-New-Token') || '').trim();
  if (!nt || nt === TOKEN) return false;
  TOKEN = nt;
  __apiCache.clear();
  return true;
}

async function api(path, opts = {}) {
  const isGet = !(opts && opts.body) && (!opts || !opts.method || opts.method === 'GET');
  if (isGet) {
    const c = __apiCache.get(path);
    if (c && Date.now() - c.t < 3500) return c.p;
    const p = (async () => {
      const res = await fetch('/console/api' + path, {
        ...opts,
        headers: { 'X-Console-Token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!res.ok) {
        // T51：token 过期时静默续期并重试一次（失败才抛给调用方）
        if (res.status === 401 && await renewToken(res)) {
          const again = await fetch('/console/api' + path, {
            ...opts,
            headers: { 'X-Console-Token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
          });
          const t2 = await again.text();
          let j2 = null;
          try { j2 = JSON.parse(t2); } catch { j2 = { raw: t2 }; }
          if (again.ok) return j2;
        }
        const info = json.error;
        const msg = typeof info === 'string' ? info : (info && info.message) || ('HTTP ' + res.status);
        throw new Error(msg);
      }
      return json;
    })();
    __apiCache.set(path, { t: Date.now(), p });
    p.catch(() => __apiCache.delete(path)); // 失败不缓存，下次重拉
    return p;
  }
  const res = await fetch('/console/api' + path, {
    ...opts,
    headers: { 'X-Console-Token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    // T51：同上，POST 也要能续期后重试
    if (res.status === 401 && await renewToken(res)) return api(path, opts);
    const info = json.error;
    const msg = typeof info === 'string' ? info : (info && info.message) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return json;
}

function toast(msg, cls = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
const copy = (text, tip) => navigator.clipboard?.writeText(text).then(() => toast((tip || '已复制') + '：' + text, 'ok')).catch(() => {});

/* HUD 壳层（shell.js/fx.js）复用的钩子：api 函数、toast、当前视图。
 * 只暴露引用，不改任何原有逻辑。 */
window.__wbApi = api;
window.toast = toast;
window.__WB_TOKEN_REF = TOKEN;

/* ---------- 时间/格式化 ---------- */
const fmtDays = (t) => {
  if (!t) return null;
  const d = Math.round((t - Date.now()) / 86400000);
  return d;
};
const expiryColor = (t) => {
  const d = fmtDays(t);
  if (d === null) return '#5a6377';
  if (d <= 0) return 'var(--bad)';
  if (d <= 7) return 'var(--bad)';
  if (d <= 30) return 'var(--warn)';
  return 'var(--ok)';
};
const expiryText = (t) => {
  if (!t) return '无到期信息';
  const d = fmtDays(t);
  const date = new Date(t).toLocaleDateString();
  if (d <= 0) return `${date}（已到期）`;
  return `${date}（${d} 天后）`;
};
const fmtK = (n) => (n == null ? '—' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n));
const dur = (ms) => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
  return h ? `${h} 时 ${m} 分` : `${m} 分`;
};

/* ---------- 全局状态与 Tab ---------- */
let refreshTimer = null, logTimer = null, logSeq = 0, logPaused = false, STATE = null;

/* 仅当内容变化时才重建 DOM：页签轮询 / SSE 推送触发的重复渲染不再引发整页闪烁。
 * 返回 true 表示真的重建了（此时才需要重绑事件、重画子区域）。 */
function paint(el, html) {
  if (!el) return false;
  if (el.__wbPaint === html) return false;
  el.__wbPaint = html;
  el.innerHTML = html;
  return true;
}

/* ---------- 0.3.24 视图路由：无页签，大屏(home)为唯一主页面，其余全部是下钻子页面 ----------
 * 导航模型：大屏面板/卡片点「详情」进子页面 → 返回条「← 返回大屏」或浏览器后退回大屏；
 * location.hash 同步（#/accounts 等），刷新/转发链接都能直接落到对应子页面。 */
const VIEWS = ['home', 'accounts', 'models', 'tasks', 'usage', 'events', 'settings'];
const VIEW_META = {
  accounts: ['账号与积分', '账号卡 · 到期批次 · 策略 · 扫码登录'],
  models: ['模型库', '清单 · 倍率 · 巡检 · 设为默认'],
  tasks: ['任务中心', '签到 · 成长任务 · 猫猫旅行 · 日历'],
  usage: ['用量分析', '消耗图表 · 按模型/账号 · CSV 导出'],
  events: ['事件时间线', '任务 / 账号 / 策略 / 登录 回放'],
  settings: ['接入与运维', '接入配置 · 通知 · 备份 · 诊断 · 日志'],
};
let active = 'home';

function parseHash() {
  const m = (location.hash || '').match(/^#\/(\w+)/);
  return m && VIEWS.includes(m[1]) ? m[1] : 'home';
}

function showView(name, focus = null) {
  active = name;
  window.__wbActiveView = name; // HUD 壳层同步导航高亮用（shell.js 轮询读取）
  for (const v of VIEWS) { const el = $('#view-' + v); if (el) el.hidden = v !== name; }
  $('#backBar').hidden = name === 'home';
  const meta = VIEW_META[name];
  if (meta) { $('#viewTitle').textContent = meta[0]; $('#viewHint').textContent = meta[1]; }
  const want = name === 'home' ? '' : '#/' + name;
  if ((location.hash || '') !== want) location.hash = want; // 触发 hashchange（同值时浏览器不触发）
  enterView(name, focus);
}

/* HUD 壳层（shell.js）的页内分段复用：只做「进入视图」的加载与定时器，不写 hash、
 * 不动返回条。showView = 切 hidden/hash + enterView；分段 = 切 hidden + enterView。 */
function enterView(name, focus = null) {
  clearInterval(refreshTimer); clearInterval(logTimer); logTimer = null;
  // shell.js 分段切换置 __wbSegKeepScroll：同页就地换段保滚动；正常 showView（含返回大屏）回顶
  if (window.__wbSegKeepScroll != null) window.scrollTo(0, window.__wbSegKeepScroll);
  else window.scrollTo(0, 0); // 子页面从顶部开始看
  if (name === 'home') { loadOverview(); void loadTcSummary(); refreshTimer = setInterval(loadOverview, 30000); }
  if (name === 'accounts') { loadAccounts().then(() => focusAcct(focus)).catch(() => {}); refreshTimer = setInterval(loadAccounts, 30000); }
  if (name === 'models') { loadModels(); refreshTimer = setInterval(loadModels, 60000); }
  if (name === 'tasks') { loadTasks(); loadTaskCenter(); void loadTcSummary(); refreshTimer = setInterval(loadTasks, 30000); }
  if (name === 'usage') { loadUsage(); refreshTimer = setInterval(loadUsage, 60000); }
  if (name === 'events') { loadEvents(); refreshTimer = setInterval(loadEvents, 30000); }
  if (name === 'settings') { loadGuide(); loadHealth(); startLogs(); refreshTimer = setInterval(loadHealth, 30000); }
}
window.__wbViews = () => VIEWS;
window.__wbEnterView = enterView;

/* T49 下钻精定位：大屏账号行 → 账号页定位到对应账号卡。render 完成后调用；
 * 找不到目标（账号不在/还没加载）就安静返回，不做任何滚动。 */
function focusAcct(id) {
  if (!id) return;
  const card = document.querySelector(`[data-acct-card][data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('flash');
  void card.offsetWidth; // 重启动画（重复点击同一路径也能再次看到高亮）
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 2400);
}
window.addEventListener('hashchange', () => { const v = parseHash(); if (v !== active) showView(v); });
$('#btnHome').onclick = () => showView('home');
$('#logPause').onclick = () => { logPaused = !logPaused; $('#logPause').textContent = logPaused ? '继续滚动' : '暂停滚动'; };
$('#logClear').onclick = () => { $('#logBox').textContent = ''; logSeq = 0; };

/* ---------- 顶栏 ---------- */
async function loadHeader() {
  STATE = await api('/state');
  const anyLogin = (STATE.sites || []).some((s) => s.logged_in);
  $('#ver').textContent = 'v' + (STATE.version || '?');
  $('#srvMeta').innerHTML =
    `<span class="pill"><span class="dot ${anyLogin ? 'ok' : ''}"></span>${anyLogin ? '运行中' : '未登录账号'}</span>` +
    `<span class="pill" title="点击复制 Base URL" onclick='copy(${JSON.stringify(STATE.base_url)},"Base URL")'>${esc(STATE.base_url)}</span>` +
    `<span class="pill" style="color:#9fc4ff" title="复制 ZCode 模型供应商接入配置" id="copyCfg">⧉ 复制 ZCode 配置</span>` +
    `<span class="pill" style="cursor:pointer" title="点击到模型库修改默认模型" onclick='showView("models")'>默认：${esc(STATE.default_model)}</span>` +
    `<span class="pill" title="本次服务运行时长">已运行 ${dur(STATE.uptime_ms || 0)}</span>`;
  $('#copyCfg').onclick = async () => {
    try {
      const c = await api('/zcode-config');
      const text = [
        'ZCode 模型供应商配置（OpenAI 兼容）：',
        'Base URL: ' + c.base_url,
        'API Key: ' + c.api_key,
        '模型 ID: ' + c.model,
        '',
        '提示：模型 ID 填 default，以后切模型在管理台「设为默认」或会话里说一声即可，不用再进 ZCode 设置。',
      ].join('\n');
      copy(text, '已复制 ZCode 接入配置');
    } catch (e) { toast('获取配置失败：' + e.message, 'bad'); }
  };
}

/* ---------- 大屏主页（0.3.24，无页签架构的唯一主页面） ----------
 * 数据大屏思维：一屏回答「还剩多少分 / 今天跑了什么 / 用哪个模型 / 出了什么事」，
 * 所有卡片都可下钻进子页面（账号/模型/任务/用量/事件/设置），返回条或浏览器后退回来。
 * 数据全部复用现有接口（/bridge /usage /tasks /events /state /models /health），零后端改动；
 * 30s 轮询 + SSE 推送都走 paint()，数据没变不动 DOM。 */
let tcSummary = null; // 大屏任务摘要：{ at, rows:[{site,id,label,claimable,playable,total,at,error}] }

/* T42：自动任务开关的共用绑定（大屏 ovTk* 与任务页 tk* 同一套后端语义）。
 * 单字段 POST 不动时点配置；总开关由后端热生效（停/起调度循环）；失败回滚勾选态。 */
function bindTaskSwitch(id, key, after) {
  const cb = document.getElementById(id);
  if (!cb) return;
  cb.onchange = async () => {
    try {
      const r = await api('/tasks/config', { method: 'POST', body: { [key]: cb.checked } });
      const s = r.saved || {};
      toast(key === 'enabled'
        ? (s.enabled === false ? '自动任务已整体关闭（调度循环已停）' : '自动任务已开启（调度循环已启动）')
        : (s[key] === false ? '该类任务已关闭（每天不再自动执行）' : '该类任务已开启'), 'ok');
      if (after) after();
    } catch (e) { toast('切换失败：' + e.message, 'bad'); cb.checked = !cb.checked; }
  };
}
async function loadTcSummary() {
  if (tcSummary && Date.now() - tcSummary.at < 10 * 60_000) return; // 10 分钟内不重复拉
  tcSummary = { at: Date.now(), rows: [], loading: true };
  try {
    const b = await api('/bridge');
    const list = [];
    for (const s of b.sites || []) for (const a of s.accounts || []) {
      if (a.enabled === false) continue;
      list.push({ site: s.site, id: a.id, label: a.label || a.nickname || a.id, claimable: 0, playable: 0, total: 0, at: null, error: null });
    }
    tcSummary = { at: Date.now(), rows: list };
    await Promise.all(list.map(async (x) => {
      try {
        // 非强制：走服务端缓存（每日 listTimes 预取 + 6h TTL），不会连续打上游
        const r = await api('/task-center?site=' + encodeURIComponent(x.site) + '&accountId=' + encodeURIComponent(x.id));
        x.total = (r.tasks || []).length;
        x.claimable = (r.tasks || []).filter((t) => t.claimable && !t.claimed).length;
        x.playable = (r.tasks || []).filter((t) => t.autoplayable && !t.claimable).length;
        x.at = r.cachedAt || null;
      } catch (e) { x.error = e.message; }
    }));
  } catch (e) { tcSummary = { at: Date.now(), rows: [], error: e.message }; }
  if (active === 'home') loadOverview(); // 回填渲染（paint 自会防抖）
  if (active === 'tasks') renderTcOverview(); // T48：任务子页面的全账号总览同步回填
}

/* T48：任务子页面顶部「全部账号」任务总览（与大屏摘要同一份 10 分钟缓存，不重复打上游）。
 * 点行 = 把下方任务中心切到该账号并加载详情。 */
function renderTcOverview() {
  const box = $('#tcOverview');
  if (!box) return;
  let rows = '';
  if (!tcSummary || tcSummary.loading) rows = '<div class="muted" style="padding:10px 2px"><span class="spin"></span>正在读取各账号任务进度…</div>';
  else if (tcSummary.error) rows = `<div class="bad" style="font-size:12.5px;padding:8px 2px">读取失败：${esc(tcSummary.error)}</div>`;
  else if (!tcSummary.rows.length) rows = '<div class="muted" style="padding:10px 2px">还没有启用中的账号</div>';
  else rows = tcSummary.rows.map((r) => `<div class="acctline" data-tcrow="${esc(r.site)}|${esc(r.id)}" style="cursor:pointer" title="点行在下方展开该账号的任务详情">
      <b style="font-size:13px;min-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label)}</b>
      <span class="badge">${esc(r.site)}</span>
      ${r.error ? '<span class="badge bad">读取失败</span>'
        : `<span style="font-size:12.5px">任务 <b>${r.total ?? 0}</b> · 待领 <b class="${r.claimable ? 'warn' : ''}">${r.claimable ?? 0}</b> · 可代打 <b>${r.playable ?? 0}</b></span>
           <span class="muted" style="font-size:11px;margin-left:auto">数据 ${r.at ? esc(new Date(r.at).toLocaleTimeString()) : '—'} ↙</span>`}
    </div>`).join('');
  const changed = paint(box, rows);
  if (changed) {
    for (const line of box.querySelectorAll('[data-tcrow]')) {
      line.onclick = () => {
        const sel = $('#tcAccount');
        if (!sel) return;
        const key = line.dataset.tcrow;
        if (![...sel.options].some((o) => o.value === key)) { toast('该账号不在任务中心列表里', 'bad'); return; }
        sel.value = key;
        localStorage.setItem('wbTcAccount', key);
        loadTaskCenter({ spinner: true });
        const card = $('#tcList') && $('#tcList').closest('.card');
        if (card) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 2200); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      };
    }
  }
}

async function loadOverview() {
  const el = $('#view-home');
  try {
    const [bridge, usage, tasks, evts, state, modelsResp, health, burnout, doctor] = await Promise.all([
      api('/bridge'),
      api('/usage?days=7'),
      api('/tasks'),
      api('/events').catch(() => ({ events: [] })),
      api('/state'),
      api('/models').catch(() => null),
      api('/health').catch(() => null),
      api('/burnout').catch(() => null),
      api('/doctor').catch(() => null),
    ]);
    STATE = state; // 顶栏的运行时长/状态随之保鲜
    const accts = [];
    for (const s of bridge.sites || []) for (const a of s.accounts || []) accts.push({ site: s, a });
    const enabled = accts.filter((x) => x.a.enabled !== false);
    const accNames = {};
    for (const x of accts) accNames[x.a.id] = x.a.label || x.a.nickname || x.a.id;

    /* ---- 汇总数字 ---- */
    const totalRemain = enabled.reduce((s, x) => s + (accountRemainOf(x.a) || 0), 0);
    const totalBatches = enabled.reduce((s, x) => s + (x.a.creditDetail || []).filter((b) => (b.remain || 0) > 0).length, 0);
    const today = usage.today || {};
    const recent = usage.recent || [];
    const dailyAvg = (burnout && burnout.dailyAvg) || 0;
    const totalDays = daysLeftOf(totalRemain, dailyAvg);
    const successRate = today.calls ? Math.round((today.calls - (today.errors || 0)) / today.calls * 100) : 100;
    let earliest = null;
    for (const x of enabled) for (const bt of (x.a.creditDetail || [])) {
      if ((bt.remain || 0) > 0 && bt.expireAt && (earliest === null || bt.expireAt < earliest)) earliest = bt.expireAt;
    }
    const healthAcc = enabled.filter((x) => healthState(x.a).cls === 'ok').length;

    /* ---- sparkline（近 7 天调用 / 积分，占位平线兜底） ---- */
    const spark = (vals, color, gid) => {
      const vs = vals.length ? vals : [1, 1];
      const max = Math.max(1, ...vs);
      const pts = vs.map((v, i) => [`M${Math.round(i / Math.max(1, vs.length - 1) * 120)} ${Math.round(24 - (v / max) * 21)}`].join(''));
      const d = pts.length ? 'M' + vs.map((v, i) => `${Math.round(i / Math.max(1, vs.length - 1) * 120)} ${Math.round(24 - (v / max) * 21)}`).join(' L') : 'M0 24 L120 24';
      const last = d.split(' ').pop().split('L').pop();
      return `<svg class="spark" viewBox="0 0 120 26" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".35"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
        <path d="${d} L120 26 L0 26Z" fill="url(#${gid})"/>
        <path class="l" d="${d}" fill="none" stroke="${color}" stroke-width="1.4"/>
      </svg>`;
    };

    /* ---- KPI 4 卡 ---- */
    const kpis = `
      <div class="card hv tilt an" data-go="usage" title="今日调用与错误统计 · 点击查看用量明细" style="--c:#4F8CFF;animation-delay:0ms;cursor:pointer">
        <div class="k">今日调用</div>
        <div class="v glow"><span data-count="${today.calls ?? 0}">0</span></div>
        <div class="muted">错误 ${today.errors ?? 0} · 成功率 ${successRate}%</div>
        ${spark(recent.map((d) => d.calls || 0), '#4F8CFF', 'spk1')}
      </div>
      <div class="card hv tilt an" data-go="usage" title="今日消耗积分与 token 统计 · 点击查看用量明细" style="--c:#22D3EE;animation-delay:60ms;cursor:pointer">
        <div class="k">今日消耗积分</div>
        <div class="v"><span data-count="${today.credit ?? 0}" data-dec="2">0</span></div>
        <div class="muted">输入 ${fmtK(today.promptTokens ?? 0)} · 输出 ${fmtK(today.completionTokens ?? 0)} tok</div>
        ${spark(recent.map((d) => d.credit || 0), '#22D3EE', 'spk2')}
      </div>
      <div class="card hv tilt an" data-go="accounts" title="各账号健康状态（冷却/失效/耗尽）· 点击进入账号管理" style="--c:#34D399;animation-delay:120ms;cursor:pointer">
        <div class="k">可用账号</div>
        <div class="v">${healthAcc} <span style="font-size:14px;color:var(--mu)">/ ${enabled.length}</span></div>
        <div class="muted">${enabled.length - healthAcc ? (enabled.length - healthAcc) + ' 个冷却/失效' : '全部健康'} · 站点 ${(state.sites || []).filter((s) => s.logged_in).map((s) => s.site).join(' ') || '—'}</div>
        ${spark(enabled.map((x) => 1), '#34D399', 'spk3')}
      </div>
      <div class="card hv tilt an" data-go="accounts" title="全部启用账号的可用积分合计 · 点击查看账号与批次明细" style="--c:#7B5CFF;animation-delay:180ms;cursor:pointer">
        <div class="k">积分总量${totalDays !== null ? ' · ≈' + totalDays + ' 天' : ''}</div>
        <div class="v"><span data-count="${Math.round(totalRemain)}">0</span></div>
        <div class="muted">${totalBatches} 个有效批次${earliest ? ' · 最早 ' + new Date(earliest).toLocaleDateString().slice(5) + ' 到期' : ''}${dailyAvg > 0 ? ' · 日均 ' + fmtCredit(dailyAvg) : ''}</div>
        ${spark(recent.map((d) => d.credit || 0).reverse(), '#7B5CFF', 'spk4')}
      </div>`;

    /* ---- 积分池环形（双层：旋转刻度环 + 进度环 + 光子） ---- */
    const maxSeen = Math.max(totalRemain, 1); // 环形图进度：无历史峰值参考时以满环展示余量占比 1（纯装饰）
    const ringPct = Math.max(0.04, Math.min(1, totalRemain / maxSeen));
    const C = 2 * Math.PI * 58;
    const ringSvg = `<svg viewBox="0 0 140 140" style="width:132px;height:132px;flex:none" aria-label="积分池环形仪表">
      <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="var(--cy)"/><stop offset="55%" stop-color="var(--ac)"/><stop offset="100%" stop-color="var(--vi)"/></linearGradient></defs>
      <circle cx="70" cy="70" r="58" fill="none" stroke="rgba(120,150,220,.16)" stroke-width="9"/>
      <circle cx="70" cy="70" r="58" fill="none" stroke="url(#rg)" stroke-width="9" stroke-linecap="round"
              stroke-dasharray="${C.toFixed(0)}" stroke-dashoffset="${(C * (1 - ringPct)).toFixed(0)}" transform="rotate(-90 70 70)"
              style="filter:drop-shadow(0 0 8px rgba(79,140,255,.6))"/>
      <circle cx="70" cy="70" r="66" fill="none" stroke="rgba(120,150,220,.35)" stroke-width="1" stroke-dasharray="1 9" style="animation:spin 6s linear infinite;transform-origin:70px 70px"/>
      <circle cx="70" cy="70" r="58" fill="none" stroke="#EAF9FF" stroke-width="2.4" stroke-dasharray="4 360" transform="rotate(-90 70 70)" style="animation:spin 3.4s linear infinite;transform-origin:70px 70px"/>
      <circle cx="70" cy="70" r="50" fill="var(--ring-core)" stroke="rgba(140,170,230,.28)" stroke-width="1"/>
      <text x="70" y="64" text-anchor="middle" fill="var(--tx)" font-size="25" font-weight="700" font-family="monospace">${fmtCredit(Math.round(totalRemain))}</text>
      <text x="70" y="81" text-anchor="middle" fill="#B9C6DE" font-size="9.5" font-family="monospace">${enabled.length} 账号 · ${totalBatches} 批</text>
      ${earliest ? `<text x="70" y="95" text-anchor="middle" fill="#F5A524" font-size="9.5" font-family="monospace">最早到期 ${new Date(earliest).toLocaleDateString().slice(5)}</text>` : ''}
    </svg>`;

    /* ---- 账号余额条 ---- */
    const accRows = enabled.map((x) => {
      const remain = accountRemainOf(x.a);
      const active = x.site.active_account_id === x.a.id;
      const bo = x.a.burnout || {};
      const dl = daysLeftOf(remain, dailyAvg);
      const hs = healthState(x.a);
      const pct = Math.max(3, Math.min(100, Math.round((remain || 0) / Math.max(1, totalRemain) * 100)));
      return `<div class="row" data-go="accounts" data-focus="${esc(x.a.id)}" style="grid-template-columns:6px minmax(0,1fr) auto;cursor:pointer">
        <span class="p ${hs.cls === 'ok' ? 'ok' : hs.cls === 'warn' ? 'wn' : 'bd'}"></span>
        <span><b style="font-weight:500">${esc(accNames[x.a.id] || x.a.id)}</b> ${active ? '<span class="tag ac">使用中</span>' : ''}
          <div class="muted">${(x.a.creditDetail || []).filter((b) => (b.remain || 0) > 0).length} 批次${dl !== null ? ' · ≈' + dl + ' 天' : ''}${bo.riskCount > 0 ? ' · <span style="color:var(--wn)">预计浪费 ' + fmtCredit(bo.totalWaste) + '</span>' : ''}</div></span>
        <span class="mono" style="font-size:19px">${remain != null ? fmtCredit(remain) : '—'}</span>
      </div>
      <div class="bar live" style="margin:2px 0 8px"><i style="width:${pct}%;background:linear-gradient(90deg,var(--ac),var(--cy))"></i></div>`;
    }).join('');

    /* ---- 批次到期分布时间轴（未来 90 天 8 段，段色按远近/风险） ---- */
    const seg = [
      { label: '≤7天', cls: 'd', w: 0 }, { label: '15天', cls: 'w', w: 0 },
      { label: '31天', cls: '', w: 0 }, { label: '45天', cls: 'v', w: 0 },
      { label: '60天', cls: '', w: 0 }, { label: '75天', cls: '', w: 0 },
      { label: '90天', cls: 'w', w: 0 }, { label: '更远', cls: '', w: 0 },
    ];
    const bounds = [7, 15, 31, 45, 60, 75, 90, 36500];
    for (const x of enabled) for (const bt of (x.a.creditDetail || [])) {
      if ((bt.remain || 0) <= 0) continue;
      const d = fmtDays(bt.expireAt);
      if (d === null) continue;
      const idx = bounds.findIndex((b) => d <= b);
      if (idx >= 0) seg[idx].w += bt.remain;
    }
    const segSum = seg.reduce((s, x) => s + x.w, 0) || 1;
    const tl = seg.map((s) => `<i class="${s.cls}" style="flex:${Math.max(1, s.w)}" title="${s.label}：${fmtCredit(s.w)} 积分"></i>`).join('');
    const tlx = seg.map((s) => `<span style="flex:1 1 0">(${s.label})${s.w > 0 ? '.' : '.'}</span>`).join('');

    /* ---- 24h 频谱（§5.2：待发生压暗区 + 现在分界 + 峰值标注） ---- */
    const hours = usage.todayHours || [];
    const nowHour = new Date().getHours();
    const maxCall = Math.max(1, ...hours.map((h) => h.calls || 0));
    const peak = hours.reduce((p, h) => (h.calls || 0) > (p.calls || 0) ? h : p, { calls: 0, hour: 0 });
    const PLOT_X0 = 26, PLOT_X1 = 592, BASE_Y = 120, TOP_Y = 18, BAR_W = 15;
    const slotW = (PLOT_X1 - PLOT_X0) / 24;
    const bx = (i) => PLOT_X0 + 4.167 + i * 23.333;
    const by = (v) => BASE_Y - Math.round((v / maxCall) * (BASE_Y - TOP_Y));
    let bars = '';
    for (let i = 0; i < 24; i++) {
      if (i > nowHour) break; // 待发生区不画柱
      const v = (hours[i] || {}).calls || 0;
      const x = bx(i).toFixed(1), y = v > 0 ? by(v) : BASE_Y - 3, h = v > 0 ? BASE_Y - y : 3;
      const isPeak = peak.calls > 0 && i === peak.hour;
      bars += `<rect class="b" x="${x}" y="${y}" width="${BAR_W}" height="${Math.max(3, h)}" rx="${isPeak ? 2 : 1.5}" fill="url(#${isPeak ? 'bg1' : 'bg2'})" style="animation-delay:${500 + i * 20}ms"/>`;
    }
    const nowX = (PLOT_X0 + 4.167 + (nowHour + 1) * 23.333).toFixed(1);
    const pendingW = (PLOT_X1 - Number(nowX)).toFixed(1);
    const ticks = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => {
      const x = (bx(h) + BAR_W / 2).toFixed(1);
      const col = h === nowHour ? '#8FE8FA' : 'var(--mu)';
      const v = String(h).padStart(2, '0');
      return `<text x="${x}" y="136" fill="${col}" font-size="9" text-anchor="middle" font-family="monospace">${v}</text>`;
    }).join('');
    const ruler = [1, 0.667, 0.333].map((f) => {
      const y = TOP_Y + Math.round((BASE_Y - TOP_Y) * f * 0) || 0; // 三条虚线固定 y=18/52/86
      return '';
    });
    const spectrum = `<svg viewBox="0 0 600 148" style="width:100%;height:auto;display:block" role="img" aria-label="24 小时调用分布">
      <defs>
        <linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--cy)"/><stop offset="100%" stop-color="var(--cy)" stop-opacity=".10"/></linearGradient>
        <linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5C6C86"/><stop offset="100%" stop-color="#5C6C86" stop-opacity=".22"/></linearGradient>
        <linearGradient id="bgu" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fff" stop-opacity=".045"/><stop offset="100%" stop-color="#fff" stop-opacity=".012"/></linearGradient>
      </defs>
      <rect x="${nowX}" y="18" width="${pendingW}" height="102" fill="url(#bgu)"/>
      <line x1="26" y1="18" x2="592" y2="18" stroke="rgba(120,150,220,.13)" stroke-dasharray="2 5"/>
      <line x1="26" y1="52" x2="592" y2="52" stroke="rgba(120,150,220,.13)" stroke-dasharray="2 5"/>
      <line x1="26" y1="86" x2="592" y2="86" stroke="rgba(120,150,220,.13)" stroke-dasharray="2 5"/>
      <text x="21" y="21" fill="var(--mu)" font-size="8" text-anchor="end" font-family="monospace">${maxCall}</text>
      <text x="21" y="55" fill="var(--mu)" font-size="8" text-anchor="end" font-family="monospace">${Math.round(maxCall * 0.667)}</text>
      <text x="21" y="89" fill="var(--mu)" font-size="8" text-anchor="end" font-family="monospace">${Math.round(maxCall * 0.333)}</text>
      <text x="21" y="123" fill="var(--mu)" font-size="8" text-anchor="end" font-family="monospace">0</text>
      <line x1="26" y1="120" x2="592" y2="120" stroke="rgba(79,140,255,.45)" stroke-width="1"/>
      ${bars}
      ${peak.calls > 0 && peak.hour <= nowHour ? `<text x="${(bx(peak.hour) + BAR_W / 2).toFixed(1)}" y="13" fill="#8FE8FA" font-size="9" text-anchor="middle" font-family="monospace">${peak.calls}</text>` : ''}
      <line x1="${nowX}" y1="18" x2="${nowX}" y2="120" stroke="rgba(150,180,255,.42)" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${Number(nowX) + 5}" y="27" fill="var(--mu)" font-size="8.5" font-family="monospace">现在 ${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')} · 之后待发生</text>
      ${ticks}
    </svg>`;

    /* ---- 按模型今日 Top（最多 5 行） ---- */
    const byModel = (usage.byModel || []).slice(0, 5);
    const modelRows = byModel.map((m) => {
      const pct = Math.round((m.credit || 0) / Math.max(0.01, today.credit || 1) * 100);
      return `<div class="row" style="grid-template-columns:minmax(0,1fr) 64px 48px 66px">
        <span class="ell">${esc(m.model || m.id)}</span><span class="mono">${m.calls} 次</span><span class="mono muted">${m.errors || 0} 错</span><span class="mono">${fmtCredit(m.credit)}</span>
      </div>`;
    }).join('');

    /* ---- 事件流（最近 5 条，状态点按 kind/文本着色） ---- */
    const evDot = (e) => /失败|错误|401|耗尽|退出|漂移/.test(e.text) ? 'bd' : /领到|成功|启动|通过|签到/.test(e.text) ? 'ok' : /预警|过期|冷却|警告/.test(e.text) ? 'wn' : '';
    const evRows = (evts.events || []).slice(0, 5).map((e) => {
      const who = e.accountId && accNames[e.accountId] ? ' · ' + esc(accNames[e.accountId]) : '';
      const evTip = `${new Date(e.at).toLocaleString()} · ${e.text}${e.site ? ' · ' + e.site : ''}${e.accountId && accNames[e.accountId] ? ' · ' + accNames[e.accountId] : ''}`;
      return `<div class="row" title="${esc(evTip)}" style="grid-template-columns:6px 46px minmax(0,1fr)">
        <span class="p ${evDot(e)}"></span>
        <u class="mono muted" style="text-decoration:none">${new Date(e.at).toTimeString().slice(0, 5)}</u>
        <span class="ell">${esc(e.text)}${e.site ? ' · ' + esc(e.site) : ''}${who}</span>
      </div>`;
    }).join('');

    /* ---- 底部四卡：自动任务 / 诊断 / 需关注 / 近 7 日消耗 ---- */
    const doneOf = (map) => {
      const ok = Object.entries(map || {}).filter(([uid, e]) => e.ok && enabled.some((x) => (x.a.uid || x.a.id) === uid)).length;
      return { ok, total: enabled.length || 1 };
    };
    const ck = doneOf(tasks.checkin), gr = doneOf(tasks.growth), tv = doneOf(tasks.travel);
    const taskDone = [ck, gr, tv].filter((x) => x.ok >= x.total && x.total > 0).length;
    const dsum = (doctor && doctor.summary) || { pass: '—', warn: '—', fail: 0 };
    const concerns = [];
    for (const x of enabled) {
      if (String(x.a.lastError || '').includes('401')) concerns.push({ cls: 'bd', tag: '重登', text: `${accNames[x.a.id] || x.a.id} · 登录态失效（401）` });
      if (x.a.cooldownUntil && x.a.cooldownUntil > Date.now()) concerns.push({ cls: 'wn', tag: '冷却', text: `${accNames[x.a.id] || x.a.id} · 冷却至 ${new Date(x.a.cooldownUntil).toLocaleTimeString()}` });
      if (x.a.tokenExpiresAt || x.a.expiresAt) {
        const d = fmtDays(x.a.expiresAt);
        if (d !== null && d >= 0 && d <= 7) concerns.push({ cls: 'wn', tag: '重登', text: `${accNames[x.a.id] || x.a.id} · token ${d} 天后到期` });
      }
      for (const bt of (x.a.creditDetail || [])) {
        const d = fmtDays(bt.expireAt);
        if (d !== null && d < 0 && (bt.remain || 0) > 0) concerns.push({ cls: 'bd', tag: '过期', text: `${accNames[x.a.id] || x.a.id} · 「${esc(bt.package || '批次')}」已过期余 ${fmtCredit(bt.remain)}` });
      }
    }
    const concernRows = concerns.length
      ? concerns.slice(0, 3).map((c) => `<div class="row" style="grid-template-columns:6px minmax(0,1fr) auto"><span class="p ${c.cls}"></span><span class="ell">${c.text}</span><span class="tag ${c.cls}" data-go="tasks" title="点击进入任务/账号处理（重登=资源池重新扫码，过期=检查批次明细）" style="cursor:pointer">${c.tag}</span></div>`).join('')
      : '<div class="muted" style="padding:8px 2px">暂无异常 —— 一切正常</div>';
    const max7 = Math.max(0.01, ...recent.map((d) => d.credit || 0));
    const weekBars = recent.map((d, i) => `<i class="${d.date === today.date ? 'hi' : ''}" style="height:${Math.max(4, Math.round((d.credit || 0) / max7 * 100))}%;animation-delay:${80 + i * 60}ms" title="${esc(d.date)}：${fmtCredit(d.credit)} 积分 · ${d.calls} 次"></i>`).join('');
    const weekDates = `<div class="muted mono" style="font-size:10px;display:flex;gap:5px">${recent.map((d) => `<span style="flex:1;text-align:center">${d.date.slice(8)}</span>`).join('')}</div>`;
    const avg7 = recent.length ? (recent.reduce((s, d) => s + (d.credit || 0), 0) / recent.length) : 0;

    /* ---- 高屏追加行：模型速览 / 任务流水 / 日志尾（仅 min-height:1300px 显示） ---- */
    const mres = (modelsResp && modelsResp.data) || [];
    const topModels = mres.filter((x) => !x.pending_login).sort((a, b) => (a.multiplier ?? 99) - (b.multiplier ?? 99)).slice(0, 5);
    const modelQuick = topModels.map((m) => `<div class="row" style="grid-template-columns:minmax(0,1fr) 64px 62px">
        <span class="ell">${esc(m.id)}</span>
        <span class="mono" style="color:${m.multiplier === 0 ? 'var(--ok)' : (m.multiplier ?? 99) < 0.1 ? 'var(--cy)' : (m.multiplier ?? 99) > 1 ? 'var(--bd)' : 'var(--wn)'}">${m.multiplier === 0 ? 'x0.00' : m.multiplier != null ? 'x' + m.multiplier : '—'}</span>
        <span class="tag ${m.id === (modelsResp?.default_model || '') ? 'ok' : ''}">${m.id === (modelsResp?.default_model || '') ? '默认' : '可用'}</span>
      </div>`).join('');
    const taskFlow = (tasks.history || []).slice(0, 5).map((h) => `<div class="row" style="grid-template-columns:56px minmax(0,1fr) auto">
        <u class="mono muted" style="text-decoration:none">${new Date(h.at).toTimeString().slice(0, 5)}</u>
        <span class="ell">${esc(h.msg || ({ checkin: '每日签到', growth: '成长任务扫描', travel: '猫猫旅行巡逻' }[h.kind] || h.kind))}</span>
        <span class="tag ${h.ok ? 'ok' : 'bd'}">${h.ok ? '✓' : '✗'}${h.creditGained ? ' +' + h.creditGained : ''}</span>
      </div>`).join('');
    const wideRow = `
      <div class="wideonly">
        <div class="card" style="--c:#4F8CFF">
          <div class="h">模型速览 <span>${mres.filter((x) => !x.pending_login).length} 个 · 按倍率</span>
            <div class="r"><a data-go="models" style="cursor:pointer;color:var(--ac);font-size:12px">全部 →</a></div></div>
          ${modelQuick || '<div class="muted">暂无模型</div>'}
        </div>
        <div class="card" style="--c:#34D399">
          <div class="h">任务流水 <span>最近记录</span>
            <div class="r"><button class="btn" id="ovRunTasks">立即执行</button></div></div>
          ${taskFlow || '<div class="muted">今天还没有记录</div>'}
        </div>
        <div class="card" style="--c:#F5A524">
          <div class="h">最新事件 <span>系统 / 任务 / 账号</span>
            <div class="r"><a data-go="events" style="cursor:pointer;color:var(--ac);font-size:12px">全部 →</a></div></div>
          ${evRows || '<div class="muted">暂无事件</div>'}
        </div>
      </div>`;

    const changed = paint(el, `
      <div class="k4">${kpis}</div>
      <div class="g">
        <div class="card hv tilt an" style="--c:#7B5CFF;animation-delay:240ms">
          <div class="orbit"><i></i><u></u></div><div class="sheen"></div>
          <div class="h">积分池 <span>${enabled.length} 账号 · ${totalBatches} 有效批次 · 策略 ${esc(bridge.policy || 'expiry-first')}${totalDays !== null ? ' · 按速率 ≈' + totalDays + ' 天' : ''}</span>
            <div class="r"><a data-go="accounts" style="cursor:pointer;color:var(--ac);font-size:12px">账号管理 →</a></div></div>
          <div class="mid" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
            ${ringSvg}
            <div style="flex:1;min-width:220px">${accRows || '<div class="muted">还没有账号</div>'}</div>
          </div>
          <div style="margin-top:14px">
            <div class="muted" style="margin-bottom:6px">批次到期分布 <span class="mono">${totalBatches} 批 · 未来 90 天</span></div>
            <div class="tl">${tl}</div>
            <div class="tlx">${tlx}</div>
          </div>
        </div>
        <div class="card hv tilt an" style="--c:#22D3EE;animation-delay:300ms">
          <div class="h">实时遥测 <span>24h 调用频谱${peak.calls > 0 ? ' · 峰值 ' + String(peak.hour).padStart(2, '0') + ' 点 · ' + peak.calls + ' 次' : ' · 今日暂无调用'}</span></div>
          ${spectrum}
          <div class="h" style="margin:12px 0 6px">按模型 · 今日 <span>${byModel.length} 个模型</span></div>
          ${modelRows || '<div class="muted" style="padding:6px 2px">今天还没有调用</div>'}
          <div class="h" style="margin:12px 0 6px">事件流 <span>最近 5 条</span></div>
          <div class="ticker">${evRows || '<div class="muted" style="padding:6px 2px">暂无事件</div>'}</div>
        </div>
      </div>
      <div class="k4b">
        <div class="card hv tilt an" style="--c:#34D399;animation-delay:360ms">
          <div class="k">自动任务 · 今日</div>
          <div style="display:flex;gap:10px;align-items:baseline;margin:4px 0 6px"><span class="mono" style="font-size:22px">${taskDone}/3</span>
            <span class="tag ${ck.ok >= ck.total ? 'ok' : ''}" data-go="tasks" title="今日签到进度 · 点击查看任务详情与手动签到" style="cursor:pointer">签到 ${ck.ok}/${ck.total}</span>
            <span class="tag ${gr.ok >= gr.total ? 'ok' : ''}" data-go="tasks" title="今日成长任务进度 · 点击查看任务详情与手动扫描" style="cursor:pointer">成长 ${gr.ok}/${gr.total}</span></div>
          <div class="muted">时点：签到 ${esc(((bridge.tasks || {}).checkinTimes || []).join(' ') || '09/21 点')} · 成长 ${esc(((bridge.tasks || {}).growthTimes || []).join(' ') || '01/13 点')}</div>
        </div>
        <div class="card hv tilt an" style="--c:#4F8CFF;animation-delay:420ms">
          <div class="k">一键诊断</div>
          <div style="display:flex;gap:14px;align-items:center;margin:4px 0 6px">
            <span class="mono" style="font-size:20px;color:var(--ok);text-shadow:0 0 14px rgba(52,211,153,.5)">${dsum.pass}</span>
            <span class="mono" style="font-size:20px;color:var(--wn);text-shadow:0 0 14px rgba(245,165,36,.45)">${dsum.warn}</span>
            <span class="mono" style="font-size:20px;color:var(--mu)">${dsum.fail}</span>
            <span class="sp" style="flex:1"></span><button class="btn" id="ovDoctor">重新诊断</button>
          </div>
          <div class="muted">通过 / 警告 / 失败 · 与 /wbp-doctor 同源</div>
        </div>
        <div class="card hv tilt an" style="--c:#F5A524;animation-delay:480ms">
          <div class="k">需关注 <span class="mono" style="color:var(--mu)">${concerns.length} 项</span></div>
          ${concernRows}
        </div>
        <div class="card hv tilt an" style="--c:#22D3EE;animation-delay:540ms">
          <div class="k">近 7 日消耗 · 日均 ${fmtCredit(avg7)}</div>
          <div class="rowsplit">${weekBars || '<i style="height:4%"></i>'}</div>
          ${weekDates}
          <div class="muted" style="margin-top:4px">今日 ${fmtCredit(today.credit ?? 0)} <span style="color:var(--cy)">· ${today.calls ?? 0} 次调用</span></div>
        </div>
      </div>
      ${wideRow}`);

    if (changed) {
      /* 重绘时剥离 an 入场类：入场动画只配首绘，轮询重绘不整页动（用户反馈定时闪） */
      el.querySelectorAll('.an').forEach((n) => n.classList.remove('an'));
      /* count-up 数字（reduced-motion 下直接终值） */
      const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.querySelectorAll('[data-count]').forEach((n) => {
        const target = parseFloat(n.dataset.count), dec = parseInt(n.dataset.dec || '0', 10);
        if (REDUCE || n.textContent !== '0') { n.textContent = dec ? target.toFixed(dec) : Math.round(target).toLocaleString('en-US'); return; } // 重绘/降级：直接终值，不从 0 重跑（用户反馈「整页定时闪」）
        const dur = 850; let start = null;
        const step = (ts) => {
          if (start === null) start = ts;
          const p = Math.min(1, (ts - start) / dur);
          const val = target * (1 - Math.pow(1 - p, 3));
          n.textContent = dec ? val.toFixed(dec) : Math.round(val).toLocaleString('en-US');
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      /* 下钻（含 T49 focus 语义） */
      for (const a of el.querySelectorAll('[data-go]')) {
        a.onclick = () => { showView(a.dataset.go, a.dataset.focus || null); };
      }
      const doc2 = $('#ovDoctor'); if (doc2) doc2.onclick = async () => {
        doc2.disabled = true;
        try { const d = await api('/doctor'); toast(`诊断：${d.summary.pass} 通过 / ${d.summary.warn} 警告 / ${d.summary.fail} 失败`, d.summary.fail ? 'bad' : 'ok'); }
        catch (e) { toast('诊断失败：' + e.message, 'bad'); }
        doc2.disabled = false;
      };
      const rt = $('#ovRunTasks'); if (rt) rt.onclick = () => runTask('all');
    }
  } catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

/* ---------- 顶栏积分预警（所有页签常驻，60s 轮询；无命中不渲染） ---------- */
// T34：这三个阈值原先写死在这里，现由后端 /bridge 的 alerts 字段下发（config.alerts）。
// 取不到时回落到与旧硬编码相同的默认值——后端不可达时预警条仍能按老逻辑工作。
const ALERT_FALLBACK = { lowBalance: 200, expiryDays: 7, expiryMinAmount: 500 };
let ALERT_TH = { ...ALERT_FALLBACK };
const alLow = () => ALERT_TH.lowBalance;
const alDays = () => ALERT_TH.expiryDays;
const alMin = () => ALERT_TH.expiryMinAmount;

// T22：更新提示 12h 提一次（localStorage 节流，用户点「知道了」也顺延 12h）
async function loadUpdateAlert(items) {
  try {
    const u = await api('/update-check');
    if (!u.updateAvailable || !u.latest) return;
    const snoozeKey = 'wbUpdateSnooze';
    const snoozedUntil = Number(localStorage.getItem(snoozeKey) || 0);
    if (Date.now() < snoozedUntil) return;
    items.push(`<span class="alertbar orange" title="更新方式：ZCode 插件设置 → 浏览插件（先「刷新市场」再找更新按钮）">⬆️ 有新版本 v${esc(u.latest)}（当前 v${esc(u.local)}） <a href="#" id="updSnooze" style="color:inherit">知道了</a></span>`);
    setTimeout(() => {
      const s = document.getElementById('updSnooze');
      if (s) s.onclick = (ev) => { ev.preventDefault(); localStorage.setItem(snoozeKey, String(Date.now() + 12 * 3600e3)); loadAlerts(); };
    }, 0);
  } catch { /* 检查不了就静默 */ }
}

function accountRemainOf(a) {
  if (Array.isArray(a.creditDetail) && a.creditDetail.length) {
    return a.creditDetail.reduce((s, b) => s + (Number(b.remain) || 0), 0);
  }
  return Number.isFinite(Number(a.creditRemain)) ? Number(a.creditRemain) : null;
}

/* T44：按近 7 日日均消耗估算「还能用 N 天」（后端 burnout.mjs 同源的口径：余额 ÷ 日均）。
 * 日均拿不到（还没消耗过）或余额为 0 时返回 null —— 展示层直接不渲染，绝不猜个数。 */
function daysLeftOf(remain, dailyAvg) {
  const r = Number(remain), d = Number(dailyAvg);
  if (!Number.isFinite(r) || !Number.isFinite(d) || d <= 0 || r <= 0) return null;
  return Math.min(999, Math.round(r / d));
}

async function loadAlerts() {
  const el = $('#alerts');
  try {
    const b = await api('/bridge');
    // T34：阈值随 /bridge 一起下发，改配置后下一轮（≤60s）自动生效
    ALERT_TH = { ...ALERT_FALLBACK, ...(b.alerts || {}) };
    const items = [];
    // T13：每日积分预算预警（/bridge 里的 budget 状态，后端已做每天一次的提醒节流）
    if (b.budget && b.budget.enabled) {
      const bt = b.budget;
      const act = bt.mode === 'free' ? '已切免费模型' : bt.mode === 'pause' ? '新请求已被拒绝' : '仅提醒';
      const actTip = bt.mode === 'free' ? '；default/auto 请求已自动改道免费模型' : bt.mode === 'pause' ? '；所有新模型请求返回 429' : '';
      if (bt.exceeded) {
        items.push(`<span class="alertbar red" title="今日已消耗 ${fmtCredit(bt.spent)}/${fmtCredit(bt.budget)} 积分${actTip}">🔴 预算超限：今日 ${fmtCredit(bt.spent)}/${fmtCredit(bt.budget)} 积分（${act}）</span>`);
      } else if (bt.warn) {
        items.push(`<span class="alertbar orange" title="今日已消耗 ${fmtCredit(bt.spent)}/${fmtCredit(bt.budget)} 积分，已达预警线">🟠 预算预警：今日 ${fmtCredit(bt.spent)}/${fmtCredit(bt.budget)} 积分（${bt.percent}%）</span>`);
      }
    }
    const accName = (a) => esc(a.label || a.nickname || a.id);
    for (const s of b.sites || []) for (const a of s.accounts || []) {
      if (a.enabled === false) continue;
      const remain = accountRemainOf(a);
      if (remain !== null && remain <= alLow()) {
        items.push(`<span class="alertbar red" title="该账号余额仅剩 ${remain} 积分，继续消耗会触发换号/失败">🔴 余额不足：${accName(a)} 剩 ${remain} 积分</span>`);
      }
      if (String(a.lastError || '').includes('401')) {
        items.push(`<span class="alertbar red" title="token 已失效：重新 /wbp-login 扫码或 /wbp-import 导入本机登录态">🔴 登录态失效：${accName(a)}（${esc(s.label)}）</span>`);
      }
      for (const bt of a.creditDetail || []) {
        const d = fmtDays(bt.expireAt);
        if (d === null || d < 0 || d > alDays() || (bt.remain || 0) <= alMin()) continue;
        items.push(`<span class="alertbar orange" title="快到期的积分先用掉：保持 expiry-first 策略，或多发起调用消耗">${d === 0 ? '不到 1 天' : d + ' 天内'}到期还有 ${fmtCredit(bt.remain)} 积分（${accName(a)} · ${esc(bt.package || '积分包')}）</span>`);
      }
    }
    await loadUpdateAlert(items); // T22：更新提示并入同一预警条（无命中不占位）
    // T32：积分耗尽预测——到期前按当前速率用不完的批次，放最前面（最需要用户决策）
    const risks = (b.burnout && b.burnout.risks) || [];
    for (const r of risks.slice(0, 2)) {
      for (const bt of (r.batches || []).slice(0, 2)) {
        items.unshift(`<span class="alertbar orange" title="${esc(bt.advice || '')}">📉 预计用不完：${esc(r.label)} 的「${esc(bt.package || '积分包')}」到期时还剩约 ${fmtCredit(bt.wasteCredits)} 积分（剩 ${bt.daysLeft} 天）</span>`);
      }
    }
    el.innerHTML = items.slice(0, 6).join('');
  } catch { /* 服务重启中等下一轮 */ }
}

/* ---------- Tab 1：账号与积分 ---------- */
const POLICIES = [
  { id: 'expiry-first', name: '积分到期优先', desc: '最早到期且有余额的账号先用（推荐）' },
  { id: 'balance-first', name: '余额优先', desc: '余额多的账号先用' },
  { id: 'round-robin', name: '轮询均摊', desc: '最久未用的先用，均匀消耗' },
  { id: 'free-first', name: '免费优先', desc: 'default/auto 请求自动改道到倍率 x0 的免费模型，省积分' },
  { id: 'pinned', name: '固定账号', desc: '始终使用指定的账号' },
];

async function loadAccounts() {
  const el = $('#view-accounts');
  try {
    const [policy, bridge0] = await Promise.all([api('/policy'), api('/bridge')]);
    // 有账号但一个批次明细都没有（还没刷过）→ 自动刷一轮，让到期排序直接可用
    const hasAccount = (bridge0.sites || []).some((s) => (s.accounts || []).length);
    const anyDetail = (bridge0.sites || []).some((s) => (s.accounts || []).some((a) => Array.isArray(a.creditDetail) && a.creditDetail.length));
    let bridge = bridge0;
    if (hasAccount && !anyDetail) {
      try { await api('/credit/refresh', { method: 'POST' }); bridge = await api('/bridge'); } catch { /* 刷新失败先用缓存渲染 */ }
    }
    const sites = bridge.sites || [];
    const acctRows = {};
    for (const s of sites) {
      if (s.accounts.length) {
        const r = await api('/pool?site=' + encodeURIComponent(s.site) + '&credit=0');
        for (const a of r.accounts) acctRows[s.site + '/' + a.id] = a;
      }
    }

    const planItems = [];
    const defSite = sites.find((s) => s.policy_applies) || sites[0];
    if (defSite) for (const row of defSite.plan || []) {
      if (!row.enabled) continue;
      const d = fmtDays(row.earliestExpiry);
      planItems.push(`<span class="step"><b>${planItems.length + 1}</b>${esc(row.label)} · 余 ${row.remain == null ? '?' : fmtCredit(row.remain)}${d === null ? '' : ` · <span style="color:${expiryColor(row.earliestExpiry)}">${d <= 0 ? '已到期' : d + '天'}</span>`}</span><span class="arrow">→</span>`);
    }

    // T48：策略卡收进折叠（低频操作不占首屏），summary 常显当前策略名与消耗顺序入口
    const curPolicyName = (POLICIES.find((p) => p.id === policy.policy) || {}).name || policy.policy;
    let html = `
    <details class="secd">
      <summary>⚙ 调度策略 <span class="sub">当前：${esc(curPolicyName)} · 每 ${policy.creditRefreshMinutes} 分钟自动刷新明细 · 点击展开切换</span></summary>
      <div style="padding:4px 0 14px">
        <div class="muted" style="font-size:12px;margin-bottom:8px">决定多账号之间先用哪个积分</div>
        <div class="grid policies">${POLICIES.map((p) => `
          <div class="policy ${policy.policy === p.id ? 'on' : ''}" data-p="${p.id}">
            <b>${p.name}${policy.policy === p.id ? ' ✓' : ''}</b><span>${p.desc}</span>
            ${p.id === 'pinned' && policy.policy === 'pinned' ? pinnedSelect(sites, policy.pinnedAccountId) : ''}
          </div>`).join('')}
        </div>
        <div class="row" style="margin:16px 0 4px">
          <button class="btn primary" id="btnAdd">＋ 添加账号</button>
          <button class="btn" id="btnImport">⬇ 导入本机账号</button>
          <button class="btn" id="btnRefresh">↻ 刷新全部积分</button>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);cursor:pointer" title="已用完的批次不参与调度，默认隐藏；明细来自上游，刷新后仍会回来，所以只能隐藏不能删除">
            <input type="checkbox" id="chkShowSpent" ${localStorage.getItem('wbShowSpentBatches') === '1' ? 'checked' : ''}> 显示已耗尽批次
          </label>
          <span class="spacer"></span>
          <span class="muted" style="font-size:12px">消耗顺序（当前策略）：</span>
        </div>
        <div class="plan">${planItems.length ? planItems.join('') : '<span class="muted">暂无账号，先添加账号</span>'}</div>
      </div>
    </details>`;

    for (const s of sites) {
      // 卡片点击选择需要知道当前策略与固定目标：从 policy（对默认站点生效）取
      const s2 = { ...s, policy: policy.policy, pinned_account_id: policy.pinnedAccountId };
      html += `<h2>${esc(s.label)} <span class="sub">${esc(s.site)} · ${esc(s.accounts.length)} 个账号</span></h2>`;
      if (!s.accounts.length) {
        html += `<div class="empty">该站点还没有账号 —— 点上方「＋ 添加账号」，用微信扫码即可登录</div>`;
        continue;
      }
      html += `<div class="grid accts">${s2.plan.map((row) => acctCard(s2, row, acctRows[s.site + '/' + row.id] || {})).join('')}</div>`;
    }
    paint(el, html); // 内容没变就不重建 DOM：30s 轮询 + 20s SSE 推送不再引发账号页闪烁

    // 点卡片 = 固定使用该账号（再点一次取消，恢复自动调度）。
    // 只拦截点在卡片空白处；改名/启停/删除等按钮和下拉框照常工作。
    for (const card of el.querySelectorAll('[data-acct-card]')) {
      card.onclick = async (ev) => {
        if (ev.target.closest('button,select,[data-act],a,input')) return; // 内部控件不触发
        const { site: psite, id: pid } = card.dataset;
        const wasPinned = card.classList.contains('pinned');
        try {
          await api('/policy', { method: 'POST', body: { policy: wasPinned ? 'expiry-first' : 'pinned', pinnedAccountId: wasPinned ? null : pid } });
          toast(wasPinned ? '已取消固定，恢复自动调度' : '已固定使用该账号（再次点击卡片取消）', 'ok');
          loadAccounts();
        } catch (e) { toast('切换失败：' + e.message, 'bad'); }
      };
    }

    // 「显示已耗尽批次」偏好（localStorage 持久化，跨刷新/跨轮询保留）
    $('#chkShowSpent').onchange = (e) => {
      localStorage.setItem('wbShowSpentBatches', e.target.checked ? '1' : '0');
      loadAccounts();
    };

    $('#btnAdd').onclick = () => openLoginModal(sites);
    $('#btnImport').onclick = async () => {
      const b = $('#btnImport');
      b.textContent = '扫描本机中…';
      try {
        const r = await api('/local/import', { method: 'POST' });
        showImportModal(r);
        loadAccounts();
      } catch (e) { toast('导入失败：' + e.message, 'bad'); }
      b.textContent = '⬇ 导入本机账号';
    };
    $('#btnRefresh').onclick = async () => {
      $('#btnRefresh').textContent = '刷新中…';
      try { await api('/credit/refresh', { method: 'POST' }); toast('积分明细已刷新', 'ok'); } catch (e) { toast('刷新失败：' + e.message, 'bad'); }
      loadAccounts();
    };
    for (const p of el.querySelectorAll('.policy')) {
      p.onclick = async (ev) => {
        if (ev.target.closest('select')) return;
        let pinnedAccountId = policy.pinnedAccountId;
        if (p.dataset.p === 'pinned') {
          // 下拉框只在「当前策略已是 pinned」时渲染（见 pinnedSelect 的调用条件），
          // 所以从别的策略切过来时 sel 必然是 null —— 原实现直接报「还没有账号可固定」，
          // 用户被卡死在这里，且无法自行恢复（策略切不过去，下拉框就永远不会出现）。
          // 正确做法：没有下拉框就回落到第一个可用账号；真一个账号都没有才报错。
          const sel = p.querySelector('select');
          const fallback = (sites.find((s) => s.policy_applies) || sites[0] || {}).accounts?.[0]?.id || null;
          pinnedAccountId = sel ? sel.value : (policy.pinnedAccountId || fallback);
          if (!pinnedAccountId) { toast('还没有账号可固定，先添加账号', 'bad'); return; }
        }
        try { await api('/policy', { method: 'POST', body: { policy: p.dataset.p, pinnedAccountId } }); toast('策略已切换：' + (POLICIES.find((x) => x.id === p.dataset.p) || {}).name, 'ok'); } catch (e) { toast('切换失败：' + e.message, 'bad'); }
        loadAccounts();
      };
    }
    for (const sel of el.querySelectorAll('select[data-pinsite]')) {
      sel.onchange = async () => {
        try { await api('/policy', { method: 'POST', body: { policy: 'pinned', pinnedAccountId: sel.value || null } }); toast('固定账号已更新', 'ok'); } catch (e) { toast('失败：' + e.message, 'bad'); }
      };
      sel.onclick = (ev) => ev.stopPropagation();
    }
    for (const b of el.querySelectorAll('[data-act]')) bindAcctAction(b, loadAccounts);
  } catch (e) {
    paint(el, `<div class="empty">加载失败：${esc(e.message)}</div>`);
  }
}

function pinnedSelect(sites, current) {
  const def = sites.find((s) => s.policy_applies) || sites[0];
  if (!def || !def.accounts.length) return `<div class="muted" style="font-size:12px;margin-top:6px">（先添加账号）</div>`;
  return `<select data-pinsite="${esc(def.site)}" style="margin-top:8px;width:100%">${def.accounts.map((a) =>
    `<option value="${esc(a.id)}" ${a.id === current ? 'selected' : ''}>${esc(a.label || a.id)}</option>`).join('')}</select>`;
}

/**
 * 积分显示：最多两位小数，但整数不带 .00（上游余额本身是整数，
 * 硬补两位只会永远是 .00；小数只出现在消耗统计里，如 3.4）。
 */
function fmtCredit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return esc(String(v));
  return String(parseFloat(n.toFixed(2)));
}

function acctCard(site, row, raw) {
  const a = { ...row, ...(raw.id ? raw : {}) };
  // 与健康面板同一套状态判定（isUsable 语义）；账号卡习惯说「可用」不说「健康」
  const hs = healthState(a);
  const status = `<span class="badge ${hs.cls}">${hs.text === '健康' ? '可用' : hs.text}</span>`;
  // 「使用中」：后端用与真实调度相同的 pickAccount 算出的当前选中账号
  const inUse = site.active_account_id && a.id === site.active_account_id && a.enabled !== false
    ? '<span class="badge acc" title="当前调度策略选中的账号，下一次调用将消耗它的积分">使用中</span>' : '';
  const total = (a.creditDetail || []).reduce((s, b) => s + (b.remain || 0), 0);
  const rawBal = a.creditDetail && a.creditDetail.length ? total : (a.remain ?? a.credit ?? a.creditRemain);
  const bal = rawBal === null || rawBal === undefined ? null : fmtCredit(rawBal);
  // 批次渲染：有余额的批次始终显示；耗尽（余 0）批次默认完全隐藏——它们不参与调度，
  // 且明细每次刷新积分都从上游重建，本地删除无法持久，所以只提供显示开关（页头勾选框）。
  // 注意：耗尽批次的展示区不能放在卡片的可点击空白里触发固定策略，一律加 data-act 排除。
  const showSpent = localStorage.getItem('wbShowSpentBatches') === '1';
  const live = [], spent = [];
  for (const b of a.creditDetail || []) {
    ((b.remain || 0) > 0 ? live : spent).push(b);
  }
  const renderBatch = (b) => {
    const full = (b.remain || 0) + (b.used || 0);
    const w = full > 0 ? Math.round((b.remain || 0) / full * 100) : 0;
    // T32：耗尽预测——这批到期前按当前速率用不完，给标记 + 建议（点击可复制建议文案）
    const bo = b.burnout;
    const riskTag = bo && bo.willExpireUnused
      ? `<span class="badge warn" style="cursor:pointer" data-act="burnout-copy" data-advice="${esc(bo.advice || '')}" title="${esc(bo.advice || '')}">📉 预计用不完 ${fmtCredit(bo.wasteCredits)}</span>` : '';
    return `<div class="batch">
      <div class="l"><span class="muted">${esc(b.package || '积分包')}</span> ${riskTag}
      <span>余 <b>${fmtCredit(b.remain)}</b> · <span style="color:${expiryColor(b.expireAt)}">${esc(expiryText(b.expireAt))}</span></span></div>
      <div class="bar"><i style="width:${w}%;background:${expiryColor(b.expireAt)}"></i></div>
      ${riskTag ? `<div class="muted" style="font-size:12px;margin-top:2px">${esc(bo.advice || '')}</div>` : ''}
    </div>`;
  };
  const batches = (showSpent ? [...spent, ...live] : live).map(renderBatch).join('');
  const spentNote = (!showSpent && spent.length)
    ? `<div class="spent-toggle" data-act="spent-note" title="已用完的批次不参与调度、不扣积分；明细来自上游，刷新后仍在，故只提供隐藏">已隐藏 ${spent.length} 个已耗尽批次（页头勾选「显示已耗尽批次」可查看）</div>`
    : '';
  // 固定使用状态：策略为 pinned 且指向本账号（卡片点击选择的就是这个）
  const isPinned = site.policy === 'pinned' && site.pinned_account_id === a.id;
  const pinnedBadge = isPinned ? '<span class="badge acc" title="已固定使用：点击卡片可取消">📌 已固定</span>' : '';
  // T44：按速率还能用几天（余额 ÷ 近 7 日日均，/pool 已把 burnout 挂在账号上）+ 到期用不完预警
  const bo = a.burnout || {};
  const dl = daysLeftOf(rawBal, bo.dailyAvg);
  const dlTag = dl !== null ? `<span class="dltag" title="按近 7 日日均 ${fmtCredit(bo.dailyAvg)} 积分估算">≈${dl} 天</span>` : '';
  const boTag = bo.riskCount > 0 ? `<span class="badge warn" title="有 ${bo.riskCount} 个批次到期前按当前速率用不完">📉 到期预计浪费 ${fmtCredit(bo.totalWaste)}</span>` : '';
  return `<div class="acct ${a.enabled ? '' : 'off'} ${isPinned ? 'pinned' : ''}" data-acct-card data-site="${esc(site.site)}" data-id="${esc(a.id)}" title="点击固定使用该账号，再点一次恢复自动调度">
    <div class="hd"><b data-act="rename" data-site="${esc(site.site)}" data-id="${esc(a.id)}" title="点击改名">${esc(a.label || a.id)}</b>${pinnedBadge}${inUse}${a.is_default ? '<span class="badge acc">默认</span>' : ''}${status}<span class="spacer"></span><small class="muted">${esc(String(a.uid || '').slice(0, 8))}…</small></div>
    <div class="bal">${bal === null ? '<span class="muted" style="font-size:14px">余额未知</span>' : bal}<small>积分${dlTag}${boTag}${a.creditCheckedAt ? ' · 刷新于 ' + new Date(a.creditCheckedAt).toLocaleTimeString() : ''}</small></div>
    <div class="batches">${batches || (a.creditDetail && a.creditDetail.length ? '' : '<span class="muted" style="font-size:12px">暂无批次明细 —— 点「刷新全部积分」获取</span>')}</div>
    ${spentNote}
    ${a.manualExpireAt ? `<div style="font-size:12px" class="muted">手动到期兜底：<span class="warn">${esc(a.manualExpireAt)}</span></div>` : ''}
    ${a.lastError ? `<div style="font-size:12px" class="bad">最近错误：${esc(a.lastError)}</div>` : ''}
    <div class="acts">
      <button class="btn mini" data-act="pin" data-site="${esc(site.site)}" data-id="${esc(a.id)}">📌 固定使用</button>
      <button class="btn mini" data-act="enable" data-site="${esc(site.site)}" data-id="${esc(a.id)}" data-v="${a.enabled ? '0' : '1'}">${a.enabled ? '禁用' : '启用'}</button>
      <button class="btn mini" data-act="manual" data-site="${esc(site.site)}" data-id="${esc(a.id)}">到期兜底</button>
      <button class="btn mini" data-act="reset" data-site="${esc(site.site)}" data-id="${esc(a.id)}">重置状态</button>
      <span class="spacer"></span>
      <button class="btn mini danger" data-act="remove" data-site="${esc(site.site)}" data-id="${esc(a.id)}">删除</button>
    </div>
  </div>`;
}

function bindAcctAction(btn, done) {
  btn.onclick = async () => {
    const { act, site, id } = btn.dataset;
    try {
      if (act === 'rename') {
        const name = await askText('修改账号显示名', '', { placeholder: '留空则不改', okText: '保存' });
        if (name && name.trim()) await api('/pool/account', { method: 'POST', body: { site, id, label: name.trim() } });
      } else if (act === 'pin') {
        await api('/policy', { method: 'POST', body: { policy: 'pinned', pinnedAccountId: id } });
        toast('已固定使用该账号（策略 → pinned）', 'ok');
      } else if (act === 'enable') {
        await api('/pool/account', { method: 'POST', body: { site, id, enabled: btn.dataset.v === '1' } });
      } else if (act === 'reset') {
        await api('/pool/account', { method: 'POST', body: { site, id, reset: true } });
        toast('已清除耗尽/冷却标记', 'ok');
      } else if (act === 'manual') {
        const cur = btn.closest('.acct')?.querySelector('[data-manual]')?.textContent || '';
        const v = await askText('手动到期兜底', cur, { placeholder: 'YYYY-MM-DD，留空清除', okText: '保存' });
        if (v !== null) await api('/pool/account', { method: 'POST', body: { site, id, manualExpireAt: v.trim() } });
      } else if (act === 'remove') {
        if (!await askConfirm('确定删除该账号？', { okText: '删除' })) return;
        await api('/pool/account/remove', { method: 'POST', body: { site, id } });
      } else if (act === 'burnout-copy') {
        // T32：点「预计用不完」标记复制建议文案，方便贴到别处或照着安排任务
        copy(btn.dataset.advice || '', '已复制建议');
        return; // 纯前端操作，不触发重渲染
      }
      done();
    } catch (e) { toast('操作失败：' + e.message, 'bad'); }
  };
}

/* ---------- 登录弹窗（微信扫码） ---------- */
function closeModal() { $('#modalRoot').innerHTML = ''; }

/**
 * 取代原生 prompt() / confirm()。
 *
 * 为什么必须换：原生对话框在**内嵌浏览器**里不可用 —— ZCode 自带的 IAB 直接抛
 * "prompt() is not supported"，点「改名」「删除」毫无反应（连报错都没有），
 * 用户只当按钮坏了。2026-10-04 手操实测发现，一并影响到期兜底、清空用量、
 * 删除密钥、恢复备份共 6 处。项目本来就有 #modalRoot 弹窗机制（登录框在用），
 * 这里把输入/确认也收敛到同一套。
 *
 * 用法：
 *   const name = await askText('修改账号显示名', '');
 *   if (name === null) return;            // 用户取消
 *   if (await askConfirm('确定删除？')) {} // true=确认
 */
function askText(title, def = '', { placeholder = '', okText = '确定' } = {}) {
  return new Promise((resolve) => {
    $('#modalRoot').innerHTML = `<div class="modal" id="mAsk"><div class="box" style="width:420px">
      <h3>${esc(title)}</h3>
      <div class="fld"><input type="text" id="mAskIn" value="${esc(def)}" placeholder="${esc(placeholder)}" style="width:100%"></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="mAskOk">${esc(okText)}</button><span class="spacer"></span><button class="btn" id="mAskCancel">取消</button></div>
    </div></div>`;
    const inp = $('#mAskIn');
    inp.focus(); inp.select();
    const finish = (v) => { closeModal(); resolve(v); };
    $('#mAskOk').onclick = () => finish(inp.value);
    $('#mAskCancel').onclick = () => finish(null);
    $('#mAsk').onclick = (e) => { if (e.target.id === 'mAsk') finish(null); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') finish(inp.value); if (e.key === 'Escape') finish(null); };
  });
}

function askConfirm(title, { okText = '确定', danger = true } = {}) {
  return new Promise((resolve) => {
    $('#modalRoot').innerHTML = `<div class="modal" id="mAsk"><div class="box" style="width:400px">
      <h3>${esc(title)}</h3>
      <div class="row" style="margin-top:16px;justify-content:flex-end">
        <button class="btn ${danger ? 'danger' : 'primary'}" id="mAskOk">${esc(okText)}</button>
        <button class="btn" id="mAskCancel">取消</button>
      </div>
    </div></div>`;
    const finish = (v) => { closeModal(); resolve(v); };
    $('#mAskOk').onclick = () => finish(true);
    $('#mAskCancel').onclick = () => finish(false);
    $('#mAsk').onclick = (e) => { if (e.target.id === 'mAsk') finish(false); };
  });
}

function openLoginModal(sites) {
  const siteOpts = (sites || []).map((s) => `<option value="${esc(s.site)}">${esc(s.label)}</option>`).join('');
  $('#modalRoot').innerHTML = `<div class="modal" id="mWrap"><div class="box">
    <h3>添加 WorkBuddy 账号</h3>
    <div class="fld"><label>站点</label><select id="lgSite">${siteOpts}</select></div>
    <div class="fld"><label>备注名（可选，方便区分多个账号）</label><input type="text" id="lgLabel" placeholder="如：小号A"></div>
    <div class="row"><button class="btn primary" id="lgGo">生成登录二维码</button><span class="spacer"></span><button class="btn" id="lgCancel">取消</button></div>
    <div id="lgArea" style="margin-top:14px"></div>
  </div></div>`;
  $('#mWrap').onclick = (e) => { if (e.target.id === 'mWrap') stopLogin(); };
  $('#lgCancel').onclick = stopLogin;
  let pollT = null;

  function stopLogin() { clearInterval(pollT); closeModal(); }

  $('#lgGo').onclick = async () => {
    const site = $('#lgSite').value, label = $('#lgLabel').value.trim();
    const area = $('#lgArea');
    area.innerHTML = `<div class="muted"><span class="spin"></span>正在向上游申请授权…</div>`;
    try {
      const r = await api('/login/start', { method: 'POST', body: { site, label } });
      const qr = makeQR(r.authUrl);
      area.innerHTML = `
        <div id="qrBox">${qr}</div>
        <div class="qrhint">
          <b style="color:var(--text)">微信扫码登录：</b><br>
          ① 打开微信「扫一扫」，扫描上方二维码 → 在手机上打开授权页并登录确认；<br>
          ② 或点 <a href="${esc(r.authUrl)}" target="_blank" style="color:var(--accent)">在电脑浏览器打开授权页</a>，按页面提示用微信扫码登录。<br>
          登录完成后本窗口会自动检测到（最长等 10 分钟）。
        </div>
        <div id="lgStatus" class="muted"><span class="spin"></span>等待你在手机/浏览器上确认…</div>`;
      const t0 = Date.now();
      pollT = setInterval(async () => {
        try {
          const p = await api('/login/poll?site=' + encodeURIComponent(site));
          if (p.done) {
            clearInterval(pollT);
            $('#lgStatus').innerHTML = `<span class="ok">✅ 登录成功：${esc(p.label || p.nickname || p.account_id)}（该站点现有 ${p.account_count} 个账号）</span>`;
            toast('账号已添加，正在刷新积分明细…', 'ok');
            setTimeout(async () => { closeModal(); try { await api('/credit/refresh', { method: 'POST' }); } catch {} loadAccounts(); }, 1400);
            return;
          }
          const wait = Math.round((Date.now() - t0) / 1000);
          $('#lgStatus').innerHTML = `<span class="spin"></span>等待确认中（${wait}s）… 上游：${esc(p.msg || '待扫码').slice(0, 60)}`;
          if (Date.now() - t0 > 600000) { clearInterval(pollT); $('#lgStatus').innerHTML = '<span class="bad">等待超时，请重新生成二维码</span>'; }
        } catch (e) { /* 轮询报错继续等 */ }
      }, 3000);
    } catch (e) {
      area.innerHTML = `<div class="bad">发起登录失败：${esc(e.message)}</div>`;
    }
  };
}

function makeQR(text) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="170" height="170" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`;
    s += `<rect width="${n}" height="${n}" fill="#fff"/>`;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) s += `<rect x="${c}" y="${r}" width="1" height="1" fill="#111"/>`;
    return s + '</svg>';
  } catch {
    return `<div class="muted" style="color:#333;padding:60px 10px;text-align:center">二维码生成失败，请直接点击下方链接</div>`;
  }
}

/* ---------- 本机账号导入结果弹窗 ---------- */
function showImportModal(r) {
  const badge = (s) => s === 'imported' ? '<span class="badge ok">新增</span>'
    : s === 'updated' ? '<span class="badge acc">已更新</span>'
    : '<span class="badge">跳过</span>';
  $('#modalRoot').innerHTML = `<div class="modal" id="mWrap2"><div class="box">
    <h3>本机账号导入结果</h3>
    <p class="muted" style="font-size:12.5px;margin-top:0">扫描了 ${r.scannedFiles} 个客户端配置文件：新增 ${r.imported} · 更新 ${r.updated} · 跳过 ${r.skipped}</p>
    ${(r.found || []).map((f) => `<div class="card" style="padding:9px 13px;margin-bottom:8px">
      <div class="row"><b style="font-size:13px">${esc(f.nickname || f.uid)}</b>${badge(f.status)}<span class="spacer"></span><span class="badge">${esc(f.site)}</span></div>
      <div class="muted" style="font-size:12px;margin-top:3px">${esc(f.reason || '')}${f.exp ? ' · token 有效期至 ' + new Date(f.exp).toLocaleDateString() : ''}</div>
    </div>`).join('') || '<div class="empty" style="padding:14px">没有发现可导入的登录态 —— 需要本机装有已登录的 WorkBuddy / CodeBuddy 客户端</div>'}
    <div class="qrhint">本机导入的账号没有 refreshToken：token 到期后（客户端会自动续期）再点一次「导入本机账号」即可拿到新 token；服务每次启动也会自动重扫一次。若同账号已用扫码登录（支持自动续期），则不会被覆盖。</div>
    <div class="row"><span class="spacer"></span><button class="btn" id="imClose">关闭</button></div>
  </div></div>`;
  $('#imClose').onclick = () => $('#mWrap2').remove();
  $('#mWrap2').onclick = (e) => { if (e.target.id === 'mWrap2') $('#mWrap2').remove(); };
}

/* ---------- Tab 2：模型 ---------- */
async function loadModels() {
  const el = $('#view-models');
  try {
    const [m, h] = await Promise.all([api('/models'), api('/health').catch(() => null)]);
    const rows = (m.data || []).map((x) => {
      const mult = x.multiplier;
      const cap = [];
      if (x.free) cap.push('<span class="badge ok">0 扣费</span>');
      return `<tr>
        <td><b>${esc(x.id)}</b>${x.id === m.default_model ? ' <span class="badge acc">默认</span>' : ''}</td>
        <td>${esc(x.name)}</td><td><span class="badge">${esc(x.site)}</span></td>
        <td>${mult == null ? '—' : `<b>${mult === 0 ? '免费' : 'x' + mult}</b>`}</td>
        <td>${fmtK(x.context)}</td><td>${fmtK(x.max_output)}</td>
        <td class="cap" title="图片输入">${capBadge(x, 'image')}</td>
        <td class="cap" title="工具调用">${capBadge(x, 'tool')}</td>
        <td class="cap" title="推理模式">${capBadge(x, 'reason')}</td>
        <td>${x.pending_login ? '<span class="badge warn">站点未登录</span>' : `<button class="btn mini" data-m="${esc(x.id)}" data-s="${esc(x.site)}">设为默认</button>`}</td>
      </tr>`;
    }).join('');
    // 健康巡检（T8）：max_tokens=1 极小请求实测各模型，性价比榜 = 可用在前 → 倍率低 → 延迟低
    const hcfg = (h && h.config) || {};
    const hrows = ((h && h.results) || []).map((r) => `<tr${r.ok ? '' : ' style="opacity:.72"'}>
      <td><b>${esc(r.model)}</b></td>
      <td><span class="badge">${esc(r.site)}</span></td>
      <td>${r.mult === 0 ? '<b class="ok">免费</b>' : r.mult != null ? '<b>x' + r.mult + '</b>' : '—'}</td>
      <td>${r.ok ? `<b class="ok">${r.ms} ms</b>` : `<span class="bad" title="${esc(r.msg || '')}">✗ ${esc((r.msg || '不可用').slice(0, 50))}</span>`}</td>
    </tr>`).join('');
    paint(el, `
      <h2>模型清单 <span class="sub">来自上游目录 · 倍率越低越省积分 · 修改默认模型即时生效</span></h2>
      <div style="display:flex;align-items:center;gap:10px;margin:0 0 12px;flex-wrap:wrap">
        <button class="btn" id="btnPoolSync">⟳ 手动同步到选择器</button>
        <span class="muted" style="font-size:12px">自动每 30 分钟同步一次；上游刚加模型/改倍率时点这里立即写入 ZCode 模型选择器</span>
      </div>
      <div class="card" style="padding:0;overflow:auto">
      <table><thead><tr><th>模型 ID</th><th>名称</th><th>站点</th><th>积分倍率</th><th>上下文容量</th><th>最大输出</th><th title="支持图片输入">🖼️</th><th title="支持工具调用">🔧</th><th title="支持推理模式">🧠</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="10" class="muted" style="text-align:center;padding:24px">还没有可用模型 —— 先添加账号</td></tr>'}</tbody></table></div>
      <p class="muted" style="font-size:12px">ZCode 模型供应商里填任意模型 ID；这里的「设为默认」影响走 <code>default</code>/裸名自动路由的客户端。</p>
      <h2>健康巡检 <span class="sub">max_tokens=1 极小请求实测可用性与首帧延迟 · 排序：可用在前 → 倍率低优先 → 延迟低优先（性价比）</span></h2>
      <div class="card">
        <div class="row" style="flex-wrap:wrap;gap:10px;margin-bottom:10px">
          <button class="btn primary" id="btnScan">▶ 全量巡检</button>
          <span class="muted" style="font-size:12px">上次巡检：${h && h.lastScanAt ? esc(new Date(h.lastScanAt).toLocaleString()) : '还没巡检过'}${h && h.scanning ? ' · <span class="warn">巡检进行中…</span>' : ''}</span>
          <span class="spacer"></span>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px" title="开启后按右侧时点每天自动巡检一次；巡检按各模型倍率产生少量真实消耗（一轮 17 个模型 ≈ 0.1~0.5 积分），默认关闭">
            <input type="checkbox" id="hcEnabled" ${hcfg.enabled ? 'checked' : ''}> 定时巡检
          </label>
          <input id="hcTimes" value="${esc((hcfg.times || []).join(', '))}" placeholder="08:00" style="width:110px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
          <button class="btn mini" id="hcSave">保存定时设置</button>
        </div>
        <div class="row" style="margin-top:9px;padding-top:9px;border-top:1px solid var(--line)">
          <label style="display:flex;align-items:center;gap:5px;font-size:13px" title="T35 省钱模式：只巡检这写模型（逗号分隔，支持 * 前缀通配如 glm-*）。留空 = 全部模型都探。巡检是真实消耗，探得越少花得越少">
            <input type="checkbox" id="hcOnlyOn" ${(hcfg.only || []).length ? 'checked' : ''}> 只巡检指定模型
          </label>
          <input id="hcOnly" value="${esc((hcfg.only || []).join(', '))}" placeholder="如 glm-5.3-flash, kimi-*" style="width:260px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px" ${(hcfg.only || []).length ? '' : 'disabled'}>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px" title="只探倍率 0 的免费模型 —— 这批探起来不花积分。适合「只想知道免费模型还能不能用」">
            <input type="checkbox" id="hcOnlyFree" ${hcfg.onlyFree ? 'checked' : ''}> 只巡检免费模型（x0）
          </label>
          <button class="btn mini" id="hcSaveOnly">保存省钱模式</button>
          <span class="muted" id="hcOnlyNow" style="font-size:12px">${(hcfg.only || []).length || hcfg.onlyFree ? '当前：' + esc(((hcfg.only || []).length ? (hcfg.only || []).join('、') : '全部') + (hcfg.onlyFree ? '（且仅免费）' : '')) : '当前：全量巡检'}</span>
        </div>
        <div style="overflow:auto">${hrows ? `<table><thead><tr><th>模型</th><th>站点</th><th>倍率</th><th>状态 / 延迟</th></tr></thead><tbody>${hrows}</tbody></table>` : '<div class="muted" style="padding:16px;text-align:center">还没有巡检结果 —— 点「▶ 全量巡检」实测所有模型（约 10~30 秒）</div>'}</div>
      </div>`);
    $('#btnPoolSync').onclick = async () => {
      const b = $('#btnPoolSync');
      b.disabled = true; b.textContent = '同步中…';
      try {
        // /admin/* 走 apiKey 鉴权；控制台只有会话 TOKEN，所以借道 console-api 转发
        const r = await api('/pool-sync', { method: 'POST' });
        if (r.ok) toast(`已同步（${r.models ?? '?'} 个模型，${r.result === 'written' ? '有更新已写入' : '内容无变化'}）`, 'ok');
        else toast('同步失败：' + (r.message || r.error || '未知错误'), 'bad');
      } catch (e) { toast('同步失败：' + e.message, 'bad'); }
      b.disabled = false; b.textContent = '⟳ 手动同步到选择器';
    };
    for (const b of el.querySelectorAll('[data-m]')) {
      b.onclick = async () => {
        try { await api('/default-model', { method: 'POST', body: { model: b.dataset.m, site: b.dataset.s } }); toast('默认模型 → ' + b.dataset.m, 'ok'); loadHeader(); loadModels(); }
        catch (e) { toast('失败：' + e.message, 'bad'); }
      };
    }
    $('#btnScan').onclick = async () => {
      const b = $('#btnScan');
      b.disabled = true; b.textContent = '巡检中…（约 10~30 秒）';
      try {
        const r = await api('/health/scan', { method: 'POST' });
        if (r.ok) toast(`巡检完成：可用 ${r.okCount}/${r.total}`, 'ok');
        else toast('巡检失败：' + (r.error || '未知错误'), 'bad');
      } catch (e) { toast('巡检失败：' + e.message, 'bad'); }
      b.disabled = false; b.textContent = '▶ 全量巡检';
      loadModels();
    };
    $('#hcSave').onclick = async () => {
      try {
        const r = await api('/health/config', { method: 'POST', body: { enabled: $('#hcEnabled').checked, times: $('#hcTimes').value } });
        toast('巡检设置已保存：' + (r.config.enabled ? (r.config.times.length ? '每天 ' + r.config.times.join(' / ') + ' 自动巡检' : '已开启但未填时点（不会自动跑）') : '定时巡检已关闭'), 'ok');
      } catch (e) { toast('保存失败：' + e.message, 'bad'); }
    };
    // T35：省钱模式勾选框控制白名单输入框的可用态（没勾时输入也没意义，后端会当空数组）
    $('#hcOnlyOn').onchange = () => { $('#hcOnly').disabled = !$('#hcOnlyOn').checked; };
    $('#hcSaveOnly').onclick = async () => {
      try {
        const body = { onlyFree: $('#hcOnlyFree').checked };
        // 勾了「只巡检指定模型」才提交白名单；没勾就是清空（回到全量）
        body.only = $('#hcOnlyOn').checked ? $('#hcOnly').value : [];
        const r = await api('/health/config', { method: 'POST', body });
        const c = r.config;
        const desc = (c.only.length ? c.only.join('、') : '全部模型') + (c.onlyFree ? '（且仅免费 x0）' : '');
        toast('省钱模式已保存：下一轮巡检只探 ' + desc, 'ok');
        loadModels();
      } catch (e) { toast('保存失败：' + e.message, 'bad'); }
    };
  } catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}
function capBadge(x, kind) {
  const v = kind === 'image' ? x.supportsImages : kind === 'tool' ? x.supportsToolCall : x.supportsReasoning;
  return v ? '<span class="ok">✓</span>' : '<span class="muted">—</span>';
}

/* T48：把「<h2>标题 <span class=sub>副题</span></h2> 内容」的连续区块自动包成
 * details.secd 折叠分区（设置/用量这类区块多的子页面默认收起，summary 常显标题）。
 * openFirst=true 时第一个分区默认展开（接入页用——描述要求「默认只展开接入」）。
 * 按 <h2> 分段做纯文本包装，不解析嵌套：h2 之后到下一个 h2 之前的全部内容归该分区。 */
function secdWrap(html, openFirst = false) {
  let first = true;
  return html.split(/(?=<h2>)/).map((seg) => {
    if (!seg.startsWith('<h2>')) return seg;
    const end = seg.indexOf('</h2>');
    if (end < 0) return seg;
    const open = openFirst && first ? ' open' : '';
    first = false;
    return `<details class="secd"${open}><summary>${seg.slice(4, end)}</summary><div style="padding:4px 0 12px">${seg.slice(end + 5)}</div></details>`;
  }).join('');
}

/* ---------- Tab：接入指南（各客户端现成可复制的接入配置） ---------- */
async function loadGuide() {
  const el = $('#sec-guide');
  try {
    const c = await api('/zcode-config');
    const base = c.base_url;                          // OpenAI 兼容：…/v1
    const root = base.replace(/\/v1\/?$/, '');        // Anthropic 兼容：根路径
    const key = c.api_key;
    const model = c.model || 'default';
    const masked = key.length <= 10 ? '***' : key.slice(0, 6) + '…' + key.slice(-4);

    const snippets = [
      {
        id: 'claude', title: 'Claude Code', note: '写入 ~/.claude/settings.json（Windows: %USERPROFILE%\\.claude\\settings.json）',
        text: JSON.stringify({ env: { ANTHROPIC_BASE_URL: root, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model } }, null, 2),
      },
      {
        id: 'cline', title: 'Cline（VS Code）', note: '设置 → API Provider 选「OpenAI Compatible」',
        text: ['API Provider: OpenAI Compatible', 'Base URL: ' + base, 'API Key: ' + key, 'Model ID: ' + model].join('\n'),
      },
      {
        id: 'cherry', title: 'Cherry Studio', note: '设置 → 模型服务 → 添加「OpenAI 兼容」提供商',
        text: ['提供商类型: OpenAI 兼容', 'API Host: ' + base, 'API Key: ' + key, '模型（手动添加）: ' + model].join('\n'),
      },
      {
        id: 'dify', title: 'Dify', note: '设置 → 模型供应商 → 安装「OpenAI-API-compatible」',
        text: ['供应商: OpenAI-API-compatible', 'Base URL: ' + base, 'API Key: ' + key, '模型名称: ' + model, '', '提示：Dify 跑在 Docker 里时把 127.0.0.1 换成 host.docker.internal'].join('\n'),
      },
      {
        id: 'py', title: 'Python（openai SDK）', note: 'pip install openai',
        text: [
          'from openai import OpenAI',
          '',
          'client = OpenAI(',
          '    base_url="' + base + '",',
          '    api_key="' + key + '",',
          ')',
          '',
          'resp = client.chat.completions.create(',
          '    model="' + model + '",',
          '    messages=[{"role": "user", "content": "你好"}],',
          ')',
          'print(resp.choices[0].message.content)',
        ].join('\n'),
      },
      {
        id: 'js', title: 'Node.js（openai SDK）', note: 'npm install openai',
        text: [
          'import OpenAI from "openai";',
          '',
          'const client = new OpenAI({',
          '  baseURL: "' + base + '",',
          '  apiKey: "' + key + '",',
          '});',
          '',
          'const resp = await client.chat.completions.create({',
          '  model: "' + model + '",',
          '  messages: [{ role: "user", content: "你好" }],',
          '});',
          'console.log(resp.choices[0].message.content);',
        ].join('\n'),
      },
    ];

    paint(el, secdWrap(`
      <h2>本机接入参数 <span class="sub">本代理同时提供 OpenAI 与 Anthropic 两种兼容端点，API Key 即 config.json 的 apiKey</span></h2>
      <div class="card" style="margin-bottom:14px">
        <div class="row" style="gap:14px">
          <span><span class="badge acc">OpenAI 兼容</span> <code>${esc(base)}</code> <button class="btn mini" data-gcopy="${esc(base)}">复制</button></span>
          <span><span class="badge acc">Anthropic 兼容</span> <code>${esc(root)}</code> <button class="btn mini" data-gcopy="${esc(root)}">复制</button></span>
          <span><span class="badge acc">API Key</span> <code title="${esc(key)}">${esc(masked)}</code> <button class="btn mini" data-gcopy="${esc(key)}">复制</button></span>
          <span><span class="badge acc">模型 ID</span> <code>${esc(model)}</code> <button class="btn mini" data-gcopy="${esc(model)}">复制</button></span>
        </div>
        <div class="muted" style="font-size:12px;margin-top:9px">模型 ID 保持 <code>${esc(model)}</code> 最省心：以后切模型在「模型」页「设为默认」或会话里说一声即可，不用回客户端改配置。任何客户端拿下面任一段现成配置即可接入，改完无需重启本服务。</div>
      </div>
      ${snippets.map((s) => `
      <div class="card" style="margin-bottom:12px">
        <div class="row" style="margin-bottom:8px"><b>${esc(s.title)}</b><span class="muted" style="font-size:12px">${esc(s.note)}</span><span class="spacer"></span><button class="btn mini" data-gsnippet="${s.id}">⧉ 复制整段配置</button></div>
        <pre id="g-${s.id}">${esc(s.text)}</pre>
      </div>`).join('')}`, true));

    for (const b of el.querySelectorAll('[data-gcopy]')) {
      b.onclick = () => navigator.clipboard?.writeText(b.dataset.gcopy).then(() => toast('已复制：' + b.dataset.gcopy, 'ok')).catch(() => {});
    }
    for (const b of el.querySelectorAll('[data-gsnippet]')) {
      b.onclick = () => {
        const s = snippets.find((x) => x.id === b.dataset.gsnippet);
        navigator.clipboard?.writeText(s.text).then(() => toast('已复制 ' + s.title + ' 配置', 'ok')).catch(() => {});
      };
    }
  } catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

/* ---------- Tab 3：自动任务 ---------- */
async function loadTasks() {
  const el = $('#view-tasks');
  try {
    const [t, bridge] = await Promise.all([api('/tasks'), api('/bridge')]);
    const cfg = bridge.tasks || {};
    const labelOf = {};
    for (const s of bridge.sites || []) for (const a of s.accounts || []) labelOf[a.uid || a.id] = a.label || a.id;
    const one = (label, map) => {
      const entries = Object.entries(map || {});
      if (!entries.length) return `<div class="empty" style="padding:14px">${label}：今天还没有记录</div>`;
      return `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${entries.map(([uid, e]) => `
        <div class="card" style="padding:11px 14px">
          <div class="row"><span class="badge ${e.ok ? 'ok' : 'bad'}">${e.ok ? '✓' : '✗'} ${esc(e.date || '')}</span><b style="font-size:13px">${esc(labelOf[uid] || uid.slice(0, 10) + '…')}</b></div>
          <div class="muted" style="font-size:12px;margin-top:4px">${esc(e.msg || (e.claimed != null ? `报名 ${e.accepted} · 代打 ${e.autoChats ?? 0} · 领奖 ${e.claimed} · +${e.creditGained} 积分${(e.autoTasks || []).length ? '（' + e.autoTasks.join('、') + '）' : ''}${(e.autoNotes || []).length ? '。' + e.autoNotes.join('；') : ''}` : ''))}</div>
        </div>`).join('')}</div>`;
    };
    // 0.3.22 布局：操作行置顶 → 任务中心 → 今日执行（三合一）→ 日历+白嫖统计并排 → 最近记录 → 配置折叠
    const listTimesTxt = (cfg.listTimes || []).join(' / ') || '未设置';
    const html = `
      <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:14px">
        <label class="tkswitch" title="总开关关闭后整个任务调度循环停止（签到/成长/旅行/列表预取都不跑）；手动按钮仍可用">
          <input type="checkbox" id="tkEnabled" ${cfg.enabled === false ? '' : 'checked'}> 自动任务总开关
        </label>
        <label class="tkswitch" title="关闭后每天不再自动签到（runTasks 现读配置，保存即生效）">
          <input type="checkbox" id="tkCheckinOn" ${cfg.checkin === false ? '' : 'checked'}> 每日签到
        </label>
        <label class="tkswitch" title="关闭后每天不再自动扫描成长任务（报名/代打/领奖）">
          <input type="checkbox" id="tkGrowthOn" ${cfg.growth === false ? '' : 'checked'}> 成长任务
        </label>
        <span class="spacer"></span>
        <button class="btn" id="tkCheckin">立即签到</button>
        <button class="btn" id="tkGrowth">扫描成长任务</button>
        <button class="btn" id="tkTravel">🐾 猫猫旅行巡逻</button>
      </div>
      <h2>全部账号任务总览 <span class="sub">T48 · 每账号一行：任务数 / 待领 / 可代打（数据走服务端缓存，不实时打上游）· 点行展开下方详情</span></h2>
      <div class="card" id="tcOverview" style="margin-bottom:14px"></div>
      <h2>任务中心 <span class="sub">列表不再实时轮询：每日 ${esc(listTimesTxt)} 自动刷新（下方设置可改时点），平时显示缓存数据，需要最新点「手动刷新」</span></h2>
      <div class="card" style="margin-bottom:14px">
        <div class="row" style="flex-wrap:wrap;gap:10px">
          <select id="tcAccount" style="min-width:220px"></select>
          <button class="btn" id="tcReload">↻ 手动刷新</button>
          <span class="muted" id="tcStatus" style="font-size:12px"></span>
        </div>
        <div id="tcList" style="margin-top:12px"></div>
      </div>
      <h2>今日执行 <span class="sub">${esc(t.today)} · 自动报名 + 对话类代打 + 达标领奖 + 猫猫到站领奖</span></h2>
      <div class="card" style="margin-bottom:14px;display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start">
        <div style="flex:1;min-width:280px"><div style="font-weight:600;font-size:13px;margin-bottom:8px">签到</div>${one('签到', t.checkin)}</div>
        <div style="flex:1;min-width:280px"><div style="font-weight:600;font-size:13px;margin-bottom:8px">成长任务</div>${one('成长任务', t.growth)}</div>
        <div style="flex:1;min-width:280px"><div style="font-weight:600;font-size:13px;margin-bottom:8px">猫猫旅行</div>${one('猫猫旅行', t.travel)}</div>
      </div>
      <div class="row" style="flex-wrap:wrap;gap:14px;align-items:stretch;margin-bottom:14px">
        <div class="card" id="checkinCal" style="margin-bottom:0"></div>
        <div style="flex:1;min-width:320px">
          <div style="font-weight:600;font-size:13px;margin-bottom:8px">累计白嫖统计 <span class="sub">自动任务领到的积分合计（不含签到积分）</span></div>
          <div class="grid kpis" id="gainedKpis"></div>
        </div>
      </div>
      <h2>最近记录</h2>
      <div class="card" style="padding:0">${(t.history || []).length ? `<table><tbody>${t.history.slice(0, 15).map((h) => `
        <tr><td style="width:120px" class="muted">${esc(new Date(h.at).toLocaleString())}</td>
        <td style="width:70px"><span class="badge ${h.kind === 'checkin' ? 'acc' : h.kind === 'travel' ? 'warn' : 'ok'}">${{ checkin: '签到', growth: '成长', travel: '旅行' }[h.kind] || h.kind}</span></td>
        <td><span class="${h.ok ? 'ok' : 'bad'}">${h.ok ? '✓' : '✗'}</span> ${esc(h.msg || `报名${h.accepted ?? 0} 代打${h.autoChats ?? 0} 领奖${h.claimed ?? 0} +${h.creditGained ?? 0}分${(h.autoNotes || []).length ? '。' + h.autoNotes.join('；') : ''}`)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="muted" style="padding:18px;text-align:center">还没有运行记录</div>'}</div>
      <details style="margin-top:14px">
        <summary style="cursor:pointer;user-select:none;font-weight:600;font-size:14px;padding:6px 0">⚙ 任务与预算设置 <span class="sub">签到 / 成长 / 旅行 / 列表刷新时点 · 代打 · 每日预算</span></summary>
        <div class="card" style="margin-top:10px;margin-bottom:14px">
          <div class="row" style="flex-wrap:wrap;gap:10px">
            <label style="display:flex;align-items:center;gap:6px;font-size:13px">签到时点
              <input id="tkCheckinTimes" value="${esc((cfg.checkinTimes || []).join(', '))}" placeholder="09:00, 21:30" style="width:170px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px">成长任务时点
              <input id="tkGrowthTimes" value="${esc((cfg.growthTimes || []).join(', '))}" placeholder="01:00, 13:20" style="width:170px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px" title="派猫猫旅行巡逻时点：到站自动领奖、空闲自动派出（每日 1 次上限由上游控制）、旅行中跳过；状态机幂等，一天可巡逻多次">
              旅行巡逻时点
              <input id="tkTravelTimes" value="${esc((cfg.travelTimes || []).join(', '))}" placeholder="09:00, 15:00, 21:00" style="width:190px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px" title="任务中心列表每天在这些时点从上游预取一次（服务端缓存）；留空则关闭自动预取，仅剩手动刷新与打开页面按需拉取">
              列表刷新时点
              <input id="tkListTimes" value="${esc((cfg.listTimes || []).join(', '))}" placeholder="09:00, 15:00, 21:00" style="width:190px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px">旅行地点 ID
              <input id="tkTravelLoc" type="number" min="1" max="99" value="${cfg.travelLocationId ?? 4}" style="width:64px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;align-items:center;gap:5px;font-size:13px" title="成长任务里的「体验指定模型 / 聊天N次」类任务，由桥接代打极小请求点亮进度（单任务每次最多代打次数见右侧数字）；公众号关注等人工任务无法代打">
              <input type="checkbox" id="tkAuto" ${cfg.autoComplete === false ? '' : 'checked'}> 自动完成对话体验类任务
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px">单任务代打上限
              <input id="tkMaxChats" type="number" min="1" max="20" value="${cfg.maxChatsPerTask ?? 5}" style="width:64px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
            </label>
            <button class="btn" id="tkSaveCfg">保存设置</button>
          </div>
          <div class="muted" style="font-size:12px;margin-top:8px">旧配置里的整点小时（checkinHours/growthHours）在时点留空时仍然生效。每天每类任务最多执行一次；抖动 ±${cfg.jitterMinutes ?? 0} 分钟。</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div class="row" style="flex-wrap:wrap;gap:10px">
            <b style="font-size:13px">每日积分预算</b>
            <label style="display:flex;align-items:center;gap:5px;font-size:13px" title="按用量页同源的估算口径累计今日消耗；超过预警线提醒，超限且模式为「自动切免费」时 default/auto 改道免费模型">
              <input type="checkbox" id="bdEnabled" ${cfg.budget?.enabled ? 'checked' : ''}> 启用
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px">每日预算（积分）
              <input id="bdDaily" type="number" min="1" step="1" value="${cfg.budget?.dailyCredits ?? 100}" style="width:90px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px" title="达到该比例时顶栏预警 + 桌面通知（每天最多一次）">预警线（%）
              <input id="bdWarn" type="number" min="1" max="99" value="${cfg.budget?.warnPercent ?? 80}" style="width:70px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px" title="warn=只提醒；free=超预算后 default/auto 自动改道到免费模型（不拦显式指定的模型）；pause=超预算后直接拒绝所有新模型请求（429），防失控烧积分">超限动作
              <select id="bdMode" style="padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
                <option value="warn" ${cfg.budget?.mode === 'warn' || !cfg.budget?.mode ? 'selected' : ''}>仅提醒</option>
                <option value="free" ${cfg.budget?.mode === 'free' ? 'selected' : ''}>自动切免费模型</option>
                <option value="pause" ${cfg.budget?.mode === 'pause' ? 'selected' : ''}>暂停新请求（429）</option>
              </select>
            </label>
            <button class="btn" id="bdSave">保存预算</button>
            <span class="muted" id="bdNow" style="font-size:12px"></span>
          </div>
          <div class="muted" style="font-size:12px;margin-top:8px">预算口径与「用量」页一致（上游没报积分时按倍率×tokens 估算）；「自动切免费」不影响显式指定的模型，「暂停新请求」则会拦下所有模型请求（含显式指定）。</div>
        </div>
      </details>`;
    const changed = paint(el, html);
    // T48：全账号任务总览（有缓存立即画，没有就拉——loadTcSummary 完成后按 active 回填）
    renderTcOverview();
    void loadTcSummary();
    // ---- T15：签到日历（最近 8 周热力格）——只在页面真的重建时重画 ----
    if (changed) {
    const calEl = $('#checkinCal');
    {
      const days = t.checkinDays || {};
      const totalAccounts = new Set();
      for (const s of bridge.sites || []) for (const a of s.accounts || []) totalAccounts.add(a.uid || a.id);
      const accCount = Math.max(1, totalAccounts.size);
      const today = new Date();
      const cells = [];
      // 8 周 = 56 天，从 55 天前到今天；前端补齐每天一格
      const start = new Date(today); start.setDate(start.getDate() - 55);
      // 让第一列对齐周一：把 start 往前推到本周一（getDay(): 0=周日）
      const dow = (d) => (d.getDay() === 0 ? 6 : d.getDay() - 1);
      start.setDate(start.getDate() - dow(start));
      const p2 = (n) => String(n).padStart(2, '0');
      const keyOf = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      for (let i = 0; i < 64; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const k = keyOf(d);
        const n = (days[k] || []).length;
        const future = d > today;
        const color = future ? 'transparent'
          : n === 0 ? 'var(--chip)'
          : n >= accCount ? 'var(--ok)'
          : 'rgba(63,185,111,.4)';
        const title = future ? '' : `${k}：${n ? n + '/' + accCount + ' 个账号已签到' : '未签到'}`;
        cells.push(`<i title="${esc(title)}" style="width:13px;height:13px;border-radius:3px;background:${color};${future ? 'visibility:hidden' : ''}"></i>`);
      }
      calEl.innerHTML = `<div style="font-weight:600;font-size:13px;margin-bottom:8px">签到日历 <span class="sub">最近 8 周 · 绿格 = 全部账号已签到</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:3px;max-width:220px">${cells.join('')}</div>
        <div class="muted" style="font-size:11.5px;margin-top:8px">深绿 = 当天全部账号签到 · 浅绿 = 部分账号 · 灰 = 未签到 · 最多保留 120 天记录</div>`;
    }
    }
    // ---- T15：累计白嫖 KPI（同上，仅重建时重画）----
    if (changed) {
      const g = t.gainedTotal || { credit: 0, checkins: 0, claims: 0, travels: 0 };
      $('#gainedKpis').innerHTML = `
        <div class="kpi"><b class="ok">${fmtCredit(g.credit ?? 0)}</b><span>成长任务+旅行领回积分</span></div>
        <div class="kpi"><b>${g.checkins ?? 0}</b><span>累计签到（账号·天）</span></div>
        <div class="kpi"><b>${g.claims ?? 0}</b><span>累计领奖次数</span></div>
        <div class="kpi"><b>${g.travels ?? 0}</b><span>猫猫旅行归来次数</span></div>`;
    }
    // ---- T14：任务中心 —— 账号下拉只在页面重建时重排；列表渲染走 renderTcList（缓存数据，不在轮询路径）----
    if (changed) {
      const tcSel = $('#tcAccount');
      const accOptions = [];
      for (const s of bridge.sites || []) for (const a of s.accounts || []) {
        if (a.enabled === false) continue;
        accOptions.push({ site: s.site, id: a.id, label: `${a.label || a.id}（${esc(s.label)}）` });
      }
      tcSel.innerHTML = accOptions.map((o) => `<option value="${esc(o.site)}|${esc(o.id)}">${o.label}</option>`).join('') || '<option value="">（没有账号）</option>';
      const lastTc = localStorage.getItem('wbTcAccount');
      if (lastTc && accOptions.some((o) => o.site + '|' + o.id === lastTc)) tcSel.value = lastTc;
      tcSel.onchange = () => { localStorage.setItem('wbTcAccount', tcSel.value); loadTaskCenter({ spinner: true }); };
      $('#tcReload').onclick = () => loadTaskCenter({ force: true, spinner: true });
      if (accOptions.length) renderTcList(); // 回填最近一次数据（showView 的按需拉取稍后自动覆盖）
      else $('#tcList').innerHTML = '<div class="empty" style="padding:14px">没有可用账号</div>';
    }

    if (changed) {
    // T42：任务页三个自动任务开关（与大屏 ovTk* 共用 bindTaskSwitch）
    for (const [id, key] of [['tkEnabled', 'enabled'], ['tkCheckinOn', 'checkin'], ['tkGrowthOn', 'growth']]) {
      bindTaskSwitch(id, key, () => { if (active === 'home') loadOverview(); });
    }
    $('#tkCheckin').onclick = () => runTask('checkin');
    $('#tkGrowth').onclick = () => runTask('growth');
    $('#tkTravel').onclick = () => runTask('travel');
    $('#bdSave').onclick = async () => {
      try {
        const r = await api('/budget', { method: 'POST', body: {
          enabled: $('#bdEnabled').checked,
          dailyCredits: Number($('#bdDaily').value) || 100,
          warnPercent: Number($('#bdWarn').value) || 80,
          mode: $('#bdMode').value,
        } });
        const bt = r.budget || {};
        toast(`预算已保存：${bt.enabled ? '今日 ' + fmtCredit(bt.spent) + '/' + fmtCredit(bt.budget) + '（' + bt.percent + '%）' : '已关闭'}`, 'ok');
        loadAlerts();
      } catch (e) { toast('保存失败：' + e.message, 'bad'); }
    };
    api('/budget').then((bt) => {
      if (!$('#bdNow')) return;
      $('#bdNow').textContent = bt.enabled ? `当前：今日 ${fmtCredit(bt.spent)}/${fmtCredit(bt.budget)}（${bt.percent}%）` : '当前未启用';
    }).catch(() => {});
    $('#tkSaveCfg').onclick = async () => {
      try {
        const r = await api('/tasks/config', { method: 'POST', body: {
          checkinTimes: $('#tkCheckinTimes').value,
          growthTimes: $('#tkGrowthTimes').value,
          travelTimes: $('#tkTravelTimes').value,
          listTimes: $('#tkListTimes').value,
          travelLocationId: Number($('#tkTravelLoc').value) || 4,
          autoComplete: $('#tkAuto').checked,
          maxChatsPerTask: Number($('#tkMaxChats').value) || 5,
        } });
        toast('任务设置已保存：签到 ' + (r.saved.checkinTimes.join(', ') || '(整点回退)') + ' · 列表刷新 ' + (r.saved.listTimes.join(', ') || '(关)'), 'ok');
      } catch (e) { toast('保存失败：' + e.message, 'bad'); }
    };
    } // end if (changed)

    // 任务中心列表不属于轮询/SSE 刷新路径：只有页面真的重建时才用最近一次数据即时回填（不重新拉上游）
    if (changed && lastTcData) renderTcList();
  } catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}
/* ---------- T14：任务中心（缓存视图 + 手动刷新 + 单任务代打/领奖） ----------
 * 0.3.22：列表不再跟随 30s 轮询 / SSE 实时拉取。调用时机只剩：
 *   进入任务页（读服务端缓存，过期才拉上游）/ 切换账号 / 手动刷新(force) / 代打领奖后(force)。
 * lastTcData 保存最近一次响应，页面因数据变化重建后用它即时回填，不产生新的上游请求。 */
let lastTcData = null;

async function loadTaskCenter({ force = false, spinner = false } = {}) {
  const sel = $('#tcAccount');
  if (!sel) return;
  const v = sel.value || '';
  const [site, accountId] = v.split('|');
  const listEl = $('#tcList'), st = $('#tcStatus');
  if (!site || !accountId) { if (listEl) listEl.innerHTML = ''; return; }
  localStorage.setItem('wbTcAccount', v);
  if (spinner && st) st.innerHTML = '<span class="spin"></span>读取中…';
  try {
    const r = await api('/task-center?site=' + encodeURIComponent(site) + '&accountId=' + encodeURIComponent(accountId) + (force ? '&refresh=1' : ''));
    lastTcData = r;
    renderTcList();
  } catch (e) {
    if (st) st.textContent = '';
    if (listEl) listEl.innerHTML = `<div class="empty" style="padding:14px">加载失败：${esc(e.message)}</div>`;
  }
}

function renderTcList() {
  const listEl = $('#tcList'), st = $('#tcStatus');
  if (!listEl || !lastTcData) return;
  const v = ($('#tcAccount') || {}).value || '';
  const [site, accountId] = v.split('|');
  const tasks = lastTcData.tasks || [];
  if (st) {
    const at = lastTcData.cachedAt ? new Date(lastTcData.cachedAt).toLocaleTimeString() : '';
    const times = (lastTcData.listTimes || []).join(' / ');
    st.textContent = `${tasks.length} 个任务 · 达标待领 ${tasks.filter((x) => x.claimable).length} · 已领 ${tasks.filter((x) => x.claimed).length}`
      + (at ? ` · 数据 ${at}${lastTcData.fromCache ? '（缓存）' : ''}` : '')
      + (times ? ` · 每日自动刷新 ${times}` : '');
  }
  if (!tasks.length) { listEl.innerHTML = '<div class="empty" style="padding:14px">上游没有返回任务（可能活动未开放）</div>'; return; }
  listEl.innerHTML = tasks.map((x) => {
    const pct = x.target > 0 ? Math.min(100, Math.round(x.current / x.target * 100)) : 0;
    const state = x.claimed ? '<span class="badge ok">已领奖</span>'
      : x.claimable ? '<span class="badge warn">可领奖</span>'
      : x.locked ? '<span class="badge">未解锁</span>'
      : x.acceptStatus !== 'accepted' ? '<span class="badge">未报名</span>'
      : '<span class="badge acc">进行中</span>';
    return `<div style="padding:9px 0;border-bottom:1px solid var(--line)">
      <div class="row" style="margin-bottom:5px">
        <b style="font-size:13px">${esc(x.title)}</b>${state}
        ${x.credit ? `<span class="badge ok">+${x.credit} 积分</span>` : ''}
        ${x.autoplayable ? `<span class="badge" title="可由桥接代打（模型 ${esc(x.autoplayModel || 'default')}）">🤖 可代打</span>` : (x.autoplayBlockedReason ? `<span class="badge" title="${esc(x.autoplayBlockedReason)}">🤖 ${esc(x.autoplayBlockedReason)}</span>` : '')}
        <span class="spacer"></span>
        <span class="muted" style="font-size:12px">${x.target ? `${x.current}/${x.target}` : ''}</span>
        ${x.autoplayable && !x.claimable ? `<button class="btn mini" data-tcplay="${esc(x.code)}" data-need="${x.remain}">代打</button>` : ''}
        ${x.claimable ? `<button class="btn mini primary" data-tcclaim="${esc(x.code)}">领奖</button>` : ''}
      </div>
      ${x.target ? `<div style="height:6px;border-radius:3px;background:var(--chip);overflow:hidden"><i style="display:block;height:100%;width:${pct}%;background:${pct >= 100 ? 'var(--ok)' : 'var(--accent)'}"></i></div>` : ''}
    </div>`;
  }).join('');
  for (const b of listEl.querySelectorAll('[data-tcplay]')) {
    b.onclick = async () => {
      b.disabled = true; b.textContent = '代打中…';
      try {
        const r2 = await api('/task-center/play', { method: 'POST', body: { site, accountId, code: b.dataset.tcplay } });
        toast(r2.msg || (r2.ok ? '代打完成' : '代打未执行'), r2.ok ? 'ok' : 'bad');
      } catch (e) { toast('代打失败：' + e.message, 'bad'); }
      b.disabled = false; b.textContent = '代打';
      loadTaskCenter({ force: true });
    };
  }
  for (const b of listEl.querySelectorAll('[data-tcclaim]')) {
    b.onclick = async () => {
      b.disabled = true; b.textContent = '领奖中…';
      try {
        const r2 = await api('/task-center/claim', { method: 'POST', body: { site, accountId, code: b.dataset.tcclaim } });
        toast(r2.msg || '已领奖', r2.ok ? 'ok' : 'bad');
      } catch (e) { toast('领奖失败：' + e.message, 'bad'); }
      b.disabled = false; b.textContent = '领奖';
      loadTaskCenter({ force: true });
    };
  }
}

async function runTask(kind) {
  toast('正在执行：' + ({ checkin: '签到', growth: '成长任务扫描', travel: '猫猫旅行巡逻' }[kind] || kind) + ' …');
  try {
    const r = await api('/tasks/run', { method: 'POST', body: { kind } });
    const parts = [];
    for (const [k, list] of Object.entries(r.results || {})) parts.push(`${k}: 成功${list.filter((x) => x.ok && !x.skipped).length} 跳过${list.filter((x) => x.skipped).length} 失败${list.filter((x) => x.ok === false).length}`);
    toast('执行完成 —— ' + parts.join('；'), 'ok');
    loadTasks();
    loadTaskCenter({ force: true }); // 手动执行会改变上游任务进度，强制刷一次当前账号的列表
  } catch (e) { toast('执行失败：' + e.message, 'bad'); }
}

/* ---------- Tab 4：用量 ---------- */
async function loadUsage() {
  const el = $('#view-usage');
  try {
    const [u, rr, bridge, cc] = await Promise.all([
      api('/usage?days=7'),
      api('/recent-requests').catch(() => ({ requests: [] })),
      api('/bridge').catch(() => null),
      api('/compressions').catch(() => null),
    ]);
    // 账号 id → 显示名（最近请求表里的「账号」列）
    const accNames = {};
    for (const s of (bridge && bridge.sites) || []) for (const a of s.accounts || []) accNames[a.id] = a.label || a.nickname || a.id;
    const today = u.today || {};
    const max = Math.max(1, ...(u.recent || []).map((d) => d.calls || 0));
    const bars = (u.recent || []).map((d) => {
      const daySpeed = d.ms > 0 ? (d.completionTokens / (d.ms / 1000)).toFixed(1) + ' tok/s' : '';
      return `<div class="col" title="${esc(d.date)}：${d.calls} 次调用，${fmtCredit(d.credit ?? 0)} 积分${daySpeed ? '，平均 ' + daySpeed : ''}"><span>${d.credit != null ? fmtCredit(d.credit) + '分' : ''}</span><i style="height:${Math.round((d.calls || 0) / max * 100)}%"></i><span>${esc(d.date.slice(5))}</span></div>`;
    }).join('');
    const byModel = (u.byModel || []).slice(0, 10).map((x) => {
      const speed = x.ms > 0 ? (x.completionTokens / (x.ms / 1000)).toFixed(1) + ' tok/s' : '—';
      return `<tr><td><b>${esc(x.model)}</b> <span class="badge">${esc(x.site)}</span></td><td>${x.calls}</td><td>${x.promptTokens}</td><td>${x.completionTokens}</td><td>${speed}</td><td><b>${fmtCredit(x.credit ?? 0)}</b></td></tr>`;
    }).join('');
    const todaySpeed = (today.ms || 0) > 0 ? ((today.completionTokens || 0) / (today.ms / 1000)).toFixed(1) + ' tok/s' : '—';
    // 今日小时分布（T7）：本地小时 0-23，柱高 = 调用次数，标注 = 消耗积分
    const maxHour = Math.max(1, ...(u.todayHours || []).map((h) => h.calls || 0));
    const hourBars = (u.todayHours || []).map((h) => {
      const hh = String(h.hour).padStart(2, '0');
      return `<div class="col" title="${esc(hh)}:00–${esc(hh)}:59：${h.calls} 次调用${h.credit > 0 ? '，' + fmtCredit(h.credit) + ' 积分' : ''}${h.errors ? '，' + h.errors + ' 次错误' : ''}"><span>${h.credit > 0 ? fmtCredit(h.credit) + '分' : ''}</span><i style="height:${Math.round((h.calls || 0) / maxHour * 100)}%"></i><span>${h.hour}</span></div>`;
    }).join('');
    // 最近请求表：新→旧；空值列可省略（思考档位/积分列只在有记录出现时才渲染）
    const MODE_TEXT = { stream: '流式', json: 'JSON', 'anthropic-stream': 'Anthropic 流式', 'anthropic-json': 'Anthropic', responses: 'Responses' };
    const reqs = rr.requests || [];
    const hasThink = reqs.some((r) => r.effort || r.think);
    const hasCredit = reqs.some((r) => r.credit != null);
    const reqRows = reqs.map((r) => {
      const tok = r.tok_s != null ? `<b>${esc(r.tok_s)}</b> tok/s` : '—';
      const ms = r.ms != null ? (r.ms >= 1000 ? (r.ms / 1000).toFixed(1) + ' s' : r.ms + ' ms') : '—';
      const acct = r.account ? esc(accNames[r.account] || String(r.account).slice(0, 10)) : '—';
      const mode = esc(MODE_TEXT[r.mode] || r.mode || '—') + (r.note ? ` <span class="badge bad" title="${esc(r.note)}">${esc(r.note)}</span>` : '');
      const site = r.site ? ` <span class="badge">${esc(r.site)}</span>` : '';
      // T9：单次消耗超过该模型今日均值 5 倍 → 整行标红 + 「异常」徽标
      const creditCell = hasCredit
        ? `<td>${r.credit != null ? `<b class="${r.anomaly ? 'bad' : ''}">${fmtCredit(r.credit)}</b>${r.anomaly ? ` <span class="badge bad" title="超过该模型今日均值（${fmtCredit(r.creditAvg)} 积分）的 5 倍">异常 5×</span>` : ''}` : '—'}</td>`
        : '';
      return `<tr${r.anomaly ? ' style="background:rgba(224,92,92,.07)"' : ''}><td class="muted" style="white-space:nowrap">${esc(new Date(r.at).toLocaleTimeString())}</td><td><b>${esc(r.model || '')}</b>${site}</td><td style="white-space:nowrap">${mode}</td>${hasThink ? `<td>${esc(r.effort || r.think || '')}</td>` : ''}<td>${tok}</td><td>${ms}</td>${creditCell}<td>${acct}</td></tr>`;
    }).join('');
    // 上下文压缩统计（T10）
    const comp = cc || { totals: { count: 0, dropped: 0, truncated: 0, savedTokens: 0 }, events: [] };
    const compDayMap = new Map();
    for (const e of comp.events || []) {
      const d = String(e.at || '').slice(0, 10);
      if (d) compDayMap.set(d, (compDayMap.get(d) || 0) + 1);
    }
    const compDayKeys = [...compDayMap.keys()].sort().slice(-14);
    const maxCompDay = Math.max(1, ...compDayKeys.map((k) => compDayMap.get(k)));
    const compBars = compDayKeys.map((k) => `<div class="col" title="${esc(k)}：压缩 ${compDayMap.get(k)} 次"><span>${compDayMap.get(k)}</span><i style="height:${Math.round(compDayMap.get(k) / maxCompDay * 100)}%"></i><span>${esc(k.slice(5))}</span></div>`).join('');
    const compRows = (comp.events || []).slice(0, 15).map((e) => `<tr>
      <td class="muted" style="white-space:nowrap">${esc(new Date(e.at).toLocaleString())}</td>
      <td><b>${esc(e.model || '')}</b>${e.site ? ` <span class="badge">${esc(e.site)}</span>` : ''}</td>
      <td>${e.phase === 'retry' ? '<span class="badge warn">重试收缩</span>' : '<span class="badge acc">预压缩</span>'}</td>
      <td>${e.dropped || 0}</td><td>${e.truncated || 0}</td>
      <td>${(e.before || 0).toLocaleString()} → ${(e.after || 0).toLocaleString()}</td></tr>`).join('');
    paint(el, `
      <h2>今日 <span class="sub">自 ${esc(u.since || '')} 起累计统计 · 数据在数据目录 usage.json</span></h2>
      <div class="grid kpis">
        <div class="kpi"><b>${today.calls ?? 0}</b><span>调用次数</span></div>
        <div class="kpi"><b class="${(today.errors || 0) > 0 ? 'bad' : ''}">${today.errors ?? 0}</b><span>错误</span></div>
        <div class="kpi"><b>${(today.promptTokens ?? 0).toLocaleString()}</b><span>输入 tokens</span></div>
        <div class="kpi"><b>${(today.completionTokens ?? 0).toLocaleString()}</b><span>输出 tokens</span></div>
        <div class="kpi"><b>${todaySpeed}</b><span title="今日输出 tokens ÷ 上游总耗时，粗粒度均值（含排队/网络）">平均输出速度</span></div>
        <div class="kpi"><b class="warn">${fmtCredit(today.credit ?? 0)}</b><span>消耗积分</span></div>
      </div>
      <h2>最近 7 天 <span class="sub">柱高 = 调用次数，标注 = 消耗积分</span></h2>
      <div class="card"><div class="bars">${bars || '<span class="muted">暂无数据</span>'}</div></div>
      <h2>按模型排行 <span class="sub">累计 Top 10 · 速度按该模型累计输出 tokens ÷ 累计上游耗时</span></h2>
      <div class="card" style="padding:0">${byModel ? `<table><thead><tr><th>模型</th><th>调用</th><th>输入 tok</th><th>输出 tok</th><th>平均速度</th><th>积分</th></tr></thead><tbody>${byModel}</tbody></table>` : '<div class="muted" style="padding:18px;text-align:center">暂无数据</div>'}</div>
      <h2>最近请求 <span class="sub">内存里最近 ${reqs.length} 条（新→旧），刷新页面即更新；消耗超该模型今日均值 5 倍标红</span></h2>
      <div class="card" style="padding:0">${reqRows ? `<table><thead><tr><th>时间</th><th>模型</th><th>模式</th>${hasThink ? '<th>思考档位</th>' : ''}<th>tok/s</th><th>耗时</th>${hasCredit ? '<th>积分</th>' : ''}<th>账号</th></tr></thead><tbody>${reqRows}</tbody></table>` : '<div class="muted" style="padding:18px;text-align:center">还没有请求记录 —— 发一次对话后再来看</div>'}</div>
      <details class="secd">
        <summary>🕐 今日小时分布 <span class="sub">0–23 点逐小时调用与积分</span></summary>
        <div style="padding:4px 0 12px"><div class="card"><div class="bars">${hourBars || '<span class="muted">暂无数据</span>'}</div></div></div>
      </details>
      <details class="secd">
        <summary>🗜 上下文压缩统计 <span class="sub">${comp.totals.count || 0} 次压缩 · 丢弃 ${comp.totals.dropped || 0} · 截断 ${comp.totals.truncated || 0}</span></summary>
        <div style="padding:4px 0 12px">
          <div class="grid kpis">
            <div class="kpi"><b>${comp.totals.count || 0}</b><span>压缩次数</span></div>
            <div class="kpi"><b>${comp.totals.dropped || 0}</b><span>丢弃消息</span></div>
            <div class="kpi"><b>${comp.totals.truncated || 0}</b><span>截断内容</span></div>
            <div class="kpi"><b>${(comp.totals.savedTokens || 0).toLocaleString()}</b><span title="压缩前后的估算 token 差值累计">估算节省 tokens</span></div>
          </div>
          ${compBars ? `<div class="card" style="margin-top:12px"><div class="bars">${compBars}</div><div class="muted" style="font-size:11.5px;margin-top:6px;text-align:center">近 14 天压缩次数（来自最近 100 条事件）</div></div>` : ''}
          <div class="card" style="padding:0;margin-top:12px">${compRows ? `<table><thead><tr><th style="width:140px">时间</th><th>模型</th><th style="width:90px">阶段</th><th>丢弃</th><th>截断</th><th>tokens（前 → 后）</th></tr></thead><tbody>${compRows}</tbody></table>` : '<div class="muted" style="padding:18px;text-align:center">还没有压缩记录 —— 会话变长触发「上下文超限」时会自动压缩并记到这里</div>'}</div>
        </div>
      </details>
      <details class="secd">
        <summary>🗂 数据管理 <span class="sub">CSV 导出（T36，按模型/账号/日期三维度）· 重置统计</span></summary>
        <div style="padding:4px 0 12px">
          <div class="row" style="flex-wrap:wrap;gap:10px;margin:0 0 12px">
            <span class="muted" style="font-size:12px">导出报表：三个维度分段，直接用 Excel 打开</span>
            <button class="btn mini" data-csv="7">⬇ 近 7 天 CSV</button>
            <button class="btn mini" data-csv="30">⬇ 近 30 天 CSV</button>
            <span class="spacer"></span>
            <button class="btn mini danger" id="uReset">重置统计</button>
          </div>
          <div class="muted" style="font-size:12px">重置会清空全部用量统计（usage.json），不可恢复；CSV 导出随时可用。</div>
        </div>
      </details>`);
    $('#uReset').onclick = async () => {
      if (!await askConfirm('清空全部用量统计？此操作不可撤销。', { okText: '清空' })) return;
      await api('/usage/reset', { method: 'POST' });
      toast('已重置', 'ok'); loadUsage();
    };
    // T36：CSV 下载。不能直接用 <a href> —— 控制台接口要 X-Console-Token 头，
    // 裸链接带不上；所以 fetch 回来再转 Blob 触发保存。
    for (const b of el.querySelectorAll('[data-csv]')) {
      b.onclick = async () => {
        const days = b.dataset.csv;
        b.disabled = true; const old = b.textContent; b.textContent = '导出中…';
        try {
          const res = await fetch('/console/api/usage/export?days=' + days, { headers: { 'X-Console-Token': TOKEN } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'workbuddy-usage-' + days + 'd.csv';
          document.body.appendChild(a); a.click(); a.remove();
          // 立刻 revoke 会让部分浏览器下载中断，给它一帧的寿命
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          toast(`已导出近 ${days} 天报表（三个维度）`, 'ok');
        } catch (e) { toast('导出失败：' + e.message, 'bad'); }
        b.disabled = false; b.textContent = old;
      };
    }
  } catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

/* ---------- Tab：事件时间线（T6） ---------- */
const EVENT_KINDS = [
  { id: '', name: '全部' },
  { id: 'system', name: '系统' },
  { id: 'task', name: '任务' },
  { id: 'policy', name: '策略' },
  { id: 'account', name: '账号' },
  { id: 'credit', name: '积分' },
  { id: 'login', name: '登录' },
  { id: 'health', name: '巡检' },
];
const EVENT_BADGE = { system: 'acc', task: 'ok', policy: 'warn', account: 'bad', credit: 'warn', login: 'ok', health: 'acc' };
let eventKindFilter = localStorage.getItem('wbEventKind') || '';

async function loadEvents() {
  const el = $('#view-events');
  try {
    const [r, bridge] = await Promise.all([api('/events'), api('/bridge').catch(() => null)]);
    // 账号 id → 显示名（事件里存的是 accountId，展示成用户认识的备注名）
    const accNames = {};
    for (const s of (bridge && bridge.sites) || []) for (const a of s.accounts || []) accNames[a.id] = a.label || a.nickname || a.id;
    const all = r.events || [];
    const list = all.filter((e) => !eventKindFilter || e.kind === eventKindFilter);
    const rows = list.map((e) => {
      const kind = (EVENT_KINDS.find((k) => k.id === e.kind) || {}).name || e.kind;
      const who = e.accountId && accNames[e.accountId] ? ` · ${esc(accNames[e.accountId])}` : (e.accountId ? ` · ${esc(String(e.accountId).slice(0, 12))}` : '');
      const tip = `${new Date(e.at).toLocaleString()} · ${e.text}${e.site ? ' · ' + e.site : ''}${e.accountId && accNames[e.accountId] ? ' · ' + accNames[e.accountId] : ''}`;
      return `<tr title="${esc(tip)}">
        <td class="muted" style="white-space:nowrap">${esc(new Date(e.at).toLocaleString())}</td>
        <td style="width:74px"><span class="badge ${EVENT_BADGE[e.kind] || ''}">${esc(kind)}</span></td>
        <td>${esc(e.text)}${e.site ? ` <span class="badge">${esc(e.site)}</span>` : ''}${who}</td>
      </tr>`;
    }).join('');
    paint(el, `
      <h2>事件时间线 <span class="sub">任务 / 账号 / 策略 / 登录 / 巡检等关键事件 · 落盘 events.json 重启不丢（最多 300 条）</span></h2>
      <div class="row" style="margin-bottom:12px">
        ${EVENT_KINDS.map((k) => `<button class="btn mini ${eventKindFilter === k.id ? 'primary' : ''}" data-evkind="${k.id}">${k.name}</button>`).join('')}
        <span class="spacer"></span>
        <span class="muted" style="font-size:12px">共 ${all.length} 条${eventKindFilter ? ` · 筛选后 ${list.length} 条` : ''}</span>
      </div>
      <div class="card" style="padding:0">${rows ? `<table><thead><tr><th style="width:150px">时间</th><th style="width:74px">类型</th><th>事件</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted" style="padding:22px;text-align:center">暂无事件</div>'}</div>`);
    for (const b of el.querySelectorAll('[data-evkind]')) {
      b.onclick = () => { eventKindFilter = b.dataset.evkind; localStorage.setItem('wbEventKind', eventKindFilter); loadEvents(); };
    }
  } catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

/* ---------- Tab：健康（T17 账号健康 + T18 Key + T19 路由规则 + T20 时段路由 + T21 备份恢复） ---------- */
const fmtPct = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 's' : n + 'ms');
/* 账号健康状态 —— 必须与 server/src/pool.mjs 的 isUsable() 同一套语义：
 * enabled=false 已禁用；lastError 含 401 登录态失效；exhaustedAt 6h TTL 内算额度耗尽；
 * cooldownUntil（epoch ms）未到算冷却中。字段全是驼峰（0.3.25 修正：此前的
 * usable/cooldown_until/exhausted_at 是不存在的幽灵字段，导致所有账号恒显示「不可用」）。 */
function healthState(a) {
  const now = Date.now();
  if (a.enabled === false) return { cls: '', text: '已禁用' };
  if (String(a.lastError || '').includes('401')) return { cls: 'bad', text: '登录态失效' };
  if (a.exhaustedAt && now - a.exhaustedAt < 6 * 3600e3) return { cls: 'bad', text: '额度耗尽' };
  if (a.cooldownUntil && now < a.cooldownUntil) return { cls: 'warn', text: '冷却中 · 剩 ' + Math.max(1, Math.ceil((a.cooldownUntil - now) / 60000)) + ' 分' };
  return { cls: 'ok', text: '健康' };
}

  async function loadHealth() {
    const el = $('#sec-health');
    try {
      const [bridge, keys, srr, sec, nt, pc, w] = await Promise.all([
        api('/bridge'), api('/keys').catch(() => null), api('/schedule-router').catch(() => null),
        api('/security').catch(() => null), api('/notify').catch(() => null), api('/protocol').catch(() => null),
        api('/weekly').catch(() => null)]);
    // T34：预警阈值从 /bridge 下发，写进卡片输入框（loadAlerts 已同步更新同一份）
    const at = bridge.alerts || {};
    ALERT_TH = { ...ALERT_FALLBACK, ...(at || {}) };
    // ---- T39：协议自检结果行 ----
    const pcSites = (pc && pc.sites) || [];
    const pcRows = pcSites.length ? `<div style="overflow:auto"><table><thead><tr><th>站点</th><th>结果</th><th>不符项</th></tr></thead><tbody>${pcSites.map((s) => `
      <tr>
        <td><b>${esc(s.site)}</b></td>
        <td>${s.skipped ? `<span class="badge">跳过（${esc(s.error || '未登录')}）</span>` : s.drifted ? `<span class="badge bad">${s.drifted}/${s.total} 项不符</span>` : `<span class="badge ok">${s.total} 项全对</span>`}</td>
        <td style="font-size:12px">${(s.results || []).map((r) => `<div><code>${esc(r.key)}</code> — ${esc(r.detail)}</div>`).join('') || '<span class="muted">—</span>'}</td>
      </tr>`).join('')}</tbody></table></div>` : '';
    const sites = bridge.sites || [];
    // ---- T17：账号健康总览（全站点的健康状态一目了然）----
    const allAccs = [];
    for (const s of sites) for (const a of s.accounts || []) allAccs.push({ ...a, site: s.site, siteLabel: s.label });
    const counts = { ok: 0, warn: 0, bad: 0 };
    for (const a of allAccs) counts[healthState(a).cls === 'ok' ? 'ok' : healthState(a).cls === 'warn' ? 'warn' : 'bad']++;
    const accRows = allAccs.map((a) => {
      const st = healthState(a);
      const remain = accountRemainOf(a);
      const ttl = [];
      if (a.exhaustedAt) ttl.push({ t: '额度耗尽', at: a.exhaustedAt, cls: 'bad' });
      if (a.cooldownUntil && a.cooldownUntil > Date.now()) ttl.push({ t: '冷却至 ' + new Date(a.cooldownUntil).toLocaleTimeString(), at: a.cooldownUntil, cls: 'warn' });
      if (a.lastError) ttl.push({ t: '失败：' + a.lastError, at: a.lastErrorAt || a.lastUsedAt || a.creditCheckedAt || a.addedAt, cls: 'bad' });
      if (a.lastUsedAt) ttl.push({ t: '最近使用', at: a.lastUsedAt, cls: 'acc' });
      ttl.sort((x, y) => new Date(y.at) - new Date(x.at));
      const timeline = ttl.slice(0, 3).map((e) =>
        `<div style="font-size:12px" class="muted"><span class="${e.cls}" style="margin-right:4px">●</span>${new Date(e.at).toLocaleString()} · ${esc(e.t.length > 60 ? e.t.slice(0, 60) + '…' : e.t)}</div>`).join('');
      return `<tr>
        <td><b>${esc(a.label || a.id)}</b> <span class="badge">${esc(a.site)}</span></td>
        <td><span class="badge ${st.cls}">${st.text}</span></td>
        <td>${remain == null ? '—' : fmtCredit(remain)}</td>
        <td>${a.failCount || 0}</td>
        <td>${a.enabled === false ? '<span class="badge">禁用</span>' : '<span class="badge ok">启用</span>'}</td>
        <td style="min-width:260px">${timeline || '<span class="muted" style="font-size:12px">暂无事件</span>'}</td>
      </tr>`;
    }).join('');
    // ---- T18：多 apiKey 管理 ----
    const keyRows = ((keys && keys.keys) || []).map((k) => `
      <tr><td><code>${esc(k.masked)}</code>${k.isPrimary ? ' <span class="badge acc">主密钥</span>' : ''}</td>
      <td class="muted" style="font-size:12px">${esc(k.hint || (k.isPrimary ? '控制台复制接入配置时显示的就是这把' : '同样可用，发给第二台设备/客户端用'))}</td>
      <td style="width:70px">${k.isPrimary ? '' : `<button class="btn mini danger" data-keydel="${esc(k.masked)}" title="删除需要粘贴完整 key：点后弹输入框">删除</button>`}</td></tr>`).join('');
    // ---- T20：时段路由当前状态 ----
    const sr = (srr && srr.scheduleRouter) || bridge.scheduleRouter || {};
    const srNow = sr.enabled ? (function () {
      const h = new Date().getHours() * 60 + new Date().getMinutes();
      const p2 = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
      const d = p2(sr.dayStart), n = p2(sr.nightStart);
      const inDay = d == null || n == null ? true : (d <= n ? h >= d && h < n : h >= d || h < n);
      return inDay ? (sr.dayModel || '不改道（走默认模型）') : (sr.nightModel || '不改道（走默认模型）');
    })() : null;
    paint(el, secdWrap(`
      <h2>账号健康 <span class="sub">T17 · 全站点账号的状态、连续失败与最近事件时间线（冷却/耗尽自动进入，恢复自动解除）</span></h2>
      <div class="grid kpis" style="margin-bottom:12px">
        <div class="kpi"><b class="ok">${counts.ok}</b><span>健康</span></div>
        <div class="kpi"><b class="warn">${counts.warn}</b><span>冷却 / 不可用</span></div>
        <div class="kpi"><b class="${counts.bad ? 'bad' : ''}">${counts.bad}</b><span>耗尽 / 失效</span></div>
      </div>
      <div class="card" style="padding:0;overflow:auto;margin-bottom:20px">
        ${accRows ? `<table><thead><tr><th>账号</th><th>状态</th><th>余额</th><th>连续失败</th><th>启用</th><th>最近事件（新→旧，最多 3 条）</th></tr></thead><tbody>${accRows}</tbody></table>`
          : '<div class="muted" style="padding:18px;text-align:center">还没有账号</div>'}
      </div>
      <h2>API Keys <span class="sub">T18 · 多把密钥同样有效：主密钥给自己用，其余发给其他客户端；改动即时生效无需重启</span></h2>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="margin-bottom:10px">
          <button class="btn primary" id="keyAdd">＋ 添加 Key</button>
          <span class="muted" style="font-size:12px">新 key 以 sk-wb- 开头自动生成；添加后立即生效（服务热读 config）。完整值只在创建时显示一次，复制好再关弹窗。</span>
        </div>
        <div style="overflow:auto">${keyRows ? `<table><thead><tr><th>密钥</th><th>说明</th><th></th></tr></thead><tbody>${keyRows}</tbody></table>` : '<div class="muted" style="padding:14px;text-align:center">加载失败或没有 key</div>'}</div>
      </div>
      <h2>路由规则 <span class="sub">T19 · 别名（模型→模型/站点/模型）、钉死路由（模型→站点）、白/黑名单（支持 * 通配符）</span></h2>
      <div class="card" style="margin-bottom:20px">
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:14px">
          <div>
            <label class="muted" style="font-size:12.5px;display:block;margin-bottom:5px" title="一行一条：别名=目标。目标可以是模型名（kimi=glm-5.3）或 站点/模型（claude=intl-cli/claude-sonnet-4.6）">模型别名（modelAliases）</label>
            <textarea id="rtAliases" rows="5" style="width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px;font:12.5px/1.6 Consolas,monospace" placeholder="claude=intl-cli/claude-sonnet-4.6&#10;快模型=glm-5.3-flash"></textarea>
          </div>
          <div>
            <label class="muted" style="font-size:12.5px;display:block;margin-bottom:5px" title="一行一条：模型=站点。把某模型钉死在指定站点，不再按倍率自动选站">钉死路由（modelRoutes）</label>
            <textarea id="rtRoutes" rows="5" style="width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px;font:12.5px/1.6 Consolas,monospace" placeholder="gpt-5.5=intl-cli&#10;claude-sonnet-4.6=intl-cli"></textarea>
          </div>
          <div>
            <label class="muted" style="font-size:12.5px;display:block;margin-bottom:5px" title="逗号分隔，支持 * 通配符。非空时只保留命中的模型">白名单（allowModels）</label>
            <input type="text" id="rtAllow" style="width:100%" placeholder="留空 = 不限制；如 glm-* , kimi-*">
          </div>
          <div>
            <label class="muted" style="font-size:12.5px;display:block;margin-bottom:5px" title="逗号分隔，支持 * 通配符。命中的模型从目录剔除、不可调用">黑名单（excludeModels）</label>
            <input type="text" id="rtExclude" style="width:100%" placeholder="如 claude-opus-* , gpt-6-astra">
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="rtSave">保存路由规则</button>
          <button class="btn" id="rtPreview">预览白/黑名单效果</button>
          <span class="muted" id="rtMsg" style="font-size:12px"></span>
        </div>
        <div id="rtPreviewBox" style="margin-top:10px"></div>
      </div>
      <h2>按时段路由 <span class="sub">T20 · default 请求白天走 dayModel、夜间走 nightModel（本地时间，支持跨零点）；显式指定模型不受影响</span></h2>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="flex-wrap:wrap;gap:12px">
          <label style="display:flex;align-items:center;gap:5px;font-size:13px">
            <input type="checkbox" id="srEnabled" ${sr.enabled ? 'checked' : ''}> 启用
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">白天从
            <input id="srDay" value="${esc(sr.dayStart || '08:00')}" placeholder="08:00" style="width:78px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">白天模型
            <input id="srDayModel" value="${esc(sr.dayModel || '')}" placeholder="留空 = 不改道" style="width:170px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">夜间从
            <input id="srNight" value="${esc(sr.nightStart || '23:00')}" placeholder="23:00" style="width:78px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">夜间模型
            <input id="srNightModel" value="${esc(sr.nightModel || '')}" placeholder="留空 = 不改道" style="width:170px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px">
          </label>
          <button class="btn" id="srSave">保存</button>
          ${sr.enabled ? `<span class="badge ok" title="此刻 default 请求实际会走的模型">当前时段 → ${esc(srNow)}</span>` : ''}
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">时段改道只作用于 <code>default</code>（客户端配的通用模型名）；<code>auto</code> 保持透传上游，显式指定模型不受影响。与「免费优先/预算切免费」同走哨兵改道，时段优先级更高。改完保存即时生效，无需重启。</div>
      </div>
      <h2>配置备份 / 恢复 <span class="sub">T21 · config + 账号池（含 token）+ 学习/用量/任务/事件/巡检状态打包成一份 JSON；换机或重装前先导出</span></h2>
      <div class="card">
        <div class="row" style="flex-wrap:wrap;gap:10px">
          <button class="btn primary" id="bkExport">⬇ 导出备份</button>
          <button class="btn" id="bkImport">⬆ 从文件恢复…</button>
          <input type="file" id="bkFile" accept=".json,application/json" style="display:none">
          <span class="muted" style="font-size:12px">备份含上游登录 token（明文），请像保存密码一样保管；恢复时同目录下的当前文件会先备份成 .prestore-*。</span>
        </div>
        <div id="bkMsg" style="margin-top:10px"></div>
      </div>
      <h2>控制台访问 PIN <span class="sub">T23 · 打开控制台需先输入 PIN 解锁（4-12 位数字）；改动即时生效，无需重启</span></h2>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="flex-wrap:wrap;gap:10px;align-items:center">
          <span class="badge ${sec && sec.pinEnabled ? 'ok' : ''}">${sec && sec.pinEnabled ? '🔒 已启用' : '未启用'}</span>
          <input id="pinNow" type="password" placeholder="当前 PIN（已启用时必填）" style="width:190px;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel2);color:var(--text);font-size:13px">
          <input id="pinNew" type="password" placeholder="新 PIN（留空=关闭）" style="width:170px;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel2);color:var(--text);font-size:13px">
          <button class="btn" id="pinSave">保存</button>
          <span class="muted" style="font-size:12px">服务只监听 127.0.0.1；PIN 防的是「别人坐在这台电脑前打开控制台」。忘记 PIN 时改数据目录 config.json 的 consolePin 字段。</span>
        </div>
      </div>
      <h2>预警阈值 <span class="sub">T34 · 控制台顶栏红色/橙色预警条的判定门槛；改完下一轮（≤60 秒）自动生效</span></h2>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="flex-wrap:wrap;gap:12px;align-items:center">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px" title="任一账号余额 ≤ 此值 → 顶栏红「余额不足」">余额不足（积分）
            <input id="alLow" type="number" min="0" step="10" value="${alLow()}" style="width:96px;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel2);color:var(--text);font-size:13px">
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px" title="批次在此天数内到期才提醒">到期提醒（天）
            <input id="alDays" type="number" min="1" step="1" value="${alDays()}" style="width:76px;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel2);color:var(--text);font-size:13px">
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px" title="且余量大于此值才提醒 —— 余量太小的批次提醒了也没意义">余量下限（积分）
            <input id="alMin" type="number" min="0" step="50" value="${alMin()}" style="width:96px;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel2);color:var(--text);font-size:13px">
          </label>
          <button class="btn" id="alSave">保存阈值</button>
          <button class="btn" id="alReset" title="恢复 200 / 7 / 500">恢复默认</button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">「登录态失效」红条没有阈值可调 —— 账号报 401 就一定提醒，否则会话会莫名其妙失败。</div>
      </div>
      <h2>通知通道 <span class="sub">T33 · 把「猫猫归来 / 余额不足 / 登录态失效 / 预算预警」推到手机，人不在电脑前也能收</span></h2>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="margin-bottom:10px">
          <label style="display:flex;align-items:center;gap:5px;font-size:13px" title="关掉后桌面气泡与所有外部通道都不再发送">
            <input type="checkbox" id="ntEnabled" ${nt && nt.enabled ? 'checked' : ''}> 启用通知
          </label>
          <button class="btn" id="ntTest">🔔 测试通知</button>
          <span class="muted" id="ntMsg" style="font-size:12px"></span>
        </div>
        <div id="ntList"></div>
        <button class="btn mini" id="ntAdd" style="margin-top:9px">＋ 添加通道</button>
        <button class="btn mini primary" id="ntSave">保存通道</button>
        <div class="muted" style="font-size:12px;margin-top:9px">
          <b>webhook</b>：POST JSON <code>{ title, text }</code>，适合自建中转。<br>
          <b>bark</b>：地址填到设备 key 为止，如 <code>https://api.day.app/你的Key</code>，标题正文自动拼到路径里。<br>
          <b>serverchan</b>：填完整的 SendKey 地址，如 <code>https://sctapi.ftqq.com/你的Key.send</code>。<br>
          地址里含密钥，保存后这里只显示打码值；不配置就完全不发外部请求。每个通道按事件独立 5 分钟节流。
        </div>
      </div>
      <h2>协议自检 <span class="sub">T39 · 比对上游响应的关键结构；上游改版时提前告警，而不是等「积分全是 0 / 目录空了」才发现</span></h2>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="margin-bottom:10px">
          <button class="btn primary" id="pcRun">▶ 立即自检</button>
          <span class="muted" id="pcSummary" style="font-size:12.5px">${pc && pc.at ? '上次自检 ' + esc(new Date(pc.at).toLocaleString()) + '（6 小时缓存）' : '还没自检过'}</span>
        </div>
        <div id="pcBox">${pcRows || '<div class="muted" style="padding:8px 2px;text-align:center">点「立即自检」比对上游响应结构（只读探针，不消耗积分、不发对话）</div>'}</div>
      </div>
      <h2>用量周报 <span class="sub">T46 · 每周一 ${(w && w.config && (w.config.times || []).join(' / ')) || '09:00'} 把上周汇总（调用/积分/模型 Top5/按账号）推送到通知通道；纯读数零消耗</span></h2>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="flex-wrap:wrap;gap:10px;align-items:center">
          <span class="badge ${w && w.config && w.config.enabled !== false ? 'ok' : ''}">${w && w.config && w.config.enabled !== false ? '已启用' : '已关闭（config weekly.enabled）'}</span>
          <button class="btn" id="wkRun">▶ 立即生成一次</button>
          <span class="muted" id="wkMsg" style="font-size:12px">${w && w.state && w.state.lastSent ? '上次发送：' + esc(w.state.lastSent) + '（每周最多一次，重启不重复发）' : '本周还没发过（周一自动发，或点按钮手动生成）'}</span>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">推送走「通知通道」卡里配置的 webhook/Bark/Server酱 + Windows 气泡；没配通道也能在事件时间线里看到生成记录。</div>
      </div>
      <h2>一键诊断 <span class="sub">T24 · 只读体检：服务/配置/登录态/账号池/路由/数据文件/后台循环/协议，与 /wbp-doctor 同源</span></h2>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="margin-bottom:10px">
          <button class="btn primary" id="docRun">▶ 运行诊断</button>
          <span class="muted" id="docSummary" style="font-size:12.5px"></span>
        </div>
        <div id="docBox"><div class="muted" style="padding:8px 2px;text-align:center">点「运行诊断」开始体检（只读，不消耗积分）</div></div>
      </div>`, false));

    // ---- T18 行为绑定 ----
    $('#keyAdd').onclick = async () => {
      try {
        const r = await api('/keys/add', { method: 'POST', body: {} });
        if (r.ok && r.key) {
          // 完整值只显示这一次：弹窗让用户先复制
          $('#modalRoot').innerHTML = `<div class="modal" id="mWrapK"><div class="box">
            <h3>新密钥已创建（${r.count} 把生效中）</h3>
            <pre id="newKeyBox" style="background:var(--codebg);border:1px solid var(--line);border-radius:8px;padding:12px;font:13px Consolas,monospace;word-break:break-all;user-select:all">${esc(r.key)}</pre>
            <div class="muted" style="font-size:12px;margin:10px 0">完整值只在这一次显示，关掉弹窗后只能看掩码。先复制再关闭。</div>
            <div class="row"><button class="btn primary" id="copyNewKey">⧉ 复制</button><span class="spacer"></span><button class="btn" id="closeNewKey">我已保存，关闭</button></div>
          </div></div>`;
          $('#copyNewKey').onclick = () => navigator.clipboard?.writeText(r.key).then(() => toast('已复制新密钥', 'ok')).catch(() => {});
          $('#closeNewKey').onclick = () => $('#mWrapK').remove();
        }
      } catch (e) { toast('添加失败：' + e.message, 'bad'); }
      loadHealth();
    };
    for (const b of el.querySelectorAll('[data-keydel]')) {
      b.onclick = async () => {
        const masked = b.dataset.keydel;
        const full = await askText(`删除密钥 ${masked}`, '', { placeholder: '粘贴该密钥的完整值以确认（防误删）', okText: '删除' });
        if (!full || !full.trim()) return;
        try {
          await api('/keys/remove', { method: 'POST', body: { key: full.trim() } });
          toast('密钥已删除', 'ok');
          loadHealth();
        } catch (e) { toast('删除失败：' + e.message, 'bad'); }
      };
    }
    // ---- T19 行为绑定 ----
    const rt = await api('/routes').catch(() => null);
    if (rt) {
      $('#rtAliases').value = Object.entries(rt.aliases || {}).map(([k, v]) => `${k}=${v}`).join('\n');
      $('#rtRoutes').value = Object.entries(rt.routes || {}).map(([k, v]) => `${k}=${v}`).join('\n');
      $('#rtAllow').value = (rt.allowModels || []).join(', ');
      $('#rtExclude').value = (rt.excludeModels || []).join(', ');
    }
    const parseKv = (text, what) => {
      const out = {};
      for (const line of String(text || '').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const i = t.indexOf('=');
        if (i <= 0 || !t.slice(i + 1).trim()) throw new Error(`${what} 格式不对：${t}（应为 键=值，一行一条）`);
        out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
      return out;
    };
    $('#rtSave').onclick = async () => {
      try {
        const body = {
          aliases: parseKv($('#rtAliases').value, '别名'),
          routes: parseKv($('#rtRoutes').value, '路由'),
          allowModels: $('#rtAllow').value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean),
          excludeModels: $('#rtExclude').value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean),
        };
        await api('/routes', { method: 'POST', body });
        $('#rtMsg').textContent = '已保存（' + Object.keys(body.aliases).length + ' 别名 · ' + Object.keys(body.routes).length + ' 路由 · 白' + body.allowModels.length + '/黑' + body.excludeModels.length + '）';
        toast('路由规则已保存，立即生效', 'ok');
      } catch (e) { $('#rtMsg').textContent = ''; toast('保存失败：' + e.message, 'bad'); }
    };
    $('#rtPreview').onclick = async () => {
      try {
        const r = await api('/models-filter', { method: 'POST', body: {
          allowModels: $('#rtAllow').value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean),
          excludeModels: $('#rtExclude').value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean),
        } });
        const dropped = (r.rows || []).filter((x) => !x.kept);
        $('#rtPreviewBox').innerHTML = `<div class="muted" style="font-size:12.5px;margin-bottom:6px">按当前输入：${r.kept}/${r.total} 个模型保留${dropped.length ? '，剔除：' : ''}</div>` +
          (dropped.length ? `<div style="max-height:160px;overflow:auto">${dropped.map((x) => `<span class="badge bad" style="margin:2px">${esc(x.id)}（${esc(x.site)}）</span>`).join('')}</div>` : '');
      } catch (e) { toast('预览失败：' + e.message, 'bad'); }
    };
    // ---- T20 行为绑定 ----
    $('#srSave').onclick = async () => {
      try {
        const r = await api('/schedule-router', { method: 'POST', body: {
          enabled: $('#srEnabled').checked,
          dayStart: $('#srDay').value,
          nightStart: $('#srNight').value,
          dayModel: $('#srDayModel').value,
          nightModel: $('#srNightModel').value,
        } });
        toast('时段路由已保存：' + (r.scheduleRouter.enabled ? '启用中' : '已关闭'), 'ok');
        loadHealth();
      } catch (e) { toast('保存失败：' + e.message, 'bad'); }
    };
    // ---- T21 行为绑定 ----
    $('#bkExport').onclick = async () => {
      try {
        const r = await api('/backup');
        const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'workbuddy-bridge-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
        $('#bkMsg').innerHTML = `<span class="ok" style="font-size:12.5px">已导出 ${Object.keys(r.files || {}).length} 个文件（含账号池与配置）—— ${new Date(r.exportedAt).toLocaleString()}</span>`;
      } catch (e) { $('#bkMsg').innerHTML = `<span class="bad" style="font-size:12.5px">导出失败：${esc(e.message)}</span>`; }
    };
    $('#bkImport').onclick = () => $('#bkFile').click();
    $('#bkFile').onchange = async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      if (!await askConfirm('恢复会覆盖当前配置与账号池（同目录的现有文件会先备份成 .prestore-*）。继续？', { okText: '继续恢复' })) { ev.target.value = ''; return; }
      try {
        const parsed = JSON.parse(await file.text());
        const r = await api('/backup/restore', { method: 'POST', body: { files: parsed.files || parsed } });
        $('#bkMsg').innerHTML = `<span class="${r.ok ? 'ok' : 'bad'}" style="font-size:12.5px">已恢复：${(r.accepted || []).join('、') || '无'}${(r.skipped || []).length ? '；跳过：' + r.skipped.join('、') : ''}</span>` +
          (r.note ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(r.note)}</div>` : '') +
          `<button class="btn mini primary" id="bkRestart" style="margin-top:6px">立即交棒重启使 config 生效（不断线）</button>`;
        const br = $('#bkRestart');
        if (br) br.onclick = async () => {
          br.disabled = true; br.textContent = '重启中…';
          try { await api('/service/restart', { method: 'POST' }); toast('交棒重启已触发，页面稍后自动恢复', 'ok'); }
          catch (e) { toast('重启失败：' + e.message, 'bad'); br.disabled = false; br.textContent = '立即交棒重启使 config 生效（不断线）'; }
        };
      } catch (e) {
        $('#bkMsg').innerHTML = `<span class="bad" style="font-size:12.5px">恢复失败：${esc(e.message)}</span>`;
      }
      ev.target.value = '';
    };
    // ---- T23 行为绑定：控制台访问 PIN ----
    $('#pinSave').onclick = async () => {
      const nowPin = $('#pinNow').value.trim();
      const newPin = $('#pinNew').value.trim();
      if (!nowPin && sec && sec.pinEnabled) { toast('已启用 PIN 时修改/关闭都必须先填「当前 PIN」', 'bad'); return; }
      if (newPin && !/^\d{4,12}$/.test(newPin)) { toast('新 PIN 必须是 4-12 位数字', 'bad'); return; }
      try {
        const r = await api('/security', { method: 'POST', body: { currentPin: nowPin, pin: newPin } });
        toast(r.pinEnabled ? 'PIN 已启用/更新——下次打开控制台会先要求解锁' : 'PIN 已关闭', 'ok');
        $('#pinNow').value = ''; $('#pinNew').value = '';
        loadHealth();
      } catch (e) { toast('保存失败：' + e.message, 'bad'); }
    };
    // ---- T34 行为绑定：预警阈值 ----
    // 保存失败时把输入框恢复成服务端真值：否则非法值（比如天数填 0）会留在框里，
    // 用户接着改别的数再点保存，容易忘了刚才报错、误以为整体没生效。
    const restoreAlerts = () => {
      $('#alLow').value = ALERT_TH.lowBalance;
      $('#alDays').value = ALERT_TH.expiryDays;
      $('#alMin').value = ALERT_TH.expiryMinAmount;
    };
    $('#alSave').onclick = async () => {
      try {
        const r = await api('/alerts', { method: 'POST', body: {
          lowBalance: $('#alLow').value, expiryDays: $('#alDays').value, expiryMinAmount: $('#alMin').value,
        } });
        ALERT_TH = r.alerts;
        restoreAlerts();
        toast(`阈值已保存：余额 ≤${r.alerts.lowBalance}、${r.alerts.expiryDays} 天内到期且余量 >${r.alerts.expiryMinAmount}`, 'ok');
        loadAlerts(); // 立刻重画预警条，不用等 60 秒
      } catch (e) {
        restoreAlerts();
        toast('保存失败：' + e.message + '（已恢复原值）', 'bad');
      }
    };
    $('#alReset').onclick = async () => {
      try {
        const r = await api('/alerts', { method: 'POST', body: { lowBalance: 200, expiryDays: 7, expiryMinAmount: 500 } });
        ALERT_TH = r.alerts;
        $('#alLow').value = r.alerts.lowBalance; $('#alDays').value = r.alerts.expiryDays; $('#alMin').value = r.alerts.expiryMinAmount;
        toast('已恢复默认阈值 200 / 7 / 500', 'ok');
        loadAlerts();
      } catch (e) { toast('重置失败：' + e.message, 'bad'); }
    };

    // ---- T33 行为绑定：通知通道 ----
    const renderChannels = (list) => {
      $('#ntList').innerHTML = (list && list.length) ? list.map((c, i) => `
        <div class="row" data-ch="${i}" style="margin-bottom:8px;padding:9px 11px;border:1px solid var(--line);border-radius:9px">
          <select data-ch-type="${i}" style="min-width:118px">
            ${['webhook', 'bark', 'serverchan'].map((t) => `<option value="${t}" ${c.type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <input type="text" data-ch-url="${i}" value="${esc(c.url || '')}" placeholder="完整地址（含密钥）" style="flex:1;min-width:200px">
          <label style="display:flex;align-items:center;gap:4px;font-size:12.5px"><input type="checkbox" data-ch-on="${i}" ${c.enabled !== false ? 'checked' : ''}> 启用</label>
          <button class="btn mini danger" data-ch-del="${i}">删除</button>
        </div>`).join('') : '<div class="muted" style="padding:10px 0;font-size:12.5px">还没有通道 —— 不配置也不影响桌面气泡，两者是并行的。</div>';
      // 行内控件改动后同步回内存列表，保存时直接提交
      for (const sel of el.querySelectorAll('[data-ch-type]')) sel.onchange = () => { list[+sel.dataset.chType].type = sel.value; };
      for (const inp of el.querySelectorAll('[data-ch-url]')) inp.oninput = () => { list[+inp.dataset.chUrl].url = inp.value; };
      for (const cb of el.querySelectorAll('[data-ch-on]')) cb.onchange = () => { list[+cb.dataset.chOn].enabled = cb.checked; };
      for (const b of el.querySelectorAll('[data-ch-del]')) b.onclick = () => { list.splice(+b.dataset.chDel, 1); renderChannels(list); };
    };
    let chList = ((nt && nt.channels) || []).map((c) => ({ ...c }));
    renderChannels(chList);
    $('#ntAdd').onclick = () => { chList.push({ type: 'webhook', url: '', enabled: true }); renderChannels(chList); };
    $('#ntSave').onclick = async () => {
      const bad = chList.find((c) => !String(c.url || '').trim());
      if (bad) { toast('有通道还没填地址 —— 填不上就点「删除」', 'bad'); return; }
      try {
        await api('/notify', { method: 'POST', body: { enabled: $('#ntEnabled').checked, channels: chList } });
        toast('通知通道已保存（地址已按密钥打码显示）', 'ok');
        loadHealth();
      } catch (e) { toast('保存失败：' + e.message, 'bad'); }
    };
    $('#ntTest').onclick = async () => {
      const b = $('#ntTest');
      const msg = $('#ntMsg');
      b.disabled = true;
      b.textContent = '投递中…（最多等 10 秒）';
      msg.textContent = '';
      try {
        // 先存再测：测试的是「当前配置」，不是页面上还没保存的草稿
        await api('/notify', { method: 'POST', body: { enabled: true, channels: chList.filter((c) => String(c.url || '').trim()) } });
        const r = await api('/notify/test', { method: 'POST' });
        // 后端现在回传每个通道的真实结果，失败要如实显示（含可行动的原因），
        // 不能一律报「已投递」——否则用户等不到推送只会以为通道坏了。
        const failed = (r.results || []).filter((x) => !x.ok);
        msg.innerHTML = failed.length
          ? `<span class="bad">${esc(r.note)}</span>`
          : `<span class="ok">${esc(r.note)}</span>`;
        toast(r.note || '已发送', r.ok ? 'ok' : 'bad');
      } catch (e) { toast('测试失败：' + e.message, 'bad'); }
      b.disabled = false;
      b.textContent = '🔔 测试通知';
    };

    // ---- T39 行为绑定：协议自检 ----
    $('#pcRun').onclick = async () => {
      const b = $('#pcRun');
      b.disabled = true; b.textContent = '自检中…';
      try {
        const r = await api('/protocol/check', { method: 'POST' });
        $('#pcSummary').innerHTML = r.drifted
          ? `<span class="bad">发现 ${r.drifted}/${r.total} 项与预期不符 —— 上游可能改版了，展开下表看具体字段</span>`
          : `<span class="ok">${r.total} 项签名全部符合预期</span>`;
        toast(r.drifted ? `协议自检：${r.drifted} 项不符` : '协议自检通过', r.drifted ? 'bad' : 'ok');
        loadHealth();
      } catch (e) { toast('自检失败：' + e.message, 'bad'); b.disabled = false; b.textContent = '▶ 立即自检'; }
    };

    // ---- T46 行为绑定：用量周报手动生成 ----
    $('#wkRun').onclick = async () => {
      const b = $('#wkRun');
      b.disabled = true; b.textContent = '生成中…';
      try {
        const r = await api('/weekly/run', { method: 'POST' });
        if (r.ok && r.summary) {
          const t = r.summary.totals || {};
          toast(`周报已生成并推送：上周调用 ${t.calls} 次 / 消耗 ${t.credit} 积分`, 'ok');
          if ($('#wkMsg')) $('#wkMsg').textContent = '已生成（' + (r.summary.from || '') + ' ~ ' + (r.summary.to || '') + '）并推送到通知通道';
        } else toast('未生成：' + (r.skipped || '未知原因'), 'bad');
      } catch (e) { toast('生成失败：' + e.message, 'bad'); }
      b.disabled = false; b.textContent = '▶ 立即生成一次';
    };

    // ---- T24 行为绑定：一键诊断 ----
    $('#docRun').onclick = async () => {
      const b = $('#docRun');
      b.disabled = true; b.textContent = '体检中…';
      try {
        const d = await api('/doctor');
        const icon = { pass: '✅', warn: '⚠️', fail: '❌' };
        $('#docSummary').innerHTML =
          `<b class="${d.summary.fail ? 'bad' : 'ok'}">✅ ${d.summary.pass} 通过</b> · <span class="warn">⚠️ ${d.summary.warn} 提醒</span> · <span class="${d.summary.fail ? 'bad' : 'muted'}">❌ ${d.summary.fail} 失败</span> · ${new Date(d.at).toLocaleTimeString()}`;
        $('#docBox').innerHTML = `<div class="card" style="padding:0;overflow:auto"><table><thead><tr><th style="width:34px"></th><th style="width:150px">检查项</th><th>结果</th></tr></thead><tbody>${
          d.checks.map((c) => `<tr><td style="text-align:center">${icon[c.level] || ''}</td><td><b>${esc(c.name)}</b></td><td class="muted" style="font-size:12.5px">${esc(c.detail)}</td></tr>`).join('')
        }</tbody></table></div>`;
      } catch (e) { toast('诊断失败：' + e.message, 'bad'); }
      b.disabled = false; b.textContent = '▶ 运行诊断';
    };
  } catch (e) { el.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

/* ---------- Tab 5：日志 ---------- */
function startLogs() {
  const box = $('#logBox');
  box.textContent = '';
  logSeq = 0;
  const tick = async () => {
    try {
      const r = await api('/logs?after=' + logSeq);
      logSeq = r.lastSeq ?? logSeq;
      if (r.list?.length && !logPaused) {
        for (const l of r.list) {
          const div = document.createElement('div');
          div.className = 'lv-' + (l.level || 'info');
          div.textContent = `[${l.time}] ${l.text}`;
          box.appendChild(div);
        }
        while (box.childNodes.length > 500) box.removeChild(box.firstChild);
        box.scrollTop = box.scrollHeight;
      }
    } catch { /* 服务重启中 */ }
  };
  tick();
  logTimer = setInterval(tick, 2000);
}

/* ---------- 启动 ---------- */
loadHeader().catch(() => {});
loadAlerts();
setInterval(loadAlerts, 60000); // 预警条独立于页签轮询，切页不被 clear

/* ---------- T29：SSE 推送（替代账号/任务/用量页的 setInterval 轮询）----------
 * 服务端把 bridge(20s)/tasks(30s)/usage(60s) 推成具名事件；收到对应事件后，
 * 若当前页签是目标页且不在加载中，就触发一次重渲染（复用现有 load* 函数与缓存数据结构）。
 * EventSource 建不上（老浏览器/代理不支持）时什么都不做——页签自己的 setInterval 轮询仍在。
 * 这里不直接用推送数据渲染（渲染函数都要配套的 promise/all 结构），只当「数据变了」信号。 */
(function startConsoleStream() {
  try {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/console/api/stream');
    let streamAlive = false;
    es.onopen = () => { if (!streamAlive) streamAlive = true; };
    const busy = {};
    es.addEventListener('bridge', () => maybeRefresh('bridge'));
    es.addEventListener('tasks', () => maybeRefresh('tasks'));
    es.addEventListener('usage', () => maybeRefresh('usage'));
    function maybeRefresh(kind) {
      // 总览大屏：bridge/tasks/usage 任一推送都值得重算（数据没变时 paint() 自会跳过）
      if (['bridge', 'tasks', 'usage'].includes(kind) && active === 'home' && !busy.overview) {
        busy.overview = true; loadOverview().finally(() => { busy.overview = false; });
      }
      // 只有「推送所属页签正被看着」才重渲染；busy 防抖（用户手动触发的加载不重复）
      if (kind === 'bridge' && active === 'accounts' && !busy.bridge) {
        busy.bridge = true; loadAccounts().finally(() => { busy.bridge = false; });
      }
      if (kind === 'tasks' && active === 'tasks' && !busy.tasks) {
        busy.tasks = true; loadTasks().finally(() => { busy.tasks = false; });
      }
      if (kind === 'usage' && active === 'usage' && !busy.usage) {
        busy.usage = true; loadUsage().finally(() => { busy.usage = false; });
      }
    }
    es.onerror = () => {
      /* 断线 EventSource 自动重连；轮询仍是兜底。
       * B1：但有一种断线不是网络抖动——CONSOLE_TOKEN 每次服务启动都重新随机生成，
       * 交棒重启后开着的老页签 token 立刻失效，服务端 401 关闭连接，EventSource 置
       * CLOSED 且不再自愈（CLOSED 正是「服务端拒绝、重连也没用」的信号）。此时刷新页面
       * 就能拿到新 token 并恢复推送；/health 守卫防止服务真挂了时无限刷新。 */
      if (es.readyState !== EventSource.CLOSED || sessionStorage.getItem('wbAutoReloaded')) return;
      sessionStorage.setItem('wbAutoReloaded', '1');
      fetch('/health').then((r) => {
        if (!r.ok) throw new Error('service down');
        location.reload(); // 服务活着 → 是会话 token 过期，刷新拿新的
      }).catch(() => { /* 服务真不在（正被交棒/看门狗拉起），等它起来刷新页面即自愈 */ })
        .finally(() => sessionStorage.removeItem('wbAutoReloaded'));
    };
  } catch { /* 不支持就全靠轮询 */ }
})();

showView(parseHash());
document.body.classList.add('hud-on'); // HUD 重设计层：环境背景/侧栏/状态条配色由此激活
