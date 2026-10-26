// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastLaneQuotas, laneQuotaPhase, DEFAULT_LANE_WARN_RATIO } from '../tools/self-manage/quota-forecast.mjs';

/** Fixed noon UTC so hours-until-day-end is predictable (12h). */
const NOW = '2026-10-26T12:00:00.000Z';

const FORBIDDEN_OUTPUT_KEYS = new Set([
  'newCapUsd',
  'setCapUsd',
  'updateCapUsd',
  'approvedSpendUsd',
  'raiseCapUsd',
  'capMutation',
  'capUsd', // output must not echo mutable cap config for writes
]);

/**
 * @param {unknown} value
 * @param {string} path
 */
function assertNoCapMutationFields(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoCapMutationFields(value[i], `${path}[${i}]`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!FORBIDDEN_OUTPUT_KEYS.has(key), `forbidden advisory output key at ${path}.${key}`);
    assertNoCapMutationFields(child, `${path}.${key}`);
  }
}

test('laneQuotaPhase mirrors cap forecast ok/warn/at-cap/no-cap', () => {
  assert.deepEqual(laneQuotaPhase({ spentUsd: 10, projectedUsd: 50, capUsd: 100, warnRatio: 0.85 }), {
    phase: 'ok',
    headroomUsd: 50,
  });
  assert.deepEqual(laneQuotaPhase({ spentUsd: 10, projectedUsd: 86, capUsd: 100, warnRatio: 0.85 }), {
    phase: 'warn',
    headroomUsd: 14,
  });
  assert.deepEqual(laneQuotaPhase({ spentUsd: 10, projectedUsd: 100, capUsd: 100 }), {
    phase: 'at-cap',
    headroomUsd: 0,
  });
  assert.deepEqual(laneQuotaPhase({ spentUsd: 10, projectedUsd: 50, capUsd: null }), {
    phase: 'no-cap',
    headroomUsd: null,
  });
});

test('lane nearing cap within forecast window gets warn or at-cap with shift-work', () => {
  const result = forecastLaneQuotas({
    now: NOW,
    lanes: [
      {
        name: 'claude',
        spentUsd: 70,
        capUsd: 100,
        burnRatePerHour: 10,
      },
    ],
  });
  assertNoCapMutationFields(result);
  const claude = result.lanes[0];
  assert.equal(claude.name, 'claude');
  assert.ok(claude.phase === 'warn' || claude.phase === 'at-cap');
  assert.equal(claude.recommendation, 'shift-work');
  assert.ok(claude.projectedRunOutAt);
  assert.ok(result.summary.atRiskSoonest.includes('claude'));
});

test('lane with ample headroom is ok with no recommendation', () => {
  const result = forecastLaneQuotas({
    now: NOW,
    lanes: [
      {
        name: 'anthropic',
        spentUsd: 5,
        capUsd: 200,
        burnRatePerHour: 1,
      },
    ],
  });
  assertNoCapMutationFields(result);
  const lane = result.lanes[0];
  assert.equal(lane.phase, 'ok');
  assert.equal(lane.recommendation, null);
  assert.ok((lane.headroomUsd ?? 0) > 50);
  assert.equal(result.summary.atRiskSoonest.length, 0);
  assert.equal(result.summary.healthiestLane, 'anthropic');
});

test('lane without configured cap is no-cap and never shift-work', () => {
  const result = forecastLaneQuotas({
    now: NOW,
    lanes: [
      {
        name: 'openrouter',
        spentUsd: 999,
        capUsd: null,
        burnRatePerHour: 50,
      },
    ],
  });
  assertNoCapMutationFields(result);
  const lane = result.lanes[0];
  assert.equal(lane.phase, 'no-cap');
  assert.equal(lane.headroomUsd, null);
  assert.equal(lane.recommendation, null);
  assert.equal(lane.projectedRunOutAt, null);
  assert.equal(result.summary.atRiskSoonest.length, 0);
});

test('summary orders at-risk lanes soonest and suggests reroute toward healthiest ok lane', () => {
  const result = forecastLaneQuotas({
    now: NOW,
    lanes: [
      { name: 'claude', spentUsd: 92, capUsd: 100, burnRatePerHour: 20 },
      { name: 'anthropic', spentUsd: 10, capUsd: 500, burnRatePerHour: 2 },
      { name: 'openrouter', spentUsd: 0, capUsd: null, burnRatePerHour: 1 },
    ],
  });
  assertNoCapMutationFields(result);
  assert.deepEqual(result.summary.atRiskSoonest, ['claude']);
  assert.equal(result.summary.healthiestLane, 'anthropic');
  assert.ok(result.summary.suggestedReroute);
  assert.equal(result.summary.suggestedReroute.agent, 'anthropic');
  assert.equal(result.summary.suggestedReroute.routeSource, 'quota-forecast');
  assert.match(result.summary.suggestedReroute.reason, /shift work off claude/i);
});

test('burn rate can be derived from recentSamples', () => {
  const result = forecastLaneQuotas({
    now: NOW,
    lanes: [
      {
        name: 'claude',
        spentUsd: 40,
        capUsd: 100,
        recentSamples: [
          { at: '2026-10-26T10:00:00.000Z', spentUsd: 10 },
          { at: '2026-10-26T11:00:00.000Z', spentUsd: 30 },
        ],
      },
    ],
  });
  assertNoCapMutationFields(result);
  assert.ok(result.lanes[0].phase === 'warn' || result.lanes[0].phase === 'at-cap');
  assert.equal(result.lanes[0].recommendation, 'shift-work');
});

