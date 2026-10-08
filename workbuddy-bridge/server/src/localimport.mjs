// 本机账号自动导入（workbuddy-bridge 新增）：
// 从本机已登录的 WorkBuddy / CodeBuddy 客户端配置里提取登录态，验证后并入账号池，
// 免去扫码登录。
//
// 数据来源（实测本机 Win11 + WorkBuddy 桌面客户端 2026-10）：
//   ~/.codebuddy/settings.json 等 settings*.json
//     → env.CODEBUDDY_AUTH_TOKEN：RS256 JWT（客户端续期时由客户端自己更新）
//     iss 形如 https://www.codebuddy.cn/auth/realms/copilot —— 与代理的站点一一对应
//     JWT 声明里带 sub(uid)/nickname/exp；企业域（若有）由 hydrateFromToken 补齐
//   ~/.workbuddy 桌面客户端本体：凭证在加密 keyblob / Chromium 存储里，无明文
//     accessToken 可提取，后续版本若发现新落盘位置再扩展本模块。
//
// 注意：客户端不落盘 refreshToken，所以导入的账号没有自动续期能力——
// token 到期后重新运行导入即可拿到客户端续期后的新 token。服务每次启动会
// 自动静默重扫一次。若同 uid 账号在池里已有 refreshToken（扫码登录的），
// 不覆盖——能自动续期的凭证更优。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hydrateFromToken, jwtClaims } from './auth.mjs';
import { loadPool, savePool, updateCreditDetail } from './pool.mjs';
import { billingHeaders } from './headers.mjs';
import { normalizeCreditDetail } from './expiry.mjs';
import { siteKeys } from './config.mjs';
import { log, warn } from './log.mjs';

/** iss / 域名 → 代理站点键。 */
function siteByIss(iss) {
  const s = String(iss || '');
  if (/codebuddy\.cn/i.test(s)) return 'cn-cli';
  if (/codebuddy\.ai/i.test(s)) return 'intl-cli';
  if (/workbuddy\.ai/i.test(s)) return 'intl-work';
  return null;
}

/** 收集候选配置文件（.codebuddy 下的 settings*.json，兼容未来更多文件名）。 */
function candidateFiles() {
  // USERPROFILE 只在 Windows 有：macOS/Linux 跑代理时回落 homedir，别静默扫出 0 个文件
  const dir = path.join(process.env.USERPROFILE || os.homedir(), '.codebuddy');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^settings.*\.json$/i.test(n))
    .map((n) => path.join(dir, n));
}

/**
 * 检测 WorkBuddy 桌面客户端的登录态文件（0.3.41）。
 *
 * 桌面客户端把登录态存在 ~/AppData/Local/CodeBuddyExtension/Data/Public/auth/
 * workbuddy-desktop.info：uid 是明文，accessToken/refreshToken 是 $wbEncrypted
 * AES-GCM 密文，密钥只在桌面主进程内存里（自家 CLI 读同一个文件也报 missing-key，
 * 见同目录 security/at-rest-failures-v1.json 的失败记录）——静态读取解不了密，
 * 所以检测到也只能给「已登录但需扫码换绑」的明确指引，不能直接入池。
 * 返回 { uid, file, mtimeMs, encrypted } 或 null（无客户端/未登录）。
 */
export function detectDesktopLogin() {
  const home = process.env.USERPROFILE || os.homedir();
  const dirs = {
    win32: ['AppData', 'Local', 'CodeBuddyExtension'],
    darwin: ['Library', 'Application Support', 'CodeBuddyExtension'],
  };
  const rel = dirs[process.platform] || ['.local', 'share', 'CodeBuddyExtension'];
  const base = path.join(home, ...rel, 'Data', 'Public', 'auth');
  let files = [];
  try { files = fs.readdirSync(base).filter((n) => n.endsWith('.info')); } catch { return null; }
  let best = null;
  for (const n of files) {
    const f = path.join(base, n);
    try {
      const st = fs.statSync(f);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs };
    } catch { /* 跳过读不到的 */ }
  }
  if (!best) return null;
  try {
    const j = JSON.parse(fs.readFileSync(best.file, 'utf8'));
    const uid = j?.account?.uid || null;
    if (!uid) return null;
    return { uid, file: best.file, mtimeMs: best.mtimeMs, encrypted: Boolean(j?.auth?.accessToken) };
  } catch {
    return null;
  }
}

