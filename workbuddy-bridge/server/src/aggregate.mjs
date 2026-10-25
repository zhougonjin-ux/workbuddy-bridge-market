// 聚合渠道泳道 v1（0.3.58，借鉴 dsh-xdpool 的 aggregate lane）：
// 把「用户自有 API key 的 OpenAI 兼容 provider」接进同一个本地端点。与 WorkBuddy
// 账号池正交：那边是「官方账号 + 积分 + 轮换容错」，这边是「自有 key + 多 key 轮换 +
// 目录自动拉取」，没有账号语义。模型 ID 形如 `agg:<provider>/<model>`，三协议入口
// 统一走同一条转发（内部强制流式向上游要，客户端要 JSON 由入口层聚合——与 WorkBuddy
// 上游同款套路）。
//
// 刻意不做的事（与 dsh 同款原则）：不发明端点——baseUrl + /models、/chat/completions
// 是唯一路径；key 绝不进日志/错误文案（打码后只剩前 6 位）。
import { log, warn } from './log.mjs';

/** 启用中的 provider 列表（name/baseUrl/keys 三要素齐才有效）。 */
export function aggregateProviders(cfg) {
  return (cfg.aggregate?.providers || []).filter((p) => p && p.enabled !== false
    && typeof p.name === 'string' && p.name.trim()
    && typeof p.baseUrl === 'string' && /^https?:\/\//.test(p.baseUrl)
    && Array.isArray(p.apiKeys) && p.apiKeys.some((k) => typeof k === 'string' && k.trim()));
}

const catalogCache = new Map(); // name → { at, models: [裸模型 id] }

/** 拉一个 provider 的模型目录（GET {baseUrl}/models，10 分钟缓存）。失败返回 []。 */
export async function aggregateCatalogFor(cfg, name, { force = false } = {}) {
  const p = aggregateProviders(cfg).find((x) => x.name === name);
  if (!p) return [];
  const hit = catalogCache.get(name);
  if (!force && hit && Date.now() - hit.at < 10 * 60_000) return hit.models;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), 15_000);
    const res = await fetch(p.baseUrl.replace(/\/+$/, '') + '/models', {
      headers: { Authorization: 'Bearer ' + p.apiKeys[0] },
      signal: ac.signal,
    });
    clearTimeout(timer);
    const json = await res.json().catch(() => null);
    const list = Array.isArray(json?.data)
      ? json.data.map((m) => (typeof m?.id === 'string' ? m.id : null)).filter(Boolean)
      : [];
    catalogCache.set(name, { at: Date.now(), models: list });
    return list;
  } catch (e) {
    warn(`[aggregate:${name}] 模型目录拉取失败：`, e.message || String(e));
    return hit ? hit.models : []; // 缓存兜底
  }
}

/** 全部聚合模型（供 /v1/models 与选择器注册）：[{ id: 'agg:name/model', provider, model }]。 */
export async function aggregateModels(cfg, { force = false } = {}) {
  const out = [];
  for (const p of aggregateProviders(cfg)) {
    for (const m of await aggregateCatalogFor(cfg, p.name, { force })) {
      out.push({ id: `agg:${p.name}/${m}`, provider: p.name, model: m });
    }
  }
  return out;
}

export function invalidateAggregateCatalog(name = null) {
  if (name == null) catalogCache.clear();
  else catalogCache.delete(name);
}

/* ---------------- 多 key 轮换 ---------------- */
const keyIdx = new Map(); // name → 上次用的 key 下标

/** provider 的下一个 key（轮换；单 key 恒返回它）。 */
export function nextAggregateKey(provider) {
  const keys = (provider.apiKeys || []).filter((k) => typeof k === 'string' && k.trim());
  if (!keys.length) return null;
  if (keys.length === 1) return keys[0];
  const i = (keyIdx.get(provider.name) ?? -1) + 1;
  keyIdx.set(provider.name, i % keys.length);
  return keys[i % keys.length];
}

function maskKey(k) {
  return typeof k === 'string' && k.length > 6 ? k.slice(0, 6) + '…' : '***';
}

/* ---------------- 转发（up 句柄与 openChat 同契约） ---------------- */

/**
 * 把一次 OpenAI 格式的对话请求转发给聚合 provider。返回 { ok, status, text,
 * accountId, frames, close }——frames 是 async iterable，yield SSE data 行的
 * payload（OpenAI chunk 格式，与 WorkBuddy 上游同构，classifyFrame/aggregateFrames
 * 直接可用）。向上游强制 stream:true（客户端要 JSON 由入口层聚合帧）。
 */
export async function aggregateOpen(cfg, providerName, body, signal) {
  const p = aggregateProviders(cfg).find((x) => x.name === providerName);
  if (!p) {
    return { ok: false, status: 501, text: `聚合渠道 ${providerName} 不存在或未启用（缺 baseUrl/key 或已停用）`, accountId: null };
  }
  const key = nextAggregateKey(p);
  if (!key) return { ok: false, status: 501, text: `聚合渠道 ${p.name} 没有可用 key`, accountId: p.name };
  const label = `${p.name}#${maskKey(key)}`;
  const ac = new AbortController();
  const onAbort = () => ac.abort(new Error('client closed'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let res;
  try {
    res = await fetch(p.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ ...body, stream: true }),
      signal: ac.signal,
    });
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    return { ok: false, status: 504, text: `聚合渠道 ${p.name} 连接失败：${e.message || e}`, transport: true, site: p.name, accountId: label };
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    signal?.removeEventListener('abort', onAbort);
    return { ok: false, status: res.status, text: `聚合渠道 ${p.name} HTTP ${res.status}：${text.slice(0, 200)}`, site: p.name, accountId: label };
  }
  log(`[aggregate:${label}] 已接通（HTTP ${res.status}）`);
  async function* frames() {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload) yield payload;
          }
        }
      }
    } finally {
      try { reader.cancel(); } catch { /* 已结束 */ }
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return {
    ok: true,
    status: res.status,
    text: '',
    site: p.name,
    accountId: label,
    frames: frames(),
    close() {
      try { ac.abort(new Error('aggregate closed')); } catch { /* 已关 */ }
    },
  };
}
