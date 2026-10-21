// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decide, autopilotStep, autopilotRunFromState, integrableFromJobs } from '../tools/autopilot.mjs';
import { loadRuns } from '../tools/brief.mjs';

const NOW = Date.parse('2030-01-01T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-no-out-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeDeps(opts = {}) {
  const { journal = [], runs = [], ...fns } = opts;
  const calls = [];
  return {
    calls,
    loadRuns: async () => runs,
    readJournal: async () => journal,
    appendEvent: async (_root, event) => {
      calls.push(['appendEvent', event]);
      journal.push({ ...event, ts: iso(NOW) });
      return event;
    },
    readPlan: async () => null,
    checkout: async () => ({ branch: 'main', dirty: false }),
    integrate: async (...args) => { calls.push(['integrate', ...args]); },
    resume: async () => {},
    retryFailed: async () => ({}),
    startWave: async () => ({}),
    ...fns,
  };
}

test('decide returns null for a complete review-only run (integrable false)', () => {
  assert.equal(decide({ id: 'ask1', status: 'complete', integrated: false, integrable: false }, { now: NOW, events: [] }), null);
});

test('decide still integrates a complete run with outputs (integrable true)', () => {
  const d = decide({ id: 'r1', status: 'complete', integrated: false, integrable: true }, { now: NOW, events: [] });
  assert.equal(d.action, 'integrate');
});

test('decide keeps legacy behavior when integrable is absent', () => {
  const d = decide({ id: 'r1', status: 'complete', integrated: false }, { now: NOW, events: [] });
  assert.equal(d.action, 'integrate');
});

test('review-only complete run gets no integrate action or checkout blocker on main', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    runs: [{ id: 'ask1', status: 'complete', integrated: false, integrable: false }],
    checkout: async () => ({ branch: 'main', dirty: false }),
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.deepEqual(step.actions, []);
  assert.deepEqual(step.blocked, []);
  assert.equal(deps.calls.some(c => c[0] === 'integrate'), false);
});

test('run with outputs still gets integrate-checkout blocker when checkout is wrong', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    runs: [{ id: 'r1', status: 'complete', integrated: false, integrable: true }],
    checkout: async () => ({ branch: 'main', dirty: false }),
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(deps.calls.some(c => c[0] === 'integrate'), false);
  assert.deepEqual(step.blocked, ['integrate-checkout-r1']);
});

test('autopilot closes an open integrate blocker for a review-only run', async t => {
  const root = await tempRoot(t);
  const journal = [{ kind: 'blocker', id: 'integrate-checkout-ask1', text: 'stale', ts: iso(NOW - 1000) }];
  const deps = fakeDeps({
    journal,
    runs: [{ id: 'ask1', status: 'complete', integrated: false, integrable: false }],
  });
  await autopilotStep(root, deps, { now: () => NOW });
  const resolved = journal.find(e => e.kind === 'blocker' && e.id === 'integrate-checkout-ask1' && e.resolved === true);
  assert.ok(resolved);
});

test('mixed review-only and output runs in one pass', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    runs: [
      { id: 'ask1', status: 'complete', integrated: false, integrable: false },
      { id: 'r1', status: 'complete', integrated: false, integrable: true },
    ],
    checkout: async () => ({ branch: 'main', dirty: false }),
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(step.actions.length, 0);
  assert.deepEqual(step.blocked, ['integrate-checkout-r1']);
  assert.equal(deps.calls.filter(c => c[0] === 'integrate').length, 0);
});

test('autopilotRunFromState sets integrable false for ask-style jobs and true when outputs exist', () => {
  const ask = autopilotRunFromState({
    id: 'ask-run',
    status: 'complete',
    jobs: [{ id: 'j1', outputs: [], status: 'complete' }],
  }, 'ask-run');
  assert.equal(ask.integrable, false);

  const withOutputs = autopilotRunFromState({
    id: 'work-run',
    status: 'complete',
    jobs: [{ id: 'j1', outputs: ['src/foo.mjs'], status: 'complete' }],
  }, 'work-run');
  assert.equal(withOutputs.integrable, true);
});

test('integrableFromJobs matches manifest job lists', () => {
  assert.equal(integrableFromJobs([{ outputs: [] }, { outputs: [] }]), false);
  assert.equal(integrableFromJobs([{ outputs: ['a.txt'] }]), true);
});

test('loadRuns via brief stays without integrable; swarm wrapper adds it from saved state', async t => {
  const root = await tempRoot(t);
  const runsDir = path.join(root, '.swarm', 'runs', 'ask-run');
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(path.join(runsDir, 'state.json'), JSON.stringify({
    id: 'ask-run',
    status: 'complete',
    jobs: [{ id: 'q', outputs: [], status: 'complete' }],
  }));
  const briefRuns = await loadRuns(root);
  assert.equal(briefRuns[0].integrable, undefined);

  const { integrableFromJobs: fromSwarm } = await import('../tools/autopilot.mjs');
  assert.equal(fromSwarm([{ outputs: [] }]), false);
});
