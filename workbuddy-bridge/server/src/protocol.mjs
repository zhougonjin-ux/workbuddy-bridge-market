// 协议漂移自检（T39）：上游 WorkBuddy 随时可能改版——换字段名、挪路径、改响应包裹层。
// 本插件的所有解析逻辑都写死了对响应结构的假设（json.code === 0、json.data.models、
// json.data.Response.Data.Accounts…）。上游一改，症状是「目录空了 / 积分全是 0 /
// 对话报解析失败」这类难以定位的怪问题。
//
// 这里把那些**假设显式写成签名**，用只读的真实响应逐条比对，改版时提前告警：
//   - 探针端点用的都是只读接口（模型目录、额度查询），不消耗积分、不发对话；
//   - 每个签名 = { 路径说明, 取值函数, 断言 }，缺字段即判 drifted；
//   - 结果落 protocol-check.json（6 小时缓存，避免每次开控制台都打上游）。
//
// 「不依赖 .ref/ 参考仓库」是刻意的：参考仓库是某一天的快照，只能人工比对；
// 真正的漂移检测必须对着**当前**上游响应做，而且要在用户察觉之前。
import path from 'node:path';
import { paths, siteKeys } from './config.mjs';
import { isLoggedIn } from './auth.mjs';
import { supportsCreditQuery, queryCredit, fetchModels } from './upstream.mjs';
import { log, warn } from './log.mjs';
import { writeJsonFileAtomic, readJsonFileWithBackup } from './util.mjs';
import { recordEvent } from './events.mjs';

const CACHE_TTL_MS = 6 * 3600_000; // 与 T22 自更新检查同一档：够新，又不会每次开面板就打上游
const file = () => path.join(paths.root, 'protocol-check.json');

/**
 * 签名定义（纯数据，便于单测直接构造假响应跑判定）。
 *
 * 每条签名：
 *   probe  —— 'models' | 'credit'，决定用哪个只读端点取样
 *   path   —— 端点路径，写进报告让人一眼知道哪里变了
 *   sample —— 从假响应里取出被检查的值（返回 undefined 表示该路径已消失）
 *   check  —— 对取到的值做断言；返回 { ok, detail }
 *
 * 只收「结构性」假设，不收会自然波动的值（模型个数、余额多少）。
 */
