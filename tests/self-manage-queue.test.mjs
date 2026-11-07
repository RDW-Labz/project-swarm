import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSharedQueue } from '../tools/self-manage/shared-queue.mjs';
import {
  LEASE_MS,
  isLeaseExpired,
  isReclaimableAfterExpiry,
  liveHolderFromEntry,
} from '../tools/self-manage/queue-expiry.mjs';

/** In-memory pairwise exchange so multiple machines merge CRDT snapshots without I/O. */
function createMemoryBus() {
  const snapshots = new Map();

  function transportFor(machine) {
    return {
      async exchange(local) {
        snapshots.set(machine, local);
        const remote = [];
        for (const [peer, snap] of snapshots) {
          if (peer !== machine) remote.push(...snap);
        }
        return remote;
      },
    };
  }

  return { transportFor };
}

/** Same as createMemoryBus but can stop relaying peer snapshots (network partition). */
function createPartitionableBus() {
  const snapshots = new Map();
  let partitioned = false;

  function transportFor(machine) {
    return {
      async exchange(local) {
        snapshots.set(machine, local);
        if (partitioned) return [];
        const remote = [];
        for (const [peer, snap] of snapshots) {
          if (peer !== machine) remote.push(...snap);
        }
        return remote;
      },
    };
  }

  return {
    transportFor,
    partition() {
      partitioned = true;
    },
    heal() {
      partitioned = false;
    },
  };
}

async function syncAll(queues) {
  for (const q of queues) {
    await q.sync();
  }
  for (const q of queues) {
    await q.sync();
  }
}

describe('self-manage queue', () => {
  it('crashed holder stops syncing; peer reclaims after LEASE_MS', async () => {
    const bus = createMemoryBus();
    let t = 4_000_000;
    const now = () => t;

    const a = createSharedQueue({ machine: 'machine-a', transport: bus.transportFor('machine-a'), now });
    const b = createSharedQueue({ machine: 'machine-b', transport: bus.transportFor('machine-b'), now });

    a.enqueue('T-crash');
    await syncAll([a, b]);

    const leaseA = a.claim('T-crash', 'worker-a');
    await syncAll([a, b]);

    assert.equal(leaseA.holder, 'machine-a/worker-a');
    assert.equal(isLeaseExpired(leaseA, now), false);

    // Machine A crashes: no further sync from A.
    t += LEASE_MS + 1;
    assert.equal(isLeaseExpired(leaseA, now), true);

    const entryOnB = b.list().find((r) => r.ticketId === 'T-crash');
    assert.equal(isReclaimableAfterExpiry(entryOnB, now), true);
    assert.equal(liveHolderFromEntry(entryOnB, now), null);

    const leaseB = b.claim('T-crash', 'worker-b');
    assert.equal(leaseB.holder, 'machine-b/worker-b');
    await b.sync();

    // A comes back online and merges; must not still believe it holds the lease.
    await a.sync();
    await b.sync();

    const onA = a.list().find((r) => r.ticketId === 'T-crash');
    const onB = b.list().find((r) => r.ticketId === 'T-crash');
    assert.equal(liveHolderFromEntry(onA, now), 'machine-b/worker-b');
    assert.equal(liveHolderFromEntry(onB, now), 'machine-b/worker-b');

    assert.throws(
      () => a.claim('T-crash', 'worker-a'),
      (err) => err.message === 'held by machine-b/worker-b',
    );
  });

  it('network partition split-brain converges to one lease holder after heal', async () => {
    const bus = createPartitionableBus();
    let t = 5_000_000;
    const now = () => t;

    const a = createSharedQueue({ machine: 'machine-a', transport: bus.transportFor('machine-a'), now });
    const b = createSharedQueue({ machine: 'machine-b', transport: bus.transportFor('machine-b'), now });

    a.enqueue('T-split');
    await syncAll([a, b]);

    bus.partition();

    const leaseA = a.claim('T-split', 'worker-a');
    const leaseB = b.claim('T-split', 'worker-b');
    assert.equal(leaseA.holder, 'machine-a/worker-a');
    assert.equal(leaseB.holder, 'machine-b/worker-b');

    bus.heal();
    await syncAll([a, b]);

    const merged = a.list().find((r) => r.ticketId === 'T-split');
    assert.ok(merged?.lease, 'exactly one live lease after partition heals');
    const winner = merged.lease.holder;

    const loser = winner.startsWith('machine-a/') ? b : a;
    const winnerQueue = winner.startsWith('machine-a/') ? a : b;

    assert.deepEqual(winnerQueue.claim('T-split', winner.split('/')[1]).holder, winner);

    assert.throws(
      () => loser.claim('T-split', 'worker-x'),
      (err) => err.message === `held by ${winner}`,
    );

    const onA = a.list().find((r) => r.ticketId === 'T-split');
    const onB = b.list().find((r) => r.ticketId === 'T-split');
    assert.equal(onA?.lease?.holder, winner);
    assert.equal(onB?.lease?.holder, winner);
    assert.equal(liveHolderFromEntry(onA, now), winner);
    assert.equal(liveHolderFromEntry(onB, now), winner);
  });
});
