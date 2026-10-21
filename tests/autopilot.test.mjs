// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACTIONS, decide, autopilotStep, runAutopilot, nextWave, integrationBlocker } from '../tools/autopilot.mjs';

const NOW = Date.parse('2030-01-01T12:00:00.000Z');
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();
const ALLOWED = new Set(['integrate', 'resume', 'retryFailed', 'startWave', 'appendEvent', 'readJournal', 'loadRuns', 'readPlan', 'checkout']);

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
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
    ...fns,
  };
  return deps;
}

function callsNamed(deps, name) {
  return deps.calls.filter(c => c[0] === name);
}

test('ACTIONS lists the autopilot actions', () => {
  assert.deepEqual(ACTIONS, ['integrate', 'resume', 'retry-failed', 'start-wave', 'start-deferred', 'start-backlog', 'unlock-tickets', 'start-ready']);
});

test('decide integrates a complete run that is not integrated', () => {
  const d = decide({ id: 'r1', status: 'complete', integrated: false }, { now: NOW, events: [] });
  assert.equal(d.action, 'integrate');
  assert.equal(d.run, 'r1');
});

test('decide returns null for an integrated complete run', () => {
  assert.equal(decide({ id: 'r1', status: 'complete', integrated: true }, { now: NOW, events: [] }), null);
});

test('decide blocks integration after a failed integrate action and never retries it', () => {
  const events = [{ kind: 'action', action: 'integrate', run: 'r1', result: 'merge conflict' }];
  const d = decide({ id: 'r1', status: 'complete', integrated: false }, { now: NOW, events });
  assert.equal(d.action, 'block');
  assert.equal(d.id, 'integrate-r1');
  assert.equal(d.text, 'Integration of run r1 needs a decision: merge conflict');
});

test('decide resumes a quota pause whose until is in the past', () => {
  const run = { id: 'r1', status: 'paused', pause: { reasons: ['quota'], until: iso(NOW - MIN) } };
  assert.equal(decide(run, { now: NOW, events: [] }).action, 'resume');
});

test('decide waits on a quota pause when the last resume was under 5 minutes ago', () => {
  const run = { id: 'r1', status: 'paused', pause: { reasons: ['quota'], until: iso(NOW - MIN) } };
  const events = [{ kind: 'action', action: 'resume', run: 'r1', ts: iso(NOW - 2 * MIN) }];
  const d = decide(run, { now: NOW, events });
  assert.equal(d.action, 'wait');
});

test('decide waits while quota until is in the future', () => {
  const until = iso(NOW + MIN);
  const d = decide({ id: 'r1', status: 'paused', pause: { reasons: ['quota'], until } }, { now: NOW, events: [] });
  assert.deepEqual(d, { action: 'wait', run: 'r1', reason: `quota until ${until}` });
});

test('decide waits on lane-cap when the last resume was under 15 minutes ago', () => {
  const run = { id: 'r1', status: 'paused', pause: { reasons: ['lane-cap'] } };
  const events = [{ kind: 'action', action: 'resume', run: 'r1', ts: iso(NOW - 10 * MIN) }];
  assert.equal(decide(run, { now: NOW, events }).action, 'wait');
});

test('decide resumes lane-cap after 15 minutes', () => {
  const run = { id: 'r1', status: 'paused', pause: { reasons: ['lane-cap'] } };
  const events = [{ kind: 'action', action: 'resume', run: 'r1', ts: iso(NOW - 20 * MIN) }];
  assert.equal(decide(run, { now: NOW, events }).action, 'resume');
});

test('decide blocks a run-cap pause and never resumes or raises it', () => {
  const d = decide({ id: 'r1', status: 'paused', pause: { reasons: ['run-cap'] } }, { now: NOW, events: [] });
  assert.equal(d.action, 'block');
  assert.equal(d.id, 'cap-r1');
  assert.match(d.text, /swarm resume r1 --raise maxUsd=<N> --reason TEXT/);
});

