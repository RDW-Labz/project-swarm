// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scopeLoop } from '../tools/scope-loop.mjs';
import { acceptanceReviewSkipNote, acceptanceReviewSkipWarning } from '../tools/acceptance.mjs';

const git = (root, ...args) => spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });

const ticket = (id, extra = {}) => ({
  id,
  title: id,
  type: 'build',
  status: 'ready',
  scopeRefs: ['R-8020'],
  acceptance: ['output is written in the target worktree'],
  files: [`src/${id}.mjs`],
  tests: [],
  context: [`src/${id}.mjs`],
  size: 'S',
  risk: 'low',
  ...extra,
});

async function repo(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-skip-'));
  const root = path.join(parent, 'repo');
  await fs.mkdir(root);
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
  assert.equal(git(root, 'add', 'README.md').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'seed').status, 0);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}

function waveDeps({ root, tickets, reviewFor }) {
  const notes = new Map();
  const reviewCalls = [];
  let resumePasses = 0;
  const ledger = { tickets };
  const deps = {
    root,
    stopped: async () => null,
    prepare: async () => {
      const ready = tickets.filter(item => item.status === 'ready');
      if (!ready.length) throw Object.assign(new Error('no ready tickets'), { code: 'scope-nothing' });
      ready.forEach(item => { item.status = 'running'; });
      return { file: 'wave.json', ids: ready.map(item => item.id) };
    },
    ledger: async () => ledger,
    runWave: async (_file, options) => {
      for (const item of tickets) {
        const target = options?.roots?.[item.id] ?? options?.root ?? root;
        await fs.mkdir(path.dirname(path.join(target, item.files[0])), { recursive: true });
        await fs.writeFile(path.join(target, item.files[0]), `// ${item.id}\n`);
      }
      return { status: 'committed', stage: 'commit', runId: 'wave-8020', integrate: { files: tickets.flatMap(item => item.files) } };
    },
    sync: async (_runId, { integrated }) => {
      if (!integrated) {
        tickets.forEach(item => { if (item.status === 'running') item.status = 'review'; });
        return 'review';
      }
      const pending = tickets.filter(item => item.status === 'review');
      if (pending.length) {
        return 'Run: swarm run .swarm/acceptance-reviews/wave-8020.json';
      }
      tickets.forEach(item => { if (item.status === 'review') item.status = 'done'; });
      return 'done';
    },
    salvage: async () => ({ integrated: true, jobs: 0 }),
    review: async (kind, file, context) => {
      reviewCalls.push({ kind, file, ticketIds: context.ticketIds });
      const id = context.ticketIds[0];
      const outcome = reviewFor(id, { kind, file, context, calls: reviewCalls });
      if (outcome?.throw) throw outcome.throw;
      return { runId: outcome?.runId ?? `review-${reviewCalls.length}` };
    },
    record: async (_kind, _runId, context) => {
      for (const id of context.ticketIds) {
        const item = tickets.find(ticket => ticket.id === id);
        if (item?.status === 'review') item.status = 'done';
      }
    },
    revert: async () => {},
    ticketNote: async (id, text) => { notes.set(id, text); },
    log: () => {},
  };
  return {
    deps,
    notes,
    reviewCalls,
    countResumePasses: () => {
      resumePasses += 1;
      return resumePasses;
    },
  };
}

test('acceptance skip helpers use the required note and warning shapes', () => {
  const reason = 'target-worktree-unknown: /tmp/other';
  assert.equal(
    acceptanceReviewSkipNote(reason),
    'acceptance review skipped: target-worktree-unknown: /tmp/other; run it by hand with swarm scope acceptance-review after the wave',
  );
  assert.equal(acceptanceReviewSkipWarning('T-8022', reason), 'acceptance-review-skipped: T-8022: target-worktree-unknown: /tmp/other');
});

