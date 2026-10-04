/* ===== HUD 环境层：粒子 canvas（单帧 / DPR≤2 / resize 180ms 防抖 / 切后台停画）=====
 * 规格出自 CONSOLE-REDESIGN-PROMPT.md §6.0：粒子数按窗口面积自适应封顶，
 * 漂移光点 + 118px 内连线 + 拖尾光束 + 上升光子；document.hidden 直接跳过绘制。 */
(function () {
  var REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cv = document.getElementById('fx');
  if (!cv || !cv.getContext) return;
  if (REDUCE) { cv.style.display = 'none'; return; }
  var ctx = cv.getContext('2d');
  var W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  var dots = [], beams = [], motes = [], LINK = 118;
  var mx = -999, my = -999;

  function rand(a, b) { return a + Math.random() * (b - a); }

  function seed() {
    var n = Math.round(Math.min(58, Math.max(20, (W * H) / 24000)));
    dots = [];
    for (var i = 0; i < n; i++) dots.push({ x: rand(0, W), y: rand(0, H), vx: rand(-.15, .15), vy: rand(-.15, .15), r: rand(.6, 1.7), a: rand(.16, .5) });
    beams = [];
    var bn = Math.round(Math.min(7, Math.max(3, n / 9)));
    for (var j = 0; j < bn; j++) beams.push({ x: rand(0, W), y: rand(0, H), vx: rand(.5, 1.2), vy: rand(-.18, .18), len: rand(50, 118), a: rand(.22, .5), c: Math.random() > .5 ? '79,140,255' : '34,211,238' });
    motes = [];
    var mn = Math.round(Math.min(18, Math.max(8, n / 3)));
    for (var k = 0; k < mn; k++) motes.push({ x: rand(0, W), y: rand(0, H), vy: rand(-.35, -.12), r: rand(.7, 1.5), a: rand(.2, .55), t: rand(14, 34) });
  }

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function frame() {
    requestAnimationFrame(frame);
    if (document.hidden) return; // 切后台停画（rAF 仍在但不绘制，回来即恢复）
    ctx.clearRect(0, 0, W, H);
    var i, j, a, b, dx, dy, d2;
    for (i = 0; i < dots.length; i++) {
      a = dots[i];
      if (mx > -900) {
        dx = mx - a.x; dy = my - a.y; d2 = Math.sqrt(dx * dx + dy * dy);
        if (d2 < 150 && d2 > 1) { a.vx += dx / d2 * 0.006; a.vy += dy / d2 * 0.006; }
      }
      a.vx = Math.max(-.5, Math.min(.5, a.vx)); a.vy = Math.max(-.5, Math.min(.5, a.vy));
      a.x += a.vx; a.y += a.vy;
      if (a.x < -20) a.x = W + 20; if (a.x > W + 20) a.x = -20;
      if (a.y < -20) a.y = H + 20; if (a.y > H + 20) a.y = -20;
      for (j = i + 1; j < dots.length; j++) {
        b = dots[j]; dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK) {
          ctx.strokeStyle = 'rgba(120,165,255,' + ((1 - d2 / (LINK * LINK)) * 0.12).toFixed(3) + ')';
          ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      ctx.fillStyle = 'rgba(205,228,255,' + a.a.toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill();
    }
    for (i = 0; i < motes.length; i++) {
      var m = motes[i]; m.y += m.vy;
      if (m.y < -20) { m.y = H + 20; m.x = rand(0, W); }
      var g = ctx.createLinearGradient(m.x, m.y, m.x, m.y + m.t);
      g.addColorStop(0, 'rgba(160,215,255,' + m.a + ')'); g.addColorStop(1, 'rgba(160,215,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = m.r;
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x, m.y + m.t); ctx.stroke();
      ctx.fillStyle = 'rgba(235,248,255,' + Math.min(.85, m.a + .3) + ')';
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r * .8, 0, Math.PI * 2); ctx.fill();
    }
    for (i = 0; i < beams.length; i++) {
      b = beams[i]; b.x += b.vx; b.y += b.vy;
      if (b.x - b.len > W) { b.x = -b.len; b.y = rand(0, H); }
      if (b.y < -30) b.y = H + 30; if (b.y > H + 30) b.y = -30;
      var g2 = ctx.createLinearGradient(b.x, b.y, b.x - b.len, b.y - b.vy * 60);
      g2.addColorStop(0, 'rgba(' + b.c + ',' + b.a + ')'); g2.addColorStop(1, 'rgba(' + b.c + ',0)');
      ctx.strokeStyle = g2; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - b.len, b.y - b.vy * 60); ctx.stroke();
      ctx.fillStyle = 'rgba(235,248,255,' + Math.min(.9, b.a + .35) + ')';
      ctx.beginPath(); ctx.arc(b.x, b.y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
  }

  resize();
  var t;
  window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(resize, 180); });
  window.addEventListener('pointermove', function (e) { mx = e.clientX; my = e.clientY; }, { passive: true });
  requestAnimationFrame(frame);
})();

/* ===== 光标聚光灯（--mx/--my CSS 变量，rAF 节流）===== */
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var px = 0, py = 0, raf = 0;
  window.addEventListener('pointermove', function (e) {
    px = e.clientX; py = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      var s = document.documentElement.style;
      s.setProperty('--mx', px + 'px'); s.setProperty('--my', py + 'px');
    });
  }, { passive: true });
})();

