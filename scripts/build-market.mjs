#!/usr/bin/env node
// 市场构建 / 校验（workbuddy-bridge-market）。
//
// 唯一版本源：workbuddy-bridge/server/package.json 的 version。
// 本脚本负责把「源码」同步成「可分发物」，避免手工复制造成版本漂移：
//   1. client/market/workbuddy-bridge  ← workbuddy-bridge（离线市场副本）
//   2. client/market/marketplace.json  ← 根 marketplace.json（版本号注入）
//   3. 根 marketplace.json             ← 版本号注入
//   4. 根 README.md                    ← workbuddy-bridge/README.md（单一文档源）
//
// 用法：
//   node scripts/build-market.mjs           写入（发布前执行）
//   node scripts/build-market.mjs --check   只校验，不一致则退出码 1（CI 用）
//
// 历史事故：client/market 副本曾停在 0.3.46 而源码已 0.3.66，
// 安装器里的 version 又硬编码在 0.3.45 —— 用户装到旧版却毫无提示。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT, 'workbuddy-bridge');
const SERVER_PKG = path.join(PLUGIN_DIR, 'server', 'package.json');
const PLUGIN_MANIFEST = path.join(PLUGIN_DIR, '.zcode-plugin', 'plugin.json');
const ROOT_MARKET = path.join(ROOT, 'marketplace.json');
const MARKET_DIR = path.join(PLUGIN_DIR, 'client', 'market');
const MARKET_PLUGIN_DIR = path.join(MARKET_DIR, 'workbuddy-bridge');
const MARKET_MANIFEST = path.join(MARKET_DIR, 'marketplace.json');
const PLUGIN_README = path.join(PLUGIN_DIR, 'README.md');
const ROOT_README = path.join(ROOT, 'README.md');

const CHECK = process.argv.includes('--check');

/** 副本里不应出现的东西：源码仓库的客户端工程、依赖、测试、构建缓存。 */
const SKIP_NAMES = new Set(['client', 'node_modules', 'bin', '.git', '.DS_Store', 'test']);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 与仓库现有风格保持一致：2 空格缩进 + 末尾换行
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
};

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** 递归列出相对路径 → 内容（用于比对期望与实际）。 */
function snapshot(dir, base = dir, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) snapshot(full, base, out);
    else if (entry.isFile()) out.set(rel, fs.readFileSync(full));
  }
  return out;
}

function genManifest(version) {
  if (!fs.existsSync(ROOT_MARKET)) fail('缺少 marketplace.json');
  const market = readJson(ROOT_MARKET);
  market.version = version;
  for (const p of market.plugins || []) {
    if (p.name === 'workbuddy-bridge') {
      p.version = version;
      if (!p.source) p.source = './workbuddy-bridge';
    }
  }
  return market;
}

function main() {
  if (!fs.existsSync(SERVER_PKG)) fail('缺少 workbuddy-bridge/server/package.json');

  const version = readJson(SERVER_PKG).version;
  if (!/^\d+\.\d+\.\d+/.test(String(version || ''))) fail(`server/package.json 版本号不可用：${version}`);

  const issues = [];
  const pluginManifest = readJson(PLUGIN_MANIFEST);
  if (pluginManifest.version !== version) {
    issues.push(`.zcode-plugin/plugin.json 版本 ${pluginManifest.version} ≠ ${version}`);
  }
  const rootMarket = readJson(ROOT_MARKET);
  if (rootMarket.version !== version) issues.push(`marketplace.json 版本 ${rootMarket.version} ≠ ${version}`);
  for (const p of rootMarket.plugins || []) {
    if (p.name === 'workbuddy-bridge' && p.version !== version) {
      issues.push(`marketplace.json 内插件版本 ${p.version} ≠ ${version}`);
    }
  }
  if (issues.length) {
    console.error('✗ 版本号不一致（唯一事实源：server/package.json）：');
    for (const i of issues) console.error(`  · ${i}`);
    console.error('  先统一版本号，再重新运行本脚本。');
    process.exit(1);
  }

  // 期望产物先算出来（含文档），--check 与写入共用同一份口径
  const expectedManifest = genManifest(version);
  const expectedReadme = fs.readFileSync(PLUGIN_README);

  if (CHECK) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-market-'));
    let ok = true;
    try {
      const tmpPlugin = path.join(tmp, 'workbuddy-bridge');
      copyTree(PLUGIN_DIR, tmpPlugin);
      const want = snapshot(tmpPlugin);
      const have = fs.existsSync(MARKET_PLUGIN_DIR) ? snapshot(MARKET_PLUGIN_DIR) : new Map();
      const diffs = [];
      for (const [rel, buf] of want) {
        if (!have.has(rel)) diffs.push(`缺少 ${rel}`);
        else if (!buf.equals(have.get(rel))) diffs.push(`内容不同 ${rel}`);
      }
      for (const rel of have.keys()) if (!want.has(rel)) diffs.push(`多余 ${rel}`);
      if (diffs.length) {
        ok = false;
        console.error(`✗ client/market 副本与源码不一致（${diffs.length} 处）：`);
        for (const d of diffs.slice(0, 20)) console.error(`  · ${d}`);
        if (diffs.length > 20) console.error(`  · …另有 ${diffs.length - 20} 处`);
        console.error('  修复：node scripts/build-market.mjs');
      }

      const checkJson = (file, wantObj, label) => {
        const wantText = JSON.stringify(wantObj, null, 2) + '\n';
        const haveText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (haveText !== wantText) {
          ok = false;
          console.error(`✗ ${label} 与期望不一致（运行 node scripts/build-market.mjs 更新）`);
        }
      };
      checkJson(MARKET_MANIFEST, expectedManifest, 'client/market/marketplace.json');
      checkJson(ROOT_MARKET, expectedManifest, 'marketplace.json');

      if (!fs.existsSync(ROOT_README) || !fs.readFileSync(ROOT_README).equals(expectedReadme)) {
        ok = false;
        console.error('✗ 根 README.md 与 workbuddy-bridge/README.md 不一致（唯一文档源是后者）');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (!ok) process.exit(1);
    console.log(`✓ 市场产物一致（v${version}）`);
    return;
  }

  // 写入：先整体删除再复制，避免旧版本残留文件混进发布包
  fs.rmSync(MARKET_PLUGIN_DIR, { recursive: true, force: true });
  copyTree(PLUGIN_DIR, MARKET_PLUGIN_DIR);
  writeJson(MARKET_MANIFEST, expectedManifest);
  writeJson(ROOT_MARKET, expectedManifest);
  fs.copyFileSync(PLUGIN_README, ROOT_README);

  console.log(`✓ 市场产物已生成（v${version}）`);
  console.log(`  · 离线副本：${path.relative(ROOT, MARKET_PLUGIN_DIR)}`);
  console.log(`  · 市场清单：marketplace.json / client/market/marketplace.json`);
  console.log(`  · 根 README：README.md（来自 workbuddy-bridge/README.md）`);
}

main();