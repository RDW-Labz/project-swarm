// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  acquirePendingSlot,
  machineBusySnapshot,
  waitForMachineIdleWhilePending,
} from '../tools/update-pending.mjs';
import { createDescribeUpdateBusy } from '../tools/swarm/core-52.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-r4-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('(1) held autopilot pid is not counted busy and idle wait succeeds', async t => {
  const installRoot = await tempDir(t);
  const autopilotPid = 77_001;
  const pendingRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    heldPids: [autopilotPid],
  };
  await acquirePendingSlot(installRoot, pendingRecord);

  const describeBusy = createDescribeUpdateBusy({
    boardSummary: async () => ({
      runs: [{
        runId: 'run-held',
        root: installRoot,
        pid: autopilotPid,
        command: `swarm autopilot ${autopilotPid}`,
        jobs: [{ status: 'running' }],
      }],
    }),
    runningSwarmCommands: () => [],
    liveBusyMarkers: async () => [],
    installDirs: [installRoot],
  });

  const withoutHeld = await describeBusy({ excludePids: [process.pid] });
  assert.equal(withoutHeld.busy, true);

  const withHeld = await describeBusy({ excludePids: [process.pid, autopilotPid], heldPids: [autopilotPid] });
  assert.equal(withHeld.busy, false);

  const wait = await waitForMachineIdleWhilePending(installRoot, {
    pendingRecord,
    describeBusy,
    sleep: async () => {},
    timeoutMinutes: 60,
  });
  assert.equal(wait.timedOut, false);
  assert.equal(wait.snapshot.busy, false);
});

test('(2) runWhenIdleUpdate passes heldPids through describeBusy to machineBusySnapshot', async t => {
  const installRoot = await tempDir(t);
  const heldPid = 77_002;
  let snapshotHeld = null;
  const describeBusy = createDescribeUpdateBusy({
    boardSummary: async () => ({
      runs: [{
        runId: 'go-loop',
        root: installRoot,
        orchestratorPid: heldPid,
        command: 'swarm go',
        jobs: [{ status: 'queued' }],
      }],
    }),
    runningSwarmCommands: () => [{ pid: heldPid, command: 'node swarm.mjs go' }],
    liveBusyMarkers: async () => [],
    installDirs: [installRoot],
  });
  const wrappedDescribe = opts => {
    snapshotHeld = opts.heldPids;
    return describeBusy(opts);
  };

  await registerHeldAndWait(installRoot, heldPid, wrappedDescribe);
  assert.ok(Array.isArray(snapshotHeld));
  assert.ok(snapshotHeld.includes(heldPid));
});

async function registerHeldAndWait(installRoot, heldPid, describeBusy) {
  const pendingRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    heldPids: [heldPid],
  };
  const acquired = await acquirePendingSlot(installRoot, pendingRecord);
  assert.equal(acquired.ok, true);
  const wait = await waitForMachineIdleWhilePending(installRoot, {
    pendingRecord: { ...pendingRecord, heldPids: [heldPid] },
    describeBusy,
    sleep: async () => {},
    timeoutMinutes: 60,
  });
  assert.equal(wait.timedOut, false);
}

test('(3) machineBusySnapshot ignores held ancestor processes', async () => {
  const held = new Set([50_001]);
  const snapshot = await machineBusySnapshot({
    boardSummary: async () => ({ runs: [] }),
    runningSwarmCommands: () => [{ pid: 50_002, command: 'child' }],
    liveBusyMarkers: async () => [],
    installDirs: [],
    heldPids: [...held],
    parentOf: pid => (pid === 50_002 ? 50_001 : null),
  });
  assert.equal(snapshot.busy, false);
});
