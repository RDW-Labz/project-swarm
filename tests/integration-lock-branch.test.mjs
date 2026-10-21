// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireIntegrationLock, resolveIntegrationLockBranch, withSharedWriteLock } from '../tools/integration-lock.mjs';
import { repoKey } from '../tools/board.mjs';

const exec = promisify(execFile);

async function repoFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lock-branch-')));
  const liveDir = path.join(root, 'live');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'README'), 'x\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'live/\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'init']);
  await exec('git', ['-C', root, 'branch', 'a']);
  await exec('git', ['-C', root, 'branch', 'b']);
  const wtA = path.join(root, 'wt-a');
  const wtB = path.join(root, 'wt-b');
  await exec('git', ['-C', root, 'worktree', 'add', '-q', wtA, 'a']);
  await exec('git', ['-C', root, 'worktree', 'add', '-q', wtB, 'b']);
  return { root, liveDir, wtA, wtB };
}

test('different branches integrate concurrently; the same branch serializes', async t => {
  const { liveDir, wtA, wtB } = await repoFixture(t);
  const a = await acquireIntegrationLock(wtA, { runId: 'a1', liveDir, pid: 101, isAlive: () => true });
  const b = await acquireIntegrationLock(wtB, { runId: 'b1', liveDir, pid: 102, isAlive: () => true });
  await assert.rejects(acquireIntegrationLock(wtA, { runId: 'a2', liveDir, pid: 103, isAlive: () => true }), error => {
    assert.equal(error.code, 'integrate-locked');
    assert.match(error.message, /branch a of this repository/);
    return true;
  });
  await a.release();
  const a2 = await acquireIntegrationLock(wtA, { runId: 'a2', liveDir, pid: 104, isAlive: () => true });
  await a2.release();
  await b.release();
});

test('detached worktrees do not block each other or a branch checkout', async t => {
  const { liveDir, wtA, root } = await repoFixture(t);
  const det1 = path.join(root, 'det1');
  const det2 = path.join(root, 'det2');
  await exec('git', ['-C', root, 'worktree', 'add', '--detach', det1, 'HEAD']);
  await exec('git', ['-C', root, 'worktree', 'add', '--detach', det2, 'HEAD']);
  const branch = await acquireIntegrationLock(wtA, { runId: 'br', liveDir, pid: 201, isAlive: () => true });
  const d1 = await acquireIntegrationLock(det1, { runId: 'd1', liveDir, pid: 202, isAlive: () => true });
  const d2 = await acquireIntegrationLock(det2, { runId: 'd2', liveDir, pid: 203, isAlive: () => true });
  await branch.release();
  await d1.release();
  await d2.release();
});

test('stale integrate locks clear per branch; explicit branch option wins', async t => {
  const { liveDir, wtA } = await repoFixture(t);
  const repo = await repoKey(wtA);
  const { branchKey } = await resolveIntegrationLockBranch(wtA, {});
  const key = crypto.createHash('sha256').update(`${repo}\0integrate:${branchKey}`).digest('hex').slice(0, 16);
  const lockDir = path.join(liveDir, 'locks', `integrate-${key}`);
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 99999, host: os.hostname(), runId: 'stale', root: wtA, startedAt: new Date().toISOString() }));
  const held = await acquireIntegrationLock(wtA, { runId: 'fresh', liveDir, pid: 301, isAlive: pid => pid !== 99999 });
  assert.equal(held.warnings.length, 1);
  assert.match(held.warnings[0], /integrate-lock-stale-cleared/);
  await held.release();
  const explicit = await acquireIntegrationLock(wtA, { runId: 'ex', branch: 'custom', liveDir, pid: 302, isAlive: () => true });
  await assert.rejects(acquireIntegrationLock(wtA, { runId: 'ex2', branch: 'custom', liveDir, pid: 303, isAlive: () => true }), /branch custom/);
  await explicit.release();
});

