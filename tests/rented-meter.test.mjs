// SPDX-License-Identifier: Apache-2.0
import "./_isolate-config.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRentalMeter, rentalDecision, formatRentalSummary } from '../tools/rented.mjs';

const T0 = Date.UTC(2025, 0, 1);
const H = 3600e3;
function clock() { let t = T0; return { now: () => t, adv: (h) => { t += h * H; } }; }
function meterAt(hours, hourlyUsd = 10) {
  const c = clock();
  const m = createRentalMeter({ hourlyUsd, maxHours: 4, now: c.now });
  m.open(); c.adv(hours);
  return m;
}
const CFG = { maxHoursPerRun: 4, dailyUsd: 50 };
function dec(over = {}) {
  return rentalDecision({ meter: meterAt(1), config: CFG, budget: { maxUsd: 100, lanes: { rented: { dailyUsd: 50 } } }, runUsd: 0, laneTodayUsd: 0, warnAt: 0.8, ...over });
}

test('open and close are idempotent', () => {
  const c = clock();
  const m = createRentalMeter({ hourlyUsd: 10, maxHours: 4, now: c.now });
  assert.equal(m.isOpen(), false); assert.equal(m.usd(), 0); assert.equal(m.hours(), 0);
  m.open(); c.adv(1); m.open(); c.adv(1); m.close(); c.adv(5); m.close();
  assert.equal(m.isOpen(), false);
  assert.equal(m.hours(), 2);
  assert.equal(m.usd(), 20);
  c.adv(3);
  assert.equal(m.usd(), 20);
});

test('minimum billable time applies once opened', () => {
  const c = clock();
  const m = createRentalMeter({ hourlyUsd: 24.5, maxHours: 3, now: c.now });
  m.open(); m.close();
  assert.equal(m.hours(), 0);
  assert.equal(m.usd(), 0.4083);
  const c2 = clock();
  const m2 = createRentalMeter({ hourlyUsd: 12, maxHours: 3, minBillableMinutes: 5, now: c2.now });
  m2.open(); m2.close();
  assert.equal(m2.usd(), 1);
});

test('clock going backwards never gives negative time', () => {
  const c = clock();
  const m = createRentalMeter({ hourlyUsd: 10, maxHours: 4, now: c.now });
  m.open(); c.adv(-1);
  assert.equal(m.hours(), 0);
  assert.ok(m.usd() >= 0);
  m.close();
  assert.equal(m.usd(), 0.1667);
});

test('usd is rounded to 4 decimals', () => {
  const c = clock();
  const m = createRentalMeter({ hourlyUsd: 1, maxHours: 4, now: c.now });
  m.open(); c.adv(1 + 1 / 3600);
  assert.equal(m.usd(), 1.0003);
});

test('snapshot is JSON-safe', () => {
  const c = clock();
  const m = createRentalMeter({ hourlyUsd: 10, maxHours: 4, now: c.now });
  assert.deepEqual(m.snapshot(), { open: false, startedAt: null, endedAt: null, hours: 0, usd: 0 });
  m.open(); c.adv(2); m.close();
  const s = m.snapshot();
  assert.equal(s.open, false);
  assert.equal(s.startedAt, new Date(T0).toISOString());
  assert.equal(s.endedAt, new Date(T0 + 2 * H).toISOString());
  assert.equal(s.hours, 2);
  assert.equal(s.usd, 20);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('no run USD cap refuses the job', () => {
  for (const maxUsd of [null, undefined]) {
    const d = dec({ budget: { maxUsd, lanes: { rented: { dailyUsd: 50 } } } });
    assert.equal(d.decision.reason, 'run-cap');
    assert.equal(d.decision.spent, 0);
    assert.equal(d.decision.cap, null);
    assert.equal(d.decision.message, 'spend-cap: the rented lane needs a run USD cap (--max-usd)');
  }
});

test('hours reason wins over the run cap', () => {
  const d = dec({ meter: meterAt(4), runUsd: 999, laneTodayUsd: 999 });
  assert.equal(d.decision.reason, 'rental-hours');
  assert.ok(d.decision.message.startsWith('spend-cap: rented lane open for 4.00 of 4'));
});

test('run-cap wins over lane-cap when both match', () => {
  const d = dec({ runUsd: 90, laneTodayUsd: 40 });
  assert.equal(d.decision.reason, 'run-cap');
  assert.ok(d.decision.message.startsWith('spend-cap: run spent $'));
  assert.ok(d.decision.message.includes('>= maxUsd $100'));
});

test('lane-cap reason and its fallback to config.dailyUsd', () => {
  const d = dec({ laneTodayUsd: 40 });
  assert.equal(d.decision.reason, 'lane-cap');
  assert.ok(d.decision.message.startsWith('spend-cap: lane rented spent $'));
  assert.ok(d.decision.message.includes('today >= dailyUsd $50'));
  const f = dec({ budget: { maxUsd: 100 }, laneTodayUsd: 40 });
  assert.equal(f.decision.reason, 'lane-cap');
});

test('no decision and no warning when every cap has room', () => {
  const d = dec();
  assert.equal(d.decision, null);
  assert.equal(d.warning, null);
});

test('80% warning names the run cap', () => {
  const d = dec({ runUsd: 75 });
  assert.equal(d.decision, null);
  assert.ok(d.warning.startsWith('rented lane at '));
  assert.ok(d.warning.includes('run cap'));
});

test('80% warning names the lane day cap', () => {
  const d = dec({ laneTodayUsd: 35 });
  assert.equal(d.decision, null);
  assert.ok(d.warning.includes('lane day cap'));
});

test('80% warning names the hours limit', () => {
  const d = dec({ meter: meterAt(3.5) });
  assert.equal(d.decision, null);
  assert.ok(d.warning.includes('hours limit'));
});

test('warning honours a custom warnAt', () => {
  const d = dec({ warnAt: 0.2 });
  assert.equal(d.decision, null);
  assert.ok(d.warning !== null);
  assert.ok(d.warning.includes('hours limit'));
});

test('warning picks the highest ratio', () => {
  const run = dec({ runUsd: 80, laneTodayUsd: 32.5 });
  assert.equal(run.decision, null);
  assert.ok(run.warning.includes('run cap'));
  const lane = dec({ runUsd: 75, laneTodayUsd: 35 });
  assert.equal(lane.decision, null);
  assert.ok(lane.warning.includes('lane day cap'));
});

test('formatRentalSummary for a used meter', () => {
  const c = clock();
  const m = createRentalMeter({ hourlyUsd: 24.5, maxHours: 3, now: c.now });
  m.open(); c.adv(1.25); m.close();
  assert.equal(formatRentalSummary(m, { name: 'h100-node', maxHoursPerRun: 3 }), 'rented h100-node: 1.25 h, $30.63 (limit 3 h)');
});

test('formatRentalSummary when the meter never opened', () => {
  const m = createRentalMeter({ hourlyUsd: 1, maxHours: 1, now: clock().now });
  assert.equal(formatRentalSummary(m, { name: 'h100-node', maxHoursPerRun: 3 }), 'rented h100-node: not used');
});
