// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardDecision, createRequest, decideRequest, branchOf } from '../tools/handbuild.mjs';
import { swarmProducedFiles } from '../tools/swarm-produced.mjs';
import { isRoutingPath } from '../tools/routing-paths.mjs';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-allow-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

async function project(t, { branch = 'feature/x', produced = [] } = {}) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'hand.ts'), 'h\n');
  await fs.writeFile(path.join(root, 'coordination', 'manifests', 'm.json'), '{}\n');
  if (produced.length) {
    await fs.mkdir(path.join(root, '.swarm', 'runs', 'RUN'), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm', 'runs', 'RUN', 'state.json'), JSON.stringify({
      integratedAt: '2026-01-01T00:00:00.000Z',
      integratedFiles: produced,
      integratedNewFiles: [],
    }));
    for (const rel of produced) {
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, 'swarm\n');
    }
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const baseRef = git('rev-parse', 'HEAD').stdout.trim();
  git('branch', '-q', 'main', baseRef);
  git('remote', 'add', 'origin', root);
  if (branch !== 'main') {
    git('checkout', '-q', '-b', branch);
  }
  git('update-ref', 'refs/remotes/origin/main', baseRef);
  const branchOfFn = () => branch;
  const decide = (tool, toolInput, extra = {}) => guardDecision({ tool, toolInput, root, cwd: root, now: () => T0, branchOf: branchOfFn, ...extra });
  const bash = (command, extra = {}) => decide('Bash', { command }, extra);
  const write = rel => decide('Write', { file_path: path.join(root, rel) });
  return { root, git, bash, write, decide, branchOfFn };
}

test('routing manifest Write is allowed; tools/swarm.mjs Write is blocked', async t => {
  const { write } = await project(t);
  assert.equal(write('coordination/manifests/task.json').allow, true);
  assert.equal(isRoutingPath('coordination/manifests/task.json'), true);
  const blocked = write('tools/swarm.mjs');
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /write a ticket instead/);
});

test('swarmProducedFiles reads integrated run state', async t => {
  const { root } = await project(t, { produced: ['src/swarm.ts'] });
  const set = swarmProducedFiles(root);
  assert.equal(set.has('src/swarm.ts'), true);
});

test('ALLOWED git and gh read commands without approval', async t => {
  const { bash } = await project(t);
  for (const cmd of [
    'git fetch origin',
    'git status',
    'git log --oneline -3',
    'git diff HEAD~1',
    'git show HEAD',
    'git branch -d old-feature',
    'git rebase origin/main',
    'gh pr create --title t',
    'gh pr view 1',
    'gh pr list',
    'gh pr checks 5',
    'gh pr diff 5',
    'gh run list',
    'gh run watch 1',
    'gh run view 1',
  ]) assert.equal(bash(cmd).allow, true, cmd);
});

test('ALLOWED shell writes to routing paths and mv untracked file into scratchpad', async t => {
  const { bash, root } = await project(t);
  assert.equal(bash('echo x > coordination/manifests/x.json').allow, true);
  await fs.mkdir(path.join(root, 'scratchpad'), { recursive: true });
  await fs.writeFile(path.join(root, 'scratchpad', 'tmp.txt'), 't\n');
  await fs.writeFile(path.join(root, 'src', 'untracked.txt'), 'u\n');
  assert.equal(bash('mv src/untracked.txt scratchpad/untracked.txt').allow, true);
});

test('ALLOWED commit and push on feature branch for swarm-produced files only', async t => {
  const { bash, git, root } = await project(t, { branch: 'feature/x', produced: ['src/swarm.ts'] });
  await fs.writeFile(path.join(root, 'src', 'swarm.ts'), 'v2\n');
  git('add', 'src/swarm.ts');
  assert.equal(bash('git commit -m "integrate"').allow, true);
  assert.equal(bash('git push origin feature/x').allow, true);
});

