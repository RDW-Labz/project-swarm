// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrain, BRAIN_LIMITS, estimateTokens, summarizeBrainLedger } from '../tools/brain.mjs';
import { sanitizeText } from '../tools/journal.mjs';

const OK = { text: 'ok', model: 'm', usage: { inTokens: 3, outTokens: 2 } };
const req = (extra = {}) => ({ kind: 'think', system: 's', user: 'u', ...extra });
const never = () => new Promise(() => {});
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const codeError = code => Object.assign(new Error(code), { code });
const rejectsWith = (promise, code) => assert.rejects(promise, e => e.code === code || String(e.message).includes(code));

function fakeLink(chat = async () => OK) {
  const link = { calls: 0, closed: 0, status: () => ({ up: true, model: 'm' }), close() { link.closed++; } };
  link.chat = async (...args) => { link.calls++; return chat(...args); };
  return link;
}

function fallback() {
  const f = async () => { f.n++; return { text: 'haiku', usage: { inTokens: 5, outTokens: 7 }, paidUsd: 0.01 }; };
  f.n = 0;
  return f;
}

test('rejects an unknown kind', async () => {
  const b = createBrain({ getLink: async () => fakeLink() });
  await rejectsWith(b.ask(req({ kind: 'chat' })), 'brain-request-invalid');
  await b.close();
});

test('local link is used first and the fallback is not called', async () => {
  const lk = fakeLink();
  const fb = fallback();
  const b = createBrain({ getLink: async () => lk, fallback: fb });
  const r = await b.ask(req());
  assert.equal(r.via, 'local');
  assert.equal(r.text, 'ok');
  assert.equal(r.paidUsd, 0);
  assert.deepEqual(r.usage, { inTokens: 3, outTokens: 2 });
  assert.equal(typeof r.ms, 'number');
  assert.equal(fb.n, 0);
  assert.equal(lk.calls, 1);
  await b.close();
});

test('fallback is used when getLink returns null and the request is not sensitive', async () => {
  const fb = fallback();
  const b = createBrain({ getLink: async () => null, fallback: fb });
  const r = await b.ask(req());
  assert.equal(r.via, 'haiku');
  assert.equal(r.paidUsd, 0.01);
  assert.deepEqual(r.usage, { inTokens: 5, outTokens: 7 });
  assert.equal(fb.n, 1);
  await b.close();
});

test('fallback is used when getLink throws', async () => {
  const fb = fallback();
  const b = createBrain({ getLink: async () => { throw new Error('down'); }, fallback: fb });
  const r = await b.ask(req());
  assert.equal(r.via, 'haiku');
  assert.equal(fb.n, 1);
  await b.close();
});

test('fallback is used once after link.chat throws brain-unavailable', async () => {
  const lk = fakeLink(async () => { throw codeError('brain-unavailable'); });
  const fb = fallback();
  const b = createBrain({ getLink: async () => lk, fallback: fb });
  const r = await b.ask(req());
  assert.equal(r.via, 'haiku');
  assert.equal(lk.calls, 1);
  assert.equal(fb.n, 1);
  await b.close();
});

test('sensitive request never falls back when getLink is null', async () => {
  const fb = fallback();
  const b = createBrain({ getLink: async () => null, fallback: fb });
  await rejectsWith(b.ask(req({ sensitive: true })), 'brain-unavailable');
  assert.equal(fb.n, 0);
  await b.close();
});

test('sensitive request never falls back when chat throws', async () => {
  const lk = fakeLink(async () => { throw codeError('brain-unavailable'); });
  const fb = fallback();
  const b = createBrain({ getLink: async () => lk, fallback: fb });
  await rejectsWith(b.ask(req({ sensitive: true })), 'brain-unavailable');
  assert.equal(fb.n, 0);
  await b.close();
});

test('non-sensitive request without a fallback throws brain-unavailable', async () => {
  const b = createBrain({ getLink: async () => null, fallback: null });
  await rejectsWith(b.ask(req()), 'brain-unavailable');
  await b.close();
});

