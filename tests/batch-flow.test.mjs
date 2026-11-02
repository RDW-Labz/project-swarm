import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBatchCollector, BATCH_LIMITS } from '../tools/batch.mjs';

const KEY = 'sk-SECRET-123';
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const body = (text = 'hi') => ({ model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: text }] });
const line = (custom_id, result) => JSON.stringify({ custom_id, result });
const ok = (id, reqs) => reqs.map((r) => line(r.custom_id, { type: 'succeeded', message: { id: r.custom_id } }));

function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimer: (fn, ms) => { id += 1; timers.set(id, { fn, ms }); return id; },
    clearTimer: (t) => { timers.delete(t); },
    fire: async () => { const all = [...timers.values()]; timers.clear(); all.forEach((x) => x.fn()); await tick(); },
    delays: () => [...timers.values()].map((x) => x.ms),
    count: () => timers.size,
  };
}

function fakeApi({ resultsFor = () => [], polls = ['in_progress', 'ended'], createStatus = 200, pollFails = 0, createThrows = false } = {}) {
  const calls = [];
  const created = [];
  const seen = new Map();
  let fails = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const method = init.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/v1/messages/batches')) {
      if (createThrows) throw new Error('ECONNRESET');
      if (createStatus !== 200) return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: createStatus });
      created.push(JSON.parse(init.body).requests);
      return new Response(JSON.stringify({ id: `msgbatch_${created.length}`, processing_status: 'in_progress' }), { status: 200 });
    }
    if (url.endsWith('/cancel')) return new Response('{}', { status: 200 });
    const id = url.split('/batches/')[1].split('/')[0];
    if (url.endsWith('/results')) return new Response(resultsFor(id, created[Number(id.split('_')[1]) - 1]).join('\n'), { status: 200 });
    if (fails < pollFails) { fails += 1; return new Response('nope', { status: 500 }); }
    const k = (seen.get(id) ?? 0) + 1;
    seen.set(id, k);
    const processing_status = polls[Math.min(k - 1, polls.length - 1)];
    return new Response(JSON.stringify({ id, processing_status, results_url: `https://api.anthropic.com/v1/messages/batches/${id}/results` }), { status: 200 });
  };
  return { fetchImpl, calls, created };
}

function make(t, api, extra = {}) {
  const events = [];
  const col = createBatchCollector({ fetchImpl: api.fetchImpl, readKey: () => KEY, setTimer: t.setTimer, clearTimer: t.clearTimer, sleep: async () => {}, now: () => 0, onEvent: (e) => events.push(e), ...extra });
  return { col, events };
}

test('requests wait collectMs after the first one, then go out as one batch', async () => {
  const t = fakeTimers();
  const api = fakeApi({ resultsFor: ok });
  const { col } = make(t, api);
  const p = [col.submit(body('a'), { id: 'a' }), col.submit(body('b'), { id: 'b' })];
  await tick();
  assert.equal(api.calls.length, 0);
  assert.deepEqual(t.delays(), [BATCH_LIMITS.collectMs]);
  assert.equal(col.status().pending, 2);
  await t.fire();
  const rs = await Promise.all(p);
  assert.equal(api.created.length, 1);
  assert.deepEqual(api.created[0].map((r) => r.custom_id), ['a-1', 'b-2']);
  assert.equal(rs[1].status, 200);
  assert.equal((await rs[0].json()).id, 'a-1');
  assert.equal(api.calls[0].init.method, 'POST');
  assert.equal(api.calls[0].init.headers['x-api-key'], KEY);
  assert.deepEqual(col.status().batches, [{ id: 'msgbatch_1', requests: 2, state: 'ended' }]);
});

test('a batch is flushed early when the next request would exceed maxRequests', async () => {
  const t = fakeTimers();
  const api = fakeApi({ resultsFor: ok });
  const { col } = make(t, api, { limits: { maxRequests: 2 } });
  const p = [1, 2, 3].map((i) => col.submit(body(), { id: 'j' + i }));
  await tick();
  assert.equal(api.created.length, 1);
  assert.equal(api.created[0].length, 2);
  await t.fire();
  await Promise.all(p);
  assert.deepEqual(api.created.map((r) => r.length), [2, 1]);
});

test('a batch is flushed early when the next request would exceed maxBytes', async () => {
  const t = fakeTimers();
  const api = fakeApi({ resultsFor: ok });
  const big = body('x'.repeat(500));
  const size = Buffer.byteLength(JSON.stringify(big));
  const { col } = make(t, api, { limits: { maxBytes: size * 2 } });
  const p = [col.submit(big, { id: 'a' }), col.submit(big, { id: 'b' }), col.submit(big, { id: 'c' })];
  await tick();
  assert.deepEqual(api.created.map((r) => r.length), [2]);
  await t.fire();
  await Promise.all(p);
  assert.deepEqual(api.created.map((r) => r.length), [2, 1]);
});

test('custom_id is sanitized, capped at 56 characters and unique per request', async () => {
  const t = fakeTimers();
  const api = fakeApi({ resultsFor: ok });
  const { col } = make(t, api);
  const p = [col.submit(body(), { id: 'job/a b.c:\u00e9' }), col.submit(body(), { id: 'job/a b.c:\u00e9' }), col.submit(body(), { id: 'a'.repeat(100) })];
  await t.fire();
  await Promise.all(p);
  const ids = api.created[0].map((r) => r.custom_id);
  assert.deepEqual(ids, ['job_a_b_c__-1', 'job_a_b_c__-2', 'a'.repeat(56) + '-3']);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s)));
});