test('decide blocks a child-paused run on the cap id', () => {
  const d = decide({ id: 'r1', status: 'paused', pause: { reasons: ['child-paused'] } }, { now: NOW, events: [] });
  assert.equal(d.action, 'block');
  assert.equal(d.id, 'cap-r1');
});

test('decide returns null for an unknown pause reason', () => {
  assert.equal(decide({ id: 'r1', status: 'paused', pause: { reasons: ['other'] } }, { now: NOW, events: [] }), null);
});

test('decide retries failed jobs once per run', () => {
  const d = decide({ id: 'r1', status: 'failed', counts: { failed: 2 } }, { now: NOW, events: [] });
  assert.equal(d.action, 'retry-failed');
});

test('decide blocks a failed run after one retry', () => {
  const events = [{ kind: 'action', action: 'retry-failed', run: 'r1', result: 'ok' }];
  const d = decide({ id: 'r1', status: 'failed', counts: { failed: 1 } }, { now: NOW, events });
  assert.equal(d.action, 'block');
  assert.equal(d.id, 'failed-r1');
  assert.equal(d.text, 'Run r1 still has failed jobs after one retry: swarm inspect r1 --results');
});

test('decide returns null for a failed run with no failed jobs and no retry', () => {
  assert.equal(decide({ id: 'r1', status: 'failed', counts: { failed: 0 } }, { now: NOW, events: [] }), null);
});

test('decide returns null for a running run', () => {
  assert.equal(decide({ id: 'r1', status: 'running' }, { now: NOW, events: [] }), null);
});

test('nextWave waits for dependencies and skips waves already started', () => {
  const plan = { waves: [{ id: 'a', manifest: 'm-a' }, { id: 'b', manifest: 'm-b', after: ['a'] }] };
  assert.equal(nextWave([], plan).id, 'a');
  assert.equal(nextWave([{ kind: 'action', action: 'start-wave', wave: 'a' }], plan), null);
  const done = [
    { kind: 'action', action: 'start-wave', wave: 'a' },
    { kind: 'run', id: 'r-a', status: 'complete', manifest: 'm-a' },
    { kind: 'integration', run: 'r-a', status: 'complete' },
  ];
  assert.equal(nextWave(done, plan).id, 'b');
  // wave a was started but not integrated yet: b must keep waiting
  assert.equal(nextWave(done.slice(0, 2), plan), null);
});

test('autopilotStep starts at most one wave per step', async t => {
  const root = await tempRoot(t);
  const plan = { waves: [{ id: 'a', manifest: 'm-a' }, { id: 'b', manifest: 'm-b', after: ['a'] }, { id: 'c', manifest: 'm-c' }] };
  const journal = [];
  const deps = fakeDeps({ journal, plan });
  await autopilotStep(root, deps, { now: () => NOW });
  const first = callsNamed(deps, 'startWave');
  assert.equal(first.length, 1);
  assert.equal(first[0][2].id, 'a');
  await autopilotStep(root, deps, { now: () => NOW });
  const second = callsNamed(deps, 'startWave');
  assert.equal(second.length, 2);
  assert.equal(second[1][2].id, 'c');
});

test('autopilotStep calls only the listed dependencies', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    journal: [],
    runs: [
      { id: 'r1', status: 'complete', integrated: false },
      { id: 'r2', status: 'paused', pause: { reasons: ['lane-cap'] } },
      { id: 'r3', status: 'failed', counts: { failed: 1 } },
      { id: 'r4', status: 'paused', pause: { reasons: ['run-cap'] } },
    ],
    plan: { waves: [{ id: 'a', manifest: 'm' }] },
  });
  await autopilotStep(root, deps, { now: () => NOW });
  for (const call of deps.calls) assert.ok(ALLOWED.has(call[0]), `unexpected dependency ${call[0]}`);
});

test('resume is called with the root and run id only, never a raises argument', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({ runs: [{ id: 'r2', status: 'paused', pause: { reasons: ['lane-cap'] } }] });
  await autopilotStep(root, deps, { now: () => NOW });
  const resumes = callsNamed(deps, 'resume');
  assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0], ['resume', root, 'r2']);
});

