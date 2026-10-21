// SPDX-License-Identifier: Apache-2.0
// Merge queue manager orchestrator: watch, flaky-test fix tickets, ordered green merges (T-0213 / R-038).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BaseManager } from '../base.mjs';
import { managerActionGroup } from '../registry.mjs';
import { managerActionModeAppliesChanges, managerActionModeRunsManager } from '../modes.mjs';
import { addCiFixTicket } from '../../scope-commands.mjs';
import { fixTicketFromFailure } from '../../ci-hooks.mjs';
import { mergeSwarmPrStandingEnabled } from '../../handbuild.mjs';
import {
  mergeQueueWatchItemsToFindingInputs,
  watchMergeQueueRuns,
} from './watch.mjs';
import { mergeGreenPullRequestsInOrder } from './merge.mjs';

/** @typedef {import('../modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */
/** @typedef {import('../registry.mjs').RunBuiltinManagerOptions} RunBuiltinManagerOptions */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */
/** @typedef {import('./watch.mjs').MergeQueueWatchItem} MergeQueueWatchItem */

export const MERGE_QUEUE_MANAGER_ID = 'merge-queue';

export const MERGE_PR_ACTION = 'merge-pr';
export const OPEN_FIX_TICKET_ACTION = 'open-fix-ticket';
export const BISECT_BATCH_ACTION = 'bisect-batch';
export const REQUEUE_AFTER_REBASE_ACTION = 'requeue-after-rebase';

/**
 * Safe merge-queue actions this orchestrator emits (registry MANAGER_ACTION_GROUPS.merge-queue.safe).
 *
 * @type {readonly string[]}
 */
export const MERGE_QUEUE_ORCHESTRATOR_SAFE_ACTIONS = Object.freeze([
  BISECT_BATCH_ACTION,
  REQUEUE_AFTER_REBASE_ACTION,
  OPEN_FIX_TICKET_ACTION,
]);

const FLAKY_FAILURE_RE = /\b(flaky|flake|intermittent|1\s*in\s*\d+|fails?\s+~?\d)/i;

/**
 * @param {string} action
 */
function assertMergeQueueSafeAction(action) {
  if (!MERGE_QUEUE_ORCHESTRATOR_SAFE_ACTIONS.includes(action)) {
    throw new Error(`merge-queue-orchestrator-action-unknown: ${String(action)}`);
  }
  if (managerActionGroup(MERGE_QUEUE_MANAGER_ID, action) !== 'safe') {
    throw new Error(`merge-queue-orchestrator-action-not-safe: ${String(action)}`);
  }
}

for (const action of MERGE_QUEUE_ORCHESTRATOR_SAFE_ACTIONS) {
  assertMergeQueueSafeAction(action);
}

/**
 * @param {import('../modes.mjs').ManagerActionMode} mode
 * @returns {import('../modes.mjs').ManagerActionMode}
 */
function watchMergePrModeForOrchestrator(mode) {
  if (mode === 'auto') return 'off';
  return mode;
}

/**
 * @param {string} root
 * @returns {Promise<{ runId: string, state: object }[]>}
 */
async function readProjectRunRows(root) {
  const dir = path.join(root, '.swarm', 'runs');
  /** @type {{ runId: string, state: object }[]} */
  const rows = [];
  let ids = [];
  try {
    ids = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return rows;
    throw error;
  }
  for (const runId of ids) {
    const file = path.join(dir, runId, 'state.json');
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state && typeof state === 'object' && !Array.isArray(state)) {
        rows.push({ runId, state });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') continue;
    }
  }
  return rows;
}

/**
 * @param {string} root
 */
async function readProjectLedger(root) {
  const file = path.join(root, '.swarm', 'project', 'tickets.json');
  try {
    const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return { version: 1, tickets: [] };
    if (!Array.isArray(ledger.tickets)) ledger.tickets = [];
    return ledger;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, tickets: [] };
    throw error;
  }
}

/**
 * @param {object} ledger
 * @returns {Record<string, unknown>}
 */
function ticketsByIdFromLedger(ledger) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const ticket of ledger.tickets ?? []) {
    if (!ticket || typeof ticket !== 'object') continue;
    const id = ticket.id;
    if (typeof id === 'string' && id.length) out[id] = ticket;
  }
  return out;
}

/**
 * @param {unknown} state
 * @param {string} job
 * @returns {object|null}
 */
function mergeQueueBatchForJob(state, job) {
  const batches = state?.mergeQueue?.batches;
  if (!Array.isArray(batches)) return null;
  for (let i = batches.length - 1; i >= 0; i--) {
    const batch = batches[i];
    if (!batch || typeof batch !== 'object') continue;
    const jobs = (Array.isArray(batch.jobs) ? batch.jobs : Array.isArray(batch.jobIds) ? batch.jobIds : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? entry?.job))
      .filter(Boolean);
    if (jobs.includes(job)) return batch;
  }
  return null;
}

