import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { dirtyBlockers } from '../tools/ship.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd });
  return { stdout, stderr };
}

async function initRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ship-clean-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'ship-clean@test');
  await git(root, 'config', 'user.name', 'ship-clean');
  await writeFile(path.join(root, 'README.md'), 'init\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-m', 'init');
  return root;
}

async function porcelain(root) {
  const { stdout } = await git(root, 'status', '--porcelain');
  return stdout.split('\n').filter(Boolean);
}

test('dirtyBlockers: empty status passes', () => {
  assert.deepEqual(dirtyBlockers([]), []);
  assert.deepEqual(dirtyBlockers(['', '   ']), []);
});

test('dirtyBlockers: swarm-generated paths alone do not block', () => {
  const lines = [
    ' M coordination/HANDOFF.md',
    ' M coordination/HANDOFF.previous.md',
    ' M coordination/HANDOFF.previous-2.md',
    ' M TASK.md',
    ' M coordination/TASK.md',
    ' M build-plan.md',
    ' M coordination/build-plan.md',
    ' M docs/state/usage-ledger.md',
  ];
  assert.deepEqual(dirtyBlockers(lines), []);
});

test('dirtyBlockers: a modified source file is named', () => {
  assert.deepEqual(dirtyBlockers([' M src/app.mjs']), ['src/app.mjs']);
});

test('dirtyBlockers: an untracked source file is named', () => {
  assert.deepEqual(dirtyBlockers(['?? src/new.mjs']), ['src/new.mjs']);
});

test('dirtyBlockers: a mix names only blocking files', () => {
  const blockers = dirtyBlockers([
    ' M coordination/HANDOFF.md',
    ' M src/keep.mjs',
    '?? coordination/TASK.md',
    '?? tmp/extra.txt',
  ]);
  assert.deepEqual(blockers, ['src/keep.mjs', 'tmp/extra.txt']);
});

test('dirtyBlockers: rename between generated handoff backups is ignored', () => {
  assert.deepEqual(
    dirtyBlockers(['R  coordination/HANDOFF.md -> coordination/HANDOFF.previous.md']),
    [],
  );
});

test('dirtyBlockers: rename from generated to real code blocks the destination', () => {
  assert.deepEqual(
    dirtyBlockers(['R  coordination/HANDOFF.md -> src/leaked.mjs']),
    ['src/leaked.mjs'],
  );
});

test('git repo: only generated coordination files look clean', async t => {
  const root = await initRepo(t);
  await mkdir(path.join(root, 'coordination'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'state'), { recursive: true });
  const files = [
    'coordination/HANDOFF.md',
    'coordination/TASK.md',
    'docs/state/usage-ledger.md',
  ];
  for (const file of files) {
    await writeFile(path.join(root, file), 'v1\n');
    await git(root, 'add', file);
  }
  await git(root, 'commit', '-m', 'add generated');
  for (const file of files) {
    await writeFile(path.join(root, file), 'v2\n');
  }
  assert.deepEqual(dirtyBlockers(await porcelain(root)), []);
});

test('git repo: unrelated dirty file is reported from porcelain', async t => {
  const root = await initRepo(t);
  await writeFile(path.join(root, 'src.mjs'), 'export {};\n');
  await git(root, 'add', 'src.mjs');
  await git(root, 'commit', '-m', 'add src');
  await writeFile(path.join(root, 'src.mjs'), 'export const x = 1;\n');
  assert.deepEqual(dirtyBlockers(await porcelain(root)), ['src.mjs']);
});

test('dirtyBlockers: refusal message lists only blocking paths', () => {
  const blockers = dirtyBlockers([' M dirty.txt\n']);
  assert.deepEqual(blockers, ['dirty.txt']);
  assert.equal(`commit first: ${blockers.join(', ')}`, 'commit first: dirty.txt');
});

test('dirtyBlockers: generated-only porcelain has no blockers', () => {
  assert.deepEqual(dirtyBlockers([' M coordination/HANDOFF.md\n']), []);
});
