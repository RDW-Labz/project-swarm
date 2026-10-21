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
  machineBusySnapshot,
  pendingPath,
  readLivePending,
  registerHeldLauncher,
  runWhenIdleUpdate,
  writePendingRecord,
} from '../tools/update-pending.mjs';
import {
  createDescribeUpdateBusy,
  READ_ONLY_SWARM_COMMANDS,
  WORK_LAUNCH_COMMANDS,
} from '../tools/swarm/core-52.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELD_LOG_BASENAME_LOCAL = '.update-pending-held.log';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-r2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('(2) SIGTERM during when-idle exits 143 after cleanup', async t => {
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
  const [code, signal] = await new Promise(resolve => child.once('exit', (c, s) => resolve([c, s])));
  assert.equal(code, 143);
  assert.equal(await readLivePending(installRoot), null);
});

test('(6) cross-process held registration does not lose pids', async t => {
  const installRoot = await tempDir(t);
  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    heldPids: [],
  });
  const modulePath = path.join(HERE, '..', 'tools', 'update-pending.mjs');
  const workers = [101, 102, 103].map(pid => spawn(process.execPath, ['--input-type=module', '-e', `
    import { registerHeldLauncher } from ${JSON.stringify(modulePath)};
    await registerHeldLauncher(${JSON.stringify(installRoot)}, ${pid});
  `], { stdio: 'ignore' }));
  await Promise.all(workers.map(w => new Promise(resolve => w.once('exit', resolve))));
  const raw = JSON.parse(await fs.readFile(pendingPath(installRoot), 'utf8'));
  assert.deepEqual(new Set(raw.heldPids), new Set([101, 102, 103]));
});

test('(6b) rewrite does not recreate pending after cleanup removed it', async t => {
  const installRoot = await tempDir(t);
  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    heldPids: [],
  });
  await fs.rm(pendingPath(installRoot), { force: true });
  await registerHeldLauncher(installRoot, 999);
  await assert.rejects(() => fs.readFile(pendingPath(installRoot)), { code: 'ENOENT' });
});

test('(7) child process of held launcher is excluded from busy snapshot', async () => {
  const heldLauncher = 40;
  const child = 41;
  const snapshot = await machineBusySnapshot({
    boardSummary: async () => ({ runs: [] }),
    runningSwarmCommands: () => [{ pid: child, command: 'swarm run manifest.json' }],
    liveBusyMarkers: async () => [],
    heldPids: [heldLauncher],
    parentOf: pid => (pid === child ? heldLauncher : null),
  });
  assert.equal(snapshot.busy, false);
});

test('(8) core-52 exports busy snapshot factory with parentOf and command lists', () => {
  assert.ok(WORK_LAUNCH_COMMANDS.includes('run'));
  assert.ok(READ_ONLY_SWARM_COMMANDS.includes('inspect'));
  assert.ok(!READ_ONLY_SWARM_COMMANDS.includes('run'));
  const describe = createDescribeUpdateBusy({
    boardSummary: async () => ({ runs: [] }),
    runningSwarmCommands: () => [{ pid: 9, command: 'swarm go' }],
    liveBusyMarkers: async () => [],
    installDirs: [],
    selfPid: 1,
  });
  assert.equal(typeof describe, 'function');
});

test('(12) held log is trimmed after many appends', async t => {
  const installRoot = await tempDir(t);
  await writePendingRecord(installRoot, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    heldPids: [],
  });
  const logPath = path.join(installRoot, HELD_LOG_BASENAME_LOCAL);
  const big = `${Array.from({ length: 600 }, (_, i) => i + 1).join('\n')}\n`;
  await fs.writeFile(logPath, big, { mode: 0o600 });
  await registerHeldLauncher(installRoot, 5000);
  const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
  assert.ok(lines.length <= 500);
});
