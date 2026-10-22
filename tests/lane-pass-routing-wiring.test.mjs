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

function failedCursorState() {
  return { jobs: [{ agent: 'cursor', status: 'failed' }] };
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
