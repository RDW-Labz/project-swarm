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
  inboxItemSubtype,
  runNeedsYouTriagePass,
  readTriageState,
  writeTriageState,
  triageStatePath,
  MAX_TRIAGE_ATTEMPTS,
} from '../tools/needs-you-triage.mjs';

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
  assert.equal(classifyInboxItem(item({ id: 'integrate-checkout-RUN', title: 'dirty tree' })), 'fixable');
  assert.equal(classifyInboxItem(item({ id: 'ci-failure-batch-2', title: 'CI failed' })), 'fixable');
  assert.equal(inboxItemSubtype(item({ id: 'split-park-x' })), 'split-park');
  assert.equal(inboxItemSubtype(item({ id: 'integrate-checkout-R1' })), 'integrate-checkout');
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
  const journal = [{ kind: 'blocker', id: 'ci-failure-1', text: 'ci broke' }];
  const appended = [];
  const goals = [];
  const inboxItem = {
    kind: 'blocker',
    id: 'ci-failure-1',
    project: root,
    title: 'ci broke',
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
        'ci-failure': async () => ({ ok: false, error: 'still red' }),
      },
    },
  };
  await fs.writeFile(path.join(path.dirname(swarmRoot), '.swarm-projects.json'), JSON.stringify([swarmRoot]), 'utf8');
  for (let i = 0; i < MAX_TRIAGE_ATTEMPTS; i += 1) {
    await runNeedsYouTriagePass(root, deps);
  }
  assert.equal(goals.length, 1);
  assert.ok(goals[0].spec.goal.includes('SWARM-FIX:'));
  assert.ok(appended.some(e => e.e?.resolved === true));
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
