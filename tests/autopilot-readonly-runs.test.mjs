// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { autopilotStep, decide } from '../tools/autopilot.mjs';
import { appendEvent, appendIntegrateBlockerIfNeeded, integrateBlockerResolutionEvent, openBlockerIds, readJournal } from '../tools/journal.mjs';
import { runInboxCommand } from '../tools/inbox-commands.mjs';

const NOW = Date.parse('2030-04-01T12:00:00.000Z');

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-readonly-'));
  await fs.mkdir(path.join(dir, '.swarm', 'project'), { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function journalDeps(root, { runs = [], ...fns } = {}) {
  return {
    loadRuns: async () => runs,
    readJournal: async () => readJournal(root, { limit: Infinity }),
    appendEvent: async (r, event) => appendEvent(r, event, { now: () => NOW }),
    appendIntegrateBlockerIfNeeded,
    readPlan: async () => null,
    checkout: async () => ({ branch: 'swarm/work', dirty: true }),
    integrate: async () => ({}),
    resume: async () => {},
    retryFailed: async () => ({}),
    ...fns,
  };
}

test('integratedAt counts as integrated: decide is null and no checkout blocker on a dirty tree', async t => {
  const root = await tempRoot(t);
  const run = {
    id: 'review-1',
    status: 'complete',
    integrated: true,
    integratedAt: '2030-01-01T00:00:00.000Z',
    integrable: false,
  };
  assert.equal(decide(run, { now: NOW, events: [] }), null);
  const step = await autopilotStep(root, journalDeps(root, { runs: [run] }), { now: () => NOW, memory: new Set() });
  assert.deepEqual(step.actions, []);
  assert.deepEqual(step.blocked, []);
});

test('ask runs never integrate or raise integrate-checkout blockers', async t => {
  const root = await tempRoot(t);
  const run = { id: 'ask-goal', status: 'complete', integrated: false, integrable: false };
  assert.equal(decide(run, { now: NOW, events: [] }), null);
  const step = await autopilotStep(root, journalDeps(root, { runs: [run] }), { now: () => NOW, memory: new Set() });
  assert.deepEqual(step.blocked, []);
});

test('a run with outputs still integrates when checkout is clean', async t => {
  const run = { id: 'work-1', status: 'complete', integrated: false, integrable: true };
  const d = decide(run, { now: NOW, events: [] });
  assert.equal(d?.action, 'integrate');
});

test('resolved integrate-checkout blocker is not raised again (1.165.0)', async t => {
  const root = await tempRoot(t);
  await appendEvent(root, integrateBlockerResolutionEvent(
    { id: 'integrate-checkout-r1', text: 'dirty tree' },
    { integrateKind: 'integrate-checkout', integrateRun: 'r1', integrateCause: 'the checkout has uncommitted changes', resolvedBy: 'owner' },
  ), { now: () => NOW });
  const step = await autopilotStep(root, journalDeps(root, {
    runs: [{ id: 'r1', status: 'complete', integrated: false, integrable: true }],
    checkout: async () => ({ branch: 'swarm/work', dirty: false }),
  }), { now: () => NOW, memory: new Set() });
  assert.equal(step.blocked.length, 0);
  assert.equal(openBlockerIds(await readJournal(root, { limit: Infinity })).has('integrate-checkout-r1'), false);
});

test('swarm resolve BLOCKER_ID still closes integrate blockers', async t => {
  const root = await tempRoot(t);
  await appendEvent(root, {
    kind: 'blocker',
    id: 'integrate-checkout-r1',
    text: 'dirty',
    integrateKind: 'integrate-checkout',
    integrateRun: 'r1',
    integrateCause: 'dirty',
  }, { now: () => NOW });
  const out = await runInboxCommand(root, 'resolve', ['integrate-checkout-r1'], { now: () => NOW });
  assert.equal(out.exitCode, 0);
});
