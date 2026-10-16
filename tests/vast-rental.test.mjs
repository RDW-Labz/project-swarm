// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API, VM_IMAGE, readKey, createClient, checkOffer, createBody, deadlineAt, findOffer, destroyInstance, waitRunning, writeState, readState, reap } from '../bench/gpu-bakeoff/vast.mjs';

const res = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const good = { id: 1, gpu_name: 'RTX PRO 6000 Max-Q', num_gpus: 1, vms_enabled: true, rentable: true, verification: 'verified', dph_total: 2.211 };
const gone = { instances: null };
const clock = () => { const c = { t: 0 }; c.now = () => c.t; c.wait = async ms => { c.t += ms; }; return c; };

test('readKey trims the keychain output and rejects an empty one', () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, args]); return '  sk-test-123\n'; };
  assert.equal(readKey(exec), 'sk-test-123');
  assert.deepEqual(calls[0], ['security', ['find-generic-password', '-s', 'project-swarm', '-a', 'vast.api_key', '-w']]);
  assert.throws(() => readKey(() => '  \n'), /no Vast key/);
});

test('createClient sends bearer auth, parses JSON, and hides the key in errors', async () => {
  const seen = [];
  const ok = createClient('KEY123', async (url, init) => { seen.push({ url, init }); return res(200, { a: 1 }); });
  assert.deepEqual(await ok.call('GET', '/x'), { a: 1 });
  assert.equal(seen[0].url, `${API}/x`);
  assert.equal(seen[0].init.headers.authorization, 'Bearer KEY123');
  assert.equal(seen[0].init.headers['content-type'], 'application/json');
  const bad = createClient('KEY123', async () => res(500, { msg: 'boom' }));
  await assert.rejects(bad.call('GET', '/x'), error => {
    assert.ok(error.message.includes('GET'));
    assert.ok(error.message.includes('/x'));
    assert.ok(error.message.includes('500'));
    assert.ok(!error.message.includes('KEY123'));
    return true;
  });
});

test('checkOffer accepts an approved offer and computes the 4-hour worst case', () => {
  assert.ok(Math.abs(checkOffer(good, { hours: 4, maxUsd: 15 }).worstUsd - 8.844) < 1e-9);
});

test('checkOffer worst case includes inet_down_cost times 100', () => {
  const offer = { ...good, dph_total: 2, inet_down_cost: 0.5 };
  assert.equal(checkOffer(offer, { hours: 4, maxUsd: 100 }).worstUsd, 58);
  assert.throws(() => checkOffer(offer, { hours: 4, maxUsd: 15 }), /over 80%/);
});

test('checkOffer refuses unapproved offers with the reason', () => {
  const cap = { hours: 4, maxUsd: 15 };
  const cases = [
    [{ ...good, gpu_name: 'RTX 4090' }, /not an RTX PRO 6000/],
    [{ ...good, num_gpus: 2 }, /2 GPUs/],
    [{ ...good, vms_enabled: false }, /VM-capable/],
    [{ ...good, rentable: false }, /not rentable/],
    [{ ...good, verification: 'unverified' }, /host is unverified/],
    [{ ...good, dph_total: 3.6 }, /over 80%/],
    [null, /offer not found/],
  ];
  for (const [offer, reason] of cases) assert.throws(() => checkOffer(offer, cap), reason);
});

test('createBody and deadlineAt', () => {
  const body = createBody();
  assert.equal(body.image, VM_IMAGE);
  assert.equal(body.runtype, 'ssh_direct');
  assert.equal(body.vm, true);
  assert.equal(body.disk, 150);
  assert.equal(body.label, 'swarm-bakeoff');
  assert.equal(deadlineAt(0, 4), '1970-01-01T04:00:00.000Z');
});

test('findOffer posts to /bundles/ and finds by id or returns null', async () => {
  const seen = [];
  const client = createClient('k', async (url, init) => { seen.push({ url, method: init.method }); return res(200, { offers: [{ id: 1 }, { id: 2 }] }); });
  assert.deepEqual(await findOffer(client, 2), { id: 2 });
  assert.equal(await findOffer(client, 9), null);
  assert.deepEqual(seen[0], { url: `${API}/bundles/`, method: 'POST' });
});

