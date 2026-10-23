// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  claim,
  renew,
  release,
  sweepExpiredLeases,
  readLeases,
  DEFAULT_LEASE_TTL_MS,
} from '../tools/ledger-lease.mjs';
import { createLedger, readLedger, writeLedger } from '../tools/tickets.mjs';

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lease-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

const humanTicket = (id, status = 'ready') => ({
  id,
  title: 'lease test',
  type: 'human',
  scopeRefs: [],
  size: 'S',
  risk: 'low',
  status,
  steps: ['do work'],
});

async function seed(root, { id = 'T-9001', status = 'ready' } = {}) {
  const ledger = createLedger({ tickets: [humanTicket(id, status)] });
  await writeLedger(root, ledger);
  return id;
}

test('claim, renew, and release a lease with fencing tokens', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  const first = await claim(root, id, 'node-a', { now: t0, leaseTtlMs: 60_000 });
  assert.equal(first.fencingToken, 1);
  assert.equal(first.holderId, 'node-a');
  let ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'running');

  const renewed = await renew(root, id, first.fencingToken, { now: t0 + 1000, leaseTtlMs: 120_000 });
  assert.equal(renewed.fencingToken, 1);
  assert.equal(Date.parse(renewed.expiresAt), t0 + 1000 + 120_000);

  await release(root, id, first.fencingToken, { now: t0 + 2000 });
  ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'ready');
  const store = await readLeases(root);
  assert.equal(store.leases[id], undefined);
});

test('claim rejects an active lease on the same ticket', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  await claim(root, id, 'node-a', { now: t0, leaseTtlMs: 60_000 });
  await assert.rejects(
    () => claim(root, id, 'node-b', { now: t0 + 1000, leaseTtlMs: 60_000 }),
    err => err.code === 'lease-held',
  );
});

test('claim after expiry issues a strictly greater fencing token', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  const ttl = 10_000;
  const first = await claim(root, id, 'node-a', { now: t0, leaseTtlMs: ttl });
  const second = await claim(root, id, 'node-b', { now: t0 + ttl + 1, leaseTtlMs: ttl });
  assert.ok(second.fencingToken > first.fencingToken);
});

test('renew rejects a stale fencing token', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  const leased = await claim(root, id, 'node-a', { now: t0, leaseTtlMs: 60_000 });
  await assert.rejects(
    () => renew(root, id, leased.fencingToken + 1, { now: t0 + 1000 }),
    err => err.code === 'lease-stale-token',
  );
});

test('max fencing token survives claim, release, and re-claim', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  const first = await claim(root, id, 'node-a', { now: t0, leaseTtlMs: 60_000 });
  await release(root, id, first.fencingToken, { now: t0 + 1000 });
  const second = await claim(root, id, 'node-b', { now: t0 + 2000, leaseTtlMs: 60_000 });
  assert.ok(second.fencingToken > first.fencingToken);
  await assert.rejects(
    () => renew(root, id, first.fencingToken, { now: t0 + 3000, leaseTtlMs: 60_000 }),
    err => err.code === 'lease-stale-token',
  );
});

test('sweepExpiredLeases returns running tickets to ready', async t => {
  const root = await tmp(t);
  const id = await seed(root, { status: 'ready' });
  const t0 = Date.now();
  const ttl = 5_000;
  await claim(root, id, 'node-a', { now: t0, leaseTtlMs: ttl });
  const result = await sweepExpiredLeases(root, { now: t0 + ttl + 1 });
  assert.deepEqual(result.swept, [id]);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'ready');
  const store = await readLeases(root);
  assert.equal(store.leases[id], undefined);
});

test('sweepExpiredLeases with nothing expired is a no-op', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  await claim(root, id, 'node-a', { now: t0, leaseTtlMs: DEFAULT_LEASE_TTL_MS });
  const result = await sweepExpiredLeases(root, { now: t0 + 1000 });
  assert.deepEqual(result.swept, []);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'running');
});
