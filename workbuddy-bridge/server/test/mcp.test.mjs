// MCP stdio 层的冒烟测试（2026-10-04 全量测试审计）。
//
// 为什么单独起子进程：mcp/index.mjs 是 stdio JSON-RPC 服务器，import 进来就会
// 往 stdout 打印响应，污染 node --test 的 TAP 输出。必须以子进程跑，用管道喂 JSON-RPC。
//
// 覆盖点：初始化握手、工具清单完整性、未知工具的报错形态、非法 JSON 的处理。
// 这些是「用户通过 /wbp 等命令或客户端调 MCP」的第一道门，坏了整条 AI 操作链都断。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpEntry = path.join(here, '..', '..', 'mcp', 'index.mjs');

/** 喂一串 JSON-RPC 消息给 MCP 进程，返回它写到 stdout 的所有 JSON 行。 */
function rpc(lines, { timeout = 15000 } = {}) {
  const input = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [mcpEntry], {
    input,
    encoding: 'utf8',
    timeout,
    // 隔离数据目录：MCP 会读 config.json，绝不能碰生产数据
    env: {
      ...process.env,
      WB_CONFIG_DIR: path.join(here, '..', '..', '.mcp-smoke-tmp'),
    },
  });
  const out = (r.stdout || '').split('\n').filter(Boolean);
  const parsed = [];
  for (const l of out) {
    try { parsed.push(JSON.parse(l)); } catch { /* 非 JSON 行（日志）忽略 */ }
  }
  return { parsed, raw: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

test('MCP：initialize 握手返回协议版本与 serverInfo', () => {
  const { parsed } = rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
  ]);
  const init = parsed.find((m) => m.id === 1);
  assert.ok(init, `应有 initialize 响应，实际输出：${JSON.stringify(parsed).slice(0, 300)}`);
  assert.equal(init.jsonrpc, '2.0');
  assert.ok(init.result?.protocolVersion, '应回 protocolVersion');
  assert.ok(init.result?.serverInfo?.name, '应回 serverInfo.name');
  assert.ok(init.result?.capabilities, '应声明 capabilities');
});

test('MCP：tools/list 返回 13 个工具且都有 name/description/inputSchema', () => {
  const { parsed } = rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const list = parsed.find((m) => m.id === 2);
  assert.ok(list?.result?.tools, 'tools/list 应返回 tools 数组');
  const tools = list.result.tools;
  assert.equal(tools.length, 13, `工具数应为 13，实际 ${tools.length}：${tools.map((t) => t.name).join(',')}`);
  for (const t of tools) {
    assert.ok(t.name, '每个工具要有 name');
    assert.ok(t.description, `工具 ${t.name} 缺 description —— 客户端要靠它决定何时调用`);
    assert.equal(t.inputSchema?.type, 'object', `工具 ${t.name} 的 inputSchema 应是 object`);
  }
  // 关键工具必须在（用户与命令直接依赖）
  const names = tools.map((t) => t.name);
  for (const must of ['wb_status', 'wb_models', 'wb_switch', 'wb_tasks_run', 'wb_credit_plan']) {
    assert.ok(names.includes(must), `缺少关键工具 ${must}`);
  }
});

test('MCP：未知工具返回 JSON-RPC 错误而不是崩溃', () => {
  const { parsed, code } = rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wb_不存在', arguments: {} } },
  ]);
  const r = parsed.find((m) => m.id === 2);
  assert.ok(r, '应给未知工具一个响应');
  // 两种合规形态：JSON-RPC error，或 result 里带 isError。都不该是「进程崩掉」
  const isErrorShape = r.error || r.result?.isError;
  assert.ok(isErrorShape, `未知工具应报错，实际：${JSON.stringify(r).slice(0, 200)}`);
});

test('MCP：非法 JSON 行不拖垮进程（后续请求仍能应答）', () => {
  const r = spawnSync(process.execPath, [mcpEntry], {
    input: '这不是JSON\n' + JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n',
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, WB_CONFIG_DIR: path.join(here, '..', '..', '.mcp-smoke-tmp') },
  });
  const parsed = (r.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = parsed.find((m) => m.id === 9);
  assert.ok(init?.result, '喂一行脏数据后，后续合法请求仍应正常应答');
});
