// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHEAP_ORDER, ROUTE_ORDER, routeJob } from '../tools/router.mjs';

// A code job: not sensitive, no bookkeeping outputs. OpenRouter never gets it.
const job = { id: 'route-job', agent: 'auto', sensitive: false, outputs: ['src/a.js'] };
// A bookkeeping job: the only kind OpenRouter may run, and only when it is not sensitive.
const bookkeeping = { ...job, outputs: ['CHANGELOG.md'] };
const lanes = { ...Object.fromEntries(ROUTE_ORDER.map(agent => [agent, { model: `${agent}-model` }])), hermes: { model: 'hermes-model' } };
const paused = () => ({ state: 'paused' });
// A job carrying the full rented contract (outputs, context, contract in context, acceptance tests).
const contracted = { ...job, sensitive: false, outputs: ['src/a.js'], context: ['src/a.js', 'docs/contract.md'], contract: 'docs/contract.md', acceptance: ['tests/a.test.mjs'] };
const rentedLanes = { ...lanes, rented: { model: 'rented-model' } };

test('route orders are frozen, cheapest first, and leave Hermes out', () => {
  assert.deepEqual(CHEAP_ORDER, ['anthropic', 'cursor', 'codex', 'openrouter']);
  assert.deepEqual(ROUTE_ORDER, [...CHEAP_ORDER, 'claude']);
  assert.equal(Object.isFrozen(CHEAP_ORDER), true);
  assert.equal(Object.isFrozen(ROUTE_ORDER), true);
  assert.equal(CHEAP_ORDER.includes('hermes') || ROUTE_ORDER.includes('hermes'), false);
  assert.deepEqual(routeJob(job, { lanes }), { agent: 'anthropic', model: 'anthropic-model', reason: 'cheapest healthy lane' });
  for (let index = 0; index < CHEAP_ORDER.length; index++) {
    const available = Object.fromEntries(ROUTE_ORDER.slice(index).map(agent => [agent, lanes[agent]]));
    assert.equal(routeJob(bookkeeping, { lanes: available }).agent, CHEAP_ORDER[index]);
  }
});

test('non-auto jobs are route-invalid', () => {
  for (const invalid of [{ agent: 'codex' }, {}, null]) {
    assert.throws(() => routeJob(invalid, { lanes }), { code: 'route-invalid' });
  }
});

test('missing, null, and non-string models are skipped', () => {
  const available = { anthropic: { model: null }, cursor: {}, codex: { model: 42 }, openrouter: lanes.openrouter, claude: lanes.claude };
  assert.equal(routeJob(bookkeeping, { lanes: available }).agent, 'openrouter');
  assert.throws(() => routeJob(job, { lanes: available }), { code: 'route-exhausted' });
});

test('Hermes never runs an untyped or code job, even when it is the only lane configured', () => {
  assert.equal(routeJob(job, { lanes }).agent, 'anthropic');
  assert.throws(() => routeJob(job, { lanes: { hermes: lanes.hermes } }), { code: 'route-exhausted' });
  assert.throws(() => routeJob(job, { lanes: { hermes: lanes.hermes, claude: lanes.claude } }), { code: 'route-exhausted' });
});

test('OpenRouter only gets non-sensitive bookkeeping jobs', () => {
  const available = { openrouter: lanes.openrouter, claude: lanes.claude };
  assert.equal(routeJob(bookkeeping, { lanes: available }).agent, 'openrouter');
  for (const sensitive of [undefined, true]) {
    assert.throws(() => routeJob({ ...bookkeeping, sensitive }, { lanes: available }), { code: 'route-exhausted' });
  }
  for (const outputs of [['src/a.js'], [], ['CHANGELOG.md', 'src/a.js'], undefined]) {
    assert.throws(() => routeJob({ ...bookkeeping, outputs }, { lanes: available }), { code: 'route-exhausted' });
  }
  assert.equal(routeJob({ ...bookkeeping, outputs: ['.swarm-manifests/plan.md', 'docs/pr-body.md'] }, { lanes: available }).agent, 'openrouter');
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
    assert.equal(routeJob(bookkeeping, { lanes, failures }).agent, agent);
    failures[agent] = 2;
    const result = routeJob(bookkeeping, { lanes, failures });
    assert.equal(result.agent, ROUTE_ORDER[index + 1]);
    assert.equal(result.reason, `fallback after 2 failures on ${CHEAP_ORDER.slice(0, index + 1).join(', ')}`);
  }
  failures.claude = 1;
  assert.equal(routeJob(bookkeeping, { lanes, failures }).agent, 'claude');
  failures.claude = 2;
  assert.throws(() => routeJob(bookkeeping, { lanes, failures }), { code: 'route-exhausted' });
  assert.equal(routeJob(job, { lanes, failures: { codex: 3 } }).agent, 'anthropic');
});

