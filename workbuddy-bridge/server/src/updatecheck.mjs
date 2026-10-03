// 插件自更新检查（T22）：对比 GitHub 市场仓库 main 分支上的版本与本地运行版本，
// 有更新时给控制台一个提示条。两点取舍：
//   - 检查是纯读的公开接口（raw.githubusercontent / codeload 同源的 CDN），无需 PAT；
//   - 结果缓存 6 小时且任何失败都静默降级为「检查不了」，绝不影响代理主流程。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { log } from './log.mjs';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
// 与 wb-publish.cjs 的发布目标保持一致。GitHub raw 在本机网络常不可直连
// （github.com HTTPS 被墙），故带一个 jsDelivr CDN 镜像兜底（国内可达，缓存几分钟）。
const RAW_URLS = [
  'https://raw.githubusercontent.com/zhougonjin-ux/workbuddy-bridge-market/main/marketplace.json',
  'https://cdn.jsdelivr.net/gh/zhougonjin-ux/workbuddy-bridge-market@main/marketplace.json',
];

let cache = null; // { at, latest, note }

/** 读本地版本号：优先插件清单（市场更新判定就用它），回落 server/package.json。 */
export function localVersion() {
  for (const p of [
    path.join(ROOT, '..', '.zcode-plugin', 'plugin.json'),
    path.join(ROOT, 'package.json'),
  ]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.version) return String(j.version);
    } catch {
      /* 试下一个来源 */
    }
  }
  return 'unknown';
}

/** 比较两个 x.y.z 版本号；a 更新返回 1，相同 0，b 更新 -1。非法输入按 0 处理。 */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function fetchLatest() {
  let lastErr = null;
  for (const url of RAW_URLS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
    try {
      // 市场清单同时含顶层 version 与插件条目 version（更新判定看后者），两者都报
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = JSON.parse(await res.text());
      const entry = (j.plugins || []).find((p) => p.name === 'workbuddy-bridge') || j.plugins?.[0] || {};
      return { top: j.version || null, plugin: entry.version || null, desc: entry.description || null };
    } catch (e) {
      lastErr = e; // 试下一个源
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('所有更新源都不可达');
}

/**
 * 更新检查结果（带缓存）：
 *   { checkedAt, local, latest, updateAvailable, note }
 * 拉取失败时 updateAvailable=false、latest=null，前端显示「检查不了」而不是报错。
 */
export async function checkForUpdate() {
  const local = localVersion();
  if (cache && Date.now() - cache.at < CHECK_INTERVAL_MS) {
    return { checkedAt: new Date(cache.at).toISOString(), local, latest: cache.latest, updateAvailable: cache.updateAvailable, note: cache.note || null };
  }
  let result;
  try {
    const { top, plugin, desc } = await fetchLatest();
    const latest = plugin || top || null;
    result = {
      checkedAt: new Date().toISOString(),
      local,
      latest,
      updateAvailable: latest ? compareVersions(latest, local) > 0 : false,
      note: desc || null,
    };
    cache = { at: Date.now(), ...result };
    if (result.updateAvailable) log(`发现新版本：v${latest}（当前 v${local}）—— 在 ZCode 插件市场「刷新市场 → 浏览插件」里更新`);
  } catch (e) {
    // 网络/仓库不可达：不缓存失败结果（下次请求再试），静默降级
    result = { checkedAt: new Date().toISOString(), local, latest: null, updateAvailable: false, note: String(e.message || e).slice(0, 120) };
  }
  return result;
}
