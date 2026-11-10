// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  healthiestFirst,
  jobTimeMs,
  passRateSince,
  passRateSummaryFor,
  recordLaneQualityAlert,
  routeWithQualityFallback,
  PASS_RATE_WINDOW_MS,
  lanePassRates,
  passRateFailuresFor,
  readRunStatesSync,
  readRunStates,
  routeWithPassRates,
  routingFailures,
} from '../tools/lane-pass-routing.mjs';
import { routeJob } from '../tools/router.mjs';

const lanes = {
  cursor: { model: 'cursor-test' },
  codex: { model: 'codex-test' },
  anthropic: { model: 'anthropic-test' },
};

const autoJob = { id: 'job-test', agent: 'auto', sensitive: false };

test('lane pass rates count finished pass and fail statuses and ignore cancelled or held jobs', () => {
  const rates = lanePassRates({
    first: {
      jobs: [
        { agent: 'cursor', status: 'complete' },
        { agent: 'cursor', status: 'failed' },
        { agent: 'codex', status: 'blocked' },
        { agent: 'codex', status: 'timed-out' },
        { agent: 'codex', status: 'timedout' },
        { agent: 'anthropic', status: 'cancelled' },
        { agent: 'anthropic', status: 'held' },
      ],
    },
    second: { jobs: [{ agent: 'codex', status: 'complete' }] },
  });

  assert.deepEqual(rates, {
    cursor: { passed: 1, failed: 1, total: 2, rate: 0.5 },
    codex: { passed: 1, failed: 3, total: 4, rate: 1 / 4 },
  });
});

test('a low-pass lane with enough samples is skipped in favor of the next cheapest lane', () => {
  const runStates = {
    one: { jobs: [{ agent: 'cursor', status: 'failed' }, { agent: 'codex', status: 'complete' }] },
    two: { jobs: [{ agent: 'cursor', status: 'failed' }, { agent: 'codex', status: 'complete' }] },
    three: { jobs: [{ agent: 'cursor', status: 'failed' }, { agent: 'codex', status: 'complete' }] },
    four: { jobs: [{ agent: 'cursor', status: 'failed' }, { agent: 'codex', status: 'complete' }] },
    five: { jobs: [{ agent: 'cursor', status: 'failed' }, { agent: 'codex', status: 'complete' }] },
  };

  const result = routeWithPassRates(autoJob, { lanes }, runStates);
  assert.equal(result.agent, 'codex');
  assert.equal(result.model, 'codex-test');
});

test('too few samples do not change routing', () => {
  const runStates = {
    one: { jobs: [{ agent: 'cursor', status: 'failed' }] },
    two: { jobs: [{ agent: 'cursor', status: 'failed' }] },
    three: { jobs: [{ agent: 'cursor', status: 'failed' }] },
    four: { jobs: [{ agent: 'cursor', status: 'failed' }] },
  };

  const result = routeWithPassRates(autoJob, { lanes }, runStates);
  assert.equal(result.agent, 'cursor');
});

test('existing failures are kept at the maximum of existing and observed counts', () => {
  const runStates = {
    one: { jobs: [{ agent: 'cursor', status: 'failed' }] },
    two: { jobs: [{ agent: 'cursor', status: 'failed' }] },
    three: { jobs: [{ agent: 'cursor', status: 'failed' }] },
    four: { jobs: [{ agent: 'cursor', status: 'failed' }] },
    five: { jobs: [{ agent: 'cursor', status: 'failed' }] },
  };

  const result = routeWithPassRates(autoJob, { lanes, failures: { cursor: 3, codex: 1 } }, runStates);
  assert.equal(result.agent, 'codex');
  assert.deepEqual(routingFailures(lanePassRates(runStates)), { cursor: 2 });
});

test('readRunStates uses injected filesystem calls and skips unreadable runs', async () => {
  const root = '/fixture-root';
  const runsDir = path.join(root, '.swarm', 'runs');
  const files = new Map([
    [path.join(runsDir, 'run-good', 'state.json'), JSON.stringify({ jobs: [] })],
  ]);
  const readdir = async target => {
    assert.equal(target, runsDir);
    return [
      { name: 'run-good', isDirectory: () => true },
      { name: 'run-missing', isDirectory: () => true },
      { name: 'file-entry', isDirectory: () => false },
    ];
  };
  const readFile = async file => {
    if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return files.get(file);
  };

  assert.deepEqual(await readRunStates(root, { readdir, readFile }), { 'run-good': { jobs: [] } });
});

