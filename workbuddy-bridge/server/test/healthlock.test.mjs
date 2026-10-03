// 巡检锁残留的回归测试（T35 顺带修的真 bug）。
//
// 为什么单独一个文件：health.mjs 的 state 是模块级缓存（懒加载 + 记住来源路径），
// 同一个进程里没法让「盘上残留 scanning:true」与「本进程读盘」相遇 —— 第一次读盘
// 就缓存住了。所以这里起一个子进程，让它对着一个写好残留锁的临时数据目录读一次。
//
// 复现的事故（2026-10-03）：scanning 一直跟着 saveState 落盘，进程在巡检途中被
// 交棒重启打断，盘上留下 scanning:true；重启后 loadState 把它读回内存，于是
// 「巡检进行中，请等上一轮结束」被永久锁死，用户点巡检永远转圈。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
// Windows 的 ESM 动态 import 只吃 file:// URL，裸绝对路径（E:\...）会被当 scheme 'e:'
const healthUrl = pathToFileURL(path.join(here, '..', 'src', 'health.mjs')).href;

test('残留的 scanning:true 不会让巡检被永久锁死', () => {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-health-lock-'));
  // 摆一份「死在巡检途中」的盘面
  fs.writeFileSync(
    path.join(iso, 'health.json'),
    JSON.stringify({ scanning: true, lastScanAt: '2026-10-02T19:08:51.854Z', results: [{ model: 'x' }], history: [] }),
    'utf8',
  );
  // 子进程里读盘，断言锁已被清掉、且历史结果没被误伤
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { healthStatus } = await import(${JSON.stringify(healthUrl)});
    const st = healthStatus({});
    process.stdout.write(JSON.stringify({ scanning: st.scanning, results: st.results.length, lastScanAt: st.lastScanAt }));
  `], {
    env: { ...process.env, WB_CONFIG_DIR: iso },
    encoding: 'utf8',
  });
  const got = JSON.parse(out);
  assert.equal(got.scanning, false, '读盘时应清掉残留锁，否则巡检永远跑不了');
  assert.equal(got.results, 1, '上次巡检结果要保留（只清锁，别把数据一起清了）');
  assert.equal(got.lastScanAt, '2026-10-02T19:08:51.854Z', '上次巡检时间要保留');
  fs.rmSync(iso, { recursive: true, force: true });
});
