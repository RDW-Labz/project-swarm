// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planWaveBatch } from '../tools/wave-batch.mjs';
import { autopilotStep } from '../tools/autopilot.mjs';
import { appendEvent } from '../tools/journal.mjs';

const NOW = Date.parse('2030-04-01T12:00:00.000Z');

function ticket(id, files, extra = {}) {
  return { id, status: 'ready', files, dependsOn: [], type: 'build', ...extra };
}

test('planWaveBatch picks non-conflicting ready tickets up to slots', () => {
  const ready = [
    ticket('a', ['src/a.ts']),
    ticket('b', ['src/b.ts']),
    ticket('c', ['src/a.ts']),
    ticket('d', ['src/d.ts'], { dependsOn: ['missing'] }),
    ticket('e', ['src/e.ts'], { sensitive: true }),
    ticket('f', ['src/f.ts'], { held: true }),
  ];
  const batch = planWaveBatch(ready, { slots: 3, heldIds: new Set(['f']) });
  assert.deepEqual(batch.map(t => t.id), ['a', 'b']);
});

test('planWaveBatch never exceeds slots', () => {
  const ready = Array.from({ length: 10 }, (_, i) => ticket(`t${i}`, [`file-${i}.ts`]));
  assert.equal(planWaveBatch(ready, { slots: 4 }).length, 4);
});

test('autopilot batches under-filled waves and logs the Events note', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wave-batch-autopilot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  const journal = [];
  const tickets = [
    ticket('T-1', ['a.ts']),
    ticket('T-2', ['b.ts']),
    ticket('T-3', ['c.ts']),
    ticket('T-4', ['d.ts']),
  ];
  const deps = {
    loadRuns: async () => [
      { id: 'r1', status: 'complete', integrated: true, jobCount: 1 },
      { id: 'r2', status: 'complete', integrated: true, jobCount: 1 },
      { id: 'r3', status: 'complete', integrated: true, jobCount: 1 },
    ],
    readJournal: async () => journal,
    appendEvent: async (r, event) => {
      const stored = await appendEvent(r, event, { now: () => NOW });
      journal.push(stored);
      return stored;
    },
    readPlan: async () => null,
    readyTickets: async () => tickets,
    pendingApprovals: async () => [],
    liveRuns: async () => [],
    busyMarkers: async () => [],
    capRoom: async () => true,
    workerSlots: async () => ({ max: 12, free: 4 }),
    recentJobCounts: async () => [1, 1, 1],
    startScope: async arg => {
      deps.lastStart = arg;
      return { ok: true, result: 'started' };
    },
  };
  const step = await autopilotStep(root, deps, { now: () => NOW, memory: { startReadyLastAt: null } });
  assert.equal(step.actions.some(a => a.action === 'start-ready' && a.ok), true);
  assert.equal(deps.lastStart?.ticketIds?.length, 4);
  assert.ok(journal.some(e => e.kind === 'note' && /batched 4 tickets into one wave because waves were under-filled/.test(e.text)));
});
