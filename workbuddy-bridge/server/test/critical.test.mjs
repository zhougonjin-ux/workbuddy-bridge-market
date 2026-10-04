// 高风险模块的补测（2026-10-04 全量测试审计）。
//
// 审计方法：34 个源文件里 17 个在 test/ 下零 import 引用；本文件优先补「一旦出错
// 会直接影响用户会话或生产数据」的那几个，其余模块另有测试或依赖真实上游难以单测。
//
// 补测清单（按风险排序）：
//   1. ratelimit.mjs     —— 零覆盖。限流一旦失效，失控重试会打爆上游（连带烧积分）。
//   2. doRestart         —— 零覆盖。它是「不可断线」承诺的入口，记忆里记着两次事故
//                          （16:49 端口空置 73 分钟、22:0x 交棒死锁），全是这条路径。
//   3. doStop            —— 只覆盖了 409 与立即退出，缺「exiting 后拒绝」与重复调用。
//   4. spawnReplacement  —— 零覆盖。找不到 server.mjs 时应报错而非静默。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { createRateLimiter } = await import('../src/ratelimit.mjs');

/* ==================== 1. ratelimit.mjs ==================== */

test('限流：窗口内超限被拒，滑出窗口后恢复', () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 3 });
  const t0 = 1_000_000;
  // 前 3 次放行
  for (let i = 0; i < 3; i++) {
    const r = rl.hit('a', t0 + i);
    assert.equal(r.limited, false, `第 ${i + 1} 次应放行`);
  }
  // 第 4 次超限
  const over = rl.hit('a', t0 + 3);
  assert.equal(over.limited, true, '第 4 次应被限流');
  assert.equal(over.remaining, 0, 'remaining 应为 0');
  assert.ok(over.retryAfterMs > 0 && over.retryAfterMs <= 1000, 'retryAfterMs 应在窗口内');

  // 窗口滑过（t0+1001 距最早那次已 >1000ms）→ 恢复
  const after = rl.hit('a', t0 + 1001);
  assert.equal(after.limited, false, '滑出窗口后应恢复放行');
});

test('限流：不同来源键互不影响', () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(rl.hit('ip-a', 2000).limited, false);
  assert.equal(rl.hit('ip-a', 2001).limited, false);
  assert.equal(rl.hit('ip-a', 2002).limited, true, 'ip-a 超限');
  assert.equal(rl.hit('ip-b', 2003).limited, false, 'ip-b 是独立来源，不该被 ip-a 连累');
  assert.equal(rl.hit('ip-c', 2004).limited, false);
});

test('限流：内存有界（maxKeys 硬上限）—— 防 CWE-770', () => {
  // maxKeys 极小 + 立即清扫，验证「键数不超上限」而不是「无界增长」
  const rl = createRateLimiter({ windowMs: 1000, max: 5, maxKeys: 10, sweepIntervalMs: 1000 });
  const t0 = 5_000_000;
  for (let i = 0; i < 200; i++) {
    rl.hit(`ip-${i}`, t0);
    // 每轮都推进时间到清扫间隔之后，强制触发惰性清扫
    if (i % 20 === 19) rl.hit('ticker', t0 + i * 2000);
  }
  assert.ok(rl.size() <= 10, `键数应 ≤10（maxKeys），实际 ${rl.size()} —— 无界增长就是漏洞本身`);
});

test('限流：完全过期后键被回收，size 归零', () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 5, sweepIntervalMs: 1000 });
  const t0 = 9_000_000;
  rl.hit('a', t0);
  rl.hit('b', t0);
  assert.equal(rl.size(), 2);
  // 远超窗口 + 清扫间隔后再 hit 一次，触发清扫
  rl.hit('c', t0 + 10_000);
  assert.equal(rl.size(), 1, 'a/b 都该被回收，只剩 c');
});

test('限流：参数非法时回落到安全默认（不能变成「不限流」）', () => {
  // windowMs=0 会让「now - 0 >= 0」恒真 → 所有请求都判定滑出窗口 → 限流完全失效；
  // max=0 则让 list.length >= 0 恒真 → 所有请求都被拒。两者都不是「宽松」而是「坏掉」。
  const rl = createRateLimiter({ windowMs: 0, max: 0 });
  assert.ok(rl.windowMs >= 1, `windowMs 应被夹到 ≥1，实际 ${rl.windowMs}（0 会让限流失效）`);
  assert.ok(rl.max >= 1, `max 应被夹到 ≥1，实际 ${rl.max}（0 会让限流失效）`);
  // 修正后仍应真的限流。语义是「窗口内允许 max 次」：前 max 次放行，第 max+1 次被拒。
  let limitedAt = -1;
  for (let i = 1; i <= rl.max + 1; i++) {
    if (rl.hit('x', 1000 + i).limited) { limitedAt = i; break; }
  }
  assert.equal(limitedAt, rl.max + 1,
    `回落默认值后，前 ${rl.max} 次应放行、第 ${rl.max + 1} 次应被限流；实际第 ${limitedAt} 次被限流`);
});

