// SPDX-License-Identifier: Apache-2.0
// Public entry for the swarm managers framework (replay harness, scorecard, registry).

/** @type {Readonly<string[]>} Stable framework submodule ids (tests/managers/framework.test.mjs). */
export const frameworkModuleIds = Object.freeze([
  'base',
  'journal',
  'modes',
  'registry',
  'replay',
  'scorecard',
  'types',
]);

/** @type {Readonly<Record<string, string>>} Paths relative to this package; used by tests/managers/framework.test.mjs. */
export const frameworkRegistry = Object.freeze(
  Object.fromEntries(frameworkModuleIds.map((id) => [id, `./${id}.mjs`])),
);

/** @type {Readonly<Record<string, string>>} @deprecated Use {@link frameworkRegistry}. */
export const frameworkModules = frameworkRegistry;

export * from './registry.mjs';
export * from './replay.mjs';
export * from './scorecard.mjs';
