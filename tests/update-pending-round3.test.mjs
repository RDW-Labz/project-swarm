// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquirePendingSlot } from '../tools/update-pending.mjs';
import {
  formatProcessLockPayload,
  stealProcessLockIfStale,
  withProcessLock,
} from '../tools/server-restart.mjs';
import { argvForRemoteServe } from '../tools/watch-cli.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-r3-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('(2) stale pending-held lock with old timestamp is stolen', async t => {
  const installRoot = await tempDir(t);
  const lockPath = path.join(installRoot, '.update-pending-held.lock');
  await fs.mkdir(installRoot, { recursive: true });
  const old = new Date(Date.now() - 120_000).toISOString();
  await fs.writeFile(lockPath, formatProcessLockPayload(process.pid, old), { mode: 0o600 });
  assert.equal(await stealProcessLockIfStale(lockPath, { maxAgeMs: 60_000, isAlive: () => true }), true);
  await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' });
});

test('(2b) acquirePendingSlot succeeds after dead-pid held lock', async t => {
  const installRoot = await tempDir(t);
  const lockPath = path.join(installRoot, '.update-pending-held.lock');
  await fs.mkdir(installRoot, { recursive: true });
  await fs.writeFile(lockPath, formatProcessLockPayload(424242, new Date().toISOString()), { mode: 0o600 });
  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    heldPids: [],
  };
  const acquired = await acquirePendingSlot(installRoot, record);
  assert.equal(acquired.ok, true);
});

test('(2c) held log lock steal allows append', async t => {
  const installRoot = await tempDir(t);
  const logPath = path.join(installRoot, '.update-pending-held.log');
  await fs.mkdir(installRoot, { recursive: true });
  const lockPath = `${logPath}.lock`;
  await fs.writeFile(lockPath, formatProcessLockPayload(1, new Date(Date.now() - 120_000).toISOString()), { mode: 0o600 });
  await withProcessLock(lockPath, async () => {
    await fs.appendFile(logPath, `${process.pid}\n`, { flag: 'a' });
  }, { timeoutMs: 5000, maxAgeMs: 60_000, isAlive: () => false });
  const text = await fs.readFile(logPath, 'utf8');
  assert.match(text, new RegExp(String(process.pid)));
});

test('(4) argvForRemoteServe records port login and hosts', () => {
  const argv = argvForRemoteServe({
    port: 4400,
    login: 'owner',
    hosts: ['alpha.example', { name: 'beta.example' }],
  });
  assert.deepEqual(argv, [
    'remote', 'serve', '--port', '4400', '--login', 'owner',
    '--host', 'alpha.example', '--host', 'beta.example',
  ]);
});

test('(10) registry argv from remote entry is not truncated to remote serve only', () => {
  const fromRegistry = argvForRemoteServe({ port: 8080 }, { argv: ['remote', 'serve', '--port', '8080', '--login', 'x'] });
  assert.deepEqual(fromRegistry, ['remote', 'serve', '--port', '8080', '--login', 'x']);
});
