import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSharedQueue } from '../tools/self-manage/shared-queue.mjs';

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

async function syncAll(queues) {
  for (const q of queues) {
    await q.sync();
  }
  for (const q of queues) {
    await q.sync();
  }
}

describe('self-manage shared queue', () => {
  it('two machines racing the same ticket converge to one lease holder', async () => {
    const bus = createMemoryBus();
    let t = 1_000_000;
    const now = () => t;

    const a = createSharedQueue({ machine: 'machine-a', transport: bus.transportFor('machine-a'), now });
    const b = createSharedQueue({ machine: 'machine-b', transport: bus.transportFor('machine-b'), now });

    a.enqueue('T-race');
    await syncAll([a, b]);

    const leaseA = a.claim('T-race', 'worker-1');
    const leaseB = b.claim('T-race', 'worker-2');
    await syncAll([a, b]);

    const merged = a.list().find((r) => r.ticketId === 'T-race');
    assert.ok(merged?.lease, 'exactly one live lease after sync');
    const winner = merged.lease.holder;

    const loser = winner.startsWith('machine-a/') ? b : a;
    const winnerQueue = winner.startsWith('machine-a/') ? a : b;

    assert.deepEqual(winnerQueue.claim('T-race', winner.split('/')[1]).holder, winner);

    assert.throws(
      () => loser.claim('T-race', 'worker-x'),
      (err) => err.message === `held by ${winner}`,
    );

    assert.equal(leaseA.fencingToken > 0 || leaseB.fencingToken > 0, true);
    assert.equal(merged.lease.ticketId, 'T-race');
    assert.match(merged.lease.expiry, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('stale lease from a dead peer does not block a fresh claim after sync', async () => {
    const bus = createMemoryBus();
    let t = 2_000_000;
    const now = () => t;

    const dead = createSharedQueue({ machine: 'machine-dead', transport: bus.transportFor('machine-dead'), now });
    const live = createSharedQueue({ machine: 'machine-live', transport: bus.transportFor('machine-live'), now });

    dead.enqueue('T-stale');
    await syncAll([dead, live]);
    // Dead holds a lease locally but never publishes it; live must not deadlock.
    dead.claim('T-stale', 'ghost');

    const lease = live.claim('T-stale', 'fresh');
    await syncAll([live, dead]);

    assert.equal(lease.holder, 'machine-live/fresh');
    assert.throws(
      () => dead.claim('T-stale', 'ghost'),
      (err) => err.message === 'held by machine-live/fresh',
    );
  });

  it('two machines claiming different tickets both succeed', async () => {
    const bus = createMemoryBus();
    const now = () => 3_000_000;

    const a = createSharedQueue({ machine: 'machine-a', transport: bus.transportFor('machine-a'), now });
    const b = createSharedQueue({ machine: 'machine-b', transport: bus.transportFor('machine-b'), now });

    a.enqueue('T-one');
    b.enqueue('T-two');
    await syncAll([a, b]);

    const leaseOne = a.claim('T-one', 'w-a');
    const leaseTwo = b.claim('T-two', 'w-b');
    await syncAll([a, b]);

    assert.equal(leaseOne.holder, 'machine-a/w-a');
    assert.equal(leaseTwo.holder, 'machine-b/w-b');
    assert.equal(a.depth(), 0);
    assert.equal(b.depth(), 0);

    const onA = a.list().find((r) => r.ticketId === 'T-two');
    const onB = b.list().find((r) => r.ticketId === 'T-one');
    assert.equal(onA?.lease?.holder, 'machine-b/w-b');
    assert.equal(onB?.lease?.holder, 'machine-a/w-a');
  });
});
