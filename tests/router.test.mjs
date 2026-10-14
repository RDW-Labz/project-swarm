// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHEAP_ORDER, ROUTE_ORDER, routeJob } from '../tools/router.mjs';

const job = { id: 'route-job', agent: 'auto', sensitive: false };
const lanes = Object.fromEntries(ROUTE_ORDER.map(agent => [agent, { model: `${agent}-model` }]));
const paused = () => ({ state: 'paused' });

test('route orders are frozen and cheapest first', () => {
  assert.deepEqual(CHEAP_ORDER, ['hermes', 'cursor', 'codex', 'openrouter']);
  assert.deepEqual(ROUTE_ORDER, [...CHEAP_ORDER, 'claude']);
  assert.equal(Object.isFrozen(CHEAP_ORDER), true);
  assert.equal(Object.isFrozen(ROUTE_ORDER), true);
  assert.deepEqual(routeJob(job, { lanes }), { agent: 'hermes', model: 'hermes-model', reason: 'cheapest healthy lane' });
  for (let index = 0; index < CHEAP_ORDER.length; index++) {
    const available = Object.fromEntries(ROUTE_ORDER.slice(index).map(agent => [agent, lanes[agent]]));
    assert.equal(routeJob(job, { lanes: available }).agent, CHEAP_ORDER[index]);
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

test('jobs are sensitive by default and only false allows OpenRouter', () => {
  const available = { hermes: lanes.hermes, openrouter: lanes.openrouter, claude: lanes.claude };
  for (const sensitive of [undefined, true]) {
    const result = routeJob({ ...job, sensitive }, { lanes: available, health: agent => ({ state: agent === 'hermes' ? 'paused' : 'ok' }) });
    assert.equal(result.agent, 'hermes');
    assert.match(result.reason, /lane hermes paused/);
  }
  assert.equal(routeJob(job, { lanes: available, health: agent => ({ state: agent === 'hermes' ? 'paused' : 'ok' }) }).agent, 'openrouter');
});

test('expensive tier uses only Claude', () => {
  assert.deepEqual(routeJob({ ...job, tier: 'expensive' }, { lanes }), {
    agent: 'claude', model: 'claude-model', reason: 'tier expensive',
  });
  assert.throws(() => routeJob({ ...job, tier: 'expensive' }, { lanes: { hermes: lanes.hermes } }), { code: 'route-exhausted' });
  assert.throws(() => routeJob({ ...job, tier: 'expensive' }, { lanes, failures: { claude: 2 } }), { code: 'route-exhausted' });
});

test('failed lanes are dropped individually and Claude waits until cheap lanes are exhausted', () => {
  const failures = {};
  for (let index = 0; index < CHEAP_ORDER.length; index++) {
    const agent = CHEAP_ORDER[index];
    failures[agent] = 1;
    assert.equal(routeJob(job, { lanes, failures }).agent, agent);
    failures[agent] = 2;
    const result = routeJob(job, { lanes, failures });
    assert.equal(result.agent, ROUTE_ORDER[index + 1]);
    assert.equal(result.reason, `fallback after 2 failures on ${CHEAP_ORDER.slice(0, index + 1).join(', ')}`);
  }
  failures.claude = 1;
  assert.equal(routeJob(job, { lanes, failures }).agent, 'claude');
  failures.claude = 2;
  assert.throws(() => routeJob(job, { lanes, failures }), { code: 'route-exhausted' });
  assert.equal(routeJob(job, { lanes, failures: { codex: 3 } }).agent, 'hermes');
});

test('Claude requires two real cheap failures even when accepts rejects all cheap lanes', () => {
  const available = { openrouter: lanes.openrouter, claude: lanes.claude };
  assert.equal(routeJob(job, { lanes: available, failures: { openrouter: 1 } }).agent, 'openrouter');
  assert.throws(() => routeJob(job, { lanes: available, failures: { openrouter: 1 }, accepts: resolved => resolved.agent === 'claude' }), { code: 'route-exhausted' });
  assert.equal(routeJob(job, { lanes: available, failures: { openrouter: 2 } }).agent, 'claude');
  const result = routeJob(job, { lanes, failures: { hermes: 1, cursor: 1 }, accepts: resolved => resolved.agent === 'claude' });
  assert.equal(result.agent, 'claude');
  assert.equal(result.reason, 'fallback after 2 failures on hermes, cursor');
  assert.throws(() => routeJob(job, { lanes: available, failures: { openrouter: 2 }, accepts: () => false }), { code: 'route-exhausted' });
});

test('docs routes stay cheap when Hermes is paused or unavailable', () => {
  const docs = { ...job, typeRoute: ['hermes'] };
  assert.equal(routeJob(docs, { lanes, health: agent => ({ state: agent === 'hermes' ? 'paused' : 'ok' }) }).agent, 'cursor');
  assert.equal(routeJob(docs, { lanes: { ...lanes, hermes: {} } }).agent, 'cursor');
  assert.deepEqual(routeJob(docs, { lanes, health: paused }), {
    agent: 'hermes', model: 'hermes-model', reason: 'cheapest healthy lane; lane hermes paused',
  });
  assert.equal(routeJob(docs, { lanes: { hermes: lanes.hermes, claude: lanes.claude }, health: paused }).agent, 'hermes');
  assert.equal(routeJob(job, { lanes, health: () => ({ state: 'backoff' }) }).agent, 'hermes');
  assert.equal(routeJob(job, { lanes, failures: { cursor: 2 }, health: paused }).agent, 'hermes');
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
});

test('only Claude configured without failures exhausts with actionable message', () => {
  for (const available of [{}, { claude: lanes.claude }]) {
    assert.throws(() => routeJob(job, { lanes: available }), {
      code: 'route-exhausted',
      message: 'route-exhausted: no cheap lane available for job route-job; Claude needs 2 real failures first or tier "expensive"',
    });
  }
  assert.throws(() => routeJob(job, { lanes, accepts: () => false }), { code: 'route-exhausted' });
});

test('typeRoute order is followed by remaining cheap lanes and skips Claude entries', () => {
  const typed = { ...job, typeRoute: ['codex', 'cursor'] };
  const failures = {};
  for (const agent of ['codex', 'cursor', 'hermes', 'openrouter', 'claude']) {
    assert.equal(routeJob(typed, { lanes, failures }).agent, agent);
    failures[agent] = 2;
  }
  assert.equal(routeJob({ ...job, typeRoute: [] }, { lanes }).agent, 'hermes');
  assert.equal(routeJob({ ...job, typeRoute: ['claude', 'codex'] }, { lanes }).agent, 'codex');
});

test('typeRoute retains sensitivity, expensive tier, health, and accepts filters', () => {
  const typed = { ...job, typeRoute: ['openrouter', 'codex'] };
  assert.equal(routeJob({ ...typed, sensitive: true }, { lanes }).agent, 'codex');
  assert.equal(routeJob({ ...typed, tier: 'expensive' }, { lanes }).agent, 'claude');
  assert.equal(routeJob(typed, { lanes, health: agent => ({ state: agent === 'openrouter' ? 'paused' : 'ok' }) }).agent, 'codex');
  assert.throws(() => routeJob(typed, { lanes, accepts: resolved => resolved.agent === 'claude' }), { code: 'route-exhausted' });
});
