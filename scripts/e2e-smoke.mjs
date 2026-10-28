// 端到端冒烟（0.4.0）：真起一个隔离实例（临时配置目录 + 独立端口），走一遍
// 健康检查、控制台页面、鉴权、模型目录、CORS 拒绝、优雅关闭。
//
// 为什么不用浏览器自动化：控制台是单文件大脚本，Playwright 要额外依赖与下载浏览器；
// 冒烟的目标是「服务能起、关键路由不 500、鉴权与跨域策略没退化」，用内置 fetch 足够，
// 且能在 CI 里零依赖跑。
//
// 用法：node scripts/e2e-smoke.mjs [--port=8899] [--verbose]
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..', 'workbuddy-bridge', 'server');
const args = process.argv.slice(2);
const PORT = Number((args.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 8899;
const VERBOSE = args.includes('--verbose');
const KEY = 'sk-e2e-smoke';
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!VERBOSE && ok) return;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function waitHealth(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    host: '127.0.0.1',
    port: PORT,
    apiKey: KEY,
    defaultSite: 'cn-cli',
    defaultModel: 'deepseek-v4-pro',
    tasks: { enabled: false },
    healthCheck: { enabled: false },
    backup: { enabled: false },
    weekly: { enabled: false },
    doctor: { enabled: false },
  }, null, 2));

  const child = spawn(process.execPath, [path.join(SERVER_DIR, 'server.mjs')], {
    cwd: SERVER_DIR,
    env: { ...process.env, WB_CONFIG_DIR: dir, WB_HOOK_SPAWN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  const cleanup = () => {
    try { child.kill(); } catch { /* 已退出 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  };
  process.on('exit', cleanup);

  try {
    const up = await waitHealth(20_000);
    check('服务在 20 秒内起来并通过 /health', up, up ? '' : out.slice(-500));
    if (!up) return;

    const health = await (await fetch(`${BASE}/health`)).json();
    check('/health 返回 sites 列表', Array.isArray(health.sites) && health.sites.length > 0, `sites=${(health.sites || []).length}`);

    // 控制台页面（同源请求，无 Origin）
    const consoleRes = await fetch(`${BASE}/console`);
    const consoleHtml = await consoleRes.text();
    check('/console 返回 HTML', consoleRes.ok && /<html/i.test(consoleHtml), `status=${consoleRes.status}`);
    check('控制台页面内联会话 token', /__WB_TOKEN__|wbConsoleToken/i.test(consoleHtml));

    // 控制台接口：无鉴权应 401
    const noAuth = await fetch(`${BASE}/console/api/state`);
    check('控制台接口未鉴权返回 401/403', noAuth.status === 401 || noAuth.status === 403, `status=${noAuth.status}`);

    // 带 apiKey：200
    const state = await fetch(`${BASE}/console/api/state`, { headers: { Authorization: `Bearer ${KEY}` } });
    check('控制台接口带 apiKey 返回 200', state.ok, `status=${state.status}`);

    // 模型目录：未登录时回落到配置兜底
    const models = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
    const modelsJson = await models.json().catch(() => null);
    check('/v1/models 返回 list', models.ok && modelsJson && modelsJson.object === 'list', `status=${models.status}`);

    // 新增接口（0.4.0）
    for (const p of ['/console/api/channels', '/console/api/lan', '/console/api/projects']) {
      const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${KEY}` } });
      check(`${p} 可用`, r.ok, `status=${r.status}`);
    }

    // CORS：非白名单来源访问控制台必须被拒
    const evil = await fetch(`${BASE}/console`, { headers: { Origin: 'http://evil.example' } });
    check('非本机 Origin 访问控制台被拒', evil.status === 403, `status=${evil.status}`);

    // 未知路径 404
    const nf = await fetch(`${BASE}/definitely-not-a-route`, { headers: { Authorization: `Bearer ${KEY}` } });
    check('未知路径返回 404', nf.status === 404, `status=${nf.status}`);
  } finally {
    try {
      await fetch(`${BASE}/admin/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* 可能已退出 */ }
    await new Promise((r) => setTimeout(r, 500));
    cleanup();
  }
}

await main();
fs.writeFileSync(path.join(os.tmpdir(), 'wb-e2e-result.txt'), JSON.stringify(results, null, 2), 'utf8');
const failed = results.filter((r) => !r.ok);
console.log(`\nSMOKE: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exit(1);
}