test('destroyInstance deletes, retries after failures, and verifies the instance is gone', async () => {
  const seen = [];
  let failures = 2;
  const client = createClient('k', async (url, init) => {
    seen.push({ url, method: init.method });
    if (init.method === 'GET') return res(200, gone);
    if (failures-- > 0) return res(500, 'nope');
    return res(200, { success: true });
  });
  assert.equal(await destroyInstance(client, 7, { wait: clock().wait }), true);
  assert.equal(seen.length, 4);
  assert.deepEqual(seen[2], { url: `${API}/instances/7/`, method: 'DELETE' });
  assert.deepEqual(seen[3], { url: `${API}/instances/7/`, method: 'GET' });
  const always = createClient('k', async () => res(500, 'nope'));
  await assert.rejects(destroyInstance(always, 7, { retries: 3, wait: clock().wait }), /HTTP 500/);
});

test('destroyInstance throws when DELETE answers success false every time', async () => {
  const seen = [];
  const client = createClient('k', async (url, init) => { seen.push(init.method); return res(200, { success: false, msg: 'busy' }); });
  await assert.rejects(destroyInstance(client, 7, { retries: 3, wait: clock().wait }), /refused to destroy 7/);
  assert.deepEqual(seen, ['DELETE', 'DELETE', 'DELETE']);
});

test('destroyInstance keeps polling while the instance runs, then throws', async () => {
  const c = clock();
  const seen = [];
  const client = createClient('k', async (url, init) => {
    seen.push(init.method);
    if (init.method === 'DELETE') return res(200, { success: true });
    return res(200, { instances: { actual_status: 'running' } });
  });
  await assert.rejects(destroyInstance(client, 7, { retries: 1, wait: c.wait }), /did not go away/);
  assert.equal(seen.filter(m => m === 'GET').length, 12);
  assert.ok(c.t >= 55000);
});

test('destroyInstance returns true as soon as GET reports the instance gone', async () => {
  const c = clock();
  const answers = [{ instances: { actual_status: 'running' } }, { instances: { actual_status: 'loading' } }, gone];
  let gets = 0;
  const client = createClient('k', async (url, init) => {
    if (init.method === 'DELETE') return res(200, { success: true });
    return res(200, answers[gets++]);
  });
  assert.equal(await destroyInstance(client, 7, { wait: c.wait }), true);
  assert.equal(gets, 3);
  assert.equal(c.t, 10000);
});

test('waitRunning keeps waiting while loading and times out', async () => {
  const running = { actual_status: 'running', ssh_host: 'h', ssh_port: 22 };
  let n = 0;
  const client = createClient('k', async () => res(200, { instances: n++ === 0 ? { actual_status: 'loading', ssh_host: 'h', ssh_port: 22 } : running }));
  let t = 0;
  const wait = async ms => { t += ms; };
  assert.deepEqual(await waitRunning(client, 7, { wait, now: () => t, timeoutMs: 60000 }), running);
  assert.equal(n, 2);
  const stuck = createClient('k', async () => res(200, { instances: { actual_status: 'loading' } }));
  t = 0;
  await assert.rejects(waitRunning(stuck, 7, { wait, now: () => t, timeoutMs: 30000 }), /did not reach running/);
});

test('reap destroys at once when the deadline has already passed', async () => {
  const calls = [];
  const c = clock();
  c.t = 2000;
  const client = createClient('k', async (url, init) => { calls.push(init.method); return init.method === 'GET' ? res(200, gone) : res(200, { success: true }); });
  const result = await reap(client, { id: 7, at: new Date(1000).toISOString() }, { wait: c.wait, now: c.now, state: () => null, writeStateFn: () => {} });
  assert.equal(result, 'destroyed');
  assert.deepEqual(calls, ['DELETE', 'GET']);
});

test('reap waits until the deadline then destroys', async () => {
  const c = clock();
  const calls = [];
  const client = createClient('k', async (url, init) => { calls.push({ t: c.t, method: init.method }); return init.method === 'GET' ? res(200, gone) : res(200, { success: true }); });
  const result = await reap(client, { id: 7, at: new Date(60000).toISOString() }, { wait: c.wait, now: c.now, state: () => null, writeStateFn: () => {} });
  assert.equal(result, 'destroyed');
  assert.deepEqual(calls, [{ t: 60000, method: 'DELETE' }, { t: 60000, method: 'GET' }]);
});