test('the legacy repo-wide integrate key does not block per-branch locks', async t => {
  const { liveDir, wtA, wtB } = await repoFixture(t);
  const repo = await repoKey(wtA);
  const legacyKey = crypto.createHash('sha256').update(repo).digest('hex').slice(0, 16);
  await fs.mkdir(path.join(liveDir, 'locks', `integrate-${legacyKey}`), { recursive: true });
  await fs.writeFile(path.join(liveDir, 'locks', `integrate-${legacyKey}`, 'owner.json'), JSON.stringify({ pid: 1, host: os.hostname(), runId: 'legacy', root: wtA, startedAt: new Date().toISOString() }));
  const a = await acquireIntegrationLock(wtA, { runId: 'new-a', liveDir, pid: 401, isAlive: () => true });
  const b = await acquireIntegrationLock(wtB, { runId: 'new-b', liveDir, pid: 402, isAlive: () => true });
  const names = await fs.readdir(path.join(liveDir, 'locks'));
  assert.ok(names.filter(name => name.startsWith('integrate-')).length >= 2);
  await a.release();
  await b.release();
});

test('withSharedWriteLock serializes same-name writers and allows different names in parallel', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-shared-write-')));
  const liveDir = path.join(root, 'live');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  const counterFile = path.join(root, 'counter.txt');
  await fs.writeFile(counterFile, '0');
  let parallel = 0;
  let maxParallel = 0;
  const bump = async () => {
    parallel++;
    maxParallel = Math.max(maxParallel, parallel);
    const value = Number(await fs.readFile(counterFile, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 30));
    await fs.writeFile(counterFile, String(value + 1));
    parallel--;
  };
  await Promise.all([
    withSharedWriteLock(root, 'counter.txt', bump, { liveDir, pid: 501, isAlive: () => true }),
    withSharedWriteLock(root, 'counter.txt', bump, { liveDir, pid: 502, isAlive: () => true }),
  ]);
  assert.equal(await fs.readFile(counterFile, 'utf8'), '2');
  assert.equal(maxParallel, 1);
  let otherParallel = 0;
  await Promise.all([
    withSharedWriteLock(root, 'a.txt', async () => { otherParallel++; await new Promise(r => setTimeout(r, 40)); otherParallel--; }, { liveDir, pid: 503, isAlive: () => true }),
    withSharedWriteLock(root, 'b.txt', async () => { otherParallel++; await new Promise(r => setTimeout(r, 40)); otherParallel--; }, { liveDir, pid: 504, isAlive: () => true }),
  ]);
  assert.equal(otherParallel, 0);
});

test('withSharedWriteLock clears stale locks, times out, and warns when held too long', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-shared-stale-')));
  const liveDir = path.join(root, 'live');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  const repo = await repoKey(root);
  const key = crypto.createHash('sha256').update(`${repo}\0shared:stale-file`).digest('hex').slice(0, 16);
  const lockDir = path.join(liveDir, 'locks', `shared-${key}`);
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 88888, host: os.hostname(), name: 'stale-file', root, startedAt: new Date().toISOString() }));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); originalWarn(...args); };
  t.after(() => { console.warn = originalWarn; });
  await withSharedWriteLock(root, 'stale-file', async () => 'ok', { liveDir, pid: 601, isAlive: pid => pid !== 88888, staleMs: 30000 });
  assert.ok(warnings.some(line => line.includes('shared-write-lock-stale-cleared')));
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 77777, host: os.hostname(), name: 'stale-file', root, startedAt: new Date().toISOString() }));
  await assert.rejects(withSharedWriteLock(root, 'stale-file', async () => {}, { liveDir, pid: 602, isAlive: () => true, waitMs: 200 }), error => {
    assert.equal(error.code, 'shared-write-locked');
    assert.match(error.message, /stale-file/);
    return true;
  });
  let tick = 0;
  const now = () => { tick += 50; return tick; };
  await withSharedWriteLock(root, 'slow-file', async () => { tick += 6000; }, { liveDir, pid: 603, isAlive: () => true, maxHoldMs: 10, now });
  assert.ok(warnings.some(line => line.includes('shared-write-lock-slow') && line.includes('slow-file')));
});
