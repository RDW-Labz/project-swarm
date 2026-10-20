// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLanes, LaneScheduler } from '../tools/lanes.mjs';

function timeoutResourceCount() {
  return process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
}

test('abort during suspended pumpShared does not orphan a wake timer', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lanes-timer-leak-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const baseline = timeoutResourceCount();
  let time = 1_700_000_000_000;
  const lanes = resolveLanes({ manifest: { lanes: { hermes: { concurrency: 2, backoff: { baseMs: 50, maxMs: 50, maxRetries: 5 } } } } });
  const scheduler = new LaneScheduler({
    lanes,
    globalConcurrency: 4,
    now: () => time,
    shared: { dir, runId: 'leak-test' },
  });

  let releaseFlush;
  const flushGate = new Promise(resolve => { releaseFlush = resolve; });
  const baseFlush = scheduler.flushReleases.bind(scheduler);
  scheduler.flushReleases = async () => {
    await flushGate;
    return baseFlush();
  };

  const pending = scheduler.acquire('hermes');
  await new Promise(resolve => setImmediate(resolve));

  await scheduler.report('hermes', { kind: 'rate-limited', retryAfterMs: 50, resetsAt: null });

  const controller = new AbortController();
  const aborted = scheduler.acquire('hermes', { signal: controller.signal });
  const rejected = assert.rejects(aborted, { name: 'AbortError' });
  controller.abort();
  await rejected;

  releaseFlush();
  await scheduler.sharedChain;
  await scheduler.close();
  await assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(timeoutResourceCount(), baseline, 'no orphaned Timeout handles after close');
  time += 200;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timeoutResourceCount(), baseline, 'backoff wake timer did not remain after close');
});

test('two consecutive scheduleShared calls retain one refill timer', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lanes-timer-refill-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let time = 0;
  const live = new Set();
  const scheduler = new LaneScheduler({
    lanes: resolveLanes({ manifest: { lanes: { hermes: { concurrency: 1 } } } }),
    globalConcurrency: 2,
    now: () => time,
    shared: { dir, runId: 'refill' },
    setTimer: (fn, delay) => {
      const id = setTimeout(fn, delay);
      live.add(id);
      return id;
    },
    clearTimer: id => {
      live.delete(id);
      clearTimeout(id);
    },
  });
  t.after(() => scheduler.close());

  scheduler.scheduleShared();
  scheduler.scheduleShared();
  assert.equal(live.size, 1, 'only one refill timer is scheduled');
  assert.equal(scheduler.refillTimer !== null, true);
});

test('scheduleShared after close does not schedule a timer', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lanes-timer-closed-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let time = 0;
  const live = new Set();
  const scheduler = new LaneScheduler({
    lanes: resolveLanes(),
    globalConcurrency: 2,
    now: () => time,
    shared: { dir, runId: 'closed' },
    setTimer: (fn, delay) => {
      const id = setTimeout(fn, delay);
      live.add(id);
      return id;
    },
    clearTimer: id => {
      live.delete(id);
      clearTimeout(id);
    },
  });

  await scheduler.close();
  scheduler.scheduleShared();
  assert.equal(live.size, 0);
  assert.equal(scheduler.refillTimer, null);
});
