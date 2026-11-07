// SPDX-License-Identifier: Apache-2.0
// Built-in manager ids, action groups (safe vs needs-you), and run entry points for CLI and replay.

import { BaseManager } from './base.mjs';
import { isManagerId, MANAGER_IDS } from './modes.mjs';

/** @typedef {import('./modes.mjs').ManagerId} ManagerId */
/** @typedef {import('./modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerRun} ManagerRun */
/** @typedef {import('../../contracts/managers.json').components.schemas.JournalReport} JournalReport */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerJournalLine} ManagerJournalLine */

/**
 * @typedef {object} ManagerActionGroups
 * @property {readonly string[]} safe
 * @property {readonly string[]} needsYou
 */

/**
 * @typedef {object} RunBuiltinManagerOptions
 * @property {string} root
 * @property {ManagerActionModeSettings} modeSettings
 * @property {ManagerTrigger} [trigger]
 * @property {(root: string, line: ManagerJournalLine, options?: object) => Promise<unknown>} [journal]
 * @property {() => number} [now]
 * @property {boolean} [best]
 */

/**
 * @typedef {(options: RunBuiltinManagerOptions) => Promise<{ run: ManagerRun, report: JournalReport|null }>} BuiltinManagerRun
 */

/**
 * @typedef {object} BuiltinManagerRegistryEntry
 * @property {ManagerId} managerId
 * @property {ManagerActionGroups} actionGroups
 * @property {BuiltinManagerRun} run
 */

/** @type {Readonly<Record<ManagerId, ManagerActionGroups>>} */
export const MANAGER_ACTION_GROUPS = Object.freeze({
  budget: Object.freeze({
    safe: Object.freeze(['warn-cap', 'hold-opus-reask', 'lower-wave-size']),
    needsYou: Object.freeze(['change-cap', 'allow-opus-loop']),
  }),
  'lane-health': Object.freeze({
    safe: Object.freeze(['pause-lane', 'reroute-tickets', 'unpause-lane', 'shrink-concurrency']),
    needsYou: Object.freeze(['lane-down-escalate']),
  }),
  version: Object.freeze({
    safe: Object.freeze(['bump-pointer', 'show-stale-banner', 'schedule-update-idle']),
    needsYou: Object.freeze(['update-mid-run']),
  }),
  'ticket-manager': Object.freeze({
    safe: Object.freeze(['add-context', 'normalize-names', 'split-ticket', 'move-to-checklist']),
    needsYou: Object.freeze(['change-acceptance', 'change-scope-tickets']),
  }),
  unblocker: Object.freeze({
    safe: Object.freeze([
      'add-context',
      'reset-stale-running',
      'reroute-lane',
      'split-ticket',
      'clear-retry-note',
    ]),
    needsYou: Object.freeze(['change-acceptance', 'change-cap', 'sensitive-change']),
  }),
  'merge-queue': Object.freeze({
    safe: Object.freeze(['bisect-batch', 'requeue-after-rebase', 'open-fix-ticket']),
    needsYou: Object.freeze(['merge-pr', 'change-required-check', 'accept-failed-check']),
  }),
  'lessons-keeper': Object.freeze({
    safe: Object.freeze(['write-lesson-draft', 'propose-template-change']),
    needsYou: Object.freeze(['change-routing', 'change-splitter-prompt', 'change-templates']),
  }),
  'visual-qa': Object.freeze({
    safe: Object.freeze(['attach-screenshots', 'attach-axe-report', 'open-axe-fix-ticket']),
    needsYou: Object.freeze(['accept-visual-diff', 'change-design-system']),
  }),
});

class BuiltinManagerStub extends BaseManager {
  /** @param {ConstructorParameters<typeof BaseManager>[0]} config */
  constructor(config) {
    super(config);
  }

  async execute(_ctx) {
    // Orchestrator implementations wire in via registerBuiltinManagerRun (follow-up tickets).
  }
}

/**
 * @param {ManagerId} managerId
 * @param {RunBuiltinManagerOptions} options
 * @returns {Promise<{ run: ManagerRun, report: JournalReport|null }>}
 */
async function defaultBuiltinManagerRun(managerId, options) {
  const manager = new BuiltinManagerStub({
    managerId,
    root: options.root,
    modeSettings: options.modeSettings,
    trigger: options.trigger ?? 'scope',
  });
  return manager.run({
    journal: options.journal,
    now: options.now,
    best: options.best,
  });
}

/** @type {Map<ManagerId, BuiltinManagerRun>} */
const customRuns = new Map();

/**
 * Replace the run implementation for one built-in manager (or restore the default with `null`).
 *
 * @param {ManagerId} managerId
 * @param {BuiltinManagerRun|null} runFn
 */
export function registerBuiltinManagerRun(managerId, runFn) {
  if (!isManagerId(managerId)) throw new Error(`Unknown manager id: ${String(managerId)}`);
  if (runFn === null) {
    customRuns.delete(managerId);
    return;
  }
  if (typeof runFn !== 'function') throw new Error('manager-run-fn-invalid');
  customRuns.set(managerId, runFn);
}

/**
 * @param {ManagerId} managerId
 * @param {RunBuiltinManagerOptions} options
 * @returns {Promise<{ run: ManagerRun, report: JournalReport|null }>}
 */
export async function runBuiltinManager(managerId, options) {
  if (!isManagerId(managerId)) throw new Error(`Unknown manager id: ${String(managerId)}`);
  const runFn = customRuns.get(managerId) ?? ((opts) => defaultBuiltinManagerRun(managerId, opts));
  return runFn(options);
}

/**
 * @param {ManagerId} managerId
 * @returns {BuiltinManagerRegistryEntry}
 */
export function getBuiltinManager(managerId) {
  if (!isManagerId(managerId)) throw new Error(`Unknown manager id: ${String(managerId)}`);
  const entry = BUILTIN_MANAGER_REGISTRY[managerId];
  if (!entry) throw new Error(`Unknown manager id: ${String(managerId)}`);
  return entry;
}

/**
 * @param {ManagerId} managerId
 * @param {string} action
 * @returns {'safe'|'needsYou'|null}
 */
export function managerActionGroup(managerId, action) {
  const groups = MANAGER_ACTION_GROUPS[managerId];
  if (!groups) return null;
  if (groups.safe.includes(action)) return 'safe';
  if (groups.needsYou.includes(action)) return 'needsYou';
  return null;
}

/** @type {Readonly<Record<ManagerId, BuiltinManagerRegistryEntry>>} */
export const BUILTIN_MANAGER_REGISTRY = Object.freeze(
  Object.fromEntries(
    MANAGER_IDS.map((managerId) => {
      const actionGroups = MANAGER_ACTION_GROUPS[managerId];
      if (!actionGroups) throw new Error(`Missing action groups for manager: ${managerId}`);
      /** @type {BuiltinManagerRegistryEntry} */
      const entry = Object.freeze({
        managerId,
        actionGroups,
        run: (options) => runBuiltinManager(managerId, options),
      });
      return [managerId, entry];
    }),
  ),
);

/** @type {readonly ManagerId[]} */
export const builtinManagerIds = MANAGER_IDS;