test('autopilotStep never runs more than 3 actions for one run per step', async t => {
  const root = await tempRoot(t);
  const same = { id: 'r1', status: 'complete', integrated: false };
  const deps = fakeDeps({ runs: [same, same, same, same, same] });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  // The same run listed five times is decided five times, but at most 3 actions are taken and the
  // once-only memory means the run is integrated a single time.
  assert.ok(step.actions.length <= 3);
  assert.equal(callsNamed(deps, 'integrate').length, 1);
  assert.equal(step.actions.filter(action => action.ok).length, 1);
});

test('a throwing dependency does not stop the step', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    runs: [
      { id: 'r1', status: 'complete', integrated: false },
      { id: 'r2', status: 'paused', pause: { reasons: ['lane-cap'] } },
    ],
    integrate: async () => { throw new Error('boom'); },
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.deepEqual(step.actions.map(a => [a.action, a.run, a.ok]), [['integrate', 'r1', false], ['resume', 'r2', true]]);
  assert.equal(callsNamed(deps, 'resume').length, 1);
  const failedEvent = deps.calls.find(c => c[0] === 'appendEvent' && c[1].action === 'integrate');
  assert.equal(failedEvent[1].result, 'boom');
});

test('action results are capped at 500 characters', async t => {
  const root = await tempRoot(t);
  const journal = [];
  const deps = fakeDeps({
    journal,
    runs: [{ id: 'r1', status: 'complete', integrated: false }],
    integrate: async () => { throw new Error('x'.repeat(900)); },
  });
  await autopilotStep(root, deps, { now: () => NOW });
  const event = journal.find(e => e.kind === 'action');
  assert.equal(event.result.length, 500);
});

test('a blocker is written once per id across steps', async t => {
  const root = await tempRoot(t);
  const journal = [];
  const deps = fakeDeps({ journal, runs: [{ id: 'r3', status: 'paused', pause: { reasons: ['run-cap'] } }] });
  const first = await autopilotStep(root, deps, { now: () => NOW });
  const second = await autopilotStep(root, deps, { now: () => NOW });
  assert.deepEqual(first.blocked, ['cap-r3']);
  assert.deepEqual(second.blocked, []);
  assert.equal(journal.filter(e => e.kind === 'blocker' && e.id === 'cap-r3').length, 1);
});

test('a blocker already open in the journal is not written again', async t => {
  const root = await tempRoot(t);
  const journal = [{ kind: 'blocker', id: 'cap-r3', text: 'existing', ts: iso(NOW) }];
  const deps = fakeDeps({ journal, runs: [{ id: 'r3', status: 'paused', pause: { reasons: ['run-cap'] } }] });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.deepEqual(step.blocked, []);
  // the run status sync may still write a run event, but never a second blocker
  assert.equal(journal.filter(e => e.kind === 'blocker').length, 1);
});

test('an integrate failure is written as a blocker with the integrate-<id> id', async t => {
  const root = await tempRoot(t);
  const journal = [{ kind: 'action', action: 'integrate', run: 'r1', result: 'merge conflict', ts: iso(NOW - MIN) }];
  const deps = fakeDeps({ journal, runs: [{ id: 'r1', status: 'complete', integrated: false }] });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.deepEqual(step.blocked, ['integrate-r1']);
  assert.equal(callsNamed(deps, 'integrate').length, 0);
  const blocker = journal.find(e => e.kind === 'blocker');
  assert.equal(blocker.text, 'Integration of run r1 needs a decision: merge conflict');
});

test('autopilotStep reports idle when nothing applies', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({ runs: [{ id: 'r9', status: 'running' }] });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.deepEqual(step, { actions: [], blocked: [], idle: true });
});

test('runAutopilot with once runs a single step without sleeping', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({ runs: [] });
  const sleeps = [];
  const results = await runAutopilot(root, deps, { once: true, sleep: async ms => { sleeps.push(ms); }, now: () => NOW });
  assert.equal(results.length, 1);
  assert.deepEqual(sleeps, []);
});

