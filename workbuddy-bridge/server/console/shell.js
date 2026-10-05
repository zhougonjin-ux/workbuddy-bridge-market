/* ===== HUD 壳层：4 导航 + 页内分段 + 顶栏/状态条/侧栏统计 + 悬浮操作坞 =====
 * 约束（CONSOLE-REDESIGN-PROMPT.md §3）：
 *  - 不重写 setView/VIEWS；导航点击包一层现有 showView。
 *  - 页内分段（资源池=账号/模型、运维中心=任务/用量/事件）是**同页就地切换**：
 *    直接切 section hidden + 触发 app.js 已有的 load* 函数，不调 showView、
 *    不动 hash、不进 backBar 历史（backBar 的返回目标 = 该分段组第一个 view）。
 *  - 本文件加载于 app.js 之前；app.js 的函数都是全局 function 声明（提升），
 *    用户点击时一定已定义。 */
(function () {
  var REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 导航 ↔ 视图映射（资源池/运维中心各含多个 view，分段负责组内切换） ---------- */
  var NAVS = {
    home: { name: '总控台', sub: '双协议代理 · 核心指标一处可见', views: ['home'] },
    res:  { name: '资源池', sub: '账号 / 模型 集中管理', views: ['accounts', 'models'], segs: [['accounts', '账号'], ['models', '模型']] },
    ops:  { name: '运维中心', sub: '任务 / 用量 / 事件', views: ['tasks', 'usage', 'events'], segs: [['tasks', '任务'], ['usage', '用量'], ['events', '事件']] },
    sys:  { name: '系统设置', sub: '接入 / 通知 / 备份 / 诊断 / 日志', views: ['settings'] },
    help: { name: '使用说明', sub: '快速上手 · 功能导览 · 常见问题', views: ['help'] },
  };
  var VIEW2NAV = { home: 'home', accounts: 'res', models: 'res', tasks: 'ops', usage: 'ops', events: 'ops', settings: 'sys', help: 'help' };
  var curNav = 'home';
  var segBar = null;

  /* ---------- 分段条（插在 backBar 之后，资源池/运维中心才显示） ---------- */
  function ensureSegBar() {
    if (segBar) return segBar;
    segBar = document.createElement('div');
    segBar.className = 'segbar';
    segBar.id = 'segBar';
    segBar.hidden = true;
    segBar.innerHTML = '<div class="seg" id="segBtns"></div>';
    var backBar = document.getElementById('backBar');
    backBar.parentNode.insertBefore(segBar, backBar.nextSibling);
    segBar.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-view]');
      if (!b) return;
      switchSeg(b.getAttribute('data-view'));
    });
    return segBar;
  }

  /* 分段切换：就地切 hidden + 触发对应 load 函数（app.js 的 showView 里有同一套加载逻辑，
   * 这里复刻其「进入视图」分支但不写 hash、不记历史）。 */
  function switchSeg(view) {
    const keepY = window.scrollY; // 分段是同页就地切换：保滚动位置（「返回大屏」走 showView 才回顶）
    for (const v of window.__wbViews()) { const el = document.getElementById('view-' + v); if (el) el.hidden = v !== view; }
    segBar.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-view') === view); });
    window.__wbSegKeepScroll = keepY; // app.js 的 enterView 读它决定是否回顶
    window.__wbEnterView(view);   // app.js 提供：与 showView 的加载分支同一套（clearInterval+load+定时器）
    requestAnimationFrame(function () { window.scrollTo(0, keepY); }); // 高度变化后仍钉在原位，消除宽度/高度跳动感
    window.__wbSegKeepScroll = null;
    replay(document.getElementById('view-' + view));
  }

  function renderSegBar(view) {
    var nav = VIEW2NAV[view] || 'home';
    var def = NAVS[nav];
    if (!def.segs) { if (segBar) segBar.hidden = true; return; }
    ensureSegBar();
    segBar.hidden = false;
    segBar.querySelector('#segBtns').innerHTML = def.segs.map(function (d) {
      return '<button data-view="' + d[0] + '" class="' + (d[0] === view ? 'on' : '') + '">' + d[1] + '</button>';
    }).join('');
  }

  function replay(section) {
    /* 用户反馈「切 tab 页面会闪」：旧 .warp 让整段 opacity 0→1 整块闪。改为只对卡片
     * 做一次性快速提亮（stagger 40ms，700ms 内结束），不整段重绘。 */
    if (!section || REDUCE) return;
    section.querySelectorAll('.card').forEach(function (c, i) {
      c.classList.remove('wb-dim'); void c.offsetWidth;
      c.style.animationDelay = Math.min(i * 40, 320) + 'ms';
      c.classList.add('wb-dim');
      setTimeout(function () { c.classList.remove('wb-dim'); c.style.animationDelay = ''; }, 700 + i * 40);
    });
  }
  window.__wbReplay = replay;

  /* ---------- 导航点击 ---------- */
  document.getElementById('nav').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-v]');
    if (!btn) return;
    var v = btn.getAttribute('data-v');
    if (v === 'theme') { toggleTheme(); return; }
    curNav = v;
    document.querySelectorAll('#nav button[data-v]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === v);
    });
    var def = NAVS[v];
    var target = def.views[0];
    window.showView(target);          // 走原有 showView：hash/返回条/加载全部保持现状
    renderSegBar(target);
    var crumb = document.getElementById('crumb');
    crumb.textContent = def.name; crumb.setAttribute('data-t', def.name);
    document.getElementById('crumbSub').textContent = def.sub;
    if (!REDUCE) {
      crumb.classList.remove('go'); void crumb.offsetWidth; crumb.classList.add('go');
      setTimeout(function () { crumb.classList.remove('go'); }, 560);
    }
  });

  /* ---------- app.js showView 之后的同步（hash 直达/返回条回退都会经过这里） ---------- */
  var lastSync = '';
  setInterval(function () {
    var active = window.__wbActiveView;
    if (!active || active === lastSync) return;
    lastSync = active;
    var nav = VIEW2NAV[active] || 'home';
    curNav = nav;
    document.querySelectorAll('#nav button[data-v]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === nav);
    });
    renderSegBar(active);
    var def = NAVS[nav];
    document.getElementById('crumb').textContent = def.name;
    document.getElementById('crumbSub').textContent = def.sub;
  }, 200);

  /* ---------- 主题系统：四档主题面板（暗色 HUD/亮色/墨蓝/暖沙） ---------- */
  var THEMES = [
    { id: 'dark',     name: '暗色（默认）', sw: 'linear-gradient(135deg,#0e1014 50%,#4f8cff 50%)' },
    { id: 'light',    name: '亮色',        sw: 'linear-gradient(135deg,#f2f4f8 50%,#2f6de0 50%)' },
    { id: 'midnight', name: '墨蓝',        sw: 'linear-gradient(135deg,#0a1020 50%,#5ea0ff 50%)' },
    { id: 'sand',     name: '暖沙',        sw: 'linear-gradient(135deg,#f4efe6 50%,#b4711e 50%)' },
    { id: 'guofeng',  name: '古风',        sw: 'linear-gradient(135deg,#f5f1e8 50%,#9e3d3d 50%)' },
    { id: 'cyber',    name: '科技',        sw: 'linear-gradient(135deg,#020604 50%,#00e68c 50%)' },
    { id: 'sakura',   name: '樱花',        sw: 'linear-gradient(135deg,#fbf0f3 50%,#e0527e 50%)' },
  ];
  var themePanel = document.getElementById('themePanel');
  function applyTheme(id) {
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem('wbTheme', id); } catch (e) { /* 隐私模式等 */ }
    if (themePanel) themePanel.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-theme-id') === id);
    });
    var th = document.getElementById('ovTheme');
    if (th) th.textContent = id === 'dark' ? '🌙 切暗色' : id === 'light' ? '☀️ 切亮色' : '🎨 主题';
  }
  function buildThemePanel() {
    if (!themePanel) return;
    themePanel.innerHTML = THEMES.map(function (t) {
      return '<button data-theme-id="' + t.id + '"><span class="sw" style="background:' + t.sw + '"></span>' + t.name + '</button>';
    }).join('');
    themePanel.querySelectorAll('button').forEach(function (b) {
      b.onclick = function () { applyTheme(b.getAttribute('data-theme-id')); themePanel.hidden = true; document.body.classList.remove('wbpanel-open'); };
    });
    applyTheme(document.documentElement.dataset.theme);
  }
  function toggleTheme() {
    if (!themePanel.innerHTML) buildThemePanel();
    if (themePanel.hidden) {
      var btn = document.getElementById('navTheme');
      var r = btn.getBoundingClientRect();
      if (themePanel.parentElement !== document.body) document.body.appendChild(themePanel); // .side 有 backdrop-filter 会造 stacking context，面板放里面会被主区盖住（用户实测选不到）
      themePanel.style.top = (r.bottom + 8) + 'px';
      var pl = Math.min(Math.max(8, r.right - 176), window.innerWidth - 184); // 面板宽 176，右缘对齐按钮
      themePanel.style.left = pl + 'px';
      themePanel.style.right = 'auto';
      themePanel.hidden = false;
      document.body.classList.add('wbpanel-open');
    } else {
      themePanel.hidden = true;
      document.body.classList.remove('wbpanel-open');
    }
  }
  document.addEventListener('click', function (e) {
    if (!themePanel.hidden && !themePanel.contains(e.target) && e.target.id !== 'navTheme' && !e.target.closest('#navTheme')) { themePanel.hidden = true; document.body.classList.remove('wbpanel-open'); }
  });
  // localStorage 旧值兼容：非法值才回默认；合法值（含七档）原样保留不再洗掉
  (function () {
    var cur = document.documentElement.dataset.theme;
    if (!THEMES.some(function (t) { return t.id === cur; })) applyTheme('dark');
  })();
  /* URL 深链 ?theme=light|dark：优先于 localStorage（无头截图/分享指定主题用）。
   * 只在本页生效不写回存储——localStorage 仍是用户的持久选择。 */
  (function () {
    var m = /[?&]theme=(light|dark|midnight|sand|guofeng|cyber|sakura)/.exec(location.search);
    if (m && m[1] !== document.documentElement.dataset.theme) {
      document.documentElement.dataset.theme = m[1];
    }
  })();

  /* ---------- 顶栏 chips / 状态条 / 侧栏统计（全部复用现有接口与字段） ---------- */
  function fmt(n) {
    n = Number(n); if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function fmtHr(ms) {
    var m = Math.round((ms || 0) / 60000);
    if (m < 60) return m + ' 分';
    return (m / 60).toFixed(1) + ' 时';
  }
  function fill(data) {
    var st = data.state, br = data.bridge, u = data.usage, doc = data.doctor;
    if (!st || !br) return;
    var anyLogin = (st.sites || []).some(function (s) { return s.logged_in; });
    const chipEp = document.getElementById('chipEndpoint');
    chipEp.textContent = (st.base_url || '').replace('http://', '');
    chipEp.title = '点击复制 Base URL：' + (st.base_url || '');
    chipEp.style.cursor = 'pointer';
    chipEp.onclick = function () { navigator.clipboard?.writeText(st.base_url || '').then(function () { window.toast && window.toast('已复制 Base URL', 'ok'); }); };
    const chipDoc = document.getElementById('chipDoctor');
    chipDoc.title = '一键诊断结果（通过/警告/失败）· 与 /wbp-doctor 同源 · 点击到系统设置运行诊断';
    chipDoc.style.cursor = 'pointer';
    chipDoc.onclick = function () { if (window.showView) window.showView('settings'); };
    const chipRun2 = document.getElementById('chipRun');
    chipRun2.title = anyLogin ? '至少一个站点已登录，服务可正常代理' : '还没有已登录账号：到资源池扫码或导入本机登录态';
    document.getElementById('chipRun').innerHTML = '<span class="dot' + (anyLogin ? '' : ' off') + '"></span>' + (anyLogin ? '运行中' : '未登录');
    document.getElementById('chipModel').innerHTML = '默认 <b>' + (st.default_model || '—') + '</b>';
    document.getElementById('chipModel').onclick = function () { if (window.showView) window.showView('models'); };
    if (doc && doc.summary) {
      document.getElementById('chipDoctor').innerHTML =
        '<span class="p ' + (doc.summary.fail ? 'bd' : 'ok') + '"></span>诊断 <b>' + doc.summary.pass + '</b> 过 · <b style="color:var(--wn)">' + doc.summary.warn + '</b> 警';
    }
    document.getElementById('footState').textContent = anyLogin ? '服务运行中' : '未登录账号';
    document.getElementById('footEndpoint').textContent = (st.base_url || '').replace('http://', '');
    var accN = 0, batchN = 0;
    for (var s of (br.sites || [])) for (var a of (s.accounts || [])) { accN++; batchN += (a.creditDetail || []).length; }
    document.getElementById('footAcc').textContent = accN;
    document.getElementById('footCalls').textContent = fmt((u.today || {}).calls);
    document.getElementById('footCredit').textContent = fmt((u.today || {}).credit);
    document.getElementById('footModel').textContent = st.default_model || '—';
    document.getElementById('footUptime').textContent = '运行 ' + fmtHr(st.uptime_ms);
    document.getElementById('footNote').textContent = 'v' + (st.version || '?') + ' · 数据取自本机实时接口';
    var total = 0;
    for (var s2 of (br.sites || [])) for (var a2 of (s2.accounts || [])) {
      if (a2.enabled === false) continue;
      for (var bt of (a2.creditDetail || [])) total += (bt.remain || 0);
    }
    document.getElementById('sideStats').innerHTML =
      '<div><span>积分总量</span><b>' + fmt(total) + '</b></div>' +
      '<div><span>账号 / 批次</span><b>' + accN + ' / ' + batchN + '</b></div>' +
      '<div><span>模型目录</span><b>' + (data.models || '—') + '</b></div>' +
      '<div><span>今日调用</span><b>' + fmt((u.today || {}).calls) + '</b></div>' +
      '<div><span>今日积分</span><b>' + fmt((u.today || {}).credit) + '</b></div>';
    document.getElementById('sideSrvState').textContent = anyLogin ? '服务运行中' : '未登录账号';
    document.getElementById('sideVer').textContent = 'v' + (st.version || '?') + ' · :' + ((st.base_url || '').match(/:(\d+)/) || ['', ''])[1];
    document.getElementById('sideSrvMeta').textContent = 'Node ' + (st.node || '') + ' · 运行 ' + fmtHr(st.uptime_ms);
  }
  async function refreshChrome() {
    try {
      var api = window.__wbApi;
      if (!api) return;
      var st = await api('/state');
      var br = await api('/bridge');
      var u = await api('/usage?days=7').catch(function () { return {}; });
      var doc = await api('/doctor').catch(function () { return null; });
      var models = null;
      try { var m = await api('/models'); models = (m.data || []).filter(function (x) { return !x.pending_login; }).length; } catch (e) { }
      fill({ state: st, bridge: br, usage: u, doctor: doc, models: models });
    } catch (e) { /* 服务重启中，下轮再填 */ }
  }
  refreshChrome();
  setInterval(refreshChrome, 30000);

  /* ---------- 复制配置按钮（复用 app.js 的 copy/toast） ---------- */
  document.getElementById('btnCopyCfg').onclick = async function () {
    var api = window.__wbApi; if (!api) return;
    try {
      var c = await api('/zcode-config');
      var text = ['ZCode 模型供应商配置（OpenAI 兼容）：', 'Base URL: ' + c.base_url, 'API Key: ' + c.api_key, '模型 ID: ' + c.model].join('\n');
      const done = function () { window.toast && window.toast('已复制 ZCode 接入配置', 'ok'); };
      const fail = function () { window.toast && window.toast('复制失败：浏览器未聚焦，请切到页面后重试', 'bad'); };
      navigator.clipboard?.writeText(text).then(done, function () {
        // 兜底：隐藏 textarea + execCommand（后台窗口也能复制）
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy') ? done() : fail(); } catch (e2) { fail(); }
        ta.remove();
      });
    } catch (e) { window.toast && window.toast('复制失败：' + e.message, 'bad'); }
  };

  /* ---------- 悬浮操作坞 ---------- */
  var dock = document.getElementById('dock');
  document.getElementById('navTheme').addEventListener('click', function (e) { e.stopPropagation(); toggleTheme(); });
  document.getElementById('fab').addEventListener('click', function (e) { e.stopPropagation(); dock.classList.toggle('open'); });
  document.addEventListener('click', function (e) {
    if (!dock.contains(e.target)) dock.classList.remove('open');
  });
  dock.addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-dock]');
    if (!b) return;
    dock.classList.remove('open');
    var api = window.__wbApi;
    var act = b.getAttribute('data-dock');
    try {
      if (act === 'copycfg') { document.getElementById('btnCopyCfg').click(); return; }
      if (!api) return;
      if (act === 'tasks') {
        window.toast && window.toast('正在执行一轮任务…');
        var r = await api('/tasks/run', { method: 'POST', body: { kind: 'all' } });
        var parts = [];
        for (var k in (r.results || {})) parts.push(k + ' 成功' + (r.results[k].ok || 0));
        window.toast && window.toast('任务完成 —— ' + parts.join('；'), 'ok');
        if (window.loadOverview) window.loadOverview();
      } else if (act === 'doctor') {
        var d = await api('/doctor');
        window.toast && window.toast('诊断完成：' + d.summary.pass + ' 通过 / ' + d.summary.warn + ' 警告 / ' + d.summary.fail + ' 失败', d.summary.fail ? 'bad' : 'ok');
      } else if (act === 'refresh') {
        await api('/credit/refresh', { method: 'POST' });
        window.toast && window.toast('积分明细已刷新', 'ok');
        if (window.loadOverview) window.loadOverview();
      } else if (act === 'csv') {
        var res = await fetch('/console/api/usage/export?days=30', { headers: { 'X-Console-Token': (window.__WB_TOKEN_REF || '') } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var blob = await res.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'workbuddy-usage-30d.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        window.toast && window.toast('已导出近 30 天报表', 'ok');
      }
    } catch (e2) { window.toast && window.toast('操作失败：' + e2.message, 'bad'); }
  });
})();
