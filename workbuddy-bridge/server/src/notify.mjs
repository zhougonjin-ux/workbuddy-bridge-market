// 通知（T11 桌面气泡 + T33 外部通道）：签到失败 / 猫猫归来 / 账号登录态失效 /
// 预算预警这类「不看控制台就错过」的事，弹一个系统 toast，并可同时推到手机。
//
// 桌面气泡实现：零依赖，走 Windows 自带的 PowerShell + System.Windows.Forms.NotifyIcon
// 气泡通知（Win10/11 均可用，无需 BurntToast 模块）。要点：
//   - spawn 分离进程（detached + unref），通知的生命周期不占本服务，也不阻塞调用方；
//   - 参数经 stdin 传 JSON（命令行传中文在 cmd/chcp 65001 之外的终端会乱码）；
//   - 全程吞错：通知是锦上添花，绝不能绊倒任务主流程；
//   - 节流：同一 key（如 "account-401-acc_x"）5 分钟内只弹一次，防止上游持续 401
//     时每 30 秒积分刷新都弹一遍。
// 非 Windows 平台静默跳过；notify.enabled=false（config）关闭桌面气泡。
//
// T33 外部通道：同一条通知并行分发到 config.notify.channels 里的
// webhook / bark / serverchan，用途是「人不在电脑前也能收」（配合 T38 手机端控制台）。
// 通道投递是 fire-and-forget：notify() 同步返回，HTTP 在后台跑，永不影响调用方。
import { spawn } from 'node:child_process';
import { log, warn } from './log.mjs';

const THROTTLE_MS = 5 * 60_000;
const lastFired = new Map(); // key → 时间戳
let psBusy = false;          // 上一条通知还没吐完时丢弃新的（气泡本来就最多同屏几条）

/** 纯函数便于单测：节流判断 + 过期键清理。 */
export function shouldNotify(key, now = Date.now(), store = lastFired) {
  const last = store.get(key) || 0;
  if (now - last < THROTTLE_MS) return false;
  store.set(key, now);
  if (store.size > 100) {
    for (const [k, t] of store) if (now - t > THROTTLE_MS) store.delete(k);
  }
  return true;
}

