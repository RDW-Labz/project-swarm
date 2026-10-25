// SPDX-License-Identifier: Apache-2.0

export const GATE_THRESHOLDS = Object.freeze({
  minReadyOverFreeDays: 3,
  minGpuFirstTryPassRate: 0.9,
});

/** Trailing days (oldest→newest samples) where ready tickets exceed free slots. */
export function consecutiveReadyOverFreeDays(samples) {
  const rows = samples ?? [];
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const ready = Number(rows[i]?.readyTickets);
    const free = Number(rows[i]?.freeSlots);
    if (!Number.isFinite(ready) || !Number.isFinite(free) || ready <= free) break;
    count += 1;
  }
  return count;
}

/** Queue pressure ratio (ready / free slots); null when free slots are zero. */
export function readyOverFreeSlotsRatio(readyTickets, freeSlots) {
  const ready = Number(readyTickets);
  const free = Number(freeSlots);
  if (!Number.isFinite(ready) || !Number.isFinite(free) || free <= 0) return null;
  return ready / free;
}

/** First-try pass rate from benchmark replay rows (same math as bench-replay aggregate). */
export function gpuFirstTryPassRateFromReplay(results) {
  const rows = results ?? [];
  if (!rows.length) return null;
  const firstTry = rows.filter((r) => r.status === 'pass' && (r.retries ?? 0) === 0).length;
  return firstTry / rows.length;
}

export function flatRateAllLimited(flatRateLanes) {
  const lanes = flatRateLanes ?? [];
  if (!lanes.length) return false;
  return lanes.every((lane) => lane?.rateLimited === true);
}

function gateRows({ readyOverFreeDays, flatRateRateLimited, gpuFirstTryPassRate }) {
  const days = Number(readyOverFreeDays);
  const gpuRate = Number(gpuFirstTryPassRate);
  return [
    {
      name: 'ready-over-free-slots',
      value: `${Number.isFinite(days) ? days : 'missing'} consecutive days`,
      measured: Number.isFinite(days) ? days : null,
      pass: Number.isFinite(days) && days >= GATE_THRESHOLDS.minReadyOverFreeDays,
    },
    {
      name: 'flat-rate-rate-limited',
      value: flatRateRateLimited === true
        ? 'all flat-rate lanes limited'
        : 'not all flat-rate lanes limited',
      measured: flatRateRateLimited === true,
      pass: flatRateRateLimited === true,
    },
    {
      name: 'gpu-first-try-pass-rate',
      value: Number.isFinite(gpuRate) ? `${(gpuRate * 100).toFixed(0)} percent` : 'missing',
      measured: Number.isFinite(gpuRate) ? gpuRate : null,
      pass: Number.isFinite(gpuRate) && gpuRate >= GATE_THRESHOLDS.minGpuFirstTryPassRate,
    },
  ];
}

/**
 * Compute GPU burst gates from caller-supplied queue, lane, and benchmark replay inputs.
 *
 * @param {object} inputs
 * @param {number} [inputs.readyTickets] — today's ready count (with freeSlots, extends pressure history)
 * @param {number} [inputs.freeSlots] — today's free slot count
 * @param {Array<{readyTickets:number,freeSlots:number}>} [inputs.pressureDailySamples]
 * @param {number} [inputs.readyOverFreeDays] — precomputed consecutive pressure days
 * @param {Array<{rateLimited?:boolean}>} [inputs.flatRateLanes]
 * @param {boolean} [inputs.flatRateRateLimited]
 * @param {Array<{status:string,retries?:number}>} [inputs.benchmarkReplayResults]
 * @param {number} [inputs.gpuFirstTryPassRate]
 */
export function computeBurstGpuGates(inputs = {}) {
  const pressureSamples = [...(inputs.pressureDailySamples ?? [])];
  if (Number.isFinite(inputs.readyTickets) && Number.isFinite(inputs.freeSlots)) {
    pressureSamples.push({
      readyTickets: inputs.readyTickets,
      freeSlots: inputs.freeSlots,
    });
  }

  let readyOverFreeDays = inputs.readyOverFreeDays;
  if (readyOverFreeDays === undefined && pressureSamples.length) {
    readyOverFreeDays = consecutiveReadyOverFreeDays(pressureSamples);
  }
  if (readyOverFreeDays === undefined) {
    readyOverFreeDays = Number.NaN;
  }

  const flatRateRateLimited = inputs.flatRateRateLimited === true
    || (inputs.flatRateLanes != null && flatRateAllLimited(inputs.flatRateLanes));

  let gpuFirstTryPassRate = inputs.gpuFirstTryPassRate;
  if (gpuFirstTryPassRate === undefined && inputs.benchmarkReplayResults != null) {
    gpuFirstTryPassRate = gpuFirstTryPassRateFromReplay(inputs.benchmarkReplayResults);
  }
  if (gpuFirstTryPassRate === undefined) {
    gpuFirstTryPassRate = Number.NaN;
  }

  const rows = gateRows({ readyOverFreeDays, flatRateRateLimited, gpuFirstTryPassRate });
  const pass = rows.every((r) => r.pass);
  const lines = formatBurstGpuGates({ rows, pass });
  const ratio = readyOverFreeSlotsRatio(inputs.readyTickets, inputs.freeSlots);

  return {
    rows,
    pass,
    lines,
    text: `${lines.join('\n')}\n`,
    readyOverFreeSlotsRatio: ratio,
  };
}

export function formatBurstGpuGates(result) {
  return result.rows.map((r) => `gate ${r.name}: ${r.value} ${r.pass ? 'PASS' : 'FAIL'}`);
}
