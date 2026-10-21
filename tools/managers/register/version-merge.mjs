// SPDX-License-Identifier: Apache-2.0
// Registry hooks for the version and merge-queue manager implementation slots.

import { registerBuiltinManagerRun } from '../registry.mjs';

/** @typedef {import('../modes.mjs').ManagerId} ManagerId */
/** @typedef {import('../registry.mjs').RunBuiltinManagerOptions} RunBuiltinManagerOptions */
/** @typedef {import('../registry.mjs').BuiltinManagerRun} BuiltinManagerRun */

/** Stable hook id for coordinator manifests and incremental registry merges. */
export const managerRegisterHookId = 'version-merge';

/**
 * Built-in manager ids owned by this hook (available before implementation modules load).
 * @type {readonly ManagerId[]}
 */
export const managerSlotIds = Object.freeze(['version', 'merge-queue']);

/**
 * Implementation module paths relative to `tools/managers/` (not loaded until a run).
 * @type {Readonly<Partial<Record<ManagerId, string>>>}
 */
export const managerSlotRegistry = Object.freeze({
  version: './version.mjs',
  'merge-queue': './merge-queue.mjs',
});

const managersPackageUrl = new URL('../', import.meta.url);

/** @type {Map<ManagerId, Promise<BuiltinManagerRun>>} */
const pendingRuns = new Map();

/**
 * @param {ManagerId} managerId
 * @returns {Promise<BuiltinManagerRun>}
 */
async function loadManagerRun(managerId) {
  let pending = pendingRuns.get(managerId);
  if (!pending) {
    const rel = managerSlotRegistry[managerId];
    if (!rel) throw new Error(`Unknown manager slot: ${String(managerId)}`);
    const moduleUrl = new URL(rel, managersPackageUrl);
    pending = import(moduleUrl.href).then((mod) => {
      const run = mod.run;
      if (typeof run !== 'function') throw new Error(`manager-slot-run-missing: ${managerId}`);
      return run;
    });
    pendingRuns.set(managerId, pending);
  }
  return pending;
}

/**
 * Register lazy run entry points for the version and merge-queue slots.
 */
export function registerVersionMergeManagerSlots() {
  for (const managerId of managerSlotIds) {
    registerBuiltinManagerRun(managerId, async (options) => {
      const run = await loadManagerRun(managerId);
      return run(options);
    });
  }
}

registerVersionMergeManagerSlots();
