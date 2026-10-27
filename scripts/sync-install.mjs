#!/usr/bin/env node
// 把本仓库的插件同步进「本机已安装的 ZCode 插件缓存」。
//
// 用途：开发时改了源码，不必走「市场刷新 → 关闭重开插件页 → 点更新」那套 UI 流程，
// 直接跑 `npm run sync:install` 即可让下一次 ZCode 会话用上新代码。
//
// 只处理 workbuddy-bridge@dev-workbuddy-bridge-local：
//   - 从 installed_plugins.json 找到真实 installPath（目录名可能是首次安装的旧版本）
//   - 同步插件代码（排除 client/test/node_modules，避免动桌面端工程与测试）
//   - 更新 installed_plugins.json 的 version/updatedAt（否则详情页一直显示旧版本）
//   - 顺带刷新市场缓存里的同一份源码与 marketplace.json（防止 UI 重装又装回旧版）
//
// 数据目录（~/.zcode/workbuddy-bridge）不在同步范围内：账号、配置、用量都不受影响。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'workbuddy-bridge');
const HOME = os.homedir();
const MARKET_ID = 'dev-workbuddy-bridge-local';
const PLUGIN_NAME = 'workbuddy-bridge';
const PLUGINS_ROOT = path.join(HOME, '.zcode', 'cli', 'plugins');
const INSTALLED_JSON = path.join(PLUGINS_ROOT, 'installed_plugins.json');
const MARKET_ROOT = path.join(PLUGINS_ROOT, 'marketplaces', MARKET_ID);
const REPO_MARKET = path.join(ROOT, 'marketplace.json');

if (!fs.existsSync(SRC)) {
  console.error('✗ 找不到 workbuddy-bridge 源码目录');
  process.exit(1);
}
if (!fs.existsSync(INSTALLED_JSON)) {
  console.error(`✗ 没有找到 ZCode 插件清单：${INSTALLED_JSON}`);
  console.error('  请先在 ZCode 插件市场里安装 workbuddy-bridge，再运行本脚本。');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(SRC, 'server', 'package.json'), 'utf8')).version;
const installed = JSON.parse(fs.readFileSync(INSTALLED_JSON, 'utf8'));
const record = (installed.plugins || []).find((p) => p.name === PLUGIN_NAME && p.marketplace === MARKET_ID);
if (!record) {
  console.error(`✗ 已安装清单里没有 ${PLUGIN_NAME}@${MARKET_ID}`);
  process.exit(1);
}

// client 是桌面客户端工程（不参与插件运行）；test/node_modules/bin/.git 不进安装包
const SKIP = new Set(['client', 'node_modules', 'bin', 'test', '.git', '.DS_Store']);

function walk(src, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) { out.push({ rel: r, dir: true }); walk(src, r, out); }
    else if (e.isFile()) out.push({ rel: r, dir: false });
  }
  return out;
}

function syncTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const wanted = new Set();
  let files = 0;
  for (const item of walk(src)) {
    const from = path.join(src, item.rel);
    const to = path.join(dst, item.rel);
    if (item.dir) { fs.mkdirSync(to, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    wanted.add(item.rel);
    files += 1;
  }
  // 删除目标里源已不存在的旧文件（避免旧模块残留被误加载）
  let removed = 0;
  (function scan(dir, rel = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full, r);
      else if (e.isFile() && !wanted.has(r)) { fs.rmSync(full, { force: true }); removed += 1; }
    }
  })(dst);
  return { files, removed };
}

const installDir = record.installPath;
const marketPluginDir = path.join(MARKET_ROOT, PLUGIN_NAME);

const main = syncTree(SRC, installDir);
const market = fs.existsSync(marketPluginDir) ? syncTree(SRC, marketPluginDir) : null;

if (fs.existsSync(REPO_MARKET) && fs.existsSync(MARKET_ROOT)) {
  const marketDoc = JSON.parse(fs.readFileSync(REPO_MARKET, 'utf8'));
  fs.writeFileSync(path.join(MARKET_ROOT, 'marketplace.json'), JSON.stringify(marketDoc, null, 2) + '\n', 'utf8');
}

record.version = version;
record.updatedAt = new Date().toISOString();
fs.writeFileSync(INSTALLED_JSON, JSON.stringify(installed, null, 2) + '\n', 'utf8');

console.log(`✓ 已同步到 ZCode 安装缓存（v${version}）`);
console.log(`  安装目录：${installDir}（${main.files} 个文件，清理 ${main.removed} 个旧文件）`);
if (market) console.log(`  市场缓存：${marketPluginDir}（${market.files} 个文件，清理 ${market.removed} 个旧文件）`);
console.log('  下一步：重开 ZCode 会话（或重启 ZCode）让 MCP/命令加载新代码。');