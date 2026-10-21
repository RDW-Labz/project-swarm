// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { autopilotStep, decide } from '../tools/autopilot.mjs';
import {
  appendEvent,
  appendIntegrateBlockerIfNeeded,
  integrateBlockerFields,
  integrateBlockerResolutionEvent,
  openBlockerIds,
  readJournal,
} from '../tools/journal.mjs';
import { runInboxCommand } from '../tools/inbox-commands.mjs';

const NOW = Date.parse('2030-02-01T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-blocker-'));
  await fs.mkdir(path.join(dir, '.swarm', 'project'), { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function journalDeps(root, { runs = [], ...fns } = {}) {
  const calls = [];
  const deps = {
    calls,
    loadRuns: async () => runs,
    readJournal: async () => readJournal(root, { limit: Infinity }),
    appendEvent: async (r, event) => {
      calls.push(['appendEvent', event]);
      return appendEvent(r, event, { now: () => NOW });
    },
    appendIntegrateBlockerIfNeeded,
    readPlan: async () => null,
    checkout: async () => ({ branch: 'swarm/work', dirty: false }),
    integrate: async () => ({}),
    resume: async () => {},
    retryFailed: async () => ({}),
    ...fns,
  };
  return deps;
}

test('resolved integrate-checkout blocker is not raised on the next autopilot tick', async t => {
  const root = await tempRoot(t);
  const runs = [{ id: 'r1', status: 'complete', integrated: false, integrable: true }];
  const resolved = integrateBlockerResolutionEvent(
    { id: 'integrate-checkout-r1', text: 'dirty tree' },
    { integrateKind: 'integrate-checkout', integrateRun: 'r1', integrateCause: 'the checkout has uncommitted changes', resolvedBy: 'owner' },
  );
  await appendEvent(root, resolved, { now: () => NOW });
  const deps = journalDeps(root, { runs });
  const memory = new Set();
  const step = await autopilotStep(root, deps, { now: () => NOW, memory });
  assert.equal(step.blocked.length, 0);
  const journal = await readJournal(root, { limit: Infinity });
  assert.equal(openBlockerIds(journal).has('integrate-checkout-r1'), false);
});

test('swarm resolve records integrate resolution and autopilot does not re-raise the same cause', async t => {
  const root = await tempRoot(t);
  await appendEvent(root, {
    kind: 'blocker',
    id: 'integrate-checkout-r1',
    text: 'Run r1 is complete but not integrated: dirty',
    ...integrateBlockerFields({ integrateKind: 'integrate-checkout', integrateRun: 'r1', integrateCause: 'dirty' }),
  }, { now: () => NOW });
  const out = await runInboxCommand(root, 'resolve', ['integrate-checkout-r1'], { now: () => NOW });
  assert.equal(out.exitCode, 0);
  const deps = journalDeps(root, { runs: [{ id: 'r1', status: 'complete', integrated: false, integrable: true }] });
  await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  assert.equal(openBlockerIds(await readJournal(root, { limit: Infinity })).has('integrate-checkout-r1'), false);
});

test('integrate success resolves integrate blockers for the run', async t => {
  const root = await tempRoot(t);
  await appendEvent(root, {
    kind: 'blocker',
    id: 'integrate-r1',
    text: 'needs decision',
    ...integrateBlockerFields({ integrateKind: 'integrate', integrateRun: 'r1', integrateCause: 'merge conflict' }),
  }, { now: () => NOW });
  const deps = journalDeps(root, {
    runs: [{ id: 'r1', status: 'complete', integrated: false, integrable: true }],
    checkout: async () => ({ branch: 'swarm/work', dirty: false }),
    integrate: async () => ({ files: 1 }),
  });
  await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  const after = await readJournal(root, { limit: Infinity });
  assert.ok(after.some(e => e.kind === 'blocker' && e.id === 'integrate-r1' && e.resolved === true));
});

test('cancelled run clears integrate blockers and does not raise new ones', async t => {
  const root = await tempRoot(t);
  await appendEvent(root, { kind: 'run', id: 'r1', status: 'running' }, { now: () => NOW });
  const deps = journalDeps(root, {
    runs: [{ id: 'r1', status: 'cancelled', integrated: false, integrable: true }],
  });
  await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  const step = await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  assert.equal(step.blocked.length, 0);
});

test('identical integrate failure cause is not raised again; a new cause gets a new blocker id', async t => {
  const root = await tempRoot(t);
  await appendEvent(root, integrateBlockerResolutionEvent(
    { id: 'integrate-r1', text: 'Integration of run r1 needs a decision: merge conflict' },
    { integrateKind: 'integrate', integrateRun: 'r1', integrateCause: 'merge conflict', resolvedBy: 'owner' },
  ), { now: () => NOW });
  await appendEvent(root, { kind: 'action', action: 'integrate', run: 'r1', result: 'merge conflict' }, { now: () => NOW });
  const deps = journalDeps(root, {
    runs: [{ id: 'r1', status: 'complete', integrated: false, integrable: true }],
    checkout: async () => ({ branch: 'swarm/work', dirty: false }),
  });
  await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  assert.equal(openBlockerIds(await readJournal(root, { limit: Infinity })).has('integrate-r1'), false);
  await appendEvent(root, { kind: 'action', action: 'integrate', run: 'r1', result: 'security gate blocked' }, { now: () => NOW });
  const step = await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  assert.equal(step.blocked.length, 1);
  assert.notEqual(step.blocked[0], 'integrate-r1');
});

test('concurrent integrate blocker raises append at most one', async t => {
  const root = await tempRoot(t);
  const draft = {
    id: 'integrate-checkout-race',
    text: 'Run race is complete but not integrated: dirty',
    integrateKind: 'integrate-checkout',
    integrateRun: 'race',
    integrateCause: 'dirty',
  };
  const [a, b] = await Promise.all([
    appendIntegrateBlockerIfNeeded(root, draft, { now: () => NOW }),
    appendIntegrateBlockerIfNeeded(root, draft, { now: () => NOW }),
  ]);
  assert.equal(Number(a.appended) + Number(b.appended), 1);
  const journal = await readJournal(root, { limit: Infinity });
  assert.equal(journal.filter(e => e.kind === 'blocker' && e.id === 'integrate-checkout-race').length, 1);
});
