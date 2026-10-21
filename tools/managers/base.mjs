// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import {
  getManagerActionMode,
  isManagerId,
  managerActionModeAppliesChanges,
  managerActionModeRunsManager,
  managerActionModeWritesJournal,
} from './modes.mjs';
import { appendManagerFinding, managerJournalLineFromFinding } from './journal.mjs';

/** @typedef {import('./types.mjs').ManagerId} ManagerId */
/** @typedef {import('./types.mjs').ManagerFinding} ManagerFinding */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerRun} ManagerRun */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerRunStatus} ManagerRunStatus */
/** @typedef {import('../../contracts/managers.json').components.schemas.JournalReport} JournalReport */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerJournalLine} ManagerJournalLine */
/** @typedef {import('./modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */

/**
 * @typedef {object} ManagerRunContext
 * @property {string} runId
 * @property {ManagerFinding[]} findings
 * @property {ManagerJournalLine[]} journalLines
 * @property {number} costUsd
 */

/**
 * @param {string} message
 * @param {number} max
 */
function clipError(message, max) {
  const text = String(message ?? '').trim() || 'manager-run-error';
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/**
 * @param {ManagerRunContext} ctx
 * @param {ManagerId} managerId
 * @param {ManagerTrigger} trigger
 * @param {ManagerRunStatus} status
 * @param {string} startedAt
 * @param {string} finishedAt
 * @param {string} [error]
 * @returns {ManagerRun}
 */
export function buildManagerRun(ctx, managerId, trigger, status, startedAt, finishedAt, error) {
  const run = {
    runId: ctx.runId,
    managerId,
    trigger,
    status,
    startedAt,
    finishedAt,
    costUsd: ctx.costUsd,
    findingCount: ctx.findings.length,
    journalLineCount: ctx.journalLines.length,
  };
  if (error) run.error = clipError(error, 2000);
  return run;
}

/**
 * @param {ManagerRunContext} ctx
 * @param {ManagerId} managerId
 * @returns {JournalReport|null}
 */
export function buildManagerJournalReport(ctx, managerId) {
  if (ctx.journalLines.length < 1) return null;
  return {
    runId: ctx.runId,
    managerId,
    lines: ctx.journalLines.slice(),
  };
}

/**
 * Shared run loop for swarm managers: resolves per-action modes, journals shadow/auto
 * findings, and applies ticket (or other) mutations only when mode is `auto`.
 */
export class BaseManager {
  /**
   * @param {{
   *   managerId: ManagerId,
   *   root: string,
   *   modeSettings: ManagerActionModeSettings,
   *   trigger?: ManagerTrigger,
   * }} config
   */
  constructor({ managerId, root, modeSettings, trigger = 'scope' }) {
    if (!isManagerId(managerId)) throw new Error(`Unknown manager id: ${String(managerId)}`);
    if (typeof root !== 'string' || root.length < 1) throw new Error('manager-root-invalid');
    if (!modeSettings || typeof modeSettings !== 'object') {
      throw new Error('manager-mode-settings-invalid');
    }
    /** @type {ManagerId} */
    this.managerId = managerId;
    /** @type {string} */
    this.root = root;
    /** @type {ManagerActionModeSettings} */
    this.modeSettings = modeSettings;
    /** @type {ManagerTrigger} */
    this.trigger = trigger;
    /** @type {ManagerRunContext|null} */
    this._ctx = null;
  }

  /**
   * @returns {boolean}
   */
  shouldRun() {
    return true;
  }

  /**
   * @param {ManagerRunContext} ctx
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    throw new Error(`${this.managerId}: execute not implemented`);
  }

  /**
   * Resolve the effective mode for one manager action name.
   * @param {string} action
   */
  actionMode(action) {
    return getManagerActionMode(this.modeSettings, this.managerId, action);
  }

  /**
   * Record one finding: journal in shadow/auto, mutate only in auto (AC1).
   *
   * @param {Omit<ManagerFinding, 'managerId' | 'mode'> & { id?: string }} input
   * @param {{
   *   cost?: number,
   *   kind?: string,
   *   apply?: () => Promise<void> | void,
   *   journal?: (root: string, line: ManagerJournalLine, options?: object) => Promise<unknown>,
   *   now?: () => number,
   *   best?: boolean,
   * }} [options]
   * @returns {Promise<ManagerFinding|null>}
   */
  async emitFinding(input, options = {}) {
    const ctx = this._ctx;
    if (!ctx) throw new Error('manager-run-not-active');

    const action = input.action;
    const mode = getManagerActionMode(this.modeSettings, this.managerId, action);
    if (!managerActionModeRunsManager(mode)) return null;

    /** @type {ManagerFinding} */
    const finding = {
      id: input.id ?? randomUUID(),
      managerId: this.managerId,
      severity: input.severity,
      code: input.code,
      reason: input.reason,
      action,
      mode,
    };
    if (input.ticket !== undefined) finding.ticket = input.ticket;
    if (input.lane !== undefined) finding.lane = input.lane;
    if (input.gatesCount !== undefined) finding.gatesCount = input.gatesCount;
    if (input.recommendation !== undefined) finding.recommendation = input.recommendation;

    const cost = options.cost ?? 0;
    if (managerActionModeWritesJournal(mode)) {
      await appendManagerFinding(this.root, finding, {
        cost,
        kind: options.kind,
        journal: options.journal,
        now: options.now,
        best: options.best,
      });
      ctx.journalLines.push(managerJournalLineFromFinding(finding, { cost, kind: options.kind }));
    }

    ctx.findings.push(finding);
    ctx.costUsd += cost;

    if (managerActionModeAppliesChanges(mode) && options.apply) {
      await options.apply();
    }

    return finding;
  }

  /**
   * @param {{
   *   journal?: (root: string, line: ManagerJournalLine, options?: object) => Promise<unknown>,
   *   now?: () => number,
   *   best?: boolean,
   * }} [options]
   * @returns {Promise<{ run: ManagerRun, report: JournalReport|null }>}
   */
  async run(options = {}) {
    const now = options.now ?? (() => Date.now());
    const startedAt = new Date(now()).toISOString();
    const runId = randomUUID();

    /** @type {ManagerRunContext} */
    const ctx = {
      runId,
      findings: [],
      journalLines: [],
      costUsd: 0,
    };
    this._ctx = ctx;

    let status = /** @type {ManagerRunStatus} */ ('ok');
    let error;

    try {
      if (!this.shouldRun()) {
        status = 'skipped';
      } else {
        await this.execute(ctx);
      }
    } catch (err) {
      status = 'error';
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this._ctx = null;
    }

    const finishedAt = new Date(now()).toISOString();
    const run = buildManagerRun(ctx, this.managerId, this.trigger, status, startedAt, finishedAt, error);
    const report = buildManagerJournalReport(ctx, this.managerId);
    return { run, report };
  }
}
