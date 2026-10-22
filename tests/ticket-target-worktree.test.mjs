// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acceptanceInputs } from '../tools/acceptance.mjs';
import { scopeLoop } from '../tools/scope-loop.mjs';
import { createLedger, resolveTargetWorktree, validateTicket, writeLedger } from '../tools/tickets.mjs';

const git = (root, ...args) => spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
const ticket = (id, targetWorktree, extra = {}) => ({
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
  ...(targetWorktree === undefined ? {} : { targetWorktree }),
  ...extra,
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

test('createLedger accepts stage targetWorktree and validates stage and stageTargets entries', () => {
  const scope = { name: 'stage targets', stages: [{ id: 'S1', title: 'First', targetWorktree: '/tmp/worktree' }] };
  const ledger = createLedger({ scope, tickets: [ticket('T-8005', undefined, { stage: 'S1' })] });
  assert.equal(ledger.scope.stages[0].targetWorktree, '/tmp/worktree');
  assert.throws(
    () => createLedger({ scope: { stages: [{ id: 'S1', targetWorktree: '' }] } }),
    error => error.code === 'ticket-invalid' && /targetWorktree/.test(error.message),
  );
  assert.throws(
    () => createLedger({ scope: { stageTargets: { S1: '/tmp/worktree/../other' } } }),
    error => error.code === 'ticket-invalid' && /targetWorktree/.test(error.message),
  );
  const mapped = createLedger({ stageTargets: { S1: 'stage-one' }, tickets: [ticket('T-8005', undefined, { stage: 'S1' })] });
  assert.equal(mapped.stageTargets.S1, 'stage-one');
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

test('a stage target reaches dispatch, verify and acceptance review at the same worktree root', async t => {
  const root = await repository(t);
  const linked = path.join(path.dirname(root), 'stage-target');
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'stage-target', linked).status, 0);
  const target = await fs.realpath(linked);
  const item = ticket('T-8006', undefined, { stage: 'S1' });
  const ledger = createLedger({
    scope: { name: 'stage targets', stages: [{ id: 'S1', title: 'Stage one', targetWorktree: target }] },
    tickets: [item],
  });
  await writeLedger(root, ledger);
  assert.equal((await acceptanceInputs(root, item)).root, target);
  const calls = { dispatch: [], verify: [], review: [], record: [] };
  const deps = {
    root,
    stopped: async () => null,
    prepare: async () => {
      if (item.status === 'done') throw Object.assign(new Error('done'), { code: 'scope-nothing' });
      item.status = 'running';
      return { file: 'wave.json', ids: [item.id] };
    },
    ledger: async () => ledger,
    runWave: async (_file, options) => {
      calls.dispatch.push(options.root);
      return { status: 'committed', stage: 'commit', runId: 'build-stage-target', integrate: { files: [] } };
    },
    sync: async (_runId, options) => {
      calls.verify.push(options.root);
      if (!options.integrated) {
        item.status = 'review';
        return 'review';
      }
      if (calls.review.length === 0) {
        item.status = 'done';
        return 'Run: swarm run .swarm/acceptance-reviews/stage-target.json';
      }
      item.status = 'done';
      return 'done';
    },
    review: async (_kind, _file, _context, options) => {
      calls.review.push(options.root);
      return { runId: 'acceptance-stage-target' };
    },
    record: async (_kind, _runId, _context, options) => { calls.record.push(options.root); },
    salvage: async () => ({ integrated: true, jobs: 0 }),
    revert: async () => {},
    log: () => {},
  };
  const result = await scopeLoop({ deps });
  assert.equal(result.status, 'complete');
  assert.deepEqual(calls.dispatch, [target]);
  assert.deepEqual(calls.verify, [target, target, target]);
  assert.deepEqual(calls.review, [target]);
  assert.deepEqual(calls.record, [target]);
});

test('two stage targets in one wave keep dispatch roots and output files separate', async t => {
  const root = await repository(t);
  const first = path.join(path.dirname(root), 'stage-first');
  const second = path.join(path.dirname(root), 'stage-second');
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'stage-first', first).status, 0);
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'stage-second', second).status, 0);
  const firstReal = await fs.realpath(first);
  const secondReal = await fs.realpath(second);
  const tickets = [
    ticket('T-8007', undefined, { stage: 'S1' }),
    ticket('T-8008', undefined, { stage: 'S2' }),
  ];
  const ledger = createLedger({
    scope: {
      name: 'two stages',
      stages: [
        { id: 'S1', title: 'First', targetWorktree: firstReal },
        { id: 'S2', title: 'Second', targetWorktree: secondReal },
      ],
    },
    tickets,
  });
  const dispatch = [];
  const verify = [];
  const deps = {
    root,
    stopped: async () => null,
    prepare: async () => {
      if (tickets.every(item => item.status === 'done')) throw Object.assign(new Error('done'), { code: 'scope-nothing' });
      tickets.forEach(item => { item.status = 'running'; });
      return { file: 'wave.json', ids: tickets.map(item => item.id) };
    },
    ledger: async () => ledger,
    runWave: async (_file, options) => {
      dispatch.push(options.roots);
      for (const item of tickets) {
        const target = options.roots[item.id];
        await fs.mkdir(path.join(target, 'out'), { recursive: true });
        await fs.writeFile(path.join(target, 'out', `${item.id}.txt`), item.id);
      }
      return { status: 'committed', stage: 'commit', runId: 'build-two-stages', integrate: { files: [] } };
    },
    sync: async (_runId, options) => {
      verify.push(options.roots);
      if (options.integrated) tickets.forEach(item => { item.status = 'done'; });
      return 'done';
    },
    salvage: async () => ({ integrated: true, jobs: 0 }),
    review: async () => ({ runId: 'review-two-stages' }),
    record: async () => {},
    revert: async () => {},
    log: () => {},
  };
  const result = await scopeLoop({ deps });
  assert.equal(result.status, 'complete');
  assert.deepEqual(dispatch, [{ [tickets[0].id]: firstReal, [tickets[1].id]: secondReal }]);
  assert.deepEqual(verify, [
    { [tickets[0].id]: firstReal, [tickets[1].id]: secondReal },
    { [tickets[0].id]: firstReal, [tickets[1].id]: secondReal },
  ]);
  assert.equal(await fs.readFile(path.join(firstReal, 'out/T-8007.txt'), 'utf8'), 'T-8007');
  assert.equal(await fs.readFile(path.join(secondReal, 'out/T-8008.txt'), 'utf8'), 'T-8008');
  await assert.rejects(() => fs.access(path.join(root, 'out/T-8007.txt')));
  await assert.rejects(() => fs.access(path.join(root, 'out/T-8008.txt')));
  await assert.rejects(() => fs.access(path.join(firstReal, 'out/T-8008.txt')));
  await assert.rejects(() => fs.access(path.join(secondReal, 'out/T-8007.txt')));
});
