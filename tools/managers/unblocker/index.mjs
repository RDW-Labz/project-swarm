// SPDX-License-Identifier: Apache-2.0
// Unblocker orchestrator: after each wave, apply ranked safe replans and report changes (T-0205 / R-013).

import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseManager } from '../base.mjs';
import { managerActionGroup } from '../registry.mjs';
import { managerActionModeAppliesChanges } from '../modes.mjs';
import { rankAndApplyBlockedReplans } from './rank.mjs';
import {
  UNBLOCKER_MANAGER_ID,
  buildUnblockerChangeReport,
  UNBLOCKER_REPLAN_FINDING_CODES,
} from './report.mjs';

/** @typedef {import('../modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */
/** @typedef {import('../registry.mjs').RunBuiltinManagerOptions} RunBuiltinManagerOptions */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */

export { UNBLOCKER_MANAGER_ID };

/**
 * Safe actions this orchestrator emits (subset of registry MANAGER_ACTION_GROUPS.unblocker.safe).
 *
 * @type {readonly string[]}
 */
export const UNBLOCKER_ORCHESTRATOR_SAFE_ACTIONS = Object.freeze([
  'add-context',
  'split-ticket',
  'reroute-lane',
]);

/**
 * @param {string} action
 */
function assertUnblockerOrchestratorSafeAction(action) {
  if (!UNBLOCKER_ORCHESTRATOR_SAFE_ACTIONS.includes(action)) {
    throw new Error(`unblocker-orchestrator-action-unknown: ${String(action)}`);
  }
  if (managerActionGroup(UNBLOCKER_MANAGER_ID, action) !== 'safe') {
    throw new Error(`unblocker-orchestrator-action-not-safe: ${String(action)}`);
  }
}

for (const action of UNBLOCKER_ORCHESTRATOR_SAFE_ACTIONS) {
  assertUnblockerOrchestratorSafeAction(action);
}

for (const code of UNBLOCKER_REPLAN_FINDING_CODES) {
  if (typeof code !== 'string' || code.length < 1) {
    throw new Error('unblocker-replan-finding-code-invalid');
  }
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
 * @param {string} root
 * @param {object} ledger
 */
async function writeProjectLedger(root, ledger) {
  const file = path.join(root, '.swarm', 'project', 'tickets.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(ledger)}\n`);
}

class UnblockerManager extends BaseManager {
  /**
   * @param {{
   *   root: string,
   *   modeSettings: ManagerActionModeSettings,
   *   trigger?: ManagerTrigger,
   *   fixture?: { ledger?: object },
   * }} config
   */
  constructor({ root, modeSettings, trigger = 'wave', fixture }) {
    super({ managerId: UNBLOCKER_MANAGER_ID, root, modeSettings, trigger });
    this.fixture = fixture;
  }

  /**
   * Unblocker runs after each orchestrator wave (and in replay fixtures).
   * @returns {boolean}
   */
  shouldRun() {
    return this.trigger === 'wave' || this.trigger === 'replay';
  }

  /**
   * @param {import('../base.mjs').ManagerRunContext} _ctx
   */
  async execute(_ctx) {
    const ledger = this.fixture?.ledger
      ? structuredClone(this.fixture.ledger)
      : await readProjectLedger(this.root);

    const { tickets, ranked, replans } = rankAndApplyBlockedReplans(ledger.tickets);
    const report = buildUnblockerChangeReport({ replans, ranked });
    const nextLedger = report.summary.total > 0 ? { ...ledger, tickets } : null;

    if (report.summary.total > 0) {
      await this.emitFinding({
        severity: 'info',
        code: 'unblocker-replan-summary',
        action: 'add-context',
        reason: report.headline,
      });
    }

    let ledgerPersisted = false;
    for (const finding of report.findings) {
      assertUnblockerOrchestratorSafeAction(finding.action);
      const persist =
        nextLedger &&
        managerActionModeAppliesChanges(this.actionMode(finding.action));
      await this.emitFinding(finding, {
        apply: persist
          ? async () => {
              if (ledgerPersisted) return;
              ledgerPersisted = true;
              await writeProjectLedger(this.root, nextLedger);
            }
          : undefined,
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
 *   fixture?: UnblockerManager['fixture'],
 * }} options
 */
export function createManager(options) {
  if (options.managerId !== UNBLOCKER_MANAGER_ID) {
    throw new Error(
      `unblocker createManager expected managerId ${UNBLOCKER_MANAGER_ID}, got ${String(options.managerId)}`,
    );
  }
  return new UnblockerManager(options);
}

/**
 * @param {RunBuiltinManagerOptions & { fixture?: UnblockerManager['fixture'] }} options
 */
export async function runBuiltinManager(options) {
  const manager = new UnblockerManager({
    root: options.root,
    modeSettings: options.modeSettings,
    trigger: options.trigger ?? 'wave',
    fixture: options.fixture,
  });
  return manager.run({
    journal: options.journal,
    now: options.now,
    best: options.best,
  });
}

/** @type {typeof runBuiltinManager} */
export const run = runBuiltinManager;
