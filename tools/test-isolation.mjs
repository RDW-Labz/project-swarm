// SPDX-License-Identifier: Apache-2.0

const HINT =
  'run tests with npm test or node --import ./tests/_isolate-config.mjs --test';

/** Throw when node:test runs without tests/_isolate-config.mjs and would hit real machine paths. */
export function assertTestIsolation(what, env = process.env) {
  if (!env.NODE_TEST_CONTEXT) return;
  if (env.SWARM_TEST_ISOLATED) return;
  throw new Error(`test-not-isolated: ${what} would use a real machine path; ${HINT}`);
}
