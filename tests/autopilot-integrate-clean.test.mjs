// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  autopilotStep,
  integrationBlocker,
  integrateCheckoutDirtyFromPorcelain,
} from '../tools/autopilot.mjs';
import { integrateOutputCollisions } from '../tools/generated-state.mjs';

const NOW = Date.parse('2030-01-01T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-integrate-clean-'));
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
    checkout: async () => ({ branch: 'swarm/work', dirty: false }),
    integrate: async (...args) => { calls.push(['integrate', ...args]); return { files: 1 }; },
    resume: async () => {},
    retryFailed: async () => ({}),
    startWave: async () => ({}),
    ...fns,
  };
}

const outputRun = {
  id: 'r-out',
  status: 'complete',
  integrated: false,
  integrable: true,
};

const manifestEvent = {
  kind: 'run',
  id: 'r-out',
  status: 'complete',
  manifest: {
    jobs: [{ id: 'j1', outputs: ['src/widget.mjs'], status: 'complete' }],
  },
};

function gitStateView(overrides = {}) {
  return {
    branch: 'swarm/work',
    dirty: false,
    integrateTrackedDirty: [],
    integrateCollisions: [],
    ...overrides,
  };
}

test('untracked junk does not block integrate on a swarm branch', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    journal: [manifestEvent],
    runs: [outputRun],
    integrateCheckoutGitState: async () => gitStateView({
      integrateTrackedDirty: [],
      integrateCollisions: [],
    }),
  });
  const step = await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  assert.equal(step.blocked.length, 0);
  assert.equal(deps.calls.some(c => c[0] === 'integrate'), true);
});

test('tracked modification of an unrelated file does not block integrate', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    journal: [manifestEvent],
    runs: [outputRun],
    integrateCheckoutGitState: async () => gitStateView({
      integrateTrackedDirty: [{ code: ' M', path: 'notes/scratch.txt' }],
      integrateCollisions: [],
    }),
  });
  const step = await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  assert.deepEqual(step.blocked, []);
  assert.equal(deps.calls.filter(c => c[0] === 'integrate').length, 1);
});

test('collision on a declared output path blocks and names the path', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    journal: [manifestEvent],
    runs: [outputRun],
    integrateCheckoutGitState: async () => gitStateView({
      integrateTrackedDirty: [{ code: ' M', path: 'src/widget.mjs' }],
      integrateCollisions: ['src/widget.mjs'],
    }),
  });
  const step = await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  assert.deepEqual(step.blocked, ['integrate-checkout-r-out']);
  const blocker = deps.calls.find(c => c[0] === 'appendEvent' && c[1].kind === 'blocker')?.[1];
  assert.match(blocker.text, /src\/widget\.mjs/);
  assert.equal(deps.calls.some(c => c[0] === 'integrate'), false);
});

test('integrateCheckoutDirtyFromPorcelain ignores untracked lines', () => {
  assert.equal(integrateCheckoutDirtyFromPorcelain('?? notes/local.txt\n'), false);
  assert.equal(integrateCheckoutDirtyFromPorcelain(' M src/other.mjs\n'), true);
});

test('integrationBlocker names output-path collisions', () => {
  const why = integrationBlocker({
    branch: 'swarm/work',
    dirty: false,
    integrateTrackedDirty: [],
    integrateCollisions: ['src/widget.mjs'],
  });
  assert.match(why, /src\/widget\.mjs/);
});

test('splitter and review runs produce no integrate item and close stale checkout blockers', async t => {
  const root = await tempRoot(t);
  const journal = [
    { kind: 'blocker', id: 'integrate-checkout-split1', text: 'stale', ts: iso(NOW - 1000) },
    { kind: 'blocker', id: 'integrate-split1', text: 'stale integrate', ts: iso(NOW - 1000) },
  ];
  const deps = fakeDeps({
    journal,
    runs: [{ id: 'split1', status: 'complete', integrated: false, integrable: false }],
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.deepEqual(step.blocked, []);
  assert.equal(deps.calls.some(c => c[0] === 'integrate'), false);
  assert.ok(journal.some(e => e.id === 'integrate-checkout-split1' && e.resolved === true));
  assert.ok(journal.some(e => e.id === 'integrate-split1' && e.resolved === true));
});

test('integrateOutputCollisions only lists declared outputs', () => {
  const hits = integrateOutputCollisions(
    ['src/widget.mjs'],
    [{ code: ' M', path: 'notes/x.txt' }, { code: ' M', path: 'src/widget.mjs' }],
    [{ code: '??', path: 'src/widget.mjs' }],
  );
  assert.deepEqual(hits, ['src/widget.mjs']);
});

test('autopilot never stashes or removes files during integrate gating', async t => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });
  await fs.writeFile(path.join(root, 'notes/keep-me.txt'), 'stay\n');
  const deps = fakeDeps({
    journal: [manifestEvent],
    runs: [outputRun],
    integrateCheckoutGitState: async () => gitStateView(),
    stash: async () => { throw new Error('must not stash'); },
    gitClean: async () => { throw new Error('must not clean'); },
  });
  await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  const text = await fs.readFile(path.join(root, 'notes/keep-me.txt'), 'utf8');
  assert.equal(text, 'stay\n');
});
