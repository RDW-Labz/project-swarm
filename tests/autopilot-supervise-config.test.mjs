// SPDX-License-Identifier: Apache-2.0
// The board's per-project autopilot supervisor is off unless the machine config turns it on.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { autopilotSuperviseEnabled, validateAutopilotBlock } from '../tools/local-config.mjs';

test('autopilot supervision is off by default and only a literal true turns it on', () => {
  assert.equal(autopilotSuperviseEnabled({}), false);
  assert.equal(autopilotSuperviseEnabled({ autopilot: {} }), false);
  assert.equal(autopilotSuperviseEnabled({ autopilot: { supervise: 'true' } }), false);
  assert.equal(autopilotSuperviseEnabled({ autopilot: { supervise: true } }), true);
});

test('autopilot.supervise must be a boolean', () => {
  assert.deepEqual(validateAutopilotBlock({ supervise: true }), []);
  assert.deepEqual(validateAutopilotBlock({ supervise: false, maxJobs: 3 }), []);
  assert.deepEqual(validateAutopilotBlock({ supervise: 'yes' }), ['autopilot.supervise: must be true or false']);
});
