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
  leasesPath,
  DEFAULT_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  validateLeaseStore,
  issueToken,
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

async function writeCorruptLeases(root, store) {
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(leasesPath(root), JSON.stringify(store));
}

test('corrupt leases.json rejects claim, renew, and release with leases-corrupt', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  const leased = await claim(root, id, 'node-a', { now: t0, leaseTtlMs: 60_000 });

  await writeCorruptLeases(root, {
    version: 2,
    leases: {},
    maxTokenByTicket: {},
  });
  await assert.rejects(() => claim(root, id, 'node-b', { now: t0 + 1, leaseTtlMs: 60_000 }), err => err.code === 'leases-corrupt');
  await assert.rejects(() => renew(root, id, leased.fencingToken, { now: t0 + 1 }), err => err.code === 'leases-corrupt');
  await assert.rejects(() => release(root, id, leased.fencingToken, { now: t0 + 1 }), err => err.code === 'leases-corrupt');

  await writeCorruptLeases(root, {
    version: 1,
    leases: {},
    maxTokenByTicket: { [id]: '5' },
  });
  await assert.rejects(() => claim(root, id, 'node-b', { now: t0 + 1, leaseTtlMs: 60_000 }), err => err.code === 'leases-corrupt');

  await writeCorruptLeases(root, {
    version: 1,
    leases: {
      [id]: { ticketId: id, holderId: 'node-a', fencingToken: 1 },
    },
    maxTokenByTicket: { [id]: 1 },
  });
  await assert.rejects(() => renew(root, id, 1, { now: t0 + 1, leaseTtlMs: 60_000 }), err => err.code === 'leases-corrupt');
});

test('claim rejects invalid holderId and leaseTtlMs', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  await assert.rejects(() => claim(root, id, '', { now: t0, leaseTtlMs: 60_000 }), err => err.code === 'invalid-holder-id');
  await assert.rejects(() => claim(root, id, 'bad id', { now: t0, leaseTtlMs: 60_000 }), err => err.code === 'invalid-holder-id');
  await assert.rejects(() => claim(root, id, 'node-a', { now: t0, leaseTtlMs: 0 }), err => err.code === 'invalid-lease-ttl');
  await assert.rejects(() => claim(root, id, 'node-a', { now: t0, leaseTtlMs: 1.5 }), err => err.code === 'invalid-lease-ttl');
});

const validLease = (ticketId, fencingToken, expiresAt) => ({
  ticketId,
  holderId: 'node-a',
  fencingToken,
  expiresAt,
});

test('validateLeaseStore rejects lease fencingToken above maxTokenByTicket', () => {
  const id = 'T-9001';
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  assert.throws(
    () =>
      validateLeaseStore({
        version: 1,
        leases: { [id]: validLease(id, 5, expiresAt) },
        maxTokenByTicket: { [id]: 2 },
      }),
    err => err.code === 'leases-corrupt',
  );
  assert.throws(
    () =>
      validateLeaseStore({
        version: 1,
        leases: { [id]: validLease(id, 3, expiresAt) },
        maxTokenByTicket: {},
      }),
    err => err.code === 'leases-corrupt',
  );
});

test('issueToken advances past lease fencingToken when maxTokenByTicket lags', () => {
  const id = 'T-9001';
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const store = {
    version: 1,
    leases: { [id]: validLease(id, 5, expiresAt) },
    maxTokenByTicket: { [id]: 2 },
  };
  const token = issueToken(store, id);
  assert.equal(token, 6);
  assert.equal(store.maxTokenByTicket[id], 6);
});

test('claim renew release and sweep reject invalid now and oversized leaseTtlMs', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  const leased = await claim(root, id, 'node-a', { now: t0, leaseTtlMs: 60_000 });
  const overTtl = MAX_LEASE_TTL_MS + 1;

  for (const fn of [
    () => claim(root, id, 'node-b', { now: NaN, leaseTtlMs: 60_000 }),
    () => claim(root, id, 'node-b', { now: t0, leaseTtlMs: overTtl }),
    () => renew(root, id, leased.fencingToken, { now: Infinity, leaseTtlMs: 60_000 }),
    () => renew(root, id, leased.fencingToken, { now: t0, leaseTtlMs: overTtl }),
    () => release(root, id, leased.fencingToken, { now: 'bad' }),
    () => sweepExpiredLeases(root, { now: null }),
  ]) {
    await assert.rejects(fn, err => err.code === 'invalid-now' || err.code === 'invalid-lease-ttl');
  }
});

test('sweepExpiredLeases removes active lease when ticket is missing from ledger', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const orphanId = 'T-orphan';
  const t0 = Date.now();
  const ttl = 60_000;
  await claim(root, id, 'node-a', { now: t0, leaseTtlMs: ttl });

  const store = await readLeases(root);
  store.leases[orphanId] = validLease(orphanId, 1, new Date(t0 + ttl).toISOString());
  store.maxTokenByTicket[orphanId] = 1;
  await writeCorruptLeases(root, store);

  const result = await sweepExpiredLeases(root, { now: t0 + 1000 });
  assert.ok(result.swept.includes(orphanId));
  const after = await readLeases(root);
  assert.equal(after.leases[orphanId], undefined);
  assert.ok(after.leases[id]);
});

test('sweepExpiredLeases reconciles lease and ticket status mismatches', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  const ttl = 60_000;
  await claim(root, id, 'node-a', { now: t0, leaseTtlMs: ttl });

  let ledger = await readLedger(root);
  ledger.tickets[0].status = 'done';
  await writeLedger(root, ledger);
  await sweepExpiredLeases(root, { now: t0 + 1000 });
  const store = await readLeases(root);
  assert.equal(store.leases[id], undefined);

  const root2 = await tmp(t);
  const id2 = await seed(root2, { status: 'running' });
  await sweepExpiredLeases(root2, { now: t0 });
  ledger = await readLedger(root2);
  assert.equal(ledger.tickets[0].status, 'ready');
});
