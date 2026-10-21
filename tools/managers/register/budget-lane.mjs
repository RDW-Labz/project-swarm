// SPDX-License-Identifier: Apache-2.0
// Registry hooks for the budget and lane-health built-in manager slots (R-037 / T-0179).

import { isManagerId } from '../modes.mjs';
import {
  getBuiltinManager,
  registerBuiltinManagerRun,
} from '../registry.mjs';

/** @typedef {import('../modes.mjs').ManagerId} ManagerId */
/** @typedef {import('../registry.mjs').BuiltinManagerRegistryEntry} BuiltinManagerRegistryEntry */
/** @typedef {import('../registry.mjs').BuiltinManagerRun} BuiltinManagerRun */

/** @type {ManagerId} */
export const BUDGET_MANAGER_ID = 'budget';

/** @type {ManagerId} */
export const LANE_HEALTH_MANAGER_ID = 'lane-health';

/**
 * Budget and lane-health ids exposed before orchestrator modules load (AC1).
 *
 * @type {readonly [ManagerId, ManagerId]}
 */
export const BUDGET_LANE_MANAGER_SLOT_IDS = Object.freeze([
  BUDGET_MANAGER_ID,
  LANE_HEALTH_MANAGER_ID,
]);

/** @type {Readonly<Set<ManagerId>>} */
const BUDGET_LANE_MANAGER_SLOT_ID_SET = new Set(BUDGET_LANE_MANAGER_SLOT_IDS);

/**
 * @param {ManagerId} managerId
 */
function assertBudgetLaneManagerId(managerId) {
  if (!BUDGET_LANE_MANAGER_SLOT_ID_SET.has(managerId)) {
    throw new Error(`Not a budget/lane-health manager id: ${String(managerId)}`);
  }
}

/**
 * @param {unknown} managerId
 * @returns {managerId is ManagerId}
 */
export function isBudgetLaneManagerId(managerId) {
  return isManagerId(managerId) && BUDGET_LANE_MANAGER_SLOT_ID_SET.has(managerId);
}

/**
 * Built-in registry entries for this slot group (action groups and run entry points).
 * Does not load budget or lane-health orchestrator modules.
 *
 * @returns {Readonly<Record<'budget' | 'lane-health', BuiltinManagerRegistryEntry>>}
 */
export function budgetLaneBuiltinManagers() {
  return Object.freeze({
    [BUDGET_MANAGER_ID]: getBuiltinManager(BUDGET_MANAGER_ID),
    [LANE_HEALTH_MANAGER_ID]: getBuiltinManager(LANE_HEALTH_MANAGER_ID),
  });
}

/**
 * @param {ManagerId} managerId
 * @returns {Promise<{ runBuiltinManager: BuiltinManagerRun }>}
 */
async function importBudgetLaneOrchestrator(managerId) {
  assertBudgetLaneManagerId(managerId);
  if (managerId === BUDGET_MANAGER_ID) {
    return import('../budget.mjs');
  }
  return import('../lane-health.mjs');
}

/**
 * @param {ManagerId} managerId
 * @returns {BuiltinManagerRun}
 */
function lazyBudgetLaneManagerRun(managerId) {
  /** @type {BuiltinManagerRun | null} */
  let delegated = null;
  return async (options) => {
    if (!delegated) {
      const mod = await importBudgetLaneOrchestrator(managerId);
      if (typeof mod.runBuiltinManager !== 'function') {
        throw new Error(`manager-run-missing: ${managerId}`);
      }
      delegated = mod.runBuiltinManager;
    }
    return delegated(options);
  };
}

let budgetLaneHooksRegistered = false;

/**
 * Install registry run hooks that load orchestrator modules on first use (T-0193, T-0196).
 */
export function registerBudgetLaneManagerHooks() {
  if (budgetLaneHooksRegistered) return;
  budgetLaneHooksRegistered = true;
  for (const managerId of BUDGET_LANE_MANAGER_SLOT_IDS) {
    registerBuiltinManagerRun(managerId, lazyBudgetLaneManagerRun(managerId));
  }
}
