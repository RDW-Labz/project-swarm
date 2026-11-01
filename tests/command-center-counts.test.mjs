// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketCountsOf } from '../tools/ticket-counts.mjs';
import {
  buildCommandCenterSnapshot,
  buildProjectCockpit,
  patchCommandCenterSnapshot,
  mergeCardTicketCounts,
} from '../tools/command-center-snapshot.mjs';

const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));

async function loadHivePanels() {
  const code = await fs.readFile(path.join(assets, 'hive-panels.js'), 'utf8');
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(code, sandbox, { filename: 'hive-panels.js' });
  return sandbox.module.exports;
}

test('ticketCountsOf: live set, human included, footer statuses, ready deps, rounding', () => {
  const empty = ticketCountsOf(null);
  assert.deepEqual(empty, {
    total: 0, done: 0, ready: 0, review: 0, blocked: 0, todo: 0,
    cancelled: 0, proposed: 0, superseded: 0, remaining: 0, percentDone: 0, counted: 0,
  });

  const ledger = {
    tickets: [
      { id: 'T-1', status: 'done', type: 'build' },
      { id: 'T-2', status: 'cancelled', type: 'build' },
      { id: 'T-3', status: 'proposed', type: 'build' },
      { id: 'T-4', status: 'superseded', type: 'build' },
      { id: 'T-5', status: 'review', type: 'human' },
      { id: 'T-6', status: 'todo', type: 'build', dependsOn: ['T-7'] },
      { id: 'T-7', status: 'todo', type: 'build' },
      { id: 'T-8', status: 'ready', type: 'build', dependsOn: ['T-1'] },
      { id: 'T-9', status: 'todo', origin: 'comment', type: 'build' },
    ],
  };
  const c = ticketCountsOf(ledger);
  assert.equal(c.total, 6, 'live tickets include human and exclude cancelled/proposed/superseded');
  assert.equal(c.done, 1);
  assert.equal(c.ready, 2, 'T-7 and T-8; T-6 waits on T-7; unapproved proposal not ready');
  assert.equal(c.review, 1);
  assert.equal(c.cancelled, 1);
  assert.equal(c.proposed, 1);
  assert.equal(c.superseded, 1);
  assert.equal(c.percentDone, 17);
  assert.equal(c.counted, c.total);
});

test('snapshot prefers board counts over byStatus and exposes totals', () => {
  const board = {
    at: '2026-10-26T12:00:00.000Z',
    machine: { agents: { total: 0 } },
    projects: [{
      id: 'p',
      name: 'P',
      card: { blocked: { needYou: 3 }, now: { buildingTickets: 0 }, next: { ready: 99 } },
      tickets: { byStatus: { done: 1, ready: 99, todo: 50 } },
      counts: {
        total: 10, done: 5, ready: 2, review: 1, blocked: 1, todo: 1,
        cancelled: 0, proposed: 0, superseded: 0, remaining: 5, percentDone: 50, counted: 10,
      },
      ledger: { tickets: [{ id: 'X', status: 'ready' }] },
    }],
  };
  const snap = buildCommandCenterSnapshot(board);
  assert.equal(snap.projects[0].ticketCounts.total, 10);
  assert.equal(snap.projects[0].ticketCounts.ready, 2);
  assert.equal(snap.totals.tickets, 10);
  assert.equal(snap.totals.percentDone, 50);
});

