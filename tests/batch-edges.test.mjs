import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBatchCollector, batchEligible, batchCostUsd, estimateBatchSavings } from '../tools/batch.mjs';

const RESULTS = 'https://results.test/b1';
const BODY = { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'PROMPT-XYZ' }] };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const line = (custom_id, result) => JSON.stringify({ custom_id, result }) + '\n';
const tick = () => new Promise((r) => setImmediate(r));
async function waitFor(pred) {
  for (let i = 0; i < 2000 && !pred(); i++) await tick();
  assert.ok(pred(), 'condition not reached');
}

function mkApi(o = {}) {
  const calls = [];
  let polls = 0;
  const plan = o.plan ?? ((n) => (n >= 2 ? 'ended' : 'running'));
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method });
    if (url.endsWith('/cancel')) return json(200, {});
    if (url === RESULTS) return new Response(o.lines ?? line('j-1', { type: 'succeeded', message: { id: 'msg_1' } }), { status: 200 });
    if (method === 'POST') {
      if (o.createError) throw o.createError;
      if (o.createStatus) return json(o.createStatus, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
      return json(200, { id: 'b1', processing_status: 'in_progress' });
    }
    const step = plan(++polls);
    if (step === 'fail') return new Response('nope', { status: 500 });
    if (step === 'throw') throw new Error('poll-net');
    if (step === 'ended') return json(200, { id: 'b1', processing_status: 'ended', results_url: RESULTS });
    return json(200, { id: 'b1', processing_status: 'in_progress' });
  };
  return { fetchImpl, calls, polls: () => polls };
}

function harness(o = {}, limits = {}) {
  const api = mkApi(o);
  const timers = [];
  const events = [];
  let t = 0;
  const c = createBatchCollector({
    fetchImpl: api.fetchImpl,
    readKey: () => 'sk-SECRET',
    now: () => t,
    sleep: async (ms) => { t += ms; await tick(); },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    limits,
    onEvent: (e) => events.push(e),
  });
  return { c, api, events, flush: () => timers.shift()?.() };
}

test('create failure status is passed through as a Response', async () => {
  const h = harness({ createStatus: 429 });
  const p = h.c.submit(BODY, { id: 'j' });
  h.flush();
  const r = await p;
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.type, 'rate_limit_error');
});

test('network failure on create rejects every request', async () => {
  const h = harness({ createError: new TypeError('offline') });
  const p = h.c.submit(BODY, { id: 'j' });
  h.flush();
  await assert.rejects(p, /offline/);
});

test('poll tolerates 5 consecutive failures', async () => {
  const h = harness({ plan: (n) => (n <= 5 ? 'fail' : 'ended') });
  const p = h.c.submit(BODY, { id: 'j' });
  h.flush();
  const r = await p;
  assert.equal(r.status, 200);
  assert.equal(h.api.polls(), 6);
});

test('poll rejects on the sixth consecutive failure', async () => {
  const h = harness({ plan: () => 'fail' });
  const p = h.c.submit(BODY, { id: 'j' });
  h.flush();
  await assert.rejects(p, /poll-500/);
  assert.equal(h.api.polls(), 6);
});

test('unfinished batch expires after expireMs with 504 batch_expired', async () => {
  const h = harness({ plan: () => 'running' }, { expireMs: 60000 });
  const p = h.c.submit(BODY, { id: 'j' });
  h.flush();
  const r = await p;
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error.type, 'batch_expired');
});

test('abort before sending rejects with AbortError and sends nothing', async () => {
  const ac = new AbortController();
  ac.abort();
  const h = harness();
  await assert.rejects(h.c.submit(BODY, { id: 'j', signal: ac.signal }), { name: 'AbortError' });
  assert.equal(h.api.calls.length, 0);
});

test('abort while pending drops the request from the pending set', async () => {
  const ac = new AbortController();
  const h = harness();
  const p = h.c.submit(BODY, { id: 'j', signal: ac.signal });
  assert.equal(h.c.status().pending, 1);
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(h.c.status().pending, 0);
  h.flush();
  assert.equal(h.api.calls.length, 0);
});

