// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyInboxItem,
  buildOwnerDecisionText,
  buildIntegrateCheckoutOwnerDecisionText,
  inboxItemSubtype,
  runNeedsYouTriagePass,
  readTriageState,
  writeTriageState,
  triageStatePath,
  triageLockPath,
  buildHandlersMap,
  acquireTriageLock,
  RISKY_WORD_FRAGMENTS,
  MAX_TRIAGE_ATTEMPTS,
  REOPEN_SUPPRESS_MS,
  SWARM_FIX_INTEGRATE_SUPPRESS_MS,
} from '../tools/needs-you-triage.mjs';
import { integrateBlockerSuppressed } from '../tools/journal.mjs';
import { readyAutopilotDeps, buildNeedsYouTriageHandlers, integrateTriageSucceeded } from '../tools/autopilot-ready-deps.mjs';

const NOW = Date.parse('2025-03-01T12:00:00Z');

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'needs-you-triage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.swarm', 'project'), { recursive: true });
  return dir;
}

function item(overrides) {
  return { project: '/proj', kind: 'blocker', id: 'x', title: 't', unblocks: 0, since: '2025-01-01T00:00:00.000Z', ...overrides };
}

test('classification table: owner vs fixable', () => {
  assert.equal(classifyInboxItem(item({ id: 'cap-R1', title: 'Run R1 is paused on a spend cap' })), 'owner');
  assert.equal(classifyInboxItem(item({ title: 'paid service upgrade required' })), 'owner');
  assert.equal(classifyInboxItem(item({ title: 'production merge to main blocked' })), 'owner');
  assert.equal(classifyInboxItem(item({ title: 'live deploy waiting' })), 'owner');
  assert.equal(classifyInboxItem(item({ title: 'expired login for npm' })), 'owner');
  assert.equal(classifyInboxItem(item({ title: 'subscription payment failed' })), 'owner');
  assert.equal(classifyInboxItem({
    kind: 'decision',
    id: 'd1',
    text: 'Pick database',
    choices: ['sqlite', 'postgres'],
    default: 'sqlite',
  }), 'owner');

  assert.equal(classifyInboxItem(item({ id: 'split-park-S1-T-1', title: 'split parked' })), 'fixable');
  assert.equal(classifyInboxItem(item({ id: 'integrate-RUN--abc', title: 'integrate failed' })), 'fixable');
  assert.equal(classifyInboxItem(item({
    id: 'integrate-checkout-RUN',
    title: 'dirty tree',
    integrateCause: 'the checkout has uncommitted tracked changes on src/foo.mjs; commit or move them before integrating',
  })), 'owner');
  assert.ok(buildIntegrateCheckoutOwnerDecisionText(item({
    id: 'integrate-checkout-RUN',
    integrateCause: 'the checkout is on main',
  }))?.startsWith('Decision needed:'));
  assert.equal(classifyInboxItem(item({ id: 'integrate-checkout-RUN', title: 'wrong branch', integrateCause: 'the checkout is on feature/foo, not a swarm/* branch' })), 'owner');
  assert.equal(classifyInboxItem(item({ id: 'integrate-checkout-RUN', integrateCause: 'a revert is in progress in the checkout' })), 'owner');
  assert.equal(classifyInboxItem(item({ id: 'integrate-checkout-RUN', integrateCause: 'the checkout could not be inspected' })), 'owner');
  assert.equal(classifyInboxItem(item({ id: 'ci-failure-batch-2', title: 'CI failed', batch: 2 })), 'owner');
  assert.equal(classifyInboxItem(item({ id: 'ci-failure-sec', title: 'security scan failed' })), 'owner');
  assert.equal(classifyInboxItem(item({ id: 'ci-failure-x', title: 'unknown CI' })), 'owner');
  assert.equal(classifyInboxItem(item({ id: 'mystery-blocker', title: 'something odd' })), 'owner');
  assert.equal(classifyInboxItem(item({ title: '' })), 'owner');
  assert.equal(classifyInboxItem(item({ id: 'split-park-S1-T-1', title: 'deploy retry parked' })), 'owner');
  assert.equal(inboxItemSubtype(item({ id: 'split-park-x' })), 'split-park');
  assert.equal(inboxItemSubtype(item({ id: 'integrate-checkout-R1' })), 'integrate-checkout');
  assert.equal(classifyInboxItem(item({ triageKind: 'constructor', title: 'harmless' })), 'owner');
});

