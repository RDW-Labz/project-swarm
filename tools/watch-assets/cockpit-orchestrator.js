// SPDX-License-Identifier: Apache-2.0
// Command Center cockpit: map real orchestrator session state (sessionsOf shape) to four owner-facing labels.
import { doingText, STATE_TEXT } from './orchestrator-view.js';

/** @typedef {'thinking'|'dispatching'|'waiting on you'|'reviewing'} CockpitLabel */

export const COCKPIT_LABELS = Object.freeze(['thinking', 'dispatching', 'waiting on you', 'reviewing']);

/**
 * Cockpit label mapping (layered on orchestrator-events state, not a second state machine):
 * - waiting on you: sessionsOf `waiting` (turn ended, owner can reply) — same as STATE_TEXT.waiting.
 * - thinking: `thinking` (prompt/post/pre with no running tool).
 * - dispatching: `working` while the active tool launches work (Task subagent, or Bash running swarm run/dispatch/worker).
 * - reviewing: `working` while the active tool is read-only inspection (Read/Grep/Glob/WebFetch/WebSearch) — orchestrator surveying the tree, not mutating.
 * Other `working` tools (Edit, Write, Bash builds) stay on thinking with doing detail, since the four labels are motion-director semantics not every tool name.
 */
const REVIEW_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'FetchMcpResource', 'ListMcpResources']);

export function isDispatchDoing(doing) {
  if (!doing || typeof doing.tool !== 'string') return false;
  if (doing.tool === 'Task') return true;
  if (doing.tool === 'Bash' && typeof doing.command === 'string') {
    return /\bswarm\s+(?:run|dispatch|worker|workers|wave|tickets)\b/.test(doing.command);
  }
  return false;
}

export function isReviewDoing(doing) {
  if (!doing || typeof doing.tool !== 'string') return false;
  return REVIEW_TOOLS.has(doing.tool);
}

/** @param {object} session sessionsOf row: { state, doing?, since?, endedAt? } */
export function cockpitOrchestratorState(session, now = Date.now()) {
  const detail = doingText(session, now);
  const state = session?.state;
  if (state === 'waiting' || state === 'idle') {
    return { label: 'waiting on you', detail: state === 'idle' ? (STATE_TEXT.idle + (detail.includes(',') ? detail.slice(detail.indexOf(',')) : '')) : detail };
  }
  if (state === 'ended') {
    return { label: 'waiting on you', detail };
  }
  if (state === 'thinking') {
    return { label: 'thinking', detail };
  }
  if (state === 'working') {
    if (isDispatchDoing(session.doing)) return { label: 'dispatching', detail };
    if (isReviewDoing(session.doing)) return { label: 'reviewing', detail };
    return { label: 'thinking', detail };
  }
  return { label: 'waiting on you', detail };
}

/** Pick the primary session row when several orchestrators are live (most recently active). */
export function cockpitOrchestratorFromSessions(sessions, now = Date.now()) {
  const list = Array.isArray(sessions) ? sessions.filter(s => s && s.shown !== false) : [];
  if (!list.length) {
    return { label: 'waiting on you', detail: STATE_TEXT.waiting };
  }
  return cockpitOrchestratorState(list[0], now);
}
