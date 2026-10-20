// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACTIONS, autopilotStep, pickReadyTickets } from '../tools/autopilot.mjs';

const NOW = Date.parse('2030-01-01T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const BASE_ACTIONS = ['integrate', 'resume', 'retry-failed', 'start-wave', 'start-deferred', 'start-backlog', 'unlock-tickets'];

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-start-ready-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function ticket(id, files, extra = {}) {
  return { id, status: 'ready', files, dependsOn: [], type: 'build', ...extra };
}

function fakeDeps(opts = {}) {
  const { journal = [], runs = [], plan = null, ...fns } = opts;
  const calls = [];
  const deps = {
    calls,
    loadRuns: async () => { calls.push(['loadRuns']); return runs; },
    readJournal: async () => { calls.push(['readJournal']); return journal; },
    appendEvent: async (root, event) => {
      calls.push(['appendEvent', event]);
      journal.push({ ...event, ts: iso(NOW) });
      return event;
    },
    readPlan: async () => { calls.push(['readPlan']); return plan; },
    checkout: async () => { calls.push(['checkout']); return { branch: 'swarm/work', dirty: false }; },
    integrate: async (...args) => { calls.push(['integrate', ...args]); },
    resume: async (...args) => { calls.push(['resume', ...args]); },
    retryFailed: async (...args) => { calls.push(['retryFailed', ...args]); },
    startWave: async (...args) => { calls.push(['startWave', ...args]); },
    readyTickets: async () => { calls.push(['readyTickets']); return []; },
    pendingApprovals: async () => { calls.push(['pendingApprovals']); return []; },
    liveRuns: async () => { calls.push(['liveRuns']); return []; },
    busyMarkers: async () => { calls.push(['busyMarkers']); return []; },
    capRoom: async () => { calls.push(['capRoom']); return true; },
    startScope: async (...args) => { calls.push(['startScope', ...args]); return { ok: true, result: 'ok' }; },
    ...fns,
  };
  return deps;
}

function callsNamed(deps, name) {
  return deps.calls.filter(c => c[0] === name);
}

function scopeDeps(overrides = {}) {
  const tickets = overrides.tickets ?? [ticket('T-1', ['src/a.ts'])];
  const deps = fakeDeps({
    runs: overrides.runs ?? [],
    readyTickets: async () => tickets,
    pendingApprovals: async () => overrides.approvals ?? [],
    liveRuns: async () => overrides.liveRuns ?? [],
    busyMarkers: async () => overrides.busyMarkers ?? [],
    capRoom: async () => overrides.capRoom ?? true,
    ...overrides.deps,
  });
  deps.startScope = async arg => {
    deps.calls.push(['startScope', arg]);
    overrides.onStartScope?.(arg);
    return overrides.startScopeResult ?? { ok: true, result: 'started' };
  };
  return deps;
}

test('start-ready is the only new autopilot action', () => {
  assert.deepEqual(ACTIONS, [...BASE_ACTIONS, 'start-ready']);
});

test('pickReadyTickets treats ready and releasable todo tickets as ready', () => {
  const tickets = [
    ticket('r1', ['a.ts']),
    { id: 't2', status: 'todo', type: 'build', files: ['b.ts'], dependsOn: ['d1'] },
    { id: 'd1', status: 'done', files: [], dependsOn: [] },
    { id: 'h1', status: 'todo', type: 'human', files: ['c.ts'], dependsOn: [] },
    { id: 'x1', status: 'blocked', files: ['d.ts'], dependsOn: [] },
  ];
  const { startable, held } = pickReadyTickets({ tickets, approvals: [] });
  assert.deepEqual(startable.map(t => t.id), ['r1', 't2']);
  assert.deepEqual(held, []);
});

test('pickReadyTickets holds only tickets whose files overlap a pending approval', () => {
  const tickets = [
    ticket('T-1', ['src/a.ts']),
    ticket('T-2', ['src/b.ts']),
  ];
  const approvals = [{ status: 'pending', files: ['src/a.ts'] }];
  const { startable, held } = pickReadyTickets({ tickets, approvals });
  assert.deepEqual(startable.map(t => t.id), ['T-2']);
  assert.deepEqual(held.map(t => t.id), ['T-1']);
});

test('pickReadyTickets ignores decided approvals and non-overlapping globs', () => {
  const tickets = [ticket('T-1', ['src/a.ts'])];
  assert.deepEqual(pickReadyTickets({ tickets, approvals: [{ status: 'approved', files: ['src/a.ts'] }] }).startable.map(t => t.id), ['T-1']);
  assert.deepEqual(pickReadyTickets({ tickets, approvals: [{ status: 'pending', files: ['docs/other.md'] }] }).startable.map(t => t.id), ['T-1']);
  assert.deepEqual(pickReadyTickets({ tickets, approvals: [{ status: 'pending', files: ['src/*.ts'] }] }).held.map(t => t.id), ['T-1']);
});

test('starts go --scope once when ready tickets exist and nothing runs', async t => {
  const root = await tempRoot(t);
  const journal = [];
  const deps = fakeDeps({
    journal,
    runs: [],
    readyTickets: async () => [ticket('T-1', ['src/x.ts'])],
    pendingApprovals: async () => [],
    liveRuns: async () => [],
    busyMarkers: async () => [],
    capRoom: async () => true,
    startScope: async ({ root: r }) => { deps.calls.push(['startScope', { root: r }]); return { ok: true, result: 'started' }; },
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(callsNamed(deps, 'startScope').length, 1);
  assert.deepEqual(callsNamed(deps, 'startScope')[0][1], { root });
  assert.equal(step.actions.filter(a => a.action === 'start-ready').length, 1);
  assert.equal(step.actions[0].ok, true);
  const event = journal.find(e => e.kind === 'action' && e.action === 'start-ready');
  assert.ok(event);
  assert.match(event.reason, /startable ticket/);
  assert.equal(event.result, 'started');
});

test('does not start with a live run from liveRuns', async t => {
  const root = await tempRoot(t);
  const deps = scopeDeps({ liveRuns: [{ id: 'r-live' }] });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(callsNamed(deps, 'startScope').length, 0);
  assert.equal(step.actions.some(a => a.action === 'start-ready'), false);
});

test('does not start with a running run from loadRuns', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    runs: [{ id: 'r1', status: 'running' }],
    readyTickets: async () => [ticket('T-1', ['src/a.ts'])],
    pendingApprovals: async () => [],
    liveRuns: async () => [],
    busyMarkers: async () => [],
    capRoom: async () => true,
    startScope: async () => ({ ok: true, result: 'ok' }),
  });
  await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(callsNamed(deps, 'startScope').length, 0);
});