test('hive card and cockpit counts agree on one board fixture', async () => {
  const board = {
    at: '2026-10-26T12:00:00.000Z',
    machine: { agents: { total: 1 } },
    projects: [{
      id: 'swarm',
      name: 'project-swarm',
      agents: { total: 1, jobs: { running: 1 } },
      card: { blocked: { needYou: 8 }, now: { buildingTickets: 1 }, next: { ready: 70 } },
      tickets: { byStatus: { done: 230, ready: 70, review: 20, blocked: 10, todo: 100, cancelled: 5 } },
      counts: {
        total: 408, done: 237, ready: 15, review: 12, blocked: 8, todo: 136,
        cancelled: 3, proposed: 0, superseded: 0, remaining: 171, percentDone: 58, counted: 408,
      },
      ledger: {
        tickets: Array.from({ length: 70 }, (_, i) => ({ id: `R-${i}`, status: 'ready', title: 'x' }))
          .concat([{ id: 'D-1', status: 'done', title: 'd' }]),
      },
    }],
  };
  const snap = buildCommandCenterSnapshot(board);
  const card = snap.projects[0].ticketCounts;
  const cockpit = buildProjectCockpit(board, 'swarm');
  assert.equal(cockpit.counts.total, card.total);
  assert.equal(cockpit.counts.done, card.done);
  assert.equal(cockpit.counts.percentDone, card.percentDone);
  assert.equal(cockpit.counts.ready, card.ready);
  assert.equal(cockpit.counts.needsYou, 8);
  assert.notEqual(cockpit.counts.ready, 70, 'stripped ledger must not drive READY headline');
  const { deriveHiveView } = await loadHivePanels();
  const view = deriveHiveView(snap);
  assert.equal(view.projects[0].counts.ready, card.ready);
  assert.equal(view.totals.ready, snap.totals.ready);
});

test('patchCommandCenterSnapshot matches full rebuild for counts and totals', () => {
  const base = {
    at: '2026-10-26T12:00:00.000Z',
    machine: { agents: { total: 2 } },
    projects: [
      { id: 'a', name: 'A', card: { blocked: { needYou: 1 }, now: {}, next: {} }, counts: { total: 4, done: 1, ready: 1, review: 0, blocked: 0, todo: 2, cancelled: 0, proposed: 0, superseded: 0, remaining: 3, percentDone: 25, counted: 4 } },
      { id: 'b', name: 'B', card: { blocked: { needYou: 0 }, now: {}, next: {} }, counts: { total: 2, done: 2, ready: 0, review: 0, blocked: 0, todo: 0, cancelled: 0, proposed: 0, superseded: 0, remaining: 0, percentDone: 100, counted: 2 } },
    ],
  };
  const snap = buildCommandCenterSnapshot(base);
  const patchedBoard = {
    ...base,
    at: '2026-10-26T12:05:00.000Z',
    projects: [
      { ...base.projects[0], card: { blocked: { needYou: 5 }, now: {}, next: {} }, counts: { total: 10, done: 4, ready: 3, review: 1, blocked: 1, todo: 1, cancelled: 1, proposed: 0, superseded: 0, remaining: 6, percentDone: 40, counted: 10 } },
      base.projects[1],
    ],
  };
  patchCommandCenterSnapshot(snap, patchedBoard, ['a']);
  const fresh = buildCommandCenterSnapshot(patchedBoard);
  assert.deepEqual(snap.projects.find(p => p.id === 'a').ticketCounts, fresh.projects.find(p => p.id === 'a').ticketCounts);
  assert.deepEqual(snap.totals, fresh.totals);
  assert.equal(snap.stats.needsYouCount.value, 5);
});

test('stripped commandCenterLedger plus server counts: counts win for card shape', () => {
  const project = {
    id: 'x',
    card: { blocked: { needYou: 2 } },
    ledger: { tickets: [{ id: 'A', status: 'ready' }, { id: 'B', status: 'todo' }] },
    counts: {
      total: 9,
      done: 4,
      ready: 0,
      review: 0,
      blocked: 0,
      todo: 1,
      cancelled: 0,
      proposed: 0,
      superseded: 0,
      remaining: 5,
      percentDone: 44,
      counted: 9,
    },
  };
  const shaped = mergeCardTicketCounts(project, 0);
  assert.equal(shaped.ready, 0, 'server ready wins over stripped rows that look ready');
  assert.equal(shaped.total, 9, 'server total differs from two stripped rows');
  assert.equal(shaped.done, 4);
  assert.equal(shaped.needsYou, 2);
  assert.equal(shaped.source, 'projects[0].counts');
  const fromLedger = mergeCardTicketCounts({ ...project, counts: undefined }, 0);
  assert.notEqual(fromLedger?.total, 9, 'ledger fallback is distinguishable');
});
