// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCenterEnabled } from '../tools/command-center-flag.mjs';

test('commandCenterEnabled is false by default', () => {
  assert.equal(commandCenterEnabled({}, null), false);
  assert.equal(commandCenterEnabled({ SWARM_COMMAND_CENTER: '0' }, {}), false);
  assert.equal(commandCenterEnabled({ SWARM_COMMAND_CENTER: 'true' }, {}), false);
});

test('commandCenterEnabled follows env SWARM_COMMAND_CENTER=1', () => {
  assert.equal(commandCenterEnabled({ SWARM_COMMAND_CENTER: '1' }, null), true);
});

test('commandCenterEnabled follows config.commandCenter', () => {
  assert.equal(commandCenterEnabled({}, { commandCenter: true }), true);
  assert.equal(commandCenterEnabled({ SWARM_COMMAND_CENTER: '1' }, { commandCenter: false }), true);
});
