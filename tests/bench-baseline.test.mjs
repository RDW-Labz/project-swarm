// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectBaseline, formatBaseline, writeBaseline, isTimingFailure } from '../tools/bench-baseline.mjs';

const CANARY = 'BENCH_CANARY_DO_NOT_LEAK_9f3c2a';
const SINCE = '2026-01-01T00:00:00.000Z';
const UNTIL = '2026-01-31T23:59:59.999Z';
const NOW = Date.parse('2026-01-20T12:00:00.000Z');

function fixtureReaders(data) {
  return {
    readRuns: async () => data.runs,
    readLedger: async () => data.ledger,
    readTicketLog: async () => data.ticketLog,
    readJournal: async () => data.journal,
    readOrchestratorEvents: async () => data.orchEvents ?? [],
    readHandbuildLog: async () => data.handbuildLog ?? '',
    readSpendStore: async () => data.spendStore ?? null,
    readOrchestratorUsage: async () => data.orchUsage ?? null,
  };
}

function baseFixture() {
  const ticketLog = [
    { at: '2026-01-05T09:00:00.000Z', event: 'transition', id: 'T-0001', from: 'todo', to: 'ready' },
    { at: '2026-01-06T09:00:00.000Z', event: 'transition', id: 'T-0002', from: 'todo', to: 'ready' },
    { at: '2026-01-07T09:00:00.000Z', event: 'transition', id: 'T-0003', from: 'todo', to: 'ready' },
    { at: '2026-01-07T14:00:00.000Z', event: 'transition', id: 'T-0003', from: 'review', to: 'done' },
    { at: '2026-02-01T10:00:00.000Z', event: 'transition', id: 'T-0099', from: 'todo', to: 'ready' },
  ].map(l => JSON.stringify(l)).join('\n');

  const ledger = {
    version: 1,
    scope: { name: 'bench-fixture' },
    tickets: [
      { id: 'T-0001', title: CANARY, type: 'build', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'done', pr: 1 },
      { id: 'T-0002', title: 'second', type: 'build', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'done', pr: 2 },
      { id: 'T-0003', title: 'third no pr', type: 'build', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'done' },
    ],
  };

  const runs = [{
    id: 'run-a',
    waves: [
      { at: '2026-01-08T10:00:00.000Z', slots: 4, readyTickets: ['T-0001', 'T-0002'] },
      { at: '2026-02-05T10:00:00.000Z', slots: 4, readyTickets: ['T-0099'] },
    ],
    jobs: [
      {
        id: 'job-paid-retry',
        ticketId: 'T-0001',
        agent: 'openrouter',
        role: 'worker',
        status: 'complete',
        retries: 1,
        startedAt: '2026-01-05T10:00:00.000Z',
        finishedAt: '2026-01-05T11:00:00.000Z',
        costUsd: 2,
      },
      {
        id: 'job-free',
        ticketId: 'T-0002',
        agent: 'cursor',
        role: 'worker',
        status: 'complete',
        retries: 0,
        startedAt: '2026-01-06T10:00:00.000Z',
        finishedAt: '2026-01-06T11:00:00.000Z',
        costUsd: 1.5,
      },
      {
        id: 'job-review',
        ticketId: 'T-0001',
        agent: 'anthropic',
        role: 'review',
        status: 'complete',
        retries: 0,
        startedAt: '2026-01-05T11:30:00.000Z',
        finishedAt: '2026-01-05T12:00:00.000Z',
        costUsd: 0.5,
      },
      {
        id: 'job-flaky',
        ticketId: 'T-0003',
        agent: 'codex',
        role: 'worker',
        status: 'failed',
        retries: 0,
        startedAt: '2026-01-07T10:00:00.000Z',
        finishedAt: '2026-01-07T10:05:00.000Z',
        error: 'test timed out waiting for assertion',
      },
    ],
  }];

  const journal = [
    { ts: '2026-01-10T15:00:00.000Z', kind: 'decision', id: 'd1' },
    { ts: '2026-02-02T15:00:00.000Z', kind: 'decision', id: 'd-out' },
    { ts: '2026-01-11T12:00:00.000Z', kind: 'action', action: 'dirty-tree' },
    { ts: '2026-01-12T12:00:00.000Z', kind: 'action', action: 'branch-switch' },
    { ts: '2026-01-13T12:00:00.000Z', kind: 'action', action: 'guard-false-positive' },
  ];

  const handbuildLog = [
    { at: '2026-01-14T12:00:00.000Z', event: 'approve', by: 'owner', id: 'hb-1' },
  ].map(l => JSON.stringify(l)).join('\n');

  return {
    ledger,
    ticketLog,
    runs,
    journal,
    handbuildLog,
    orchUsage: { allTokens: 90000 },
    mergedPullRequests: [
      { number: 1, mergedAt: '2026-01-05T12:00:00.000Z', createdAt: '2026-01-04T00:00:00.000Z', title: CANARY },
      { number: 2, mergedAt: '2026-01-06T11:00:00.000Z', createdAt: '2026-01-05T00:00:00.000Z', title: 'secret title' },
      { number: 99, mergedAt: '2026-02-10T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z', title: 'out of window' },
    ],
  };
}