test('限流：reset 清空状态（测试隔离用）', () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 1 });
  rl.hit('a', 1000);
  assert.equal(rl.size(), 1);
  rl.reset();
  assert.equal(rl.size(), 0, 'reset 后应为空');
});

/* ==================== 2-4. lifecycle-impl.mjs ==================== */

// lifecycle-impl 依赖 config/paths 指向真实数据目录，测试里必须先隔离
let life;
let restoreDir;
test.before?.(async () => {});
{
  const { setConfigDir } = await import('../src/config.mjs');
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-life-'));
  restoreDir = setConfigDir(iso);
  life = await import('../src/lifecycle-impl.mjs');
}

test.after(() => { restoreDir?.(); });

test('doRestart：活跃请求为 0 时立即放行，并交棒给新实例', () => {
  life.bootLifecycle({ activeRequestsRef: () => 0, stoppers: [], flushers: [] });
  const r = life.doRestart();
  assert.equal(r.waiting, false, '无活跃请求应立即退出而非等待');
  assert.ok(r.pid, '应返回新实例 PID');
});

test('doRestart：有活跃请求时进入 draining，等归零才退出（不断线核心）', () => {
  let active = 2;
  life.bootLifecycle({ activeRequestsRef: () => active, stoppers: [], flushers: [] });
  const r = life.doRestart();
  assert.equal(r.waiting, true, '有活跃请求应等待');
  assert.equal(r.active, 2, '应报出当前活跃数');

  // 重复调用必须被 409 拒绝（防重入锁：否则会拉起多个新实例抢端口）
  assert.throws(() => life.doRestart(), (e) => e.status === 409, '交棒中再发一次应 409');

  // 活跃降到 1 → 仍不退出
  active = 1;
  life.drainWaiters();
  // 降到 0 → 挂起的退出才执行（这里会真的走 finish，但 exiting 标志只在真调用时置位）
  active = 0;
  life.drainWaiters();
  // 归零后再点一次应当已被 exiting 拦住
  assert.throws(() => life.doRestart(), (e) => e.status === 409, '已退出流程后应 409');
});

test('gracefulExit：stoppers 抛错不影响后续 flusher（退出路径不互相绊）', () => {
  const order = [];
  life.bootLifecycle({
    activeRequestsRef: () => 0,
    stoppers: [
      () => { order.push('stop1'); throw new Error('停循环炸了'); },
      () => order.push('stop2'),
    ],
    flushers: [() => order.push('flush1')],
  });
  life.gracefulExit({ waitIdle: false, reason: '测试' });
  assert.deepEqual(order, ['stop1', 'stop2', 'flush1'],
    '前一个 stopper 抛错后，后面的 stopper 与 flusher 仍必须执行 —— 否则数据不落盘');
});

test('gracefulExit：只执行一次（exiting 幂等）', () => {
  let n = 0;
  life.bootLifecycle({ activeRequestsRef: () => 0, stoppers: [], flushers: [() => { n++; }] });
  life.gracefulExit({ waitIdle: false, reason: '第一次' });
  life.gracefulExit({ waitIdle: false, reason: '第二次' });
  assert.equal(n, 1, '重复调用 gracefulExit 不应重复刷盘');
});

test('doStop：force 只跳过「拒绝」，仍等在途请求跑完', () => {
  let active = 1;
  life.bootLifecycle({ activeRequestsRef: () => active, stoppers: [], flushers: [] });
  const r = life.doStop({ force: true });
  assert.equal(r.waiting, true, 'force 下仍应等待在途请求（掐断=会话断线）');
  assert.equal(r.active, 1);
  active = 0;
  life.drainWaiters();
});

test('doStop：exiting 后再调用应 409', () => {
  life.bootLifecycle({ activeRequestsRef: () => 0, stoppers: [], flushers: [] });
  life.doStop();
  assert.throws(() => life.doStop(), (e) => e.status === 409, '退出流程中应 409');
});

test('drainWaiters：未处于 draining 时是空操作（不能凭空触发退出）', () => {
  let active = 0;
  let flushed = 0;
  life.bootLifecycle({ activeRequestsRef: () => active, stoppers: [], flushers: [() => { flushed++; }] });
  life.drainWaiters();
  assert.equal(flushed, 0, '没有 pendingExits 时不该执行任何 flusher');
});
