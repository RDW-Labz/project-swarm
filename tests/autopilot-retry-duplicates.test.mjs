// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decide, autopilotStep, manifestWorkFingerprint, supersedingSuccessfulRun } from '../tools/autopilot.mjs';
import { appendEvent, readJournal } from '../tools/journal.mjs';
import { runInboxCommand } from '../tools/inbox-commands.mjs';

const NOW = Date.parse('2030-05-01T12:00:00.000Z');

const manifest = {
  version: 1,
  jobs: [
    { id: 'job-a', agent: 'codex', model: 'm', prompt: 'p', context: [], outputs: ['out/a.txt'] },
    { id: 'job-b', agent: 'codex', model: 'm', prompt: 'p', context: [], outputs: ['out/b.txt'] },
  ],
};

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-retry-dup-'));
  await fs.mkdir(path.join(dir, '.swarm', 'project'), { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeRun(root, id, { status, handled = false } = {}) {
  const dir = path.join(root, '.swarm', 'runs', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await fs.writeFile(path.join(dir, 'state.json'), `${JSON.stringify({
    id,
    status,
    handled,
    jobs: manifest.jobs.map(job => ({ ...job, status: status === 'complete' ? 'complete' : 'failed' })),
    summary: { counts: { failed: status === 'failed' ? 1 : 0, complete: status === 'complete' ? 2 : 1 } },
  }, null, 2)}\n`);
}

function deps(root, { runs, journal = [], retryCalls = [] } = {}) {
  const events = [...journal];
  return {
    events,
    loadRuns: async () => runs,
    readJournal: async () => events,
    appendEvent: async (r, event) => {
      await appendEvent(r, event, { now: () => NOW });
      events.push({ ...event, ts: new Date(NOW).toISOString() });
    },
    readPlan: async () => null,
    checkout: async () => ({ branch: 'swarm/work', dirty: false }),
    integrate: async () => ({}),
    resume: async () => {},
    retryFailed: async () => {
      retryCalls.push(1);
      return { run: 'retry-run', status: 'running' };
    },
    retryCalls,
  };
}

test('supersedingSuccessfulRun matches manifest fingerprint and declared outputs', () => {
  const fp = manifestWorkFingerprint(manifest);
  const failed = { id: 'failed-1', status: 'failed', counts: { failed: 1 } };
  const sibling = { id: 'ok-1', status: 'complete', integrated: true };
  const events = [
    { kind: 'run', id: 'failed-1', status: 'failed', manifest },
    { kind: 'run', id: 'ok-1', status: 'complete', manifest },
  ];
  assert.equal(supersedingSuccessfulRun(failed, { runs: [failed, sibling], events, manifest }), true);
  assert.equal(fp.outputsHash, manifestWorkFingerprint(manifest).outputsHash);
});

test('decide skips retry-failed when a sibling run already completed the same work', async t => {
  const root = await tempRoot(t);
  await writeRun(root, 'failed-1', { status: 'failed' });
  await writeRun(root, 'ok-1', { status: 'complete' });
  const runs = [
    { id: 'failed-1', status: 'failed', integrated: false, counts: { failed: 1 } },
    { id: 'ok-1', status: 'complete', integrated: true },
  ];
  const events = [
    { kind: 'run', id: 'failed-1', status: 'failed', manifest },
    { kind: 'run', id: 'ok-1', status: 'complete', manifest },
  ];
  assert.equal(decide(runs[0], { now: NOW, events, runs, manifest }), null);
});

test('swarm resolve RUN --handled stops retry-failed', async t => {
  const root = await tempRoot(t);
  await writeRun(root, 'failed-1', { status: 'failed' });
  const out = await runInboxCommand(root, 'resolve', ['failed-1', '--handled'], { now: () => NOW });
  assert.equal(out.exitCode, 0);
  const state = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'runs', 'failed-1', 'state.json'), 'utf8'));
  assert.equal(state.handled, true);
  const run = { id: 'failed-1', status: 'failed', handled: true, counts: { failed: 1 } };
  assert.equal(decide(run, { now: NOW, events: await readJournal(root, { limit: Infinity }), runs: [run], manifest }), null);
});

test('a failed run with no sibling still retries once', async t => {
  const root = await tempRoot(t);
  await writeRun(root, 'only-fail', { status: 'failed' });
  const runs = [{ id: 'only-fail', status: 'failed', integrated: false, counts: { failed: 1 } }];
  const events = [{ kind: 'run', id: 'only-fail', status: 'failed', manifest }];
  const d = decide(runs[0], { now: NOW, events, runs, manifest });
  assert.equal(d?.action, 'retry-failed');
  const journalDeps = deps(root, { runs, journal: events });
  const memory = new Set();
  const step = await autopilotStep(root, journalDeps, { now: () => NOW, memory });
  assert.equal(step.actions.length, 1);
  assert.equal(step.actions[0].action, 'retry-failed');
  assert.equal(journalDeps.retryCalls.length, 1);
  const second = await autopilotStep(root, journalDeps, { now: () => NOW, memory });
  assert.equal(second.actions.length, 0);
});
