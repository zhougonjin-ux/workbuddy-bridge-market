#!/usr/bin/env node
// 文档漂移校验：README 第 8 节列出的 MCP 工具与斜杠命令，必须与实际代码一致。
//
// 为什么需要：README 曾写「178 项测试」「5 种策略」「9 个命令」，
// 而代码早就是 243 项 / 7 种 / 11 个。文档不会报错，只会慢慢变成谎言。
//
// 只校验、不改写文档：README 的叙述结构比自动生成更可读，
// 但「清单类」内容必须由代码兜底。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'workbuddy-bridge');
const README = path.join(PLUGIN, 'README.md');
const MCP_ENTRY = path.join(PLUGIN, 'mcp', 'index.mjs');
const COMMANDS_DIR = path.join(PLUGIN, 'commands');

const problems = [];

if (!fs.existsSync(README)) {
  console.error('✗ 缺少 workbuddy-bridge/README.md');
  process.exit(1);
}
const readme = fs.readFileSync(README, 'utf8');

// 1) MCP 工具：以 index.mjs 的 TOOLS 定义为准
const mcpSrc = fs.readFileSync(MCP_ENTRY, 'utf8');
const tools = [...mcpSrc.matchAll(/\bname:\s*'(wb_[a-z0-9_]+)'/g)].map((m) => m[1]);
const uniqTools = [...new Set(tools)];
for (const t of uniqTools) {
  if (!readme.includes('`' + t + '`')) problems.push(`README 未列出 MCP 工具 ${t}`);
}
// 反向：README 里写了但代码里没有
for (const m of readme.matchAll(/`(wb_[a-z0-9_]+)`/g)) {
  if (!uniqTools.includes(m[1])) problems.push(`README 写了不存在的 MCP 工具 ${m[1]}`);
}

// 2) 斜杠命令：以 commands/*.md 为准
const commands = fs.readdirSync(COMMANDS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => '/' + path.basename(f, '.md'));
for (const c of commands) {
  if (!readme.includes('`' + c + '`')) problems.push(`README 未列出斜杠命令 ${c}`);
}
for (const m of readme.matchAll(/`(\/wbp[a-z-]*)`/g)) {
  if (!commands.includes(m[1])) problems.push(`README 写了不存在的斜杠命令 ${m[1]}`);
}

// 3) 计数类描述：只检查「共 N 个」这类硬数字是否与实际一致
const cmdCount = readme.match(/斜杠命令（`commands\/` 目录，共 (\d+) 个）/);
if (cmdCount && Number(cmdCount[1]) !== commands.length) {
  problems.push(`README 写「共 ${cmdCount[1]} 个」命令，实际 ${commands.length} 个`);
}
const toolCount = readme.match(/提供 (\d+) 个工具/);
if (toolCount && Number(toolCount[1]) !== uniqTools.length) {
  problems.push(`README 写「${toolCount[1]} 个工具」，实际 ${uniqTools.length} 个`);
}

if (problems.length) {
  console.error(`✗ 文档与代码不一致（${problems.length} 处）：`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(`✓ 文档清单一致（${uniqTools.length} 个 MCP 工具 / ${commands.length} 个命令）`);