// SPDX-License-Identifier: Apache-2.0
// T-0079 / R-018: load-timing stability under artificial load and flaky quarantine reporting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOAD_TIMING_RUNS,
  assertLoadTimingHarness,
  defaultLoadTimingChecks,
  runLoadTimingHarness,
} from '../bench/throughput/load-timing.mjs';
import {
  createCountBarrier,
  createLoadSync,
  createManualGate,
  runLoadTimingCheck,
} from '../tools/load-sync-wait.mjs';
import {
  applyFlakeReportToRunState,
  checkCountsAsPassed,
  collectQuarantinedFlaky,
  finalizeCheckWithFlakeReport,
  isQuarantinedCheckResult,
  QUARANTINED_CHECK_STATUS,
  shipAllowFlakyRerun,
  shipWarningsForQuarantinedFlaky,
} from '../tools/flake-report.mjs';
import {
  blockSilentRetryToGreen,
  finalizeRepeatAttempts,
  flakeQuarantineGuard,
  integrateCheckRunner,
  quarantineReportLine,
  silentlyRetryingToGreen,
} from '../tools/test-quarantine.mjs';

const fastLoad = { workers: 1, mainThreadIterations: 500 };

test('AC1: load-timing harness runs five consecutive passes under artificial load', async () => {
  assert.equal(LOAD_TIMING_RUNS, 5);
  const summary = await assertLoadTimingHarness(defaultLoadTimingChecks(), fastLoad);
  assert.equal(summary.runs, 5);
  assert.equal(summary.ok, true);
  assert.equal(summary.quarantined.length, 0);
  for (const report of summary.reports) {
    assert.equal(report.ok, true);
    assert.equal(report.passed, 5);
    assert.equal(report.runs, 5);
    assert.equal(report.quarantined, false);
  }
});

test('AC1: load-timing checks coordinate on events (notify/wait), not wall-clock sleep', async () => {
  const summary = await runLoadTimingHarness(
    [
      {
        name: 'event-notify-wait-under-load',
        async check({ trace }) {
          const sync = createLoadSync({ trace });
          setImmediate(() => sync.notify('done'));
          await sync.waitFor('done');
        },
      },
      {
        name: 'count-barrier-under-load',
        async check({ trace }) {
          const barrier = createCountBarrier(2, { trace });
          setImmediate(() => barrier.arrive('a'));
          setImmediate(() => barrier.arrive('b'));
          await barrier.wait();
        },
      },
      {
        name: 'manual-gate-under-load',
        async check({ trace }) {
          const gate = createManualGate({ trace });
          setImmediate(() => gate.open());
          await gate.wait();
        },
      },
    ],
    fastLoad,
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.reports.length, 3);
  for (const report of summary.reports) {
    assert.equal(report.passed, LOAD_TIMING_RUNS);
  }
});

test('AC1: first failing load-timing run quarantines without retrying remaining runs to green', async () => {
  let calls = 0;
  const report = await runLoadTimingCheck(
    'fail-on-third',
    async () => {
      calls += 1;
      if (calls === 3) throw new Error('simulated flake');
    },
    { ...fastLoad, runs: 5 },
  );
  assert.equal(report.quarantined, true);
  assert.equal(report.ok, false);
  assert.equal(report.passed, 2);
  assert.equal(report.failure?.run, 3);
  assert.equal(calls, 3, 'must not retry runs 4–5 after failure');
});

test('AC2: retry-to-green attempt series is quarantined, not passed', () => {
  const check = { name: 'unit' };
  const attempts = [
    { status: 'failed', tail: 'first fail' },
    { status: 'passed', tail: 'second pass' },
  ];
  assert.equal(silentlyRetryingToGreen(attempts), true);
  const { result, quarantined } = finalizeRepeatAttempts(check, attempts, {
    failedFile: 'tests/flaky.test.mjs',
  });
  assert.equal(quarantined, true);
  assert.equal(result.status, QUARANTINED_CHECK_STATUS);
  assert.equal(result.quarantined, true);
  assert.equal(result.quarantineReason, 'retry-to-green');
  assert.match(result.tail, /not retried to green/);
  assert.equal(checkCountsAsPassed(result), false);
});

test('AC2: integrate runner blocks silent retry when outcome is quarantined flaky', () => {
  const check = { name: 'ci-test' };
  const outcome = integrateCheckRunner(check, {
    attempts: [
      { status: 'failed', tail: 'err' },
      { status: 'passed', tail: 'green' },
    ],
    failedFile: 'tests/flaky.test.mjs',
  });
  assert.equal(outcome.quarantined, true);
  assert.equal(outcome.allowRetry, false);
  assert.equal(outcome.result.quarantineReason, 'retry-to-green');
  assert.equal(outcome.retryBlockReason, 'quarantined-flaky');
  assert.equal(outcome.result.status, QUARANTINED_CHECK_STATUS);

  const policy = blockSilentRetryToGreen({
    attempts: [],
    result: outcome.result,
    quarantined: true,
  });
  assert.equal(policy.allowRetry, false);
  assert.equal(policy.reason, 'quarantined-flaky');
});

test('AC2: flake report surfaces quarantined checks in run state and ship warnings', () => {
  const check = { name: 'manifest-check' };
  const bundle = {
    attempts: [
      { status: 'passed', tail: '' },
      { status: 'failed', tail: 'boom' },
      { status: 'passed', tail: '' },
    ],
    failedFile: 'tests/intermittent.test.mjs',
  };
  const { outcome, checkRow, quarantinedEntry } = finalizeCheckWithFlakeReport(check, bundle);
  assert.equal(outcome.quarantined, true);
  assert.ok(isQuarantinedCheckResult(checkRow));
  assert.ok(quarantinedEntry);
  assert.match(quarantinedEntry.line, /quarantined-flaky:/);
  assert.match(quarantinedEntry.line, /tests\/intermittent\.test\.mjs/);

  const state = applyFlakeReportToRunState({}, [{ check, outcome }]);
  assert.equal(state.checksPassed, false);
  assert.equal(state.flakeQuarantineReported, true);
  assert.equal(state.quarantinedFlaky.length, 1);
  assert.equal(collectQuarantinedFlaky([{ check, outcome }]).length, 1);

  const shipGate = shipAllowFlakyRerun(state.checks);
  assert.equal(shipGate.allow, false);
  assert.equal(shipGate.reason, 'quarantined-flaky');

  const warnings = shipWarningsForQuarantinedFlaky(state.checks);
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /not retried to green/);
});

test('AC2: flakeQuarantineGuard never leaves a retry-to-green series as passed', () => {
  const check = { name: 'guard-check' };
  const guarded = flakeQuarantineGuard(
    check,
    { status: 'passed', tail: '' },
    {
      attempts: [
        { status: 'failed' },
        { status: 'passed' },
      ],
      failedFile: 'tests/x.test.mjs',
      runs: 2,
    },
  );
  assert.equal(guarded.status, QUARANTINED_CHECK_STATUS);
  assert.equal(guarded.quarantined, true);
  const expectedLine = quarantineReportLine({
    checkName: 'guard-check',
    testFile: 'tests/x.test.mjs',
    reason: 'retry-to-green',
    runs: 2,
  });
  assert.match(guarded.tail, new RegExp(expectedLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