/** 深度收集 JSON 里所有「三段式 JWT」字符串。 */
function collectJwtStrings(value, out) {
  if (typeof value === 'string') {
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && value.length > 100) out.push(value);
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectJwtStrings(v, out); return; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) collectJwtStrings(v, out); }
}

/** 用上游计费接口验证 token 并顺带拿积分明细（与服务端同款请求体）。 */
async function validateWithBilling(cfg, site, auth) {
  const siteCfg = cfg.sites[site];
  const now = new Date();
  const end = new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  };
  const res = await fetch(siteCfg.billingBase + '/v2/billing/meter/get-user-resource', {
    method: 'POST',
    headers: billingHeaders(siteCfg, auth),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} 非 JSON 响应`); }
  if (res.status === 401 || res.status === 403) throw new Error('token 已失效（上游 401/403）');
  if (json.code !== 0) throw new Error(`上游 code=${json.code} ${String(json.msg || '').slice(0, 100)}`);
  const detail = normalizeCreditDetail(json.data?.Response?.Data?.Accounts || []);
  return { remain: detail.reduce((s, b) => s + b.remain, 0), detail };
}

/**
 * 扫描并导入本机客户端登录态。
 * @param {object} cfg 代理配置
 * @param {{silent?: boolean}} opts silent=true 时不打启动横幅（每次服务启动自动调用）
 * @returns {{scannedFiles: number, found: Array<{uid,nickname,site,exp,status,reason?}>}}
 */
export async function importLocalAccounts(cfg, { silent = false } = {}) {
  const files = candidateFiles();
  const found = [];
  const byUid = new Map(); // uid → { token, claims, site, exp }

  for (const file of files) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const strings = [];
    collectJwtStrings(json, strings);
    for (const token of strings) {
      const claims = jwtClaims(token);
      const site = siteByIss(claims?.iss);
      if (!site || !claims.sub) continue;
      const expMs = claims.exp ? claims.exp * 1000 : 0;
      if (expMs && expMs <= Date.now()) {
        found.push({ uid: String(claims.sub).slice(0, 8) + '…', nickname: claims.nickname || '', site, exp: expMs, status: 'skipped', reason: 'token 已过期，等客户端续期后再导入' });
        continue;
      }
      if (!cfg.sites[site] || cfg.sites[site].enabled === false || !siteKeys(cfg).includes(site)) {
        found.push({ uid: String(claims.sub).slice(0, 8) + '…', nickname: claims.nickname || '', site, exp: expMs, status: 'skipped', reason: '站点被禁用' });
        continue;
      }
      const prev = byUid.get(claims.sub);
      // 同一账号多份文件 → 取 exp 最新的一份
      if (!prev || expMs > prev.expMs) byUid.set(claims.sub, { token, claims, site, expMs, file });
    }
  }

  let imported = 0, updated = 0, skipped = 0;
  for (const [uid, item] of byUid) {
    const { token, claims, site, expMs } = item;
    const auth = { accessToken: token, refreshToken: null, expiresAt: expMs || undefined, uid: String(uid) };
    hydrateFromToken(site, auth);

    let credit = null;
    let verifyNote = '';
    try {
      credit = await validateWithBilling(cfg, site, auth);
    } catch (e) {
      // 网络抖动不拦导入（池里 token 临期会自动刷新，到期自动切换），401 类才拒绝
      if (/401|403|失效/.test(e.message)) {
        skipped++;
        found.push({ uid: String(uid).slice(0, 8) + '…', nickname: claims.nickname || '', site, exp: expMs, status: 'skipped', reason: e.message });
        continue;
      }
      verifyNote = `（上游验证暂不可达：${String(e.message).slice(0, 60)}，已先入池）`;
    }

    const pool = loadPool(site);
    const exist = pool.accounts.find((a) => a.uid && String(a.uid) === uid);
    if (exist && exist.refreshToken) {
      found.push({ uid: String(uid).slice(0, 8) + '…', nickname: claims.nickname || exist.label, site, exp: expMs, status: 'skipped', reason: '池里已有同账号且支持自动续期（扫码登录），不覆盖' });
      skipped++;
      continue;
    }
    if (exist) {
      exist.accessToken = token;
      exist.expiresAt = expMs || exist.expiresAt;
      exist.lastError = null;
      exist.importedAt = new Date().toISOString();
      if (!exist.label) exist.label = claims.nickname || exist.label;
      savePool(site, pool);
      updated++;
      found.push({ uid: String(uid).slice(0, 8) + '…', nickname: exist.label || claims.nickname || '', site, exp: expMs, status: 'updated', reason: '已用客户端最新的 token 更新' + verifyNote });
    } else {
      const acc = {
        id: 'acc_' + crypto.randomBytes(4).toString('hex'),
        label: (claims.nickname || `本机账号${pool.accounts.length + 1}`) + '（本机导入）',
        accessToken: token,
        refreshToken: null,
        expiresAt: expMs || null,
        uid: String(uid),
        nickname: claims.nickname || null,
        domain: auth.domain || null,
        enterpriseId: auth.enterpriseId || null,
        enabled: true,
        exhaustedAt: null,
        cooldownUntil: null,
        failCount: 0,
        lastUsedAt: null,
        lastError: null,
        addedAt: new Date().toISOString(),
        importedAt: new Date().toISOString(),
        source: 'local-import',
      };
      pool.accounts.push(acc);
      pool.nextLabel = Math.max(pool.nextLabel || 1, pool.accounts.length + 1);
      savePool(site, pool);
      imported++;
      found.push({ uid: String(uid).slice(0, 8) + '…', nickname: acc.label, site, exp: expMs, status: 'imported', reason: '导入成功' + verifyNote });
    }
    if (credit) updateCreditDetail(site, (loadPool(site).accounts.find((a) => a.uid && String(a.uid) === uid) || {}).id, credit);
  }

  // WorkBuddy 桌面客户端登录态检测（0.3.41）：token 加密解不了，但 uid 明文可读。
  // 检测到就在结果里如实告知「检测到登录但 token 加密」，别让弹窗笼统地说「没有发现」——
  // 用户明明登录着客户端，看到那句话只会以为是桥接坏了。
  const desktop = detectDesktopLogin();
  if (desktop) {
    const short = String(desktop.uid).slice(0, 8) + '…';
    const inPool = siteKeys(cfg).some((site) => loadPool(site).accounts.find((a) => a.uid && String(a.uid) === desktop.uid));
    found.push({
      uid: short,
      nickname: 'WorkBuddy 桌面客户端',
      site: 'cn-cli',
      exp: null,
      status: inPool ? 'skipped' : 'skipped',
      reason: inPool
        ? '桌面客户端已登录（该账号已在账号池中，无需导入）'
        : '检测到桌面客户端已登录，但 token 是加密存储（密钥只在客户端内存），无法静态导入——请在控制台「＋ 添加账号」扫码登录同一账号',
    });
  }

  if (!silent) {
    if (!files.length && !desktop) log('本机导入：未找到 ~/.codebuddy 客户端配置（没装客户端不影响其他登录方式）');
    else if (!found.length) log(`本机导入：扫描了 ${files.length} 个配置文件，没有发现可导入的登录态`);
    else log(`本机导入：新增 ${imported} / 更新 ${updated} / 跳过 ${skipped}`);
  }
  return { scannedFiles: files.length, imported, updated, skipped, found, desktop };
}
