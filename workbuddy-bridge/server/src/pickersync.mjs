// 模型池自动同步（workbuddy-bridge）：把 WorkBuddy 供应商与模型清单写进
// ZCode 的个人供应商配置（provider_config.json），让「管理模型/模型选择器」
// 直接出现 WorkBuddy 分组，并随上游清单自动增删。
//
// 两处复用：
//   - 服务端定时循环（startProviderConfigSync）：上游加/删模型或倍率变动时自动跟上
//   - SessionStart 钩子（hooks/sync-provider.mjs）：会话启动时的快路径触发
//
// 本模块刻意保持零依赖（仅 node 内置），钩子引入时不拖起服务端的其它模块。
//
// schema 要点（从 ZCode 运行内核逆向 + 桌面日志实证，详见项目记忆）：
//   - 文件每 60 秒被 ZCode 轮询，解析成功即热加载进模型目录，无需重启
//   - 解析失败会静默降级为空配置（只在 v2/logs 里记「加载失败」），所以
//     写入形状必须严格正确；改动本文件的合并逻辑后务必实测一轮轮询
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROVIDER_ID = 'workbuddy-bridge';
export const PROVIDER_NAME = 'WorkBuddy';

/** ZCode 个人供应商配置的目标路径（ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 可覆盖，便于测试）。 */
export function providerConfigTarget() {
  return process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
    || path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
}

/** 拉取代理当前暴露的模型（带倍率后缀的 ID、上下文/输出上限、图像支持）。 */
export async function fetchPickerModels(port, timeoutMs = 3000) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`/v1/models HTTP ${res.status}`);
  const body = await res.json();
  return (Array.isArray(body?.data) ? body.data : [])
    .filter((m) => typeof m?.id === 'string' && m.id)
    .map((m) => ({
      id: m.id,
      contextWindow: Number.isFinite(m.context_window) ? m.context_window : null,
      maxOutputTokens: Number.isFinite(m.max_output_tokens) ? m.max_output_tokens : null,
      supportsImages: m.supports_images === true,
    }));
}

/**
 * 按手动模型规则的严格 schema 构建单条规则。
 *
 * 字段全部必填、多余键整份文件校验失败（strict schema）：
 *   - properties 禁止 supportsToolCall / requiresMfjsToolSchema / outputFormat
 *     （工具支持由内置兜底规则的 supportsToolCall:true 在解析时保留）
 *   - optionSpecs 必填：reasoningLevel{values,map} 与 maxOutputTokens{max}
 *     map 是必填的可编译选项映射串，"{}" 表示恒等映射
 */
export function buildModelRule(m) {
  return {
    providerId: PROVIDER_ID,
    modelId: m.id,
    config: {
      properties: {
        contextWindow: Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : 200000,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
        inputFormat: {
          supportsImage: m.supportsImages === true,
          supportsVideo: false,
          supportsPdf: false,
        },
      },
      optionSpecs: {
        reasoningLevel: { values: ['disabled', 'enabled'], map: '{}' },
        maxOutputTokens: { max: Number.isFinite(m.maxOutputTokens) && m.maxOutputTokens > 0 ? m.maxOutputTokens : 32000 },
      },
    },
  };
}

/**
 * 把 WorkBuddy 供应商条目合并进 provider_config.json（只动自己的条目）。
 * 返回 'written' | 'unchanged'；结构不合法的现存文件不动（那是应用恢复逻辑的事）。
 */
