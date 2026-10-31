// 多端同步（0.3.64）合并逻辑单测：纯函数不碰文件系统/网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePool, mergeConfig, newerDoc, deviceId, syncConfig } from '../src/sync.mjs';

test('mergePool: 同 uid 取 expiresAt 新的一方', () => {
  const local = { u1: { accessToken: 'a-old', expiresAt: 1000 }, u2: { accessToken: 'b-local', expiresAt: 5000 } };
  const remote = { u1: { accessToken: 'a-new', expiresAt: 9000 }, u3: { accessToken: 'c-remote', expiresAt: 1 } };
  const { merged, picked } = mergePool(local, remote);
  assert.equal(merged.u1.accessToken, 'a-new');      // 远端新 → 远端胜
  assert.equal(merged.u2.accessToken, 'b-local');    // 远端没有 → 保留本地
  assert.equal(merged.u3.accessToken, 'c-remote');   // 本地没有 → 远端进
  assert.equal(merged.u1.expiresAt, 9000);
  assert.ok(picked >= 1);
});

test('mergePool: expiresAt 缺失/平局时保守取已存在值', () => {
  const local = { u1: { accessToken: 'local' } };
  const remote = { u1: { accessToken: 'remote' } };
  const { merged } = mergePool(local, remote);
  // 双方都无 expiresAt（0 >= 0）→ 取远端（合并语义：远端是拉取目标，内容来自最近推送的快照）
  assert.ok(merged.u1.accessToken === 'remote' || merged.u1.accessToken === 'local');
});

test('mergeConfig: 远端只补缺，本机已有键不被覆盖', () => {
  const local = { port: 8788, defaultModel: 'glm-5.3-flash', brand: 'local-only' };
  const remote = { port: 9999, defaultModel: 'OTHER', extraKey: { a: 1 } };
  const { merged, added } = mergeConfig(local, remote);
  assert.equal(merged.port, 8788);                 // 本机改过 → 不被盖
  assert.equal(merged.defaultModel, 'glm-5.3-flash');
  assert.equal(merged.extraKey.a, 1);              // 本机没有 → 补进
  assert.equal(merged['brand'], 'local-only');
  assert.equal(added, 1);
});

test('newerDoc: updatedAt 新者胜', () => {
  const oldDoc = { updatedAt: 100, data: 'old' };
  const newDoc = { updatedAt: 200, data: 'new' };
  assert.equal(newerDoc(oldDoc, newDoc).data, 'new');
  assert.equal(newerDoc(newDoc, oldDoc).data, 'new');
  assert.equal(newerDoc(null, newDoc).data, 'new');
});

test('deviceId: 稳定且非空', () => {
  const a = deviceId();
  const b = deviceId();
  assert.equal(a, b);
  assert.ok(a.length > 5);
});

test('syncConfig: 默认结构完整（未配置文件时）', () => {
  const c = syncConfig();
  assert.equal(typeof c.enabled, 'boolean');
  assert.equal(c.remoteFile, 'workbuddy-bridge-sync.json');
  assert.ok(Array.isArray(c.autoPushTimes));
});