test('runAutopilot stops at maxSteps and sleeps between steps', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({ runs: [] });
  const sleeps = [];
  const results = await runAutopilot(root, deps, {
    intervalMs: 30000,
    maxSteps: 3,
    sleep: async ms => { sleeps.push(ms); },
    now: () => NOW,
  });
  assert.equal(results.length, 3);
  assert.deepEqual(sleeps, [30000, 30000]);
  const fast = [];
  await runAutopilot(root, fakeDeps({ runs: [] }), { intervalMs: 10, maxSteps: 2, sleep: async ms => { fast.push(ms); }, now: () => NOW });
  assert.deepEqual(fast, [5000], 'an interval below the minimum is raised to 5 seconds');
});

test('runAutopilot does nothing when the signal is already aborted', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({ runs: [] });
  const controller = new AbortController();
  controller.abort();
  const results = await runAutopilot(root, deps, { signal: controller.signal, sleep: async () => {}, now: () => NOW });
  assert.equal(results.length, 0);
  assert.equal(callsNamed(deps, 'loadRuns').length, 0);
});

test('runAutopilot stops when the signal aborts during a sleep', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({ runs: [] });
  const controller = new AbortController();
  const results = await runAutopilot(root, deps, {
    signal: controller.signal,
    sleep: async () => { controller.abort(); },
    now: () => NOW,
  });
  assert.equal(results.length, 1);
});

test('a failed run whose retry run completed is handled; a failed retry run blocks instead of retrying again', () => {
  const retried = [{ kind: 'action', action: 'retry-failed', run: 'r1' }];
  assert.equal(decide({ id: 'r1', status: 'failed', counts: { failed: 1 } }, { now: NOW, events: [...retried, { kind: 'run', id: 'r2', status: 'complete', retryOf: 'r1' }] }), null);
  assert.equal(decide({ id: 'r1', status: 'failed', counts: { failed: 1 } }, { now: NOW, events: [...retried, { kind: 'run', id: 'r2', status: 'failed', retryOf: 'r1' }] }).action, 'block');
  const second = decide({ id: 'r2', status: 'failed', counts: { failed: 1 } }, { now: NOW, events: [{ kind: 'run', id: 'r2', status: 'running', retryOf: 'r1' }] });
  assert.equal(second.action, 'block');
  assert.match(second.text, /Retry run r2/);
});

test('autopilotStep journals run status changes, integrations, retry runs and started waves', async t => {
  const root = await tempRoot(t);
  const journal = [];
  const deps = {
    loadRuns: async () => [{ id: 'r-done', status: 'complete', integrated: false, counts: { complete: 2 } }, { id: 'r-bad', status: 'failed', counts: { failed: 1 } }],
    readJournal: async () => journal,
    appendEvent: async (_root, event) => { journal.push(event); },
    readPlan: async () => ({ waves: [{ id: 'w1', manifest: 'coordination/manifests/w1.json' }] }),
    checkout: async () => ({ branch: 'swarm/x', dirty: false }),
    integrate: async () => ({ files: 3 }),
    resume: async () => { throw new Error('not used'); },
    retryFailed: async () => ({ run: 'r-retry', status: 'running' }),
    startWave: async () => ({ run: 'r-wave', status: 'running' }),
  };
  await autopilotStep(root, deps, { now: () => NOW });
  const kinds = journal.map(e => `${e.kind}:${e.action ?? e.status ?? ''}`);
  assert.ok(journal.some(e => e.kind === 'run' && e.id === 'r-done' && e.status === 'complete'), 'run status synced');
  assert.ok(journal.some(e => e.kind === 'integration' && e.run === 'r-done' && e.files === 3), kinds.join(','));
  assert.ok(journal.some(e => e.kind === 'run' && e.id === 'r-retry' && e.retryOf === 'r-bad'));
  assert.ok(journal.some(e => e.kind === 'run' && e.id === 'r-wave' && e.manifest === 'coordination/manifests/w1.json'));
});