test('Claude requires two real cheap failures even when accepts rejects all cheap lanes', () => {
  const available = { openrouter: lanes.openrouter, claude: lanes.claude };
  assert.equal(routeJob(bookkeeping, { lanes: available, failures: { openrouter: 1 } }).agent, 'openrouter');
  assert.throws(() => routeJob(bookkeeping, { lanes: available, failures: { openrouter: 1 }, accepts: resolved => resolved.agent === 'claude' }), { code: 'route-exhausted' });
  assert.equal(routeJob(bookkeeping, { lanes: available, failures: { openrouter: 2 } }).agent, 'claude');
  const result = routeJob(job, { lanes, failures: { anthropic: 1, cursor: 1 }, accepts: resolved => resolved.agent === 'claude' });
  assert.equal(result.agent, 'claude');
  assert.equal(result.reason, 'fallback after 2 failures on anthropic, cursor');
  assert.throws(() => routeJob(bookkeeping, { lanes: available, failures: { openrouter: 2 }, accepts: () => false }), { code: 'route-exhausted' });
});

test('a research route runs on Hermes and stays cheap when Hermes is paused or unavailable', () => {
  const research = { ...job, typeRoute: ['hermes'] };
  assert.equal(routeJob(research, { lanes }).agent, 'hermes');
  assert.equal(routeJob(research, { lanes, health: agent => ({ state: agent === 'hermes' ? 'paused' : 'ok' }) }).agent, 'anthropic');
  assert.equal(routeJob(research, { lanes: { ...lanes, hermes: {} } }).agent, 'anthropic');
  assert.deepEqual(routeJob(research, { lanes, health: paused }), {
    agent: 'hermes', model: 'hermes-model', reason: 'cheapest healthy lane; lane hermes paused',
  });
  assert.equal(routeJob(research, { lanes: { hermes: lanes.hermes, claude: lanes.claude }, health: paused }).agent, 'hermes');
  assert.equal(routeJob(research, { lanes, failures: { hermes: 2 } }).agent, 'anthropic');
  assert.equal(routeJob(job, { lanes, health: () => ({ state: 'backoff' }) }).agent, 'anthropic');
  assert.equal(routeJob(job, { lanes, failures: { anthropic: 2 }, health: paused }).agent, 'cursor');
});

test('accepts receives the resolved job and filters rejected lanes', () => {
  const seen = [];
  const result = routeJob({ ...job, sensitive: true }, { lanes, accepts: resolved => {
    seen.push(resolved);
    return resolved.agent === 'codex';
  } });
  assert.equal(result.agent, 'codex');
  assert.deepEqual(seen[0], { ...job, sensitive: true, agent: 'anthropic', model: 'anthropic-model' });
  assert.equal(seen.some(candidate => candidate.agent === 'openrouter'), false);
  assert.equal(routeJob(job, { lanes, accepts: () => undefined }).agent, 'anthropic');
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
  const typed = { ...bookkeeping, typeRoute: ['codex', 'cursor'] };
  const failures = {};
  for (const agent of ['codex', 'cursor', 'anthropic', 'openrouter', 'claude']) {
    assert.equal(routeJob(typed, { lanes, failures }).agent, agent);
    failures[agent] = 2;
  }
  assert.equal(routeJob({ ...job, typeRoute: [] }, { lanes }).agent, 'anthropic');
  assert.equal(routeJob({ ...job, typeRoute: ['claude', 'codex'] }, { lanes }).agent, 'codex');
});

test('typeRoute retains sensitivity, bookkeeping, expensive tier, health, and accepts filters', () => {
  const typed = { ...bookkeeping, typeRoute: ['openrouter', 'codex'] };
  assert.equal(routeJob({ ...typed, sensitive: true }, { lanes }).agent, 'codex');
  assert.equal(routeJob({ ...typed, outputs: ['src/a.js'] }, { lanes }).agent, 'codex');
  assert.equal(routeJob({ ...typed, tier: 'expensive' }, { lanes }).agent, 'claude');
  assert.equal(routeJob(typed, { lanes, health: agent => ({ state: agent === 'openrouter' ? 'paused' : 'ok' }) }).agent, 'codex');
  assert.throws(() => routeJob(typed, { lanes, accepts: resolved => resolved.agent === 'claude' }), { code: 'route-exhausted' });
});

test('no sensitive job is ever a candidate for OpenRouter, OpenAI, Gemini or Lambda, even when a type route names them', () => {
  const all = { ...lanes, openai: { model: 'o' }, gemini: { model: 'g' }, lambda: { model: 'l' } };
  for (const sensitive of [true, undefined, 'false', 0, null]) {
    for (const agent of ['openrouter', 'openai', 'gemini', 'lambda']) {
      const typed = { ...bookkeeping, sensitive, typeRoute: [agent] };
      const picked = routeJob(typed, { lanes: all });
      assert.notEqual(picked.agent, agent, `${agent} with sensitive=${String(sensitive)}`);
    }
  }
  // not sensitive: these lanes can be named by a type route (OpenRouter still needs bookkeeping outputs)
  assert.equal(routeJob({ ...job, typeRoute: ['openai'] }, { lanes: all }).agent, 'openai');
  assert.equal(routeJob({ ...bookkeeping, typeRoute: ['openrouter'] }, { lanes: all }).agent, 'openrouter');
});

