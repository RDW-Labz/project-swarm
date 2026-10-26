import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  computeBurstGpuGates,
  consecutiveReadyOverFreeDays,
  flatRateAllLimited,
  gpuFirstTryPassRateFromReplay,
  readyOverFreeSlotsRatio,
} from '../tools/burst-gates.mjs';
import { startBurstGpu } from '../tools/burst-gpu.mjs';
import {
  createBurstScaler,
  DEFAULT_START_SUSTAIN_MS,
  IDLE_STOP_MS,
  resolveBurstScalerAction,
} from '../tools/burst-gpu-scale.mjs';

function gate(result, name) {
  const row = result.rows.find((r) => r.name === name);
  assert.ok(row, `missing gate ${name}`);
  return row;
}

function replayResults(passCount, failFirstTry = 0) {
  const rows = [];
  for (let i = 0; i < passCount; i += 1) {
    rows.push({ status: 'pass', retries: 0 });
  }
  for (let i = 0; i < failFirstTry; i += 1) {
    rows.push({ status: 'fail', retries: 0 });
  }
  return rows;
}

describe('burst gpu gates', () => {
  test('ready-over-free-slots PASS at 3 consecutive pressure days', () => {
    const result = computeBurstGpuGates({
      pressureDailySamples: [
        { readyTickets: 2, freeSlots: 4 },
        { readyTickets: 5, freeSlots: 4 },
        { readyTickets: 6, freeSlots: 5 },
        { readyTickets: 8, freeSlots: 3 },
      ],
      flatRateRateLimited: true,
      gpuFirstTryPassRate: 0.9,
    });
    const row = gate(result, 'ready-over-free-slots');
    assert.equal(row.measured, 3);
    assert.equal(row.pass, true);
    assert.match(row.value, /3 consecutive days/);
  });

  test('ready-over-free-slots FAIL below 3 consecutive pressure days', () => {
    const result = computeBurstGpuGates({
      readyTickets: 10,
      freeSlots: 4,
      pressureDailySamples: [
        { readyTickets: 9, freeSlots: 2 },
        { readyTickets: 1, freeSlots: 5 },
      ],
      flatRateRateLimited: true,
      gpuFirstTryPassRate: 1,
    });
    const row = gate(result, 'ready-over-free-slots');
    assert.equal(row.measured, 1);
    assert.equal(row.pass, false);
    assert.match(row.value, /1 consecutive days/);
  });

  test('flat-rate-rate-limited PASS when every flat-rate lane is limited', () => {
    assert.equal(flatRateAllLimited([
      { rateLimited: true },
      { rateLimited: true },
    ]), true);
    const result = computeBurstGpuGates({
      readyOverFreeDays: 3,
      flatRateLanes: [
        { name: 'cursor', rateLimited: true },
        { name: 'codex', rateLimited: true },
      ],
      gpuFirstTryPassRate: 0.9,
    });
    const row = gate(result, 'flat-rate-rate-limited');
    assert.equal(row.pass, true);
    assert.equal(row.value, 'all flat-rate lanes limited');
  });

  test('flat-rate-rate-limited FAIL when any flat-rate lane is not limited', () => {
    const result = computeBurstGpuGates({
      readyOverFreeDays: 5,
      flatRateLanes: [
        { name: 'cursor', rateLimited: true },
        { name: 'codex', rateLimited: false },
      ],
      gpuFirstTryPassRate: 1,
    });
    const row = gate(result, 'flat-rate-rate-limited');
    assert.equal(row.pass, false);
    assert.equal(row.value, 'not all flat-rate lanes limited');
  });

  test('gpu-first-try-pass-rate PASS at 90% from benchmark replay', () => {
    assert.equal(gpuFirstTryPassRateFromReplay(replayResults(9, 1)), 0.9);
    const result = computeBurstGpuGates({
      readyOverFreeDays: 3,
      flatRateRateLimited: true,
      benchmarkReplayResults: replayResults(9, 1),
    });
    const row = gate(result, 'gpu-first-try-pass-rate');
    assert.equal(row.measured, 0.9);
    assert.equal(row.pass, true);
    assert.equal(row.value, '90.0 percent');
  });

  test('gpu-first-try-pass-rate FAIL below 90% from benchmark replay', () => {
    const result = computeBurstGpuGates({
      readyOverFreeDays: 3,
      flatRateRateLimited: true,
      benchmarkReplayResults: replayResults(7, 3),
    });
    const row = gate(result, 'gpu-first-try-pass-rate');
    assert.equal(row.measured, 0.7);
    assert.equal(row.pass, false);
    assert.equal(row.value, '70.0 percent');
  });

  test('flat-rate-rate-limited ignores stale precomputed true when lane data shows not limited', () => {
    const result = computeBurstGpuGates({
      readyOverFreeDays: 3,
      flatRateRateLimited: true,
      flatRateLanes: [
        { name: 'cursor', rateLimited: true },
        { name: 'codex', rateLimited: false },
      ],
      gpuFirstTryPassRate: 1,
    });
    const row = gate(result, 'flat-rate-rate-limited');
    assert.equal(row.pass, false);
    assert.equal(row.value, 'not all flat-rate lanes limited');
  });

  test('numeric gate inputs reject coercion from boolean, string, array, and null', () => {
    const result = computeBurstGpuGates({
      readyOverFreeDays: true,
      flatRateRateLimited: true,
      gpuFirstTryPassRate: '1',
    });
    const days = gate(result, 'ready-over-free-slots');
    assert.equal(days.pass, false);
    assert.equal(days.measured, null);
    assert.match(days.value, /missing/);

    const gpu = gate(result, 'gpu-first-try-pass-rate');
    assert.equal(gpu.pass, false);
    assert.equal(gpu.measured, null);
    assert.equal(gpu.value, 'missing');

    const withNull = computeBurstGpuGates({
      readyOverFreeDays: null,
      flatRateRateLimited: true,
      gpuFirstTryPassRate: [1],
    });
    assert.equal(gate(withNull, 'ready-over-free-slots').pass, false);
    assert.equal(gate(withNull, 'gpu-first-try-pass-rate').pass, false);
  });

  test('gpu-first-try-pass-rate display matches FAIL verdict just below threshold', () => {
    const result = computeBurstGpuGates({
      readyOverFreeDays: 3,
      flatRateRateLimited: true,
      gpuFirstTryPassRate: 0.895,
    });
    const row = gate(result, 'gpu-first-try-pass-rate');
    assert.equal(row.pass, false);
    assert.equal(row.value, '89.5 percent');
  });

  test('malformed benchmark replay rows do not throw and count as failing data', () => {
    const malformed = [
      { status: 'pass', retries: 0 },
      null,
      { status: 'pass', retries: 0 },
    ];
    assert.equal(gpuFirstTryPassRateFromReplay(malformed), 2 / 3);
    const result = computeBurstGpuGates({
      readyOverFreeDays: 3,
      flatRateRateLimited: true,
      benchmarkReplayResults: malformed,
    });
    const row = gate(result, 'gpu-first-try-pass-rate');
    assert.equal(row.pass, false);
    assert.equal(row.measured, 2 / 3);
    assert.equal(row.value, '66.6 percent');

    const nonObject = computeBurstGpuGates({
      readyOverFreeDays: 3,
      flatRateRateLimited: true,
      benchmarkReplayResults: [null, 'bad'],
    });
    assert.equal(gate(nonObject, 'gpu-first-try-pass-rate').pass, false);
    assert.equal(gate(nonObject, 'gpu-first-try-pass-rate').measured, 0);
  });

  test('three-line output order matches ready/free, rate limit, GPU pass rate', () => {
    const result = computeBurstGpuGates({
      readyOverFreeDays: 4,
      flatRateRateLimited: false,
      gpuFirstTryPassRate: 0.73,
    });
    assert.deepEqual(result.lines, [
      'gate ready-over-free-slots: 4 consecutive days PASS',
      'gate flat-rate-rate-limited: not all flat-rate lanes limited FAIL',
      'gate gpu-first-try-pass-rate: 73.0 percent FAIL',
    ]);
    assert.equal(result.pass, false);
    assert.equal(
      result.text,
      `${result.lines.join('\n')}\n`,
    );
  });

  test('pressure sample fields are not coerced for consecutiveReadyOverFreeDays', () => {
    const trailingMalformed = consecutiveReadyOverFreeDays([
      { readyTickets: 9, freeSlots: 2 },
      { readyTickets: 5, freeSlots: 4 },
      { readyTickets: null, freeSlots: 1 },
    ]);
    assert.equal(trailingMalformed, 0);

    const stringReady = consecutiveReadyOverFreeDays([
      { readyTickets: '9', freeSlots: 1 },
      { readyTickets: 8, freeSlots: 3 },
    ]);
    assert.equal(stringReady, 1);

    const booleanFree = consecutiveReadyOverFreeDays([
      { readyTickets: 10, freeSlots: true },
    ]);
    assert.equal(booleanFree, 0);
  });

  test('pressure sample fields are not coerced for readyOverFreeSlotsRatio', () => {
    assert.equal(readyOverFreeSlotsRatio(null, 4), null);
    assert.equal(readyOverFreeSlotsRatio(5, true), null);
    assert.equal(readyOverFreeSlotsRatio('9', 2), null);
    assert.equal(readyOverFreeSlotsRatio(9, 2), 4.5);
  });

  test('gpu-first-try-pass-rate 0.8999 displays below 90% and FAILs', () => {
    const result = computeBurstGpuGates({
      readyOverFreeDays: 3,
      flatRateRateLimited: true,
      gpuFirstTryPassRate: 0.8999,
    });
    const row = gate(result, 'gpu-first-try-pass-rate');
    assert.equal(row.pass, false);
    assert.equal(row.value, '89.9 percent');
    assert.notEqual(row.value, '90.0 percent');
  });

  test('consecutiveReadyOverFreeDays counts only trailing pressure days', () => {
    const days = consecutiveReadyOverFreeDays([
      { readyTickets: 9, freeSlots: 1 },
      { readyTickets: 2, freeSlots: 8 },
      { readyTickets: 5, freeSlots: 4 },
      { readyTickets: 6, freeSlots: 2 },
      { readyTickets: 7, freeSlots: 3 },
    ]);
    assert.equal(days, 3);
  });

  test('all three gates FAIL independently when each threshold is missed at once', () => {
    const result = computeBurstGpuGates({
      readyOverFreeDays: 2,
      flatRateRateLimited: false,
      gpuFirstTryPassRate: 0.5,
    });
    assert.equal(result.pass, false);

    const days = gate(result, 'ready-over-free-slots');
    assert.equal(days.measured, 2);
    assert.equal(days.pass, false);

    const flat = gate(result, 'flat-rate-rate-limited');
    assert.equal(flat.measured, false);
    assert.equal(flat.pass, false);

    const gpu = gate(result, 'gpu-first-try-pass-rate');
    assert.equal(gpu.measured, 0.5);
    assert.equal(gpu.pass, false);

    assert.deepEqual(result.lines, [
      'gate ready-over-free-slots: 2 consecutive days FAIL',
      'gate flat-rate-rate-limited: not all flat-rate lanes limited FAIL',
      'gate gpu-first-try-pass-rate: 50.0 percent FAIL',
    ]);
  });
});

