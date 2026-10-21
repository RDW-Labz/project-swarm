// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { guardDecision, createRequest, decideRequest, recordChatMerge } from '../tools/handbuild.mjs';
import { isRoutingPathResolved } from '../tools/routing-paths.mjs';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const swarmBytes = Buffer.from('swarm\n');
const integratedHashesFor = rels => Object.fromEntries(rels.map(rel => [rel, crypto.createHash('sha256').update(swarmBytes).digest('hex')]));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-hard-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

async function project(t, { branch = 'feature/x', produced = ['src/core.mjs'] } = {}) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'core.mjs'), 'core\n');
  await fs.writeFile(path.join(root, 'coordination', 'manifests', 'm.json'), '{}\n');
  if (produced.length) {
    await fs.mkdir(path.join(root, '.swarm', 'runs', 'RUN'), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm', 'runs', 'RUN', 'state.json'), JSON.stringify({
      id: 'RUN',
      integratedAt: '2026-01-01T00:00:00.000Z',
      integratedFiles: produced,
      integratedNewFiles: [],
      integratedHashes: integratedHashesFor(produced),
    }));
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const baseRef = git('rev-parse', 'HEAD').stdout.trim();
  git('branch', '-q', 'main', baseRef);
  git('remote', 'add', 'origin', root);
  git('update-ref', 'refs/remotes/origin/main', baseRef);
  if (branch !== 'main') git('checkout', '-q', '-b', branch);
  if (produced.length) {
    for (const rel of produced) {
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, 'swarm\n');
    }
  }
  const branchOfFn = () => branch;
  const bash = (command, extra = {}) => guardDecision({ tool: 'Bash', toolInput: { command }, root, cwd: root, now: () => T0, branchOf: branchOfFn, ...extra });
  const write = rel => guardDecision({ tool: 'Write', toolInput: { file_path: path.join(root, rel) }, root, cwd: root, now: () => T0, branchOf: branchOfFn });
  return { root, git, bash, write, branchOfFn };
}

test('(1) compound writes and mv: redirect blocked; tmp mv free; tracked mv to scratchpad needs approval', async t => {
  const { bash, root } = await project(t);
  await fs.mkdir(path.join(root, 'scratchpad'), { recursive: true });
  const sessionScratch = path.join(os.tmpdir(), `claude-hard-${process.pid}`, 'scratchpad');
  await fs.mkdir(sessionScratch, { recursive: true });
  t.after(() => fs.rm(path.dirname(sessionScratch), { recursive: true, force: true }));
  const outside = path.join(sessionScratch, 'a');
  await fs.writeFile(outside, 'a');
  assert.equal(bash('printf x > src/core.mjs').allow, false);
  assert.equal(bash(`mv ${JSON.stringify(outside)} ${JSON.stringify(path.join(sessionScratch, 'b'))}`).allow, true);
  const tracked = bash('mv src/core.mjs scratchpad/core.mjs');
  assert.equal(tracked.allow, false);
  assert.match(tracked.reason, /src\/core\.mjs/);
});

test('(2) swarm-produced files are free for commit only when staged bytes match integrate hash, not shell sed -i', async t => {
  const { bash, git, root } = await project(t, { produced: ['src/core.mjs'] });
  git('add', 'src/core.mjs');
  assert.equal(bash('git commit -m integrate').allow, true);
  await fs.writeFile(path.join(root, 'src', 'core.mjs'), 'v2\n');
  git('add', 'src/core.mjs');
  assert.equal(bash('git commit -m hand-edit').allow, false);
  assert.equal(bash('sed -i "" "s/a/b/" src/core.mjs').allow, false);
  assert.equal(bash('printf x > src/core.mjs').allow, false);
});

test('(3) git push: refspec to main and --all blocked or need push approval', async t => {
  const { bash } = await project(t);
  for (const cmd of [
    'git push origin feature:main',
    'git push origin HEAD:refs/heads/main',
    'git push origin :main',
    'git push origin +HEAD:main',
    'git push --all',
  ]) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
  }
  assert.match(bash('git push origin +HEAD:main').reason, /never approvable/i);
});

