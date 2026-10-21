// SPDX-License-Identifier: Apache-2.0
import { appendEvent, KINDS } from '../journal.mjs';

/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerFinding} ManagerFinding */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerJournalLine} ManagerJournalLine */
/** @typedef {import('../../contracts/managers.json').components.schemas.JournalReport} JournalReport */

export const MANAGER_IDS = Object.freeze([
  'budget',
  'lane-health',
  'version',
  'ticket-manager',
  'unblocker',
  'merge-queue',
  'lessons-keeper',
  'visual-qa',
]);

export const MANAGER_ACTION_MODES = Object.freeze(['off', 'shadow', 'auto']);

const MANAGER_ID_SET = new Set(MANAGER_IDS);
const MODE_SET = new Set(MANAGER_ACTION_MODES);
const KIND_SET = new Set(KINDS);
const FINDING_SEVERITIES = new Set(['info', 'warn', 'needs_you']);

function normalizeCost(cost) {
  const n = Number(cost);
  if (!Number.isFinite(n) || n < 0) throw new Error('manager-journal-cost-invalid');
  return n;
}

function clipText(value, max, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`manager-journal-${label}-invalid`);
  if (text.length > max) return text.slice(0, max);
  return text;
}

function optionalClip(value, max, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return clipText(value, max, label);
}

/**
 * Build one journal line from a manager finding (does not append).
 * @param {ManagerFinding} finding
 * @param {{ cost?: number, kind?: string }} [options]
 * @returns {ManagerJournalLine}
 */
export function managerJournalLineFromFinding(finding, { cost = 0, kind = 'action' } = {}) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    throw new Error('manager-journal-finding-invalid');
  }
  if (!finding.id || typeof finding.id !== 'string') throw new Error('manager-journal-finding-id-invalid');
  if (!MANAGER_ID_SET.has(finding.managerId)) throw new Error('manager-journal-manager-invalid');
  if (!FINDING_SEVERITIES.has(finding.severity)) throw new Error('manager-journal-severity-invalid');
  if (!MODE_SET.has(finding.mode)) throw new Error('manager-journal-mode-invalid');
  clipText(finding.code, 80, 'code');
  const line = {
    kind,
    manager: finding.managerId,
    action: clipText(finding.action, 80, 'action'),
    reason: clipText(finding.reason, 2000, 'reason'),
    mode: finding.mode,
    cost: normalizeCost(cost),
  };
  const ticket = optionalClip(finding.ticket, 16, 'ticket');
  const lane = optionalClip(finding.lane, 40, 'lane');
  if (ticket) line.ticket = ticket;
  if (lane) line.lane = lane;
  validateManagerJournalLine(line);
  return line;
}

/**
 * Build one journal line for a manager action (does not append).
 * @param {{ manager: string, action: string, reason: string, mode: string, cost?: number, ticket?: string, lane?: string, kind?: string }} input
 * @returns {ManagerJournalLine}
 */
export function managerJournalLineFromAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('manager-journal-action-invalid');
  }
  const kind = input.kind ?? 'action';
  const line = {
    kind,
    manager: input.manager,
    action: clipText(input.action, 80, 'action'),
    reason: clipText(input.reason, 2000, 'reason'),
    mode: input.mode,
    cost: normalizeCost(input.cost ?? 0),
  };
  if (!MANAGER_ID_SET.has(line.manager)) throw new Error('manager-journal-manager-invalid');
  if (!MODE_SET.has(line.mode)) throw new Error('manager-journal-mode-invalid');
  const ticket = optionalClip(input.ticket, 16, 'ticket');
  const lane = optionalClip(input.lane, 40, 'lane');
  if (ticket) line.ticket = ticket;
  if (lane) line.lane = lane;
  validateManagerJournalLine(line);
  return line;
}

/** @param {ManagerJournalLine} line */
export function validateManagerJournalLine(line) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) {
    throw new Error('manager-journal-line-invalid');
  }
  if (!KIND_SET.has(line.kind)) throw new Error('manager-journal-kind-invalid');
  if (!MANAGER_ID_SET.has(line.manager)) throw new Error('manager-journal-manager-invalid');
  if (!MODE_SET.has(line.mode)) throw new Error('manager-journal-mode-invalid');
  clipText(line.action, 80, 'action');
  clipText(line.reason, 2000, 'reason');
  normalizeCost(line.cost);
  if (line.ticket !== undefined) optionalClip(line.ticket, 16, 'ticket');
  if (line.lane !== undefined) optionalClip(line.lane, 40, 'lane');
}

/**
 * Append one structured manager journal line.
 * @param {string} root
 * @param {ManagerJournalLine} line
 * @param {{ journal?: typeof appendEvent, now?: () => number, best?: boolean }} [options]
 */
export async function appendManagerJournalLine(root, line, { journal = appendEvent, now, best } = {}) {
  validateManagerJournalLine(line);
  return journal(root, line, { now, best });
}

/**
 * Append one journal line for a manager finding.
 * @param {string} root
 * @param {ManagerFinding} finding
 * @param {{ cost?: number, kind?: string, journal?: typeof appendEvent, now?: () => number, best?: boolean }} [options]
 */
export async function appendManagerFinding(root, finding, options = {}) {
  const line = managerJournalLineFromFinding(finding, options);
  return appendManagerJournalLine(root, line, options);
}

/**
 * Append one journal line for a manager action.
 * @param {string} root
 * @param {{ manager: string, action: string, reason: string, mode: string, cost?: number, ticket?: string, lane?: string, kind?: string }} action
 * @param {{ journal?: typeof appendEvent, now?: () => number, best?: boolean }} [options]
 */
export async function appendManagerAction(root, action, options = {}) {
  const line = managerJournalLineFromAction(action);
  return appendManagerJournalLine(root, line, options);
}

/**
 * Append every journal line from a manager run report.
 * @param {string} root
 * @param {JournalReport} report
 * @param {{ journal?: typeof appendEvent, now?: () => number, best?: boolean }} [options]
 */
export async function appendManagerJournalReport(root, report, options = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('manager-journal-report-invalid');
  }
  if (!report.runId || typeof report.runId !== 'string') throw new Error('manager-journal-report-runId-invalid');
  if (!MANAGER_ID_SET.has(report.managerId)) throw new Error('manager-journal-manager-invalid');
  if (!Array.isArray(report.lines) || report.lines.length < 1) {
    throw new Error('manager-journal-report-lines-invalid');
  }
  const stored = [];
  for (const line of report.lines) {
    stored.push(await appendManagerJournalLine(root, line, options));
  }
  return stored;
}