test('abort after sending cancels the remote batch when every request is aborted', async () => {
  const ac = new AbortController();
  const h = harness({ plan: () => 'running' });
  const p = h.c.submit(BODY, { id: 'j', signal: ac.signal });
  h.flush();
  await waitFor(() => h.events.some((e) => e.type === 'submitted'));
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  await waitFor(() => h.api.calls.some((c) => c.url.endsWith('/cancel')));
  assert.ok(h.events.some((e) => e.type === 'canceled'));
});

test('cancelAll cancels sent batches and rejects pending requests', async () => {
  const h = harness({ plan: () => 'running' });
  const p1 = h.c.submit(BODY, { id: 'a' });
  h.flush();
  await waitFor(() => h.events.some((e) => e.type === 'submitted'));
  const p2 = h.c.submit(BODY, { id: 'b' });
  const a1 = assert.rejects(p1, { name: 'AbortError' });
  const a2 = assert.rejects(p2, { name: 'AbortError' });
  await h.c.cancelAll();
  await a1;
  await a2;
  assert.ok(h.api.calls.some((c) => c.url.endsWith('/cancel')));
  assert.equal(h.c.status().batches[0].state, 'canceled');
});

test('close rejects pending work and later submits with batch-closed', async () => {
  const h = harness();
  const p = h.c.submit(BODY, { id: 'a' });
  h.c.close();
  await assert.rejects(p, { message: 'batch-closed' });
  await assert.rejects(h.c.submit(BODY, { id: 'b' }), { message: 'batch-closed' });
});

test('submit validates the request body', async () => {
  const h = harness();
  await assert.rejects(h.c.submit({ model: 'm' }, { id: 'j' }), { message: 'batch-request-invalid' });
});

test('status() reports pending count and batch state', async () => {
  const h = harness({ plan: () => 'running' });
  const p = h.c.submit(BODY, { id: 'a' });
  assert.deepEqual(h.c.status(), { pending: 1, batches: [] });
  h.flush();
  await waitFor(() => h.events.some((e) => e.type === 'submitted'));
  const s = h.c.status();
  assert.equal(s.pending, 0);
  assert.deepEqual(s.batches, [{ id: 'b1', requests: 1, state: 'in_progress' }]);
  await h.c.cancelAll();
  await assert.rejects(p, { name: 'AbortError' });
});

test('onEvent never carries the key or request bodies', async () => {
  const h = harness();
  const p = h.c.submit(BODY, { id: 'j' });
  h.flush();
  await p;
  const dump = JSON.stringify(h.events);
  assert.ok(!dump.includes('sk-SECRET'));
  assert.ok(!dump.includes('PROMPT-XYZ'));
  const types = h.events.map((e) => e.type);
  assert.ok(types.includes('submitted') && types.includes('ended'));
});

test('batchEligible truth table', () => {
  const anth = { agent: 'anthropic', type: 'review' };
  assert.equal(batchEligible(anth, { types: ['review'] }), true);
  assert.equal(batchEligible(anth), false);
  assert.equal(batchEligible(anth, { all: true }), true);
  assert.equal(batchEligible({ agent: 'anthropic', batch: true }), true);
  assert.equal(batchEligible({ agent: 'anthropic', type: 'lead', batch: true }), false);
  assert.equal(batchEligible({ agent: 'anthropic', type: 'review', batch: false }, { all: true }), false);
  assert.equal(batchEligible({ agent: 'openai', type: 'review', batch: true }), false);
  assert.equal(batchEligible({ agent: 'anthropic' }, { types: ['review'] }), false);
  assert.equal(batchEligible(anth, { types: 'review' }), false);
  assert.equal(batchEligible(null, { all: true }), false);
  assert.equal(batchEligible('x', { all: true }), false);
});

test('batchCostUsd halves the price and keeps null', () => {
  assert.equal(batchCostUsd(2), 1);
  assert.equal(batchCostUsd(null), null);
});

test('estimateBatchSavings computes batch and saved amounts', () => {
  assert.deepEqual(estimateBatchSavings(2), { standardUsd: 2, batchUsd: 1, savedUsd: 1 });
  assert.deepEqual(estimateBatchSavings(1, { fraction: 0.25 }), { standardUsd: 1, batchUsd: 0.25, savedUsd: 0.75 });
  assert.deepEqual(estimateBatchSavings(null), { standardUsd: null, batchUsd: null, savedUsd: null });
});