function passingGateInputs(overrides = {}) {
  return {
    readyOverFreeDays: 3,
    flatRateRateLimited: true,
    gpuFirstTryPassRate: 0.9,
    ...overrides,
  };
}

describe('startBurstGpu', () => {
  test('ready-over-free-slots FAIL blocks rental and reports gates not met with measured values', async () => {
    let calls = 0;
    const result = await startBurstGpu(
      passingGateInputs({ readyOverFreeDays: 2 }),
      { sensitive: false },
      () => { calls += 1; },
    );
    assert.equal(calls, 0);
    assert.equal(result.exitCode, 1);
    assert.equal(result.message, 'gates not met');
    assert.match(result.lines.join('\n'), /2 consecutive days/);
    assert.match(result.lines.join('\n'), /FAIL/);
  });

  test('flat-rate-rate-limited FAIL blocks rental and reports gates not met', async () => {
    let calls = 0;
    const result = await startBurstGpu(
      passingGateInputs({ flatRateRateLimited: false }),
      { sensitive: false },
      () => { calls += 1; },
    );
    assert.equal(calls, 0);
    assert.equal(result.exitCode, 1);
    assert.equal(result.message, 'gates not met');
    assert.match(result.lines.join('\n'), /not all flat-rate lanes limited/);
  });

  test('gpu-first-try-pass-rate FAIL blocks rental and reports gates not met', async () => {
    let calls = 0;
    const result = await startBurstGpu(
      passingGateInputs({ gpuFirstTryPassRate: 0.5 }),
      { sensitive: false },
      () => { calls += 1; },
    );
    assert.equal(calls, 0);
    assert.equal(result.exitCode, 1);
    assert.equal(result.message, 'gates not met');
    assert.match(result.lines.join('\n'), /50\.0 percent/);
  });

  test('all three gate FAILs block rental once with gates not met and every measured line', async () => {
    let calls = 0;
    const result = await startBurstGpu(
      {
        readyOverFreeDays: 1,
        flatRateRateLimited: false,
        gpuFirstTryPassRate: 0.5,
      },
      { sensitive: false },
      () => { calls += 1; },
    );
    assert.equal(calls, 0);
    assert.equal(result.exitCode, 1);
    assert.equal(result.message, 'gates not met');
    const text = result.lines.join('\n');
    assert.match(text, /1 consecutive days FAIL/);
    assert.match(text, /not all flat-rate lanes limited FAIL/);
    assert.match(text, /50\.0 percent FAIL/);
    assert.equal(result.gates.rows.every((r) => r.pass === false), true);
  });

  test('sensitive ticket is refused on rented lane even when all gates pass', async () => {
    let calls = 0;
    const result = await startBurstGpu(
      passingGateInputs(),
      { sensitive: true },
      () => { calls += 1; },
    );
    assert.equal(calls, 0);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /not allowed on rented lane/);
  });

  test('unknown-sensitive ticket is refused even when all gates pass', async () => {
    let calls = 0;
    const result = await startBurstGpu(
      passingGateInputs(),
      { id: 'T-1' },
      () => { calls += 1; },
    );
    assert.equal(calls, 0);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /not allowed on rented lane/);
  });

  for (const ticket of [
    null,
    undefined,
    { sensitive: null },
    { sensitive: 'false' },
  ]) {
    test(`missing or non-explicit non-sensitive ticket is refused (${JSON.stringify(ticket)})`, async () => {
      let calls = 0;
      const result = await startBurstGpu(
        passingGateInputs(),
        ticket,
        () => { calls += 1; },
      );
      assert.equal(calls, 0);
      assert.equal(result.exitCode, 1);
      assert.match(result.message, /not allowed on rented lane/);
    });
  }

  test('non-sensitive ticket with passing gates invokes provision exactly once', async () => {
    let calls = 0;
    const result = await startBurstGpu(
      passingGateInputs(),
      { sensitive: false },
      async () => {
        calls += 1;
        return { session: 'ok' };
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.deepEqual(result.provisionResult, { session: 'ok' });
  });
});