test('BLOCKED commit on protected branch even for swarm-produced files', async t => {
  const { bash, git, root } = await project(t, { branch: 'main', produced: ['src/swarm.ts'] });
  await fs.writeFile(path.join(root, 'src', 'swarm.ts'), 'v2\n');
  git('add', 'src/swarm.ts');
  const d = bash('git commit -m x');
  assert.equal(d.allow, false);
  assert.match(d.reason, /blocked: git commit/);
});

test('BLOCKED commit on feature branch for hand-edited non-produced file', async t => {
  const { bash, git, root } = await project(t, { branch: 'feature/x' });
  await fs.writeFile(path.join(root, 'src', 'hand.ts'), 'edited\n');
  git('add', 'src/hand.ts');
  const d = bash('git commit -m x');
  assert.equal(d.allow, false);
  assert.match(d.reason, /blocked/);
});

test('BLOCKED force push, push to main, and push refspec to main', async t => {
  const { bash } = await project(t, { branch: 'feature/x' });
  assert.equal(bash('git push --force origin feature/x').allow, false);
  assert.match(bash('git push --force origin feature/x').reason, /force-push/);
  assert.equal(bash('git push origin main').allow, false);
  assert.equal(bash('git push origin HEAD:main').allow, false);
});

test('BLOCKED merge, deploy, branch -D, and gh api write without approval', async t => {
  const { bash } = await project(t);
  for (const [cmd, pat] of [
    ['git merge origin/main', /git merge/],
    ['gh pr merge 5', /git merge/],
    ['swarm merge 5', /git merge/],
    ['vercel deploy', /git deploy/],
    ['git branch -D stale', /branch-D/],
    ['gh api -X POST repos/o/r/issues', /gh api write/],
  ]) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
    assert.match(d.reason, pat, cmd);
  }
});

test('approval naming merge allows gh pr merge', async t => {
  const { bash, root } = await project(t);
  const r = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge from here', files: 'src/hand.ts', git: 'merge', minutes: 30 }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0, channel: 'computer' });
  assert.equal(bash('gh pr merge 5', { now: () => T0 + 1000 }).allow, true);
});

test('outside deletes: session scratchpad dir allowed, home path blocked', async t => {
  const { bash, root } = await project(t);
  const scratch = path.join(os.tmpdir(), `claude-hb-${process.pid}`, 'scratchpad');
  await fs.mkdir(scratch, { recursive: true });
  const victim = path.join(scratch, 'x.txt');
  await fs.writeFile(victim, 'x');
  t.after(() => fs.rm(path.dirname(scratch), { recursive: true, force: true }));
  assert.equal(bash(`rm ${JSON.stringify(victim)}`).allow, true);
  const outside = `/var/tmp/swarm-hb-victim-${process.pid}`;
  const blocked = bash(`rm ${JSON.stringify(outside)}`);
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /deletes outside the scratchpad/);
});

test('quoted commit message with backtick, $HOME, and > is allowed on feature branch', async t => {
  const { bash, git, root } = await project(t, { branch: 'feature/x', produced: ['src/swarm.ts'] });
  await fs.writeFile(path.join(root, 'src', 'swarm.ts'), 'v3\n');
  git('add', 'src/swarm.ts');
  assert.equal(bash('git commit -m "fix `x` for $HOME > y"').allow, true);
});

test('rebase on protected branch needs approval', async t => {
  const { bash, root } = await project(t, { branch: 'main' });
  assert.equal(bash('git rebase origin/main').allow, false);
  const r = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot rebase main here', files: 'src/hand.ts', git: 'commit', minutes: 30 }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  assert.equal(bash('git rebase origin/main', { now: () => T0 + 1000 }).allow, true);
});

test('createRequest accepts extended git operation names', async t => {
  const { root } = await project(t);
  const r = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot force push from here', files: 'src/hand.ts', git: 'force-push,merge,deploy,branch-D', minutes: 15 }, { now: () => T0 });
  assert.ok(r.id.startsWith('hb-'));
});
