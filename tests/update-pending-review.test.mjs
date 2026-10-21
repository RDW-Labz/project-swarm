// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  acquirePendingSlot,
  machineBusySnapshot,
  pendingPath,
  readLivePending,
  registerHeldLauncher,
  runWhenIdleUpdate,
  waitForMachineIdleWhilePending,
  writePendingRecord,
} from '../tools/update-pending.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('(5a) corrupt pending record is removed with warning, not thrown', async t => {
  const installRoot = await tempDir(t);
  await fs.writeFile(pendingPath(installRoot), '{not-json', { mode: 0o600 });
  const warnings = [];
  const record = await readLivePending(installRoot, { warn: msg => warnings.push(msg) });
  assert.equal(record, null);
  assert.match(warnings.join(''), /corrupt/i);
});

test('(5b) held launcher registration is serialized and not lost', async t => {
  const installRoot = await tempDir(t);
  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    heldPids: [],
  });
  await Promise.all([
    registerHeldLauncher(installRoot, 101),
    registerHeldLauncher(installRoot, 102),
    registerHeldLauncher(installRoot, 103),
  ]);
  const raw = JSON.parse(await fs.readFile(pendingPath(installRoot), 'utf8'));
  assert.deepEqual(new Set(raw.heldPids), new Set([101, 102, 103]));
});

test('(5c) busy marker for held launcher is ignored', async () => {
  const held = new Set([55]);
  const snapshot = await machineBusySnapshot({
    boardSummary: async () => ({ runs: [] }),
    runningSwarmCommands: () => [],
    liveBusyMarkers: async () => [{ pid: 55, command: 'swarm go --scope x', root: '/tmp' }],
    heldPids: [...held],
    parentOf: () => null,
  });
  assert.equal(snapshot.busy, false);
});

test('(5d) marker that only waits for update is ignored', async () => {
  const snapshot = await machineBusySnapshot({
    boardSummary: async () => ({ runs: [] }),
    runningSwarmCommands: () => [],
    liveBusyMarkers: async () => [{ pid: 77, command: 'waiting for swarm update', root: '/tmp' }],
    heldPids: [],
  });
  assert.equal(snapshot.busy, false);
});

test('(5e) held wave/autopilot run is not counted busy', async () => {
  const snapshot = await machineBusySnapshot({
    boardSummary: async () => ({ runs: [{ runId: 'r1', jobs: [], root: '/tmp', pid: 88, command: 'swarm go wave' }] }),
    runningSwarmCommands: () => [],
    liveBusyMarkers: async () => [],
    heldPids: [88],
  });
  assert.equal(snapshot.busy, false);
});

test('(5f) pending expiry is refreshed while waiting for idle', async t => {
  const installRoot = await tempDir(t);
  const startedAt = new Date().toISOString();
  const initialExpires = new Date(Date.now() + 5_000).toISOString();
  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt,
    expiresAt: initialExpires,
    heldPids: [],
  });
  let polls = 0;
  const waiter = waitForMachineIdleWhilePending(installRoot, {
    pendingRecord: { pid: process.pid, startedAt, expiresAt: initialExpires, heldPids: [] },
    timeoutMinutes: 5,
    describeBusy: async () => {
      polls += 1;
      if (polls >= 2) return { busy: false, liveRuns: [], processes: [], markers: [] };
      return { busy: true, liveRuns: [], processes: [], markers: [{ pid: 1, command: 'swarm run', root: '/tmp' }] };
    },
    sleep: async () => {},
    env: { SWARM_UPDATE_PENDING_POLL_MS: '1', SWARM_UPDATE_PENDING_STATUS_MS: '1000' },
  });
  await waiter;
  const fresh = JSON.parse(await fs.readFile(pendingPath(installRoot), 'utf8'));
  assert.ok(Date.parse(fresh.expiresAt) > Date.parse(initialExpires));
});

test('(5g) acquirePendingSlot uses exclusive create', async t => {
  const installRoot = await tempDir(t);
  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    heldPids: [],
  };
  const first = await acquirePendingSlot(installRoot, record);
  assert.equal(first.ok, true);
  const second = await acquirePendingSlot(installRoot, {
    ...record,
    pid: process.pid + 1,
  });
  assert.equal(second.ok, false);
});

test('(5h) SIGTERM removes pending record during when-idle update', async t => {
  const installRoot = await tempDir(t);
  const modulePath = path.join(HERE, '..', 'tools', 'update-pending.mjs');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runWhenIdleUpdate } from ${JSON.stringify(modulePath)};
    await runWhenIdleUpdate({
      installRoot: ${JSON.stringify(installRoot)},
      timeoutMinutes: 5,
      performUpdate: async () => ({}),
      describeBusy: async () => ({ busy: true, liveRuns: [], processes: [], markers: [{ pid: 1, command: 'busy', root: '/tmp' }] }),
      sleep: async () => {},
      env: { SWARM_UPDATE_PENDING_POLL_MS: '20' },
    });
  `], { stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 80));
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  const pending = await readLivePending(installRoot);
  assert.equal(pending, null);
});
