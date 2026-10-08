// 客户端指纹剥离回归测试（2026-10-08 补，上游 400 实录驱动）。
//
// 背景：上游 cn-cli 对 system 里的「客户端指纹」做精确黑名单，命中回
// 400 "Illegal API invocation from an unapproved channel"。此前只覆盖 Claude Code
// 开场白一条，且只处理字符串 content。ZCode 复刻的 gitStatus 句
// "Main branch (you will usually use this for PRs)" 让所有带 git 上下文的请求
// 全军覆没（二分定位实录：换掉 system 即 200，剥成 "Main branch: main" 也 200）。
// 这里把「新增指纹」「数组分段 content」「开关关闭不剥」三类行为钉死。
//
// 运行：node --test server/test/fingerprint.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 测试隔离：先指到临时目录再 import
process.env.WB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fingerprint-test-'));

const { stripClientFingerprint, prepareBody, dumpRejectedBody } = await import('../src/upstream.mjs');
const { paths } = await import('../src/config.mjs');

const FALLBACK = 'You are a helpful AI assistant.';
const CC_OPENING = "You are Claude Code, Anthropic's official CLI for Claude.";
const GITSTATUS = 'Main branch (you will usually use this for PRs): main';

test('剥离 Claude Code 开场白，其余指令原样保留', () => {
  const messages = [{ role: 'system', content: `Before ${CC_OPENING} After` }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.ok(!messages[0].content.includes('Claude Code,'));
  assert.ok(messages[0].content.includes('Before'));
  assert.ok(messages[0].content.includes('After'));
});

test('整条 system 就是开场白时用 fallback 兜底', () => {
  const messages = [{ role: 'system', content: CC_OPENING }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.equal(messages[0].content, FALLBACK);
});

test('剥离 gitStatus 指纹且保留分支名语义', () => {
  const messages = [{ role: 'system', content: `Current branch: main\n\n${GITSTATUS}\n\nGit user: x` }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.equal(messages[0].content.includes('you will usually use this for PRs'), false);
  assert.ok(messages[0].content.includes('Main branch: main'));
  assert.ok(messages[0].content.includes('Current branch: main'));
  assert.ok(messages[0].content.includes('Git user: x'));
});

test('分支名不是 main 也命中', () => {
  const messages = [{ role: 'system', content: 'Main branch (you will usually use this for PRs): develop' }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.equal(messages[0].content, 'Main branch: develop');
});

test('同一消息内多处命中全部剥离', () => {
  const messages = [{ role: 'system', content: `${GITSTATUS}\n${GITSTATUS}` }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.equal(messages[0].content.includes('you will usually use this for PRs'), false);
});

test('分段数组 content 里的指纹同样剥离', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: GITSTATUS }, { type: 'text', text: 'other' }] },
  ];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.equal(messages[0].content[0].text, 'Main branch: main');
  assert.equal(messages[0].content[1].text, 'other');
});

test('无指纹时内容一字不动、不计数', () => {
  const original = 'Main branch: main\n\n\n\nGit user: x';
  const messages = [{ role: 'system', content: original }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 0);
  assert.equal(messages[0].content, original);
});

test('user 位置同名内容不动（上游只黑 system/assistant，探针 E 实锤）', () => {
  const messages = [{ role: 'user', content: GITSTATUS }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 0);
  assert.equal(messages[0].content, GITSTATUS);
});

// —— 第三轮探针实锤（2026-10-08，cn-cli）：assistant content 同样被上游拉黑 ——
// 这就是 system 层剥离后仍偶发 400 的根因：编码会话里助手历史消息
// （曾输出/编辑过含指纹的代码）让后续所有请求带毒。

test('assistant content 里的开场白指纹剥离', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: `note: ${CC_OPENING}` },
    { role: 'user', content: 'continue' },
  ];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.ok(!messages[1].content.includes('Claude Code,'));
  assert.ok(messages[1].content.includes('note:'));
});

test('assistant content 里的 gitStatus 指纹剥离', () => {
  const messages = [{ role: 'assistant', content: `note: ${GITSTATUS}` }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.ok(!messages[0].content.includes('you will usually use this for PRs'));
  assert.ok(messages[0].content.includes('Main branch: main'));
});

test('assistant 整条 content 就是指纹时用中性占位符兜底', () => {
  const messages = [{ role: 'assistant', content: CC_OPENING }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.equal(messages[0].content, '(earlier content removed)');
});

test('assistant content:null（纯工具调用消息）跳过不报错', () => {
  const messages = [{ role: 'assistant', content: null, tool_calls: [] }];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 0);
});

test('assistant 数组分段 content 里的指纹同样剥离', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: GITSTATUS }, { type: 'text', text: 'other' }] },
  ];
  assert.equal(stripClientFingerprint(messages, FALLBACK), 1);
  assert.equal(messages[0].content[0].text, 'Main branch: main');
  assert.equal(messages[0].content[1].text, 'other');
});

test('prepareBody：开关关闭时不剥离', () => {
  const cfg = { stripClientFingerprint: false, defaultSystemPrompt: FALLBACK };
  const body = prepareBody(cfg, { messages: [{ role: 'system', content: GITSTATUS }] });
  assert.ok(body.messages[0].content.includes('you will usually use this for PRs'));
});

test('prepareBody：默认剥离，其余系统指令不受影响', () => {
  const cfg = { defaultSystemPrompt: FALLBACK };
  const body = prepareBody(cfg, {
    messages: [{ role: 'system', content: `Be terse.\n${GITSTATUS}` }],
  });
  assert.equal(body.messages[0].content.includes('you will usually use this for PRs'), false);
  assert.ok(body.messages[0].content.includes('Be terse.'));
  assert.ok(body.messages[0].content.includes('Main branch: main'));
});

test('dumpRejectedBody：11128 报错留存请求体，其余错误不留', () => {
  const before = fs.existsSync(path.join(paths.root, 'rejected'))
    ? fs.readdirSync(path.join(paths.root, 'rejected')).length : 0;

  const payload = { model: 'glm-5.3-flash', messages: [{ role: 'system', content: 'poison' }] };
  dumpRejectedBody(400, '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}', payload);
  // 非 11128 报错不落盘
  dumpRejectedBody(400, '{"code":11133,"msg":"too long"}', payload);

  const dir = path.join(paths.root, 'rejected');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('rejected-') && f.endsWith('.json'));
  assert.equal(files.length, before + 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files.at(-1)), 'utf8'));
  assert.match(saved.upstream, /Illegal API invocation/);
  assert.equal(saved.payload.model, 'glm-5.3-flash');
  assert.equal(saved.status, 400);
});