export const PROTOCOL_SIGNATURES = [
  {
    key: 'envelope.code',
    probe: 'models',
    path: '/console/enterprises/personal/models',
    what: '统一响应包裹层 code（0 = 成功）',
    sample: (j) => (j && typeof j === 'object' ? j.code : undefined),
    check: (v) => (v === 0
      ? { ok: true, detail: 'code=0（包裹层正常）' }
      : { ok: false, detail: `期望 code=0，实际 ${JSON.stringify(v)}——上游可能改了响应包裹层` }),
  },
  {
    key: 'catalog.data.models',
    probe: 'models',
    path: '/console/enterprises/personal/models',
    what: '模型清单数组 data.models',
    sample: (j) => j?.data?.models,
    check: (v) => (Array.isArray(v)
      ? { ok: true, detail: `data.models 仍是数组（${v.length} 个模型）` }
      : { ok: false, detail: `data.models 不再是数组（实际 ${describeType(v)}）——模型目录会解析成空` }),
  },
  {
    key: 'catalog.model.credits',
    probe: 'models',
    path: '/console/enterprises/personal/models',
    what: '模型倍率字段 credits（如 "x0.06 credits"；x0.00 = 免费）',
    sample: (j) => (Array.isArray(j?.data?.models) ? j.data.models[0]?.credits : undefined),
    check: (v) => (v === undefined || v === null || typeof v === 'string'
      // 允许为 null（上游不给倍率时是正常的，只有整个字段消失才可疑）
      ? { ok: true, detail: v === undefined || v === null ? 'credits 为空（该模型未标倍率）' : `credits 形如 ${JSON.stringify(String(v).slice(0, 24))}` }
      : { ok: false, detail: `credits 类型变成 ${describeType(v)}，倍率解析会失效` }),
  },
  {
    key: 'billing.envelope.code',
    probe: 'credit',
    path: '/v2/billing/meter/get-user-resource',
    what: '额度接口的 code（0 = 成功）',
    sample: (j) => (j && typeof j === 'object' ? j.code : undefined),
    check: (v) => (v === 0
      ? { ok: true, detail: 'code=0（额度包裹层正常）' }
      : { ok: false, detail: `期望 code=0，实际 ${JSON.stringify(v)}` }),
  },
  {
    key: 'billing.data.Response.Data.Accounts',
    probe: 'credit',
    path: '/v2/billing/meter/get-user-resource',
    what: '资源包数组 data.Response.Data.Accounts（积分到期优先调度的数据源）',
    sample: (j) => j?.data?.Response?.Data?.Accounts,
    check: (v) => (Array.isArray(v)
      ? { ok: true, detail: `Accounts 仍是数组（${v.length} 个资源包）` }
      : { ok: false, detail: `Accounts 不再是数组（实际 ${describeType(v)}）——所有批次会显示为 0，到期优先调度失效` }),
  },
  {
    key: 'billing.account.expiry',
    probe: 'credit',
    path: '/v2/billing/meter/get-user-resource',
    what: '资源包到期时间字段（CycleEndTime / PackageEndTime / ExpiredTime 任一）',
    sample: (j) => {
      const a = j?.data?.Response?.Data?.Accounts;
      const b = Array.isArray(a) ? a[0] : null;
      if (!b) return undefined;
      return b.CycleEndTime ?? b.PackageEndTime ?? b.ExpiredTime ?? b.expireAt ?? null;
    },
    check: (v) => {
      // 到期字段全都没有 = 漂移（批次仍存在但不再有过期时间，整套 expiry-first 失去依据）
      if (v === undefined) return { ok: false, detail: '资源包里找不到任何到期时间字段' };
      if (v === null) return { ok: true, detail: '该资源包无到期时间（不过期，合理）' };
      return { ok: true, detail: `到期时间可读（${JSON.stringify(String(v).slice(0, 24))}）` };
    },
  },
  {
    key: 'v3config.cli.models',
    probe: 'v3config',
    path: '/v3/config',
    what: 'v3/config 的 cli agent 模型清单（与企业端点并行的目录来源，迁移先兆）',
    sample: (j) => {
      const agents = Array.isArray(j?.data?.agents) ? j.data.agents : null;
      if (!agents) return null;
      const cli = agents.find((a) => a?.name === 'cli') || null;
      if (!cli) return null;
      return { models: cli.models, want: j?.__wantModel };
    },
    check: (v) => {
      // sample 返回 null 有两种可能（data.agents 消失 / cli 条目消失），都算漂移
      if (v === null || v === undefined) return { ok: false, detail: 'v3/config 里找不到 data.agents 的 cli 条目——目录结构变了或端点已废弃' };
      if (!Array.isArray(v.models) || !v.models.length) {
        return { ok: false, detail: `cli.models 不再是非空数组（实际 ${describeType(v.models)}）` };
      }
      if (v.want && !v.models.includes(v.want)) {
        return { ok: false, detail: `cli 目录（${v.models.length} 个模型）已不含当前默认模型 ${v.want}——defaultModel 可能失效` };
      }
      return { ok: true, detail: `cli models 仍是数组（${v.models.length} 个）${v.want && v.models.includes(v.want) ? '，含默认模型 ' + v.want : ''}` };
    },
  },
];

function describeType(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 纯判定：拿一组假响应跑全部签名（单测用；也便于以后接历史样本回归）。
 * 返回 { total, ok, drifted, results:[{ key, what, path, ok, detail }] }
 */
export function evaluateSignatures(responses) {
  const results = [];
  for (const sig of PROTOCOL_SIGNATURES) {
    const json = responses?.[sig.probe];
    let out;
    try {
      out = sig.check(sig.sample(json));
    } catch (e) {
      out = { ok: false, detail: `判定时抛错：${e.message}` };
    }
    results.push({ key: sig.key, what: sig.what, path: sig.path, ok: out.ok, detail: out.detail });
  }
  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    drifted: results.filter((r) => !r.ok).length,
    results,
  };
}

// ---------------- 真实探测 ----------------

let state = null;
function loadState() {
  if (state) return state;
  const disk = readJsonFileWithBackup(file());
  state = disk && typeof disk === 'object' ? disk : { sites: {} };
  if (typeof state.sites !== 'object' || !state.sites) state.sites = {};
  return state;
}

function saveState() {
  try {
    writeJsonFileAtomic(file(), state);
  } catch (e) {
    warn('protocol-check.json 写入失败：', e.message);
  }
}

/**
 * 探一个站点的响应样本（只读端点，不消耗积分）。
 * 返回 { ok, responses } 或 { ok:false, error }。
 * 探针本身失败（网络/未登录/无计费接口）不算漂移——那是另一回事，
 * 由 doctor 的登录态检查负责报。
 */
async function probeSite(cfg, site) {
  const responses = {};
  if (!isLoggedIn(site)) return { ok: false, skipped: true, error: '未登录' };
  try {
    // fetchModels 会校验 code/data 结构，所以它「成功」本身就说明目录协议没变；
    // 但我们还要看到原始 JSON，所以这里重新取一次原始响应。
    responses.models = await rawModels(cfg, site);
  } catch (e) {
    return { ok: false, error: `模型目录探测失败：${e.message}` };
  }
  if (supportsCreditQuery(cfg, site)) {
    try {
      responses.credit = await rawCredit(cfg, site);
    } catch (e) {
      // 额度接口挂了不阻塞模型侧签名判定，把 credit 留空由签名判成「取不到样」
      responses.creditError = e.message;
    }
  }
  // T54：v3/config 探针（独立目录家族）。探测失败不算漂移（端点可能只是该站不可用），
  // 留空由签名判成「取不到样」；doctor 的登录态检查负责报网络问题。
  try {
    responses.v3config = await rawV3Config(cfg, site);
  } catch (e) {
    responses.v3configError = e.message;
  }
  return { ok: true, responses };
}

