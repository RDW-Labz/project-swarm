// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANE_AGENTS, LANE_DEFAULTS, resolveLanes, classifyProviderOutcome, LaneScheduler } from '../tools/lanes.mjs';

function fixture(overrides = {}, globalConcurrency = 4, random = () => 1) {
  let time = 1700000000000;
  let nextId = 0;
  const timers = new Map();
  const scheduler = new LaneScheduler({
    lanes: resolveLanes({ manifest: { lanes: overrides } }), globalConcurrency,
    now: () => time, random,
    setTimer: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return {
    scheduler, timers, now: () => time,
    async tick(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await Promise.resolve();
      }
      time = end;
      await Promise.resolve();
    },
  };
}
const outcome = (kind, extra = {}) => ({ kind, retryAfterMs: null, resetsAt: null, ...extra });

test('defaults are complete, deeply frozen, and independently resolved', () => {
  assert.deepEqual(LANE_AGENTS, ['hermes', 'cursor', 'codex', 'claude', 'qwen', 'openai', 'gemini', 'ollama', 'lambda', 'openrouter']);
  assert.ok(Object.isFrozen(LANE_AGENTS));
  assert.ok(Object.isFrozen(LANE_DEFAULTS));
  const lanes = resolveLanes();
  assert.deepEqual(Object.keys(lanes), LANE_AGENTS);
  for (const agent of LANE_AGENTS) {
    assert.ok(Object.isFrozen(LANE_DEFAULTS[agent]));
    assert.ok(Object.isFrozen(LANE_DEFAULTS[agent].backoff));
    assert.deepEqual(lanes[agent], {
      concurrency: ({ hermes: 3, cursor: 8, codex: 6, claude: 4, openrouter: 64 })[agent] ?? 32,
      requestsPerMinute: null, backoff: { baseMs: 2000, maxMs: 300000, maxRetries: 5 },
      pauseMs: 900000, maxPauseMs: 900000, model: null,
    });
  }
  lanes.hermes.backoff.baseMs = 7;
  assert.equal(resolveLanes().hermes.backoff.baseMs, 2000);
  assert.equal(lanes.cursor.backoff.baseMs, 2000);
});

test('config precedes manifest; lane and backoff fields merge independently', () => {
  const config = { lanes: { codex: { concurrency: 9, requestsPerMinute: 8, model: 'gpt-5', backoff: { baseMs: 10, maxRetries: 2 } } } };
  const manifest = { lanes: { codex: { concurrency: 5, backoff: { maxMs: 400 } }, cursor: { model: 'vendor/model:v1.2_3' } } };
  assert.deepEqual(resolveLanes({ config, manifest }).codex, {
    concurrency: 5, requestsPerMinute: 8, model: 'gpt-5', backoff: { baseMs: 10, maxMs: 400, maxRetries: 2 },
    pauseMs: 900000, maxPauseMs: 900000,
  });
  assert.equal(config.lanes.codex.concurrency, 9);
  assert.equal(manifest.lanes.codex.backoff.baseMs, undefined);
  assert.equal(resolveLanes({ config, manifest }).cursor.model, 'vendor/model:v1.2_3');
  assert.equal(resolveLanes({ config, manifest: { lanes: { codex: { model: null, requestsPerMinute: null } } } }).codex.model, null);
  assert.deepEqual(resolveLanes({
    config: { lanes: { codex: { backoff: { baseMs: 600000 } } } },
    manifest: { lanes: { codex: { backoff: { maxMs: 900000 } } } },
  }).codex.backoff, { baseMs: 600000, maxMs: 900000, maxRetries: 5 });
});

test('every invalid field, shape, range, and model refuses with lanes-invalid', () => {
  const cases = [
    ['concurrency', [0, 513, 1.5, null, '2', NaN, Infinity]],
    ['requestsPerMinute', [0, 100001, 1.5, '2', undefined, Infinity]],
    ['pauseMs', [0, 86400001, 1.5, null, '2']],
    ['maxPauseMs', [0, 86400001, 1.5, null, '2']],
    ['model', ['', '-bad', 'a b', 'a'.repeat(121), 'a\n', 7, false, {}]],
    ['backoff.baseMs', [0, 600001, 1.5, null, '2']],
    ['backoff.maxMs', [1999, 3600001, 2000.5, null, '2000']],
    ['backoff.maxRetries', [-1, 21, 0.5, null, '2']],
  ];
  for (const [field, values] of cases) for (const value of values) {
    const [parent, key] = field.split('.');
    const lane = key ? { [parent]: { [key]: value } } : { [field]: value };
    for (const source of ['config', 'manifest']) assert.throws(() => resolveLanes({ [source]: { lanes: { codex: lane } } }), error => {
      assert.equal(error.code, 'lanes-invalid');
      assert.ok(error.message.startsWith(`lanes-invalid: codex.${field} `));
      return true;
    });
  }
  for (const lanes of [null, [], false, 'bad', { unknown: {} }, { toString: {} }, { codex: null }, { codex: [] },
    { codex: { mystery: 1 } }, { codex: { backoff: null } }, { codex: { backoff: [] } }, { codex: { backoff: { unknown: 1 } } }]) {
    assert.throws(() => resolveLanes({ manifest: { lanes } }), { code: 'lanes-invalid' });
  }
  assert.throws(() => resolveLanes({ manifest: { lanes: JSON.parse('{"__proto__":{}}') } }), { code: 'lanes-invalid' });
});

test('inclusive validation bounds and maximum model length are accepted', () => {
  for (const concurrency of [1, 512]) for (const requestsPerMinute of [null, 1, 100000]) {
    assert.equal(resolveLanes({ manifest: { lanes: { hermes: { concurrency, requestsPerMinute } } } }).hermes.concurrency, concurrency);
  }
  for (const bounds of [
    { backoff: { baseMs: 1, maxMs: 1, maxRetries: 0 }, pauseMs: 1, maxPauseMs: 1, model: null },
    { backoff: { baseMs: 600000, maxMs: 3600000, maxRetries: 20 }, pauseMs: 86400000, maxPauseMs: 86400000, model: 'a'.repeat(120) },
  ]) assert.deepEqual(resolveLanes({ manifest: { lanes: { codex: bounds } } }).codex, { ...LANE_DEFAULTS.codex, ...bounds });
});

test('classification covers all rules, complete precedence, and quota before rate limits', () => {
  const cases = [
    [{ status: 'complete', httpStatus: 402, error: '429 quota exhausted', quotaExhausted: true }, 'ok'],
    [{ status: 'provider-limit' }, 'quota-exhausted'], [{ quotaExhausted: true }, 'quota-exhausted'],
    [{ httpStatus: 402 }, 'quota-exhausted'], [{ httpStatus: 429 }, 'rate-limited'],
    ...['429', 'RATE LIMIT', 'rate-limit', 'rate limited', 'ratelimited', 'too many requests'].map(error => [{ error }, 'rate-limited']),
    ...['quota exhausted', 'quota exceeded', 'insufficient_quota', 'insufficient quota', 'insufficient_credit', 'insufficient credits', 'out of credit', 'out of credits'].map(error => [{ error: `429 ${error} rate limited`, httpStatus: 429 }, 'quota-exhausted']),
    [{ error: 'network down' }, 'other'], [{ error: '1429 ratelimiter' }, 'other'], [{ quotaExhausted: 'true', httpStatus: '429' }, 'other'],
    [{ error: { toString() { throw Error('must not coerce'); } } }, 'other'], [{}, 'other'],
  ];
  for (const [result, kind] of cases) assert.deepEqual(classifyProviderOutcome(result), { kind, retryAfterMs: null, resetsAt: null });
  for (const retryAfterMs of [0, 0.5, 12345]) assert.equal(classifyProviderOutcome({ retryAfterMs }).retryAfterMs, retryAfterMs);
  for (const retryAfterMs of [-1, NaN, Infinity, '1', null]) assert.equal(classifyProviderOutcome({ retryAfterMs }).retryAfterMs, null);
  assert.equal(classifyProviderOutcome({ resetsAt: 'arbitrary string' }).resetsAt, 'arbitrary string');
  assert.equal(classifyProviderOutcome({ resetsAt: 12 }).resetsAt, null);
  assert.equal(classifyProviderOutcome({ get body() { throw Error('must not read'); } }).kind, 'other');
});

test('lane cap and FIFO do not block another lane; release is idempotent', async () => {
  const { scheduler: s } = fixture({ hermes: { concurrency: 1 }, cursor: { concurrency: 2 } });
  const first = await s.acquire('hermes');
  const order = [];
  const second = s.acquire('hermes').then(release => { order.push(2); return release; });
  const third = s.acquire('hermes').then(release => { order.push(3); return release; });
  const cursor1 = await s.acquire('cursor');
  const cursor2 = await s.acquire('cursor');
  assert.equal(s.health('hermes').queued, 2);
  assert.equal(s.health('cursor').inFlight, 2);
  assert.deepEqual(order, []);
  first(); first();
  const release2 = await second;
  assert.deepEqual(order, [2]);
  assert.equal(s.health('hermes').inFlight, 1);
  release2();
  const release3 = await third;
  assert.deepEqual(order, [2, 3]);
  release3(); cursor1(); cursor2();
  assert.equal(s.snapshot().globalInFlight, 0);
  s.close();
});

test('global capacity constrains multiple lanes and preserves peak', async () => {
  const { scheduler: s } = fixture({}, 2);
  const a = await s.acquire('hermes');
  const b = await s.acquire('cursor');
  const pending = s.acquire('codex');
  assert.equal(s.health('codex').queued, 1);
  assert.equal(s.snapshot().globalInFlight, 2);
  a();
  const c = await pending;
  assert.equal(s.snapshot().globalInFlight, 2);
  b(); c();
  assert.equal(s.snapshot().peakGlobal, 2);
  s.close();
});

test('RPM counts acquisitions in a trailing window, including released slots', async () => {
  const f = fixture({ hermes: { requestsPerMinute: 2 } });
  const s = f.scheduler;
  (await s.acquire('hermes'))();
  await f.tick(1000);
  (await s.acquire('hermes'))();
  const third = s.acquire('hermes');
  const fourth = s.acquire('hermes');
  assert.equal(s.health('hermes').queued, 2);
  (await s.acquire('cursor'))();
  await f.tick(58999);
  assert.equal(s.health('hermes').queued, 2);
  await f.tick(1);
  (await third)();
  assert.equal(s.health('hermes').queued, 1);
  await f.tick(1000);
  (await fourth)();
  assert.equal(s.health('hermes').queued, 0);
  s.close();
  assert.equal(f.timers.size, 0);
});

test('global cap serves eligible waiters in arrival order across lanes', async () => {
  const { scheduler: s } = fixture({}, 1);
  const occupied = await s.acquire('hermes');
  const order = [];
  const pending = ['codex', 'openai', 'codex'].map(agent => s.acquire(agent).then(release => {
    order.push(agent);
    return release;
  }));
  assert.deepEqual(order, []);
  occupied();
  for (const [index, acquisition] of pending.entries()) {
    const release = await acquisition;
    assert.deepEqual(order, ['codex', 'openai', 'codex'].slice(0, index + 1));
    release();
  }
  s.close();
});

test('a capped lane is skipped when global capacity becomes available', async () => {
  const { scheduler: s } = fixture({ codex: { concurrency: 1 } }, 2);
  const codex = await s.acquire('codex');
  const occupied = await s.acquire('hermes');
  const order = [];
  const waitingCodex = s.acquire('codex').then(release => { order.push('codex'); return release; });
  const waitingOpenai = s.acquire('openai').then(release => { order.push('openai'); return release; });
  occupied();
  const openai = await waitingOpenai;
  assert.deepEqual(order, ['openai']);
  assert.equal(s.health('codex').queued, 1);
  codex();
  const nextCodex = await waitingCodex;
  assert.deepEqual(order, ['openai', 'codex']);
  openai(); nextCodex();
  s.close();
});

test('rate limits preserve a later quota pause and its queued wake time', async () => {
  const f = fixture({ codex: { pauseMs: 500, backoff: { baseMs: 100, maxMs: 100 } } });
  const s = f.scheduler;
  s.report('codex', outcome('quota-exhausted'));
  const until = s.health('codex').until;
  const pending = s.acquire('codex');
  await f.tick(50);
  s.report('codex', { kind: 'rate-limited' });
  assert.equal(s.health('codex').state, 'paused');
  assert.equal(s.health('codex').until, until);
  assert.equal(s.health('codex').consecutiveRateLimits, 1);
  assert.equal(s.pausedFor('codex'), 450);
  await f.tick(100);
  assert.equal(s.health('codex').queued, 1);
  s.report('codex', outcome('rate-limited', { retryAfterMs: 0 }));
  assert.equal(s.health('codex').until, until);
  await f.tick(349);
  assert.equal(s.health('codex').queued, 1);
  await f.tick(1);
  (await pending)();
  assert.equal(s.health('codex').state, 'ok');
  s.close();
  assert.equal(f.timers.size, 0);
});

test('backoff grows exponentially, caps before jitter, and respects retryAfter override', async () => {
  for (const random of [0, 0.5, 1]) {
    const f = fixture({ codex: { backoff: { baseMs: 100, maxMs: 250 } } }, 4, () => random);
    const s = f.scheduler;
    for (const [index, capped] of [100, 200, 250, 250].entries()) {
      s.report('codex', outcome('rate-limited'));
      const delay = capped * (0.5 + random / 2);
      assert.equal(s.health('codex').until, new Date(f.now() + delay).toISOString());
      assert.equal(s.health('codex').consecutiveRateLimits, index + 1);
      assert.equal(s.pausedFor('codex'), 0);
      await f.tick(delay);
      assert.equal(s.health('codex').state, 'ok');
    }
    s.report('codex', outcome('rate-limited', { retryAfterMs: 777 }));
    assert.equal(s.health('codex').until, new Date(f.now() + 777).toISOString());
    s.report('codex', outcome('other'));
    assert.equal(s.health('codex').consecutiveRateLimits, 5);
    s.report('codex', outcome('ok'));
    assert.equal(s.health('codex').consecutiveRateLimits, 0);
    assert.equal(s.health('codex').state, 'backoff');
    await f.tick(777);
    s.report('codex', outcome('rate-limited'));
    assert.equal(s.health('codex').until, new Date(f.now() + 100 * (0.5 + random / 2)).toISOString());
    s.report('codex', outcome('rate-limited', { retryAfterMs: 0 }));
    assert.equal(s.health('codex').state, 'ok');
    s.close();
    assert.equal(f.timers.size, 0);
  }
});

test('backoff wakes queued FIFO work while other lanes run', async () => {
  const f = fixture({ hermes: { backoff: { baseMs: 100, maxMs: 100 }, concurrency: 1 } });
  const s = f.scheduler;
  s.report('hermes', outcome('rate-limited'));
  const first = s.acquire('hermes');
  const second = s.acquire('hermes');
  (await s.acquire('cursor'))();
  await f.tick(99);
  assert.equal(s.health('hermes').queued, 2);
  await f.tick(1);
  assert.equal(s.health('hermes').state, 'ok');
  assert.equal(s.health('hermes').queued, 1);
  (await first)();
  (await second)();
  s.close();
});

test('quota pause uses future reset, otherwise pauseMs; timers wake waiters', async () => {
  const f = fixture({ codex: { pauseMs: 500 } });
  const s = f.scheduler;
  const reset = new Date(f.now() + 1000).toISOString();
  s.report('codex', outcome('quota-exhausted', { resetsAt: reset }));
  assert.equal(s.health('codex').until, reset);
  assert.equal(s.pausedFor('codex'), 1000);
  const waiting = s.acquire('codex');
  (await s.acquire('cursor'))();
  await f.tick(999);
  assert.equal(s.pausedFor('codex'), 1);
  assert.equal(s.health('codex').queued, 1);
  await f.tick(1);
  (await waiting)();
  assert.equal(s.health('codex').state, 'ok');
  assert.equal(s.pausedFor('codex'), 0);
  for (const resetsAt of [null, 'invalid', new Date(f.now()).toISOString(), new Date(f.now() - 1).toISOString()]) {
    s.report('codex', outcome('quota-exhausted', { resetsAt }));
    assert.equal(s.pausedFor('codex'), 500);
    const pending = s.acquire('codex');
    await f.tick(500);
    (await pending)();
    assert.equal(s.pausedFor('codex'), 0);
  }
  s.close();
  assert.equal(f.timers.size, 0);
});

test('abort while queued removes waiter, including pre-aborted signals', async () => {
  const f = fixture({}, 1);
  const s = f.scheduler;
  const release = await s.acquire('hermes');
  const controller = new AbortController();
  const pending = s.acquire('hermes', { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(s.health('hermes').queued, 0);
  await assert.rejects(s.acquire('cursor', { signal: controller.signal }), { name: 'AbortError' });
  const granted = new AbortController();
  release();
  const live = await s.acquire('cursor', { signal: granted.signal });
  granted.abort();
  assert.equal(s.health('cursor').inFlight, 1);
  live();
  s.close();
});

test('close clears timers and rejects every queued waiter; active releases remain safe', async () => {
  const f = fixture({}, 1);
  const s = f.scheduler;
  const release = await s.acquire('hermes');
  s.report('codex', outcome('rate-limited'));
  const rejects = [assert.rejects(s.acquire('hermes'), { name: 'AbortError' }), assert.rejects(s.acquire('codex'), { name: 'AbortError' })];
  assert.ok(f.timers.size > 0);
  s.close(); s.close();
  await Promise.all(rejects);
  assert.equal(f.timers.size, 0);
  assert.equal(s.health('codex').queued, 0);
  await assert.rejects(s.acquire('cursor'), { name: 'AbortError' });
  release(); release();
  assert.equal(s.snapshot().globalInFlight, 0);
  await f.tick(60000);
  assert.equal(f.timers.size, 0);
});

test('health, snapshot, pausedFor, unknown agents and global limits', async () => {
  const f = fixture({}, 3);
  const s = f.scheduler;
  assert.deepEqual(s.snapshot(), { globalConcurrency: 3, globalInFlight: 0, peakGlobal: 0, lanes: {} });
  assert.deepEqual(s.health('hermes'), { agent: 'hermes', state: 'ok', until: null, inFlight: 0, queued: 0, concurrency: 3, consecutiveRateLimits: 0 });
  assert.deepEqual(s.snapshot().lanes, {});
  const release = await s.acquire('hermes');
  s.report('cursor', outcome('quota-exhausted'));
  assert.deepEqual(s.snapshot(), {
    globalConcurrency: 3, globalInFlight: 1, peakGlobal: 1,
    lanes: {
      hermes: { agent: 'hermes', state: 'ok', until: null, inFlight: 1, queued: 0, concurrency: 3, consecutiveRateLimits: 0, peak: 1 },
      cursor: { agent: 'cursor', state: 'paused', until: new Date(f.now() + 900000).toISOString(), inFlight: 0, queued: 0, concurrency: 8, consecutiveRateLimits: 0, peak: 0 },
    },
  });
  for (const agent of ['unknown', 'toString', '__proto__']) {
    for (const action of [() => s.acquire(agent), () => s.report(agent, outcome('ok')), () => s.health(agent), () => s.pausedFor(agent)]) {
      assert.throws(action, { code: 'lanes-invalid' });
    }
  }
  for (const globalConcurrency of [0, 513, 1.5]) assert.throws(() => new LaneScheduler({ lanes: resolveLanes(), globalConcurrency }), { code: 'lanes-invalid' });
  release();
  assert.equal(s.snapshot().lanes.hermes.peak, 1);
  s.close();
});
