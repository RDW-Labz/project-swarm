// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scopeLoop } from '../tools/scope-loop.mjs';
import { resolveTargetWorktree, validateTicket } from '../tools/tickets.mjs';

const git = (root, ...args) => spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
const ticket = (id, targetWorktree) => ({
  id,
  title: id,
  type: 'build',
  scopeRefs: ['R-800'],
  acceptance: ['the output is written in its target worktree'],
  files: [`src/${id}.mjs`],
  tests: [],
  context: [],
  contracts: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  status: 'ready',
  targetWorktree,
});

async function repository(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'target-worktree-'));
  const root = path.join(parent, 'repo');
  await fs.mkdir(root);
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
  assert.equal(git(root, 'add', 'README.md').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'seed').status, 0);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}

test('validateTicket accepts targetWorktree and rejects malformed path targets', () => {
  const base = ticket('T-8003', '/tmp/worktree');
  assert.equal(validateTicket(base).ok, true);
  assert.equal(validateTicket({ ...base, targetWorktree: 'feature/one' }).ok, true);
  assert.equal(validateTicket({ ...base, targetWorktree: '' }).ok, false);
  assert.equal(validateTicket({ ...base, targetWorktree: `x${String.fromCharCode(0)}y` }).ok, false);
  assert.equal(validateTicket({ ...base, targetWorktree: 'x'.repeat(401) }).ok, false);
  assert.equal(validateTicket({ ...base, targetWorktree: '/tmp/worktree/../other' }).ok, false);
});

test('resolveTargetWorktree accepts a registered path or checked-out branch and refuses unknown targets', async t => {
  const root = await repository(t);
  const first = path.join(path.dirname(root), 'first');
  const second = path.join(path.dirname(root), 'second');
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'feature-first', first).status, 0);
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'feature-second', second).status, 0);
  const firstReal = await fs.realpath(first);
  const secondReal = await fs.realpath(second);
  assert.equal(await resolveTargetWorktree(root, firstReal), firstReal);
  assert.equal(await resolveTargetWorktree(root, 'feature-second'), secondReal);
  await assert.rejects(() => resolveTargetWorktree(root, 'not-checked-out'), error => error.code === 'target-worktree-unknown');
});

test('one wave with two targetWorktree tickets passes each resolved root and writes no cross-tree output', async t => {
  const root = await repository(t);
  const first = path.join(path.dirname(root), 'first');
  const second = path.join(path.dirname(root), 'second');
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'feature-first', first).status, 0);
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'feature-second', second).status, 0);
  const tickets = [ticket('T-8003', await fs.realpath(first)), ticket('T-8004', 'feature-second')];
  const calls = [];
  const deps = {
    root,
    stopped: async () => null,
    prepare: async () => {
      if (tickets.every(item => item.status === 'done')) throw Object.assign(new Error('done'), { code: 'scope-nothing' });
      tickets.forEach(item => { item.status = 'running'; });
      return { file: 'wave.json', ids: tickets.map(item => item.id) };
    },
    ledger: async () => ({ tickets }),
    runWave: async (_file, options) => {
      calls.push(options);
      for (const item of tickets) {
        await fs.mkdir(path.dirname(path.join(options.roots[item.id], 'out', `${item.id}.txt`)), { recursive: true });
        await fs.writeFile(path.join(options.roots[item.id], 'out', `${item.id}.txt`), item.id);
      }
      return { status: 'committed', stage: 'commit', runId: 'build-8003-8004', integrate: { files: [] } };
    },
    sync: async (_runId, { integrated }) => {
      if (integrated) tickets.forEach(item => { item.status = 'done'; });
      return 'done';
    },
    salvage: async () => ({ integrated: true, jobs: 0 }),
    review: async () => ({ runId: 'review-1' }),
    record: async () => {},
    revert: async () => {},
    log: () => {},
  };
  const result = await scopeLoop({ deps });
  assert.equal(result.status, 'complete');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].roots['T-8003'], await fs.realpath(first));
  assert.equal(calls[0].roots['T-8004'], await fs.realpath(second));
  assert.equal(await fs.readFile(path.join(first, 'out/T-8003.txt'), 'utf8'), 'T-8003');
  assert.equal(await fs.readFile(path.join(second, 'out/T-8004.txt'), 'utf8'), 'T-8004');
  await assert.rejects(() => fs.access(path.join(root, 'out/T-8003.txt')));
  await assert.rejects(() => fs.access(path.join(root, 'out/T-8004.txt')));
});
