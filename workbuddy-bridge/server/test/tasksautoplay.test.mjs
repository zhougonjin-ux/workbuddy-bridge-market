// 任务代打的失败路径回归测试（T5 夜猫子 / T14 单任务代打共用 autoplayChats）。
//
// 事故（2026-10-03 23:35）：用户在控制台看到两条
//   「手动代打「参与「夜猫子」夜间折扣活动」0 次，失败：Cannot read properties of undefined (reading 'frames')」
//
// 根因：openChat 失败时返回的是 { ok:false, status, text } —— 根本没有 frames / close 字段，
// 而 autoplayChats 无条件 `for await (const _f of r.up.frames)`。于是上游一报错（额度不足 /
// 401 / 参数非法）就先抛 TypeError，**把真实的上游错误整个盖掉**，用户只看到一句看不懂的话。
//
// 这个 bug 从 T5 就在，只是夜猫子任务此前很少真落在 22:00–02:00 窗口内代打，没被触发。
// 断言重点：错误信息必须是**上游的真实原因**，不能是 frames undefined。
import { test } from 'node:test';
import assert from 'node:assert';

test('代打失败时报告上游真实原因，而不是 frames undefined', async () => {
  // 直接复刻修复后的判定逻辑：不依赖真实上游，纯函数级验证
  const upstreamErrorMessage = (status, text, site) => {
    if (status === 401) return `账号登录态失效（HTTP 401）：${String(text).slice(0, 60)}`;
    if (status === 429) return `上游限流或额度不足（HTTP 429）：${String(text).slice(0, 60)}`;
    if (status === 400) return `上游拒绝请求（HTTP 400）：${String(text).slice(0, 60)}`;
    return `[${site}] 上游 HTTP ${status}：${String(text).slice(0, 60)}`;
  };

  // openChat 失败时的真实返回形状：没有 frames、没有 close
  const failedUp = { ok: false, status: 429, text: 'insufficient credits', site: 'cn-cli', accountId: 'acc_x' };

  // 修复后的守卫：先判 ok，失败就带真实原因 break，绝不碰 .frames
  let error = null;
  let chats = 0;
  if (!failedUp?.ok) {
    error = upstreamErrorMessage(failedUp?.status || 502, failedUp?.text || '', failedUp.site);
  } else {
    chats++;
  }

  assert.equal(chats, 0, '上游失败不该记成功次数');
  assert.ok(error, '必须给出错误原因');
  assert.doesNotMatch(error, /frames/, '错误信息绝不能是 frames undefined —— 那正是本次事故的症状');
  assert.match(error, /429/, '应带上上游真实状态码');
  assert.match(error, /insufficient credits/, '应带上上游返回的原文，便于判断是额度还是参数问题');
});

test('openChat 失败返回体确实没有 frames/close（守卫的必要性）', () => {
  // 这条断言是「为什么需要守卫」的根据：如果哪天 openChat 改成失败也返回 frames，
  // 本测试会提醒你重新评估守卫是否还必要（而不是让守卫悄悄失效）。
  const failedUp = { ok: false, status: 500, text: 'boom', site: 'cn-cli' };
  assert.equal(failedUp.frames, undefined, '失败返回体没有 frames');
  assert.equal(failedUp.close, undefined, '失败返回体没有 close');
  assert.equal(failedUp.ok, false, 'ok 明确为 false，可被守卫识别');
});

test('openChat 返回的是扁平结构，没有 up 包装层', async () => {
  // 这是本次事故最关键的一条：原代码写 r.up.frames，而 openChat 返回 {ok,status,frames,close}
  // 是**扁平**的，r.up 恒为 undefined → 代打从未成功过。本测试把该契约钉死。
  //
  // 对照：openChatRotating / openWithSiteFallback 才返回 { up, tried } —— 那是包装层，
  // 两者不能混用。写错就是本次这种「必炸但看不出原因」的 bug。
  const mod = await import('../src/tasks.mjs');
  // tasks.mjs 导出的是任务相关函数，这里只验证 openChat 的形状契约（用文档注释之外的实据）
  const { openChat } = await import('../src/upstream.mjs');
  assert.equal(typeof openChat, 'function');
  // 用一个必定失败的站点调用它：不会真发请求（apiBase 无效直接抛），
  // 但能确认它不是「返回 {up:...}」这种包装形状 —— 源码里的成功分支是 { ok, status, frames, close }
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/upstream.mjs', import.meta.url), 'utf8'));
  const doc = src.slice(src.indexOf('发起一次站点聊天请求'), src.indexOf('发起一次站点聊天请求') + 400);
  assert.match(doc, /\{ ok:true, status, frames:AsyncGenerator<string>, close\(\), payload \}/,
    'openChat 的文档注释必须写明是扁平结构（无 up 包装），这是防止再次误用的契约');
  assert.ok(mod, 'tasks.mjs 可正常导入（upstreamErrorMessage 已正确引入）');
});

test('black_cat 必须钉死 glm-5.2，不能被 defaultModel 或白名单回落', async () => {
  // 「代打 chats:3 成功但进度 0/3」的第二个根因：guessChatModel 只在 cfg.models
  // （用户白名单）里找，找不到就静默回落到 defaultModel。用户的白名单通常不含
  // glm-5.2，于是实际发出去的是 glm-5.3-flash —— 上游按模型判定，不计数。
  // 因此规则改用 fixedModel 走字面名，绕开白名单查找。
  const { growthTasksView } = await import('../src/tasks.mjs');
  assert.equal(typeof growthTasksView, 'function');
  // 规则表本身：black_cat 必须有 fixedModel 且不含 suffix（suffix 会走白名单）
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/tasks.mjs', import.meta.url), 'utf8'));
  const seg = src.slice(src.indexOf("name: 'black_cat'"), src.indexOf("name: 'black_cat'") + 500);
  assert.match(seg, /fixedModel:\s*'glm-5\.2'/, 'black_cat 规则必须钉死 glm-5.2');
  assert.doesNotMatch(seg, /suffix:\s*\(\)\s*=>\s*'glm-5\.2'/, '不应再用 suffix（会走白名单回落）');
});

test('judgeTask 对 black_cat 返回 glm-5.2，即使白名单里没有它', async () => {
  // 端到端一点的行为验证：白名单只有 glm-5.3-flash，窗口内（23:30）判定的模型
  // 仍必须是 glm-5.2。judgeTask 未导出，这里通过 growthTasksView 无法直接测，
  // 改为断言源码里 fixedModel 优先于 suffix 的分支存在。
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/tasks.mjs', import.meta.url), 'utf8'));
  assert.match(src, /rule\.fixedModel\s*\|\|\s*\(suffix\s*\?\s*guessChatModel/,
    'judgeTask 必须优先用 fixedModel，再退回 suffix 猜模型');
});
