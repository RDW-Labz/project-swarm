// SPDX-License-Identifier: Apache-2.0
// Registry hooks for ticket-manager and unblocker slots (ids are sync; run modules load on register).

/** @typedef {'ticket-manager'|'unblocker'} TicketUnblockManagerId */

/** @type {TicketUnblockManagerId} */
export const TICKET_MANAGER_ID = 'ticket-manager';

/** @type {TicketUnblockManagerId} */
export const UNBLOCKER_ID = 'unblocker';

/**
 * Built-in manager ids for this slot group. Safe to import before run implementations load.
 *
 * @type {readonly TicketUnblockManagerId[]}
 */
export const ticketUnblockBuiltinManagerIds = Object.freeze([TICKET_MANAGER_ID, UNBLOCKER_ID]);

/**
 * Relative paths to per-manager run modules (loaded by {@link registerTicketUnblockBuiltinManagers}).
 *
 * @type {Readonly<Record<TicketUnblockManagerId, string>>}
 */
export const ticketUnblockBuiltinManagerRunRegistry = Object.freeze({
  [TICKET_MANAGER_ID]: `./run/${TICKET_MANAGER_ID}.mjs`,
  [UNBLOCKER_ID]: `./run/${UNBLOCKER_ID}.mjs`,
});

let registered = false;

/**
 * Wire ticket-manager and unblocker run functions into the built-in manager registry.
 *
 * @returns {Promise<void>}
 */
export async function registerTicketUnblockBuiltinManagers() {
  if (registered) return;
  registered = true;
  const { registerBuiltinManagerRun } = await import('../registry.mjs');
  for (const managerId of ticketUnblockBuiltinManagerIds) {
    const modulePath = ticketUnblockBuiltinManagerRunRegistry[managerId];
    const mod = await import(modulePath);
    const runFn = mod.runBuiltinManager ?? mod.default;
    if (typeof runFn !== 'function') throw new Error(`manager-run-missing: ${managerId}`);
    registerBuiltinManagerRun(managerId, runFn);
  }
}
