// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEASE_MS } from '../tools/cluster-queue.mjs';
import {
  isLeaseExpired,
  isReclaimableAfterExpiry,
  liveHolderFromEntry,
} from '../tools/self-manage/queue-expiry.mjs';
import { createSharedQueue } from '../tools/self-manage/shared-queue.mjs';

function createFakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

function createMirrorTransport() {
  let left = [];
  let right = [];
  return {
    left: { exchange: async (local) => { left = local; return right; } },
    right: { exchange: async (local) => { right = local; return left; } },
  };
}

async function syncPair(a, b) {
  await Promise.all([a.sync(), b.sync()]);
}

test('held lease blocks peer claim until fake clock passes LEASE_MS', async () => {
  const clock = createFakeClock();
  const mirror = createMirrorTransport();
  const crashed = createSharedQueue({
    machine: 'alpha',
    transport: mirror.left,
    now: clock.now,
  });
  const peer = createSharedQueue({
    machine: 'bravo',
    transport: mirror.right,
    now: clock.now,
  });

  const ticketId = 'T-0465-expiry';
  crashed.enqueue(ticketId);
  await syncPair(crashed, peer);

  const lease = crashed.claim(ticketId, 'w1');
  assert.equal(lease.holder, 'alpha/w1');
  assert.equal(isLeaseExpired(lease, clock.now), false);

  await syncPair(crashed, peer);

  const peerEntry = peer.list().find((e) => e.ticketId === ticketId);
  assert.equal(liveHolderFromEntry(peerEntry, clock.now), 'alpha/w1');
  assert.equal(isReclaimableAfterExpiry(peerEntry, clock.now), false);

  assert.throws(
    () => peer.claim(ticketId, 'w2'),
    (err) => err.message === 'held by alpha/w1' && err.exitCode === 1,
  );

  // Holder crashes: no renew, no further sync — only time advances.
  clock.advance(LEASE_MS + 1);

  assert.equal(isLeaseExpired({ expiry: lease.expiry }, clock.now), true);

  const stalePeerView = peer.list().find((e) => e.ticketId === ticketId);
  assert.equal(liveHolderFromEntry(stalePeerView, clock.now), null);
  assert.equal(isReclaimableAfterExpiry(stalePeerView, clock.now), true);

  const reclaimed = peer.claim(ticketId, 'w2');
  assert.equal(reclaimed.holder, 'bravo/w2');
  assert.equal(isLeaseExpired(reclaimed, clock.now), false);
});
