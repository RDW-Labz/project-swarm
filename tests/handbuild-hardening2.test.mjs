// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardDecision } from '../tools/handbuild.mjs';
import { swarmProducedFiles } from '../tools/swarm-produced.mjs';
import { isSelfApprovalCommand } from '../tools/self-approval.mjs';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-hard2-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

async function project(t, { branch = 'feature/x', produced = ['src/core.mjs'] } = {}) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'core.mjs'), 'core\n');
  if (produced.length) {
    await fs.mkdir(path.join(root, '.swarm', 'runs', 'RUN'), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm', 'runs', 'RUN', 'state.json'), JSON.stringify({
      id: 'RUN',
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
  git('update-ref', 'refs/remotes/origin/main', baseRef);
  if (branch !== 'main') git('checkout', '-q', '-b', branch);
  const branchOfFn = () => branch;
  const bash = (command, extra = {}) => guardDecision({ tool: 'Bash', toolInput: { command }, root, cwd: root, now: () => T0, branchOf: branchOfFn, ...extra });
  const write = rel => guardDecision({ tool: 'Write', toolInput: { file_path: path.join(root, rel) }, root, cwd: root, now: () => T0, branchOf: branchOfFn });
  return { root, git, bash, write, branchOfFn };
}

test('(1) push force/delete to protected branches: never approvable', async t => {
  const { bash } = await project(t);
  for (const cmd of [
    'git push -fu origin main',
    'git push -uf origin main',
    'git push --force-with-lease=origin/main origin main',
    'git push origin --delete main',
  ]) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
    assert.match(d.reason, /never approvable/i, cmd);
  }
});

test('(2) branch delete: safe -d alone; -d with force is branch-D', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git branch -d tmp').allow, true);
  for (const cmd of ['git branch --delete --force unmerged', 'git branch -d -f x']) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
    assert.match(d.reason, /branch-D/, cmd);
  }
});

test('(3) git commit with -c config is not free', async t => {
  const { bash, git, root } = await project(t, { produced: ['src/core.mjs'] });
  await fs.writeFile(path.join(root, 'src', 'core.mjs'), 'v2\n');
  git('add', 'src/core.mjs');
  const d = bash('git -c core.hooksPath=/tmp/e commit -m x');
  assert.equal(d.allow, false);
  assert.match(d.reason, /commit/);
});

test('(4) command wrappers peel to real git policy', async t => {
  const { bash } = await project(t);
  assert.match(bash('command git push -f origin main').reason, /never approvable|force-push/);
  assert.equal(bash('env FOO=1 git push origin feature:main').allow, false);
  assert.equal(bash('nice git push --all').allow, false);
  const wrapped = bash('bash -c "git push -f origin main"');
  assert.equal(wrapped.allow, false);
  assert.match(wrapped.reason, /never approvable|force-push/);
});

test('(5) self-approval detector blocks orchestrator forgery channels', () => {
  assert.ok(isSelfApprovalCommand('swarm decide handbuild-abc approve'));
  assert.ok(isSelfApprovalCommand('claude -p merge 12'));
  assert.ok(isSelfApprovalCommand('tmux send-keys -t s swarm decide handbuild-x approve Enter'));
  assert.ok(isSelfApprovalCommand('script -q /dev/null swarm decide handbuild-abc approve'));
  const b64 = `echo ${Buffer.from('swarm decide handbuild-abc approve').toString('base64')} | base64 -d | sh`;
  assert.ok(isSelfApprovalCommand(b64));
});

test('(6) orchestrator text writes to swarm run records are never approvable', async t => {
  const { bash, write, root } = await project(t, { produced: [] });
  await fs.mkdir(path.join(root, '.swarm', 'runs', 'x'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', 'x', 'state.json'), '{}\n');
  const w = write('.swarm/runs/x/state.json');
  assert.equal(w.allow, false);
  assert.match(w.reason, /swarm run state|no approval covers/i);
  const s = bash('sed -i "" "s/a/b/" .swarm/runs/x/state.json');
  assert.equal(s.allow, false);
  assert.match(s.reason, /swarm run state|no approval covers/i);
});

test('(7) swarmProducedFiles ignores symlink state.json and mismatched run id', async t => {
  const { root } = await project(t, { produced: ['src/core.mjs'] });
  assert.equal(swarmProducedFiles(root).has('src/core.mjs'), true);
  const badDir = path.join(root, '.swarm', 'runs', 'BAD');
  await fs.mkdir(badDir, { recursive: true });
  await fs.writeFile(path.join(badDir, 'state.json'), JSON.stringify({
    id: 'WRONG',
    integratedAt: '2026-01-01T00:00:00.000Z',
    integratedFiles: ['src/forged.mjs'],
    integratedNewFiles: [],
  }));
  const linkDir = path.join(root, '.swarm', 'runs', 'LINK');
  await fs.mkdir(linkDir, { recursive: true });
  const realState = path.join(badDir, 'state-real.json');
  await fs.writeFile(realState, JSON.stringify({
    id: 'LINK',
    integratedAt: '2026-01-01T00:00:00.000Z',
    integratedFiles: ['src/link.mjs'],
    integratedNewFiles: [],
  }));
  fsSync.symlinkSync(realState, path.join(linkDir, 'state.json'));
  const set = swarmProducedFiles(root);
  assert.equal(set.has('src/forged.mjs'), false);
  assert.equal(set.has('src/link.mjs'), false);
  assert.equal(set.has('src/core.mjs'), true);
});
