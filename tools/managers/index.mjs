// SPDX-License-Identifier: Apache-2.0
// Public entry for the swarm managers framework (replay harness, scorecard, registry).

/** @type {Readonly<Record<string, string>>} */
export const frameworkModules = Object.freeze({
  base: './base.mjs',
  journal: './journal.mjs',
  modes: './modes.mjs',
  registry: './registry.mjs',
  replay: './replay.mjs',
  scorecard: './scorecard.mjs',
  types: './types.mjs',
});

export * from './replay.mjs';
export * from './scorecard.mjs';