/**
 * @param {MergeQueueWatchItem} item
 * @param {object|null|undefined} state
 * @returns {boolean}
 */
export function mergeQueueFailureLooksFlaky(item, state) {
  const text = `${item.reason ?? ''}\n${item.recommendation ?? ''}`;
  if (FLAKY_FAILURE_RE.test(text)) return true;
  const job = item.job;
  if (!job || !state) return false;
  const batch = mergeQueueBatchForJob(state, job);
  if (!batch || batch.checks !== 'failed') return false;
  const results = Array.isArray(batch.checkResults) ? batch.checkResults : [];
  const failed = results.filter((row) => row && row.status === 'failed');
  if (failed.length !== 1) return false;
  const tail = typeof failed[0].tail === 'string' ? failed[0].tail : '';
  return FLAKY_FAILURE_RE.test(tail);
}

/**
 * @param {{
 *   item: MergeQueueWatchItem,
 *   state?: object|null,
 *   ticket?: unknown,
 *   batchNumber?: number,
 * }} input
 */
export function buildMergeQueueFixTicketPartial(input) {
  const { item } = input;
  const job = item.job ?? 'merge-queue';
  const checks = Array.isArray(item.checks) ? item.checks : [];
  const checkLabel = checks[0] ?? 'merge-queue-check';
  const batchNumber = input.batchNumber ?? 0;
  const ticket = input.ticket && typeof input.ticket === 'object' ? input.ticket : null;
  const files = Array.isArray(ticket?.files) ? ticket.files.filter((f) => typeof f === 'string') : [];

  const flaky = mergeQueueFailureLooksFlaky(item, input.state ?? null);
  const base = fixTicketFromFailure({
    kind: flaky ? `flaky ${checkLabel}` : checkLabel,
    batchNumber,
    files,
    tail: item.reason,
    summary: item.reason,
  });

  if (flaky) {
    base.title = `Fix flaky test ${checkLabel} (merge queue job ${job})`.slice(0, 140);
    base.acceptance = [
      `The flaky ${checkLabel} check is stabilized or quarantined; merge queue batches pass without re-running the same check to get green.`,
    ];
    base.notes = `${base.notes}\n\nDetected as flaky: do not re-run the same failing check to get green.`.slice(0, 600);
  }

  if (typeof ticket?.id === 'string') {
    base.dependsOn = [ticket.id];
  }

  return base;
}

/**
 * @param {string} root
 * @param {object} ledger
 * @param {string} job
 */
function ticketForJob(ledger, job) {
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : [];
  return (
    tickets.find((t) => t?.id === job) ??
    tickets.find((t) => typeof t?.id === 'string' && t.id.toUpperCase() === job.toUpperCase()) ??
    null
  );
}

/**
 * @param {string} root
 * @param {object} ledger
 * @param {string} job
 */
function openCiFixTicketExists(ledger, job) {
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : [];
  return tickets.some(
    (t) =>
      t?.origin === 'ci' &&
      t?.status !== 'cancelled' &&
      t?.status !== 'done' &&
      (t?.notes ?? '').includes(`merge queue job ${job}`),
  );
}

class MergeQueueManager extends BaseManager {
  /**
   * @param {{
   *   root: string,
   *   modeSettings: ManagerActionModeSettings,
   *   trigger?: ManagerTrigger,
   *   fixture?: {
   *     runs?: { runId: string, state: object }[],
   *     ledger?: object,
   *     prViews?: Record<string, unknown>,
   *     defaultBranch?: string|null,
   *     standingMergeApproval?: boolean|null,
   *     alreadyMergedPrs?: readonly number[],
   *     runMerge?: typeof import('../../merge-guard.mjs').runMerge,
   *   },
   *   home?: string,
   * }} config
   */
  constructor({ root, modeSettings, trigger = 'scope', fixture, home }) {
    super({ managerId: MERGE_QUEUE_MANAGER_ID, root, modeSettings, trigger });
    this.fixture = fixture;
    this.home = home ?? os.homedir();
  }

  /**
   * Merge queue manager runs after integration waves and in replay fixtures.
   * @returns {boolean}
   */
  shouldRun() {
    return (
      this.trigger === 'wave' ||
      this.trigger === 'integration' ||
      this.trigger === 'replay' ||
      this.trigger === 'idle'
    );
  }