test('one ticket in another worktree is skipped while the rest of the wave completes', async t => {
  const root = await repo(t);
  const linked = path.join(path.dirname(root), 'linked');
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'linked', linked).status, 0);
  const linkedReal = await fs.realpath(linked);
  const tickets = [
    ticket('T-8020'),
    ticket('T-8021'),
    ticket('T-8022', { targetWorktree: linkedReal, files: ['src/T-8022.mjs'], context: ['src/T-8022.mjs'] }),
  ];
  await fs.mkdir(path.dirname(path.join(root, 'src/T-8020.mjs')), { recursive: true });
  await fs.writeFile(path.join(root, 'src/T-8020.mjs'), '// local\n');
  await fs.writeFile(path.join(root, 'src/T-8021.mjs'), '// local\n');
  const fixture = waveDeps({
    root,
    tickets,
    reviewFor: id => (id === 'T-8022' ? { throw: new Error('manifest missing context file src/T-8022.mjs') } : {}),
  });
  fixture.deps.prepareAcceptanceReview = async ({ ticket, file }) => {
    if (ticket.id === 'T-8022') {
      throw new Error('manifest missing context file src/T-8022.mjs');
    }
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), '{"version":1,"jobs":[]}\n');
  };
  const out = await scopeLoop({ deps: fixture.deps, root });
  assert.equal(out.status, 'stuck');
  assert.equal(out.summary.done, 2);
  assert.equal(out.summary.review, 1);
  assert.equal(tickets.find(item => item.id === 'T-8020').status, 'done');
  assert.equal(tickets.find(item => item.id === 'T-8021').status, 'done');
  assert.equal(tickets.find(item => item.id === 'T-8022').status, 'review');
  assert.match(fixture.notes.get('T-8022'), /acceptance review skipped: manifest missing context file src\/T-8022\.mjs/);
  assert.ok(out.waves[0].warnings.some(w => w === 'acceptance-review-skipped: T-8022: manifest missing context file src/T-8022.mjs'));
  assert.equal(fixture.reviewCalls.filter(call => call.ticketIds.includes('T-8022')).length, 0);
  assert.equal(fixture.reviewCalls.filter(call => call.kind === 'acceptance').length, 2);
});

test('a review-start exception for one ticket is skipped and does not stall the loop', async t => {
  const root = await repo(t);
  const tickets = [ticket('T-8030'), ticket('T-8031')];
  for (const item of tickets) {
    await fs.mkdir(path.dirname(path.join(root, item.files[0])), { recursive: true });
    await fs.writeFile(path.join(root, item.files[0]), `// ${item.id}\n`);
  }
  const fixture = waveDeps({
    root,
    tickets,
    reviewFor: id => (id === 'T-8031'
      ? { throw: Object.assign(new Error('review runner rejected path lessons/swarm because it is a directory'), { code: 'review-start' }) }
      : {}),
  });
  fixture.deps.prepareAcceptanceReview = async ({ file }) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), '{"version":1,"jobs":[]}\n');
  };
  const out = await scopeLoop({ deps: fixture.deps, root });
  assert.equal(out.status, 'stuck');
  assert.equal(out.summary.done, 1);
  assert.equal(out.summary.review, 1);
  assert.equal(tickets[0].status, 'done');
  assert.equal(tickets[1].status, 'review');
  assert.match(fixture.notes.get('T-8031'), /acceptance review skipped: review runner rejected path lessons\/swarm/);
  assert.ok(out.waves[0].warnings.some(w => w.startsWith('acceptance-review-skipped: T-8031:')));
  assert.equal(fixture.reviewCalls.filter(call => call.ticketIds.includes('T-8031')).length, 1);
});

test('resume acceptance reviews do not spin on a ticket that was already skipped', async () => {
  const tickets = [
    { ...ticket('T-8040'), status: 'review' },
    { ...ticket('T-8041'), status: 'review' },
  ];
  const reviewCalls = [];
  const notes = new Map();
  const prepareCalls = new Map();
  const deps = {
    root: '/tmp/fake-root',
    stopped: async () => null,
    prepare: async () => { throw Object.assign(new Error('no ready tickets'), { code: 'scope-nothing' }); },
    ledger: async () => ({ tickets }),
    review: async (kind, file, context) => {
      reviewCalls.push({ kind, file, ticketIds: context.ticketIds });
      if (context.ticketIds[0] === 'T-8040') throw new Error('review could not start for T-8040');
      return { runId: 'review-8041' };
    },
    record: async (_kind, _runId, context) => {
      for (const id of context.ticketIds) {
        const item = tickets.find(ticket => ticket.id === id);
        if (item) item.status = 'done';
      }
    },
    ticketNote: async (id, text) => { notes.set(id, text); },
    prepareAcceptanceReview: async ({ ticket }) => {
      prepareCalls.set(ticket.id, (prepareCalls.get(ticket.id) ?? 0) + 1);
    },
    log: () => {},
  };
  const out = await scopeLoop({ deps, root: '/tmp/fake-root' });
  assert.equal(out.status, 'stuck');
  assert.equal(tickets[0].status, 'review');
  assert.equal(tickets[1].status, 'done');
  assert.equal(prepareCalls.get('T-8040') ?? 0, 1, 'skipped ticket is not retried on resume');
  assert.equal(prepareCalls.get('T-8041') ?? 0, 1);
  assert.equal(reviewCalls.filter(call => call.ticketIds.includes('T-8040')).length, 1);
  assert.match(notes.get('T-8040'), /acceptance review skipped/);
});
