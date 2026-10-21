// SPDX-License-Identifier: Apache-2.0
import { sizeTicket } from './escalation.mjs';

/** Hermes and other single-request API lanes default to the same per-file output cap as swarm validate. */
export const HERMES_CAP_BYTES = 15360;
export const OUTPUT_CAP_BYTES = Object.freeze({ total: 61440, perFile: HERMES_CAP_BYTES });
export const DEFAULT_MAX_FILES = 4;

/** Lanes that edit existing outputs in a worktree or shell; not limited by API rewrite caps. */
export const IN_PLACE_LANES = Object.freeze(['cursor', 'codex', 'claude']);

/** Cheap lanes the splitter considers before routing in place or splitting (matches router cheap order, plus research Hermes). */
export const CHEAP_LANE_ORDER = Object.freeze(['cursor', 'codex', 'anthropic', 'hermes', 'openrouter']);

/** Default per-lane capBytes for API lanes (single-request output limits). */
export const LANE_CAP_BYTES = Object.freeze({
  hermes: HERMES_CAP_BYTES,
  anthropic: HERMES_CAP_BYTES,
  openrouter: HERMES_CAP_BYTES,
  qwen: HERMES_CAP_BYTES,
  openai: HERMES_CAP_BYTES,
  gemini: HERMES_CAP_BYTES,
  lambda: HERMES_CAP_BYTES,
});

export function laneAgent(lane) {
  const text = String(lane ?? '').trim();
  const idx = text.indexOf(':');
  return (idx === -1 ? text : text.slice(0, idx)).toLowerCase();
}

export function isInPlaceLane(lane) {
  return IN_PLACE_LANES.includes(laneAgent(lane));
}

export function capBytesForLane(lane, overrides = {}) {
  const agent = laneAgent(lane);
  if (isInPlaceLane(agent)) return null;
  if (Object.hasOwn(overrides, agent)) return overrides[agent];
  return LANE_CAP_BYTES[agent] ?? HERMES_CAP_BYTES;
}

export function ticketOutputFiles(ticket) {
  const entries = ticket?.outputs ?? ticket?.files ?? [];
  return entries.filter((file) => typeof file === 'string' && !file.endsWith('/'));
}

export function ticketByteTotal(ticket, sizes = {}) {
  return ticketOutputFiles(ticket).reduce((sum, file) => sum + (sizes[file] ?? 0), 0);
}

export function sizeTicketForLane(ticket, lane, { sizes = {}, maxFiles = DEFAULT_MAX_FILES, capBytes, laneCaps = {} } = {}) {
  const cap = capBytes ?? capBytesForLane(lane, laneCaps);
  if (cap === null) {
    return sizeTicket(ticket, { sizes, capBytes: Number.MAX_SAFE_INTEGER, maxFiles });
  }
  return sizeTicket(ticket, { sizes, capBytes: cap, maxFiles });
}

export function fittingLanes(ticket, { sizes = {}, lanes = CHEAP_LANE_ORDER, maxFiles = DEFAULT_MAX_FILES, laneCaps = {} } = {}) {
  return lanes.filter((lane) => sizeTicketForLane(ticket, lane, { sizes, maxFiles, laneCaps }).ok);
}

/**
 * Pick a cheap lane or tell the splitter to route in place or split.
 * API lanes are checked first so byte budgets apply before unlimited in-place writers.
 */
export function adviseTicketLane(ticket, { sizes = {}, lanes = CHEAP_LANE_ORDER, maxFiles = DEFAULT_MAX_FILES, laneCaps = {} } = {}) {
  const apiLanes = lanes.filter((lane) => !isInPlaceLane(lane));
  const inPlaceLanes = lanes.filter((lane) => isInPlaceLane(lane));

  for (const lane of apiLanes) {
    const result = sizeTicketForLane(ticket, lane, { sizes, maxFiles, laneCaps });
    if (result.ok) return { ok: true, action: 'ready', lane, reasons: [] };
  }

  for (const lane of inPlaceLanes) {
    const result = sizeTicketForLane(ticket, lane, { sizes, maxFiles, laneCaps });
    if (result.ok) {
      return {
        ok: true,
        action: 'route-in-place',
        lane,
        reasons: [`existing outputs exceed API lane limits; route to ${lane} (edits in place)`],
      };
    }
  }

  const probeLane = apiLanes[0] ?? inPlaceLanes[0] ?? 'hermes';
  const reasons = sizeTicketForLane(ticket, probeLane, { sizes, maxFiles, laneCaps }).reasons;
  return { ok: false, action: 'split', lane: null, reasons };
}
