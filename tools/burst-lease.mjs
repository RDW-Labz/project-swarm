// SPDX-License-Identifier: Apache-2.0
// T-0411: heartbeat-aware lease return for cloud burst runners (built on ledger-lease).
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireAutopilotLock } from './autopilot-lock.mjs';
import { claim, release, readLeases, validateHolderId, validateNow } from './ledger-lease.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

/** Missed-heartbeat threshold from burst runner contract (120 seconds). */
export const HEARTBEAT_TIMEOUT_MS = 120_000;

const RUNNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const fail = (code, message) => Object.assign(new Error(message), { code });

export const runnersPath = root => path.join(root, '.swarm', 'project', 'burst-runners.json');

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertRunnersCorrupt(message) {
  throw fail('burst-runners-corrupt', message);
}

export function validateRunnerId(runnerId) {
  if (typeof runnerId !== 'string' || !RUNNER_ID_PATTERN.test(runnerId)) {
    throw fail('invalid-runner-id', 'runnerId must be a non-empty alphanumeric string (dash/underscore allowed)');
  }
}

function validateRunnerRecord(runner, runnerId) {
  if (!isPlainObject(runner)) assertRunnersCorrupt(`runner ${runnerId} is not an object`);
  if (typeof runner.registeredAt !== 'string' || !Number.isFinite(Date.parse(runner.registeredAt))) {
    assertRunnersCorrupt(`invalid registeredAt for ${runnerId}`);
  }
  if (typeof runner.lastHeartbeatAt !== 'string' || !Number.isFinite(Date.parse(runner.lastHeartbeatAt))) {
    assertRunnersCorrupt(`invalid lastHeartbeatAt for ${runnerId}`);
  }
}

export function validateRunnersStore(store) {
  if (!isPlainObject(store)) assertRunnersCorrupt('burst runners store root is not an object');
  if (store.version !== 1) assertRunnersCorrupt('burst runners store version must be 1');
  if (!isPlainObject(store.runners)) assertRunnersCorrupt('runners must be a plain object');
  for (const [runnerId, runner] of Object.entries(store.runners)) {
    validateRunnerId(runnerId);
    validateRunnerRecord(runner, runnerId);
  }
}

export function emptyRunnersStore() {
  return { version: 1, runners: {} };
}

export async function readRunners(root) {
  let raw;
  try {
    raw = await fs.readFile(runnersPath(root), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyRunnersStore();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    assertRunnersCorrupt('burst-runners.json is not valid JSON');
  }
  validateRunnersStore(parsed);
  return parsed;
}

export async function writeRunners(root, store) {
  validateRunnersStore(store);
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'burst-runners.json');
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.burst-runners.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
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

function heartbeatStale(runner, now) {
  return now - Date.parse(runner.lastHeartbeatAt) >= HEARTBEAT_TIMEOUT_MS;
}

export async function registerRunner(root, runnerId, { now = Date.now() } = {}) {
  validateNow(now);
  validateRunnerId(runnerId);
  const releaseLock = await acquireAutopilotLock(root, { name: 'burst-runners' });
  try {
    const store = await readRunners(root);
    const at = new Date(now).toISOString();
    store.runners[runnerId] = { registeredAt: at, lastHeartbeatAt: at };
    await writeRunners(root, store);
    return { runnerId, registeredAt: at, lastHeartbeatAt: at };
  } finally {
    await releaseLock();
  }
}

export async function recordHeartbeat(root, runnerId, { now = Date.now() } = {}) {
  validateNow(now);
  validateRunnerId(runnerId);
  const releaseLock = await acquireAutopilotLock(root, { name: 'burst-runners' });
  try {
    const store = await readRunners(root);
    const runner = store.runners[runnerId];
    if (!runner) throw fail('runner-missing', `unknown burst runner ${runnerId}`);
    const at = new Date(now).toISOString();
    store.runners[runnerId] = { ...runner, lastHeartbeatAt: at };
    await writeRunners(root, store);
    return { runnerId, lastHeartbeatAt: at };
  } finally {
    await releaseLock();
  }
}

/** Claim a ticket lease on behalf of a registered cloud runner (refreshes heartbeat). */
export async function claimForRunner(root, ticketId, runnerId, options = {}) {
  validateRunnerId(runnerId);
  validateHolderId(runnerId);
  const store = await readRunners(root);
  if (!store.runners[runnerId]) {
    throw fail('runner-missing', `unknown burst runner ${runnerId}`);
  }
  const now = options.now ?? Date.now();
  await recordHeartbeat(root, runnerId, { now });
  return claim(root, ticketId, runnerId, options);
}

/**
 * Returns leases held by cloud runners that have missed heartbeats for HEARTBEAT_TIMEOUT_MS
 * back to the local ready queue (via ledger-lease release).
 */
export async function sweepStaleHeartbeats(root, { now = Date.now() } = {}) {
  validateNow(now);
  const releaseLock = await acquireAutopilotLock(root, { name: 'burst-runners' });
  try {
    const store = await readRunners(root);
    const leaseStore = await readLeases(root);
    const returned = [];

    for (const [ticketId, lease] of Object.entries(leaseStore.leases)) {
      const runner = store.runners[lease.holderId];
      if (!runner) continue;
      if (!heartbeatStale(runner, now)) continue;
      await release(root, ticketId, lease.fencingToken, { now });
      returned.push(ticketId);
    }

    return { returned };
  } finally {
    await releaseLock();
  }
}
