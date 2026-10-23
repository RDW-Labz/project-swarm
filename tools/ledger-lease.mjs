// SPDX-License-Identifier: Apache-2.0
/**
 * Ticket work leases with monotonic fencing tokens (single machine, no network).
 *
 * Lease records live in `.swarm/project/leases.json` (sibling to `tickets.json`), keyed by ticket id.
 * Mutations use the same exclusive lockfile discipline as scope-go: `.swarm/project/leases.lock`
 * (O_CREAT|O_EXCL; stale locks older than ten minutes are removed).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';
import { readLedger, writeLedger } from './tickets.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

export const DEFAULT_LEASE_TTL_MS = 60_000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const STORE_VERSION = 1;

export const leasesPath = root => path.join(root, '.swarm', 'project', 'leases.json');
const lockPath = root => path.join(root, '.swarm', 'project', 'leases.lock');

function emptyStore() {
  return { version: STORE_VERSION, leases: {}, maxToken: {} };
}

function parseExpiresAt(expiresAt) {
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) return expiresAt;
  if (typeof expiresAt === 'string') {
    const ms = Date.parse(expiresAt);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

export function isLeaseActive(lease, nowMs) {
  if (!lease) return false;
  const exp = parseExpiresAt(lease.expiresAt);
  return Number.isFinite(exp) && exp > nowMs;
}

export async function readLeases(root) {
  try {
    const data = JSON.parse(await fs.readFile(leasesPath(root), 'utf8'));
    if (!data || typeof data !== 'object') return emptyStore();
    return {
      version: STORE_VERSION,
      leases: data.leases && typeof data.leases === 'object' ? data.leases : {},
      maxToken: data.maxToken && typeof data.maxToken === 'object' ? data.maxToken : {},
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw error;
  }
}

async function writeLeases(root, store) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'leases.json');
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.leases.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const body = {
      version: STORE_VERSION,
      leases: store.leases ?? {},
      maxToken: store.maxToken ?? {},
      updatedAt: new Date().toISOString(),
    };
    await handle.writeFile(JSON.stringify(body, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

async function withLeaseLock(root, fn) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const lock = path.join(dir, 'leases.lock');
  let handle = null;
  for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
    try {
      handle = await fs.open(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.rm(lock, { force: true });
      else throw fail('lease-busy', 'another lease mutation is in progress; try again');
    }
  }
  if (!handle) throw fail('lease-busy', 'could not take the lease lock');
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lock, { force: true });
  }
}

function nextFencingToken(store, ticketId) {
  const prev = Number(store.maxToken?.[ticketId] ?? 0);
  const next = (Number.isInteger(prev) && prev >= 0 ? prev : 0) + 1;
  store.maxToken[ticketId] = next;
  return next;
}

function assertHolderId(holderId) {
  if (typeof holderId !== 'string' || !holderId.trim() || holderId.length > 200) {
    throw fail('lease-invalid', 'holderId must be a non-empty string of at most 200 characters');
  }
  return holderId.trim();
}

function assertTicketId(ticketId) {
  if (!/^T-[0-9]{4,}$/.test(ticketId ?? '')) throw fail('lease-invalid', `bad ticket id: ${ticketId}`);
}

async function loadLedgerTicket(root, ticketId) {
  const ledger = await readLedger(root);
  if (!ledger) throw fail('ledger-missing', 'no ticket ledger; run swarm scope split first');
  const ticket = ledger.tickets?.find(t => t.id === ticketId);
  if (!ticket) throw fail('ticket-missing', `no ticket ${ticketId}`);
  return { ledger, ticket };
}

function activeLeaseFor(store, ticketId, nowMs) {
  const lease = store.leases?.[ticketId];
  return isLeaseActive(lease, nowMs) ? lease : null;
}

function setTicketReady(ledger, ticketId, nowMs) {
  const ticket = ledger.tickets.find(t => t.id === ticketId);
  if (ticket && ticket.status === 'running') ticket.status = 'ready';
  ledger.updatedAt = new Date(nowMs).toISOString();
}

function setTicketRunning(ledger, ticketId, nowMs) {
  const ticket = ledger.tickets.find(t => t.id === ticketId);
  if (!ticket) return;
  if (ticket.status === 'ready') ticket.status = 'running';
  ledger.updatedAt = new Date(nowMs).toISOString();
}

/**
 * Claim a lease on ticketId for holderId. Rejects when an unexpired lease exists.
 * On success returns a new fencing token strictly greater than any prior token for this ticket.
 */
