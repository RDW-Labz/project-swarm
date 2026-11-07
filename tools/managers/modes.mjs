// SPDX-License-Identifier: Apache-2.0
// Per-manager, per-action off / shadow / auto settings. New actions default to shadow; auto is refused until the owner enables it for that action.

/** @typedef {'budget'|'lane-health'|'version'|'ticket-manager'|'unblocker'|'merge-queue'|'lessons-keeper'|'visual-qa'} ManagerId */
/** @typedef {'off'|'shadow'|'auto'} ManagerActionMode */

/** @type {readonly ManagerId[]} */
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

/** @type {readonly ManagerActionMode[]} */
export const MANAGER_ACTION_MODES = Object.freeze(['off', 'shadow', 'auto']);

/** @type {ManagerActionMode} */
export const DEFAULT_MANAGER_ACTION_MODE = 'shadow';

const MANAGER_ID_SET = new Set(MANAGER_IDS);
const MANAGER_ACTION_MODE_SET = new Set(MANAGER_ACTION_MODES);

/**
 * @param {unknown} value
 * @returns {value is ManagerId}
 */
export function isManagerId(value) {
  return typeof value === 'string' && MANAGER_ID_SET.has(value);
}

/**
 * @param {unknown} value
 * @returns {value is ManagerActionMode}
 */
export function isManagerActionMode(value) {
  return typeof value === 'string' && MANAGER_ACTION_MODE_SET.has(value);
}

/**
 * @param {ManagerId} managerId
 * @param {string} action
 */
export function managerActionModeKey(managerId, action) {
  assertManagerId(managerId);
  assertActionName(action);
  return `${managerId}\0${action}`;
}

/**
 * @param {ManagerId} managerId
 */
function assertManagerId(managerId) {
  if (!isManagerId(managerId)) throw new Error(`Unknown manager id: ${String(managerId)}`);
}

/**
 * @param {string} action
 */
function assertActionName(action) {
  if (typeof action !== 'string' || action.length < 1 || action.length > 80) {
    throw new Error(`Invalid manager action name: ${String(action)}`);
  }
}

/**
 * @param {ManagerActionMode} mode
 */
function assertManagerActionMode(mode) {
  if (!isManagerActionMode(mode)) throw new Error(`Invalid manager action mode: ${String(mode)}`);
}

/**
 * @typedef {object} ManagerActionModeSettings
 * @property {Map<string, ManagerActionMode>} modes
 * @property {Set<string>} autoEnabled
 */

/**
 * @param {{ modes?: Record<string, Record<string, ManagerActionMode>>, autoEnabled?: Array<{ managerId: ManagerId, action: string }> }} [serialized]
 * @returns {ManagerActionModeSettings}
 */
export function createManagerActionModeSettings(serialized = {}) {
  /** @type {Map<string, ManagerActionMode>} */
  const modes = new Map();
  /** @type {Set<string>} */
  const autoEnabled = new Set();

  for (const entry of serialized.autoEnabled ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const { managerId, action } = entry;
    assertManagerId(managerId);
    assertActionName(action);
    autoEnabled.add(managerActionModeKey(managerId, action));
  }

  for (const [managerId, actions] of Object.entries(serialized.modes ?? {})) {
    assertManagerId(managerId);
    if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
      throw new Error(`Invalid manager action mode map for ${managerId}`);
    }
    for (const [action, mode] of Object.entries(actions)) {
      assertActionName(action);
      assertManagerActionMode(mode);
      const key = managerActionModeKey(managerId, action);
      if (mode === 'auto' && !autoEnabled.has(key)) {
        throw refuseAutoMode(managerId, action);
      }
      modes.set(key, mode);
    }
  }

  return { modes, autoEnabled };
}

/**
 * @param {ManagerId} managerId
 * @param {string} action
 */
function refuseAutoMode(managerId, action) {
  const error = new Error(
    `Manager action auto mode refused until explicitly enabled: ${managerId}/${action}`,
  );
  error.code = 'manager-action-auto-refused';
  return error;
}

/**
 * @param {ManagerActionModeSettings} settings
 * @param {ManagerId} managerId
 * @param {string} action
 * @returns {ManagerActionMode}
 */
export function getManagerActionMode(settings, managerId, action) {
  assertManagerId(managerId);
  assertActionName(action);
  return settings.modes.get(managerActionModeKey(managerId, action)) ?? DEFAULT_MANAGER_ACTION_MODE;
}

/**
 * @param {ManagerActionModeSettings} settings
 * @param {ManagerId} managerId
 * @param {string} action
 */
export function isManagerActionAutoEnabled(settings, managerId, action) {
  assertManagerId(managerId);
  assertActionName(action);
  return settings.autoEnabled.has(managerActionModeKey(managerId, action));
}

/**
 * Owner grant: an action may be set to auto only after this runs for that action.
 *
 * @param {ManagerActionModeSettings} settings
 * @param {ManagerId} managerId
 * @param {string} action
 */
export function enableManagerActionAuto(settings, managerId, action) {
  assertManagerId(managerId);
  assertActionName(action);
  settings.autoEnabled.add(managerActionModeKey(managerId, action));
}

/**
 * @param {ManagerActionModeSettings} settings
 * @param {ManagerId} managerId
 * @param {string} action
 * @param {ManagerActionMode} mode
 */
export function setManagerActionMode(settings, managerId, action, mode) {
  assertManagerActionMode(mode);
  const key = managerActionModeKey(managerId, action);
  if (mode === 'auto' && !settings.autoEnabled.has(key)) throw refuseAutoMode(managerId, action);
  settings.modes.set(key, mode);
}

/**
 * @param {ManagerActionMode} mode
 */
export function managerActionModeRunsManager(mode) {
  return mode !== 'off';
}

/**
 * @param {ManagerActionMode} mode
 */
export function managerActionModeAppliesChanges(mode) {
  return mode === 'auto';
}

/**
 * @param {ManagerActionMode} mode
 */
export function managerActionModeWritesJournal(mode) {
  return mode === 'shadow' || mode === 'auto';
}

/**
 * @param {ManagerActionModeSettings} settings
 */
export function serializeManagerActionModeSettings(settings) {
  /** @type {Record<string, Record<string, ManagerActionMode>>} */
  const modes = {};
  for (const [key, mode] of settings.modes.entries()) {
    const [managerId, action] = key.split('\0');
    if (!modes[managerId]) modes[managerId] = {};
    modes[managerId][action] = mode;
  }
  const autoEnabled = [...settings.autoEnabled].map(key => {
    const [managerId, action] = key.split('\0');
    return { managerId, action };
  });
  return { modes, autoEnabled };
}
