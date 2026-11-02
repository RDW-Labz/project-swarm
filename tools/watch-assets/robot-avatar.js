// SPDX-License-Identifier: Apache-2.0
// Thin adapter: job/agent records → lane colour (board-lib) and robot-head state (All Projects board).
import { mountRobotHead, STATES } from './robot-head.js';

/** Same keys as tools/watch-assets/board.js `HEAD_STATE` (headSpec / agents grid). */
export const HEAD_STATE = Object.freeze({
  working: 'working',
  thinking: 'thinking',
  error: 'error',
  sleeping: 'sleeping',
});

/** Must match `agentState` in tools/board-data.mjs (running / failed / timeout). */
export const WORKING_MS = 90 * 1000;
export const ERROR_SHOWN_MS = 10 * 60 * 1000;

function boardLaneColor(label) {
  const lib = (typeof globalThis !== 'undefined' && globalThis.BoardLib)
    || (typeof self !== 'undefined' && self.BoardLib);
  if (!lib || typeof lib.laneColor !== 'function') {
    throw new Error('robot-avatar requires BoardLib.laneColor (load board-lib.js first)');
  }
  return lib.laneColor(label);
}

function agentStateFromJob(job, now = Date.now()) {
  if (job?.status === 'running') {
    const last = Date.parse(job.progress?.lastOutputAt ?? '');
    return Number.isFinite(last) && now - last <= WORKING_MS ? 'working' : 'thinking';
  }
  if (job?.status === 'failed' || job?.status === 'timeout') {
    const finished = Date.parse(job.finishedAt ?? '');
    return Number.isFinite(finished) && now - finished <= ERROR_SHOWN_MS ? 'error' : null;
  }
  return null;
}

function mapHeadState(raw) {
  if (!raw || typeof raw !== 'string') return 'idle';
  return HEAD_STATE[raw] ?? 'idle';
}

/** Lane label → hex via the shared All Projects palette (never a local duplicate table). */
export function resolveLaneColor(lane) {
  return boardLaneColor(lane == null ? '' : String(lane));
}

/**
 * Derive a robot-head state from an agent row (`state`) or a run job (`status` + progress).
 * Unknown lane/status values fall back to `idle`; idle bays use `sleeping`.
 */
export function resolveRobotState(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return 'idle';
  if (record.state === 'sleeping' || record.idle === true) return 'sleeping';
  if (record.status !== undefined && record.status !== null) {
    return mapHeadState(agentStateFromJob(record, now));
  }
  if (typeof record.state === 'string' && record.state.length > 0) {
    return mapHeadState(record.state);
  }
  return 'idle';
}

export function robotScreenColor(state) {
  return state === 'error' ? '#ffc4c4' : '#e8f2ff';
}

function headId(record, options) {
  if (options.id) return String(options.id);
  if (record?.key) return String(record.key);
  const runId = record?.runId ?? record?.run ?? '';
  const jobId = record?.jobId ?? record?.job ?? '';
  if (runId || jobId) return `${runId}|${jobId}`;
  return '';
}

function headLabel(record, lane, state, options) {
  if (options.label !== undefined) return options.label;
  const base = `${lane} agent, ${state}`;
  if (record?.ticket || record?.job) {
    const id = record.ticket || record.job;
    const run = record.runShort ?? record.run ?? '';
    return run ? `${base}, ${id}, run ${run}` : `${base}, ${id}`;
  }
  return base;
}

/** Options passed to `mountRobotHead` after lane/state resolution. */
export function buildRobotAvatarMountOptions(record, options = {}) {
  const lane = String(record?.lane ?? options.lane ?? '');
  const state = resolveRobotState(record, options.now);
  const safeState = STATES.includes(state) ? state : 'idle';
  const color = resolveLaneColor(lane);
  const size = options.size ?? 56;
  return {
    state: safeState,
    size,
    color,
    trimColor: options.trimColor,
    screenColor: options.screenColor ?? robotScreenColor(safeState),
    shape: options.shape,
    antenna: options.antenna,
    id: headId(record, options),
    label: headLabel(record, lane, safeState, options),
  };
}

/**
 * Mount a robot head for one agent/job/session row. `record` carries `lane` and either
 * board agent `state` or run job `status` (plus progress / finishedAt when needed).
 */
export function mountRobotAvatar(host, record, options = {}) {
  return mountRobotHead(host, buildRobotAvatarMountOptions(record, options));
}
