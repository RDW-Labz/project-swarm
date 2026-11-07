// SPDX-License-Identifier: Apache-2.0
// T-0193: Budget manager orchestrator — daily spend cap warnings and safe hold actions (R-037).

import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseManager } from '../base.mjs';
import { managerActionGroup } from '../registry.mjs';
import { WARN_CAP_ACTION } from './spend-watch.mjs';
import {
  capWarnWatchItemsToFindingInputs,
  watchProjectCapForecast,
} from './cap-warn.mjs';

/** @typedef {import('../modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */
/** @typedef {import('../registry.mjs').RunBuiltinManagerOptions} RunBuiltinManagerOptions */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */

export const BUDGET_MANAGER_ID = 'budget';

/** Safe budget-manager action when Opus acceptance reviews re-ask too often (registry.mjs). */
export const HOLD_OPUS_REASK_ACTION = 'hold-opus-reask';

/** Opus report re-asks on one ticket before the manager recommends holding further reviews. */
export const OPUS_REASK_HOLD_AFTER = 4;

/**
 * Safe actions this orchestrator emits (subset of registry MANAGER_ACTION_GROUPS.budget.safe).
 *
 * @type {readonly [string, string]}
 */
export const BUDGET_ORCHESTRATOR_SAFE_ACTIONS = Object.freeze([
  WARN_CAP_ACTION,
  HOLD_OPUS_REASK_ACTION,
]);

const TICKET_ID = /^T-\d{4,}$/;

/**
 * @param {string} action
 */
function assertBudgetOrchestratorSafeAction(action) {
  if (!BUDGET_ORCHESTRATOR_SAFE_ACTIONS.includes(action)) {
    throw new Error(`budget-orchestrator-action-unknown: ${String(action)}`);
  }
  if (managerActionGroup(BUDGET_MANAGER_ID, action) !== 'safe') {
    throw new Error(`budget-orchestrator-action-not-safe: ${String(action)}`);
  }
}

/**
 * Wire safe warn / hold action names against the built-in registry (AC1 / T-0193).
 */
export function registerBudgetOrchestratorSafeActions() {
  for (const action of BUDGET_ORCHESTRATOR_SAFE_ACTIONS) {
    assertBudgetOrchestratorSafeAction(action);
  }
}

registerBudgetOrchestratorSafeActions();

/**
 * @param {string} root
 */
async function readProjectRuns(root) {
  const dir = path.join(root, '.swarm', 'runs');
  /** @type {{ state: object }[]} */
  const runs = [];
  let ids = [];
  try {
    ids = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return runs;
    throw error;
  }
  for (const id of ids) {
    const file = path.join(dir, id, 'state.json');
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state && typeof state === 'object' && !Array.isArray(state)) runs.push({ state });
    } catch (error) {
      if (error.code !== 'ENOENT') continue;
    }
  }
  return runs;
}

/**
 * @param {string} model
 */
function isOpusModel(model) {
  return typeof model === 'string' && model.toLowerCase().includes('opus');
}

/**
 * @param {object} job
 */
function isOpusReviewJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (!isOpusModel(job.model ?? '')) return false;
  const type = String(job.type ?? '').toLowerCase();
  if (type === 'review' || type === 'acceptance') return true;
  return job.agent === 'claude';
}

/**
 * @param {object} job
 * @param {object} [state]
 */
function ticketFromReviewJob(job, state) {
  const direct = job.ticket ?? job.ticketId ?? state?.ticket ?? state?.ticketId;
  if (typeof direct === 'string' && TICKET_ID.test(direct)) return direct;
  if (typeof job.id === 'string') {
    if (TICKET_ID.test(job.id)) return job.id;
    const embedded = job.id.match(/T-\d{4,}/);
    if (embedded) return embedded[0];
  }
  return null;
}

/**
 * @param {readonly { state?: object }[]} runs
 */