test('readRunStatesSync reads only the newest 200 folders and skips invalid files', () => {
  const root = '/fixture-root-sync';
  const runsDir = path.join(root, '.swarm', 'runs');
  const entries = Array.from({ length: 201 }, (_, index) => ({
    name: `run-${String(index).padStart(3, '0')}`,
    isDirectory: () => true,
  }));
  entries.push({ name: 'run-invalid', isDirectory: () => true });
  let reads = 0;
  const states = readRunStatesSync(root, {
    readdirSync: target => {
      assert.equal(target, runsDir);
      return entries;
    },
    readFileSync: file => {
      reads += 1;
      if (file.endsWith(`${path.sep}run-invalid${path.sep}state.json`)) return '{';
      return JSON.stringify({ jobs: [] });
    },
  });

  assert.equal(reads, 200);
  assert.equal(Object.keys(states).length, 199);
  assert.equal(states['run-200']?.jobs.length, 0);
  assert.equal(states['run-000'], undefined);
});

test('provider credit and quota failures do not count toward lane pass rates', () => {
  const jobs = Array.from({ length: 6 }, () => ({
    agent: 'cursor',
    status: 'failed',
    agentError: 'insufficient_quota: billing hard limit reached',
  }));
  const rates = lanePassRates({ only: { jobs } });
  assert.deepEqual(rates, {});
  assert.deepEqual(routingFailures(rates), {});
});