/* ===== 卡片 3D 倾斜（±0.96°/±1.2°，perspective 1500px，rAF 节流，上限常量 MAX=2.4）===== */
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia('(hover:hover)').matches) return;
  function bind(c) {
    if (c.__wbTilt) return;
    c.__wbTilt = true;
    var MAX = 2.4; /* 最大倾斜角（度）；与 perspective 1500px、150ms 过渡配套，单独调一个没用 */
    var raf = 0, tx = 0, ty = 0;
    function apply() { raf = 0; c.style.transform = 'perspective(1500px) rotateX(' + tx + 'deg) rotateY(' + ty + 'deg)'; }
    c.addEventListener('pointermove', function (e) {
      var r = c.getBoundingClientRect();
      tx = (-(e.clientY - r.top) / r.height + .5) * MAX * .8;
      ty = ((e.clientX - r.left) / r.width - .5) * MAX;
      if (!raf) raf = requestAnimationFrame(apply);
    });
    c.addEventListener('pointerleave', function () { c.style.transform = ''; });
  }
  /* render 都走 innerHTML 重建，用事件委托在 document 上做 pointermove 找最近卡片 */
  document.addEventListener('pointermove', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('.card.tilt') : null;
    if (c) bind(c);
  }, { passive: true });
})();

/* ===== 入场动画结束后释放 transform（让 tilt 接管）===== */
document.addEventListener('animationend', function (e) {
  if (e.target && e.target.classList && e.target.classList.contains('an')) e.target.classList.remove('an');
});

/* ===== 按钮涟漪 ===== */
document.addEventListener('click', function (e) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var b = e.target.closest && e.target.closest('.btn, .dock .items button');
  if (!b) return;
  var r = b.getBoundingClientRect();
  var s = document.createElement('span');
  var d = Math.max(r.width, r.height) * 2.2;
  s.className = 'ripple';
  s.style.width = s.style.height = d + 'px';
  s.style.left = (e.clientX - r.left) + 'px';
  s.style.top = (e.clientY - r.top) + 'px';
  b.appendChild(s);
  setTimeout(function () { s.remove(); }, 540);
});

/* ===== 主题化 tooltip 引擎：接管全页 [title]（原生 title 延迟且不可样式化）=====
 * 规则：mouseenter 延时 350ms 显示；固定定位跟随目标元素；Esc/scroll/leave 隐藏；
 * 尊重 reduced-motion（直接显示无动画）；不碰 contenteditable/input 内部拖选。 */
(function () {
  if (window.__wbTip) return;
  window.__wbTip = true;
  var el = null, timer = 0, cur = null;
  var mx = 0, my = 0, raf = 0;
  function place() {
    raf = 0;
    if (!el || !cur) return;
    var w = el.offsetWidth, h = el.offsetHeight;
    var x = mx + 14, y = my + 16;
    if (x + w > window.innerWidth - 8) x = mx - w - 12;      // 右边放不下翻到左侧
    if (y + h > window.innerHeight - 8) y = my - h - 12;     // 下方放不下翻到上方
    el.style.left = Math.max(8, Math.round(x)) + 'px';
    el.style.top = Math.max(8, Math.round(y)) + 'px';
  }
  function show(target) {
    var txt = target.getAttribute('title');
    if (!txt) return;
    target.setAttribute('data-wbtiptext', txt);
    target.removeAttribute('title'); // 防止原生 tooltip 与自定义层同显
    cur = target;
    if (!el) { el = document.createElement('div'); el.className = 'wbtip'; document.body.appendChild(el); }
    el.textContent = txt;
    el.classList.add('show');
    place();
    startWatch();
  }
  function hide() {
    if (cur) { cur.setAttribute('title', cur.getAttribute('data-wbtiptext') || ''); cur.removeAttribute('data-wbtiptext'); cur = null; }
    if (el) el.classList.remove('show');
    clearInterval(watch); watch = 0;
  }
  var watch = 0;
  function startWatch() {
    clearInterval(watch);
    watch = setInterval(function () {
      if (!cur) { clearInterval(watch); watch = 0; return; }
      var r = cur.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < -40 || r.top > window.innerHeight + 40 || r.right < 0 || r.left > window.innerWidth) { hide(); return; } // 目标隐藏/滚出视口即隐
      place(); // 内容自动刷新导致目标位移时跟随（fixed 定位不随文档流，需手动校正）
    }, 200);
  }
  document.addEventListener('pointermove', function (e) {
    mx = e.clientX; my = e.clientY;
    if (cur) {
      // 移到无 title 的空白处：mouseout 可能因快速划过/子元素边界抖动而漏发，这里兜底——
      // 只要当前指针位置的祖先链上既无 [title] 也无 [data-wbtiptext]（即不是 cur 及其内部），立即隐藏
      var t = e.target && e.target.closest ? (e.target.closest('[title]') || e.target.closest('[data-wbtiptext]')) : null;
      if (t !== cur && !cur.contains(e.target)) { hide(); return; }
      place();
    }
  }, { passive: true });
  document.addEventListener('mouseover', function (e) {
    var t = e.target && e.target.closest ? (e.target.closest('[title]') || e.target.closest('[data-wbtiptext]')) : null;
    if (!t || t === cur) return;
    mx = e.clientX || 0; my = e.clientY || 0; // 首次悬停时 pointermove 可能未发生，用事件自带坐标
    clearTimeout(timer);
    timer = setTimeout(function () { show(t); }, 250);
  }, true);
  document.addEventListener('mouseout', function (e) {
    /* show() 时摘掉了原元素 title（换 data-wbtiptext 标记），closest('[title]') 会扑空——
     * 必须同时找标记属性，否则移出永远匹配不到 → tooltip 永不消失（用户实测 bug） */
    var t = e.target && e.target.closest ? (e.target.closest('[title]') || e.target.closest('[data-wbtiptext]')) : null;
    if (t && t === cur) { clearTimeout(timer); hide(); }
  }, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('click', hide, true);   // 点击即隐（防面板/弹层打开后残留遮内容）
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
})();