test('(4) git commit pathspec must be routing or swarm-produced', async t => {
  const { bash, git, root } = await project(t);
  await fs.writeFile(path.join(root, 'coordination', 'HANDOFF.md'), '# h\n');
  git('add', 'coordination/HANDOFF.md');
  const d = bash('git add coordination/HANDOFF.md && git commit -m x tools/handbuild.mjs');
  assert.equal(d.allow, false);
  assert.match(d.reason, /commit|handbuild/);
});

test('(5) free push on feature branch requires carried diff to be swarm or routing only', async t => {
  const { bash, git, root } = await project(t, { produced: ['src/core.mjs'] });
  await fs.writeFile(path.join(root, 'src', 'extra.mjs'), 'x\n');
  git('add', 'src/core.mjs', 'src/extra.mjs');
  git('commit', '-q', '-m', 'both');
  const d = bash('git push origin feature/x');
  assert.equal(d.allow, false);
  assert.match(d.reason, /push/);
});

test('(6) branch ops judged separately: -d free with -f main needs branch-D', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git branch -d tmp').allow, true);
  const d = bash('git branch -d tmp && git branch -f main HEAD');
  assert.equal(d.allow, false);
  assert.match(d.reason, /branch-D/);
  assert.equal(bash('git branch -m main x').allow, false);
});

test('(7) git rebase: only single plain ref; -x and two refs need approval', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git rebase origin/main').allow, true);
  assert.equal(bash('git rebase -x "echo 1" origin/main').allow, false);
  assert.equal(bash('git rebase feat main').allow, false);
});

test('(8) gh api/workflow, vercel deploy, and non-free gh need elevated approvals', async t => {
  const { bash } = await project(t);
  for (const [cmd, pat] of [
    ['gh api repos/o/r/merges -f base=main -f head=f', /gh api write|merge/],
    ['gh api user', /gh api write|merge/],
    ['gh workflow run deploy.yml', /gh|ticket/i],
    ['vercel --prod', /deploy/],
    ['vercel promote', /deploy/],
  ]) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
    assert.match(d.reason, pat, cmd);
  }
  assert.equal(bash('vercel ls').allow, true);
});

test('(9) outside delete only under session scratchpad realpath', async t => {
  const { bash, root } = await project(t);
  const home = os.homedir();
  const other = path.join(home, 'otherproject', 'scratchpad');
  const d = bash(`rm -rf ${JSON.stringify(other)}`);
  assert.equal(d.allow, false);
  assert.match(d.reason, /deletes outside the scratchpad/);
});

test('(10) routing path symlink to non-routing target is not a free Write', async t => {
  const { root, write } = await project(t);
  const link = path.join(root, 'coordination', 'manifests', 'a.json');
  const target = path.join(root, 'package.json');
  await fs.writeFile(target, '{}\n');
  try { fsSync.unlinkSync(link); } catch { /* no file */ }
  fsSync.symlinkSync(target, link);
  assert.equal(isRoutingPathResolved(root, 'coordination/manifests/a.json'), false);
  assert.equal(write('coordination/manifests/a.json').allow, false);
});

test('(11) read-only git with -c or --output is not free', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git -c core.pager=x log').allow, false);
  assert.equal(bash('git diff --output=src/x').allow, false);
});

test('(12) elevated hand-build approve requires computer channel in decideRequest', async t => {
  const { root } = await project(t);
  const r = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge from here today', files: 'src/core.mjs', git: 'merge', minutes: 30 }, { now: () => T0 });
  assert.throws(() => decideRequest(root, r.id, 'approve', { now: () => T0 }), /handbuild-computer-only/);
  decideRequest(root, r.id, 'approve', { now: () => T0, channel: 'computer' });
});

test('(13) chat merge token for swarm merge only; gh pr merge always blocked', async t => {
  const { bash, root } = await project(t);
  recordChatMerge(root, 5, { now: () => T0 });
  assert.equal(bash('swarm merge 5', { now: () => T0 + 1000 }).allow, true);
  assert.equal(bash('swarm merge 5', { now: () => T0 + 2000 }).allow, false);
  recordChatMerge(root, 5, { now: () => T0 });
  assert.equal(bash('gh pr merge 5', { now: () => T0 + 1000 }).allow, false);
  assert.match(bash('gh pr merge 5', { now: () => T0 + 1000 }).reason, /use swarm merge/i);
  assert.equal(bash('gh pr merge 5 -R o/r', { now: () => T0 + 1000 }).allow, false);
});