test('passRateFailuresFor memoizes state reads per resolved root', () => {
  const root = `/fixture-root-cache-${Date.now()}-${Math.random()}`;
  let readdirCalls = 0;
  let readFileCalls = 0;
  const deps = {
    readdirSync: () => {
      readdirCalls += 1;
      return [{ name: 'run-one', isDirectory: () => true }];
    },
    readFileSync: () => {
      readFileCalls += 1;
      return JSON.stringify({ jobs: [{ agent: 'cursor', status: 'failed', finishedAt: new Date().toISOString() }] });
    },
    installedAt: null,
  };

  assert.deepEqual(passRateFailuresFor(root, deps), { cursor: 0 });
  assert.deepEqual(passRateFailuresFor(path.join(root, '.'), deps), { cursor: 0 });
  assert.equal(readdirCalls, 1);
  assert.equal(readFileCalls, 1);
});

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-10T18:00:00Z');
const failedRuns = (agent, at, n = 5) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${agent}-${at}-${i}`, { jobs: [{ agent, status: 'failed', finishedAt: new Date(at).toISOString() }] }]));

test('only jobs from the last 48 hours count toward lane pass rates', () => {
  const old = failedRuns('cursor', NOW - 72 * HOUR);
  const since = passRateSince({ now: NOW });
  assert.equal(since, NOW - PASS_RATE_WINDOW_MS);
  assert.deepEqual(lanePassRates(old, { since }), {});
  assert.deepEqual(routingFailures(lanePassRates({ ...old, ...failedRuns('codex', NOW - 2 * HOUR) }, { since })), { codex: 2 });
  // without a window (pure use) everything still counts
  assert.equal(lanePassRates(old).cursor.total, 5);
});

test('installing a fix starts the history fresh', () => {
  const recent = failedRuns('cursor', NOW - 10 * HOUR);
  assert.equal(passRateSince({ now: NOW, installedAt: NOW - HOUR }), NOW - HOUR);
  assert.equal(passRateSince({ now: NOW, installedAt: NOW - 100 * HOUR }), NOW - PASS_RATE_WINDOW_MS);
  assert.deepEqual(lanePassRates(recent, { since: passRateSince({ now: NOW, installedAt: NOW - HOUR }) }), {});
  const root = `/fixture-install-${Math.random()}`;
  const deps = {
    readdirSync: () => Object.keys(recent).map(name => ({ name, isDirectory: () => true })),
    readFileSync: file => JSON.stringify(recent[path.basename(path.dirname(file))]),
    now: () => NOW,
    installedAt: NOW - HOUR,
  };
  assert.deepEqual(passRateSummaryFor(root, deps).failures, {});
  assert.deepEqual(passRateSummaryFor(`${root}-before`, { ...deps, installedAt: NOW - 20 * HOUR }).failures, { cursor: 2 });
});

test('job time falls back to the run time and the run folder prefix; unknown age does not count', () => {
  assert.equal(jobTimeMs({ finishedAt: '2026-11-10T00:00:00Z' }, {}, 'x'), Date.parse('2026-11-10T00:00:00Z'));
  assert.equal(jobTimeMs({}, { startedAt: '2026-11-09T00:00:00Z' }, 'x'), Date.parse('2026-11-09T00:00:00Z'));
  assert.equal(jobTimeMs({}, {}, '1794151335344-e71adbcf'), 1794151335344);
  assert.equal(jobTimeMs({}, {}, 'run-one'), null);
  assert.deepEqual(lanePassRates({ 'run-one': { jobs: [{ agent: 'cursor', status: 'failed' }] } }, { since: 0 }), {});
});

test('when the quality check rules out every lane, the healthiest lane takes the job', () => {
  const lanesOnlyTwo = { cursor: { model: 'cursor-test' }, codex: { model: 'codex-test' } };
  const runStates = {};
  for (let i = 0; i < 5; i += 1) {
    runStates[`c${i}`] = { jobs: [{ agent: 'cursor', status: i < 1 ? 'complete' : 'failed', finishedAt: new Date(NOW).toISOString() }] };
    runStates[`x${i}`] = { jobs: [{ agent: 'codex', status: i < 2 ? 'complete' : 'failed', finishedAt: new Date(NOW).toISOString() }] };
  }
  const rates = lanePassRates(runStates);
  const passFailures = routingFailures(rates);
  assert.deepEqual(passFailures, { cursor: 2, codex: 2 });
  assert.deepEqual(healthiestFirst(passFailures, rates), ['codex', 'cursor']);
  const route = failures => routeJob({ ...autoJob, sensitive: true }, { lanes: lanesOnlyTwo, failures });
  assert.throws(() => route(passFailures), /route-exhausted/);
  const { route: picked, fallback } = routeWithQualityFallback(route, { passFailures, rates });
  assert.equal(picked.agent, 'codex');
  assert.match(picked.reason, /lane-quality fallback/);
  assert.deepEqual(fallback, { agent: 'codex', rate: 0.4, passed: 2, total: 5 });
  // routeWithPassRates uses the same fallback
  assert.equal(routeWithPassRates({ ...autoJob, sensitive: true }, { lanes: lanesOnlyTwo }, runStates).agent, 'codex');
});

test('the fallback never lifts a lane that really failed twice in this run', () => {
  const lanesOnlyOne = { cursor: { model: 'cursor-test' } };
  const route = failures => routeJob({ ...autoJob, sensitive: true }, { lanes: lanesOnlyOne, failures });
  assert.throws(() => routeWithQualityFallback(route, { baseFailures: { cursor: 2 }, passFailures: { cursor: 2 }, rates: {} }), /route-exhausted/);
  // no quality penalty in play: unchanged routing, no fallback
  const plain = routeWithQualityFallback(route, {});
  assert.equal(plain.route.agent, 'cursor');
  assert.equal(plain.fallback, null);
});

test('lane quality alerts are appended for Fleet health', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'lq-alert-'));
  recordLaneQualityAlert({ job: 'lead-1', lane: 'codex', rate: 0.4 }, { home, env: {}, now: () => NOW });
  recordLaneQualityAlert({ job: 'lead-2', lane: 'codex', rate: 0.4 }, { home, env: {}, now: () => NOW });
  const lines = (await fsp.readFile(path.join(home, '.project-swarm', 'alerts', 'lane-quality.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { at: '2026-11-10T18:00:00.000Z', kind: 'lane-quality-fallback', job: 'lead-1', lane: 'codex', rate: 0.4 });
  await fsp.rm(home, { recursive: true, force: true });
});
