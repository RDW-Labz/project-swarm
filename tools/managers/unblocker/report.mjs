// SPDX-License-Identifier: Apache-2.0
// Unblocker change report: summarize replans and reroutes from safe recovery (R-013, T-0204).

import { managerJournalLineFromAction } from '../journal.mjs';

/** @typedef {import('./rank.mjs').ReplanLogEntry} ReplanLogEntry */
/** @typedef {import('./rank.mjs').RankedBlockedTicket} RankedBlockedTicket */
/** @typedef {import('../types.mjs').ManagerFinding} ManagerFinding */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerJournalLine} ManagerJournalLine */

export const UNBLOCKER_MANAGER_ID = 'unblocker';

/** Finding codes for applied replans (replay fixtures key off these). */
export const UNBLOCKER_REPLAN_FINDING_CODES = Object.freeze([
  'unblocker-replan-split',
  'unblocker-replan-reroute',
]);

/**
 * @typedef {object} UnblockerChangeSummary
 * @property {number} total
 * @property {number} splitTicket
 * @property {number} rerouteLane
 * @property {readonly ReplanLogEntry[]} replans
 */

/**
 * @typedef {object} UnblockerChangeReport
 * @property {UnblockerChangeSummary} summary
 * @property {string} headline
 * @property {Omit<ManagerFinding, 'id'|'managerId'|'mode'>[]} findings
 * @property {readonly RankedBlockedTicket[]} ranked
 */

/**
 * @param {string} text
 * @param {number} [max]
 */
function clipReason(text, max = 2000) {
  const value = String(text ?? '').trim() || 'unblocker-replan';
  if (value.length <= max) return value;
  return value.slice(0, max);
}

/**
 * @param {'split-ticket'|'reroute-lane'} action
 */
function replanFindingCode(action) {
  return action === 'reroute-lane' ? 'unblocker-replan-reroute' : 'unblocker-replan-split';
}

/**
 * @param {readonly RankedBlockedTicket[]} ranked
 * @param {string} ticketId
 */
function gatesCountForTicket(ranked, ticketId) {
  const row = ranked.find((entry) => entry?.ticket?.id === ticketId);
  const gates = row?.gatesCount;
  return typeof gates === 'number' && gates > 0 ? gates : undefined;
}

/**
 * Count replans by safe action (split vs lane reroute).
 *
 * @param {readonly ReplanLogEntry[]} replans
 * @returns {UnblockerChangeSummary}
 */
export function summarizeUnblockerReplans(replans) {
  const list = Array.isArray(replans) ? replans.filter((entry) => entry && entry.ticketId) : [];
  let splitTicket = 0;
  let rerouteLane = 0;
  for (const entry of list) {
    if (entry.action === 'reroute-lane') rerouteLane += 1;
    else splitTicket += 1;
  }
  return {
    total: list.length,
    splitTicket,
    rerouteLane,
    replans: list,
  };
}

/**
 * @param {UnblockerChangeSummary} summary
 */
export function unblockerChangeHeadline(summary) {
  if (!summary?.total) return 'Unblocker made no replans this run';
  const parts = [];
  if (summary.rerouteLane) {
    parts.push(`${summary.rerouteLane} reroute${summary.rerouteLane === 1 ? '' : 's'}`);
  }
  if (summary.splitTicket) {
    parts.push(`${summary.splitTicket} re-split${summary.splitTicket === 1 ? '' : 's'}`);
  }
  return `Unblocker replanned ${summary.total} ticket(s): ${parts.join(', ')}`;
}

/**
 * Map applied replan log lines to manager finding shapes (orchestrator supplies ids and modes).
 *
 * @param {readonly ReplanLogEntry[]} replans
 * @param {{ ranked?: readonly RankedBlockedTicket[] }} [options]
 * @returns {Omit<ManagerFinding, 'id'|'managerId'|'mode'>[]}
 */
export function unblockerReplanLogToFindingInputs(replans, { ranked = [] } = {}) {
  const list = Array.isArray(replans) ? replans : [];
  const rankedList = Array.isArray(ranked) ? ranked : [];
  return list.map((entry) => {
    const gatesCount = gatesCountForTicket(rankedList, entry.ticketId);
    return {
      severity: 'info',
      code: replanFindingCode(entry.action),
      action: entry.action,
      reason: clipReason(entry.reason),
      ticket: entry.ticketId,
      ...(gatesCount !== undefined ? { gatesCount } : {}),
    };
  });
}

/**
 * Build a structured change report for one Unblocker recovery pass.
 *
 * @param {{ replans?: readonly ReplanLogEntry[], ranked?: readonly RankedBlockedTicket[] }} [input]
 * @returns {UnblockerChangeReport}
 */
export function buildUnblockerChangeReport({ replans = [], ranked = [] } = {}) {
  const summary = summarizeUnblockerReplans(replans);
  const rankedList = Array.isArray(ranked) ? ranked : [];
  const findings = unblockerReplanLogToFindingInputs(summary.replans, { ranked: rankedList });
  const headline = unblockerChangeHeadline(summary);
  return {
    summary,
    headline,
    findings,
    ranked: rankedList,
  };
}

/**
 * Human-readable report of what the Unblocker changed (for journals and operator logs).
 *
 * @param {UnblockerChangeReport} report
 */
export function formatUnblockerChangeReportText(report) {
  if (!report?.summary?.total) {
    return report?.headline ?? 'Unblocker made no replans this run';
  }
  const lines = [report.headline];
  for (const entry of report.summary.replans) {
    lines.push(`- ${entry.ticketId} (${entry.action}): ${entry.reason}`);
  }
  return clipReason(lines.join('\n'));
}

/**
 * Journal lines describing replans and reroutes (summary note plus one line per change).
 *
 * @param {readonly ReplanLogEntry[]} replans
 * @param {{ mode: string, ranked?: readonly RankedBlockedTicket[], cost?: number }} options
 * @returns {ManagerJournalLine[]}
 */
export function unblockerReplanJournalLines(replans, { mode, ranked = [], cost = 0 }) {
  const report = buildUnblockerChangeReport({ replans, ranked });
  if (!report.summary.total) return [];
  /** @type {ManagerJournalLine[]} */
  const lines = [
    managerJournalLineFromAction({
      manager: UNBLOCKER_MANAGER_ID,
      kind: 'note',
      action: 'add-context',
      reason: report.headline,
      mode,
      cost,
    }),
  ];
  for (const finding of report.findings) {
    lines.push(managerJournalLineFromAction({
      manager: UNBLOCKER_MANAGER_ID,
      kind: 'action',
      action: finding.action,
      reason: finding.reason,
      mode,
      cost,
      ...(finding.ticket ? { ticket: finding.ticket } : {}),
    }));
  }
  return lines;
}
