// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  snapshotIntegrated,
  worktreeFromSnapshot,
  listSnapshotRefs,
  sweepOldSnapshots,
  defaultGitRunner,
} from '../tools/integrated-snapshot.mjs';

const execFileAsync = promisify(execFile);

async function git(root, args, env = {}) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return stdout;
}

async function captureRepoState(root) {
  const gitDir = path.resolve(root, (await git(root, ['rev-parse', '--git-dir'])).trim());
  const indexPath = path.join(gitDir, 'index');
  const porcelain = (await git(root, ['status', '--porcelain'])).trimEnd();
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const branch = (await git(root, ['symbolic-ref', '-q', 'HEAD'])).trim();
  const stash = (await git(root, ['stash', 'list'])).trimEnd();
  const indexBytes = await fs.readFile(indexPath);
  return {
    porcelain,
    head,
    branch,
    stash,
    indexBytes,
    tracked: (await git(root, ['show', 'HEAD:tracked.txt'])).trim(),
    workTracked: (await fs.readFile(path.join(root, 'tracked.txt'), 'utf8')).trim(),
    workNew: await fs.readFile(path.join(root, 'new.txt'), 'utf8').catch(() => null),
    workDeleted: await fs.readFile(path.join(root, 'deleted.txt'), 'utf8').catch(() => null),
  };
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-int-snap-')));
  t.after(async () => {
    const refs = await listSnapshotRefs(root, defaultGitRunner(root));
    for (const ref of refs) await git(root, ['update-ref', '-d', ref]).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  await git(root, ['init', '-b', 'main']);
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
  await fs.writeFile(path.join(root, 'tracked.txt'), 'old-tracked\n');
  await fs.writeFile(path.join(root, 'deleted.txt'), 'will-delete\n');
  await fs.writeFile(path.join(root, 'ignored.txt'), 'ignored-content\n');
  await fs.writeFile(path.join(root, '.swarm', 'secret.txt'), 'swarm-only\n');
  await git(root, ['add', 'tracked.txt', 'deleted.txt', '.gitignore', '.swarm/secret.txt']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  await fs.writeFile(path.join(root, 'stash-marker.txt'), 'stash\n');
  await git(root, ['add', 'stash-marker.txt']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', '-c', 'commit.gpgsign=false', 'stash', 'push', '-m', 'keep']);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'new-tracked\n');
  await fs.writeFile(path.join(root, 'new.txt'), 'brand-new\n');
  await fs.rm(path.join(root, 'deleted.txt'));
  return root;
}

test('snapshot reflects working tree without mutating the real repo', async t => {
  const root = await fixture(t);
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-out-'));
  t.after(() => fs.rm(outsideDir, { recursive: true, force: true }));
  const outsideTarget = path.join(outsideDir, 'target.txt');
  await fs.writeFile(outsideTarget, 'outside\n');
  const linkOutside = path.join(root, 'link-out');
  await fs.symlink(outsideTarget, linkOutside);
  const bigPath = path.join(root, 'big.bin');
  await fs.writeFile(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1));
  await fs.writeFile(path.join(root, '.swarm', 'nope.txt'), 'nope\n');

  const before = await captureRepoState(root);

  const paths = [
    'tracked.txt',
    'new.txt',
    'deleted.txt',
    'ignored.txt',
    '.swarm/nope.txt',
    '../outside.txt',
    'big.bin',
    'link-out',
  ];

  const gitRunner = defaultGitRunner(root);
  const snap = await snapshotIntegrated({ root, paths, git: gitRunner });
  const after = await captureRepoState(root);

  assert.equal(after.porcelain, before.porcelain);
  assert.equal(after.head, before.head);
  assert.equal(after.branch, before.branch);
  assert.equal(after.stash, before.stash);
  assert.ok(after.indexBytes.equals(before.indexBytes));
  assert.equal(after.workTracked, before.workTracked);
  assert.equal(after.workNew, before.workNew);
  assert.equal(after.workDeleted, before.workDeleted);

  assert.deepEqual(snap.included.sort(), ['deleted.txt', 'new.txt', 'tracked.txt'].sort());
  const skippedByPath = new Map(snap.skipped.map(s => [s.path, s.reason]));
  assert.equal(skippedByPath.get('ignored.txt'), 'ignored');
  assert.equal(skippedByPath.get('.swarm/nope.txt'), 'dot-swarm');
  assert.equal(skippedByPath.get('../outside.txt'), 'outside-repo');
  assert.equal(skippedByPath.get('big.bin'), 'oversized');
  assert.equal(skippedByPath.get('link-out'), 'symlink-outside');

  const wtDir = path.join(root, '.swarm', 'snap-wt');
  const wt = await worktreeFromSnapshot({ root, snapshot: snap, dir: wtDir, git: gitRunner });
  assert.equal(await fs.readFile(path.join(wt.dir, 'tracked.txt'), 'utf8'), 'new-tracked\n');
  assert.equal(await fs.readFile(path.join(wt.dir, 'new.txt'), 'utf8'), 'brand-new\n');
  await assert.rejects(fs.access(path.join(wt.dir, 'deleted.txt')));
  assert.equal((await git(root, ['show', `${snap.commit}:tracked.txt`])).trim(), 'new-tracked');
  assert.equal((await git(root, ['show', `${snap.commit}:new.txt`])).trim(), 'brand-new');
  await assert.rejects(() => git(root, ['show', `${snap.commit}:deleted.txt`]));
  await wt.remove();

  const refsBeforeCleanup = await listSnapshotRefs(root, gitRunner);
  assert.ok(refsBeforeCleanup.includes(snap.ref));
  await snap.cleanup();
  await snap.cleanup();
  const refsAfterCleanup = await listSnapshotRefs(root, gitRunner);
  assert.ok(!refsAfterCleanup.includes(snap.ref));
});

test('concurrent snapshots get distinct refs', async t => {
  const root = await fixture(t);
  const gitRunner = defaultGitRunner(root);
  const [a, b] = await Promise.all([
    snapshotIntegrated({ root, paths: ['tracked.txt'], git: gitRunner }),
    snapshotIntegrated({ root, paths: ['new.txt'], git: gitRunner }),
  ]);
  assert.notEqual(a.ref, b.ref);
  assert.notEqual(a.commit, b.commit);
  await a.cleanup();
  await b.cleanup();
});

test('sweepOldSnapshots removes only stale refs', async t => {
  const root = await fixture(t);
  const gitRunner = defaultGitRunner(root);
  const snapOld = await snapshotIntegrated({ root, paths: ['tracked.txt'], git: gitRunner });
  const snapNew = await snapshotIntegrated({ root, paths: ['new.txt'], git: gitRunner });
  const gitDir = path.resolve(root, (await git(root, ['rev-parse', '--git-dir'])).trim());
  const oldRefPath = path.join(gitDir, snapOld.ref);
  const oldTime = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(oldRefPath, oldTime, oldTime);

  const removed = await sweepOldSnapshots({
    root,
    olderThanMs: 60_000,
    now: Date.now(),
    git: gitRunner,
  });
  assert.deepEqual(removed, [snapOld.ref]);
  const remaining = await listSnapshotRefs(root, gitRunner);
  assert.ok(remaining.includes(snapNew.ref));
  assert.ok(!remaining.includes(snapOld.ref));
  await snapNew.cleanup();
});
