// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireAutopilotLock } from './autopilot-lock.mjs';
import { readLedger, writeLedger } from './tickets.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

const fail = (code, message) => Object.assign(new Error(message), { code });

export const leasesPath = root => path.join(root, '.swarm', 'project', 'leases.json');

export function emptyLeaseStore() {
  return { version: 1, leases: {}, maxTokenByTicket: {} };
}

export async function readLeases(root) {
  try {
    return JSON.parse(await fs.readFile(leasesPath(root), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyLeaseStore();
    throw error;
  }
}

export async function writeLeases(root, store) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'leases.json');
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.leases.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(store, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

function leaseActive(lease, now) {
  return Boolean(lease?.expiresAt && Date.parse(lease.expiresAt) > now);
}

function issueToken(store, ticketId) {
  const prev = store.maxTokenByTicket[ticketId] ?? 0;
  const token = prev + 1;
  store.maxTokenByTicket[ticketId] = token;
  return token;
}

function findTicket(ledger, ticketId) {
  const ticket = ledger?.tickets?.find(t => t.id === ticketId);
  if (!ticket) throw fail('ticket-missing', `no ticket ${ticketId}`);
  return ticket;
}

export async function claim(root, ticketId, holderId, { now = Date.now(), leaseTtlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  const releaseLock = await acquireAutopilotLock(root, { name: 'leases' });
  try {
    const ledger = await readLedger(root);
    if (!ledger) throw fail('ledger-missing', 'no ticket ledger; run swarm scope split first');
    const ticket = findTicket(ledger, ticketId);
    const store = await readLeases(root);
    const existing = store.leases[ticketId];
    if (leaseActive(existing, now)) {
      throw fail('lease-held', `${ticketId} is leased until ${existing.expiresAt}`);
    }
    const fencingToken = issueToken(store, ticketId);
    const expiresAt = new Date(now + leaseTtlMs).toISOString();
    store.leases[ticketId] = { ticketId, holderId, fencingToken, expiresAt };
    if (ticket.status === 'ready') ticket.status = 'running';
    ledger.updatedAt = new Date(now).toISOString();
    await writeLeases(root, store);
    await writeLedger(root, ledger);
    return { ticketId, holderId, fencingToken, expiresAt };
  } finally {
    await releaseLock();
  }
}

export async function renew(root, ticketId, fencingToken, { now = Date.now(), leaseTtlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  const releaseLock = await acquireAutopilotLock(root, { name: 'leases' });
  try {
    const ledger = await readLedger(root);
    if (!ledger) throw fail('ledger-missing', 'no ticket ledger; run swarm scope split first');
    findTicket(ledger, ticketId);
    const store = await readLeases(root);
    const lease = store.leases[ticketId];
    if (!leaseActive(lease, now)) throw fail('lease-expired', `${ticketId} has no active lease`);
    if (lease.fencingToken !== fencingToken) throw fail('lease-stale-token', `stale fencing token for ${ticketId}`);
    const expiresAt = new Date(now + leaseTtlMs).toISOString();
    store.leases[ticketId] = { ...lease, expiresAt };
    await writeLeases(root, store);
    return { ticketId, holderId: lease.holderId, fencingToken, expiresAt };
  } finally {
    await releaseLock();
  }
}

export async function release(root, ticketId, fencingToken, { now = Date.now() } = {}) {
  const releaseLock = await acquireAutopilotLock(root, { name: 'leases' });
  try {
    const ledger = await readLedger(root);
    if (!ledger) throw fail('ledger-missing', 'no ticket ledger; run swarm scope split first');
    const ticket = findTicket(ledger, ticketId);
    const store = await readLeases(root);
    const lease = store.leases[ticketId];
    if (!lease) throw fail('lease-missing', `${ticketId} has no lease`);
    if (lease.fencingToken !== fencingToken) throw fail('lease-stale-token', `stale fencing token for ${ticketId}`);
    delete store.leases[ticketId];
    if (ticket.status === 'running') ticket.status = 'ready';
    ledger.updatedAt = new Date(now).toISOString();
    await writeLeases(root, store);
    await writeLedger(root, ledger);
    return { ticketId, released: true };
  } finally {
    await releaseLock();
  }
}

export async function sweepExpiredLeases(root, { now = Date.now() } = {}) {
  const releaseLock = await acquireAutopilotLock(root, { name: 'leases' });
  try {
    const ledger = await readLedger(root);
    if (!ledger) throw fail('ledger-missing', 'no ticket ledger; run swarm scope split first');
    const store = await readLeases(root);
    const swept = [];
    for (const [ticketId, lease] of Object.entries(store.leases)) {
      if (leaseActive(lease, now)) continue;
      delete store.leases[ticketId];
      swept.push(ticketId);
      const ticket = ledger.tickets.find(t => t.id === ticketId);
      if (ticket?.status === 'running') ticket.status = 'ready';
    }
    if (!swept.length) return { swept: [] };
    ledger.updatedAt = new Date(now).toISOString();
    await writeLeases(root, store);
    await writeLedger(root, ledger);
    return { swept };
  } finally {
    await releaseLock();
  }
}
