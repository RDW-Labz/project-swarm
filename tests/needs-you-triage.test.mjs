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
} from '../tools/needs-you-triage.mjs';
import { integrateBlockerSuppressed } from '../tools/journal.mjs';
import { readyAutopilotDeps, buildNeedsYouTriageHandlers } from '../tools/autopilot-ready-deps.mjs';

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
  assert.equal(classifyInboxItem(item({ id: 'integrate-checkout-RUN', title: 'wrong branch', integrateCause: 'the checkout is on feature/foo, not a swarm/* branch' })), 'fixable');
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
  assert.equal(appended.length, 0);
});

test('production deps expose handlers and run a fake item through them', async t => {
  const root = await tmp(t);
  const handlers = buildNeedsYouTriageHandlers(root, {
    integrate: async () => ({ files: 1 }),
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
      readJournal: async () => [],
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
    id: 'integrate-checkout-r1',
    text: 'dirty',
    integrateKind: 'integrate-checkout',
    integrateRun: 'r1',
    integrateCause: 'the checkout is on swarm/foo',
  }];
  const inboxItem = {
    kind: 'blocker',
    id: 'integrate-checkout-r1',
    project: root,
    title: 'dirty',
    integrateCause: 'the checkout is on swarm/foo',
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
        'integrate-checkout': async () => ({ ok: true }),
      },
    },
  };
  await runNeedsYouTriagePass(root, deps);
  const resolution = journal.find(e => e.resolved === true && e.integrateKey);
  assert.ok(resolution?.integrateCauseKey);
  assert.ok(integrateBlockerSuppressed(journal, {
    id: inboxItem.id,
    integrateKind: 'integrate-checkout',
    integrateRun: 'r1',
    integrateCause: inboxItem.integrateCause,
  }));
  journal.push({
    kind: 'blocker',
    id: 'integrate-checkout-r1',
    text: 'dirty again',
    integrateKind: 'integrate-checkout',
    integrateRun: 'r1',
    integrateCause: inboxItem.integrateCause,
  });
  assert.ok(integrateBlockerSuppressed(journal, {
    id: inboxItem.id,
    integrateKind: 'integrate-checkout',
    integrateRun: 'r1',
    integrateCause: inboxItem.integrateCause,
  }));
});

test('stale triage lock is replaced when owner pid is dead', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.dirname(triageLockPath(root)), { recursive: true });
  await fs.writeFile(triageLockPath(root), `${JSON.stringify({ pid: 999999, at: NOW - 60_000 })}\n`, { mode: 0o600 });
  const lock = await acquireTriageLock(root, { now: () => NOW, isPidAlive: () => false });
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

test('works with a fake second project root', async t => {
  const a = await tmp(t);
  const b = await tmp(t);
  const items = [
    { kind: 'blocker', id: 'split-park-S1-T-2', project: a, title: 'a', unblocks: 0, since: '2025-01-01T00:00:00.000Z' },
    { kind: 'blocker', id: 'integrate-R2--x', project: b, title: 'b', unblocks: 0, since: '2025-01-01T00:00:00.000Z' },
  ];
  const closed = [];
  const deps = {
    now: () => NOW,
    readJournal: async () => [],
    appendEvent: async (r, e) => { closed.push({ r, e }); },
    listTriageRoots: () => [a, b],
    collectInbox: async () => items,
    needsYouTriage: {
      handlers: {
        'split-park': async () => ({ ok: true }),
        integrate: async () => ({ ok: true }),
      },
    },
  };
  const out = await runNeedsYouTriagePass(a, deps);
  assert.equal(out.results.length, 2);
  assert.equal(closed.length, 2);
  assert.ok(closed.some(entry => entry.r === b));
});