function longQueueSample(now, running = false) {
  return { now, readyTickets: 10, freeSlots: 2, running };
}

function emptyQueueSample(now, running = true) {
  return { now, readyTickets: 0, freeSlots: 4, running };
}

describe('burst gpu scaler queue timing', () => {
  const limitCtx = {
    billedTodayUsd: 0,
    hourlyUsd: 1,
    settings: { machine: { usd: 100, mode: 'stop' } },
  };

  test('long queue sustains 10 minutes before start, then idle 10 minutes before stop', () => {
    const scaler = createBurstScaler();
    const t0 = 10_000_000;

    assert.equal(
      resolveBurstScalerAction(scaler, longQueueSample(t0), limitCtx).action,
      'none',
    );
    assert.equal(
      resolveBurstScalerAction(
        scaler,
        longQueueSample(t0 + DEFAULT_START_SUSTAIN_MS - 1),
        limitCtx,
      ).action,
      'none',
    );
    assert.equal(
      resolveBurstScalerAction(
        scaler,
        longQueueSample(t0 + DEFAULT_START_SUSTAIN_MS),
        limitCtx,
      ).action,
      'start',
    );

    const afterStart = t0 + DEFAULT_START_SUSTAIN_MS;
    assert.equal(
      resolveBurstScalerAction(
        scaler,
        emptyQueueSample(afterStart, true),
        { ...limitCtx, billedTodayUsd: 0.1 },
      ).action,
      'none',
    );
    assert.equal(
      resolveBurstScalerAction(
        scaler,
        emptyQueueSample(afterStart + IDLE_STOP_MS - 1, true),
        { ...limitCtx, billedTodayUsd: 0.1 },
      ).action,
      'none',
    );
    assert.equal(
      resolveBurstScalerAction(
        scaler,
        emptyQueueSample(afterStart + IDLE_STOP_MS, true),
        { ...limitCtx, billedTodayUsd: 0.1 },
      ).action,
      'stop',
    );
  });

  test('breaking a long queue resets the start sustain window', () => {
    const scaler = createBurstScaler();
    const t0 = 20_000_000;
    const almost = DEFAULT_START_SUSTAIN_MS - 60_000;

    resolveBurstScalerAction(scaler, longQueueSample(t0), limitCtx);
    resolveBurstScalerAction(scaler, longQueueSample(t0 + almost), limitCtx);
    resolveBurstScalerAction(scaler, emptyQueueSample(t0 + almost, false), limitCtx);
    const restart = t0 + almost + 120_000;
    resolveBurstScalerAction(scaler, longQueueSample(restart), limitCtx);
    assert.equal(
      resolveBurstScalerAction(
        scaler,
        longQueueSample(restart + DEFAULT_START_SUSTAIN_MS - 1),
        limitCtx,
      ).action,
      'none',
    );
    assert.equal(
      resolveBurstScalerAction(
        scaler,
        longQueueSample(restart + DEFAULT_START_SUSTAIN_MS),
        limitCtx,
      ).action,
      'start',
    );
  });
});

