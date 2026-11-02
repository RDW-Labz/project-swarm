import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunSnapshot } from '../tools/watch-state.mjs';

const NOW = 2000;

function fixtureState() {
  return {
    id: 'run-1',
    branch: 'feat/x',
    status: 'running',
    startedAt: 1000,
    finishedAt: null,
    peakConcurrency: 3,
    pause: null,
    lanes: {
      lanes: {
        codex: { state: 'ok', concurrency: 2 },
        claude: { state: 'rate-limited', concurrency: 1 }
      }
    },
    jobs: [
      { id: 'j1', status: 'complete', lane: 'codex', agent: 'a', model: 'm1', attempts: [{ error: 'x', startedAt: 1100 }, { startedAt: 1200 }], costUsd: 0.5, durationMs: 800, outputs: ['out/a.js'], rateLimitRetries: 1, finishedAt: 1900 },
      { id: 'j2', status: 'failed', lane: 'codex', agent: 'a', attempts: [{ startedAt: 1300 }], costUsd: 0.25, durationMs: 400, error: 'boom', finishedAt: 1700 },
      { id: 'j3', status: 'queued', lane: 'claude', agent: 'c' },
      { id: 'j4', status: 'running', agent: 'b', attempts: [{ startedAt: 1500 }], costUsd: 0.1 }
    ],
    mergeQueue: null
  };
}

function fixtureManifest() {
  return {
    goal: 'Ship it',
    jobs: [
      { id: 'j1', lead: 'alpha', wave: 'build', type: 'build' },
      { id: 'j2', lead: 'alpha', type: 'test' },
      { id: 'j3', type: 'contract' }
    ]
  };
}

function snap(overrides, manifest) {
  const state = Object.assign(fixtureState(), overrides || {});
  return buildRunSnapshot(state, { manifest: manifest === undefined ? fixtureManifest() : manifest, now: NOW });
}

function iso(ms) {
  return new Date(ms).toISOString();
}

test('top-level fields come from state and manifest', () => {
  const s = snap();
  assert.equal(s.schema, 1);
  assert.equal(s.runId, 'run-1');
  assert.equal(s.goal, 'Ship it');
  assert.equal(s.branch, 'feat/x');
  assert.equal(s.status, 'live');
  assert.equal(s.startedAt, new Date(1000).toISOString());
  assert.equal(s.elapsedMs, 1000);
});

test('goal and branch are null when absent', () => {
  const state = fixtureState();
  delete state.branch;
  const s = buildRunSnapshot(state, { now: NOW });
  assert.equal(s.goal, null);
  assert.equal(s.branch, null);
});

test('status maps paused, live, complete and failed rules', () => {
  assert.equal(snap({ pause: { at: 1 }, status: 'running' }).status, 'paused');
  assert.equal(snap({ pause: { at: 1 }, status: 'complete' }).status, 'complete');
  assert.equal(snap({ status: 'queued' }).status, 'live');
  assert.equal(snap({ status: 'complete' }).status, 'complete');
  assert.equal(snap({ status: 'integrated' }).status, 'complete');
  assert.equal(snap({ status: 'integrated-with-failures' }).status, 'complete');
  assert.equal(snap({ status: 'failed' }).status, 'failed');
  assert.equal(snap({ status: 'weird-status' }).status, 'live');
});

test('elapsedMs uses finishedAt when set and 0 without startedAt', () => {
  assert.equal(snap({ finishedAt: 1600, status: 'complete' }).elapsedMs, 600);
  const state = fixtureState();
  delete state.startedAt;
  assert.equal(buildRunSnapshot(state, { now: NOW }).elapsedMs, 0);
});

test('jobs keep order and carry manifest lead, wave and type', () => {
  const s = snap();
  assert.deepEqual(s.jobs.map((j) => j.id), ['j1', 'j2', 'j3', 'j4']);
  const j1 = s.jobs[0];
  assert.equal(j1.status, 'complete');
  assert.equal(j1.lane, 'codex');
  assert.equal(j1.agent, 'a');
  assert.equal(j1.model, 'm1');
  assert.equal(j1.attempts, 2);
  assert.equal(j1.lead, 'alpha');
  assert.equal(j1.wave, 'build');
  assert.equal(j1.type, 'build');
  assert.equal(j1.file, 'out/a.js');
  assert.equal(j1.costUsd, 0.5);
  assert.equal(j1.durationMs, 800);
});

