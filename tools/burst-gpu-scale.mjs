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
export function resolveBurstScalerAction(scaler, sample, limitContext) {
  const base = scaler.update(sample);
  const {
    billedTodayUsd = 0,
    hourlyUsd,
    settings = {},
    notifiedLevels = [],
  } = limitContext ?? {};
  assertFiniteNumber('hourlyUsd', hourlyUsd);

  const evaluate = (reserveUsd) => evaluateDailyLimit({
    settings,
    billedTodayUsd,
    reserveUsd,
    lane: 'rented',
    now: sample.now,
    notifiedLevels,
  });

  if (sample.running) {
    const dailyLimit = evaluate(hourlyUsd);
    if (dailyLimit.ceilingHit) {
      return { action: 'stop', dailyLimit };
    }
  }

  if (base === 'start') {
    const dailyLimit = evaluate(hourlyUsd);
    if (!dailyLimit.allow) {
      return { action: 'none', dailyLimit };
    }
    return { action: 'start', dailyLimit };
  }

  return { action: base, dailyLimit: null };
}