test('a journal that cannot be read or written means no actions', async t => {
  const root = await tempRoot(t);
  const runs = [{ id: 'r1', status: 'complete', integrated: false }, { id: 'r2', status: 'failed', counts: { failed: 1 } }];
  const unreadable = fakeDeps({ runs, readJournal: async () => { throw new Error('EIO'); } });
  const blind = await autopilotStep(root, unreadable, { now: () => NOW });
  assert.deepEqual(blind.actions, []);
  assert.match(blind.error, /journal-unreadable/);
  assert.equal(callsNamed(unreadable, 'integrate').length + callsNamed(unreadable, 'retryFailed').length, 0);

  const unwritable = fakeDeps({ runs, appendEvent: async () => { throw new Error('ENOSPC'); } });
  const stuck = await autopilotStep(root, unwritable, { now: () => NOW });
  assert.match(stuck.error, /journal-unwritable/);
  assert.equal(callsNamed(unwritable, 'integrate').length, 0, 'the run-status sync already finds the journal broken, so nothing is started');
  assert.equal(callsNamed(unwritable, 'retryFailed').length, 0);

  // across steps, the loop stops and nothing repeats even though the journal never records anything
  const results = await runAutopilot(root, fakeDeps({ runs, appendEvent: async () => { throw new Error('ENOSPC'); } }), { maxSteps: 5, sleep: async () => {}, now: () => NOW });
  assert.equal(results.length, 1);
});

test('the once-only memory stops a paid retry or wave from repeating when the journal forgets it', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({ runs: [{ id: 'r2', status: 'failed', counts: { failed: 1 } }], readJournal: async () => [], plan: { waves: [{ id: 'w1', manifest: 'm.json' }] } });
  const memory = new Set();
  await autopilotStep(root, deps, { now: () => NOW, memory });
  await autopilotStep(root, deps, { now: () => NOW, memory });
  assert.equal(callsNamed(deps, 'retryFailed').length, 1);
  assert.equal(callsNamed(deps, 'startWave').length, 1);
});

test('autopilot only integrates from a clean swarm/* branch or a linked worktree; otherwise it adds one blocker', async t => {
  const run = { id: 'r1', status: 'complete', integrated: false };
  const cases = [
    [{ branch: 'main', dirty: false }, /on main/],
    [{ branch: 'master', dirty: false, linkedWorktree: true }, /on master/],
    [{ branch: 'swarm/work', dirty: true }, /uncommitted/],
    [{ branch: 'feat/x', dirty: false }, /not a swarm\/\* branch/],
    [{ branch: '', dirty: false }, /not on a branch/],
    [undefined, /could not be inspected/],
  ];
  for (const [checkout, pattern] of cases) {
    const root = await tempRoot(t);
    const deps = fakeDeps({ runs: [run], checkout: async () => checkout });
    const memory = new Set();
    const step = await autopilotStep(root, deps, { now: () => NOW, memory });
    assert.equal(callsNamed(deps, 'integrate').length, 0);
    assert.deepEqual(step.blocked, ['integrate-checkout-r1']);
    const blocker = deps.calls.find(c => c[0] === 'appendEvent' && c[1].kind === 'blocker')[1];
    assert.match(blocker.text, pattern);
    await autopilotStep(root, deps, { now: () => NOW, memory });
    assert.equal(deps.calls.filter(c => c[0] === 'appendEvent' && c[1].kind === 'blocker').length, 1, 'one blocker only');
  }
  assert.equal(integrationBlocker({ branch: 'swarm/go-1', dirty: false }), null);
  assert.equal(integrationBlocker({ branch: 'work', dirty: false, linkedWorktree: true }), null);
  const throwing = fakeDeps({ runs: [run], checkout: async () => { throw new Error('git missing'); } });
  assert.equal((await autopilotStep(await tempRoot(t), throwing, { now: () => NOW })).blocked.length, 1);
});
