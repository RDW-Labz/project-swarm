// SPDX-License-Identifier: Apache-2.0

import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickJobRoute } from '../tools/swarm/core-41.mjs';

const lanes = {
  cursor: { model: 'cursor-test' },
  codex: { model: 'codex-test' },
  anthropic: { model: 'anthropic-test' },
};

const autoJob = {
  id: 'job-test',
  agent: 'auto',
  sensitive: false,
  prompt: 'route this job',
  context: [],
  outputs: [],
  acceptance: ['the route is selected'],
};

function projectWithRuns(states) {
  const root = fs.mkdtempSync(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'lane-route-wiring-'));
  for (const [name, state] of Object.entries(states)) {
    const dir = path.join(root, '.swarm', 'runs', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify(state)}\n`, 'utf8');
  }
  return root;
}

function failedCursorState(at = Date.now()) {
  return { jobs: [{ agent: 'cursor', status: 'failed', finishedAt: new Date(at).toISOString() }] };
}

test('pickJobRoute uses lane pass rates from the project root', () => {
  const states = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`run-${index}`, failedCursorState()]));
  const root = projectWithRuns(states);

  const result = pickJobRoute(autoJob, lanes, { root });
  assert.equal(result.agent, 'codex');
  assert.equal(result.model, 'codex-test');
});

test('pickJobRoute keeps cursor below the minimum pass-rate sample count', () => {
  const states = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`run-${index}`, failedCursorState()]));
  const root = projectWithRuns(states);

  const result = pickJobRoute(autoJob, lanes, { root });
  assert.equal(result.agent, 'cursor');
  assert.equal(result.model, 'cursor-test');
});

test('pickJobRoute preserves explicit failures using the maximum count', () => {
  const result = pickJobRoute(autoJob, lanes, {
    passRateFailures: { cursor: 2 },
    failures: { cursor: 3 },
  });

  assert.equal(result.agent, 'codex');
  assert.equal(result.model, 'codex-test');
});

test('failures older than 48 hours no longer rule a lane out (the Nov 7-8 incident)', () => {
  const old = Date.now() - 72 * 60 * 60 * 1000;
  const states = {};
  for (let i = 0; i < 8; i += 1) {
    for (const agent of ['cursor', 'codex', 'anthropic']) states[`old-${agent}-${i}`] = { jobs: [{ agent, status: 'failed', finishedAt: new Date(old).toISOString() }] };
  }
  const result = pickJobRoute(autoJob, lanes, { root: projectWithRuns(states) });
  assert.equal(result.agent, 'cursor');
  assert.doesNotMatch(result.reason, /fallback/);
});

test('pickJobRoute falls back to the healthiest lane and raises an alert when every lane is ruled out', () => {
  const now = new Date().toISOString();
  const states = {};
  for (let i = 0; i < 5; i += 1) {
    states[`c-${i}`] = { jobs: [{ agent: 'cursor', status: 'failed', finishedAt: now }] };
    states[`x-${i}`] = { jobs: [{ agent: 'codex', status: i < 2 ? 'complete' : 'failed', finishedAt: now }] };
    states[`a-${i}`] = { jobs: [{ agent: 'anthropic', status: i < 1 ? 'complete' : 'failed', finishedAt: now }] };
  }
  const alerts = [];
  const result = pickJobRoute({ ...autoJob, id: 'lead-1' }, lanes, { root: projectWithRuns(states), onLaneQualityFallback: a => alerts.push(a) });
  assert.equal(result.agent, 'codex');
  assert.match(result.reason, /lane-quality fallback/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].lane, 'codex');
  assert.equal(alerts[0].job, 'lead-1');
});
