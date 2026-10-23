// SPDX-License-Identifier: Apache-2.0
/**
 * Ticket work leases with monotonic fencing tokens (single machine, no network).
 *
 * Lease records live in `.swarm/project/leases.json` (sibling to `tickets.json`), keyed by ticket id.
 * Lease mutations take the shared `leases` autopilot lock (PID liveness); ticket ledger writes use
 * `withLock` from scope-commands.mjs (same `scope-go.lock` path as the rest of the ledger tooling).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';
import { readLedger, writeLedger } from './tickets.mjs';
import { acquireAutopilotLock } from './autopilot-lock.mjs';
import { withLock } from './scope-commands.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

export const DEFAULT_LEASE_TTL_MS = 60_000;
const STORE_VERSION = 1;

export const leasesPath = root => path.join(root, '.swarm', 'project', 'leases.json');

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateLeaseStore(data) {
  if (!isPlainObject(data)) throw fail('lease-corrupt', 'leases.json must be a JSON object');
  if (data.version !== STORE_VERSION) {
    throw fail('lease-corrupt', `leases.json version must be ${STORE_VERSION}`);
  }
  if (!isPlainObject(data.leases)) throw fail('lease-corrupt', 'leases must be a plain object');
  if (!isPlainObject(data.maxToken)) throw fail('lease-corrupt', 'maxToken must be a plain object');

  for (const [ticketId, token] of Object.entries(data.maxToken)) {
    if (!Number.isInteger(token) || token < 0) {
      throw fail('lease-corrupt', `maxToken.${ticketId} must be a non-negative integer`);
    }
  }

  for (const [ticketId, lease] of Object.entries(data.leases)) {
    if (!isPlainObject(lease)) throw fail('lease-corrupt', `lease ${ticketId} must be an object`);
    if (!Number.isInteger(lease.fencingToken)) {
      throw fail('lease-corrupt', `lease ${ticketId} fencingToken must be an integer`);
    }
    if (!Number.isFinite(parseExpiresAt(lease.expiresAt))) {
      throw fail('lease-corrupt', `lease ${ticketId} expiresAt must be a parseable timestamp`);
    }
  }

  return {
    version: STORE_VERSION,
    leases: data.leases,
    maxToken: data.maxToken,
  };
}

export function isLeaseActive(lease, nowMs) {
  if (!lease) return false;
  const exp = parseExpiresAt(lease.expiresAt);
  return Number.isFinite(exp) && exp > nowMs;
}

export async function readLeases(root) {
  try {
    const data = JSON.parse(await fs.readFile(leasesPath(root), 'utf8'));
    return validateLeaseStore(data);
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    if (error.code === 'lease-corrupt') throw error;
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
  const release = await acquireAutopilotLock(root, { name: 'leases' });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Same retry discipline as `lockedUpdate` in scope-commands.mjs. */
async function withScopeLedgerLock(root, fn) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withLock(root, fn);
    } catch (error) {
      if (error.code !== 'scope-busy' || attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  return null;
}

async function withLeaseAndScopeGoLock(root, fn) {
  return withLeaseLock(root, () => withScopeLedgerLock(root, fn));
}

function nextFencingToken(store, ticketId) {
  const maxToken = store.maxToken ?? {};
  const hasMax = Object.prototype.hasOwnProperty.call(maxToken, ticketId);
  let fromMax = 0;
  if (hasMax) {
    const raw = maxToken[ticketId];
    if (!Number.isInteger(raw) || raw < 0) {
      throw fail('lease-corrupt', `maxToken.${ticketId} must be a non-negative integer`);
    }
    fromMax = raw;
  }

  const lease = store.leases?.[ticketId];
  let fromLease = 0;
  if (lease !== undefined) {
    if (!Number.isInteger(lease.fencingToken)) {
      throw fail('lease-corrupt', `lease ${ticketId} fencingToken must be an integer`);
    }
    fromLease = lease.fencingToken;
  }

  const next = Math.max(fromMax, fromLease) + 1;
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
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_LEASE_TTL_MS;

  return withLeaseAndScopeGoLock(root, async () => {
    const nowMs = typeof now === 'function' ? now() : now;
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
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_LEASE_TTL_MS;

  return withLeaseLock(root, async () => {
    const nowMs = typeof now === 'function' ? now() : now;
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

  return withLeaseAndScopeGoLock(root, async () => {
    const nowMs = typeof now === 'function' ? now() : now;
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
  return withLeaseAndScopeGoLock(root, async () => {
    const nowMs = typeof now === 'function' ? now() : now;
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