test('default warn ratio matches budget manager convention', () => {
  assert.equal(DEFAULT_LANE_WARN_RATIO, 0.85);
});

test('invalid warnRatio falls back to default so near-cap lanes still warn', () => {
  const at99 = { spentUsd: 99, projectedUsd: 99, capUsd: 100 };
  assert.deepEqual(laneQuotaPhase({ ...at99, warnRatio: NaN }), {
    phase: 'warn',
    headroomUsd: 1,
  });
  assert.deepEqual(laneQuotaPhase({ ...at99, warnRatio: 1.5 }), {
    phase: 'warn',
    headroomUsd: 1,
  });

  for (const warnRatio of [NaN, 1.5]) {
    const result = forecastLaneQuotas({
      now: NOW,
      lanes: [{ name: 'claude', spentUsd: 99, capUsd: 100, burnRatePerHour: 0, warnRatio }],
    });
    assertNoCapMutationFields(result);
    assert.equal(result.lanes[0].phase, 'warn');
    assert.notEqual(result.lanes[0].phase, 'ok');
    assert.equal(result.lanes[0].recommendation, 'shift-work');
  }
});

test('missing or non-numeric spentUsd is unknown and never healthiestLane or reroute target', () => {
  const stringSpent = forecastLaneQuotas({
    now: NOW,
    lanes: [
      { name: 'claude', spentUsd: '150', capUsd: 100, burnRatePerHour: 0 },
      { name: 'anthropic', spentUsd: 5, capUsd: 200, burnRatePerHour: 1 },
    ],
  });
  assertNoCapMutationFields(stringSpent);
  assert.equal(stringSpent.lanes[0].phase, 'unknown');
  assert.notEqual(stringSpent.lanes[0].phase, 'ok');
  assert.equal(stringSpent.summary.healthiestLane, 'anthropic');
  assert.equal(stringSpent.summary.suggestedReroute, null);

  const missingSpent = forecastLaneQuotas({
    now: NOW,
    lanes: [{ name: 'claude', capUsd: 100, burnRatePerHour: 0 }],
  });
  assert.equal(missingSpent.lanes[0].phase, 'unknown');
  assert.equal(missingSpent.summary.healthiestLane, null);
});

test('invalid capUsd never yields ok phase', () => {
  const nanCap = forecastLaneQuotas({
    now: NOW,
    lanes: [{ name: 'claude', spentUsd: 10, capUsd: NaN, burnRatePerHour: 1 }],
  });
  assertNoCapMutationFields(nanCap);
  assert.equal(nanCap.lanes[0].phase, 'unknown');
  assert.notEqual(nanCap.lanes[0].phase, 'ok');
  assert.equal(nanCap.lanes[0].headroomUsd, null);

  const stringCap = forecastLaneQuotas({
    now: NOW,
    lanes: [{ name: 'anthropic', spentUsd: 5, capUsd: '100', burnRatePerHour: 0 }],
  });
  assert.equal(stringCap.lanes[0].phase, 'unknown');
});

test('invalid now marks every lane unknown with no false ok', () => {
  const result = forecastLaneQuotas({
    now: 'not-a-date',
    lanes: [
      { name: 'claude', spentUsd: 5, capUsd: 200, burnRatePerHour: 1 },
      { name: 'anthropic', spentUsd: 90, capUsd: 100, burnRatePerHour: 50 },
    ],
  });
  assertNoCapMutationFields(result);
  for (const lane of result.lanes) {
    assert.equal(lane.phase, 'unknown');
    assert.notEqual(lane.phase, 'ok');
  }
  assert.equal(result.summary.healthiestLane, null);
  assert.equal(result.summary.suggestedReroute, null);
  assert.equal(result.summary.atRiskSoonest.length, 0);
});

test('unreliable burn history does not yield false ok; spent over cap still at-cap', () => {
  const singleSample = forecastLaneQuotas({
    now: NOW,
    lanes: [
      {
        name: 'claude',
        spentUsd: 88,
        capUsd: 100,
        recentSamples: [{ at: '2026-10-26T11:00:00.000Z', spentUsd: 80 }],
      },
    ],
  });
  assertNoCapMutationFields(singleSample);
  assert.equal(singleSample.lanes[0].phase, 'unknown');
  assert.notEqual(singleSample.lanes[0].phase, 'ok');

  const badTimestamps = forecastLaneQuotas({
    now: NOW,
    lanes: [
      {
        name: 'claude',
        spentUsd: 88,
        capUsd: 100,
        recentSamples: [
          { at: 'invalid', spentUsd: 10 },
          { at: '2026-10-26T11:00:00.000Z', spentUsd: 30 },
        ],
      },
    ],
  });
  assert.equal(badTimestamps.lanes[0].phase, 'unknown');

  const overCapNoBurn = forecastLaneQuotas({
    now: NOW,
    lanes: [{ name: 'anthropic', spentUsd: 110, capUsd: 100 }],
  });
  assert.equal(overCapNoBurn.lanes[0].phase, 'at-cap');
  assert.equal(overCapNoBurn.lanes[0].recommendation, 'shift-work');
});