export function syncProviderConfigFile({ apiKey, baseUrl, models, target }) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'skipped';
    if (!doc.config || typeof doc.config !== 'object' || Array.isArray(doc.config)) doc.config = {};
  } catch {
    doc = { schemaVersion: 1, config: {} };
  }
  const cfgRoot = doc.config;
  doc.schemaVersion = 1;

  // --- providerRules：删掉自己旧的，追加新条目 ---
  const pcr = (cfgRoot.providerConfigRules && typeof cfgRoot.providerConfigRules === 'object' && !Array.isArray(cfgRoot.providerConfigRules))
    ? cfgRoot.providerConfigRules
    : {};
  const providerRules = Array.isArray(pcr.providerRules) ? pcr.providerRules.filter((r) => r && typeof r === 'object') : [];
  const previous = providerRules.find((r) => r?.providerId === PROVIDER_ID);
  const keptRules = providerRules.filter((r) => r?.providerId !== PROVIDER_ID);

  const modelIds = models.map((m) => m.id);
  const personalModelIds = modelIds.length > 0
    ? modelIds
    : (Array.isArray(previous?.config?.personalModelIds) ? previous.config.personalModelIds : []);
  if (personalModelIds.length === 0 && !previous) return 'skipped'; // 首次注册但一个模型都拿不到，等下次

  keptRules.push({
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    enabled: true,
    config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey },
      api: { type: 'openai-chat-completions', baseUrl },
      personalModelIds,
      modelOrder: personalModelIds,
    },
  });
  pcr.providerRules = keptRules;
  cfgRoot.providerConfigRules = pcr;

  // --- modelConfigRules：只替换自己供应商的规则 ---
  const mcr = (cfgRoot.modelConfigRules && typeof cfgRoot.modelConfigRules === 'object' && !Array.isArray(cfgRoot.modelConfigRules))
    ? cfgRoot.modelConfigRules
    : {};
  const manualRules = Array.isArray(mcr.manualProviderModelRules)
    ? mcr.manualProviderModelRules.filter((r) => r && typeof r === 'object' && r.providerId !== PROVIDER_ID)
    : [];
  for (const m of models) manualRules.push(buildModelRule(m));
  mcr.manualProviderModelRules = manualRules;
  // providerModelRules 是必填键（且不能与 manual 规则同 provider/model 重复）
  if (!Array.isArray(mcr.providerModelRules)) mcr.providerModelRules = [];
  mcr.providerModelRules = mcr.providerModelRules.filter((r) => r?.providerId !== PROVIDER_ID);
  cfgRoot.modelConfigRules = mcr;

  // --- providerOrder：不存在就放最前，已存在保持用户排的顺序 ---
  if (!Array.isArray(cfgRoot.providerOrder)) cfgRoot.providerOrder = [];
  if (!cfgRoot.providerOrder.includes(PROVIDER_ID)) cfgRoot.providerOrder.unshift(PROVIDER_ID);

  const next = JSON.stringify({ schemaVersion: 1, config: cfgRoot }, null, 2);
  let current = null;
  try { current = fs.readFileSync(target, 'utf8'); } catch { /* 不存在 */ }
  if (current === next) return 'unchanged';

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.provider_config.${process.pid}.tmp`);
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, target);
  return 'written';
}

/**
 * 完整同步流程：拉模型清单（代理不在时退回 fallbackModels，
 * 再不行保留已注册的旧清单）→ 合并写入。异常向上抛由调用方兜住。
 */
export async function runProviderConfigSync({ port, apiKey, fallbackModels = [] }) {
  let models = [];
  try {
    models = await fetchPickerModels(port);
  } catch {
    /* 代理没起来，走兜底 */
  }
  if (models.length === 0 && fallbackModels.length > 0) {
    models = fallbackModels.map((id) => ({ id, contextWindow: null, maxOutputTokens: null, supportsImages: false }));
  }
  const target = providerConfigTarget();
  const result = syncProviderConfigFile({ apiKey, baseUrl: `http://127.0.0.1:${port}/v1`, models, target });
  return { result, models: models.length, target };
}

// ---- 服务端定时循环 ----

const timers = { sync: null };
let syncing = false;

/** 启动模型池自动同步循环（启动后 20 秒先跑一次，之后按 providerSyncMinutes 间隔）。 */
export function startProviderConfigSync(cfg, onError) {
  if (timers.sync) return;
  const tick = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const r = await runProviderConfigSync({
        port: cfg.port,
        apiKey: cfg.apiKey,
        fallbackModels: (cfg.models || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean),
      });
      if (r.result === 'written') {
        const { log } = await import('./log.mjs');
        log(`模型池已同步进 ZCode 选择器（${r.models} 个模型）`);
      }
    } catch (e) {
      (onError || (() => {}))(e);
    } finally {
      syncing = false;
    }
  };
  const boot = setTimeout(tick, 20_000);
  boot.unref?.();
  const ms = Math.max(2, Number(cfg.providerSyncMinutes) || 5) * 60_000;
  timers.sync = setInterval(tick, ms);
  timers.sync.unref?.();
}

export function stopProviderConfigSync() {
  if (timers.sync) clearInterval(timers.sync);
  timers.sync = null;
}
