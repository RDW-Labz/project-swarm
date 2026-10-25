import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  computeBurstGpuGates,
  consecutiveReadyOverFreeDays,
  flatRateAllLimited,
  gpuFirstTryPassRateFromReplay,
} from '../tools/burst-gates.mjs';

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
    assert.equal(row.value, '90 percent');
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
    assert.equal(row.value, '70 percent');
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
      'gate gpu-first-try-pass-rate: 73 percent FAIL',
    ]);
    assert.equal(result.pass, false);
    assert.equal(
      result.text,
      `${result.lines.join('\n')}\n`,
    );
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
});
