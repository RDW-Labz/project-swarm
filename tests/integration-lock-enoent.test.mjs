// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import {
  tryAcquireLock,
  withSharedWriteLock,
  acquireIntegrationLock,
} from '../tools/integration-lock.mjs';

const lockOpts = {
  owner: { pid: process.pid, host: os.hostname(), name: 'test', root: '/tmp', startedAt: new Date().toISOString() },
  isAlive: () => true,
  now: Date.now,
  staleMs: 30000,
  staleOwnerlessMs: 30000,
  integrateStale: false,
  warnings: [],
};

test('tryAcquireLock retries after lstat ENOENT when lock dir vanishes', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-enoent-'));
  const lock = path.join(base, 'locks', 'shared-test');
  await fs.mkdir(lock, { recursive: true });
  let lstatEnoent = 1;
  const fsImpl = {
    mkdir: fs.mkdir.bind(fs),
    lstat: async (p) => {
      if (p === lock && lstatEnoent > 0) {
        lstatEnoent--;
        await fs.rm(lock, { recursive: true, force: true });
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return fs.lstat(p);
    },
    readFile: fs.readFile.bind(fs),
    rm: fs.rm.bind(fs),
    writeFile: fs.writeFile.bind(fs),
  };
  const result = await tryAcquireLock(lock, { ...lockOpts, fsImpl });
  assert.equal(result.ok, true);
  await fs.rm(base, { recursive: true, force: true });
});

test('fresh ownerless lock refuses integrate-locked; stale ownerless clears', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-ownerless-'));
  await execFileAsync('git', ['init'], { cwd: repoRoot });
  const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-ownerless-live-'));
  const lock = path.join(repoRoot, '.swarm', 'integration.lock');
  await fs.mkdir(lock, { recursive: true });
  await assert.rejects(
    acquireIntegrationLock(repoRoot, { runId: 'blocked', liveDir }),
    (error) => error.code === 'integrate-locked',
  );
  const old = new Date(Date.now() - 61000);
  await fs.utimes(lock, old, old);
  const held = await acquireIntegrationLock(repoRoot, { runId: 'cleared', liveDir });
  assert.equal(held.warnings.length, 1);
  assert.match(held.warnings[0], /integrate-lock-stale-cleared:/);
  await held.release();
  await fs.rm(liveDir, { recursive: true, force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
});

test('tryAcquireLock throws lock-race-exhausted when lstat ENOENT never ends', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-enoent-'));
  const lock = path.join(base, 'locks', 'shared-race');
  await fs.mkdir(lock, { recursive: true });
  const fsImpl = {
    mkdir: async (p, opts) => {
      if (p === lock && !opts?.recursive) {
        const err = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      return fs.mkdir(p, opts);
    },
    lstat: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    readFile: fs.readFile.bind(fs),
    rm: fs.rm.bind(fs),
    writeFile: fs.writeFile.bind(fs),
  };
  await assert.rejects(
    () => tryAcquireLock(lock, { ...lockOpts, fsImpl }),
    (error) => error.code === 'lock-race-exhausted',
  );
  await fs.rm(base, { recursive: true, force: true });
});

test('parallel shared and integrate locks never throw ENOENT', async () => {
  const root = process.cwd();
  const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-live-'));
  const sharedName = `enoent-concurrency-${Date.now()}`;
  const sharedRan = [];
  const integrateRan = [];
  const integrateRoots = [];
  const sharedTasks = Array.from({ length: 20 }, (_, i) =>
    withSharedWriteLock(root, sharedName, async () => {
      sharedRan.push(i);
    }, { liveDir, waitMs: 60000 }),
  );
  const integrateTasks = Array.from({ length: 20 }, (_, i) =>
    (async () => {
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), `integrate-repo-${i}-`));
      integrateRoots.push(repoRoot);
      await execFileAsync('git', ['init'], { cwd: repoRoot });
      const { release } = await acquireIntegrationLock(repoRoot, {
        runId: `enoent-${i}`,
        branch: `enoent-branch-${i}`,
        liveDir,
      });
      integrateRan.push(i);
      await release();
    })(),
  );
  await Promise.all([...sharedTasks, ...integrateTasks]);
  assert.equal(sharedRan.length, 20);
  assert.equal(integrateRan.length, 20);
  await fs.rm(liveDir, { recursive: true, force: true });
  for (const repoRoot of integrateRoots) {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});