test('each risky word fragment classifies as owner on allowlisted kinds', () => {
  for (const word of RISKY_WORD_FRAGMENTS) {
    const title = `split parked ${word} noise`;
    assert.equal(classifyInboxItem(item({ id: 'split-park-S1-T-9', title })), 'owner', word);
  }
});

test('buildHandlersMap ignores prototype property names', () => {
  const raw = Object.create(null);
  raw['split-park'] = async () => ({ ok: true });
  raw.constructor = async () => ({ ok: true });
  raw.toString = async () => ({ ok: true });
  const handlers = buildHandlersMap(raw);
  assert.equal(typeof handlers['split-park'], 'function');
  assert.equal(Object.hasOwn(handlers, 'constructor'), false);
  assert.equal(Object.hasOwn(handlers, 'toString'), false);
});

test('owner decision text is required shape and blocks handlers', async t => {
  const root = await tmp(t);
  const events = [];
  const ownerItem = {
    kind: 'decision',
    id: 'd9',
    project: root,
    text: 'Ship now?',
    choices: ['yes', 'no'],
    default: 'yes',
    title: 'Ship now?',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  const handlerCalls = [];
  const out = await runNeedsYouTriagePass(root, {
    now: () => NOW,
    readJournal: async () => [],
    appendEvent: async (r, e) => { events.push({ r, e }); },
    collectInbox: async () => [ownerItem],
    needsYouTriage: {
      handlers: {
        generic: async () => { handlerCalls.push('generic'); return { ok: true }; },
      },
    },
  });
  assert.equal(handlerCalls.length, 0);
  const decision = buildOwnerDecisionText(ownerItem);
  assert.ok(decision?.startsWith('Decision needed:'));
  assert.ok(decision.includes('Options:'));
  assert.ok(decision.includes('Why only you:'));
  assert.equal(out.results[0].action, 'owner');
  assert.equal(out.results[0].decision, decision);
  assert.equal(events.length, 1);
  assert.equal(events[0].e.kind, 'decision');
  assert.equal(events[0].e.text, decision);
});

test('fixable item is retried then closed on success', async t => {
  const root = await tmp(t);
  const journal = [{ kind: 'blocker', id: 'split-park-S1-T-1', text: 'parked' }];
  const appended = [];
  let calls = 0;
  const inboxItem = {
    kind: 'blocker',
    id: 'split-park-S1-T-1',
    project: root,
    title: 'parked',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  const deps = {
    now: () => NOW,
    readJournal: async () => journal,
    appendEvent: async (r, e) => { appended.push(e); journal.push(e); },
    collectInbox: async () => [inboxItem],
    needsYouTriage: {
      handlers: {
        'split-park': async () => {
          calls += 1;
          return calls >= 2 ? { ok: true } : { ok: false, error: 'still broken' };
        },
      },
    },
  };
  const first = await runNeedsYouTriagePass(root, deps);
  assert.equal(first.results[0].action, 'retry');
  assert.equal(calls, 1);
  const second = await runNeedsYouTriagePass(root, deps);
  assert.equal(second.results[0].action, 'closed');
  assert.ok(appended.some(e => e.resolved === true && e.triageClosed === true));
});

test('third failure opens exactly one swarm-fix goal and closes the item', async t => {
  const root = await tmp(t);
  const swarmRoot = await tmp(t);
  const journal = [{ kind: 'blocker', id: 'split-park-S1-T-99', text: 'parked' }];
  const appended = [];
  const goals = [];
  const inboxItem = {
    kind: 'blocker',
    id: 'split-park-S1-T-99',
    project: root,
    title: 'parked',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  const deps = {
    now: () => NOW,
    installRoot: path.dirname(swarmRoot),
    swarmRoot,
    readJournal: async () => journal,
    appendEvent: async (r, e) => { appended.push({ r, e }); journal.push(e); },
    collectInbox: async () => [inboxItem],
    addGoal: async (r, spec) => { goals.push({ r, spec }); return { id: 'G-fix-1', ...spec }; },
    needsYouTriage: {
      handlers: {
        'split-park': async () => ({ ok: false, error: 'still red' }),
      },
    },
  };
  await fs.writeFile(path.join(path.dirname(swarmRoot), '.swarm-projects.json'), JSON.stringify([swarmRoot]), 'utf8');
  for (let i = 0; i < MAX_TRIAGE_ATTEMPTS; i += 1) {
    await runNeedsYouTriagePass(root, deps);
  }
  assert.equal(goals.length, 1);
  assert.ok(goals[0].spec.goal.includes('SWARM-FIX:'));
  assert.ok(goals[0].spec.goal.includes('subtype=split-park'));
  assert.ok(!goals[0].spec.goal.includes('parked'));
  assert.ok(!goals[0].spec.goal.includes(root));
  assert.ok(appended.some(e => e.e?.resolved === true));
});

test('swarm-fix does not close or claim a goal without an id', async t => {
  const root = await tmp(t);
  const inboxItem = {
    kind: 'blocker',
    id: 'split-park-S1-T-9',
    project: root,
    title: 'parked',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  const journal = [{ kind: 'blocker', id: inboxItem.id, text: 'parked' }];
  const appended = [];
  const deps = {
    now: () => NOW,
    swarmRoot: root,
    readJournal: async () => journal,
    appendEvent: async (r, e) => { appended.push(e); journal.push(e); },
    collectInbox: async () => [inboxItem],
    addGoal: async () => ({}),
    needsYouTriage: {
      handlers: {
        'split-park': async () => ({ ok: false, error: 'still red' }),
      },
    },
  };
  for (let i = 0; i < MAX_TRIAGE_ATTEMPTS; i += 1) {
    await runNeedsYouTriagePass(root, deps);
  }
  assert.equal(appended.filter(e => e.resolved === true).length, 0);
});

test('missing swarm root leaves item stuck without double SWARM-FIX log', async t => {
  const root = await tmp(t);
  const logs = [];
  const inboxItem = {
    kind: 'blocker',
    id: 'split-park-S1-T-3',
    project: root,
    title: 'parked',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  const deps = {
    now: () => NOW,
    readJournal: async () => [{ kind: 'blocker', id: inboxItem.id, text: 'parked' }],
    appendEvent: async () => {},
    collectInbox: async () => [inboxItem],
    addGoal: async () => { throw new Error('should not write goal into app repo'); },
    needsYouTriage: {
      handlers: {
        'split-park': async () => ({ ok: false, error: 'nope' }),
      },
    },
  };
  for (let i = 0; i < MAX_TRIAGE_ATTEMPTS; i += 1) {
    await runNeedsYouTriagePass(root, deps, { log: line => logs.push(line) });
  }
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('SWARM-FIX'));
  await runNeedsYouTriagePass(root, deps, { log: line => logs.push(line) });
  assert.equal(logs.length, 1);
  const state = await readTriageState(root);
  assert.equal(state.items[`${root}:blocker:${inboxItem.id}`]?.exhausted, true);
});

test('corrupt triage state aborts the pass without resetting counts', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.dirname(triageStatePath(root)), { recursive: true });
  await fs.writeFile(triageStatePath(root), '{not-json', 'utf8');
  const calls = [];
  const out = await runNeedsYouTriagePass(root, {
    now: () => NOW,
    readJournal: async () => [],
    appendEvent: async () => {},
    collectInbox: async () => {
      calls.push('inbox');
      return [{ kind: 'blocker', id: 'split-park-S1-T-1', project: root, title: 'x', unblocks: 0, since: '2025-01-01T00:00:00.000Z' }];
    },
    needsYouTriage: { handlers: { 'split-park': async () => ({ ok: true }) } },
  });
  assert.equal(out.error, 'state-unreadable');
  assert.equal(calls.length, 0);
});

test('triage lock excludes a concurrent pass', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.dirname(triageLockPath(root)), { recursive: true });
  await fs.writeFile(triageLockPath(root), `${JSON.stringify({ pid: 424242, at: NOW })}\n`, { mode: 0o600 });
  const out = await runNeedsYouTriagePass(root, {
    now: () => NOW,
    isPidAlive: () => true,
    readJournal: async () => [],
    appendEvent: async () => {},
    collectInbox: async () => [{ kind: 'blocker', id: 'split-park-S1-T-1', project: root, title: 'x', unblocks: 0, since: '2025-01-01T00:00:00.000Z' }],
    needsYouTriage: { handlers: { 'split-park': async () => ({ ok: true }) } },
  });
  assert.equal(out.skipped, 'locked');
});