/** 原始模型目录响应（复用 upstream 的请求头与鉴权，但不做结构解析）。 */
async function rawModels(cfg, site) {
  const { fetchModelsRaw } = await import('./upstream.mjs');
  return fetchModelsRaw(cfg, site);
}

/** 原始额度响应。 */
async function rawCredit(cfg, site) {
  const { fetchCreditRaw } = await import('./upstream.mjs');
  return fetchCreditRaw(cfg, site);
}

/** 原始 /v3/config 响应（T54）。 */
async function rawV3Config(cfg, site) {
  const { fetchV3ConfigRaw } = await import('./upstream.mjs');
  return fetchV3ConfigRaw(cfg, site);
}

/**
 * 跑一遍全站协议自检。返回 { at, sites: { site: {...} }, drifted, total }。
 *
 * 6 小时缓存：results 命中缓存直接返回（drift:true 也不重探，除非 force），
 * 免得用户反复开控制台把只读端点打爆。但**已判定漂移时**会记一条事件，
 * 且不重复记（同一 key 当天只记一次）。
 */
export async function runProtocolCheck(cfg, { force = false } = {}) {
  const s = loadState();
  const now = Date.now();
  const out = { at: new Date().toISOString(), cached: false, sites: {}, drifted: 0, total: 0 };

  for (const site of siteKeys(cfg)) {
    const prev = s.sites[site];
    if (!force && prev?.checkedAt && now - new Date(prev.checkedAt).getTime() < CACHE_TTL_MS) {
      out.sites[site] = { ...prev, cached: true };
      out.cached = true;
    } else {
      const r = await probeSite(cfg, site);
      if (!r.ok) {
        out.sites[site] = { checkedAt: new Date().toISOString(), skipped: true, error: r.error, results: [], drifted: 0, total: 0 };
        s.sites[site] = out.sites[site];
      } else {
        const ev = evaluateSignatures(r.responses);
        out.sites[site] = {
          checkedAt: new Date().toISOString(),
          skipped: false,
          ...(r.responses.creditError ? { creditError: r.responses.creditError } : {}),
          ...(r.responses.v3configError ? { v3configError: r.responses.v3configError } : {}),
          results: ev.results,
          drifted: ev.drifted,
          total: ev.total,
        };
        s.sites[site] = out.sites[site];
      }
    }
    const st = out.sites[site];
    out.drifted += st.drifted || 0;
    out.total += st.total || 0;
  }

  saveState();

  // 漂移事件：同一站点当天只记一次，避免每次开面板刷时间线
  const today = nowStr(now);
  for (const site of Object.keys(out.sites)) {
    const st = out.sites[site];
    if (!st.drifted) { s.notified = { ...(s.notified || {}), [site]: null }; continue; }
    if (s.notified?.[site] === today) continue;
    s.notified = { ...(s.notified || {}), [site]: today };
    const bad = st.results.filter((r) => !r.ok).map((r) => `${r.key}：${r.detail}`);
    recordEvent('health', `协议漂移告警（${site}）：${bad.length} 项与预期不符 —— ${bad.join('；')}`);
  }
  saveState();

  if (out.drifted) warn(`协议自检发现 ${out.drifted} 项与预期不符（上游可能改版了）`);
  else log('协议自检通过：上游响应结构与预期一致');
  return out;
}

function nowStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 诊断用的精简视图：每个已登录站点一行「N/M 项正常」，drift 的站点附明细。
 * doctor.mjs 与控制台「协议」卡共用。
 */
export function protocolCheckBrief(cfg) {
  const s = loadState();
  const sites = [];
  for (const site of siteKeys(cfg)) {
    const st = s.sites?.[site];
    if (!st) continue;
    sites.push({
      site,
      checkedAt: st.checkedAt || null,
      skipped: st.skipped === true,
      error: st.error || null,
      drifted: st.drifted || 0,
      total: st.total || 0,
      results: (st.results || []).filter((r) => !r.ok),
    });
  }
  const checked = sites.filter((x) => !x.skipped);
  return {
    at: checked.map((x) => x.checkedAt).filter(Boolean).sort().pop() || null,
    sites,
    drifted: checked.reduce((n, x) => n + x.drifted, 0),
    total: checked.reduce((n, x) => n + x.total, 0),
  };
}

/** 测试隔离：清掉内存态（切数据目录时用）。 */
export function resetProtocolCache() {
  state = null;
}
