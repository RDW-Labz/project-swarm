// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeLoop } from '../tools/scope-loop.mjs';
import { acceptanceReviewSkipWarning } from '../tools/acceptance.mjs';

const ticket = (id, extra = {}) => ({
  id,
  title: id,
  type: 'build',
  status: 'review',
  files: [`src/current/${id}.mjs`],
  context: [`current context for ${id}`],
  ...extra,
});

const idle = async () => { throw Object.assign(new Error('no ready tickets'), { code: 'scope-nothing' }); };

function reviewDeps(tickets, overrides = {}) {
  const calls = [];
  const journal = [];
  const current = tickets.map(t => ({ ...t }));
  const deps = {
    stopped: async () => null,
    prepare: idle,
    ledger: async () => ({ tickets: current }),
    review: async (kind, file, context) => {
      calls.push({ kind, file, context });
      return { runId: `review-${calls.length}` };
    },
    record: async (kind, runId) => {
      calls.push({ kind: 'record', reviewKind: kind, runId });
      current.forEach(t => { if (t.status === 'review') t.status = 'done'; });
    },
    journal: async event => journal.push(event),
    now: () => '2026-10-21T17:00:00.000Z',
    log: () => {},
    ...overrides,
  };
  return { deps, calls, journal, current };
}

test('resume queues an acceptance review for every review ticket with no recorded review run', async () => {
  const f = reviewDeps(Array.from({ length: 10 }, (_, n) => ticket(`T-${n + 1}`)));
  const out = await scopeLoop({ deps: f.deps });
  assert.equal(out.status, 'complete');
  const starts = f.calls.filter(call => call.kind === 'acceptance');
  assert.equal(starts.length, 10);
  assert.deepEqual(starts.map(call => call.context.ticketIds), Array.from({ length: 10 }, (_, n) => [`T-${n + 1}`]));
  assert.ok(starts.every(call => call.file.startsWith('.swarm/acceptance-reviews/resume-')));
});

test('a review that cannot start is skipped with a named warning and the loop continues', async () => {
  const reason = 'review runner rejected path lessons/swarm because it is a directory';
  const notes = new Map();
  const warnings = [];
  const f = reviewDeps([ticket('T-1')], {
    review: async (kind, file, context) => {
      f.calls.push({ kind, file, context });
      throw new Error(reason);
    },
    ticketNote: async (id, text) => { notes.set(id, text); },
    log: text => { if (String(text).startsWith('acceptance-review-skipped:')) warnings.push(text); },
  });
  const out = await scopeLoop({ deps: f.deps });
  assert.equal(out.status, 'stuck');
  assert.match(out.reason, /nothing is ready: 1 in review/);
  assert.equal(f.current[0].status, 'review');
  assert.match(notes.get('T-1'), /acceptance review skipped: review runner rejected path lessons\/swarm/);
  assert.equal(warnings[0], acceptanceReviewSkipWarning('T-1', reason));
  assert.equal(f.journal.length, 0);
  assert.equal(f.calls.filter(call => call.kind === 'acceptance').length, 1);
});

test('a saved acceptance manifest is overwritten with the current ticket context on review start', async () => {
  const manifests = new Map([
    ['.swarm/acceptance-reviews/resume-1-T-1.json', { files: ['lessons/swarm'] }],
  ]);
  const f = reviewDeps([ticket('T-1', { files: ['src/current/route.mjs'] })], {
    review: async (kind, file, context) => {
      manifests.set(file, { kind, files: context.tickets[0].files, context: context.tickets[0].context });
      return { runId: 'review-current' };
    },
  });
  const out = await scopeLoop({ deps: f.deps });
  assert.equal(out.status, 'complete');
  assert.deepEqual(manifests.get('.swarm/acceptance-reviews/resume-1-T-1.json'), {
    kind: 'acceptance',
    files: ['src/current/route.mjs'],
    context: ['current context for T-1'],
  });
});