test('text is sanitized with sanitizeText and control characters are removed', async () => {
  const raw = 'hello' + String.fromCharCode(7) + ' api_key=abcdef1234567890 world';
  const lk = fakeLink(async () => ({ ...OK, text: raw }));
  const b = createBrain({ getLink: async () => lk });
  const r = await b.ask(req());
  assert.equal(r.text, sanitizeText(raw));
  assert.ok(!r.text.includes('abcdef1234567890'));
  assert.ok(!r.text.includes(String.fromCharCode(7)));
  await b.close();
});

test('text is cut to maxOutputChars', async () => {
  const lk = fakeLink(async () => ({ ...OK, text: 'x'.repeat(9000) }));
  const b = createBrain({ getLink: async () => lk });
  const r = await b.ask(req());
  assert.ok(r.text.length <= BRAIN_LIMITS.maxOutputChars);
  assert.ok(r.text.length > 0);
  await b.close();
});

test('status kind is accepted', async () => {
  const b = createBrain({ getLink: async () => fakeLink() });
  const r = await b.ask(req({ kind: 'status' }));
  assert.equal(r.via, 'local');
  await b.close();
});

test('concurrency 1 runs one request at a time', async () => {
  const gates = [deferred(), deferred()];
  const lk = fakeLink(async () => { const i = lk.calls - 1; await gates[i].promise; return OK; });
  const b = createBrain({ getLink: async () => lk, concurrency: 1 });
  const p1 = b.ask(req());
  const p2 = b.ask(req());
  await settle();
  assert.equal(b.status().running, 1);
  assert.equal(b.status().queued, 1);
  assert.equal(lk.calls, 1);
  gates[0].resolve();
  await p1;
  await settle();
  assert.equal(lk.calls, 2);
  gates[1].resolve();
  await p2;
  assert.equal(b.status().running, 0);
  await b.close();
});

test('concurrency 2 runs two requests at once', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const lk = fakeLink(async () => { const i = lk.calls - 1; await gates[i].promise; return OK; });
  const b = createBrain({ getLink: async () => lk, concurrency: 2 });
  const p1 = b.ask(req());
  const p2 = b.ask(req());
  const p3 = b.ask(req());
  await settle();
  assert.equal(b.status().running, 2);
  assert.equal(b.status().queued, 1);
  assert.equal(lk.calls, 2);
  gates[0].resolve();
  await p1;
  await settle();
  assert.equal(lk.calls, 3);
  gates[1].resolve();
  gates[2].resolve();
  await Promise.all([p2, p3]);
  await b.close();
});

test('concurrency is clamped to the range 1 to 2', async () => {
  const high = createBrain({ getLink: async () => null, concurrency: 9 });
  const low = createBrain({ getLink: async () => null, concurrency: 0 });
  assert.equal(high.status().concurrency, 2);
  assert.equal(low.status().concurrency, 1);
  await high.close();
  await low.close();
});

test('more than maxQueued waiting requests throws brain-busy', async () => {
  const lk = fakeLink(never);
  const b = createBrain({ getLink: async () => lk, timeoutMs: 100 });
  const running = b.ask(req()).catch(e => e);
  await settle();
  const queued = [];
  for (let i = 0; i < BRAIN_LIMITS.maxQueued; i++) queued.push(b.ask(req()).catch(e => e));
  await settle();
  assert.equal(b.status().queued, BRAIN_LIMITS.maxQueued);
  await rejectsWith(b.ask(req()), 'brain-busy');
  await b.close();
  const errors = await Promise.all(queued);
  assert.ok(errors.every(e => e.code === 'brain-closed'));
  await running;
});

test('a request that times out is abandoned and the queue continues', async () => {
  let n = 0;
  const lk = fakeLink(async () => (n++ === 0 ? never() : OK));
  const b = createBrain({ getLink: async () => lk, timeoutMs: 30 });
  await rejectsWith(b.ask(req()), 'timeout');
  const r = await b.ask(req());
  assert.equal(r.via, 'local');
  await b.close();
});

test('a successful request writes one ledger event', async () => {
  const events = [];
  const b = createBrain({ getLink: async () => fakeLink(), ledger: async e => { events.push(e); } });
  await b.ask(req({ kind: 'digest', savedTokens: 120 }));
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.kind, 'digest');
  assert.equal(e.via, 'local');
  assert.equal(e.inTokens, 3);
  assert.equal(e.outTokens, 2);
  assert.equal(e.savedTokens, 120);
  assert.equal(e.paidUsd, 0);
  assert.equal(e.ok, true);
  assert.equal(typeof e.ms, 'number');
  await b.close();
});

