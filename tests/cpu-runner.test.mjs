// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBurstScorecard, idleSlotPercentFromWaves } from '../tools/burst-scorecard.mjs';
import { runCpuRunnerJob } from '../tools/cpu-runner.mjs';

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

const sleepMs = (ms) =>
  `node -e "import('node:timers/promises').then(({setTimeout})=>setTimeout(${ms}))"`;

test('runCpuRunnerJob records pass and duration for passing ticket tests and e2e', async () => {
  const result = await runCpuRunnerJob({
    ticketTestCommand: sleepMs(40),
    e2eSuiteCommand: sleepMs(40),
  });
  assert.equal(result.ticketTests.status, 'pass');
  assert.equal(result.ticketTests.exitCode, 0);
  assert.ok(result.ticketTests.durationMs >= 35);
  assert.equal(result.e2eSuite.status, 'pass');
  assert.equal(result.e2eSuite.exitCode, 0);
  assert.ok(result.e2eSuite.durationMs >= 35);
  assert.ok(result.completedAt);
});

test('runCpuRunnerJob still runs e2e when ticket tests fail', async () => {
  const marker = `cpu-runner-e2e-${Date.now()}.marker`;
  const result = await runCpuRunnerJob({
    ticketTestCommand: 'exit 1',
    e2eSuiteCommand: `touch ${marker} && exit 0`,
  });
  assert.equal(result.ticketTests.status, 'fail');
  assert.notEqual(result.ticketTests.exitCode, 0);
  assert.equal(result.e2eSuite.status, 'pass');
  assert.equal(result.e2eSuite.exitCode, 0);
  assert.ok(result.e2eSuite.durationMs >= 0);
  const { unlinkSync, existsSync } = await import('node:fs');
  if (existsSync(marker)) unlinkSync(marker);
});

test('runCpuRunnerJob uses elapsed time, not a fixed duration', async () => {
  const SHORT_SLEEP_MS = 10;
  const LONG_SLEEP_MS = 500;
  const configuredGap = LONG_SLEEP_MS - SHORT_SLEEP_MS;
  const short = await runCpuRunnerJob({
    ticketTestCommand: sleepMs(SHORT_SLEEP_MS),
    e2eSuiteCommand: 'exit 0',
  });
  const long = await runCpuRunnerJob({
    ticketTestCommand: sleepMs(LONG_SLEEP_MS),
    e2eSuiteCommand: 'exit 0',
  });
  const shortDur = short.ticketTests.durationMs;
  const longDur = long.ticketTests.durationMs;
  assert.notEqual(shortDur, longDur);
  assert.ok(
    longDur >= shortDur * 3,
    `expected long elapsed (${longDur}ms) >= 3× short (${shortDur}ms)`,
  );
  assert.ok(
    longDur - shortDur >= configuredGap * 0.4,
    `expected elapsed gap ≥ 40% of configured ${configuredGap}ms, got ${longDur - shortDur}ms`,
  );
});
