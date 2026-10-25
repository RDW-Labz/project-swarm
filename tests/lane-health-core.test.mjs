// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  discoverLanes,
  defaultLaneHealth,
  registerLaneAdapter,
  validateLaneAdapter,
  listLaneAdapters,
} from '../tools/lane-adapters.mjs';
import {
  createLaneHealthMonitor,
  laneRoutable,
  readLaneHealth,
  laneHealthStatePath,
} from '../tools/lane-health.mjs';

const TIER_HALF = 15 * 60 * 1000;

function fakeFetch(allowed = 'GET') {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    if (method !== allowed) {
      throw new Error(`fetch method ${method} not allowed`);
    }
    calls.push({ url, method });
    return { ok: true, status: 200, body: { cancel: async () => {} } };
  };
  return { impl, calls };
}

test('discoverLanes: config keys, local endpoints, and adapters (no hardcoded list)', () => {
  registerLaneAdapter({
    name: 'test-adapter-discover',
    kind: 'test',
    health: async () => ({ state: 'healthy', reason: 'ok' }),
  });
  const config = {
    lanes: {
      customLaneX: { command: 'echo' },
      local: { endpoints: [{ name: 'gpu1', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm' }] },
    },
  };
  const found = discoverLanes({ config, adapters: listLaneAdapters() });
  assert.ok(found.includes('customLaneX'));
  assert.ok(found.includes('local:gpu1'));
  assert.ok(found.includes('test-adapter-discover'));
  assert.ok(!found.includes('hermes'));
});

test('discoverLanes: removed lane prunes state and emits pruned', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'lh-prune-'));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps') };
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let tNow = 1_000_000;
  const events = [];
  const { impl } = fakeFetch();
  const config = { lanes: { vanishOnly: { baseUrl: 'http://127.0.0.1:8080/v1' } } };
  const monitor = createLaneHealthMonitor({
    home,
    env,
    config,
    now: () => tNow,
    emit: e => events.push(e),
    fetch: impl,
    exec: async () => {},
  });
  await monitor.tick();
  assert.ok(monitor.snapshot().lanes.vanishOnly);
  config.lanes = {};
  await monitor.tick();
  assert.equal(monitor.snapshot().lanes.vanishOnly, undefined);
  assert.ok(events.some(e => e.type === 'pruned' && e.lane === 'vanishOnly'));
});

test('validateLaneAdapter rejects missing health', () => {
  const problems = validateLaneAdapter({ name: 'n', kind: 'k' });
  assert.ok(problems.some(p => /health/.test(p)));
  assert.throws(() => registerLaneAdapter({ name: 'bad', kind: 'k' }), /lane-adapter-invalid/);
});

test('defaultLaneHealth: paused without endpoint or command', async () => {
  const r = await defaultLaneHealth({ lane: 'orphan', config: { lanes: { orphan: {} } } });
  assert.equal(r.state, 'paused');
  assert.match(r.reason, /no health check configured/);
});

test('defaultLaneHealth: reachable baseUrl and job failure streak', async () => {
  const { impl } = fakeFetch();
  const base = await defaultLaneHealth({
    lane: 'ep',
    config: { lanes: { ep: { baseUrl: 'http://127.0.0.1:9000/v1' } } },
    fetch: impl,
  });
  assert.equal(base.state, 'healthy');
  const deg = await defaultLaneHealth({
    lane: 'ep',
    config: { lanes: { ep: { baseUrl: 'http://127.0.0.1:9000/v1' } } },
    fetch: impl,
    lastResult: { ok: false },
  });
  assert.equal(deg.state, 'degraded');
  const down = await defaultLaneHealth({
    lane: 'ep',
    config: { lanes: { ep: { baseUrl: 'http://127.0.0.1:9000/v1' } } },
    fetch: impl,
    lastResult: { ok: false, consecutiveBad: 2 },
  });
  assert.equal(down.state, 'down');
});

test('defaultLaneHealth: CLI --version via exec', async () => {
  const r = await defaultLaneHealth({
    lane: 'cli',
    config: { lanes: { cli: { command: '/bin/echo' } } },
    exec: async (cmd, args) => {
      assert.equal(cmd, '/bin/echo');
      assert.deepEqual(args, ['--version']);
    },
  });
  assert.equal(r.state, 'healthy');
});

test('monitor: down then two ok checks returns healthy', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'lh-recover-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let probe = 'down';
  registerLaneAdapter({
    name: 'recoverLane',
    kind: 'test',
    health: async () => ({ state: probe, reason: probe }),
  });
  const monitor = createLaneHealthMonitor({
    home,
    env: { PROJECT_SWARM_HOME: path.join(home, 'ps') },
    config: { lanes: {} },
    adapters: listLaneAdapters(),
    now: () => 5_000_000,
    fetch: fakeFetch().impl,
  });
  await monitor.tick();
  assert.equal(monitor.snapshot().lanes.recoverLane.state, 'down');
  probe = 'healthy';
  await monitor.tick();
  assert.equal(monitor.snapshot().lanes.recoverLane.state, 'degraded');
  await monitor.tick();
  assert.equal(monitor.snapshot().lanes.recoverLane.state, 'healthy');
});

