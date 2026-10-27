// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOB_TYPES, applyJobType } from '../tools/job-types.mjs';
import { routeJob } from '../tools/router.mjs';
import { resolveLanes } from '../tools/lanes.mjs';

const jobForType = (type, { sensitive = false, tier } = {}) => {
  const outputs = type === 'docs' ? ['docs/a.md']
    : type === 'test' ? ['tests/a.test.mjs']
      : type === 'review' || type === 'research' ? []
        : ['src/a.ts'];
  const base = { id: `j-${type}`, agent: 'auto', type, prompt: 'p', sensitive, outputs };
  return tier === undefined ? base : { ...base, tier };
};

const routableLanes = (extra = {}) => resolveLanes({
  config: {
    lanes: {
      cursor: { model: 'cursor-m' },
      codex: { model: 'codex-m', paused: false },
      anthropic: { model: 'haiku-m' },
      hermes: { model: 'hermes-m' },
      claude: { model: 'claude-m', midModel: 'claude-mid', expensiveModel: 'claude-exp' },
      openrouter: { model: 'openrouter-m' },
      ...extra,
    },
  },
});

test('every preset that lists anthropic places it after cursor', () => {
  for (const [type, preset] of Object.entries(JOB_TYPES)) {
    const route = preset.route;
    if (!route.includes('anthropic')) continue;
    if (!route.includes('cursor')) continue;
    assert.ok(route.indexOf('anthropic') > route.indexOf('cursor'), `${type}: ${route.join(', ')}`);
  }
});

test('paused anthropic and openrouter never route for any job type (cheap or mid, sensitive on or off)', () => {
  const lanes = routableLanes({
    anthropic: { model: 'haiku-m', paused: true },
    openrouter: { model: 'openrouter-m', paused: true },
  });
  const paid = new Set(['anthropic', 'openrouter']);
  const tiers = [undefined, 'mid'];
  const sensitives = [false, true];
  for (const type of Object.keys(JOB_TYPES)) {
    for (const tier of tiers) {
      for (const sensitive of sensitives) {
        const { job } = applyJobType(jobForType(type, { sensitive, tier }));
        const failures = { cursor: 2 };
        let result;
        try {
          result = routeJob(job, { lanes, failures });
        } catch (error) {
          assert.equal(error.code, 'route-exhausted', `${type} tier=${tier ?? 'cheap'} sensitive=${sensitive}`);
          continue;
        }
        assert.ok(!paid.has(result.agent), `${type} tier=${tier ?? 'cheap'} sensitive=${sensitive} -> ${result.agent}`);
      }
    }
  }
});

test('with anthropic unpaused, cursor failing twice may still use anthropic', () => {
  const lanes = routableLanes();
  const { job } = applyJobType(jobForType('build'));
  const result = routeJob(job, { lanes, failures: { cursor: 2 } });
  assert.equal(result.agent, 'anthropic');
});