test('reopen suppression never auto-closes an owner-class item', async t => {
  const root = await tmp(t);
  const ownerItem = {
    kind: 'decision',
    id: 'd-reopen',
    project: root,
    text: 'Pick?',
    choices: ['a', 'b'],
    title: 'Pick?',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  const state = await readTriageState(root);
  state.suppressReopen[`${root}:decision:d-reopen`] = NOW + REOPEN_SUPPRESS_MS;
  await writeTriageState(root, state);
  const appended = [];
  const out = await runNeedsYouTriagePass(root, {
    now: () => NOW,
    readJournal: async () => [],
    appendEvent: async (r, e) => { appended.push(e); },
    collectInbox: async () => [ownerItem],
  });
  assert.equal(out.results[0]?.action, 'owner');
  assert.ok(!appended.some(e => e.resolved === true || e.done === true));
  assert.equal(appended.filter(e => e.kind === 'decision').length, 1);
});

test('production deps expose handlers and run a fake item through them', async t => {
  const root = await tmp(t);
  const handlers = buildNeedsYouTriageHandlers(root, {
    integrate: async () => ({ status: 'integrated', checksPassed: true, files: 1 }),
  });
  assert.equal(typeof handlers.integrate, 'function');
  assert.equal(handlers['ci-failure'], undefined);
  const ready = readyAutopilotDeps(root, {
    spawnImpl: () => ({ once() {}, unref() {} }),
    liveBusyMarkers: async () => [],
    listLiveRuns: async () => [],
    checkProjectCap: async () => null,
    readTickets: async () => [],
    readPending: async () => [],
  });
  assert.equal(typeof ready.needsYouTriage?.handlers?.['split-park'], 'function');
  const out = await handlers.integrate({
    root,
    item: { id: 'integrate-RUN--abc', title: 'integrate' },
    deps: {
      readJournal: async () => [{ kind: 'run', id: 'RUN' }],
      listRuns: async () => [{ id: 'RUN', status: 'complete', jobs: [] }],
      checkout: async () => ({ branch: 'swarm/test', linkedWorktree: false, dirty: false }),
      integrateCheckoutGitState: async () => ({
        branch: 'swarm/test',
        linkedWorktree: false,
        mergeInProgress: false,
        rebaseInProgress: false,
        cherryPickInProgress: false,
        integrateTrackedDirty: [],
        integrateCollisions: [],
        unmergedPaths: [],
      }),
    },
  });
  assert.equal(out.ok, true);
});

test('closed integrate blocker records resolution keys and suppresses re-raise', async t => {
  const root = await tmp(t);
  const journal = [{
    kind: 'blocker',
    id: 'integrate-r1',
    text: 'gate failed',
    integrateKind: 'integrate',
    integrateRun: 'r1',
    integrateCause: 'integration checks failed',
  }];
  const inboxItem = {
    kind: 'blocker',
    id: 'integrate-r1',
    project: root,
    title: 'gate failed',
    integrateCause: 'integration checks failed',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  const deps = {
    now: () => NOW,
    readJournal: async () => journal,
    appendEvent: async (r, e) => { journal.push(e); },
    collectInbox: async () => [inboxItem],
    needsYouTriage: {
      handlers: {
        integrate: async () => ({ ok: true }),
      },
    },
  };
  await runNeedsYouTriagePass(root, deps);
  const resolution = journal.find(e => e.resolved === true && e.integrateKey);
  assert.ok(resolution?.integrateCauseKey);
  assert.ok(resolution?.integrateSuppressUntil);
  const fields = {
    id: inboxItem.id,
    integrateKind: 'integrate',
    integrateRun: 'r1',
    integrateCause: inboxItem.integrateCause,
  };
  assert.ok(integrateBlockerSuppressed(journal, fields, { now: NOW }));
  const afterExpiry = NOW + SWARM_FIX_INTEGRATE_SUPPRESS_MS + 1;
  assert.equal(integrateBlockerSuppressed(journal, fields, { now: afterExpiry }), false);
  journal.push({
    kind: 'blocker',
    id: 'integrate-r1',
    text: 'gate failed again',
    integrateKind: 'integrate',
    integrateRun: 'r1',
    integrateCause: inboxItem.integrateCause,
  });
  assert.ok(integrateBlockerSuppressed(journal, fields, { now: NOW }));
});

test('integrate-checkout blockers are owner items with decision text from cause', async t => {
  const root = await tmp(t);
  const inboxItem = {
    kind: 'blocker',
    id: 'integrate-checkout-r1',
    project: root,
    title: 'blocked',
    integrateCause: 'the checkout has unmerged paths: foo.mjs',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  let handlerCalls = 0;
  const out = await runNeedsYouTriagePass(root, {
    now: () => NOW,
    readJournal: async () => [],
    appendEvent: async () => {},
    collectInbox: async () => [inboxItem],
    needsYouTriage: {
      handlers: {
        'integrate-checkout': async () => { handlerCalls += 1; return { ok: true }; },
      },
    },
  });
  assert.equal(handlerCalls, 0);
  assert.equal(out.results[0].action, 'owner');
  assert.ok(out.results[0].decision?.includes('unmerged paths'));
});

test('swarm-fix integrate close expires suppression after 24 hours', async t => {
  const root = await tmp(t);
  const swarmRoot = await tmp(t);
  const journal = [{ kind: 'blocker', id: 'integrate-r1', text: 'fail' }];
  const inboxItem = {
    kind: 'blocker',
    id: 'integrate-r1',
    project: root,
    title: 'fail',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  const deps = {
    now: () => NOW,
    swarmRoot,
    readJournal: async () => journal,
    appendEvent: async (r, e) => { journal.push(e); },
    collectInbox: async () => [inboxItem],
    addGoal: async () => ({ id: 'G-swarm-1' }),
    needsYouTriage: {
      handlers: {
        integrate: async () => ({ ok: false, error: 'nope' }),
      },
    },
  };
  for (let i = 0; i < MAX_TRIAGE_ATTEMPTS; i += 1) {
    await runNeedsYouTriagePass(root, deps);
  }
  const resolution = journal.find(e => e.resolved === true && e.integrateSuppressUntil);
  assert.ok(resolution);
  const fields = {
    id: 'integrate-r1',
    integrateKind: 'integrate',
    integrateRun: 'r1',
    integrateCause: resolution.integrateCause,
  };
  assert.ok(integrateBlockerSuppressed(journal, fields, { now: NOW }));
  const afterExpiry = NOW + SWARM_FIX_INTEGRATE_SUPPRESS_MS + 1;
  assert.equal(integrateBlockerSuppressed(journal, fields, { now: afterExpiry }), false);
});

test('reopened integrate blocker with existing swarm-fix goal stays owner without new goal', async t => {
  const root = await tmp(t);
  const swarmRoot = await tmp(t);
  const journal = [{ kind: 'blocker', id: 'integrate-r1', text: 'fail' }];
  const inboxItem = {
    kind: 'blocker',
    id: 'integrate-r1',
    project: root,
    title: 'fail',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  let goalCalls = 0;
  const deps = {
    now: () => NOW,
    swarmRoot,
    readJournal: async () => journal,
    appendEvent: async (r, e) => { journal.push(e); },
    collectInbox: async () => [inboxItem],
    addGoal: async () => { goalCalls += 1; return { id: 'G-one' }; },
    needsYouTriage: {
      handlers: {
        integrate: async () => ({ ok: false, error: 'nope' }),
      },
    },
  };
  for (let i = 0; i < MAX_TRIAGE_ATTEMPTS; i += 1) {
    await runNeedsYouTriagePass(root, deps);
  }
  assert.equal(goalCalls, 1);
  journal.push({ kind: 'blocker', id: 'integrate-r1', text: 'fail again' });
  const out = await runNeedsYouTriagePass(root, deps);
  assert.equal(goalCalls, 1);
  assert.equal(out.results[0].action, 'owner');
  assert.ok(out.results[0].decision?.includes('G-one'));
  const ownerNote = journal.find(e => e.kind === 'note' && e.text?.includes('G-one'));
  assert.ok(ownerNote);
});

test('integrate handler refuses when run has integratable jobs but no output paths', async t => {
  const root = await tmp(t);
  const handlers = buildNeedsYouTriageHandlers(root, {
    integrate: async () => ({ status: 'ok' }),
  });
  const run = {
    id: 'RUN',
    integrable: true,
    counts: { complete: 1 },
    jobs: [{ id: 'j1', status: 'complete', outputs: [] }],
  };
  const out = await handlers.integrate({
    root,
    item: { id: 'integrate-RUN--abc', title: 'integrate', outputPaths: ['should-not-use.mjs'] },
    deps: {
      readJournal: async () => [{ kind: 'run', id: 'RUN', manifest: { jobs: run.jobs } }],
      listRuns: async () => [run],
      checkout: async () => ({ branch: 'swarm/test', linkedWorktree: false, dirty: false }),
      integrateCheckoutGitState: async () => ({
        branch: 'swarm/test',
        linkedWorktree: false,
        mergeInProgress: false,
        rebaseInProgress: false,
        cherryPickInProgress: false,
        integrateTrackedDirty: [],
        integrateCollisions: [],
        unmergedPaths: [],
      }),
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /no declared output paths/i);
});

test('stale triage lock is replaced when owner pid is dead', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.dirname(triageLockPath(root)), { recursive: true });
  await fs.writeFile(triageLockPath(root), `${JSON.stringify({ pid: 999999, at: NOW - 60_000 })}\n`, { mode: 0o600 });
  const lock = await acquireTriageLock(root, { now: () => NOW, isPidAlive: () => false });
  assert.equal(lock.ok, true);
});

test('stale triage lock is replaced when pid is alive but older than stale age', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.dirname(triageLockPath(root)), { recursive: true });
  await fs.writeFile(triageLockPath(root), `${JSON.stringify({ pid: 424242, at: NOW - 31 * 60_000 })}\n`, { mode: 0o600 });
  const lock = await acquireTriageLock(root, { now: () => NOW, isPidAlive: () => true });
  assert.equal(lock.ok, true);
});

test('attempt counters survive restart via state file', async t => {
  const root = await tmp(t);
  const state = await readTriageState(root);
  state.items['p:blocker:b1'] = { attempts: [{ pass: 1, error: 'e1' }, { pass: 2, error: 'e2' }], lastFailedPass: 2 };
  state.passCount = 2;
  await writeTriageState(root, state);
  const loaded = await readTriageState(root);
  assert.equal(loaded.items['p:blocker:b1'].attempts.length, 2);
  assert.ok(await fs.stat(triageStatePath(root)));
});

test('no reopen loop within one hour for the same cause', async t => {
  const root = await tmp(t);
  const journal = [];
  const inboxItem = {
    kind: 'blocker',
    id: 'integrate-RUN--cause',
    project: root,
    title: 'integrate',
    unblocks: 0,
    since: '2025-01-01T00:00:00.000Z',
  };
  let handlerCalls = 0;
  const deps = {
    now: () => NOW,
    readJournal: async () => journal,
    appendEvent: async (r, e) => { journal.push(e); },
    collectInbox: async () => [inboxItem],
    needsYouTriage: {
      handlers: {
        integrate: async () => { handlerCalls += 1; return { ok: true }; },
      },
    },
  };
  await runNeedsYouTriagePass(root, deps);
  assert.equal(handlerCalls, 1);
  journal.push({ kind: 'blocker', id: inboxItem.id, text: 'integrate again' });
  await runNeedsYouTriagePass(root, deps);
  assert.equal(handlerCalls, 1);
  const suppressed = (await readTriageState(root)).suppressReopen;
  assert.ok(Object.keys(suppressed).length >= 1);
});

test('pass triages only the primary project root', async t => {
  const a = await tmp(t);
  const b = await tmp(t);
  const items = [
    { kind: 'blocker', id: 'split-park-S1-T-2', project: a, title: 'a', unblocks: 0, since: '2025-01-01T00:00:00.000Z' },
    { kind: 'blocker', id: 'integrate-R2--x', project: b, title: 'b', unblocks: 0, since: '2025-01-01T00:00:00.000Z' },
  ];
  const closed = [];
  const collectedRoots = [];
  const deps = {
    now: () => NOW,
    readJournal: async () => [],
    appendEvent: async (r, e) => { closed.push({ r, e }); },
    collectInbox: async (roots) => {
      collectedRoots.push(roots);
      return items;
    },
    needsYouTriage: {
      handlers: {
        'split-park': async () => ({ ok: true }),
        integrate: async () => ({ ok: true }),
      },
    },
  };
  const out = await runNeedsYouTriagePass(a, deps);
  assert.deepEqual(collectedRoots[0], [a]);
  assert.equal(out.results.length, 1);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].r, a);
});

test('integrateTriageSucceeded accepts only integrated or merged with checks passed', () => {
  assert.equal(integrateTriageSucceeded({ status: 'integrated', checksPassed: true }).ok, true);
  assert.equal(integrateTriageSucceeded({ status: 'merged', checksPassed: true }).ok, true);
  assert.equal(integrateTriageSucceeded({ status: 'integrated', checksSkipped: true, checksPassed: true }).ok, true);
  assert.equal(integrateTriageSucceeded({ files: 1 }).ok, false);
  assert.equal(integrateTriageSucceeded({ status: 'partial' }).ok, false);
  assert.equal(integrateTriageSucceeded({ status: 'integrated', integrationStatus: 'queued' }).ok, false);
  assert.equal(integrateTriageSucceeded({ status: 'integrated', integrationStatus: 'partial' }).ok, false);
  assert.equal(integrateTriageSucceeded({ status: 'integrated', checksPassed: false }).ok, false);
  assert.equal(integrateTriageSucceeded({ status: 'failed' }).ok, false);
  assert.equal(integrateTriageSucceeded({ status: 'integrated', integrationStatus: 'failed-check' }).ok, false);
});

test('integrate handler returns run not found before output-path refusal', async t => {
  const root = await tmp(t);
  const handlers = buildNeedsYouTriageHandlers(root, {
    integrate: async () => ({ status: 'integrated', checksPassed: true }),
  });
  const out = await handlers.integrate({
    root,
    item: { id: 'integrate-MISSING--abc', title: 'integrate' },
    deps: {
      readJournal: async () => [],
      listRuns: async () => [],
      checkout: async () => ({ branch: 'swarm/test', linkedWorktree: false, dirty: false }),
      integrateCheckoutGitState: async () => ({
        branch: 'swarm/test',
        linkedWorktree: false,
        mergeInProgress: false,
        rebaseInProgress: false,
        cherryPickInProgress: false,
        integrateTrackedDirty: [],
        integrateCollisions: [],
        unmergedPaths: [],
      }),
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'run not found');
});

test('integrate handler rejects partial integrate result', async t => {
  const root = await tmp(t);
  const run = {
    id: 'RUN',
    status: 'complete',
    jobs: [{ id: 'j1', status: 'complete', outputs: ['out.mjs'] }],
  };
  const handlers = buildNeedsYouTriageHandlers(root, {
    integrate: async () => ({ status: 'partial', integrationStatus: 'queued' }),
  });
  const out = await handlers.integrate({
    root,
    item: { id: 'integrate-RUN--abc', title: 'integrate' },
    deps: {
      readJournal: async () => [{ kind: 'run', id: 'RUN', manifest: { jobs: run.jobs } }],
      listRuns: async () => [run],
      checkout: async () => ({ branch: 'swarm/test', linkedWorktree: false, dirty: false }),
      integrateCheckoutGitState: async () => ({
        branch: 'swarm/test',
        linkedWorktree: false,
        mergeInProgress: false,
        rebaseInProgress: false,
        cherryPickInProgress: false,
        integrateTrackedDirty: [],
        integrateCollisions: [],
        unmergedPaths: [],
      }),
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /incomplete/i);
});
