// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardDecision } from '../tools/handbuild.mjs';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-sw-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function project(t) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'state'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination', 'HANDOFF.md'), '# h\n');
  await fs.writeFile(path.join(root, 'coordination', 'manifests', 'm.json'), '{}\n');
  await fs.writeFile(path.join(root, 'docs', 'state', 'usage-ledger.md'), 'u\n');
  await fs.writeFile(path.join(root, 'tools', 'swarm.mjs'), 's\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const baseRef = git('rev-parse', 'HEAD').stdout.trim();
  git('branch', '-q', 'main', baseRef);
  git('checkout', '-q', '-b', 'feature/x');
  git('remote', 'add', 'origin', root);
  git('update-ref', 'refs/remotes/origin/main', baseRef);

  const branchOfFn = () => 'feature/x';
  const bash = (command, extra = {}) => guardDecision({
    tool: 'Bash',
    toolInput: { command },
    root,
    cwd: root,
    now: () => T0,
    branchOf: branchOfFn,
    ...extra,
  });
  return { root, bash, git };
}

test('git switch and checkout branch forms are free', async t => {
  const { bash } = await project(t);
  for (const cmd of [
    'git switch feature/y',
    'git checkout feature/y',
    'git switch -c feat/x',
    'git checkout -b feat/x',
    'git switch --detach origin/main',
    'git checkout --detach origin/main',
    'git switch main',
    'git checkout master',
  ]) {
    assert.equal(bash(cmd).allow, true, cmd);
  }
});

test('git switch and checkout unsafe forms stay blocked', async t => {
  const { bash } = await project(t);
  for (const cmd of [
    'git checkout -f main',
    'git switch --force other',
    'git checkout -B main',
    'git switch --orphan tmp',
    'git checkout -- tools/swarm.mjs',
    'git checkout -- .',
    'git switch feature/x -- path',
    'git -C /tmp switch feat',
  ]) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
  }
});

test('git restore and checkout path restore for routing and docs/state only', async t => {
  const { bash } = await project(t);
  for (const cmd of [
    'git checkout -- coordination/HANDOFF.md',
    'git checkout HEAD -- coordination/manifests/m.json',
    'git restore coordination/HANDOFF.md',
    'git restore --source=HEAD -- coordination/HANDOFF.md docs/state/usage-ledger.md',
  ]) {
    assert.equal(bash(cmd).allow, true, cmd);
  }
  const blocked = bash('git checkout -- tools/swarm.mjs');
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /write a ticket instead|blocked/i);
});
