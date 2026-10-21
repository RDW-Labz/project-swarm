// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_AUTOPILOT_ACTIONS,
  LEGACY_PLAN_ACTIONS,
  autopilotStep,
  manifestWorkFingerprint,
  legacyWaveAlreadyRun,
} from '../tools/autopilot.mjs';

const exec = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swarm = path.join(packageRoot, 'tools/swarm.mjs');
const NOW = Date.parse('2030-01-01T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

async function tempRoot(t, prefix = 'autopilot-ledger-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function ticket(id, files) {
  return { id, status: 'ready', files, dependsOn: [], type: 'build' };
}

function fakeDeps(opts = {}) {
  const {
    journal = [],
    runs = [],
    plan = null,
    existingRunWork = [],
    coordinationManifest,
    manifestMtimeMs,
    ...fns
  } = opts;
  const calls = [];
  const deps = {
    calls,
    loadRuns: async () => { calls.push(['loadRuns']); return runs; },
    readJournal: async () => journal,
    appendEvent: async (_root, event) => {
      calls.push(['appendEvent', event]);
      journal.push({ ...event, ts: iso(NOW) });
      return event;
    },
    readPlan: async () => plan,
    checkout: async () => ({ branch: 'swarm/work', dirty: false }),
    integrate: async () => ({}),
    resume: async () => {},
    retryFailed: async () => ({}),
    startWave: async (...args) => { calls.push(['startWave', ...args]); return { run: 'r-wave', status: 'running' }; },
    startDeferred: async (...args) => { calls.push(['startDeferred', ...args]); return { run: 'r-def', status: 'running' }; },
    startBacklog: async (...args) => { calls.push(['startBacklog', ...args]); return { run: 'r-back', status: 'running' }; },
    readyTickets: async () => [],
    pendingApprovals: async () => [],
    liveRuns: async () => [],
    busyMarkers: async () => [],
    capRoom: async () => true,
    startScope: async (...args) => { calls.push(['startScope', ...args]); return { ok: true, result: 'ok' }; },
    humanGroups: async () => [],
    nextBacklog: async () => ({ id: 'g1', goal: 'x' }),
    readCoordinationManifest: async () => ({
      manifest: coordinationManifest ?? { version: 1, jobs: [{ id: 'j1', outputs: ['out.txt'] }] },
      mtimeMs: manifestMtimeMs ?? NOW,
    }),
    existingRunWork: async () => existingRunWork,
    ...fns,
  };
  return deps;
}

test('default autopilot actions exclude legacy plan starts', () => {
  assert.deepEqual(DEFAULT_AUTOPILOT_ACTIONS, ['integrate', 'resume', 'retry-failed', 'unlock-tickets', 'start-ready']);
  assert.deepEqual(LEGACY_PLAN_ACTIONS, ['start-wave', 'start-deferred', 'start-backlog']);
});

test('ready plan wave does not start without ledger tickets when legacyPlan is off', async t => {
  const root = await tempRoot(t);
  const plan = {
    waves: [{
      id: 'w1',
      manifest: 'coordination/manifests/w1.json',
    }],
  };
  const deps = fakeDeps({ plan, existingRunWork: [] });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(deps.calls.some(c => c[0] === 'startWave'), false);
  assert.equal(step.actions.some(a => a.action === 'start-wave'), false);
});

test('with ready ledger tickets only start-ready runs by default', async t => {
  const root = await tempRoot(t);
  const plan = { waves: [{ id: 'w1', manifest: 'coordination/manifests/w1.json' }] };
  const deps = fakeDeps({
    plan,
    readyTickets: async () => [ticket('T-1', ['src/a.ts'])],
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(deps.calls.filter(c => c[0] === 'startScope').length, 1);
  assert.equal(step.actions.some(a => a.action === 'start-ready'), true);
  assert.equal(step.actions.some(a => a.action === 'start-wave'), false);
});

test('legacyPlan starts a wave that no saved run covers', async t => {
  const root = await tempRoot(t);
  const manifest = { version: 1, jobs: [{ id: 'fix-db', outputs: ['tests/db.test.mjs'] }] };
  const plan = { waves: [{ id: 'w1', manifest: 'coordination/manifests/fix.json' }] };
  const deps = fakeDeps({
    plan,
    coordinationManifest: manifest,
    existingRunWork: [],
  });
  const step = await autopilotStep(root, deps, { now: () => NOW, legacyPlan: true });
  assert.equal(deps.calls.filter(c => c[0] === 'startWave').length, 1);
  assert.equal(step.actions.some(a => a.action === 'start-wave' && a.ok), true);
});

test('legacyPlan skips a wave whose jobs already completed in an earlier run', async t => {
  const root = await tempRoot(t);
  const manifest = { version: 1, jobs: [{ id: 'fix-db', outputs: ['tests/db.test.mjs'] }] };
  const fp = manifestWorkFingerprint(manifest);
  const plan = { waves: [{ id: 'w1', manifest: 'coordination/manifests/fix.json' }] };
  const deps = fakeDeps({
    plan,
    coordinationManifest: manifest,
    existingRunWork: [{
      id: 'hand-run',
      status: 'complete',
      integrated: false,
      fingerprint: fp,
      completedJobIds: ['fix-db'],
      allJobsComplete: true,
      timeMs: NOW - 60_000,
    }],
  });
  const step = await autopilotStep(root, deps, { now: () => NOW, legacyPlan: true });
  assert.equal(deps.calls.some(c => c[0] === 'startWave'), false);
  const waveAction = step.actions.find(a => a.action === 'start-wave');
  assert.equal(waveAction?.reason, 'already-run');
  assert.equal(waveAction?.ok, true);
});

test('legacyPlan skips a stale manifest older than the newest overlapping run', async t => {
  const manifest = { version: 1, jobs: [{ id: 'fix-db', outputs: ['tests/db.test.mjs'] }] };
  const fp = manifestWorkFingerprint(manifest);
  assert.equal(legacyWaveAlreadyRun({
    manifest,
    manifestMtimeMs: NOW - 120_000,
    existing: [{
      id: 'newer-run',
      status: 'running',
      fingerprint: { jobIds: ['fix-db', 'extra'], outputsHash: 'other' },
      completedJobIds: [],
      timeMs: NOW - 30_000,
    }],
  }), true);
  const root = await tempRoot(t);
  const deps = fakeDeps({
    plan: { waves: [{ id: 'w1', manifest: 'coordination/manifests/stale.json' }] },
    coordinationManifest: manifest,
    manifestMtimeMs: NOW - 120_000,
    existingRunWork: [{
      id: 'newer-run',
      status: 'running',
      fingerprint: { jobIds: ['fix-db', 'extra'], outputsHash: fp.outputsHash },
      completedJobIds: [],
      timeMs: NOW - 30_000,
    }],
  });
  const step = await autopilotStep(root, deps, { now: () => NOW, legacyPlan: true });
  assert.equal(deps.calls.some(c => c[0] === 'startWave'), false);
  assert.equal(step.actions.find(a => a.action === 'start-wave')?.reason, 'already-run');
});

test('start-deferred and start-backlog do not run without legacyPlan', async t => {
  const root = await tempRoot(t);
  const group = { id: 'g1', humans: [{ done: true }], started: false, hasDeferred: true, runless: true };
  const deps = fakeDeps({
    runs: [{ id: 'r1', status: 'paused', pause: { reasons: ['human'] } }],
    humanGroups: async () => [group],
    nextBacklog: async () => ({ id: 'bg1', goal: 'work' }),
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.equal(deps.calls.some(c => c[0] === 'startDeferred'), false);
  assert.equal(deps.calls.some(c => c[0] === 'startBacklog'), false);
  assert.equal(step.actions.some(a => ['start-deferred', 'start-backlog'].includes(a.action)), false);
});

test('complete review-only ask run starts nothing and raises no blocker', async t => {
  const root = await tempRoot(t);
  const deps = fakeDeps({
    runs: [{ id: 'ask1', status: 'complete', integrated: false, integrable: false }],
    checkout: async () => ({ branch: 'main', dirty: false }),
  });
  const step = await autopilotStep(root, deps, { now: () => NOW });
  assert.deepEqual(step.actions, []);
  assert.deepEqual(step.blocked, []);
});

test('swarm autopilot usage documents --legacy-plan and the flag is accepted', async t => {
  const help = await exec(process.execPath, [swarm, 'help'], { encoding: 'utf8' });
  assert.match(help.stdout, /--legacy-plan/);
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'plan.json'), '{}');
  const out = await exec(process.execPath, [swarm, '--root', root, 'autopilot', '--once', '--legacy-plan'], {
    encoding: 'utf8',
    env: { ...process.env, SWARM_CONFIG: process.env.SWARM_CONFIG },
  });
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.status, 'ok');
});
