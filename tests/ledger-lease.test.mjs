// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLedger, writeLedger, readLedger } from '../tools/tickets.mjs';
import { withLock } from '../tools/scope-commands.mjs';
import {
  claim,
  renew,
  release,
  sweepExpiredLeases,
  readLeases,
  leasesPath,
  DEFAULT_LEASE_TTL_MS,
} from '../tools/ledger-lease.mjs';
import { acquireAutopilotLock } from '../tools/autopilot-lock.mjs';

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

const BUSY_OR_HELD = new Set(['lease-held', 'leases-running', 'scope-busy']);

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
  assert.ok(BUSY_OR_HELD.has(rejected[0].reason.code));

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

test('malformed leases.json throws lease-corrupt instead of resetting', async t => {
  const root = await project(t);
  const file = leasesPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });

  for (const body of [
    'null',
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, leases: {}, maxToken: { 'T-0172': -1 } }),
    JSON.stringify({ version: 1, leases: {}, maxToken: { 'T-0172': 'x' } }),
  ]) {
    await fs.writeFile(file, body);
    await assert.rejects(() => readLeases(root), err => err.code === 'lease-corrupt');
    await assert.rejects(() => claim(root, 'T-0172', 'node-a', { now: Date.now() }), err => err.code === 'lease-corrupt');
  }
});

test('claim issues token above lease record when maxToken was tampered lower', async t => {
  let now = Date.now();
  const root = await project(t);
  const past = new Date(now - 60_000).toISOString();
  await fs.mkdir(path.dirname(leasesPath(root)), { recursive: true });
  await fs.writeFile(leasesPath(root), JSON.stringify({
    version: 1,
    leases: {
      'T-0172': {
        ticketId: 'T-0172',
        holderId: 'old',
        fencingToken: 7,
        expiresAt: past,
      },
    },
    maxToken: { 'T-0172': 1 },
  }, null, 2));

  const claimed = await claim(root, 'T-0172', 'node-b', { now: () => now, ttlMs: 30_000 });
  assert.ok(claimed.fencingToken > 7);
  assert.equal((await readLeases(root)).maxToken['T-0172'], claimed.fencingToken);
});

test('lease claim and scope-go ticket write do not lose each other', async t => {
  const now = Date.now();
  const root = await project(t);
  const marker = `scope-touch-${randomBytes(4).toString('hex')}`;

  const [claimResult] = await Promise.all([
    claim(root, 'T-0172', 'worker', { now, ttlMs: 60_000 }),
    withLock(root, async () => {
      const ledger = await readLedger(root);
      ledger.tickets[0].title = marker;
      await writeLedger(root, ledger);
    }),
  ]);

  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].title, marker);
  assert.equal(ledger.tickets[0].status, 'running');
  assert.equal(claimResult.holderId, 'worker');
});

function scopeGoLockFile(root) {
  return path.join(root, '.swarm', 'project', 'scope-go.lock');
}

test('withLeaseLock retries leases-running contention instead of failing immediately', async t => {
  const root = await project(t);
  const hold = await acquireAutopilotLock(root, { name: 'leases' });
  const claimPromise = claim(root, 'T-0172', 'retry-worker', { now: Date.now(), ttlMs: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 50));
  await hold();
  const claimed = await claimPromise;
  assert.equal(claimed.holderId, 'retry-worker');
});

test('claim samples now after lock so long waits do not use stale expiry', async t => {
  let now = Date.now();
  const root = await project(t);
  const lock = scopeGoLockFile(root);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const hold = await fs.open(lock, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW, 0o600);

  const claimPromise = claim(root, 'T-0172', 'late-clock', {
    now: () => now,
    ttlMs: 5_000,
  });

  await new Promise(resolve => setTimeout(resolve, 40));
  now += 8_000;
  await hold.close();
  await fs.rm(lock, { force: true });

  const claimed = await claimPromise;
  const expiresMs = Date.parse(claimed.expiresAt);
  assert.ok(expiresMs > now - 1_000, 'expiresAt should reflect now sampled inside the critical section');
});