test('ledger savedTokens is clamped to 0 and 2000000', async () => {
  const events = [];
  const b = createBrain({ getLink: async () => fakeLink(), ledger: async e => { events.push(e); } });
  await b.ask(req({ savedTokens: -5 }));
  await b.ask(req({ savedTokens: 9e9 }));
  assert.equal(events[0].savedTokens, 0);
  assert.equal(events[1].savedTokens, 2000000);
  await b.close();
});

test('fallback ledger event records haiku and paidUsd', async () => {
  const events = [];
  const b = createBrain({ getLink: async () => null, fallback: fallback(), ledger: async e => { events.push(e); } });
  await b.ask(req());
  assert.equal(events[0].via, 'haiku');
  assert.equal(events[0].paidUsd, 0.01);
  await b.close();
});

test('a failed request writes a failure ledger event with the error code', async () => {
  const events = [];
  const b = createBrain({ getLink: async () => null, ledger: async e => { events.push(e); } });
  await rejectsWith(b.ask(req({ sensitive: true })), 'brain-unavailable');
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, false);
  assert.equal(events[0].via, null);
  assert.equal(events[0].error, 'brain-unavailable');
  await b.close();
});

test('a ledger failure is ignored', async () => {
  const b = createBrain({ getLink: async () => fakeLink(), ledger: async () => { throw new Error('disk full'); } });
  const r = await b.ask(req());
  assert.equal(r.text, 'ok');
  await b.close();
});

test('summarizeBrainLedger totals events and skips malformed ones', () => {
  const events = [
    { kind: 'think', via: 'local', inTokens: 10, outTokens: 5, savedTokens: 100, paidUsd: 0, ms: 5, ok: true },
    { kind: 'think', via: 'haiku', inTokens: 4, outTokens: 2, savedTokens: 50, paidUsd: 0.02, ms: 6, ok: true },
    { kind: 'digest', via: 'local', inTokens: 1, outTokens: 1, savedTokens: 30, paidUsd: 0, ms: 2, ok: true },
    { kind: 'triage', via: null, ok: false, error: 'brain-unavailable' },
    null,
    'junk',
    42,
  ];
  const s = summarizeBrainLedger(events);
  assert.equal(s.local, 2);
  assert.equal(s.haiku, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.inTokens, 15);
  assert.equal(s.outTokens, 8);
  assert.equal(s.savedTokens, 180);
  assert.equal(s.paidUsd, 0.02);
  assert.equal(s.byKind.think.calls, 2);
  assert.equal(s.byKind.think.savedTokens, 150);
  assert.equal(s.byKind.digest.savedTokens, 30);
});

test('summarizeBrainLedger of an empty list is all zeros', () => {
  const s = summarizeBrainLedger([]);
  assert.equal(s.local, 0);
  assert.equal(s.haiku, 0);
  assert.equal(s.savedTokens, 0);
  assert.equal(s.paidUsd, 0);
});

test('estimateTokens is ceil(length / 4)', () => {
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens(''), 0);
});

test('close rejects queued requests with brain-closed and closes the link', async () => {
  const lk = fakeLink(never);
  const b = createBrain({ getLink: async () => lk, timeoutMs: 100 });
  const running = b.ask(req()).catch(e => e);
  await settle();
  const queued = b.ask(req()).catch(e => e);
  await settle();
  await b.close();
  const q = await queued;
  assert.equal(q.code, 'brain-closed');
  assert.equal(lk.closed, 1);
  await running;
});

test('a saved-only event adds saved tokens without counting as a call', () => {
  const sum = summarizeBrainLedger([
    { kind: 'digest', via: 'local', inTokens: 100, outTokens: 20, savedTokens: 0, paidUsd: 0, ok: true },
    { kind: 'digest', savedOnly: true, savedTokens: 900 },
    { kind: 'think', savedOnly: true, savedTokens: -5 },
    { kind: 'bogus', savedOnly: true, savedTokens: 50 },
  ]);
  assert.equal(sum.calls, 1);
  assert.equal(sum.savedTokens, 900);
  assert.deepEqual(sum.byKind.digest, { calls: 1, savedTokens: 900 });
  assert.equal(sum.byKind.think.calls, 0);
});
