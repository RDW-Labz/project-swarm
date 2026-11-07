// SPDX-License-Identifier: Apache-2.0
// Registry hooks for visual-qa and lessons-keeper built-in manager slots (T-0182).

/** @typedef {import('../modes.mjs').ManagerId} ManagerId */

/** @type {ManagerId} */
export const LESSONS_KEEPER_MANAGER_ID = 'lessons-keeper';

/** @type {ManagerId} */
export const VISUAL_QA_MANAGER_ID = 'visual-qa';

/** @type {readonly [ManagerId, ManagerId]} */
export const visualLessonsManagerIds = Object.freeze([
  LESSONS_KEEPER_MANAGER_ID,
  VISUAL_QA_MANAGER_ID,
]);

/**
 * Slot registry: manager ids are available before implementation modules load (AC1).
 *
 * @type {Readonly<{ managerIds: readonly [ManagerId, ManagerId] }>}
 */
export const registry = Object.freeze({
  managerIds: visualLessonsManagerIds,
});

/** @type {Readonly<Record<ManagerId, string>>} */
const RUN_IMPLEMENTATION_HREF = Object.freeze({
  [LESSONS_KEEPER_MANAGER_ID]: new URL('../lessons-keeper.mjs', import.meta.url).href,
  [VISUAL_QA_MANAGER_ID]: new URL('../visual-qa.mjs', import.meta.url).href,
});

/**
 * @param {unknown} value
 * @returns {ManagerId}
 */
async function assertManagerId(value) {
  const { isManagerId } = await import('../modes.mjs');
  if (!isManagerId(value)) throw new Error(`Unknown manager id: ${String(value)}`);
  return value;
}

/**
 * Wire custom run implementations when orchestrator modules exist (lazy import).
 *
 * @returns {Promise<void>}
 */
export async function registerBuiltinManagerHooks() {
  const { registerBuiltinManagerRun } = await import('../registry.mjs');

  for (const managerId of visualLessonsManagerIds) {
    await assertManagerId(managerId);
    const href = RUN_IMPLEMENTATION_HREF[managerId];
    try {
      const mod = await import(href);
      const runFn = mod.runBuiltinManager ?? mod.run ?? mod.default;
      if (typeof runFn !== 'function') continue;
      registerBuiltinManagerRun(managerId, runFn);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') continue;
      throw error;
    }
  }
}
