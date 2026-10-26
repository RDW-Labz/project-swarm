// Burst GPU worker scaling decisions for ticket T-0280.
// Pure logic only: the caller supplies samples and performs the actual start or stop.

import { evaluateDailyLimit } from './daily-limit.mjs';

export const IDLE_STOP_MS = 10 * 60 * 1000;
export const DEFAULT_START_SUSTAIN_MS = 10 * 60 * 1000;

function assertFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function assertPositiveFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function assertNonNegativeFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

// The queue is long when ready tickets exceed free slots across the Macs.
export function isQueueLong(sample) {
  return sample.readyTickets > sample.freeSlots;
}

// The queue is empty when no ticket is ready.
export function isQueueEmpty(sample) {
  return sample.readyTickets === 0;
}

export function createBurstScaler(options = {}) {
  const idleStopMs = options.idleStopMs ?? IDLE_STOP_MS;
  const startSustainMs = options.startSustainMs ?? DEFAULT_START_SUSTAIN_MS;
  assertFiniteNumber('idleStopMs', idleStopMs);
  assertFiniteNumber('startSustainMs', startSustainMs);

  let longSince = null;
  let emptySince = null;

  return {
    // Returns 'start', 'stop', or 'none' for one observation of the queue.
    update(sample) {
      assertFiniteNumber('now', sample.now);
      assertFiniteNumber('readyTickets', sample.readyTickets);
      assertFiniteNumber('freeSlots', sample.freeSlots);
      const now = sample.now;

      if (isQueueLong(sample)) {
        if (longSince === null) longSince = now;
      } else {
        longSince = null;
      }

      if (isQueueEmpty(sample)) {
        if (emptySince === null) emptySince = now;
      } else {
        emptySince = null;
      }

      if (!sample.running && longSince !== null && now - longSince >= startSustainMs) {
        return 'start';
      }
      if (sample.running && emptySince !== null && now - emptySince >= idleStopMs) {
        return 'stop';
      }
      return 'none';
    },
  };
}

// Applies machine daily-limit checks to createBurstScaler decisions.
// reserveUsd uses one hour of GPU cost (same convention as hourly rental exposure).
//
// Contract: billedTodayUsd must include any in-progress unbilled rental cost the caller
// already knows about. A returned 'start' commits one hour of hourlyUsd exposure. Re-run
// this function with fresh inputs before each actual start; do not reuse one result for
// multiple starts.
export function resolveBurstScalerAction(scaler, sample, limitContext) {
  const {
    billedTodayUsd,
    hourlyUsd,
    settings = {},
    notifiedLevels = [],
  } = limitContext ?? {};
  assertNonNegativeFiniteNumber('billedTodayUsd', billedTodayUsd);
  assertPositiveFiniteNumber('hourlyUsd', hourlyUsd);

  const base = scaler.update(sample);

  const evaluate = (reserveUsd) => evaluateDailyLimit({
    settings,
    billedTodayUsd,
    reserveUsd,
    lane: 'rented',
    now: sample.now,
    notifiedLevels,
  });

  let runningDailyLimit = null;
  if (sample.running) {
    runningDailyLimit = evaluate(hourlyUsd);
    if (runningDailyLimit.ceilingHit) {
      return { action: 'stop', dailyLimit: runningDailyLimit };
    }
  }

  if (base === 'start') {
    const dailyLimit = evaluate(hourlyUsd);
    if (!dailyLimit.allow) {
      return { action: 'none', dailyLimit };
    }
    return { action: 'start', dailyLimit };
  }

  if (sample.running) {
    return { action: base, dailyLimit: runningDailyLimit };
  }

  return { action: base, dailyLimit: null };
}
