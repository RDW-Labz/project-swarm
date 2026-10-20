// SPDX-License-Identifier: Apache-2.0
export function assertTestIsolation(what, env = process.env) {
  if (!env.NODE_TEST_CONTEXT) return;
  if (env.SWARM_TEST_ISOLATED) return;
  throw new Error(
    `test-not-isolated: ${what} would use a real machine path; tests must run through npm test or with node --import ./tests/_isolate-config.mjs --test`,
  );
}
