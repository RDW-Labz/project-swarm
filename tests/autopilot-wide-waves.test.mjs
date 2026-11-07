// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autopilotStep } from '../tools/autopilot.mjs';
import { readyAutopilotDeps } from '../tools/autopilot-ready-deps.mjs';
import {
  AUTOPILOT_MAX_JOBS_CEILING,
  resolveAutopilotStartReady,
  validateAutopilotBlock,
} from '../tools/local-config.mjs';

const NOW = Date.parse('2030-06-01T12:00:00.000Z');
const swarmEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'swarm.mjs');

function ticket(id, files, extra = {}) {
  return { id, status: 'ready', files, dependsOn: [], type: 'build', ...extra };
}

function doneTicket(id) {
  return { id, status: 'done', files: [], dependsOn: [], type: 'build' };
}

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-wide-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function stepDeps(overrides = {}) {
  const journal = [];
  const calls = [];
  const tickets = overrides.tickets ?? [];
  const deps = {
    journal,
    calls,
    loadRuns: async () => overrides.runs ?? [],
    readJournal: async () => journal,
    appendEvent: async (_r, event) => {
      journal.push({ ...event, ts: new Date(NOW).toISOString() });
      return event;
    },
    readPlan: async () => null,
    readyTickets: async () => tickets.filter(t => t.status === 'ready'),
    readTickets: async () => tickets,
    pendingApprovals: async () => [],
    liveRuns: async () => overrides.liveRuns ?? [],
    busyMarkers: async () => overrides.busyMarkers ?? [],
    capRoom: async () => overrides.capRoom ?? true,
    workerSlots: async () => overrides.workerSlots ?? { max: 8, free: 8 },
    autopilotStartReadySettings: async () => overrides.waveSettings ?? { skipSkeleton: false, maxJobs: overrides.workerSlots?.free ?? 8 },
    startScope: async arg => {
      calls.push(arg);
      return { ok: true, result: 'started' };
    },
    ...overrides.deps,
  };
  return deps;
}

test('12 independent ready tickets and 8 free slots start 8 in one startScope with maxJobs 8', async t => {
  const root = await tempRoot(t);
  const tickets = Array.from({ length: 12 }, (_, i) => ticket(`T-${i}`, [`src/f-${i}.ts`]));
  const deps = stepDeps({ tickets, workerSlots: { max: 12, free: 8 } });
  const step = await autopilotStep(root, deps, { now: () => NOW, memory: {} });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].ticketIds.length, 8);
  assert.equal(deps.calls[0].maxJobs, 8);
  assert.equal(step.actions.some(a => a.action === 'start-ready' && a.ok), true);
});

test('tickets sharing a file are not started together', async t => {
  const root = await tempRoot(t);
  const tickets = [
    ticket('A', ['shared.ts']),
    ticket('B', ['shared.ts']),
    ticket('C', ['other.ts']),
  ];
  const deps = stepDeps({ tickets, workerSlots: { max: 8, free: 8 } });
  await autopilotStep(root, deps, { now: () => NOW, memory: {} });
  assert.equal(deps.calls.length, 1);
  const ids = deps.calls[0].ticketIds;
  assert.ok(ids.includes('A') || ids.includes('B'));
  assert.notEqual(ids.includes('A') && ids.includes('B'), true);
  assert.ok(ids.includes('C'));
});

test('resolveAutopilotStartReady auto skipSkeleton when 10+ done tickets', () => {
  const on = resolveAutopilotStartReady({ doneTicketCount: 10, freeSlots: 4 });
  assert.equal(on.skipSkeleton, true);
  const off = resolveAutopilotStartReady({ doneTicketCount: 9, freeSlots: 4 });
  assert.equal(off.skipSkeleton, false);
});

test('skipSkeleton false never passes skeleton skip; true always does', () => {
  assert.equal(resolveAutopilotStartReady({ machine: { skipSkeleton: false }, doneTicketCount: 99 }).skipSkeleton, false);
  assert.equal(resolveAutopilotStartReady({ machine: { skipSkeleton: true }, doneTicketCount: 0 }).skipSkeleton, true);
});

