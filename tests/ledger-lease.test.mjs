// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedger, writeLedger, readLedger } from '../tools/tickets.mjs';
import {
  claim,
  renew,
  release,
  sweepExpiredLeases,
  readLeases,
  leasesPath,
  DEFAULT_LEASE_TTL_MS,
} from '../tools/ledger-lease.mjs';

const scope = { name: 'P', version: 1, hash: 'a'.repeat(64) };
const baseTicket = {
  epic: 'E',
  scopeRefs: ['R-001'],
  acceptance: ['works'],
  files: ['src/a.ts'],
  context: [],
  contracts: [],
  dependsOn: [],
  tests: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  stage: 'S1',
  type: 'build',
  title: 'Lease ticket',
};

async function project(t, status = 'ready') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-lease-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeLedger(root, createLedger({
    scope,
    tickets: [{ ...baseTicket, id: 'T-0172', status }],
  }));
  return root;
}

test('claim, renew, and release with fencing tokens', async t => {
  let now = Date.now();
  const root = await project(t);
  const first = await claim(root, 'T-0172', 'node-a', { now: () => now, ttlMs: 5_000 });
  assert.equal(first.holderId, 'node-a');
  assert.equal(first.fencingToken, 1);

  const ledgerRunning = await readLedger(root);
  assert.equal(ledgerRunning.tickets[0].status, 'running');

  now += 1_000;
  const renewed = await renew(root, 'T-0172', first.fencingToken, { now: () => now, ttlMs: 8_000 });
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(first.expiresAt));

  await release(root, 'T-0172', first.fencingToken, { now: () => now });
  const ledgerReady = await readLedger(root);
  assert.equal(ledgerReady.tickets[0].status, 'ready');
  const store = await readLeases(root);
  assert.equal(store.leases['T-0172'], undefined);
  assert.equal(store.maxToken['T-0172'], 1);
});

test('rejects claim on an active lease', async t => {
  const now = Date.now();
  const root = await project(t);
  await claim(root, 'T-0172', 'node-a', { now, ttlMs: 30_000 });
  await assert.rejects(
    () => claim(root, 'T-0172', 'node-b', { now, ttlMs: 30_000 }),
    err => err.code === 'lease-held',
  );
});

test('claim after expiry or release issues a strictly greater fencing token', async t => {
  let now = Date.now();
  const root = await project(t);
  const a = await claim(root, 'T-0172', 'node-a', { now: () => now, ttlMs: 100 });
  await release(root, 'T-0172', a.fencingToken, { now: () => now });

  const b = await claim(root, 'T-0172', 'node-b', { now: () => now, ttlMs: 100 });
  assert.ok(b.fencingToken > a.fencingToken);

  now += 200;
  const c = await claim(root, 'T-0172', 'node-c', { now: () => now, ttlMs: 100 });
  assert.ok(c.fencingToken > b.fencingToken);
});

test('renew rejects a stale fencing token', async t => {
  const now = Date.now();
  const root = await project(t);
  const held = await claim(root, 'T-0172', 'node-a', { now, ttlMs: 30_000 });
  await assert.rejects(
    () => renew(root, 'T-0172', held.fencingToken + 99, { now, ttlMs: 30_000 }),
    err => err.code === 'lease-stale-token',
  );
});

test('sweep returns expired leases to ready without owner action', async t => {
  let now = Date.now();
  const root = await project(t);
  await claim(root, 'T-0172', 'node-a', { now: () => now, ttlMs: 50 });
  assert.equal((await readLedger(root)).tickets[0].status, 'running');

  now += DEFAULT_LEASE_TTL_MS + 1;
  const swept = await sweepExpiredLeases(root, { now: () => now });
  assert.deepEqual(swept.swept, ['T-0172']);
  assert.equal((await readLedger(root)).tickets[0].status, 'ready');
  assert.equal((await readLeases(root)).leases['T-0172'], undefined);
});

test('two concurrent claims yield exactly one holder', async t => {
  const now = Date.now();
  const root = await project(t);
  const results = await Promise.allSettled([
    claim(root, 'T-0172', 'node-a', { now, ttlMs: 60_000 }),
    claim(root, 'T-0172', 'node-b', { now, ttlMs: 60_000 }),
  ]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(['lease-held', 'lease-busy'].includes(rejected[0].reason.code));

  const store = await readLeases(root);
  const active = Object.values(store.leases);
  assert.equal(active.length, 1);
  const winner = fulfilled[0].value;
  assert.equal(active[0].holderId, winner.holderId);
  assert.equal(active[0].fencingToken, winner.fencingToken);
});

test('leases persist under .swarm/project/leases.json', async t => {
  const root = await project(t);
  await claim(root, 'T-0172', 'node-a', { now: Date.now(), ttlMs: 1_000 });
  const text = await fs.readFile(leasesPath(root), 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.leases['T-0172'].holderId, 'node-a');
  assert.ok(parsed.maxToken['T-0172'] >= 1);
});
