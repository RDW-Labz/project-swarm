// SPDX-License-Identifier: Apache-2.0
// Self-manage ticket queue: wraps cluster-queue CRDT sync + lease rules for multi-machine workers.

import { createClusterQueue } from '../cluster-queue.mjs';

/**
 * @param {import('./types.mjs').LeaseRecord | null} _
 */
function toLeaseRecord(rec, now) {
  if (!rec?.lease) return null;
  const live = rec.lease.expiresAt > now();
  if (!live) return null;
  return {
    ticketId: rec.ticket,
    holder: rec.lease.holder,
    expiry: new Date(rec.lease.expiresAt).toISOString(),
    fencingToken: rec.version,
  };
}

function findTicket(queue, ticketId) {
  return queue.list().find((r) => r.ticket === ticketId);
}

function liveHolder(rec, now) {
  if (!rec?.lease || rec.lease.expiresAt <= now()) return null;
  return rec.lease.holder;
}

/**
 * @param {object} opts
 * @param {string} opts.machine
 * @param {{ exchange: (local: unknown[]) => Promise<unknown[]> }} opts.transport
 * @param {() => number} [opts.now]
 * @param {(err: Error) => void} [opts.onSyncError]
 */
export function createSharedQueue({ machine, transport, now = () => Date.now(), onSyncError } = {}) {
  const queue = createClusterQueue({ machine, transport, now, onSyncError });
  const selfHolder = (workerId) => `${machine}/${workerId}`;

  function enqueue(ticketId) {
    queue.enqueue(ticketId);
  }

  function claim(ticketId, workerId) {
    try {
      const rec = queue.lease(ticketId, workerId);
      const lease = toLeaseRecord(rec, now);
      if (!lease) {
        const cur = findTicket(queue, ticketId);
        const who = liveHolder(cur, now) ?? 'another worker';
        const err = new Error(`held by ${who}`);
        err.exitCode = 1;
        throw err;
      }
      return lease;
    } catch (e) {
      if (e.message === 'leased elsewhere') {
        const cur = findTicket(queue, ticketId);
        const who = liveHolder(cur, now) ?? 'another worker';
        const err = new Error(`held by ${who}`);
        err.exitCode = 1;
        throw err;
      }
      throw e;
    }
  }

  function list() {
    return queue.list().map((rec) => {
      const lease = toLeaseRecord(rec, now);
      return {
        ticketId: rec.ticket,
        state: rec.state,
        ...(lease ? { lease } : {}),
      };
    });
  }

  function depth() {
    return queue.depth();
  }

  return {
    enqueue,
    claim,
    list,
    depth,
    sync: queue.sync,
    startSync: queue.startSync,
  };
}