test('maxJobs from config is respected and capped at 64', () => {
  const capped = resolveAutopilotStartReady({ machine: { maxJobs: 100 }, freeSlots: 80 });
  assert.equal(capped.maxJobs, AUTOPILOT_MAX_JOBS_CEILING);
  const limited = resolveAutopilotStartReady({ machine: { maxJobs: 5 }, freeSlots: 8 });
  assert.equal(limited.maxJobs, 5);
});

test('validateAutopilotBlock rejects unknown keys and bad maxJobs', () => {
  assert.ok(validateAutopilotBlock({ extra: true }).some(e => /unknown key/.test(e)));
  assert.ok(validateAutopilotBlock({ maxJobs: 1.5 }).some(e => /maxJobs/.test(e)));
  assert.ok(validateAutopilotBlock({ maxJobs: 65 }).some(e => /64/.test(e)));
});

test('live run prevents start-ready', async t => {
  const root = await tempRoot(t);
  const deps = stepDeps({
    tickets: [ticket('T-1', ['a.ts'])],
    liveRuns: [{ id: 'live' }],
  });
  await autopilotStep(root, deps, { now: () => NOW, memory: {} });
  assert.equal(deps.calls.length, 0);
});

test('busy marker prevents start-ready', async t => {
  const root = await tempRoot(t);
  const deps = stepDeps({
    tickets: [ticket('T-1', ['a.ts'])],
    busyMarkers: [{ pid: 9, root }],
  });
  await autopilotStep(root, deps, { now: () => NOW, memory: {} });
  assert.equal(deps.calls.length, 0);
});

test('capRoom false prevents start-ready', async t => {
  const root = await tempRoot(t);
  const deps = stepDeps({ tickets: [ticket('T-1', ['a.ts'])], capRoom: false });
  await autopilotStep(root, deps, { now: () => NOW, memory: {} });
  assert.equal(deps.calls.length, 0);
});

test('startScope argv includes --max-jobs and --skip-skeleton when allowed', async () => {
  const spawnCalls = [];
  const deps = readyAutopilotDeps('/tmp/wide-project', {
    memoryAware: false,
    env: {},
    spawnImpl: (execPath, args, opts) => {
      spawnCalls.push({ execPath, args, opts });
      return { pid: 1, unref() {}, once() {} };
    },
    selfPid: 0,
    liveBusyMarkers: async () => [],
    listLiveRuns: async () => [],
    checkProjectCap: async () => null,
    readTickets: async () => [],
    readPending: async () => [],
  });
  await deps.startScope({ root: '/tmp/wide-project', maxJobs: 6, skipSkeleton: true });
  assert.deepEqual(spawnCalls[0].args, [
    swarmEntry, '--root', path.resolve('/tmp/wide-project'), 'go', '--scope', '--max-jobs', '6', '--skip-skeleton',
  ]);
  spawnCalls.length = 0;
  await deps.startScope({ root: '/tmp/wide-project', maxJobs: 2, skipSkeleton: false });
  assert.deepEqual(spawnCalls[0].args, [
    swarmEntry, '--root', path.resolve('/tmp/wide-project'), 'go', '--scope', '--max-jobs', '2',
  ]);
});

test('readyAutopilotDeps skeleton auto uses done ticket count from ledger', async t => {
  const root = await tempRoot(t);
  await fs.writeFile(path.join(root, '.project-swarm.json'), `${JSON.stringify({ install: '/x', version: '1' })}\n`);
  const done = Array.from({ length: 10 }, (_, i) => doneTicket(`D-${i}`));
  const deps = readyAutopilotDeps(root, {
    memoryAware: false,
    env: process.env,
    spawnImpl: () => ({ pid: 1, unref() {}, once() {} }),
    selfPid: 0,
    liveBusyMarkers: async () => [],
    listLiveRuns: async () => [],
    checkProjectCap: async () => null,
    readTickets: async () => [...done, ticket('R', ['z.ts'])],
    readPending: async () => [],
  });
  const settings = await deps.autopilotStartReadySettings(root, { freeSlots: 4 });
  assert.equal(settings.skipSkeleton, true);
});
