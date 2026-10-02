// 冒烟：/admin/* 管理端点（bridge / policy 切换 / tasks 状态）+ MCP 工具链路。
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(process.env.TEMP + '/wbbridge-srv/config.json', 'utf8'));
const H = { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' };
const j = (p, init) => fetch('http://127.0.0.1:8788' + p, init).then(async (r) => ({ status: r.status, body: await r.json() }));

const bridge = await j('/admin/bridge', { headers: H });
console.log('bridge.status =', bridge.status, '| policy =', bridge.body.policy, '| sites =', bridge.body.sites.map((s) => `${s.site}(${s.accounts.length})`).join(','));

const sw = await j('/admin/policy', { method: 'POST', headers: H, body: JSON.stringify({ policy: 'balance-first' }) });
console.log('switch.status =', sw.status, '| now =', sw.body.policy);

const bad = await j('/admin/policy', { method: 'POST', headers: H, body: JSON.stringify({ policy: 'bogus' }) });
console.log('bogus.status =', bad.status, '(期望 400)');

const tasks = await j('/admin/tasks', { headers: H });
console.log('tasks.status =', tasks.status, '| today =', tasks.body.today);

const noauth = await fetch('http://127.0.0.1:8788/admin/bridge');
console.log('no-auth.status =', noauth.status, '(期望 401)');

const models = await j('/v1/models');
console.log('models.status =', models.status, '| count =', (models.body.data || []).length, '| first =', (models.body.data || [])[0]?.id);

const ok = bridge.status === 200 && sw.body.policy === 'balance-first' && bad.status === 400 && tasks.status === 200 && noauth.status === 401 && models.status === 200;
console.log(ok ? 'ADMIN-SMOKE-OK' : 'ADMIN-SMOKE-FAIL');
process.exit(ok ? 0 : 1);
