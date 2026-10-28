import './_isolate-config.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLaneHealthMonitor } from '../tools/lane-health.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// Hold each state write after serialization, before the atomic rename.
function slowFs() {
  const writes = [];
  const landed = [];
  const waiters = [];
  const files = new Map();
  return {
    writes,
    landed,
    async started(index) {
      while (!writes[index]) {
        const ready = deferred();
        waiters.push(ready.resolve);
        await ready.promise;
      }
      return writes[index];
    },
    fs: {
      async mkdir() {},
      async chmod() {},
      async stat() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      async open(file) {
        return {
          async writeFile(data) {
            files.set(file, data);
            if (!file.endsWith('.tmp')) return;
            const gate = deferred();
            writes.push({ data: JSON.parse(data), release: gate.resolve });
            waiters.splice(0).forEach(resolve => resolve());
            await gate.promise;
          },
          async chmod() {},
          async close() {},
        };
      },
      async rename(from, to) {
        const data = files.get(from);
        files.set(to, data);
        files.delete(from);
        landed.push(JSON.parse(data));
      },
    },
  };
}

function monitorWith(disk, options = {}) {
  return createLaneHealthMonitor({
    home: '/fake-home',
    env: { PROJECT_SWARM_HOME: '/fake-home/swarm' },
    fs: disk.fs,
    adapters: [],
    now: () => 1000,
    ...options,
  });
}

test('overlapping persists run in order and queued writes use the latest state', async () => {
  const disk = slowFs();
  const monitor = monitorWith(disk);
  monitor.recordJobResult('lane', true, { jobId: 'old' });
  const first = await disk.started(0);
  monitor.recordJobResult('lane', false, { jobId: 'middle' });
  monitor.recordJobResult('lane', true, { jobId: 'newest' });
  await nextTurn();
  assert.equal(disk.writes.length, 1);
  first.release();
  const second = await disk.started(1);
  assert.equal(second.data.lanes.lane.lastJobId, 'newest');
  second.release();
  const third = await disk.started(2);
  assert.equal(third.data.lanes.lane.lastJobId, 'newest');
  third.release();
  await monitor.stop();
  assert.deepEqual(disk.landed.map(data => data.lanes.lane.lastJobId), ['old', 'newest', 'newest']);
});

test('flush waits for an in-flight write', async () => {
  const disk = slowFs();
  const monitor = monitorWith(disk);
  monitor.recordJobResult('lane', true);
  const write = await disk.started(0);
  let flushed = false;
  const flushing = monitor.flush().then(() => { flushed = true; });
  await nextTurn();
  assert.equal(flushed, false);
  assert.equal(disk.landed.length, 0);
  write.release();
  await flushing;
  assert.equal(disk.landed.length, 1);
  await monitor.stop();
});

test('a persist failure is swallowed and does not block the next write', async () => {
  const disk = slowFs();
  const open = disk.fs.open;
  let fail = true;
  disk.fs.open = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error('injected write failure');
    }
    return open(...args);
  };
  const monitor = monitorWith(disk);
  monitor.recordJobResult('lane', false, { jobId: 'failed' });
  await monitor.flush();
  monitor.recordJobResult('lane', true, { jobId: 'saved' });
  const write = await disk.started(0);
  write.release();
  await monitor.stop();
  assert.equal(disk.landed.length, 1);
  assert.equal(disk.landed[0].lanes.lane.lastJobId, 'saved');
});

test('stop drains queued writes and prevents writes after it resolves', async () => {
  const disk = slowFs();
  const monitor = monitorWith(disk);
  monitor.recordJobResult('lane', true);
  const first = await disk.started(0);
  monitor.recordJobResult('lane', false);
  let stopped = false;
  const stopping = monitor.stop().then(() => { stopped = true; });
  await nextTurn();
  assert.equal(stopped, false);
  first.release();
  const second = await disk.started(1);
  await nextTurn();
  assert.equal(stopped, false);
  second.release();
  await stopping;
  assert.equal(disk.landed.length, 2);
  monitor.recordJobResult('lane', true);
  await monitor.tick();
  await monitor.stop();
  await nextTurn();
  assert.equal(disk.writes.length, 2);
  assert.equal(disk.landed.length, 2);
});

test('stop waits for an active tick and its persistence', async () => {
  const disk = slowFs();
  const probe = deferred();
  const entered = deferred();
  const monitor = monitorWith(disk, {
    config: { lanes: { lane: { baseUrl: 'http://localhost:1234/v1' } } },
    fetch: async () => {
      entered.resolve();
      await probe.promise;
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    },
  });
  const ticking = monitor.tick();
  await entered.promise;
  let stopped = false;
  const stopping = monitor.stop().then(() => { stopped = true; });
  await nextTurn();
  assert.equal(stopped, false);
  probe.resolve();
  const write = await disk.started(0);
  assert.equal(stopped, false);
  write.release();
  await Promise.all([stopping, ticking]);
  await nextTurn();
  assert.equal(disk.writes.length, 1);
  assert.equal(disk.landed.length, 1);
});
