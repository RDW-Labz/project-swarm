// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  lanePassRates,
  passRateFailuresFor,
  readRunStatesSync,
  readRunStates,
  routeWithPassRates,
  routingFailures,
} from '../tools/lane-pass-routing.mjs';

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
      return JSON.stringify({ jobs: [{ agent: 'cursor', status: 'failed' }] });
    },
  };

  assert.deepEqual(passRateFailuresFor(root, deps), { cursor: 0 });
  assert.deepEqual(passRateFailuresFor(path.join(root, '.'), deps), { cursor: 0 });
  assert.equal(readdirCalls, 1);
  assert.equal(readFileCalls, 1);
});
