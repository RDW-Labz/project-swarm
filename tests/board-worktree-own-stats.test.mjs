// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectId } from '../tools/projects.mjs';
import { approveLedger, createLedger, writeLedger } from '../tools/tickets.mjs';
import { boardSnapshot } from '../tools/board-data.mjs';

const execFileAsync = promisify(execFile);
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

async function repo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-own-ledger-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await git(root, ['checkout', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Test']);
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/parent.md'), '# Scope: Parent\nVersion: 1\n\n## S1 Foundation\n### R-001 Requirement\nAcceptance:\n- done\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'fixture']);
  return root;
}

async function addWorktree(t, root, branch) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-own-child-')));
  await fs.rm(dir, { recursive: true, force: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await git(root, ['worktree', 'add', '-q', '-b', branch, dir]);
  return dir;
}

function ticket(id, status) {
  return { id, title: id, type: 'build', status, stage: 'S1', scopeRefs: ['R-001'], acceptance: ['done'], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false };
}

async function ledger(root, scopeFile, scopeName, tickets, at) {
  const value = approveLedger(createLedger({ scope: { file: scopeFile, name: scopeName }, tickets, now: at }), { now: at });
  await writeLedger(root, value);
}

test('worktree rows read their own ledger and no-ledger worktrees do not inherit parent stats', async t => {
  const root = await repo(t);
  const child = await addWorktree(t, root, 'child');
  const empty = await addWorktree(t, root, 'empty');
  await fs.mkdir(path.join(child, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(child, 'docs/scope/child.md'), '# Scope: Child\nVersion: 1\n\n## S1 Foundation\n### R-001 Requirement\nAcceptance:\n- done\n');
  await ledger(root, 'docs/scope/parent.md', 'Parent', [ticket('T-0001', 'done'), ticket('T-0002', 'todo'), ticket('T-0003', 'todo')], NOW - 2000);
  await ledger(child, 'docs/scope/child.md', 'Child', [ticket('T-1001', 'done'), ticket('T-1002', 'done'), ticket('T-1003', 'todo'), ticket('T-1004', 'todo')], NOW - 1000);

  const parent = { id: projectId(root), root, name: 'parent' };
  const childProject = { id: projectId(child), root: child, name: 'child' };
  const emptyProject = { id: projectId(empty), root: empty, name: 'empty' };
  const snapshot = await boardSnapshot({ projects: [parent, childProject, emptyProject], liveRuns: [], now: NOW });
  const parentOverview = snapshot.projects.find(project => project.id === parent.id);
  const childOverview = snapshot.projects.find(project => project.id === childProject.id);
  const emptyOverview = snapshot.projects.find(project => project.id === emptyProject.id);

  assert.equal(childOverview.worktree, true);
  assert.equal(childOverview.progress.headline, 'build 2/4');
  assert.equal(childOverview.tickets.open, 2);
  assert.equal(emptyOverview.worktree, true);
  assert.equal(emptyOverview.progress.headline, 'no ledger');
  assert.equal(emptyOverview.tickets.total, 0);
  assert.match(parentOverview.progress.headline, /build 3\/7 \(incl\. 2 worktrees\)$/);
  assert.notEqual(parentOverview.progress.headline, childOverview.progress.headline);
});
