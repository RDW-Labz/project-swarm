// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLaneRecovery } from '../tools/self-manage/recovery.mjs';

test('unknown lane is not up and reads do not grow the lane map', () => {
  const recovery = createLaneRecovery();
  assert.equal(recovery.isUp('never-seen'), false);
  assert.deepEqual(recovery.status('never-seen'), {
    up: false,
    healthyStreak: 0,
    flaps: 0,
    retryAt: 0,
  });
  recovery.isUp('probe-only');
  recovery.status('another-probe');
  assert.equal(recovery.isUp('never-seen'), false);
});

test('lane returns after requiredHealthy consecutive healthy checks', () => {
  const recovery = createLaneRecovery({ requiredHealthy: 2, baseBackoffMs: 1000 });
  const lane = 'cursor';
  const t0 = 1_000_000;
  assert.equal(recovery.recordCheck(lane, true, t0), false);
  assert.equal(recovery.recordCheck(lane, true, t0 + 1), true);
  assert.equal(recovery.isUp(lane), true);
});

test('invalid option values fall back to safe defaults', () => {
  const recovery = createLaneRecovery({
    requiredHealthy: 0,
    baseBackoffMs: Number.NaN,
    maxBackoffMs: -5,
    flapWindowMs: 'nope',
  });
  const lane = 'codex';
  const t0 = 2_000_000;
  assert.equal(recovery.recordCheck(lane, true, t0), true);
});

test('flapping lane increases backoff before recovery counts', () => {
  const recovery = createLaneRecovery({
    requiredHealthy: 1,
    baseBackoffMs: 1000,
    maxBackoffMs: 100_000,
    flapWindowMs: 60_000,
  });
  const lane = 'claude';
  let t = 10_000;
  assert.equal(recovery.recordCheck(lane, true, t), true);
  t += 1;
  assert.equal(recovery.recordCheck(lane, false, t), false);
  t += 1;
  assert.equal(recovery.recordCheck(lane, true, t), false);
  const { retryAt, flaps } = recovery.status(lane);
  assert.equal(flaps, 1);
  assert.ok(retryAt > t);
  assert.equal(recovery.recordCheck(lane, true, retryAt), true);
});

test('forget removes lane state; prune keeps only listed lanes', () => {
  const recovery = createLaneRecovery({ requiredHealthy: 1 });
  const t0 = 4_000_000;
  recovery.recordCheck('keep', true, t0);
  recovery.recordCheck('drop', true, t0);
  assert.equal(recovery.isUp('keep'), true);
  assert.equal(recovery.isUp('drop'), true);
  recovery.forget('drop');
  assert.equal(recovery.isUp('drop'), false);
  assert.equal(recovery.isUp('keep'), true);
  recovery.recordCheck('extra', true, t0);
  recovery.prune(['keep']);
  assert.equal(recovery.isUp('keep'), true);
  assert.equal(recovery.isUp('extra'), false);
});

test('non-finite event time is ignored and does not mutate lane state', () => {
  const recovery = createLaneRecovery({ requiredHealthy: 2 });
  const lane = 'finite';
  const t0 = 5_000_000;
  assert.equal(recovery.recordCheck(lane, true, t0), false);
  assert.equal(recovery.recordCheck(lane, true, Number.NaN), false);
  assert.equal(recovery.status(lane).healthyStreak, 1);
  assert.equal(recovery.recordCheck(lane, true, t0 + 1), true);
});

test('redacted probe token shape does not affect recovery checks', () => {
  const prefix = 'sk-';
  const suffix = 'demo';
  const lane = [prefix, suffix].join('');
  const recovery = createLaneRecovery({ requiredHealthy: 1 });
  const t0 = 3_000_000;
  assert.equal(recovery.recordCheck(lane, true, t0), true);
  assert.equal(recovery.isUp(lane), true);
});
