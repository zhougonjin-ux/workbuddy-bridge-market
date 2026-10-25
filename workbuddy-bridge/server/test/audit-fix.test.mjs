// 0.3.53 审查修复的回归测试（full-audit-0352）
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankSiteCandidates } from '../src/router.mjs';
import { missedRunToday } from '../src/tasks.mjs';

test('rankSiteCandidates：比较器对称，等 key 项保持稳定顺序（0.3.53 P3）', () => {
  // z 倍率最低居首；b/a 倍率相同且都不是默认站点 → 比较器必须返回 0，
  // 稳定排序保持原相对顺序 [b,a]（旧三元式在这种情况下恒返回 1，结果依赖 V8 实现）
  const r = rankSiteCandidates(
    [
      { site: 'b', mult: 0.5, usable: true },
      { site: 'a', mult: 0.5, usable: true },
      { site: 'z', mult: 0.1, usable: true },
    ],
    'cn-cli',
  );
  assert.deepEqual(r.map((x) => x.site), ['z', 'b', 'a']);
  // 默认站点在其余 key 相同时排最前
  const r2 = rankSiteCandidates(
    [
      { site: 'x', mult: 0.5, usable: true },
      { site: 'cn-cli', mult: 0.5, usable: true },
      { site: 'y', mult: 0.5, usable: true },
    ],
    'cn-cli',
  );
  assert.equal(r2[0].site, 'cn-cli');
});

test('missedRunToday：report（活跃上报）参与补跑（0.3.53 P3）', () => {
  const cfg = { tasks: { reportTimes: ['10:00'] } };
  const at = new Date(2026, 9, 25, 12, 0); // 10:00 已过
  const before = new Date(2026, 9, 25, 9, 0); // 还没到
  assert.equal(missedRunToday(cfg, 'report', at), true, '时点已过且未跑 → 补');
  assert.equal(missedRunToday(cfg, 'report', before), false, '时点未到 → 不补');
  assert.equal(missedRunToday({ tasks: {} }, 'report', at), false, '未配置 reportTimes = 调度未启用，不补');
});
