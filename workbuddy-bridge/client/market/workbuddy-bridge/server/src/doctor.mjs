// 一键诊断（T24，/wbp-doctor 命令与控制台「诊断」共用）：
// 把「服务健康 → 配置 → 站点登录态 → 账号池 → 路由 → 数据文件 → 后台循环」过一遍，
// 每项产出 { name, ok, detail }，汇总成 pass/warn/fail 计数与可读报告。
//
// 设计约束：
//   - 只读诊断：绝不改状态、绝不发上游对话请求（余额查询除外，那是只读接口且失败可降级）；
//   - 单项失败不拖垮整体：每项 try/catch，坏掉的那项标 fail 继续；
//   - 返回结构化数组而不是拼好的长文本——agent（/wbp-doctor）与前端（控制台）各自排版。
import fs from 'node:fs';
import path from 'node:path';
import { paths, siteKeys, authKeys } from './config.mjs';
import { writeJsonFileAtomic } from './util.mjs';
import { log, warn } from './log.mjs';
import { recordEvent } from './events.mjs';
import { notify } from './notify.mjs';
import { isLoggedIn, getAuth } from './auth.mjs';
import { listAccounts } from './pool.mjs';
import { getCatalog, mergedModels } from './router.mjs';
import { usageSnapshot } from './usage.mjs';
import { recentRequests } from './log.mjs';
import { recentEvents } from './events.mjs';
import { taskStatus } from './tasks.mjs';
import { healthStatus } from './health.mjs';
import { compressionStats } from './compress.mjs';
import { protocolCheckBrief } from './protocol.mjs';
import { localVersion as updatecheckLocalVersion } from './updatecheck.mjs';

/**
 * 跑一遍体检。返回：
 * {
 *   at, version, summary: { pass, warn, fail },
 *   checks: [{ name, level: 'pass'|'warn'|'fail', detail }],
 * }
 */
