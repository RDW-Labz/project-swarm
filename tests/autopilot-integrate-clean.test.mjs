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
  runIntegrateOutputPaths,
} from '../tools/autopilot.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  integrateCheckoutGitState,
  integrateOutputCollisions,
  integratePathsCollide,
} from '../tools/generated-state.mjs';

const execFileAsync = promisify(execFile);

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

test('tracked modification outside output paths blocks and names files', async t => {
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
  assert.deepEqual(step.blocked, ['integrate-checkout-r-out']);
  const blocker = deps.calls.find(c => c[0] === 'appendEvent' && c[1].kind === 'blocker')?.[1];
  assert.match(blocker.text, /notes\/scratch\.txt/);
  assert.match(blocker.text, /commit or move/i);
  assert.equal(deps.calls.some(c => c[0] === 'integrate'), false);
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

test('runIntegrateOutputPaths falls back to run.jobs when manifest is missing', () => {
  const paths = runIntegrateOutputPaths(
    {
      id: 'r1',
      jobs: [{ id: 'j1', outputs: ['lib/a.mjs'] }],
    },
    [],
  );
  assert.deepEqual(paths, ['lib/a.mjs']);
});

test('runIntegrateOutputPaths includes child-run job outputs', () => {
  const paths = runIntegrateOutputPaths(
    {
      id: 'lead',
      jobs: [{ id: 'lead-j', childRun: 'child1' }],
    },
    [],
    {
      runs: [
        { id: 'child1', jobs: [{ id: 'c1', outputs: ['out/child.mjs'] }] },
      ],
    },
  );
  assert.deepEqual(paths, ['out/child.mjs']);
});

test('integratable run with no resolvable output paths blocks integrate', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    journal: [{ kind: 'run', id: 'r-empty', status: 'complete' }],
    runs: [{
      id: 'r-empty',
      status: 'complete',
      integrated: false,
      integrable: true,
      counts: { complete: 1 },
      jobs: [{ id: 'j1', status: 'complete', outputs: [] }],
    }],
  });
  const step = await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
  assert.deepEqual(step.blocked, ['integrate-checkout-r-empty']);
  assert.equal(deps.calls.some(c => c[0] === 'integrate'), false);
});

test('failed run with complete jobs does not auto-close integrate blockers', async t => {
  const root = await tempRoot(t);
  const journal = [
    { kind: 'blocker', id: 'integrate-checkout-r-fail', text: 'stale', ts: iso(NOW - 1000) },
  ];
  const deps = fakeDeps({
    journal,
    runs: [{
      id: 'r-fail',
      status: 'failed',
      integrated: false,
      integrable: true,
      counts: { complete: 1, failed: 1 },
      jobs: [{ id: 'j1', status: 'complete', outputs: ['src/x.mjs'] }],
    }],
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.deepEqual(step.blocked, []);
  assert.ok(!journal.some(e => e.id === 'integrate-checkout-r-fail' && e.resolved === true));
});

test('integratePathsCollide matches directory prefixes', () => {
  assert.equal(integratePathsCollide('src/pkg', 'src/pkg/deep/file.mjs'), true);
  assert.equal(integratePathsCollide('src/pkg/deep', 'src/pkg'), true);
});

test('integrateOutputCollisions is case-insensitive when configured', () => {
  const hits = integrateOutputCollisions(
    ['src/Widget.mjs'],
    [{ code: ' M', path: 'src/widget.mjs' }],
    [],
    { ignoreCase: true },
  );
  assert.deepEqual(hits, ['src/widget.mjs']);
});

test('integrationBlocker reports cherry-pick and unmerged paths', () => {
  assert.match(integrationBlocker({
    branch: 'swarm/work',
    dirty: false,
    cherryPickInProgress: true,
  }), /cherry-pick/);
  assert.match(integrationBlocker({
    branch: 'swarm/work',
    dirty: false,
    unmergedPaths: ['both.txt'],
  }), /both\.txt/);
});

test('integrateCheckoutGitState detects rebase-merge via git-path', async t => {
  const root = await tempRoot(t);
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
  await fs.writeFile(path.join(root, 'f.txt'), 'a\n');
  await execFileAsync('git', ['add', 'f.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
  const { stdout: gitDirOut } = await execFileAsync('git', ['rev-parse', '--git-path', 'rebase-merge'], { cwd: root });
  const rebaseDir = path.join(root, gitDirOut.trim());
  await fs.mkdir(rebaseDir, { recursive: true });
  const exec = (cmd, args, opts) => execFileAsync(cmd, args, { ...opts, cwd: root });
  const state = await integrateCheckoutGitState(root, {
    exec: (cmd, args, opts) => exec(cmd, args, opts).then(({ stdout }) => ({ stdout })),
    outputPaths: [],
  });
  assert.equal(state.rebaseInProgress, true);
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
