// SPDX-License-Identifier: Apache-2.0
/** Central hive core ("the model") visual state. */

export const HIVE_BRAIN_STATES = ['idle', 'working', 'merge', 'failure'];

/** Merge pulse visible for this long after a merge event (ms). */
export const HIVE_BRAIN_MERGE_PULSE_MS = 2400;

/** Failure flicker while a failure/error event is this recent (ms). */
export const HIVE_BRAIN_FAILURE_ACTIVE_MS = 12000;

/** No qualifying activity for this long → idle resting state (ms). */
export const HIVE_BRAIN_IDLE_AFTER_MS = 45000;

const FAILURE_KINDS = new Set(['failure', 'error', 'failed']);
const ACTIVITY_KINDS = new Set(['activity', 'working', 'ticket', 'run', 'job', 'code', 'sys']);
const MERGE_KINDS = new Set(['merge', 'merged', 'pr-merge']);

/**
 * Resolve hive core UI state from recent board/job events.
 *
 * Event shape: `{ kind: string, ts: number }` where `ts` is epoch milliseconds.
 * Optional aliases: `type` instead of `kind`, `at` instead of `ts`.
 *
 * Selection (highest priority first):
 * 1. `failure` — latest failure/error within FAILURE_ACTIVE_MS
 * 2. `merge` — latest merge within MERGE_PULSE_MS (one-shot pulse window)
 * 3. `working` — any activity-kind event within IDLE_AFTER_MS
 * 4. `idle` — calm resting state when nothing recent qualifies
 *
 * @param {Array<{ kind?: string, type?: string, ts?: number, at?: number }>} events
 * @param {number} now Epoch ms
 * @returns {'idle'|'working'|'merge'|'failure'}
 */
export function hiveBrainStateFromEvents(events, now) {
  const list = Array.isArray(events) ? events : [];
  const tNow = Number(now) || 0;

  let latestFailure = -Infinity;
  let latestMerge = -Infinity;
  let latestActivity = -Infinity;

  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;
    const kind = String(ev.kind ?? ev.type ?? '').toLowerCase();
    const ts = Number(ev.ts ?? ev.at);
    if (!Number.isFinite(ts)) continue;

    if (FAILURE_KINDS.has(kind) || kind.includes('fail') || kind.includes('error')) {
      if (ts > latestFailure) latestFailure = ts;
    }
    if (MERGE_KINDS.has(kind) || kind.includes('merge')) {
      if (ts > latestMerge) latestMerge = ts;
    }
    const isFailure = FAILURE_KINDS.has(kind) || kind.includes('fail') || kind.includes('error');
    const isMerge = MERGE_KINDS.has(kind) || kind.includes('merge');
    if (!isFailure && !isMerge && ACTIVITY_KINDS.has(kind)) {
      if (ts > latestActivity) latestActivity = ts;
    }
  }

  if (latestFailure > tNow - HIVE_BRAIN_FAILURE_ACTIVE_MS) {
    return 'failure';
  }
  if (latestMerge > tNow - HIVE_BRAIN_MERGE_PULSE_MS) {
    return 'merge';
  }
  if (latestActivity > tNow - HIVE_BRAIN_IDLE_AFTER_MS) {
    return 'working';
  }
  return 'idle';
}

const STILL_FRAME_BY_STATE = {
  idle: {
    coreClass: 'hive-core-disk hive-core--idle',
    statusClass: 'hive-core-status',
    statusText: 'resting',
  },
  working: {
    coreClass: 'hive-core-disk hive-core--working',
    statusClass: 'hive-core-status',
    statusText: 'working',
  },
  merge: {
    coreClass: 'hive-core-disk hive-core--merge',
    statusClass: 'hive-core-status',
    statusText: 'merged',
  },
  failure: {
    coreClass: 'hive-core-disk hive-core--failure',
    statusClass: 'hive-core-status',
    statusText: 'degraded',
  },
};

/**
 * Reduced motion: a single still frame (classes + copy), not an animation descriptor.
 * @param {'idle'|'working'|'merge'|'failure'} state
 * @returns {{ coreClass: string, statusClass: string, statusText: string }}
 */
export function hiveBrainReducedMotionStillFrame(state) {
  const key = STILL_FRAME_BY_STATE[state] ? state : 'idle';
  return { ...STILL_FRAME_BY_STATE[key] };
}

/**
 * Animated path descriptor (only when motion is allowed).
 * @param {'idle'|'working'|'merge'|'failure'} state
 * @returns {{ animation: string, loop: boolean }}
 */
export function hiveBrainMotionDescriptor(state) {
  switch (state) {
    case 'merge':
      return { animation: 'hive-core-pulse-merge', loop: false };
    case 'failure':
      return { animation: 'hive-core-flicker-failure', loop: true };
    case 'idle':
      return { animation: 'hive-core-breathe-idle', loop: true };
    default:
      return { animation: 'hive-core-glow-working', loop: true };
  }
}