test('job defaults: lane falls back to agent, missing values become null or zero', () => {
  const s = snap();
  const j4 = s.jobs[3];
  assert.equal(j4.lane, 'b');
  assert.equal(j4.lead, null);
  assert.equal(j4.wave, null);
  assert.equal(j4.type, null);
  assert.equal(j4.file, null);
  assert.equal(j4.attempts, 1);
  const j3 = s.jobs[2];
  assert.equal(j3.attempts, 0);
  assert.equal(j3.costUsd, 0);
  assert.equal(j3.file, null);
});

test('kpi counts, retries, first-try pass rate and spend', () => {
  const k = snap().kpi;
  assert.equal(k.total, 4);
  assert.equal(k.done, 1);
  assert.equal(k.running, 1);
  assert.equal(k.queued, 1);
  assert.equal(k.failed, 1);
  assert.equal(k.cancelled, 0);
  assert.equal(k.retries, 1);
  assert.equal(k.firstTryPassRate, 0);
  assert.equal(k.peakInFlight, 3);
  assert.ok(Math.abs(k.spendUsd - 0.85) < 1e-9);
  assert.equal(k.jobsPerSec, 2);
  assert.equal(k.etaMs, 1000);
});

test('kpi nulls and zeros when nothing finished or elapsed is zero', () => {
  const state = fixtureState();
  state.jobs = [{ id: 'q1', status: 'queued', lane: 'codex' }];
  state.peakConcurrency = undefined;
  const k = buildRunSnapshot(state, { now: NOW }).kpi;
  assert.equal(k.firstTryPassRate, null);
  assert.equal(k.peakInFlight, 0);
  assert.equal(k.jobsPerSec, 0);
  assert.equal(k.etaMs, null);
});

test('kpi etaMs is zero when nothing is queued or running', () => {
  const state = fixtureState();
  state.jobs = [{ id: 'd1', status: 'complete', lane: 'codex', attempts: [{}], finishedAt: 1500, durationMs: 300 }];
  const k = buildRunSnapshot(state, { now: NOW }).kpi;
  assert.equal(k.etaMs, 0);
  assert.equal(k.firstTryPassRate, 1);
});

test('lanes sorted by name with health, pass rate, timing and reason', () => {
  const lanes = snap().lanes;
  assert.deepEqual(lanes.map((l) => l.name), ['claude', 'codex']);
  const claude = lanes[0];
  assert.equal(claude.state, 'rate-limited');
  assert.equal(claude.offline, true);
  assert.equal(claude.limit, 1);
  assert.equal(claude.done, 0);
  assert.equal(claude.failed, 0);
  assert.equal(claude.passRate, null);
  assert.equal(claude.avgMs, null);
  assert.equal(claude.reason, 'claude rate-limited');
  const codex = lanes[1];
  assert.equal(codex.offline, false);
  assert.equal(codex.limit, 2);
  assert.equal(codex.done, 1);
  assert.equal(codex.failed, 1);
  assert.equal(codex.passRate, 0.5);
  assert.equal(codex.avgMs, 600);
  assert.equal(codex.rateLimits, 1);
  assert.ok(Math.abs(codex.costUsd - 0.75) < 1e-9);
  assert.equal(codex.reason, null);
});

test('waves always list three names with wave rules applied', () => {
  const waves = snap().waves;
  assert.deepEqual(waves.map((w) => w.name), ['contracts', 'build', 'verify']);
  assert.deepEqual(waves[0], { name: 'contracts', total: 1, done: 0, running: 0 });
  assert.deepEqual(waves[1], { name: 'build', total: 2, done: 1, running: 1 });
  assert.deepEqual(waves[2], { name: 'verify', total: 1, done: 0, running: 0 });
});

test('attention includes retry, failure and rate-limit entries with severities', () => {
  const att = snap().attention;
  const retry = att.find((a) => a.kind === 'retry');
  assert.ok(retry);
  assert.equal(retry.severity, 'warn');
  assert.equal(retry.jobId, 'j1');
  assert.equal(retry.at, iso(1200));
  assert.equal(retry.text, 'x');
  const failure = att.find((a) => a.kind === 'failure');
  assert.ok(failure);
  assert.equal(failure.severity, 'error');
  assert.equal(failure.jobId, 'j2');
  assert.equal(failure.text, 'boom');
  assert.equal(failure.at, iso(1700));
  const rl = att.find((a) => a.kind === 'rate-limit');
  assert.ok(rl);
  assert.equal(rl.severity, 'warn');
  assert.equal(rl.jobId, 'j1');
});

test('attention is newest first', () => {
  const att = snap().attention;
  for (let i = 1; i < att.length; i++) {
    assert.ok(att[i - 1].at >= att[i].at);
  }
});