test('isTimingFailure recognizes timing causes', () => {
  assert.equal(isTimingFailure('test timed out'), true);
  assert.equal(isTimingFailure('assertion failed'), false);
});

test('collectBaseline: metrics, privacy, billing, window, and missing sources', async () => {
  const data = baseFixture();
  const baseline = await collectBaseline({
    root: '/unused',
    project: 'fixture',
    since: SINCE,
    until: UNTIL,
    now: () => NOW,
    readers: fixtureReaders(data),
    mergedPullRequests: data.mergedPullRequests,
  });

  assert.equal(baseline.version, 1);
  assert.equal(baseline.perTicket.length, 3);

  const t1 = baseline.perTicket.find(t => t.id === 'T-0001');
  assert.equal(t1.readyToMergedMs, 3 * 60 * 60 * 1000);
  assert.equal(t1.billedUsd.workers, 2);
  assert.equal(t1.billedUsd.reviews, 0.5);
  assert.equal(t1.listUsd.workers, 2);
  assert.equal(t1.listUsd.reviews, 0.5);

  const t2 = baseline.perTicket.find(t => t.id === 'T-0002');
  assert.equal(t2.billedUsd.workers, 0);
  assert.equal(t2.listUsd.workers, 1.5);

  const t3 = baseline.perTicket.find(t => t.id === 'T-0003');
  assert.equal(t3.readyToMergedMs, 5 * 60 * 60 * 1000);

  assert.equal(baseline.metrics.billed_usd.value.workers, 2);
  assert.equal(baseline.metrics.billed_usd.value.reviews, 0.5);
  assert.equal(baseline.metrics.list_usd.value.workers, 3.5);

  assert.equal(baseline.metrics.retries.value, 1);
  assert.equal(baseline.metrics.first_try_pass_rate.value, 2 / 3);
  assert.equal(baseline.metrics.flaky_failures.value, 1);
  assert.equal(baseline.metrics.flaky_failures.status, 'estimated');

  assert.equal(baseline.metrics.ready_to_merged_ms.status, 'estimated');
  assert.equal(baseline.metrics.ready_to_merged_ms.value, (3 * 3600000 + 2 * 3600000 + 5 * 3600000) / 3);

  assert.equal(baseline.metrics.idle_slot_pct.status, 'estimated');
  assert.equal(baseline.metrics.idle_slot_pct.value, 50);

  assert.equal(baseline.metrics.dirty_tree_incidents.value, 1);
  assert.equal(baseline.metrics.branch_switch_incidents.value, 1);
  assert.equal(baseline.metrics.guard_false_positives.value, 1);

  assert.equal(baseline.metrics.orchestrator_tokens_per_merged_ticket.value, 30000);

  assert.equal(baseline.metrics.owner_interruptions_per_day.value, 2);
  assert.deepEqual(baseline.perDay, [{ day: '2026-01-10', interruptions: 1 }, { day: '2026-01-14', interruptions: 1 }]);

  const blob = JSON.stringify(baseline);
  assert.equal(blob.includes(CANARY), false);
  assert.equal(blob.includes('secret title'), false);

  const table = formatBaseline(baseline);
  assert.ok(table.split('\n').length <= 40);
  assert.equal(table.includes(CANARY), false);

  const missing = await collectBaseline({
    root: '/unused',
    project: 'empty',
    since: SINCE,
    until: UNTIL,
    now: () => NOW,
    readers: fixtureReaders({
      runs: [],
      ledger: null,
      ticketLog: '',
      journal: null,
      orchEvents: [],
      handbuildLog: '',
      spendStore: null,
      orchUsage: null,
    }),
    mergedPullRequests: [],
  });
  assert.equal(missing.metrics.ready_to_merged_ms.status, 'missing');
  assert.equal(missing.metrics.billed_usd.status, 'missing');
  assert.equal(missing.metrics.orchestrator_tokens_per_merged_ticket.status, 'missing');
  assert.equal(missing.metrics.owner_interruptions_per_day.status, 'missing');
});

test('writeBaseline writes mode 0600 atomically', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-bl-'));
  const file = path.join(dir, 'baseline.json');
  const data = baseFixture();
  const baseline = await collectBaseline({
    root: dir,
    project: 'fixture',
    since: SINCE,
    until: UNTIL,
    now: () => NOW,
    readers: fixtureReaders(data),
    mergedPullRequests: data.mergedPullRequests,
  });
  await writeBaseline({ baseline, file });
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(parsed.project, 'fixture');
});
