// SPDX-License-Identifier: Apache-2.0
// Shared manager types aligned with contracts/managers.json. No runtime imports.

/**
 * @typedef {(
 *   | "budget"
 *   | "lane-health"
 *   | "version"
 *   | "ticket-manager"
 *   | "unblocker"
 *   | "merge-queue"
 *   | "lessons-keeper"
 *   | "visual-qa"
 * )} ManagerId
 * @exports ManagerId
 */

/**
 * Manager action mode (`ManagerActionMode` in the OpenAPI contract).
 * @typedef {("off" | "shadow" | "auto")} ManagerMode
 * @exports ManagerMode
 */

/**
 * Short action label on a finding or journal line (1-80 characters in the contract).
 * @typedef {string} ManagerAction
 * @exports ManagerAction
 */

/**
 * @typedef {Object} ManagerFinding
 * @property {string} id
 * @property {ManagerId} managerId
 * @property {"info" | "warn" | "needs_you"} severity
 * @property {string} code
 * @property {string} reason
 * @property {ManagerAction} action
 * @property {ManagerMode} mode
 * @property {string} [ticket]
 * @property {string} [lane]
 * @property {number} [gatesCount]
 * @property {string} [recommendation]
 * @exports ManagerFinding
 */

export {};
