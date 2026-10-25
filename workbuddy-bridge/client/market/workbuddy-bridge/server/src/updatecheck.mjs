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
// 与 wb-publish.cjs 的发布目标保持一致。
// T65 源顺序（2026-10-05 调整）：GitHub raw 在本机网络常不可直连（github.com HTTPS
// 被墙）；jsDelivr 各节点刷新不同步，发布后经常误报旧版本（0.3.14 时实测：curl 与
// node fetch 同一时刻拿到不同版本）。GitHub API contents 端点（发布脚本一直在用）
// 走 api.github.com，无 CDN 缓存、本机可达，提到第一位；raw 兜底、jsDelivr 垫底。
const RAW_URLS = [
  { url: 'https://api.github.com/repos/zhougonjin-ux/workbuddy-bridge-market/contents/marketplace.json', headers: { accept: 'application/vnd.github.raw' } },
  { url: 'https://raw.githubusercontent.com/zhougonjin-ux/workbuddy-bridge-market/main/marketplace.json', headers: {} },
  { url: 'https://cdn.jsdelivr.net/gh/zhougonjin-ux/workbuddy-bridge-market@main/marketplace.json', headers: {} },
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
  for (const src of RAW_URLS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
    try {
      // 市场清单同时含顶层 version 与插件条目 version（更新判定看后者），两者都报
      const res = await fetch(src.url, { signal: ac.signal, headers: src.headers });
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
    // checkedAt 用缓存里存的真实时间（cache.at 可能是失败缓存回拨过的，展示会误导）
    return { checkedAt: cache.checkedAt || new Date(cache.at).toISOString(), local, latest: cache.latest, updateAvailable: cache.updateAvailable, note: cache.note || null };
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
    // 网络/仓库不可达（GitHub 类域名被墙很常见）：失败结果缓存 10 分钟——
    // 不缓存的话三源串行 × 8s 超时会让每次「检查更新」的管理请求阻塞约 24s
    result = { checkedAt: new Date().toISOString(), local, latest: null, updateAvailable: false, note: String(e.message || e).slice(0, 120) };
    cache = { at: Date.now() - (CHECK_INTERVAL_MS - 10 * 60_000), ...result };
  }
  return result;
}