describe('burst gpu scaler daily limit', () => {
  const hourlyUsd = 1;
  const stopSettings = { machine: { usd: 5, mode: 'stop' } };
  const notifySettings = { machine: { usd: 5, mode: 'notify' } };
  const ceilingSettings = { machine: { usd: 5, mode: 'notify', ceilingUsd: 6 } };

  test('long-queue start is blocked in stop mode when daily limit would be exceeded', () => {
    const scaler = createBurstScaler({ startSustainMs: 0, idleStopMs: IDLE_STOP_MS });
    const t0 = 1_000_000;
    resolveBurstScalerAction(scaler, longQueueSample(t0), {
      billedTodayUsd: 4.6,
      hourlyUsd,
      settings: stopSettings,
    });
    const result = resolveBurstScalerAction(scaler, longQueueSample(t0 + 1), {
      billedTodayUsd: 4.6,
      hourlyUsd,
      settings: stopSettings,
    });
    assert.equal(result.action, 'none');
    assert.equal(result.dailyLimit.allow, false);
    assert.equal(result.dailyLimit.action, 'stop');
    assert.match(result.dailyLimit.reason, /Daily spend limit/);
  });

  test('long-queue start proceeds in notify mode but surfaces limit notice', () => {
    const scaler = createBurstScaler({ startSustainMs: 0, idleStopMs: IDLE_STOP_MS });
    const t0 = 2_000_000;
    resolveBurstScalerAction(scaler, longQueueSample(t0), {
      billedTodayUsd: 5,
      hourlyUsd,
      settings: notifySettings,
    });
    const result = resolveBurstScalerAction(scaler, longQueueSample(t0 + 1), {
      billedTodayUsd: 5,
      hourlyUsd,
      settings: notifySettings,
    });
    assert.equal(result.action, 'start');
    assert.equal(result.dailyLimit.allow, true);
    assert.ok(result.dailyLimit.notify.length > 0);
  });

  test('hard ceiling stops a running worker before idle-queue timer', () => {
    const scaler = createBurstScaler({ startSustainMs: 0, idleStopMs: IDLE_STOP_MS });
    const t0 = 3_000_000;
    const running = { now: t0, readyTickets: 8, freeSlots: 2, running: true };
    const result = resolveBurstScalerAction(scaler, running, {
      billedTodayUsd: 5.5,
      hourlyUsd,
      settings: ceilingSettings,
    });
    assert.equal(result.action, 'stop');
    assert.equal(result.dailyLimit.ceilingHit, true);
    assert.match(result.dailyLimit.reason, /hard ceiling/);
  });

  test('start and idle stop under daily limit match createBurstScaler alone', () => {
    const opts = { startSustainMs: 0, idleStopMs: 100 };
    const plain = createBurstScaler(opts);
    const limited = createBurstScaler(opts);
    const t0 = 4_000_000;
    const limitCtx = { billedTodayUsd: 0, hourlyUsd, settings: stopSettings };

    const plainStart = plain.update(longQueueSample(t0));
    const limitedStart = resolveBurstScalerAction(limited, longQueueSample(t0), limitCtx);
    assert.equal(plainStart, 'start');
    assert.equal(limitedStart.action, 'start');
    assert.equal(limitedStart.dailyLimit.allow, true);

    const t1 = t0 + 50;
    assert.equal(plain.update(emptyQueueSample(t1, true)), 'none');
    assert.equal(
      resolveBurstScalerAction(limited, emptyQueueSample(t1, true), { ...limitCtx, billedTodayUsd: 0.5 }).action,
      'none',
    );
    const t2 = t1 + 100;
    const plainStop = plain.update(emptyQueueSample(t2, true));
    const limitedStop = resolveBurstScalerAction(limited, emptyQueueSample(t2, true), {
      ...limitCtx,
      billedTodayUsd: 0.5,
    });
    assert.equal(plainStop, 'stop');
    assert.equal(limitedStop.action, 'stop');
    assert.equal(limitedStop.dailyLimit.allow, true);
  });

  test('negative hourlyUsd throws instead of allowing a start', () => {
    const scaler = createBurstScaler({ startSustainMs: 0, idleStopMs: IDLE_STOP_MS });
    const t0 = 5_000_000;
    resolveBurstScalerAction(scaler, longQueueSample(t0), {
      billedTodayUsd: 4.6,
      hourlyUsd,
      settings: stopSettings,
    });
    assert.throws(
      () => resolveBurstScalerAction(scaler, longQueueSample(t0 + 1), {
        billedTodayUsd: 4.6,
        hourlyUsd: -1,
        settings: stopSettings,
      }),
      /hourlyUsd must be a finite number/,
    );
  });

  test('invalid billedTodayUsd throws instead of coercing to zero', () => {
    const scaler = createBurstScaler({ startSustainMs: 0, idleStopMs: IDLE_STOP_MS });
    const ctx = { hourlyUsd, settings: stopSettings };
    assert.throws(
      () => resolveBurstScalerAction(scaler, longQueueSample(6_000_000), ctx),
      /billedTodayUsd must be a finite number/,
    );
    assert.throws(
      () => resolveBurstScalerAction(scaler, longQueueSample(6_000_000), {
        ...ctx,
        billedTodayUsd: '4.6',
      }),
      /billedTodayUsd must be a finite number/,
    );
    assert.throws(
      () => resolveBurstScalerAction(scaler, longQueueSample(6_000_001), {
        ...ctx,
        billedTodayUsd: -0.01,
      }),
      /billedTodayUsd must be a finite number/,
    );
    assert.throws(
      () => resolveBurstScalerAction(scaler, longQueueSample(6_000_002), {
        ...ctx,
        billedTodayUsd: Number.NaN,
      }),
      /billedTodayUsd must be a finite number/,
    );
  });

  test('limitContext validation failure does not advance scaler sustain timers', () => {
    const sustainMs = 10_000;
    const scaler = createBurstScaler({ startSustainMs: sustainMs, idleStopMs: IDLE_STOP_MS });
    const t0 = 8_000_000;
    assert.throws(
      () => resolveBurstScalerAction(scaler, longQueueSample(t0), {
        hourlyUsd,
        settings: stopSettings,
      }),
      /billedTodayUsd must be a finite number/,
    );
    const result = resolveBurstScalerAction(scaler, longQueueSample(t0 + sustainMs), {
      billedTodayUsd: 0,
      hourlyUsd,
      settings: stopSettings,
    });
    assert.equal(result.action, 'none');
  });

  test('running worker in notify mode returns dailyLimit with notify below hard ceiling', () => {
    const scaler = createBurstScaler({ startSustainMs: 0, idleStopMs: IDLE_STOP_MS });
    const t0 = 7_000_000;
    const running = { now: t0, readyTickets: 8, freeSlots: 2, running: true };
    const result = resolveBurstScalerAction(scaler, running, {
      billedTodayUsd: 5,
      hourlyUsd,
      settings: notifySettings,
      notifiedLevels: [],
    });
    assert.equal(result.action, 'none');
    assert.ok(result.dailyLimit);
    assert.equal(result.dailyLimit.allow, true);
    assert.ok(result.dailyLimit.notify.length > 0);
  });
});
