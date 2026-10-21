// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wavesOf } from '../tools/tickets.mjs';
import { ledgerSummary } from '../tools/scope-loop.mjs';
import {
  buildProgressStats,
  ledgerBuildSummary,
  wavePlanningTickets,
  waveBlockingTicketIds,
  waveBlockingCount,
  ownerHumanChecklists,
} from '../tools/human-progress.mjs';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const tk = (id, over = {}) => ({
  id,
  title: `Ticket ${id}`,
  type: 'build',
  stage: 'S1',
  scopeRefs: ['R-001'],
  acceptance: ['ok'],
  files: ['src/a.mjs'],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  status: 'todo',
  ...over,
});

test('AC1: human tickets do not count toward build progress or block wave planning', () => {
  const tickets = [
    tk('T-1', { status: 'done' }),
    tk('T-2', { status: 'todo' }),
    tk('H-1', { type: 'human', scopeRefs: [], acceptance: [], steps: ['Create Stripe'], status: 'todo' }),
    tk('H-2', { type: 'human', scopeRefs: [], acceptance: [], steps: ['DNS'], status: 'done' }),
  ];
  assert.deepEqual(buildProgressStats(tickets), { total: 2, done: 1, percentDone: 50 });

  const ledger = { tickets };
  const all = ledgerSummary(ledger);
  const build = ledgerBuildSummary(ledger);
  assert.equal(all.total, 4);
  assert.equal(build.total, 2);
  assert.equal(build.done, 1);
  assert.equal(build.humans, 1);

  const waitingOnHuman = [
    tk('T-1', { status: 'done' }),
    tk('T-2', { dependsOn: ['H-1'], status: 'todo' }),
    tk('H-1', { type: 'human', scopeRefs: [], acceptance: [], steps: ['Go'], status: 'todo' }),
  ];
  assert.deepEqual(waveBlockingTicketIds(waitingOnHuman), []);
  assert.equal(waveBlockingCount(waitingOnHuman), 0);
  const planned = wavePlanningTickets(waitingOnHuman);
  const waves = wavesOf(planned);
  assert.equal(waves.length, 1, 'human dependency must not push T-2 to a later wave');
  assert.ok(waves[0].includes('T-2'));
  const withHuman = wavesOf(waitingOnHuman.filter((t) => t.status !== 'cancelled' && t.status !== 'proposed'));
  assert.equal(withHuman.length, 2, 'with human tickets, T-2 waits on H-1 in a later wave');

  const blockedChain = [
    tk('T-1', { status: 'blocked' }),
    tk('T-2', { dependsOn: ['T-1'], status: 'todo' }),
  ];
  assert.deepEqual(waveBlockingTicketIds(blockedChain), ['T-1', 'T-2']);
});

test('AC2: they appear to the owner as a checklist with steps', () => {
  const tickets = [
    tk('H-9', {
      type: 'human',
      title: 'Day 0: Stripe',
      scopeRefs: [],
      acceptance: [],
      status: 'todo',
      steps: ['Create the Stripe account', 'Store API keys'],
    }),
    tk('T-1', { status: 'running' }),
  ];
  const lists = ownerHumanChecklists(tickets, { now: NOW });
  assert.equal(lists.length, 1);
  assert.equal(lists[0].id, 'H-9');
  assert.equal(lists[0].title, 'Day 0: Stripe');
  assert.equal(lists[0].done, false);
  assert.deepEqual(lists[0].steps, ['Create the Stripe account', 'Store API keys']);
  assert.equal(lists[0].updatedAt, new Date(NOW).toISOString());

  const closed = ownerHumanChecklists(
    [tk('H-9', { type: 'human', scopeRefs: [], acceptance: [], status: 'done', steps: ['Done step'], updatedAt: '2026-10-20T00:00:00.000Z' })],
    { now: NOW },
  );
  assert.equal(closed[0].done, true);
  assert.equal(closed[0].updatedAt, '2026-10-20T00:00:00.000Z');
});
