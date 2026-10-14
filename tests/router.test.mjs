// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_ORDER, routeJob } from '../tools/router.mjs';

const job = { id: 'route-job', agent: 'auto' };
const lanes = Object.fromEntries(ROUTE_ORDER.map(agent => [agent, { model: `${agent}-model` }]));

test('route order is frozen and cheapest first', () => {
  assert.deepEqual(ROUTE_ORDER, ['hermes', 'cursor', 'codex', 'openrouter', 'claude']);
  assert.equal(Object.isFrozen(ROUTE_ORDER), true);
  assert.deepEqual(routeJob(job, { lanes }), {
    agent: 'hermes', model: 'hermes-model', reason: 'cheapest healthy lane',
  });
  for (let index = 0; index < ROUTE_ORDER.length; index += 1) {
    const available = Object.fromEntries(ROUTE_ORDER.slice(index).map(agent => [agent, lanes[agent]]));
    assert.equal(routeJob(job, { lanes: available }).agent, ROUTE_ORDER[index]);
  }
});

test('non-auto jobs are route-invalid', () => {
  for (const invalid of [{ agent: 'codex' }, {}, null]) {
    assert.throws(() => routeJob(invalid, { lanes }), { code: 'route-invalid' });
  }
});

test('missing, null, and non-string models are skipped', () => {
  assert.equal(routeJob(job, { lanes: {
    hermes: { model: null }, cursor: {}, codex: { model: 42 },
    openrouter: lanes.openrouter, claude: lanes.claude,
  } }).agent, 'openrouter');
});

test('sensitive jobs remove openrouter', () => {
  const available = { openrouter: lanes.openrouter, claude: lanes.claude };
  assert.equal(routeJob(job, { lanes: available }).agent, 'openrouter');
  assert.equal(routeJob({ ...job, sensitive: true }, { lanes: available }).agent, 'claude');
});

test('expensive tier starts at claude', () => {
  assert.deepEqual(routeJob({ ...job, tier: 'expensive' }, { lanes }), {
    agent: 'claude', model: 'claude-model', reason: 'tier expensive',
  });
  assert.throws(() => routeJob({ ...job, tier: 'expensive' }, { lanes: { hermes: lanes.hermes } }), {
    code: 'route-exhausted',
  });
});

test('two failures advance one tier and accumulated failures never move down', () => {
  const failures = {};
  for (let index = 0; index < ROUTE_ORDER.length - 1; index += 1) {
    const agent = ROUTE_ORDER[index];
    failures[agent] = 1;
    assert.equal(routeJob(job, { lanes, failures }).agent, agent);
    failures[agent] = 2;
    assert.deepEqual(routeJob(job, { lanes, failures }), {
      agent: ROUTE_ORDER[index + 1], model: lanes[ROUTE_ORDER[index + 1]].model,
      reason: `fallback after 2 failures on ${agent}`,
    });
  }
  assert.equal(routeJob(job, { lanes, failures }).agent, 'claude');
  failures.claude = 1;
  assert.equal(routeJob(job, { lanes, failures }).agent, 'claude');
  failures.claude = 2;
  assert.throws(() => routeJob(job, { lanes, failures }), { code: 'route-exhausted' });
  assert.equal(routeJob(job, { lanes, failures: { codex: 3 } }).agent, 'openrouter');
});

test('paused lanes are skipped while backoff lanes remain eligible', () => {
  assert.equal(routeJob(job, { lanes, health: agent => ({ state: agent === 'hermes' ? 'paused' : 'ok' }) }).agent, 'cursor');
  assert.equal(routeJob(job, { lanes, health: () => ({ state: 'backoff' }) }).agent, 'hermes');
});

test('all paused returns the first remaining lane and names its pause', () => {
  const result = routeJob(job, { lanes, failures: { cursor: 2 }, health: () => ({ state: 'paused' }) });
  assert.deepEqual(result, {
    agent: 'codex', model: 'codex-model', reason: 'fallback after 2 failures on cursor; lane codex paused',
  });
});

test('accepts receives the resolved job and filters rejected lanes', () => {
  const seen = [];
  const result = routeJob({ ...job, sensitive: true }, { lanes, accepts: resolved => {
    seen.push(resolved);
    return resolved.agent === 'codex';
  } });
  assert.equal(result.agent, 'codex');
  assert.deepEqual(seen[0], { ...job, sensitive: true, agent: 'hermes', model: 'hermes-model' });
  assert.equal(seen.some(candidate => candidate.agent === 'openrouter'), false);
  assert.equal(routeJob(job, { lanes, accepts: () => undefined }).agent, 'hermes');
  assert.equal(routeJob(job, { lanes, accepts: resolved => resolved.agent !== 'hermes', health: () => ({ state: 'paused' }) }).agent, 'cursor');
});

test('exhaustion reports code, job id, and reason', () => {
  assert.throws(() => routeJob(job), {
    code: 'route-exhausted', message: 'route-exhausted: no lane left for job route-job (cheapest healthy lane)',
  });
  assert.throws(() => routeJob(job, { lanes, accepts: () => false }), { code: 'route-exhausted' });
  assert.throws(() => routeJob(job, { lanes, failures: { claude: 2 } }), {
    code: 'route-exhausted', message: 'route-exhausted: no lane left for job route-job (fallback after 2 failures on claude)',
  });
});
