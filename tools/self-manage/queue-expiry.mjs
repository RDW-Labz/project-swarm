// SPDX-License-Identifier: Apache-2.0
// Lease expiry helpers for self-manage workers after a holder crashes (no renew / no sync).

import { LEASE_MS } from '../cluster-queue.mjs';

export { LEASE_MS };

/**
 * @param {{ expiresAt?: number, expiry?: string } | null | undefined} lease
 * @param {() => number} now
 */
export function isLeaseExpired(lease, now) {
  if (!lease) return true;
  const expiresAt =
    typeof lease.expiresAt === 'number'
      ? lease.expiresAt
      : typeof lease.expiry === 'string'
        ? Date.parse(lease.expiry)
        : NaN;
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= now();
}

/**
 * Shared-queue list() entry: live holder, or null if unheld / lease expired.
 * @param {{ lease?: { holder: string, expiry?: string, expiresAt?: number } } | null | undefined} entry
 * @param {() => number} now
 */
export function liveHolderFromEntry(entry, now) {
  if (!entry?.lease || isLeaseExpired(entry.lease, now)) return null;
  return entry.lease.holder;
}

/**
 * After a crash the CRDT may still show `active` but shared-queue omits an expired lease.
 * @param {{ state?: string, lease?: unknown }} entry
 * @param {() => number} now
 */
export function isReclaimableAfterExpiry(entry, now) {
  if (entry?.lease && !isLeaseExpired(entry.lease, now)) return false;
  return entry?.state === 'queued' || entry?.state === 'active';
}
