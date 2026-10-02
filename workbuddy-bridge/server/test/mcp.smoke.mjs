// 冒烟：MCP stdio 服务器 —— initialize / tools/list / tools/call(wb_status)。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('../../mcp/index.mjs', import.meta.url))], {
  env: { ...process.env, WB_CONFIG_DIR: process.env.TEMP + '/wbbridge-srv' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const responses = [];
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) responses.push(JSON.parse(line));
  }
});
child.stderr.on('data', (d) => process.stderr.write('[mcp] ' + d));

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (id, timeoutMs = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = responses.find((r) => r.id === id);
    if (hit) return hit;
    await wait(100);
  }
  throw new Error(`等待 id=${id} 响应超时`);
};

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
const init = await waitFor(1);
console.log('initialize →', init.result.serverInfo.name, init.result.protocolVersion);

send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const list = await waitFor(2);
console.log('tools/list →', list.result.tools.map((t) => t.name).join(', '));

send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wb_status', arguments: {} } });
const call = await waitFor(3);
const text = call.result?.content?.[0]?.text || '';
console.log('wb_status →', call.result?.isError ? 'ERROR: ' + text.slice(0, 120) : text.split('\n').slice(0, 4).join(' | '));

const ok = init.result?.serverInfo?.name === 'workbuddy-bridge' && list.result.tools.length === 9 && typeof text === 'string' && text.includes('调度策略');
console.log(ok ? 'MCP-SMOKE-OK' : 'MCP-SMOKE-FAIL');
child.kill();
process.exit(ok ? 0 : 1);