test('does not start with a live busy marker', async t => {
  const root = await tempRoot(t);
  const deps = scopeDeps({ busyMarkers: ['scope-busy'] });
  await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(callsNamed(deps, 'startScope').length, 0);
});

test('does not start when capRoom is false', async t => {
  const root = await tempRoot(t);
  const deps = scopeDeps({ capRoom: false });
  await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(callsNamed(deps, 'startScope').length, 0);
});

test('does not start when every ready ticket is held by an approval', async t => {
  const root = await tempRoot(t);
  const deps = scopeDeps({
    tickets: [ticket('T-1', ['src/a.ts'])],
    approvals: [{ status: 'pending', files: ['src/a.ts'] }],
  });
  await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(callsNamed(deps, 'startScope').length, 0);
});

test('starts when only some ready tickets are held', async t => {
  const root = await tempRoot(t);
  const deps = scopeDeps({
    tickets: [ticket('T-1', ['src/a.ts']), ticket('T-2', ['src/b.ts'])],
    approvals: [{ status: 'pending', files: ['src/a.ts'] }],
  });
  await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(callsNamed(deps, 'startScope').length, 1);
});

test('an approval naming other files holds nothing back', async t => {
  const root = await tempRoot(t);
  const deps = scopeDeps({
    tickets: [ticket('T-1', ['src/a.ts'])],
    approvals: [{ status: 'pending', files: ['lib/unrelated.ts'] }],
  });
  await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(callsNamed(deps, 'startScope').length, 1);
});

test('second pass in the same process does not start again', async t => {
  const root = await tempRoot(t);
  const deps = scopeDeps({ tickets: [ticket('T-1', ['src/a.ts'])] });
  const memory = new Set();
  await autopilotStep(root, deps, { now: () => NOW, memory });
  await autopilotStep(root, deps, { now: () => NOW, memory });
  assert.equal(callsNamed(deps, 'startScope').length, 1);
});

test('two start-ready attempts in one step are impossible (memory within pass)', async t => {
  const root = await tempRoot(t);
  let starts = 0;
  const deps = scopeDeps({
    tickets: [ticket('T-1', ['src/a.ts'])],
    onStartScope: () => { starts += 1; },
  });
  await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(starts, 1);
});
