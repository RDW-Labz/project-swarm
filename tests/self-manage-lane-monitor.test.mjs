// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LANE_MONITOR_INTERVAL_MS,
  createLaneMonitor,
  createProbeFetch,
  discoverLanes,
  isStale,
  probeLane,
} from '../tools/self-manage/lane-monitor.mjs';

const okProbe = () => ({ ok: true });

test('discoverLanes merges config.lanes and localEndpoints for the same id', () => {
  const lanes = discoverLanes({
    config: {
      lanes: { cursor: { cli: 'cursor-agent' } },
      localEndpoints: { cursor: { url: 'http://127.0.0.1:9' } },
    },
  });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].id, 'cursor');
  assert.equal(lanes[0].cli, 'cursor-agent');
  assert.equal(lanes[0].endpoint, 'http://127.0.0.1:9');
  assert.match(lanes[0].source, /config\.lanes/);
  assert.match(lanes[0].source, /config\.localEndpoints/);
});

test('missing spend-cap or rate-limit probe pauses the lane', async () => {
  const reachOnly = {
    reachable: okProbe,
    spendCap: undefined,
    rateLimit: okProbe,
  };
  const paused = await probeLane({ id: 'a' }, reachOnly);
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /spend-cap/);

  const healthy = await probeLane({ id: 'b' }, {
    reachable: okProbe,
    spendCap: okProbe,
    rateLimit: okProbe,
    modelsList: okProbe,
  });
  assert.equal(healthy.status, 'healthy');
});

test('spend-cap probe throw pauses the lane', async () => {
  const entry = await probeLane({ id: 'x' }, {
    spendCap: () => { throw new Error('boom'); },
    rateLimit: okProbe,
    reachable: okProbe,
  });
  assert.equal(entry.status, 'paused');
});

test('probe timeout pauses policy probes', async () => {
  const hang = (_lane, { signal }) => new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const entry = await probeLane({ id: 'slow' }, {
    spendCap: hang,
    rateLimit: okProbe,
  }, { probeTimeoutMs: 30 });
  assert.equal(entry.status, 'paused');
  assert.match(entry.reason, /timeout/i);
});

test('noCap lane skips spend-cap and can be healthy', async () => {
  const entry = await probeLane({ id: 'local', noCap: true }, {
    rateLimit: okProbe,
    reachable: okProbe,
    modelsList: okProbe,
  });
  assert.equal(entry.status, 'healthy');
});

test('discoverLanes passes noCap from lane config', () => {
  const lanes = discoverLanes({
    config: { lanes: { local: { noCap: true } } },
  });
  assert.equal(lanes[0].noCap, true);
});

test('reasons redact sensitive fragments', async () => {
  const prefix = 'sk-';
  const suffix = 'abc123';
  const entry = await probeLane({ id: 'r' }, {
    spendCap: () => ({ ok: false, reason: `failed ${prefix}${suffix}` }),
    rateLimit: okProbe,
  });
  assert.equal(entry.status, 'paused');
  assert.doesNotMatch(entry.reason, /abc123/);
  assert.match(entry.reason, /\[redacted\]/);
});

test('createProbeFetch allows GET and rejects other methods', async () => {
  const probeFetch = createProbeFetch(async (url, options) => ({ url, method: options.method }));
  const res = await probeFetch('http://example.test', { method: 'GET' });
  assert.equal(res.method, 'GET');
  await assert.rejects(
    () => probeFetch('http://example.test', { method: 'POST' }),
    /probe-method-not-allowed/,
  );
});

test('createProbeFetch forwards abort signal to fetch', async () => {
  const controller = new AbortController();
  const probeFetch = createProbeFetch(async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    return { ok: true };
  });
  await probeFetch('http://example.test', { signal: controller.signal });
});

test('isStale when lastChecked is older than twice the interval', () => {
  const now = 1_000_000;
  const fresh = { lastChecked: new Date(now - LANE_MONITOR_INTERVAL_MS).toISOString() };
  const stale = { lastChecked: new Date(now - LANE_MONITOR_INTERVAL_MS * 2 - 1).toISOString() };
  assert.equal(isStale(fresh, now, LANE_MONITOR_INTERVAL_MS), false);
  assert.equal(isStale(stale, now, LANE_MONITOR_INTERVAL_MS), true);
});

test('createLaneMonitor probes lanes in parallel and does not stack ticks', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slowProbe = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 40));
    inFlight -= 1;
    return { ok: true };
  };
  const monitor = createLaneMonitor({
    loadConfig: async () => ({
      lanes: { a: {}, b: {}, c: {} },
    }),
    probes: {
      spendCap: okProbe,
      rateLimit: okProbe,
      reachable: slowProbe,
      modelsList: okProbe,
    },
    probeTimeoutMs: 5000,
    intervalMs: 60_000,
  });
  await monitor.tick();
  assert.equal(maxInFlight >= 2, true, 'lanes should be probed concurrently');

  let reachCalls = 0;
  const gate = createLaneMonitor({
    loadConfig: async () => ({ lanes: { only: {} } }),
    probes: {
      spendCap: okProbe,
      rateLimit: okProbe,
      reachable: async () => {
        reachCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 50));
        return { ok: true };
      },
      modelsList: okProbe,
    },
  });
  const first = gate.tick();
  assert.equal(gate.running, true);
  const second = gate.tick();
  const [snapEarly, snapDone] = await Promise.all([second, first]);
  assert.equal(snapEarly.lanes.length, 0);
  assert.equal(snapDone.lanes.length, 1);
  assert.equal(reachCalls, 1);
});

test('started reflects timer; running reflects in-flight tick', async () => {
  const monitor = createLaneMonitor({
    loadConfig: async () => ({ lanes: {} }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  assert.equal(monitor.started, false);
  assert.equal(monitor.running, false);
  monitor.start();
  assert.equal(monitor.started, true);
  assert.equal(monitor.running, false);
  monitor.stop();
  assert.equal(monitor.started, false);
});
