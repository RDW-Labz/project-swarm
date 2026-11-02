// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allocateJobs,
  DEGRADED_WEIGHT,
  effectiveShares,
  normalizeLaneHealth,
} from '../tools/self-manage/reroute.mjs';

const costOrder = ['cursor', 'codex', 'claude'];

test('normalizeLaneHealth accepts monitor and legacy vocabulary', () => {
  assert.equal(normalizeLaneHealth('healthy'), 'up');
  assert.equal(normalizeLaneHealth('up'), 'up');
  assert.equal(normalizeLaneHealth('degraded'), 'degraded');
  assert.equal(normalizeLaneHealth('down'), 'down');
  assert.equal(normalizeLaneHealth('paused'), 'down');
  assert.equal(normalizeLaneHealth('mystery'), 'down');
});

test('missing health entry is treated as down', () => {
  const shares = effectiveShares({
    costOrder,
    health: { cursor: 'up', claude: 'up' },
  });
  assert.equal(shares.codex, 0);
  assert.equal(shares.cursor, 2);
  assert.equal(shares.claude, 1);
});

test('down lane share goes to cheapest healthy lane not the next pricier one', () => {
  const { allocations } = allocateJobs({
    count: 6,
    costOrder,
    health: { cursor: 'up', codex: 'down', claude: 'up' },
  });
  assert.equal(allocations.cursor, 4);
  assert.equal(allocations.codex, 0);
  assert.equal(allocations.claude, 2);
  assert.equal(allocations.cursor + allocations.claude, 6);
});

test('monitor healthy vocabulary routes like up', () => {
  const { allocations, allDown } = allocateJobs({
    count: 3,
    costOrder: ['a', 'b'],
    health: { a: 'healthy', b: 'healthy' },
  });
  assert.equal(allDown, false);
  assert.equal(allocations.a + allocations.b, 3);
});

test('paused lane is not routable and share moves to cheapest healthy', () => {
  const shares = effectiveShares({
    costOrder: ['cheap', 'pausedLane'],
    health: { cheap: 'up', pausedLane: 'paused' },
    baseShares: { cheap: 1, pausedLane: 2 },
  });
  assert.equal(shares.pausedLane, 0);
  assert.equal(shares.cheap, 3);
});

test('redistributed share to a degraded lane uses degraded weight', () => {
  const shares = effectiveShares({
    costOrder: ['cursor', 'codex'],
    health: { cursor: 'degraded', codex: 'down' },
    baseShares: { cursor: 0, codex: 2 },
  });
  assert.equal(shares.codex, 0);
  assert.equal(shares.cursor, 2 * DEGRADED_WEIGHT);
});

test('all lanes down returns zeros and allDown', () => {
  const { allocations, allDown } = allocateJobs({
    count: 5,
    costOrder,
    health: { cursor: 'down', codex: 'down', claude: 'paused' },
  });
  assert.equal(allDown, true);
  assert.equal(allocations.cursor, 0);
  assert.equal(allocations.codex, 0);
  assert.equal(allocations.claude, 0);
});

test('baseShares rejects non-finite or negative values', () => {
  assert.throws(
    () => effectiveShares({ costOrder, baseShares: { cursor: -1 } }),
    err => err.code === 'reroute-invalid',
  );
  assert.throws(
    () => effectiveShares({ costOrder, baseShares: { cursor: Number.NaN } }),
    err => err.code === 'reroute-invalid',
  );
});

test('costOrder rejects duplicate lane names', () => {
  assert.throws(
    () => effectiveShares({ costOrder: ['a', 'a'] }),
    err => err.code === 'reroute-invalid',
  );
});

test('lane named toString does not break share maps', () => {
  const lane = 'toString';
  const shares = effectiveShares({
    costOrder: [lane, 'other'],
    health: { [lane]: 'down', other: 'up' },
    baseShares: { [lane]: 1, other: 1 },
  });
  assert.equal(shares[lane], 0);
  assert.equal(shares.other, 2);
});

test('allocateJobs never assigns more than count jobs', () => {
  const { allocations } = allocateJobs({
    count: 11,
    costOrder,
    health: { cursor: 'degraded', codex: 'down', claude: 'up' },
    baseShares: { cursor: 3, codex: 5, claude: 1 },
  });
  const total = allocations.cursor + allocations.codex + allocations.claude;
  assert.equal(total, 11);
});

test('null or undefined health throws reroute-invalid', () => {
  for (const bad of [null, undefined]) {
    assert.throws(
      () => effectiveShares({ costOrder, health: bad }),
      err => err instanceof Error && err.code === 'reroute-invalid',
    );
    assert.throws(
      () => allocateJobs({ count: 1, costOrder, health: bad }),
      err => err instanceof Error && err.code === 'reroute-invalid',
    );
  }
});

test('down lane share moves to routable lane with zero base share', () => {
  const { allocations, allDown, noCapacity } = allocateJobs({
    count: 3,
    costOrder: ['a', 'b'],
    health: { a: 'up', b: 'down' },
    baseShares: { a: 0, b: 1 },
  });
  assert.equal(allDown, false);
  assert.notEqual(noCapacity, true);
  assert.equal(allocations.b, 0);
  assert.equal(allocations.a, 3);
});

test('routable lanes with zero base share yield noCapacity and no assignments', () => {
  const { allocations, allDown, noCapacity } = allocateJobs({
    count: 4,
    costOrder: ['a', 'b'],
    health: { a: 'up', b: 'healthy' },
    baseShares: { a: 0, b: 0 },
  });
  assert.equal(noCapacity, true);
  assert.equal(allDown, false);
  assert.equal(allocations.a, 0);
  assert.equal(allocations.b, 0);
});

test('stale monitor health entry is treated as down for routing', () => {
  const intervalMs = 60_000;
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const freshChecked = new Date(now - intervalMs).toISOString();
  const staleChecked = new Date(now - 3 * intervalMs).toISOString();
  const shares = effectiveShares({
    costOrder: ['cheap', 'stale', 'fresh'],
    health: {
      cheap: 'down',
      stale: { status: 'healthy', lastChecked: staleChecked },
      fresh: { status: 'healthy', lastChecked: freshChecked },
    },
    baseShares: { cheap: 0, stale: 0, fresh: 1 },
    now,
    intervalMs,
  });
  assert.equal(shares.stale, 0);
  assert.equal(shares.cheap, 0);
  assert.equal(shares.fresh, 1);
});