export async function runDiagnostics(cfg) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });

  // ---- 1. 服务本体 ----
  try {
    const uptime = process.uptime();
    add('服务进程', 'pass', `运行中，PID ${process.pid}，Node ${process.version}，已运行 ${Math.round(uptime / 60)} 分钟，监听 ${cfg.host}:${cfg.port}`);
  } catch (e) {
    add('服务进程', 'fail', String(e.message || e));
  }

  // ---- 2. 配置完整性（loadConfig 已做过校验回退，这里只报关键项）----
  try {
    const keys = authKeys(cfg);
    if (!keys.length) add('apiKey', 'warn', '未配置 apiKey——服务对本机不鉴权，建议在 config.json 补一个 sk-wb- 随机密钥');
    else add('apiKey', 'pass', `已配置 ${keys.length} 把密钥`);
    const sites = siteKeys(cfg);
    add('站点配置', sites.length ? 'pass' : 'fail', `${sites.length} 个站点启用：${sites.join('、') || '无'}`);
  } catch (e) {
    add('配置', 'fail', String(e.message || e));
  }

  // ---- 3. 数据目录可写性（落盘全靠它；只读会导致用量/池/任务全部静默失败）----
  try {
    const probe = path.join(paths.root, '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('数据目录', 'pass', `${paths.root}（可读写）`);
  } catch (e) {
    add('数据目录', 'fail', `${paths.root} 不可写：${e.message}——用量统计/账号池/任务状态都会保存失败`);
  }

  // ---- 4. 站点登录态与模型目录 ----
  try {
    for (const site of siteKeys(cfg)) {
      const s = cfg.sites[site];
      if (!isLoggedIn(site)) {
        add(`站点 ${site}`, 'warn', '未登录——控制台「＋ 添加账号」扫码，或 /wbp-import 导入本机登录态');
        continue;
      }
      const a = getAuth(site);
      const exp = a.expiresAt ? new Date(a.expiresAt) : null;
      const expSoon = exp && exp.getTime() - Date.now() < 24 * 3600e3;
      let cat;
      try {
        cat = await getCatalog(cfg, site, { force: false });
      } catch (e) {
        add(`站点 ${site}`, 'fail', `目录拉取失败：${e.message}`);
        continue;
      }
      const accs = listAccounts(site);
      const usable = accs.filter((x) => x.enabled !== false && x.accessToken && !x.exhaustedAt).length;
      add(
        `站点 ${site}`,
        cat.models.size ? 'pass' : 'warn',
        `已登录（uid=${(a.uid || '?').slice(0, 8)}…），${accs.length} 个账号（${usable} 可用），目录 ${cat.models.size} 个模型（来源 ${cat.source || '?'}）`
          + (exp ? `，token ${expSoon ? '24 小时内到期' : `至 ${exp.toLocaleDateString()}`}` : '')
          + (cat.error ? `；目录报错：${String(cat.error).slice(0, 80)}` : ''),
      );
    }
  } catch (e) {
    add('站点', 'fail', String(e.message || e));
  }

  // ---- 5. 账号池健康（失效/耗尽/冷却）----
  try {
    const problems = [];
    let total = 0;
    for (const site of siteKeys(cfg)) {
      for (const a of listAccounts(site)) {
        total++;
        if (a.enabled === false) problems.push(`${site}/${a.label || a.id} 已禁用`);
        else if (String(a.lastError || '').includes('401')) problems.push(`${site}/${a.label || a.id} 登录态失效（401）`);
        else if (a.exhaustedAt) problems.push(`${site}/${a.label || a.id} 额度耗尽`);
      }
    }
    if (!total) add('账号池', 'warn', '没有任何账号——对话功能不可用，先添加账号');
    else if (!problems.length) add('账号池', 'pass', `${total} 个账号全部健康`);
    else add('账号池', 'warn', `${total} 个账号中有问题：${problems.join('；')}`);
  } catch (e) {
    add('账号池', 'fail', String(e.message || e));
  }

  // ---- 6. 路由与模型目录（合并视角）----
  try {
    const merged = await mergedModels(cfg);
    if (!merged.length) add('模型目录', 'fail', '合并目录为空——没有站点可用，或白名单把模型全过滤了');
    else add('模型目录', 'pass', `${merged.length} 个模型可路由；default=${cfg.defaultModel}（站点 ${cfg.defaultSite}）`);
  } catch (e) {
    add('模型目录', 'fail', String(e.message || e));
  }

  // ---- 7. 最近请求成功率（有没有一直在失败）----
  try {
    const recent = recentRequests(50);
    if (!recent.length) add('最近请求', 'warn', '本进程还没有处理过任何模型请求');
    else {
      const bad = recent.filter((r) => (r.status || 200) >= 400).length;
      const rate = Math.round(((recent.length - bad) / recent.length) * 100);
      add('最近请求', bad > recent.length / 2 ? 'fail' : bad ? 'warn' : 'pass',
        `最近 ${recent.length} 次请求成功率 ${rate}%（${bad} 次失败）`);
    }
  } catch (e) {
    add('最近请求', 'fail', String(e.message || e));
  }

  // ---- 8. 数据文件完整性（能解析就过）----
  try {
    const files = ['config.json', 'usage.json', 'learned.json', 'tasks-state.json', 'events.json', 'health.json'];
    const stats = [];
    for (const name of files) {
      const f = path.join(paths.root, name);
      if (!fs.existsSync(f)) continue;
      try {
        JSON.parse(fs.readFileSync(f, 'utf8'));
        stats.push(name);
      } catch {
        add(`数据文件 ${name}`, 'fail', 'JSON 解析失败（旁边可能有 .corrupt-* 备份可手工抢救）');
      }
    }
    if (stats.length === files.filter((n) => fs.existsSync(path.join(paths.root, n))).length) {
      add('数据文件', 'pass', `已加载且合法：${stats.join('、') || '（还没有任何数据文件，正常——首次使用）'}`);
    }
  } catch (e) {
    add('数据文件', 'fail', String(e.message || e));
  }

  // ---- 9. 后台循环产出物（证明循环活着）----
  try {
    const tasks = taskStatus();
    const growthRuns = Object.values(tasks.growth || {}).length;
    const checkinRuns = Object.values(tasks.checkin || {}).length;
    add('自动任务', 'pass', `签到记录 ${checkinRuns} 个账号 · 成长任务记录 ${growthRuns} 个账号 · 任务状态文件正常`);
    // T66：连登管家巡检——漏跑一天连登断链重攒 7 天，值得单独一项盯住。
    // 只读本地 tasks-state，不发上游请求。签到时点已过且没有今天的 streak 记录 → warn。
    const streakEntries = Object.values(tasks.streak || {});
    const now0 = new Date();
    const todayStr = `${now0.getFullYear()}-${String(now0.getMonth() + 1).padStart(2, '0')}-${String(now0.getDate()).padStart(2, '0')}`;
    const hhmm = `${String(now0.getHours()).padStart(2, '0')}:${String(now0.getMinutes()).padStart(2, '0')}`;
    const times = Array.isArray(cfg.tasks?.checkinTimes) && cfg.tasks.checkinTimes.length ? cfg.tasks.checkinTimes : [];
    const pastDue = times.some((x) => x <= hhmm)
      || (Array.isArray(cfg.tasks?.checkinHours) && cfg.tasks.checkinHours.some((h) => h <= now0.getHours()));
    const ranToday = streakEntries.some((e) => e.date === todayStr && e.ok);
    if (ranToday) {
      const top = streakEntries.filter((e) => e.ok && e.date === todayStr).sort((a, b) => (b.days || 0) - (a.days || 0))[0];
      add('连登管家', 'pass', `今天已巡检${top ? `（连登 ${top.days ?? '?'} 天 · 下一档 ${top.nextTier || '—'} 差 ${top.nextTierRemaining ?? '?'} 天）` : ''}`);
    } else if (pastDue) {
      add('连登管家', 'warn', '今天签到时点已过但连登管家没有巡检记录——连登断链要重攒 7 天，点任务页「🔗 连登巡检」补跑');
    } else {
      add('连登管家', 'pass', '今天还没到签到时点（时点过后自动巡检，错过会补跑）');
    }
  } catch (e) {
    add('自动任务', 'fail', `任务状态读取失败：${e.message}`);
  }
  try {
    const h = healthStatus(cfg);
    add('模型巡检', h.lastScanAt ? 'pass' : 'warn',
      h.lastScanAt ? `上次巡检 ${new Date(h.lastScanAt).toLocaleString()}` : '从未巡检过（模型页可手动跑一轮）');
  } catch (e) {
    add('模型巡检', 'fail', String(e.message || e));
  }
  try {
    const comp = compressionStats();
    add('上下文压缩', comp.totals.count ? 'pass' : 'warn',
      comp.totals.count ? `累计压缩 ${comp.totals.count} 次，节省约 ${comp.totals.savedTokens.toLocaleString()} tokens` : '还没有压缩记录（长会话触发后这里会有数）');
  } catch (e) {
    add('上下文压缩', 'fail', String(e.message || e));
  }

  // ---- 10. 用量统计 ----
  try {
    const snap = usageSnapshot(1);
    add('用量统计', 'pass',
      `今日 ${snap.today?.calls || 0} 次调用、消耗 ${Math.round((snap.today?.credit || 0) * 100) / 100} 积分（估算口径）`);
  } catch (e) {
    add('用量统计', 'fail', String(e.message || e));
  }

  // ---- 11. 事件时间线里的最近异常（只看今天）----
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const badEvents = recentEvents({ limit: 60 }).filter(
      (e) => new Date(e.at) >= todayStart && (e.kind === 'account' || e.kind === 'credit'),
    );
    add('今日异常事件', badEvents.length ? 'warn' : 'pass',
      badEvents.length ? `${badEvents.length} 条（账号/积分类），最近一条：${badEvents[0].text.slice(0, 80)}` : '没有账号/积分类异常事件');
  } catch (e) {
    add('今日异常事件', 'fail', String(e.message || e));
  }

  // ---- 12. 版本与更新 ----
  try {
    const v = updatecheckLocalVersion();
    add('版本', 'pass', `workbuddy-bridge v${v}`);
  } catch (e) {
    add('版本', 'fail', String(e.message || e));
  }

  // ---- 13. 协议漂移（T39）----
  // 读上次探测结果（不现探，避免诊断本身去打上游）：漂移即 fail，
  // 并把不符的字段名逐条列出——那是「上游改版了」的定位线索。
  try {
    const p = protocolCheckBrief(cfg);
    const checked = p.sites.filter((x) => !x.skipped);
    if (!checked.length) {
      add('协议自检', 'warn', '还没有探测记录——控制台「协议」卡点「立即自检」，或等 6 小时缓存过期后自动跑');
    } else if (p.drifted) {
      const bad = checked.flatMap((x) => x.results.map((r) => `${x.site}/${r.key}：${r.detail}`));
      add('协议自检', 'fail', `${p.drifted}/${p.total} 项与预期不符，上游可能改版：${bad.slice(0, 3).join('；')}`);
    } else {
      add('协议自检', 'pass', `${p.sites.filter((x) => !x.skipped).map((x) => x.site).join('、')} 共 ${p.total} 项签名全部符合预期（上次 ${p.at ? new Date(p.at).toLocaleString() : '—'}）`);
    }
  } catch (e) {
    add('协议自检', 'fail', String(e.message || e));
  }

  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.level]++;
  return { at: new Date().toISOString(), version: updatecheckLocalVersion(), summary, checks };
}