test('attention has a pause entry with null jobId when paused', () => {
  const att = snap({ pause: { at: 1 } }).attention;
  const pause = att.find((a) => a.kind === 'pause');
  assert.ok(pause);
  assert.equal(pause.severity, 'warn');
  assert.equal(pause.jobId, null);
});

test('attention has one conflict entry per merge conflict using file or string text', () => {
  const state = fixtureState();
  state.mergeQueue = { state: 'merging', batches: [], integrated: [], conflicts: [{ file: 'x.js' }, 'raw'] };
  const conflicts = buildRunSnapshot(state, { manifest: null, now: NOW }).attention.filter((a) => a.kind === 'conflict');
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts[0].severity, 'error');
  assert.equal(conflicts[0].jobId, null);
  const texts = conflicts.map((c) => c.text).sort();
  assert.deepEqual(texts, ['raw', 'x.js']);
});

test('attention is capped at 50 entries', () => {
  const state = fixtureState();
  state.mergeQueue = { batches: [], integrated: [], conflicts: Array.from({ length: 60 }, (_, i) => 'c' + i) };
  const att = buildRunSnapshot(state, { manifest: null, now: NOW }).attention;
  assert.equal(att.length, 50);
});

test('leads group jobs with default main and states', () => {
  const leads = snap().leads;
  assert.deepEqual(leads.map((l) => l.lead), ['alpha', 'main']);
  const alpha = leads[0];
  assert.equal(alpha.total, 2);
  assert.equal(alpha.done, 1);
  assert.equal(alpha.running, 0);
  assert.equal(alpha.retries, 1);
  assert.ok(Math.abs(alpha.spendUsd - 0.75) < 1e-9);
  assert.equal(alpha.state, 'failed');
  const main = leads[1];
  assert.equal(main.total, 2);
  assert.equal(main.running, 1);
  assert.equal(main.state, 'running');
});

test('leads report done and queued states', () => {
  const state = fixtureState();
  state.jobs = [
    { id: 'a1', status: 'complete', lane: 'codex' },
    { id: 'b1', status: 'queued', lane: 'codex' }
  ];
  const manifest = { jobs: [{ id: 'a1', lead: 'done-lead' }, { id: 'b1', lead: 'queued-lead' }] };
  const leads = buildRunSnapshot(state, { manifest, now: NOW }).leads;
  const byName = {};
  for (const l of leads) byName[l.lead] = l.state;
  assert.equal(byName['done-lead'], 'done');
  assert.equal(byName['queued-lead'], 'queued');
});

test('mergeQueue is null when missing', () => {
  assert.equal(snap().mergeQueue, null);
});

test('mergeQueue counts bisects and recent batch kinds', () => {
  const batches = [];
  for (let i = 0; i < 12; i++) batches.push({ id: i });
  batches.push({ id: 12, bisected: true });
  batches.push({ id: 13, conflicts: ['c.js'] });
  const state = fixtureState();
  state.mergeQueue = { state: 'merging', batches, integrated: [1, 2], conflicts: [{ file: 'x.js' }] };
  const mq = buildRunSnapshot(state, { manifest: null, now: NOW }).mergeQueue;
  assert.equal(mq.state, 'merging');
  assert.equal(mq.batches, 14);
  assert.equal(mq.integrated, 2);
  assert.equal(mq.conflicts, 1);
  assert.equal(mq.bisects, 1);
  assert.equal(mq.recent.length, 12);
  assert.equal(mq.recent[0], 'ok');
  assert.equal(mq.recent[10], 'bisect');
  assert.equal(mq.recent[11], 'conflict');
});

test('mergeQueue counts default to zero when arrays are absent', () => {
  const state = fixtureState();
  state.mergeQueue = { state: 'idle' };
  const mq = buildRunSnapshot(state, { manifest: null, now: NOW }).mergeQueue;
  assert.equal(mq.batches, 0);
  assert.equal(mq.integrated, 0);
  assert.equal(mq.conflicts, 0);
  assert.equal(mq.bisects, 0);
  assert.deepEqual(mq.recent, []);
});

test('rollup is null while live and present when complete', () => {
  assert.equal(snap().rollup, null);
  const r = snap({ status: 'complete', finishedAt: 1600 }).rollup;
  assert.ok(r);
  assert.equal(r.elapsedMs, 600);
  assert.equal(r.branch, 'feat/x');
  assert.equal(r.counts.total, 4);
  assert.equal(r.counts.done, 1);
  assert.equal(r.counts.failed, 1);
  assert.equal(r.counts.cancelled, 0);
  assert.ok(Math.abs(r.spendByLane.codex - 0.75) < 1e-9);
});

test('rollup is present when failed', () => {
  assert.ok(snap({ status: 'failed', finishedAt: 1600 }).rollup);
});
