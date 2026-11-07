// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeBusyMarker } from '../tools/busy-marker.mjs';
import {
  PENDING_BASENAME,
  WHEN_IDLE_TRY_AGAIN_EXIT,
  acquirePendingSlot,
  pendingPath,
  readLivePending,
  removePendingRecord,
  runWhenIdleUpdate,
  waitBeforeLaunchingWork,
  writePendingRecord,
} from '../tools/update-pending.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swarmPath = path.join(packageRoot, 'tools/swarm.mjs');
const execFileAsync = promisify(execFile);

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-when-idle-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
}

async function holdingPid(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGTERM'); });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child.pid;
}

function swarmEnv({ busyDir, home, installRoot, extra = {} }) {
  return {
    ...process.env,
    HOME: home,
    SWARM_BUSY_DIR: busyDir,
    SWARM_INSTALL_ROOT: installRoot,
    SWARM_UPDATE_PENDING_POLL_MS: '20',
    SWARM_UPDATE_PENDING_STATUS_MS: '40',
    ...extra,
  };
}

test('stale pending record never blocks a launcher or a new acquire', async t => {
  const installRoot = await tempDir(t);
  const deadPid = 999_999;
  await writePendingRecord(installRoot, {
    pid: deadPid,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    heldPids: [],
  });
  assert.equal(await readLivePending(installRoot), null);
  const lines = [];
  await waitBeforeLaunchingWork(installRoot, {
    write: text => lines.push(text),
    sleep: async () => {},
  });
  assert.deepEqual(lines, []);
  const acquired = await acquirePendingSlot(installRoot, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    heldPids: [],
  });
  assert.equal(acquired.ok, true);
  await removePendingRecord(installRoot);
});

test('expired pending record is ignored', async t => {
  const installRoot = await tempDir(t);
  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    heldPids: [],
  });
  assert.equal(await readLivePending(installRoot), null);
});

test('held launcher waits while pending exists and continues after', async t => {
  const installRoot = await tempDir(t);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt,
    heldPids: [],
  });
  const lines = [];
  let polls = 0;
  const waiter = waitBeforeLaunchingWork(installRoot, {
    write: text => lines.push(text),
    sleep: async () => { polls += 1; },
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !lines.some(line => line.includes('waiting for swarm update'))) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(lines.some(line => line.includes('waiting for swarm update')));
  await removePendingRecord(installRoot);
  await waiter;
  assert.ok(polls > 0);
});

test('runWhenIdleUpdate removes record on success and failure', async t => {
  const installRoot = await tempDir(t);
  const ok = await runWhenIdleUpdate({
    installRoot,
    timeoutMinutes: 1,
    performUpdate: async () => ({ ok: true }),
    describeBusy: async () => ({ busy: false, liveRuns: [], processes: [], markers: [] }),
    sleep: async () => {},
  });
  assert.equal(ok.status, 'updated');
  assert.equal(await readLivePending(installRoot), null);

  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    heldPids: [],
  });
  await removePendingRecord(installRoot);
  await assert.rejects(() => runWhenIdleUpdate({
    installRoot,
    timeoutMinutes: 1,
    performUpdate: async () => { throw new Error('update-failed'); },
    describeBusy: async () => ({ busy: false, liveRuns: [], processes: [], markers: [] }),
    sleep: async () => {},
  }), /update-failed/);
  assert.equal(await readLivePending(installRoot), null);
});

test('timeout exits 75, names what was live, and releases held launchers', async t => {
  const installRoot = await tempDir(t);
  const busyDir = await tempDir(t);
  const root = await tempDir(t);
  const holderPid = await holdingPid(t);
  const remove = await writeBusyMarker({ command: 'node tools/swarm.mjs go --scope x', root, pid: holderPid, dir: busyDir });
  t.after(() => remove());
  const stderr = [];
  const outcome = await runWhenIdleUpdate({
    installRoot,
    timeoutMinutes: 0.001,
    performUpdate: async () => ({ ok: true }),
    describeBusy: async ({ excludePids = [] } = {}) => {
      const markers = (await import('../tools/busy-marker.mjs')).liveBusyMarkers({ dir: busyDir });
      const list = (await markers).filter(marker => !excludePids.includes(marker.pid));
      return { busy: list.length > 0, liveRuns: [], processes: [], markers: list };
    },
    write: text => stderr.push(text),
    sleep: async () => {},
  });
  assert.equal(outcome.status, 'timeout');
  assert.equal(process.exitCode, WHEN_IDLE_TRY_AGAIN_EXIT);
  process.exitCode = undefined;
  assert.match(stderr.join(''), /never became idle/i);
  assert.match(stderr.join(''), /swarm go/);
  assert.equal(await readLivePending(installRoot), null);

  const heldLines = [];
  const held = waitBeforeLaunchingWork(installRoot, {
    write: text => heldLines.push(text),
    sleep: async () => {},
  });
  await held;
  assert.equal(heldLines.length, 0);
});