test('monitor: flapping increases required ok streak', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'lh-flap-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let tNow = 10_000_000;
  let flip = 0;
  registerLaneAdapter({
    name: 'flapLane',
    kind: 'test',
    health: async () => {
      flip += 1;
      return flip % 2 === 1
        ? { state: 'down', reason: 'down' }
        : { state: 'healthy', reason: 'ok' };
    },
  });
  const monitor = createLaneHealthMonitor({
    home,
    env: { PROJECT_SWARM_HOME: path.join(home, 'ps') },
    config: { lanes: {} },
    adapters: listLaneAdapters(),
    now: () => tNow,
    fetch: fakeFetch().impl,
  });
  for (let i = 0; i < 6; i += 1) {
    tNow += 60_000;
    await monitor.tick();
  }
  const entry = monitor.snapshot().lanes.flapLane;
  assert.ok(entry.flaps.length >= 3);
  assert.ok(entry.requiredOkStreak > 2);
});

test('monitor: probation then full routability after 3 checks and 2 jobs', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'lh-prob-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  registerLaneAdapter({
    name: 'probLane',
    kind: 'test',
    health: async () => ({ state: 'healthy', reason: 'ok' }),
  });
  const monitor = createLaneHealthMonitor({
    home,
    env: { PROJECT_SWARM_HOME: path.join(home, 'ps') },
    config: { lanes: {} },
    adapters: listLaneAdapters(),
    now: () => 20_000_000,
    fetch: fakeFetch().impl,
  });
  await monitor.tick();
  let snap = monitor.snapshot();
  assert.ok(snap.lanes.probLane.probation.active);
  assert.equal(laneRoutable(snap, 'probLane', { size: 'large' }).ok, false);
  assert.equal(laneRoutable(snap, 'probLane', { size: 'small' }).ok, true);
  await monitor.tick();
  await monitor.tick();
  monitor.recordJobResult('probLane', true, { jobId: 'j1' });
  monitor.recordJobResult('probLane', true, { jobId: 'j2' });
  snap = monitor.snapshot();
  assert.equal(snap.lanes.probLane.probation.active, false);
  assert.equal(laneRoutable(snap, 'probLane', { size: 'large' }).ok, true);
});

test('monitor: all cheap tier down 30 minutes emits needs-you once', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'lh-tier-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let tNow = 30_000_000;
  for (const name of ['cursor', 'anthropic', 'openrouter']) {
    registerLaneAdapter({
      name,
      kind: 'test',
      health: async () => ({ state: 'down', reason: 'down' }),
    });
  }
  const needs = [];
  const monitor = createLaneHealthMonitor({
    home,
    env: { PROJECT_SWARM_HOME: path.join(home, 'ps') },
    config: { lanes: { cursor: {}, anthropic: {}, openrouter: {} } },
    adapters: listLaneAdapters(),
    now: () => tNow,
    emit: e => { if (e.type === 'needs-you') needs.push(e); },
    fetch: fakeFetch().impl,
  });
  await monitor.tick();
  tNow += TIER_HALF;
  await monitor.tick();
  assert.equal(needs.length, 0);
  tNow += TIER_HALF + 1;
  await monitor.tick();
  assert.equal(needs.length, 1);
  await monitor.tick();
  assert.equal(needs.length, 1);
});

test('state file is mode 0600 and written atomically', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'lh-persist-'));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps') };
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  registerLaneAdapter({
    name: 'persistLane',
    kind: 'test',
    health: async () => ({ state: 'healthy', reason: 'ok' }),
  });
  const monitor = createLaneHealthMonitor({
    home,
    env,
    config: { lanes: {} },
    adapters: listLaneAdapters(),
    now: () => 40_000_000,
    fetch: fakeFetch().impl,
  });
  await monitor.tick();
  const file = laneHealthStatePath(home, env);
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  const dir = path.dirname(file);
  const names = await fs.readdir(dir);
  assert.ok(!names.some(n => n.includes('.tmp')));
  const disk = await readLaneHealth({ home, env });
  assert.ok(disk.lanes.persistLane);
});

test('injected fetch allows GET only (no POST / model calls)', async t => {
  const { impl, calls } = fakeFetch('GET');
  registerLaneAdapter({
    name: 'getOnlyLane',
    kind: 'test',
    health: async ({ fetch: f }) => {
      await f('http://127.0.0.1/models', { method: 'GET' });
      try {
        await f('http://127.0.0.1/chat/completions', { method: 'POST', body: '{}' });
      } catch {
        /* expected */
      }
      return { state: 'healthy', reason: 'ok' };
    },
  });
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'lh-get-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const monitor = createLaneHealthMonitor({
    home,
    env: { PROJECT_SWARM_HOME: path.join(home, 'ps') },
    config: { lanes: {} },
    adapters: listLaneAdapters(),
    now: () => 50_000_000,
    fetch: impl,
  });
  await monitor.tick();
  assert.ok(calls.every(c => c.method === 'GET'));
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});