/* ---------------- 每日自动体检（T67） ----------------
 * 上游是非官方接口，最怕的不是报错而是静默失效：腾讯改了端点，签到/对话
 * 默默失败好几天没人发现。本循环每天在 tasks.doctorTimes 时点自动跑一遍
 * runDiagnostics，有 fail 项就推一条汇总通知；全绿只记事件时间线，不打扰。
 * 模式照抄 weekly.mjs：状态落盘（doctor.json，补跑判定）、依赖注入（离线单测）、
 * 60s tick。与手动 /wbp-doctor 的区别只在于「自动 + 有异常才说话」。 */

const autoTimers = { tick: null };

function autoStateFile() {
  return path.join(paths.root, 'doctor.json');
}

function loadAutoState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveAutoState(file, data) {
  try { writeJsonFileAtomic(file, data); } catch (e) {
    // 状态写不进去只影响补跑判定（同一天可能重跑一次），不值得绊倒体检本身
    warn('每日体检状态保存失败：', e.message);
  }
}

const p2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/**
 * 每日体检 tick（依赖可注入，单测不碰生产数据目录与真实通知）。
 * 返回 { ok, skipped?, summary?, notified?, fails? }；
 * skipped: 'disabled'（时点数组为空）| 'no-account' | 'not-time' | 'already-run'。
 */
