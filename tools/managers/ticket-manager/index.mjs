// SPDX-License-Identifier: Apache-2.0
// Ticket Manager orchestrator: scope-time gate blocks the run until checks pass (T-0201 / R-036 AC1).

import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseManager } from '../base.mjs';
import { managerActionModeAppliesChanges } from '../modes.mjs';
import { contextEnvFor, readProfile } from '../../scope-commands.mjs';
import { parseScope } from '../../scope.mjs';
import { checkTicketManagerScopeIntegrity } from './scope-integrity.mjs';

/** @typedef {import('../modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */
/** @typedef {import('../registry.mjs').RunBuiltinManagerOptions} RunBuiltinManagerOptions */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */

export const TICKET_MANAGER_ID = 'ticket-manager';

const SCOPE_GATE_ERROR_PREFIX = 'ticket-manager-scope-gate:';
const PROMOTE_ACTION = 'move-to-checklist';

/**
 * Whether a manager run outcome should block the orchestrator from starting a wave (scope gate).
 *
 * @param {{ run?: { status?: string, error?: string } }} [result]
 * @returns {boolean}
 */
export function orchestratorRunBlocked(result) {
  const run = result?.run;
  if (!run || run.status !== 'error') return false;
  return String(run.error ?? '').startsWith(SCOPE_GATE_ERROR_PREFIX);
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

/**
 * @param {string} root
 * @param {object|null|undefined} ledger
 * @param {object|null|undefined} fixtureScope
 */
async function resolveScope(root, ledger, fixtureScope) {
  if (fixtureScope && typeof fixtureScope === 'object' && !Array.isArray(fixtureScope)) {
    return fixtureScope;
  }
  const embedded = ledger?.scope;
  if (embedded && Array.isArray(embedded.requirements) && embedded.requirements.length > 0) {
    return embedded;
  }
  const snapshotFile = path.join(root, '.swarm', 'project', 'scope.snapshot.md');
  try {
    const text = await fs.readFile(snapshotFile, 'utf8');
    return parseScope(text);
  } catch (error) {
    if (error.code === 'ENOENT') return embedded && typeof embedded === 'object' ? embedded : {};
    throw error;
  }
}

/**
 * @param {object} gate
 */
function scopeGateFailureMessage(gate) {
  const needsYou = gate.findings.filter((f) => f.severity === 'needs_you').length;
  const parts = [];
  if (!gate.tree?.ok) parts.push('ticket tree has blocking errors');
  if (!gate.readyPool?.ok) {
    parts.push(
      `ready pool short of ${gate.readyPool?.min ?? 5} (${gate.readyPool?.readyCount ?? 0} ready)`,
    );
  }
  if (needsYou) parts.push(`${needsYou} finding(s) need the owner`);
  return parts.length ? parts.join('; ') : 'scope checks did not pass';
}

class TicketManager extends BaseManager {
  /**
   * @param {{
   *   root: string,
   *   modeSettings: ManagerActionModeSettings,
   *   trigger?: ManagerTrigger,
   *   fixture?: { ledger?: object, scope?: object },
   * }} config
   */
  constructor({ root, modeSettings, trigger = 'scope', fixture }) {
    super({ managerId: TICKET_MANAGER_ID, root, modeSettings, trigger });
    this.fixture = fixture;
  }

  /**
   * Ticket Manager runs at scope time (before the first wave).
   * @returns {boolean}
   */
  shouldRun() {
    return this.trigger === 'scope' || this.trigger === 'replay';
  }

  /**
   * @param {import('../base.mjs').ManagerRunContext} ctx
   */
  async execute(_ctx) {
    const ledger = this.fixture?.ledger
      ? structuredClone(this.fixture.ledger)
      : await readProjectLedger(this.root);
    const scope = await resolveScope(this.root, ledger, this.fixture?.scope);
    const profile = await readProfile(this.root);
    const { exists, listFiles, sizes, profileContext } = contextEnvFor(this.root, profile);

    const gate = checkTicketManagerScopeIntegrity({
      scope,
      tickets: ledger.tickets,
      exists,
      listFiles,
      sizes,
      profileContext,
    });

    const persistPromotions =
      gate.promoted.length > 0 &&
      managerActionModeAppliesChanges(this.actionMode(PROMOTE_ACTION));
    const nextLedger = persistPromotions ? { ...ledger, tickets: gate.tickets } : null;

    for (const finding of gate.findings) {
      const input = {
        severity: finding.severity,
        code: finding.code,
        reason: finding.reason,
        action: finding.action,
      };
      if (finding.ticket !== undefined) input.ticket = finding.ticket;
      if (finding.gatesCount !== undefined) input.gatesCount = finding.gatesCount;
      if (finding.recommendation !== undefined) input.recommendation = finding.recommendation;

      const apply =
        finding.code === 'ready-pool-promote' && nextLedger
          ? async () => {
              await writeProjectLedger(this.root, nextLedger);
            }
          : undefined;

      await this.emitFinding(input, { apply });
    }

    if (!gate.ok) {
      throw new Error(`${SCOPE_GATE_ERROR_PREFIX} ${scopeGateFailureMessage(gate)}`);
    }
  }

  /**
   * @param {{
   *   journal?: (root: string, line: import('../journal.mjs').ManagerJournalLine, options?: object) => Promise<unknown>,
   *   now?: () => number,
   *   best?: boolean,
   * }} [options]
   * @returns {Promise<{ run: import('../../contracts/managers.json').components.schemas.ManagerRun, report: import('../../contracts/managers.json').components.schemas.JournalReport|null, blocksOrchestratorRun: boolean }>}
   */
  async run(options = {}) {
    const result = await super.run(options);
    return { ...result, blocksOrchestratorRun: orchestratorRunBlocked(result) };
  }
}

/**
 * @param {{
 *   managerId: import('../modes.mjs').ManagerId,
 *   root: string,
 *   modeSettings: ManagerActionModeSettings,
 *   trigger?: ManagerTrigger,
 *   fixture?: TicketManager['fixture'],
 * }} options
 */
export function createManager(options) {
  if (options.managerId !== TICKET_MANAGER_ID) {
    throw new Error(
      `ticket-manager createManager expected managerId ${TICKET_MANAGER_ID}, got ${String(options.managerId)}`,
    );
  }
  return new TicketManager(options);
}

/**
 * @param {RunBuiltinManagerOptions & { fixture?: TicketManager['fixture'] }} options
 */
export async function runBuiltinManager(options) {
  const manager = new TicketManager({
    root: options.root,
    modeSettings: options.modeSettings,
    trigger: options.trigger ?? 'scope',
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
