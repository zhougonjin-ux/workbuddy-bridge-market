// 0.3.54 事件链重放（移植 dsh-xdpool）的纯函数回归测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  desktopChatEvents, buddyAppChain, templateChains, libraryReadChain,
  appearanceChain, skillChain, expertSummonEvents, expertChatEvents,
  desktopFingerprint, isEventChainTask, EVENT_CHAIN_CODES,
} from '../src/taskevents.mjs';

test('desktopChatEvents：六事件链的顺序与会话字段（打分器认的就是这个序列）', () => {
  const evts = desktopChatEvents('conv-1', 'req-1', 'msg-1');
  assert.deepEqual(
    evts.map((e) => e.eventCode),
    ['agent_task_created', 'chat_message_send', 'chat_request_send', 'chat_message_response', 'chat_message_status', 'chat_request_response'],
  );
  // chat_request_send 必须携带会话身份字段（dsh 实测：缺了 200 但计 0 分）
  const send = evts.find((e) => e.eventCode === 'chat_request_send');
  assert.equal(send['codebuddy.session_id'], 'conv-1');
  assert.equal(send['codebuddy.conversation_request_id'], 'req-1');
  assert.equal(send.userId, undefined, 'userId 由指纹层合并，链本身不带');
});

test('buddyAppChain：五连点，buddyId 恒定（一次点亮 Buddy_App 与 Buddy_App_QQ）', () => {
  const chain = buddyAppChain();
  assert.equal(chain.transport, 'desktop');
  assert.equal(chain.events.length, 5);
  assert.ok(chain.events.every((e) => e.buddyId === chain.events[0].buddyId));
});

test('templateChains：5 条链、模板 id 各不相同（打分器数的是不同 template_used）', () => {
  const chains = templateChains();
  assert.equal(chains.length, 5);
  const ids = chains.map((c) => c.events.find((e) => e.eventCode === 'template_used').template_id);
  assert.deepEqual([...new Set(ids)].sort(), ['1', '2', '3', '4', '5']);
});

test('libraryReadChain：走 web 指纹（同事件走桌面指纹计 0 分）', () => {
  const chain = libraryReadChain();
  assert.equal(chain.transport, 'web');
  assert.equal(chain.web.eventCode, 'web_element_click');
  assert.ok(chain.web.pageUrl.startsWith('https://www.workbuddy.cn/'));
});

test('skillChain：chat_message_response 必须报 tool_calls（技能被当工具加载才计分）', () => {
  const chain = skillChain('conv-9', 'cmb-' + 'a'.repeat(32));
  const resp = chain.events.find((e) => e.eventCode === 'chat_message_response');
  assert.equal(resp.finishReason, 'tool_calls');
  const info = chain.events.find((e) => e.eventCode === 'skill_info');
  assert.ok(info && info.skillId && info.conversationId === 'conv-9');
});

test('专家事件族：召唤三事件 + agent_task_created 带 expert 字段', () => {
  const expert = { expertId: 'ex_x', expertType: 'agent', displayName: '测试专家', profession: '测试', version: '', categories: ['cat-a'] };
  const summon = expertSummonEvents(expert);
  assert.deepEqual(summon.map((e) => e.eventCode), ['web_element_click', 'expert_summon_click', 'expert_summoned']);
  const chat = expertChatEvents(expert, 'conv-e', 'req-e');
  const created = chat.find((e) => e.eventCode === 'agent_task_created');
  assert.equal(created.has_expert, true);
  assert.equal(created.expert_id, 'ex_x');
  // version 为空时兜底 1.0.0
  assert.equal(summon[1].version, '1.0.0');
});

test('desktopFingerprint：同 uid 派生稳定，machineId ≠ sessionId，36 hex', () => {
  const a = desktopFingerprint({ uid: 'u123', nickname: '张三' });
  const b = desktopFingerprint({ uid: 'u123', nickname: '张三' });
  assert.equal(a.machineId, b.machineId);
  assert.equal(a.sessionId, b.sessionId);
  assert.notEqual(a.machineId, a.sessionId);
  assert.match(a.machineId, /^[0-9a-f]{36}$/);
  assert.equal(a.ideVersion, '5.5.6');
});

test('isEventChainTask：11 类链任务判定（RichMeow_Chat 仍走对话代打，不在此表）', () => {
  for (const code of EVENT_CHAIN_CODES) assert.ok(isEventChainTask(code), code);
  assert.equal(EVENT_CHAIN_CODES.length, 12);
  assert.equal(isEventChainTask('RichMeow_Chat'), false);
  assert.equal(isEventChainTask('black_cat'), false);
  assert.equal(isEventChainTask('wb_wechat_oa_subscribe_task'), false);
});
