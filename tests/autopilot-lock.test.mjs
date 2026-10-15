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
