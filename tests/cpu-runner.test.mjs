// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBurstScorecard, idleSlotPercentFromWaves } from '../tools/burst-scorecard.mjs';

test('idleSlotPercentFromWaves matches wave idle share', () => {
  const pct = idleSlotPercentFromWaves([
    { slots: 10, readyTickets: ['a', 'b', 'c', 'd', 'e'] },
    { slots: 4, readyTickets: ['x', 'y', 'z', 'w'] },
  ]);
  assert.equal(pct, 35.7);
});

test('buildBurstScorecard summarizes median, mean, and wave-derived idle percent', () => {
  const before = {
    readyToMergedMs: [10_000, 12_000, 14_000],
    waves: [{ slots: 10, readyTickets: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
  };
  const after = {
    readyToMergedMs: [4_000, 5_000, 6_000],
    waves: [{ slots: 10, readyTickets: ['a', 'b', 'c', 'd', 'e'] }],
  };
  const card = buildBurstScorecard(before, after);
  assert.equal(card.before.readyToMergedMs.median, 12_000);
  assert.equal(card.before.readyToMergedMs.mean, 12_000);
  assert.equal(card.before.idleSlotPct, 30);
  assert.equal(card.after.readyToMergedMs.median, 5_000);
  assert.equal(card.after.idleSlotPct, 50);
});

test('buildBurstScorecard improved case uses lower duration and lower idle', () => {
  const before = {
    readyToMergedMs: [20_000, 24_000, 28_000],
    idleSlotPct: 60,
  };
  const after = {
    readyToMergedMs: [8_000, 10_000, 12_000],
    idleSlotPct: 25,
  };
  const card = buildBurstScorecard(before, after);
  assert.equal(card.improved, true);
  assert.ok(card.after.readyToMergedMs.median < card.before.readyToMergedMs.median);
  assert.ok(card.after.idleSlotPct < card.before.idleSlotPct);
});

test('buildBurstScorecard reports not improved on regression', () => {
  const before = {
    readyToMergedMs: [5_000, 6_000, 7_000],
    idleSlotPct: 20,
  };
  const after = {
    readyToMergedMs: [15_000, 16_000, 17_000],
    idleSlotPct: 45,
  };
  assert.equal(buildBurstScorecard(before, after).improved, false);
});

test('buildBurstScorecard reports not improved when metrics are unchanged', () => {
  const samples = {
    readyToMergedMs: [9_000, 10_000, 11_000],
    idleSlotPct: 33.3,
  };
  assert.equal(buildBurstScorecard(samples, { ...samples }).improved, false);
});

test('buildBurstScorecard reports not improved when only duration improves', () => {
  const before = {
    readyToMergedMs: [20_000, 22_000, 24_000],
    idleSlotPct: 40,
  };
  const after = {
    readyToMergedMs: [8_000, 9_000, 10_000],
    idleSlotPct: 40,
  };
  assert.equal(buildBurstScorecard(before, after).improved, false);
});