export function collectOpusReaskHoldDrafts(runs) {
  /** @type {Map<string, number>} */
  const reasksByTicket = new Map();
  for (const { state } of runs ?? []) {
    if (!state) continue;
    for (const job of state.jobs ?? []) {
      if (!isOpusReviewJob(job)) continue;
      const ticket = ticketFromReviewJob(job, state);
      if (!ticket) continue;
      let add = 0;
      if (typeof job.reportReaskCount === 'number' && Number.isFinite(job.reportReaskCount) && job.reportReaskCount > 0) {
        add = job.reportReaskCount;
      } else if (job.reportReasked) {
        add = 1;
      }
      if (add < 1) continue;
      reasksByTicket.set(ticket, (reasksByTicket.get(ticket) ?? 0) + add);
    }
  }

  /** @type {Array<{ ticket: string, severity: 'warn', code: string, action: string, reason: string, recommendation: string }>} */
  const drafts = [];
  for (const [ticket, count] of reasksByTicket) {
    if (count < OPUS_REASK_HOLD_AFTER) continue;
    drafts.push({
      ticket,
      severity: 'warn',
      code: 'hold-opus-reask',
      action: HOLD_OPUS_REASK_ACTION,
      reason: `budget-hold-opus: ticket ${ticket} logged ${count} Opus acceptance review report re-asks (hold after ${OPUS_REASK_HOLD_AFTER}); further re-asks need allow-opus-loop or fixed review inputs`,
      recommendation:
        'Pause expensive Opus acceptance loops on this ticket until evidence and prompts are fixed, or enable allow-opus-loop if the extra reviews are intentional',
    });
  }
  return drafts;
}

class BudgetManager extends BaseManager {
  /**
   * @param {{
   *   root: string,
   *   modeSettings: ManagerActionModeSettings,
   *   trigger?: ManagerTrigger,
   *   fixture?: {
   *     day?: string,
   *     spendDir?: string,
   *     warnRatio?: number,
   *     tickets?: unknown[],
   *     runs?: { state?: object }[],
   *   },
   *   env?: NodeJS.ProcessEnv,
   *   now?: () => number,
   * }} config
   */
  constructor({ root, modeSettings, trigger = 'scope', fixture, env, now }) {
    super({ managerId: BUDGET_MANAGER_ID, root, modeSettings, trigger });
    this.fixture = fixture;
    this.env = env ?? process.env;
    this.now = now;
  }

  /**
   * @param {import('../base.mjs').ManagerRunContext} _ctx
   */
  async execute(_ctx) {
    const cap = await watchProjectCapForecast(this.root, {
      env: this.env,
      now: this.now,
      day: this.fixture?.day,
      dir: this.fixture?.spendDir,
      warnRatio: this.fixture?.warnRatio,
      tickets: this.fixture?.tickets,
      runs: this.fixture?.runs,
    });

    for (const draft of capWarnWatchItemsToFindingInputs(cap.items)) {
      assertBudgetOrchestratorSafeAction(draft.action);
      await this.emitFinding({
        severity: draft.severity,
        code: draft.code,
        reason: draft.reason,
        action: draft.action,
        recommendation: draft.recommendation,
      });
    }

    const runs = this.fixture?.runs ?? await readProjectRuns(this.root);
    for (const draft of collectOpusReaskHoldDrafts(runs)) {
      assertBudgetOrchestratorSafeAction(draft.action);
      await this.emitFinding({
        severity: draft.severity,
        code: draft.code,
        reason: draft.reason,
        action: draft.action,
        ticket: draft.ticket,
        recommendation: draft.recommendation,
      });
    }
  }
}

/**
 * @param {{
 *   managerId: import('../modes.mjs').ManagerId,
 *   root: string,
 *   modeSettings: ManagerActionModeSettings,
 *   trigger?: ManagerTrigger,
 *   fixture?: BudgetManager['fixture'],
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 * }} options
 */
export function createManager(options) {
  if (options.managerId !== BUDGET_MANAGER_ID) {
    throw new Error(`budget manager createManager expected managerId budget, got ${String(options.managerId)}`);
  }
  return new BudgetManager(options);
}

/**
 * @param {RunBuiltinManagerOptions & {
 *   fixture?: BudgetManager['fixture'],
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 * }} options
 */
export async function runBuiltinManager(options) {
  const manager = new BudgetManager({
    root: options.root,
    modeSettings: options.modeSettings,
    trigger: options.trigger ?? 'scope',
    fixture: options.fixture,
    env: options.env,
    now: options.now,
  });
  return manager.run({
    journal: options.journal,
    now: options.now,
    best: options.best,
  });
}

/** @type {typeof runBuiltinManager} */
export const run = runBuiltinManager;