function firePS(title, text) {
  if (process.platform !== 'win32') return false;
  if (psBusy) return false;
  psBusy = true;
  try {
    // -NoProfile 加速启动；STA 是 NotifyIcon 的要求；stdin 喂参数避免命令行中文乱码
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', `
$input_json = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(8000, $input_json.title, $input_json.text, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 9
$n.Dispose()
`], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.stdin.end(JSON.stringify({ title: String(title).slice(0, 60), text: String(text).slice(0, 180) }));
    child.on('error', () => { psBusy = false; });
    child.on('exit', () => { psBusy = false; });
    child.unref?.();
    return true;
  } catch (e) {
    psBusy = false;
    warn('桌面通知发送失败：', e.message);
    return false;
  }
}

/**
 * 发一条通知：桌面气泡（T11）+ 外部通道（T33）并行。
 * key 相同的 5 分钟内只发一次（两个通道各自独立节流）；
 * opts:{ key, force } 可去重/强发；_fire 供测试注入。
 * 返回是否真的弹了桌面气泡（供测试断言）。
 *
 * 外部通道在平台判断**之前**分发：气泡只在 Windows 有，通道是跨平台的，
 * 放在后面会被 `process.platform !== 'win32'` 提前 return 吃掉。
 * 反过来节流也不能共用 key——气泡用裸 key，通道用 `ch-<type>-` 前缀，各走各的表。
 */
export function notify(cfg, title, text, { key = null, force = false, _fire = firePS } = {}) {
  if (cfg?.notify?.enabled === false) return false;
  // 通道投递是 fire-and-forget，异常已在内部吞掉
  try { notifyChannels(cfg, title, text, { key, force }); } catch { /* 旁观者不绊倒主流程 */ }
  try {
    if (process.platform !== 'win32') return false;
    if (!force && key && !shouldNotify(key)) return false;
    const ok = _fire(title, text);
    if (ok) log(`桌面通知：${title} — ${String(text).slice(0, 80)}`);
    return ok;
  } catch {
    return false;
  }
}

/** 便捷包装：任务类通知（自动带任务 key 去重）。cfg 缺省时用空配置（仍受平台限制）。 */
export function notifyTask(cfg, title, text, keySuffix = '') {
  return notify(cfg, title, text, { key: `task-${title}-${keySuffix}` });
}

/* ---------------- T33：外部通知通道（Webhook / Bark / Server酱） ---------------- */
// 桌面气泡只在人守着电脑时有用。这三个通道把同一条通知推到手机：
//   webhook    —— 自建/第三方通用 webhook，POST JSON { title, text }
//   bark       —— Bark 推送服务：GET <url>/<title>/<body>
//   serverchan —— Server 酱：POST <url>，表单 title= & desp=
// 全部 fire-and-forget：投递在后台跑，notify() 立刻返回，绝不阻塞任务主流程。
// 节流复用 shouldNotify 的同一张表（按通道分 key），一个通道坏了不影响别的。

const CHANNEL_TYPES = new Set(['webhook', 'bark', 'serverchan', 'feishu', 'dingtalk', 'telegram']);

/** 清洗成 URL 安全的一段（title/body 里可能有空格与中文）。 */
function urlSeg(s, max = 80) {
  return encodeURIComponent(String(s ?? '').slice(0, max));
}

/** 配置里已启用的通道（纯函数便于单测：类型合法 + enabled 不为 false + url 非空）。 */
export function enabledChannels(cfg) {
  const list = cfg?.notify?.channels;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && CHANNEL_TYPES.has(String(c.type)) && c.url && c.enabled !== false)
    .map((c) => ({ type: String(c.type), url: String(c.url).trim() }));
}

/**
 * 构造一次投递的 { url, init }（纯函数，便于单测断言各通道的报文形状）。
 * 返回 null 表示这个通道构造不出合法请求。
 */
export function buildChannelRequest(ch, title, text) {
  const t = String(title ?? '');
  const b = String(text ?? '');
  if (ch.type === 'webhook') {
    return {
      url: ch.url,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t, text: b }) },
    };
  }
  if (ch.type === 'bark') {
    // Bark 的设备 key 已在 url 里，正文追加两个路径段（官方协议就是 GET 路径参数）
    return {
      url: `${ch.url.replace(/\/+$/, '')}/${urlSeg(t)}/${urlSeg(b, 200)}`,
      init: { method: 'GET' },
    };
  }
  if (ch.type === 'serverchan') {
    return {
      url: ch.url,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title: t, desp: b }).toString(),
      },
    };
  }
  // T62：飞书自定义机器人 / 钉钉自定义机器人 / Telegram Bot。
  //   feishu   POST {msg_type:'text', content:{text}}（url = 开放平台复制的 webhook 地址）
  //   dingtalk POST {msgtype:'text', text:{content}}（url = oapi.dingtalk.com 机器人 webhook）
  //   telegram POST {chat_id, text}——url 形如 https://api.telegram.org/bot<token>/sendMessage，
  //            chat_id 拼在 url 查询参数里（?chat_id=123456），这里解析出来挪进 body。
  if (ch.type === 'feishu') {
    return {
      url: ch.url,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text: `【${t}】${b}` } }) },
    };
  }
  if (ch.type === 'dingtalk') {
    return {
      url: ch.url,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: `【${t}】${b}` } }) },
    };
  }
  if (ch.type === 'telegram') {
    const u = new URL(ch.url);
    const chatId = u.searchParams.get('chat_id') || '';
    if (!chatId) throw new Error('telegram 通道的 url 里缺 chat_id 查询参数（如 ?chat_id=123456）');
    u.searchParams.delete('chat_id');
    return {
      url: u.toString(),
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: `【${t}】${b}` }) },
    };
  }
  return null;
}

/**
 * 向一个通道投递（不抛错；10 秒超时防挂住事件循环）。
 * 返回 Promise<结果>，结果形如 { type, ok, status, error }。
 *
 * 为什么返回结果而不只是 fire-and-forget：控制台的「测试通知」需要告诉用户
 * 到底成没成。原先只统计"发起了几个"，于是投递到不可达地址时前端照样显示
 * 「已向 1 个通道投递」——用户等不到手机推送，只当通道配错了或消息没触发
 * （2026-10-04 手操实测：notexist.invalid 明确 Failed to parse URL，前端仍报成功）。
 * 日常通知（notifyChannels）依旧不 await 它，行为不变。
 */
export function deliver(ch, title, text) {
  const req = buildChannelRequest(ch, title, text);
  if (!req) return Promise.resolve({ type: ch.type, ok: false, error: '通道类型无法构造请求' });
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 10_000);
  return fetch(req.url, { ...req.init, signal: ac.signal })
    .then((r) => {
      if (r.ok) {
        log(`通知已投递：${ch.type}`);
        return { type: ch.type, ok: true, status: r.status };
      }
      warn(`通知通道 ${ch.type} 返回 ${r.status}`);
      return { type: ch.type, ok: false, status: r.status, error: `上游返回 HTTP ${r.status}` };
    })
    .catch((e) => {
      const msg = String(e?.message || e);
      warn(`通知通道 ${ch.type} 投递失败：`, msg);
      // 给用户看的是可行动的原因，不是 "fetch failed"
      const friendly = /Failed to parse URL|Invalid URL/i.test(msg)
        ? '地址格式不对（不是有效的 http/https URL？）'
        : /abort/i.test(msg) ? '连接超时（10 秒无响应）'
          : /ENOTFOUND|getaddrinfo/i.test(msg) ? '域名解析失败（地址打错了？）'
            : /ECONNREFUSED/i.test(msg) ? '连接被拒绝（端口/服务没起？）'
              : /certificate|SSL|TLS/i.test(msg) ? 'HTTPS 证书校验失败'
                : msg;
      return { type: ch.type, ok: false, error: friendly };
    })
    .finally(() => clearTimeout(to));
}

/**
 * 把一条通知分发到所有已启用的外部通道。每个通道按 `ch-<type>-<key>` 独立节流，
 * 所以一个通道连发失败不会把别的通道顺带节流掉。返回投递了几个（供测试断言）。
 */
export function notifyChannels(cfg, title, text, { key = null, force = false } = {}) {
  const channels = enabledChannels(cfg);
  if (!channels.length) return 0;
  let n = 0;
  for (const ch of channels) {
    if (!force && key && !shouldNotify(`ch-${ch.type}-${key}`)) continue;
    try {
      deliver(ch, title, text);
      n++;
    } catch (e) {
      warn(`通知通道 ${ch.type} 异常：`, e.message);
    }
  }
  return n;
}

/** 控制台「测试通知」：忽略节流，往所有通道真发一条，并等每个通道的真实结果。 */
export async function testChannels(cfg, title = 'WorkBuddy 积分桥测试 🔔', text = '通知通道已连通，收到即配置成功。') {
  const channels = enabledChannels(cfg);
  const results = await Promise.all(channels.map((ch) => deliver(ch, title, text)));
  return { total: results.length, ok: results.filter((r) => r.ok).length, results };
}

/** 测试隔离：清空节流表。 */
export function resetNotifyThrottle() {
  lastFired.clear();
}