test('isBookkeepingJob refuses traversal, absolute paths, non-strings and holes', async () => {
  const { isBookkeepingJob } = await import('../tools/openrouter.mjs');
  assert.equal(isBookkeepingJob(['CHANGELOG.md']), true);
  assert.equal(isBookkeepingJob(['docs/pr-body.md', '.swarm-manifests/plan.md']), true);
  for (const bad of [['../../x/CHANGELOG.md'], ['/etc/CHANGELOG.md'], ['C:/x/CHANGELOG.md'], ['a/../CHANGELOG.md'], [['CHANGELOG.md']], [null], [''], [], 'CHANGELOG.md', undefined, new Array(2)]) {
    assert.equal(isBookkeepingJob(bad), false, JSON.stringify(bad));
  }
});

test('rented lane is not chosen below the default threshold of 700 ready jobs', () => {
  assert.deepEqual(routeJob(contracted, { lanes: rentedLanes, ready: 699 }), { agent: 'anthropic', model: 'anthropic-model', reason: 'cheapest healthy lane' });
});

test('rented lane is chosen at exactly 700 ready jobs for a complete non-sensitive contract job', () => {
  assert.deepEqual(routeJob(contracted, { lanes: rentedLanes, ready: 700 }), { agent: 'rented', model: 'rented-model', reason: 'cheapest healthy lane' });
});

test('rented lane is not chosen when ready is omitted', () => {
  assert.equal(routeJob(contracted, { lanes: rentedLanes }).agent, 'anthropic');
});

test('rented lane needs a complete contract job', () => {
  const { acceptance, ...noAcceptance } = contracted;
  assert.equal(routeJob(noAcceptance, { lanes: rentedLanes, ready: 1000 }).agent, 'anthropic');
  assert.equal(routeJob({ ...contracted, contract: 'docs/other.md' }, { lanes: rentedLanes, ready: 1000 }).agent, 'anthropic');
});

test('lanes.rented.minReady overrides the default threshold', () => {
  const lowered = { ...rentedLanes, rented: { model: 'rented-model', minReady: 5 } };
  assert.equal(routeJob(contracted, { lanes: lowered, ready: 5 }).agent, 'rented');
  assert.equal(routeJob(contracted, { lanes: lowered, ready: 4 }).agent, 'anthropic');
  const raised = { ...rentedLanes, rented: { model: 'rented-model', minReady: 2000 } };
  assert.equal(routeJob(contracted, { lanes: raised, ready: 700 }).agent, 'anthropic');
});

test('a sensitive job is never routed to the rented lane at any ready count', () => {
  for (const ready of [0, 699, 700, 100000]) {
    const picked = routeJob({ ...contracted, sensitive: true }, { lanes: rentedLanes, ready });
    assert.notEqual(picked.agent, 'rented');
  }
  assert.notEqual(routeJob({ ...contracted, sensitive: true, typeRoute: ['rented'] }, { lanes: rentedLanes, ready: 100000 }).agent, 'rented');
});

test('a hard job goes to codex first when codex is configured', () => {
  const hard = { ...contracted, hard: true };
  assert.deepEqual(routeJob(hard, { lanes: rentedLanes, ready: 700 }), { agent: 'codex', model: 'codex-model', reason: 'hard ticket: codex first' });
  assert.deepEqual(routeJob(hard, { lanes }), { agent: 'codex', model: 'codex-model', reason: 'hard ticket: codex first' });
});

test('a hard job falls back to the next lane after 2 failures on codex', () => {
  const hard = { ...contracted, hard: true };
  assert.deepEqual(routeJob(hard, { lanes, failures: { codex: 1 } }), { agent: 'codex', model: 'codex-model', reason: 'hard ticket: codex first' });
  assert.deepEqual(routeJob(hard, { lanes, failures: { codex: 2 } }), { agent: 'anthropic', model: 'anthropic-model', reason: 'fallback after 2 failures on codex' });
});

test('a hard job with tier expensive keeps the claude-only rule', () => {
  const hard = { ...contracted, hard: true, tier: 'expensive' };
  assert.deepEqual(routeJob(hard, { lanes }), { agent: 'claude', model: 'claude-model', reason: 'tier expensive' });
  assert.throws(() => routeJob(hard, { lanes: { hermes: lanes.hermes } }), { code: 'route-exhausted' });
});

test('a job without hard is unchanged and goes to anthropic first', () => {
  assert.deepEqual(routeJob(contracted, { lanes }), { agent: 'anthropic', model: 'anthropic-model', reason: 'cheapest healthy lane' });
  assert.deepEqual(routeJob({ ...contracted, hard: false }, { lanes }), { agent: 'anthropic', model: 'anthropic-model', reason: 'cheapest healthy lane' });
});
