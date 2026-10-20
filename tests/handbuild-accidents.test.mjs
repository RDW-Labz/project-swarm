// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { guardDecision } from '../tools/handbuild.mjs';
import { isRoutingPathResolved } from '../tools/routing-paths.mjs';
import { isHandBuilt } from '../tools/orchestrator-events.mjs';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const swarmBytes = Buffer.from('swarm\n');
const integratedHashesFor = rels => Object.fromEntries(rels.map(rel => [rel, crypto.createHash('sha256').update(swarmBytes).digest('hex')]));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-acc-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

async function project(t, { branch = 'feature/x', produced = [] } = {}) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
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
  const bash = (command, extra = {}) => guardDecision({ tool: 'Bash', toolInput: { command }, root, cwd: root, now: () => T0, branchOf: branchOfFn, home: extra.home ?? os.homedir(), ...extra });
  const write = (rel, extra = {}) => guardDecision({ tool: 'Write', toolInput: { file_path: path.isAbsolute(rel) ? rel : path.join(root, rel) }, root, cwd: root, now: () => T0, branchOf: branchOfFn, home: extra.home ?? os.homedir() });
  return { root, git, bash, write, branchOfFn };
}

test('git push origin on main', async t => {
  const { bash } = await project(t, { branch: 'main' });
  assert.equal(bash('git push origin').allow, false);
});

test('git push origin feature main', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git push origin feature main').allow, false);
});

test('git push origin feature:main', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git push origin feature:main').allow, false);
});

test('git push --mirror origin', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git push --mirror origin').allow, false);
});

test('git push origin --delete feature', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git push origin --delete feature').allow, false);
});

test('git fetch . HEAD:refs/remotes/origin/main', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git fetch . HEAD:refs/remotes/origin/main').allow, false);
});

test('git fetch --upload-pack=x .', async t => {
  const { bash } = await project(t);
  assert.equal(bash('git fetch --upload-pack=x .').allow, false);
});

test('printf evil > src/x.js && git add src/x.js && git commit -m x (src/x.js swarm-produced with matching staged bytes but the write in the same line)', async t => {
  const { bash, root, git } = await project(t, { produced: ['src/x.js'] });
  await fs.writeFile(path.join(root, 'src', 'x.js'), 'swarm\n');
  git('add', 'src/x.js');
  const d = bash('printf evil > src/x.js && git add src/x.js && git commit -m x');
  assert.equal(d.allow, false);
});

test('git --work-tree=/tmp/w add src/x.js', async t => {
  const { bash, root } = await project(t);
  await fs.writeFile(path.join(root, 'src', 'x.js'), 'x\n');
  assert.equal(bash('git --work-tree=/tmp/w add src/x.js').allow, false);
});

test('GIT_WORK_TREE=/tmp/w git add src/x.js', async t => {
  const { bash, root } = await project(t);
  await fs.writeFile(path.join(root, 'src', 'x.js'), 'x\n');
  assert.equal(bash('GIT_WORK_TREE=/tmp/w git add src/x.js').allow, false);
});

test('a dynamic command (a variable as the command word, eval, a pipe into sh, base64 -d into sh)', async t => {
  const { bash } = await project(t);
  for (const cmd of ['$CMD src/x.js', 'eval "touch src/x.js"', 'echo x | sh', 'echo dGVzdA== | base64 -d | sh']) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
  }
});

test('a Write to a transcript jsonl under the home .claude projects folder', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const transcript = path.join(home, '.claude', 'projects', 'proj-id', 'session-abc.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  const { write } = await project(t);
  const d = write(transcript, { home });
  assert.equal(d.allow, false);
});

test('a Write to a symlink named like a manifest that points at a source file', async t => {
  const { root, write } = await project(t);
  const link = path.join(root, 'coordination', 'manifests', 'trap.json');
  const target = path.join(root, 'src', 'secret.mjs');
  await fs.writeFile(target, 'x\n');
  try { fsSync.unlinkSync(link); } catch { /* no file */ }
  fsSync.symlinkSync(target, link);
  assert.equal(isRoutingPathResolved(root, 'coordination/manifests/trap.json'), false);
  assert.equal(isHandBuilt('Write', 'coordination/manifests/trap.json', root), true);
  assert.equal(write('coordination/manifests/trap.json').allow, false);
});