export async function claim(root, ticketId, holderId, { now = Date.now, ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  assertTicketId(ticketId);
  const holder = assertHolderId(holderId);
  const nowMs = typeof now === 'function' ? now() : now;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_LEASE_TTL_MS;

  return withLeaseLock(root, async () => {
    const store = await readLeases(root);
    const active = activeLeaseFor(store, ticketId, nowMs);
    if (active) throw fail('lease-held', `${ticketId} is leased to ${active.holderId} until ${active.expiresAt}`);

    const { ledger, ticket } = await loadLedgerTicket(root, ticketId);
    if (!['ready', 'running'].includes(ticket.status)) {
      throw fail('lease-not-claimable', `${ticketId} is ${ticket.status}: only ready or running tickets can be leased`);
    }

    const fencingToken = nextFencingToken(store, ticketId);
    const expiresAt = new Date(nowMs + ttl).toISOString();
    store.leases[ticketId] = { ticketId, holderId: holder, fencingToken, expiresAt };
    setTicketRunning(ledger, ticketId, nowMs);

    await writeLeases(root, store);
    await writeLedger(root, ledger);
    return { ticketId, holderId: holder, fencingToken, expiresAt };
  });
}

/** Extend expires-at when fencingToken matches the current active lease. */
export async function renew(root, ticketId, fencingToken, { now = Date.now, ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  assertTicketId(ticketId);
  const token = Number(fencingToken);
  if (!Number.isInteger(token) || token < 1) throw fail('lease-invalid', 'fencingToken must be a positive integer');
  const nowMs = typeof now === 'function' ? now() : now;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_LEASE_TTL_MS;

  return withLeaseLock(root, async () => {
    const store = await readLeases(root);
    const lease = store.leases?.[ticketId];
    if (!lease || !isLeaseActive(lease, nowMs)) throw fail('lease-expired', `no active lease on ${ticketId}`);
    if (lease.fencingToken !== token) throw fail('lease-stale-token', `stale fencing token for ${ticketId}`);

    const expiresAt = new Date(nowMs + ttl).toISOString();
    store.leases[ticketId] = { ...lease, expiresAt };
    await writeLeases(root, store);
    return { ticketId, fencingToken: token, expiresAt };
  });
}

/** Release the active lease when fencingToken matches; returns the ticket to ready when it was running. */
export async function release(root, ticketId, fencingToken, { now = Date.now } = {}) {
  assertTicketId(ticketId);
  const token = Number(fencingToken);
  if (!Number.isInteger(token) || token < 1) throw fail('lease-invalid', 'fencingToken must be a positive integer');
  const nowMs = typeof now === 'function' ? now() : now;

  return withLeaseLock(root, async () => {
    const store = await readLeases(root);
    const lease = store.leases?.[ticketId];
    if (!lease || !isLeaseActive(lease, nowMs)) throw fail('lease-expired', `no active lease on ${ticketId}`);
    if (lease.fencingToken !== token) throw fail('lease-stale-token', `stale fencing token for ${ticketId}`);

    delete store.leases[ticketId];
    const { ledger } = await loadLedgerTicket(root, ticketId);
    setTicketReady(ledger, ticketId, nowMs);

    await writeLeases(root, store);
    await writeLedger(root, ledger);
    return { ticketId, released: true };
  });
}

/**
 * Drop expired leases and return affected tickets to ready (no owner transition).
 * Returns { swept: ticketId[] }.
 */
export async function sweepExpiredLeases(root, { now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;

  return withLeaseLock(root, async () => {
    const store = await readLeases(root);
    const expiredIds = Object.keys(store.leases ?? {}).filter(id => {
      const lease = store.leases[id];
      return lease && !isLeaseActive(lease, nowMs);
    });
    if (!expiredIds.length) return { swept: [] };

    const ledger = await readLedger(root);
    if (!ledger) throw fail('ledger-missing', 'no ticket ledger; run swarm scope split first');

    for (const id of expiredIds) delete store.leases[id];
    for (const id of expiredIds) setTicketReady(ledger, id, nowMs);

    await writeLeases(root, store);
    await writeLedger(root, ledger);
    return { swept: expiredIds.sort() };
  });
}
