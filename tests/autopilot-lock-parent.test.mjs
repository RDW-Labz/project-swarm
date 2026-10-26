// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireAutopilotLock } from '../tools/autopilot-lock.mjs';

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lock-parent-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
const lockFile = root => path.join(root, '.swarm/project/autopilot.lock');

const OWNER_PID = 40_001;
const CHILD_PID = 40_002;
const STRANGER_PID = 40_003;

test('child of the lock owner may proceed; release does not remove the lock file', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(lockFile(root), `${JSON.stringify({ pid: OWNER_PID })}\n`);
  const release = await acquireAutopilotLock(root, {
    pid: CHILD_PID,
    parentPid: OWNER_PID,
    allowOwnerPid: OWNER_PID,
    isAlive: pid => pid === OWNER_PID,
  });
  assert.equal(JSON.parse(await fs.readFile(lockFile(root), 'utf8')).pid, OWNER_PID);
  await release();
  assert.equal(JSON.parse(await fs.readFile(lockFile(root), 'utf8')).pid, OWNER_PID);
});

test('a non-child with the same allowOwnerPid env value is still refused', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(lockFile(root), `${JSON.stringify({ pid: OWNER_PID })}\n`);
  await assert.rejects(
    acquireAutopilotLock(root, {
      pid: STRANGER_PID,
      parentPid: 1,
      env: { SWARM_AUTOPILOT_PID: String(OWNER_PID) },
      isAlive: pid => pid === OWNER_PID,
    }),
    /autopilot-running: pid 40001/,
  );
});

test('an unrelated live owner is refused even when SWARM_AUTOPILOT_PID points elsewhere', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(lockFile(root), `${JSON.stringify({ pid: 50_000 })}\n`);
  await assert.rejects(
    acquireAutopilotLock(root, {
      pid: CHILD_PID,
      parentPid: OWNER_PID,
      env: { SWARM_AUTOPILOT_PID: String(OWNER_PID) },
      isAlive: () => true,
    }),
    /autopilot-running: pid 50000/,
  );
});

test('explicit allowOwnerPid does not bypass a non-autopilot lock name', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  const customLock = path.join(root, '.swarm/project/custom.lock');
  await fs.writeFile(customLock, `${JSON.stringify({ pid: OWNER_PID })}\n`);
  await assert.rejects(
    acquireAutopilotLock(root, {
      name: 'custom',
      pid: CHILD_PID,
      parentPid: OWNER_PID,
      allowOwnerPid: OWNER_PID,
      isAlive: pid => pid === OWNER_PID,
    }),
    /custom-running: pid 40001/,
  );
});

test('a dead owner lock is cleared for a child caller as before', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(lockFile(root), `${JSON.stringify({ pid: OWNER_PID })}\n`);
  const release = await acquireAutopilotLock(root, {
    pid: CHILD_PID,
    parentPid: OWNER_PID,
    env: { SWARM_AUTOPILOT_PID: String(OWNER_PID) },
    isAlive: () => false,
  });
  assert.equal(JSON.parse(await fs.readFile(lockFile(root), 'utf8')).pid, CHILD_PID);
  await release();
  await assert.rejects(fs.stat(lockFile(root)));
});
