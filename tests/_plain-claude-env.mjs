// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

const PAID_KEY_NAMES = ['ANTHROPIC_API_KEY', 'SWARM_CLAUDE_WORKER_API_KEY'];

/** Put fake paid keys and a marker in process.env for the duration of a test. */
export function withPaidKeys(t) {
  const saved = {};
  for (const key of [...PAID_KEY_NAMES, 'SWARM_TEST_ENV_MARKER']) {
    saved[key] = process.env[key];
  }
  process.env.ANTHROPIC_API_KEY = 'ab'.repeat(16);
  process.env.SWARM_CLAUDE_WORKER_API_KEY = 'cd'.repeat(16);
  process.env.SWARM_TEST_ENV_MARKER = 'kept';
  t.after(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

/** Assert env matches plainClaudeJobEnv(process.env): copy minus ambient paid keys. */
export function assertPlainClaudeEnv(env) {
  assert.equal(typeof env, 'object');
  assert.notEqual(env, null);
  assert.notEqual(env, process.env);
  for (const key of PAID_KEY_NAMES) {
    assert.equal(Object.hasOwn(env, key), false);
  }
  for (const key of Object.keys(process.env)) {
    if (PAID_KEY_NAMES.includes(key)) continue;
    assert.equal(Object.hasOwn(env, key), true, `missing own key ${key}`);
    assert.equal(env[key], process.env[key], `value mismatch for ${key}`);
  }
  assert.equal(env.SWARM_TEST_ENV_MARKER, 'kept');
  for (const key of Object.keys(env)) {
    assert.equal(Object.hasOwn(process.env, key), true, `unexpected extra key ${key}`);
  }
}
