// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireAutopilotLock } from './autopilot-lock.mjs';
import { readLedger, writeLedger } from './tickets.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;
/** Maximum lease duration (24 hours). Longer TTLs risk Date overflow and unbounded lock retention. */
export const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

const HOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TICKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const fail = (code, message) => Object.assign(new Error(message), { code });

export const leasesPath = root => path.join(root, '.swarm', 'project', 'leases.json');

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPositiveSafeInteger(value) {
  return Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

function assertLeasesCorrupt(message) {
  throw fail('leases-corrupt', message);
}

function validateTicketIdField(ticketId, context) {
  if (typeof ticketId !== 'string' || !TICKET_ID_PATTERN.test(ticketId)) {
    assertLeasesCorrupt(`invalid ticketId ${context}`);
  }
}

export function validateHolderId(holderId) {
  if (typeof holderId !== 'string' || !HOLDER_ID_PATTERN.test(holderId)) {
    throw fail('invalid-holder-id', 'holderId must be a non-empty alphanumeric string (dash/underscore allowed)');
  }
}

export function validateLeaseTtlMs(leaseTtlMs) {
  if (!Number.isFinite(leaseTtlMs) || !Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw fail('invalid-lease-ttl', 'leaseTtlMs must be a positive finite integer');
  }
  if (leaseTtlMs > MAX_LEASE_TTL_MS) {
    throw fail('invalid-lease-ttl', `leaseTtlMs must not exceed ${MAX_LEASE_TTL_MS} ms (24 hours)`);
  }
}

export function validateNow(now) {
  if (!Number.isFinite(now) || !Number.isInteger(now)) {
    throw fail('invalid-now', 'now must be a finite integer timestamp in milliseconds');
  }
}

function validateLeaseRecord(lease, ticketIdKey) {
  if (!isPlainObject(lease)) assertLeasesCorrupt(`lease for ${ticketIdKey} is not an object`);
  validateTicketIdField(lease.ticketId, `in lease ${ticketIdKey}`);
  if (lease.ticketId !== ticketIdKey) {
    assertLeasesCorrupt(`lease ticketId mismatch for key ${ticketIdKey}`);
  }
  if (typeof lease.holderId !== 'string' || !HOLDER_ID_PATTERN.test(lease.holderId)) {
    assertLeasesCorrupt(`invalid holderId in lease ${ticketIdKey}`);
  }
  if (!Number.isInteger(lease.fencingToken) || lease.fencingToken <= 0 || lease.fencingToken > Number.MAX_SAFE_INTEGER) {
    assertLeasesCorrupt(`invalid fencingToken in lease ${ticketIdKey}`);
  }
  if (typeof lease.expiresAt !== 'string' || !Number.isFinite(Date.parse(lease.expiresAt))) {
    assertLeasesCorrupt(`invalid expiresAt in lease ${ticketIdKey}`);
  }
}

export function validateLeaseStore(store) {
  if (!isPlainObject(store)) assertLeasesCorrupt('leases store root is not an object');
  if (store.version !== 1) assertLeasesCorrupt('leases store version must be 1');
  if (!isPlainObject(store.leases)) assertLeasesCorrupt('leases must be a plain object');
  if (!isPlainObject(store.maxTokenByTicket)) assertLeasesCorrupt('maxTokenByTicket must be a plain object');
  for (const [ticketId, token] of Object.entries(store.maxTokenByTicket)) {
    validateTicketIdField(ticketId, 'in maxTokenByTicket');
    if (!isPositiveSafeInteger(token)) {
      assertLeasesCorrupt(`maxTokenByTicket[${ticketId}] must be a positive safe integer`);
    }
  }
  for (const [ticketId, lease] of Object.entries(store.leases)) {
    validateTicketIdField(ticketId, 'in leases');
    validateLeaseRecord(lease, ticketId);
    const maxTok = store.maxTokenByTicket[ticketId];
    if (!isPositiveSafeInteger(maxTok) || maxTok < lease.fencingToken) {
      assertLeasesCorrupt(
        `maxTokenByTicket[${ticketId}] must exist and be >= lease fencingToken ${lease.fencingToken}`,
      );
    }
  }
}

export function emptyLeaseStore() {
  return { version: 1, leases: {}, maxTokenByTicket: {} };
}

export async function readLeases(root) {
  let raw;
  try {
    raw = await fs.readFile(leasesPath(root), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyLeaseStore();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    assertLeasesCorrupt('leases.json is not valid JSON');
  }
  validateLeaseStore(parsed);
  return parsed;
}

export async function writeLeases(root, store) {
  validateLeaseStore(store);
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
    await handle.close().catch(closeError => {
      console.error('[tools/ledger-lease.mjs] writeLeases handle.close:', closeError?.message ?? closeError);
    });
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

function leaseActive(lease, now) {
  return Boolean(lease?.expiresAt && Date.parse(lease.expiresAt) > now);
}

export function issueToken(store, ticketId) {
  const storedMaxToken = store.maxTokenByTicket[ticketId];
  const existingLease = store.leases[ticketId];
  const base = Math.max(storedMaxToken ?? 0, existingLease?.fencingToken ?? 0);
  const token = base + 1;
  store.maxTokenByTicket[ticketId] = token;
  return token;
}

function findTicket(ledger, ticketId) {
  const ticket = ledger?.tickets?.find(t => t.id === ticketId);
  if (!ticket) throw fail('ticket-missing', `no ticket ${ticketId}`);
  return ticket;
}

const TERMINAL_TICKET_STATUSES = new Set(['done', 'cancelled']);

// claim persists leases.json then tickets.json. If writeLedger fails after writeLeases
// succeeds, the files can disagree until a later claim/release/sweep reconciles them.
export async function claim(root, ticketId, holderId, { now = Date.now(), leaseTtlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  validateNow(now);
  validateHolderId(holderId);
  validateLeaseTtlMs(leaseTtlMs);
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
  validateNow(now);
  validateLeaseTtlMs(leaseTtlMs);
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

// release persists leases.json then tickets.json; partial failure can leave mismatched state
// until sweepExpiredLeases or another lease operation reconciles ticket status vs leases.
export async function release(root, ticketId, fencingToken, { now = Date.now() } = {}) {
  validateNow(now);
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

// Sweeps expired leases and reconciles lease/ticket drift (e.g. dual-write partial failure,
// terminal ticket status with a still-active lease, or running ticket with no active lease).
export async function sweepExpiredLeases(root, { now = Date.now() } = {}) {
  validateNow(now);
  const releaseLock = await acquireAutopilotLock(root, { name: 'leases' });
  try {
    const ledger = await readLedger(root);
    if (!ledger) throw fail('ledger-missing', 'no ticket ledger; run swarm scope split first');
    const store = await readLeases(root);
    const swept = [];
    let changed = false;

    for (const [ticketId, lease] of Object.entries(store.leases)) {
      if (!leaseActive(lease, now)) {
        delete store.leases[ticketId];
        swept.push(ticketId);
        changed = true;
        const ticket = ledger.tickets.find(t => t.id === ticketId);
        if (ticket?.status === 'running') ticket.status = 'ready';
        continue;
      }
      const ticket = ledger.tickets.find(t => t.id === ticketId);
      if (!ticket) {
        delete store.leases[ticketId];
        swept.push(ticketId);
        changed = true;
        continue;
      }
      if (TERMINAL_TICKET_STATUSES.has(ticket.status)) {
        delete store.leases[ticketId];
        swept.push(ticketId);
        changed = true;
      }
    }

    for (const ticket of ledger.tickets) {
      if (ticket.status !== 'running') continue;
      const lease = store.leases[ticket.id];
      if (!leaseActive(lease, now)) {
        ticket.status = 'ready';
        changed = true;
      }
    }

    if (!changed) return { swept: [] };
    ledger.updatedAt = new Date(now).toISOString();
    await writeLeases(root, store);
    await writeLedger(root, ledger);
    return { swept };
  } finally {
    await releaseLock();
  }
}
