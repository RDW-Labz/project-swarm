// SPDX-License-Identifier: Apache-2.0
import '../tests/_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  runEndFailureRegression,
  failureRegressionOptIn,
  normalizeCauseKey,
} from '../tools/failure-regression.mjs';

const NOW = Date.parse('2026-01-15T12:00:00.000Z');
const tmpBase = () => process.env.SWARM_TEST_TMP || os.tmpdir();

function failedRunState(id, errorText) {
  return {
    id,
    status: 'failed',
    finishedAt: new Date(NOW).toISOString(),
    startedAt: new Date(NOW - 1000).toISOString(),
    jobs: [
      {
        id: 'job-a',
        agent: 'codex',
        lane: 'codex',
        status: 'failed',
        error: errorText,
        finishedAt: new Date(NOW).toISOString(),
      },
    ],
  };
}

function completeRunState(id) {
  return {
    id,
    status: 'complete',
    finishedAt: new Date(NOW).toISOString(),
    jobs: [{ id: 'job-a', agent: 'codex', status: 'complete', finishedAt: new Date(NOW).toISOString() }],
  };
}

test('failureRegressionOptIn defaults off', () => {
  assert.equal(failureRegressionOptIn({}, {}), false);
  assert.equal(failureRegressionOptIn(null, { failureRegression: false }), false);
  assert.equal(failureRegressionOptIn({ failureRegression: true }, {}), true);
  assert.equal(failureRegressionOptIn({}, { failureRegression: true }), true);
});

test('failed run writes stubs once; second finish writes none', async () => {
  const root = await fs.mkdtemp(path.join(tmpBase(), 'fr-wire-'));
  const errorText = 'build failed with exit code 2';
  const state = failedRunState('run-fail-once', errorText);
  const manifest = { version: 1, jobs: [{ id: 'job-a', agent: 'codex', outputs: [] }] };
  const events = [];
  const deps = {
    config: { failureRegression: true },
    now: NOW,
    appendEvent: async (_root, event) => {
      events.push(event);
    },
  };

  const first = await runEndFailureRegression(root, state, manifest, deps);
  assert.equal(first.stubsWritten, 1);
  assert.equal(events.length, 1);
  assert.match(events[0].text, /wrote 1 regression stub/);

  const key = normalizeCauseKey(errorText);
  const stubPath = path.join(root, 'tests', 'regressions', `${key}.test.mjs`);
  assert.equal(await fs.stat(stubPath).then(() => true, () => false), true);

  const second = await runEndFailureRegression(root, state, manifest, deps);
  assert.equal(second.stubsWritten, 0);
  assert.equal(events.length, 2);
  assert.match(events[1].text, /wrote 0 regression stubs/);
});

test('successful run writes no stubs', async () => {
  const root = await fs.mkdtemp(path.join(tmpBase(), 'fr-wire-'));
  const state = completeRunState('run-ok');
  const manifest = { version: 1, jobs: [{ id: 'job-a', agent: 'codex', outputs: [] }] };
  const events = [];
  const result = await runEndFailureRegression(root, state, manifest, {
    config: { failureRegression: true },
    now: NOW,
    appendEvent: async (_root, event) => {
      events.push(event);
    },
  });
  assert.equal(result.stubsWritten, 0);
  assert.match(events[0].text, /wrote 0 regression stubs/);
  const regressionsDir = path.join(root, 'tests', 'regressions');
  assert.equal(await fs.stat(regressionsDir).then(() => true, () => false), false);
});

test('hook error does not throw', async () => {
  const root = await fs.mkdtemp(path.join(tmpBase(), 'fr-wire-'));
  const state = failedRunState('run-hook-err', 'something broke');
  const manifest = { version: 1, jobs: [{ id: 'job-a', agent: 'codex', outputs: [] }] };
  const result = await runEndFailureRegression(root, state, manifest, {
    config: { failureRegression: true },
    captureNewFailureCauses: async () => {
      throw new Error('injected hook failure');
    },
  });
  assert.equal(result.error, true);
});

test('nonIntegrating smoke run writes no stubs', async () => {
  const root = await fs.mkdtemp(path.join(tmpBase(), 'fr-wire-'));
  const state = {
    ...failedRunState('doctor-smoke-abc', 'probe failed'),
    nonIntegrating: true,
  };
  const manifest = { version: 1, jobs: [{ id: 'job-a', agent: 'codex', outputs: [] }] };
  const events = [];
  const result = await runEndFailureRegression(root, state, manifest, {
    config: { failureRegression: true },
    now: NOW,
    appendEvent: async (_root, event) => {
      events.push(event);
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'non-integrating');
  assert.equal(events.length, 0);
});

test('with failureRegression off nothing is written', async () => {
  const root = await fs.mkdtemp(path.join(tmpBase(), 'fr-wire-'));
  const state = failedRunState('run-opt-out', 'still failing');
  const manifest = { version: 1, jobs: [{ id: 'job-a', agent: 'codex', outputs: [] }] };
  const events = [];
  const result = await runEndFailureRegression(root, state, manifest, {
    config: { failureRegression: false },
    profile: {},
    now: NOW,
    appendEvent: async (_root, event) => {
      events.push(event);
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'disabled');
  assert.equal(events.length, 0);
  const regressionsDir = path.join(root, 'tests', 'regressions');
  assert.equal(await fs.stat(regressionsDir).then(() => true, () => false), false);
});