test('status lines appear on a long wait', async t => {
  const installRoot = await tempDir(t);
  const stderr = [];
  let polls = 0;
  const updatePromise = runWhenIdleUpdate({
    installRoot,
    timeoutMinutes: 5,
    performUpdate: async () => ({ ok: true }),
    describeBusy: async () => {
      polls += 1;
      if (polls < 3) return { busy: true, liveRuns: [], processes: [], markers: [{ pid: 42, command: 'swarm run', root: '/tmp' }] };
      return { busy: false, liveRuns: [], processes: [], markers: [] };
    },
    write: text => stderr.push(text),
    sleep: async () => {},
    env: { SWARM_UPDATE_PENDING_STATUS_MS: '1', SWARM_UPDATE_PENDING_POLL_MS: '1' },
  });
  const outcome = await updatePromise;
  assert.equal(outcome.status, 'updated');
  assert.match(stderr.join(''), /update-when-idle: waiting for idle/);
});

test('second concurrent when-idle update is refused', async t => {
  const installRoot = await tempDir(t);
  const holderPid = await holdingPid(t);
  const first = await acquirePendingSlot(installRoot, {
    pid: holderPid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    heldPids: [],
  });
  assert.equal(first.ok, true);
  await assert.rejects(() => runWhenIdleUpdate({
    installRoot,
    timeoutMinutes: 1,
    performUpdate: async () => ({}),
    describeBusy: async () => ({ busy: false, liveRuns: [], processes: [], markers: [] }),
    sleep: async () => {},
  }), error => {
    assert.match(error.message, /update-when-idle-refused/);
    assert.match(error.message, new RegExp(`pid ${holderPid}`));
    return true;
  });
  await removePendingRecord(installRoot);
});

test('plain update is still refused while a live busy marker is present', async t => {
  const busyDir = await tempDir(t);
  const home = await tempDir(t);
  const root = await tempDir(t);
  const holderPid = await holdingPid(t);
  const remove = await writeBusyMarker({ command: 'node tools/swarm.mjs go --scope x', root, pid: holderPid, dir: busyDir });
  t.after(() => remove());
  await assert.rejects(
    execFileAsync(process.execPath, [swarmPath, 'update'], {
      cwd: packageRoot,
      env: swarmEnv({ busyDir, home, installRoot: packageRoot }),
      encoding: 'utf8',
    }),
    error => {
      assert.match(error.stderr, /update-refused/);
      return true;
    },
  );
});

test('read-only status is not held while an update is pending', async t => {
  const installRoot = await tempDir(t);
  const home = await tempDir(t);
  const busyDir = await tempDir(t);
  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    heldPids: [],
  });
  const project = await tempDir(t);
  await fs.mkdir(path.join(project, '.swarm', 'runs', '1700000000001-run'), { recursive: true });
  await fs.writeFile(path.join(project, '.swarm', 'runs', '1700000000001-run', 'state.json'), JSON.stringify({
    id: '1700000000001-run',
    root: project,
    status: 'complete',
    jobs: [],
  }));
  const started = Date.now();
  await execFileAsync(process.execPath, [swarmPath, '--root', project, 'status', '1700000000001-run'], {
    cwd: packageRoot,
    env: swarmEnv({ busyDir, home, installRoot }),
    encoding: 'utf8',
  });
  assert.ok(Date.now() - started < 3000);
  await removePendingRecord(installRoot);
});

test('update --when-idle waits for a busy marker then runs performUpdate', async t => {
  const installRoot = await tempDir(t);
  let polls = 0;
  let performed = false;
  const outcome = await runWhenIdleUpdate({
    installRoot,
    timeoutMinutes: 1,
    performUpdate: async () => { performed = true; return { dry: true }; },
    describeBusy: async () => {
      polls += 1;
      if (polls < 4) {
        return {
          busy: true,
          liveRuns: [],
          processes: [],
          markers: [{ pid: 42, command: 'node tools/swarm.mjs go --scope x', root: '/tmp' }],
        };
      }
      return { busy: false, liveRuns: [], processes: [], markers: [] };
    },
    sleep: async () => {},
    env: { SWARM_UPDATE_PENDING_POLL_MS: '1', SWARM_UPDATE_PENDING_STATUS_MS: '1' },
  });
  assert.equal(outcome.status, 'updated');
  assert.equal(performed, true);
  assert.ok(polls > 1);
});

test('pending file is mode 0600', async t => {
  const installRoot = await tempDir(t);
  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    heldPids: [],
  });
  const mode = (await fs.stat(pendingPath(installRoot))).mode & 0o777;
  assert.equal(mode, 0o600);
  await removePendingRecord(installRoot);
});

test('held launcher is released when pending expires even if update pid is dead', async t => {
  const installRoot = await tempDir(t);
  const holderPid = await holdingPid(t);
  const realDateNow = Date.now;
  let clock = realDateNow();
  Date.now = () => clock;
  t.after(() => { Date.now = realDateNow; });
  const pollMs = 10;
  const startedAt = clock;
  const expiresAt = clock + pollMs * 3;
  await writePendingRecord(installRoot, {
    pid: holderPid,
    startedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    heldPids: [],
  });
  const lines = [];
  const waiter = waitBeforeLaunchingWork(installRoot, {
    write: text => lines.push(text),
    sleep: async ms => { clock += ms; },
    env: { SWARM_UPDATE_PENDING_POLL_MS: String(pollMs) },
  });
  await waiter;
  assert.ok(lines.some(line => line.includes('waiting for swarm update')));
});
