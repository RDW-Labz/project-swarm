// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { acquireAutopilotLock } from '../tools/autopilot-lock.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');
const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lock-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
const lockFile = root => path.join(root, '.swarm/project/autopilot.lock');

test('a second autopilot is refused while the first holds the lock; release frees it', async t => {
  const root = await tmp(t);
  const release = await acquireAutopilotLock(root, { pid: 111, isAlive: () => true });
  await assert.rejects(acquireAutopilotLock(root, { pid: 222, isAlive: () => true }), /autopilot-running: pid 111/);
  await release();
  await release();
  await assert.rejects(fs.stat(lockFile(root)));
  const again = await acquireAutopilotLock(root, { pid: 222, isAlive: () => true });
  await again();
});

test('stale takeover quarantine does not delete a live lock published before quarantine rename', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  const liveRecord = { pid: 222, token: 'live-token', startedAt: new Date().toISOString() };
  await fs.writeFile(lockFile(root), JSON.stringify({ pid: 999999 }));
  let hookRan = false;
  await assert.rejects(
    acquireAutopilotLock(root, {
      pid: 111,
      isAlive: p => p === 222,
      afterStaleJudgmentBeforeQuarantine: async () => {
        hookRan = true;
        await fs.writeFile(lockFile(root), `${JSON.stringify(liveRecord)}\n`);
      },
    }),
    /autopilot-running: pid 222/,
  );
  assert.ok(hookRan);
  const onDisk = JSON.parse(await fs.readFile(lockFile(root), 'utf8'));
  assert.equal(onDisk.pid, 222);
  assert.equal(onDisk.token, 'live-token');
});

test('a lock left by a dead process, or an unreadable one, is cleared', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(lockFile(root), JSON.stringify({ pid: 999999 }));
  const release = await acquireAutopilotLock(root, { pid: 5, isAlive: () => false });
  assert.equal(JSON.parse(await fs.readFile(lockFile(root), 'utf8')).pid, 5);
  await release();
  await fs.writeFile(lockFile(root), 'garbage');
  await (await acquireAutopilotLock(root, { pid: 6 }))();
});

test('two concurrent acquisitions in the same process exclude each other', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  const isAlive = () => true;
  const results = await Promise.allSettled([
    acquireAutopilotLock(root, { pid: 42, isAlive }),
    acquireAutopilotLock(root, { pid: 42, isAlive }),
  ]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'autopilot-running');
  await fulfilled[0].value();
});

test('a temp lock file without a linked final path is not mistaken for the live lock', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  const dir = path.join(root, '.swarm/project');
  await fs.writeFile(
    path.join(dir, `autopilot.lock.${process.pid}.abc123.tmp`),
    `${JSON.stringify({ pid: 1, token: 'pending', startedAt: new Date().toISOString() })}\n`,
  );
  await assert.rejects(fs.stat(lockFile(root)));
  const release = await acquireAutopilotLock(root, { pid: 2, isAlive: () => true });
  const owner = JSON.parse(await fs.readFile(lockFile(root), 'utf8'));
  assert.equal(owner.pid, 2);
  assert.ok(typeof owner.token === 'string' && owner.token.length > 0);
  await release();
});

test('an empty final lock file still yields at most one live holder under contention', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(lockFile(root), '');
  const results = await Promise.allSettled([
    acquireAutopilotLock(root, { pid: 1, isAlive: () => true }),
    acquireAutopilotLock(root, { pid: 2, isAlive: () => true }),
  ]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1);
  await fulfilled[0].value();
});

test('release only removes the lock when the token matches this acquisition', async t => {
  const root = await tmp(t);
  const release = await acquireAutopilotLock(root, { pid: 7, isAlive: () => true });
  const saved = JSON.parse(await fs.readFile(lockFile(root), 'utf8'));
  await fs.writeFile(lockFile(root), JSON.stringify({ pid: 7, token: 'other-token', startedAt: saved.startedAt }));
  await release();
  assert.equal(JSON.parse(await fs.readFile(lockFile(root), 'utf8')).token, 'other-token');
  await (await acquireAutopilotLock(root, { pid: 9, isAlive: () => false }))();
});

test('a release never removes a lock that another process took over; a symlinked lock is refused', async t => {
  const root = await tmp(t);
  const release = await acquireAutopilotLock(root, { pid: 7 });
  await fs.writeFile(lockFile(root), JSON.stringify({ pid: 8 }));
  await release();
  assert.equal(JSON.parse(await fs.readFile(lockFile(root), 'utf8')).pid, 8);
  await fs.rm(lockFile(root));
  await fs.writeFile(path.join(root, 'elsewhere'), 'x');
  await fs.symlink(path.join(root, 'elsewhere'), lockFile(root));
  await assert.rejects(acquireAutopilotLock(root, { pid: 9 }));
});

test('swarm autopilot refuses to start while a live process holds the lock, and cleans up after itself', async t => {
  const root = await tmp(t);
  await exec('git', ['init', '-q', root]);
  const env = { ...process.env, SWARM_CONFIG: process.env.SWARM_CONFIG, HOME: root };
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  t.after(() => sleeper.kill());
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(lockFile(root), JSON.stringify({ pid: sleeper.pid }));
  await assert.rejects(exec(process.execPath, [swarm, '--root', root, 'autopilot', '--once'], { env }), error => /autopilot-running/.test(error.stderr + error.stdout));
  sleeper.kill();
  await new Promise(resolve => sleeper.once('exit', resolve));
  await exec(process.execPath, [swarm, '--root', root, 'autopilot', '--once'], { env });
  await assert.rejects(fs.stat(lockFile(root)));
});