const kinds = [
  { type: 'succeeded', message: { id: 'msg_ok', content: [] } },
  { type: 'errored', error: { type: 'invalid_request_error', message: 'm' } },
  { type: 'errored', error: { type: 'authentication_error', message: 'm' } },
  { type: 'errored', error: { type: 'permission_error', message: 'm' } },
  { type: 'errored', error: { type: 'not_found_error', message: 'm' } },
  { type: 'errored', error: { type: 'rate_limit_error', message: 'm' } },
  { type: 'errored', error: { type: 'overloaded_error', message: 'm' } },
  { type: 'errored', error: { type: 'api_error', message: 'm' } },
  { type: 'canceled' },
  { type: 'expired' },
  null,
];
const want = [200, 400, 401, 403, 404, 429, 529, 500, 499, 504, 504];

test('each result type maps to the right Response, with missing and malformed lines handled', async () => {
  const t = fakeTimers();
  const api = fakeApi({ resultsFor: (id, reqs) => ['not json', line('unknown-id', kinds[0]), ...reqs.flatMap((r, i) => (kinds[i] ? [line(r.custom_id, kinds[i])] : []))] });
  const { col } = make(t, api);
  const p = kinds.map((_, i) => col.submit(body(), { id: 'r' + i }));
  await t.fire();
  const rs = await Promise.all(p);
  assert.deepEqual(rs.map((r) => r.status), want);
  assert.deepEqual(await rs[0].json(), kinds[0].message);
  assert.deepEqual(await rs[1].json(), { type: 'error', error: kinds[1].error });
  assert.equal((await rs[7].json()).error.type, 'api_error');
  assert.equal((await rs[8].json()).error.type, 'batch_canceled');
  assert.equal((await rs[9].json()).error.type, 'batch_expired');
  assert.equal((await rs[10].json()).error.type, 'batch_expired');
});

test('a rejected batch create answers every request with the provider status and body', async () => {
  const t = fakeTimers();
  const api = fakeApi({ createStatus: 429 });
  const { col } = make(t, api);
  const p = [col.submit(body(), { id: 'a' }), col.submit(body(), { id: 'b' })];
  await t.fire();
  const rs = await Promise.all(p);
  assert.deepEqual(rs.map((r) => r.status), [429, 429]);
  assert.equal((await rs[0].json()).error.type, 'rate_limit_error');
  assert.equal(api.calls.length, 1);
});

test('a network failure on create rejects every request of that batch', async () => {
  const t = fakeTimers();
  const api = fakeApi({ createThrows: true });
  const { col } = make(t, api);
  const p = [col.submit(body(), { id: 'a' }).then(() => null, (e) => e), col.submit(body(), { id: 'b' }).then(() => null, (e) => e)];
  await t.fire();
  const errs = await Promise.all(p);
  assert.deepEqual(errs.map((e) => e.message), ['ECONNRESET', 'ECONNRESET']);
});

test('invalid request bodies are rejected before anything is queued', async () => {
  const t = fakeTimers();
  const api = fakeApi();
  const { col } = make(t, api);
  const bad = [null, [], { ...body(), model: 1 }, { ...body(), max_tokens: 1.5 }, { ...body(), messages: [] }, { model: 'm', max_tokens: 1 }, { ...body(), messages: 'hi' }, { ...body(), messages: [{ role: 'user', content: 'x'.repeat(4 * 1024 * 1024) }] }];
  for (const b of bad) {
    await assert.rejects(col.submit(b, { id: 'v' }), { message: 'batch-request-invalid' });
  }
  assert.equal(t.count(), 0);
  assert.equal(col.status().pending, 0);
});

test('the key goes only in the x-api-key header', async () => {
  const t = fakeTimers();
  const api = fakeApi({ resultsFor: ok });
  const { col, events } = make(t, api);
  const p = [col.submit(body(), { id: 'a' })];
  await t.fire();
  const rs = await Promise.all(p);
  assert.equal(rs[0].status, 200);
  assert.equal(api.calls.length, 4);
  for (const k of api.calls) {
    assert.equal(k.init.headers['x-api-key'], KEY);
    assert.ok(!String(k.url).includes(KEY));
    assert.ok(!String(k.init.body ?? '').includes(KEY));
  }
  assert.deepEqual(events.map((e) => e.type), ['submitted', 'polled', 'polled', 'ended']);
  assert.ok(!JSON.stringify(events).includes(KEY));
  assert.ok(!JSON.stringify(col.status()).includes(KEY));
});

test('the window is a quiet period: it restarts with each request, but never holds one past maxHoldMs', async () => {
  const t = fakeTimers();
  const api = fakeApi({ resultsFor: ok });
  let clock = 1000;
  const col = createBatchCollector({ fetchImpl: api.fetchImpl, readKey: () => KEY, setTimer: t.setTimer, clearTimer: t.clearTimer, sleep: async () => {}, now: () => clock, limits: { collectMs: 2000, maxHoldMs: 5000 } });
  const first = col.submit(body('a'), { id: 'a' });
  assert.deepEqual(t.delays(), [2000]);
  clock += 1500;
  const second = col.submit(body('b'), { id: 'b' });
  assert.deepEqual(t.delays(), [2000], 'restarted, still one timer');
  clock += 2500; // 4000 ms since the first request: only 1000 ms of hold left
  const third = col.submit(body('c'), { id: 'c' });
  assert.deepEqual(t.delays(), [1000], 'capped by maxHoldMs');
  await t.fire();
  await Promise.all([first, second, third]);
  assert.equal(api.created.length, 1);
  assert.equal(api.created[0].length, 3);
});