export async function doctorAutoTick(cfg, now = new Date(), {
  stateFile = null,
  diagnose = runDiagnostics,
  sendNotify = notify,
  fireEvent = recordEvent,
  hasAccount = null,
} = {}) {
  const times = Array.isArray(cfg.tasks?.doctorTimes) ? cfg.tasks.doctorTimes : ['10:00'];
  if (!times.length) return { ok: false, skipped: 'disabled' };
  // 没有任何已登录站点时跳过：裸服务（还没加账号）必然「模型目录为空」，天天报狼来了
  const has = hasAccount || (() => siteKeys(cfg).some((s) => isLoggedIn(s)));
  if (!has()) return { ok: false, skipped: 'no-account' };
  const today = dateKey(now);
  const hhmm = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
  const st = loadAutoState(stateFile || autoStateFile());
  if (st.lastRun === today) return { ok: false, skipped: 'already-run' };
  // 已过最早时点即跑——同 weekly 的补跑语义：60s tick 恰好命中那一分钟太脆弱，
  // 服务那一刻没活着（关机/重启），启动后第一条 tick 就把当天体检补上
  if (!times.some((t) => hhmm >= String(t).trim())) return { ok: false, skipped: 'not-time' };

  const report = await diagnose(cfg);
  const fails = report.checks.filter((c) => c.level === 'fail');
  let notified = false;
  if (fails.length) {
    // 气泡正文 180 字上限：逐条「名称：详情」，超出的靠控制台时间线回看
    const text = fails.map((c) => `${c.name}：${String(c.detail).slice(0, 60)}`).join('；');
    try {
      sendNotify(cfg, `每日体检 🔴 ${fails.length} 项异常`, text, { key: `doctor-${today}` });
      notified = true;
    } catch { /* 通知失败不绊倒体检 */ }
  }
  try {
    fireEvent('system', fails.length
      ? `每日体检：${fails.length}/${report.checks.length} 项异常（${fails.map((c) => c.name).slice(0, 4).join('、')}）`
      : `每日体检通过：${report.checks.length} 项全部正常`);
  } catch { /* 时间线失败不影响主流程 */ }
  saveAutoState(stateFile || autoStateFile(), {
    lastRun: today,
    at: report.at,
    summary: report.summary,
    failNames: fails.map((c) => c.name),
  });
  const s = report.summary;
  log(`每日体检完成：${s.pass} 过 / ${s.warn} 警告 / ${s.fail} 不及格${notified ? '（已通知）' : ''}`);
  return { ok: true, summary: report.summary, notified, fails: fails.map((c) => c.name) };
}

/** 启动每日体检调度（60s tick，与任务/周报循环同节奏；幂等）。 */
export function startDoctorLoop(cfg) {
  if (autoTimers.tick) return;
  if (Array.isArray(cfg.tasks?.doctorTimes) && cfg.tasks.doctorTimes.length === 0) {
    log('每日自动体检已关闭（tasks.doctorTimes=[]）');
    return;
  }
  autoTimers.tick = setInterval(() => {
    void doctorAutoTick(cfg).catch((e) => warn('每日体检调度异常：', e.message));
  }, 60_000);
  autoTimers.tick.unref?.();
}

export function stopDoctorLoop() {
  if (autoTimers.tick) clearInterval(autoTimers.tick);
  autoTimers.tick = null;
}