test('reap returns gone when the state file says this instance was destroyed by hand', async () => {
  const calls = [];
  const client = createClient('k', async () => { calls.push(1); return res(200, {}); });
  const result = await reap(client, { id: 7, at: new Date(60000).toISOString() }, { wait: clock().wait, now: () => 0, state: () => ({ instanceId: 7, destroyedAt: 'x' }), writeStateFn: () => {} });
  assert.equal(result, 'gone');
  assert.equal(calls.length, 0);
});

test('reap ignores a destroyedAt that belongs to a different instance', async () => {
  const c = clock();
  const writes = [];
  const client = createClient('k', async (url, init) => (init.method === 'GET' ? res(200, gone) : res(200, { success: true })));
  const result = await reap(client, { id: 7, at: new Date(60000).toISOString() }, { wait: c.wait, now: c.now, state: () => ({ instanceId: 99, destroyedAt: 'x' }), writeStateFn: s => writes.push(s) });
  assert.equal(result, 'destroyed');
  assert.equal(c.t, 60000);
  assert.equal(writes.length, 0);
});

test('reap writes a heartbeat for its own instance while waiting', async () => {
  const c = clock();
  const writes = [];
  const client = createClient('k', async (url, init) => (init.method === 'GET' ? res(200, gone) : res(200, { success: true })));
  await reap(client, { id: 7, at: new Date(60000).toISOString() }, { wait: c.wait, now: c.now, state: () => ({ instanceId: 7 }), writeStateFn: s => writes.push(s) });
  assert.deepEqual(writes.map(w => w.heartbeatAt), ['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:30.000Z']);
});

test('reap retries failed destroy rounds 30 s apart and succeeds on a later round', async () => {
  const c = clock();
  let failing = 10;
  const logs = [];
  const seen = [];
  const client = createClient('k', async (url, init) => {
    seen.push(init.method);
    if (init.method === 'GET') return res(200, gone);
    if (failing-- > 0) return res(500, 'api down');
    return res(200, { success: true });
  });
  const result = await reap(client, { id: 7, at: new Date(60000).toISOString() }, { wait: c.wait, now: c.now, log: m => logs.push(m), state: () => null, writeStateFn: () => {} });
  assert.equal(result, 'destroyed');
  assert.equal(logs.filter(m => /failed/.test(m)).length, 2);
  assert.equal(seen.filter(m => m === 'DELETE').length, 11);
  assert.ok(c.t >= 120000);
});

test('reap gives up with an error only after 60 minutes of failed rounds', async () => {
  const c = clock();
  let rounds = 0;
  const client = createClient('k', async () => res(500, 'api down'));
  await assert.rejects(reap(client, { id: 7, at: new Date(0).toISOString() }, { wait: c.wait, now: c.now, log: m => { if (/destroy round/.test(m)) rounds += 1; }, state: () => null, writeStateFn: () => {} }), /HTTP 500/);
  assert.ok(c.t >= 60 * 60000);
  assert.ok(rounds >= 90);
});

test('reap keeps waiting through API errors and still destroys at the deadline', async () => {
  const c = clock();
  const calls = [];
  const client = createClient('k', async (url, init) => {
    if (c.t < 60000) throw new Error('network down');
    calls.push({ t: c.t, method: init.method });
    return init.method === 'GET' ? res(200, gone) : res(200, { success: true });
  });
  const result = await reap(client, { id: 7, at: new Date(60000).toISOString() }, { wait: c.wait, now: c.now, state: () => null, writeStateFn: () => {} });
  assert.equal(result, 'destroyed');
  assert.deepEqual(calls, [{ t: 60000, method: 'DELETE' }, { t: 60000, method: 'GET' }]);
});

test('writeState and readState round-trip in a temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-test-'));
  const file = path.join(dir, 'nested', 'state.json');
  assert.equal(readState(file), null);
  writeState({ instanceId: 7 }, file);
  assert.deepEqual(readState(file), { instanceId: 7 });
  fs.rmSync(dir, { recursive: true, force: true });
});