  /**
   * @param {import('../base.mjs').ManagerRunContext} _ctx
   */
  async execute(_ctx) {
    const runs =
      this.fixture?.runs?.map((row) => ({
        runId: String(row.runId),
        state: row.state,
      })) ?? (await readProjectRunRows(this.root));

    const ledger = this.fixture?.ledger
      ? structuredClone(this.fixture.ledger)
      : await readProjectLedger(this.root);
    const ticketsById = ticketsByIdFromLedger(ledger);

    const prViews =
      this.fixture?.prViews && typeof this.fixture.prViews === 'object' ? this.fixture.prViews : {};
    const defaultBranch = this.fixture?.defaultBranch ?? null;
    const standing =
      this.fixture?.standingMergeApproval === null || this.fixture?.standingMergeApproval === undefined
        ? mergeSwarmPrStandingEnabled(this.home)
        : Boolean(this.fixture.standingMergeApproval);

    const mergePrMode = this.actionMode(MERGE_PR_ACTION);
    const watchMergeMode = watchMergePrModeForOrchestrator(mergePrMode);

    const watch = await watchMergeQueueRuns(runs, {
      root: this.root,
      ticketsById,
      prViews,
      defaultBranch,
      standingMergeApproval: standing,
      home: this.home,
      mergePrMode: watchMergeMode,
      alreadyMergedPrs: this.fixture?.alreadyMergedPrs,
      runMerge: this.fixture?.runMerge,
    });

    const activeState = runs.find((row) => row.state?.mergeQueue?.state === 'running')?.state ?? runs[0]?.state ?? null;

    for (const item of watch.items) {
      const draft = mergeQueueWatchItemsToFindingInputs([item])[0];
      if (!draft) continue;
      if (MERGE_QUEUE_ORCHESTRATOR_SAFE_ACTIONS.includes(draft.action)) {
        assertMergeQueueSafeAction(draft.action);
      }
      const apply =
        draft.action === OPEN_FIX_TICKET_ACTION &&
        managerActionModeAppliesChanges(this.actionMode(OPEN_FIX_TICKET_ACTION)) &&
        item.job &&
        !openCiFixTicketExists(ledger, item.job)
          ? async () => {
              const ticket = ticketForJob(ledger, item.job);
              const batch = mergeQueueBatchForJob(activeState, item.job);
              const partial = buildMergeQueueFixTicketPartial({
                item,
                state: activeState,
                ticket,
                batchNumber: typeof batch?.id === 'number' ? batch.id : Number(batch?.id) || 0,
              });
              partial.notes = `${partial.notes ?? ''}\nmerge queue job ${item.job}`.slice(0, 600);
              const id = await addCiFixTicket(this.root, partial);
              if (!id) throw new Error('merge-queue-fix-ticket-skipped');
            }
          : undefined;

      await this.emitFinding(
        {
          severity: draft.severity,
          code: draft.code,
          reason: draft.reason,
          action: draft.action,
          ...(draft.ticket ? { ticket: draft.ticket } : {}),
          ...(draft.recommendation ? { recommendation: draft.recommendation } : {}),
          ...(draft.gatesCount !== undefined ? { gatesCount: draft.gatesCount } : {}),
        },
        { apply },
      );
    }

    if (
      managerActionModeAppliesChanges(mergePrMode) &&
      watch.greenMerges.length > 0 &&
      managerActionModeRunsManager(mergePrMode)
    ) {
      const outcome = await mergeGreenPullRequestsInOrder({
        root: this.root,
        greenMerges: watch.greenMerges,
        prViews,
        defaultBranch,
        alreadyMergedPrs: this.fixture?.alreadyMergedPrs,
        runMerge: this.fixture?.runMerge,
      });

      for (const item of outcome.items) {
        await this.emitFinding({
          severity: item.severity,
          code: item.code,
          reason: item.reason,
          action: item.action,
          ...(item.ticket ? { ticket: item.ticket } : {}),
          ...(item.recommendation ? { recommendation: item.recommendation } : {}),
        });
      }
    }
  }
}

/**
 * @param {{
 *   managerId: import('../modes.mjs').ManagerId,
 *   root: string,
 *   modeSettings: ManagerActionModeSettings,
 *   trigger?: ManagerTrigger,
 *   fixture?: MergeQueueManager['fixture'],
 *   home?: string,
 * }} options
 */
export function createManager(options) {
  if (options.managerId !== MERGE_QUEUE_MANAGER_ID) {
    throw new Error(
      `merge-queue manager createManager expected managerId ${MERGE_QUEUE_MANAGER_ID}, got ${String(options.managerId)}`,
    );
  }
  return new MergeQueueManager(options);
}

/**
 * @param {RunBuiltinManagerOptions & {
 *   fixture?: MergeQueueManager['fixture'],
 *   home?: string,
 * }} options
 */
export async function runBuiltinManager(options) {
  const manager = new MergeQueueManager({
    root: options.root,
    modeSettings: options.modeSettings,
    trigger: options.trigger ?? 'scope',
    fixture: options.fixture,
    home: options.home,
  });
  return manager.run({
    journal: options.journal,
    now: options.now,
    best: options.best,
  });
}

/** @type {typeof runBuiltinManager} */
export const run = runBuiltinManager;
