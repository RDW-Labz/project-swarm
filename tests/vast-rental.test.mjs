// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API, VM_IMAGE, readKey, createClient, checkOffer, createBody, deadlineAt, findOffer, destroyInstance, waitRunning, writeState, readState, reap } from '../bench/gpu-bakeoff/vast.mjs';

const res = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const noWait = async () => {};
const good = { id: 1, gpu_name: 'RTX PRO 6000 Max-Q', num_gpus: 1, vms_enabled: true, rentable: true, verification: 'verified', dph_total: 2.211 };

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

test('destroyInstance deletes and retries after failures', async () => {
  const seen = [];
  let failures = 2;
  const client = createClient('k', async (url, init) => { seen.push({ url, method: init.method }); if (failures-- > 0) return res(500, 'nope'); return res(200, {}); });
  assert.equal(await destroyInstance(client, 7, { wait: noWait }), true);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[2], { url: `${API}/instances/7/`, method: 'DELETE' });
  const always = createClient('k', async () => res(500, 'nope'));
  await assert.rejects(destroyInstance(always, 7, { retries: 3, wait: noWait }), /HTTP 500/);
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
  const client = createClient('k', async (url, init) => { calls.push(init.method); return res(200, {}); });
  const result = await reap(client, { id: 7, at: new Date(1000).toISOString() }, { wait: noWait, now: () => 2000, state: () => null });
  assert.equal(result, 'destroyed');
  assert.deepEqual(calls, ['DELETE']);
});

test('reap waits until the deadline then destroys', async () => {
  let t = 0;
  const calls = [];
  const wait = async ms => { t += ms; };
  const client = createClient('k', async (url, init) => { calls.push({ t, method: init.method }); return res(200, {}); });
  const result = await reap(client, { id: 7, at: new Date(60000).toISOString() }, { wait, now: () => t, state: () => null });
  assert.equal(result, 'destroyed');
  assert.deepEqual(calls, [{ t: 60000, method: 'DELETE' }]);
});

test('reap returns gone when the state file says destroyed by hand', async () => {
  const calls = [];
  const client = createClient('k', async () => { calls.push(1); return res(200, {}); });
  const result = await reap(client, { id: 7, at: new Date(60000).toISOString() }, { wait: noWait, now: () => 0, state: () => ({ destroyedAt: 'x' }) });
  assert.equal(result, 'gone');
  assert.equal(calls.length, 0);
});

test('reap keeps waiting through API errors and still destroys at the deadline', async () => {
  let t = 0;
  const calls = [];
  const wait = async ms => { t += ms; };
  const client = createClient('k', async (url, init) => {
    if (t < 60000) throw new Error('network down');
    calls.push({ t, method: init.method });
    return res(200, {});
  });
  const result = await reap(client, { id: 7, at: new Date(60000).toISOString() }, { wait, now: () => t, state: () => null });
  assert.equal(result, 'destroyed');
  assert.deepEqual(calls, [{ t: 60000, method: 'DELETE' }]);
});

test('writeState and readState round-trip in a temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-test-'));
  const file = path.join(dir, 'nested', 'state.json');
  assert.equal(readState(file), null);
  writeState({ instanceId: 7 }, file);
  assert.deepEqual(readState(file), { instanceId: 7 });
  fs.rmSync(dir, { recursive: true, force: true });
});
