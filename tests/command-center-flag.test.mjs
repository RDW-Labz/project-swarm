// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCenterEnabled } from '../tools/command-center-flag.mjs';

test('commandCenterEnabled is true by default', () => {
  assert.equal(commandCenterEnabled({}, null), true);
  assert.equal(commandCenterEnabled({}, {}), true);
  assert.equal(commandCenterEnabled({ SWARM_COMMAND_CENTER: 'true' }, {}), true);
});

test('commandCenterEnabled is false for SWARM_COMMAND_CENTER=0 or config.commandCenter false', () => {
  assert.equal(commandCenterEnabled({ SWARM_COMMAND_CENTER: '0' }, null), false);
  assert.equal(commandCenterEnabled({ SWARM_COMMAND_CENTER: '0' }, { commandCenter: true }), false);
  assert.equal(commandCenterEnabled({}, { commandCenter: false }), false);
});

test('commandCenterEnabled follows env SWARM_COMMAND_CENTER=1', () => {
  assert.equal(commandCenterEnabled({ SWARM_COMMAND_CENTER: '1' }, null), true);
  assert.equal(commandCenterEnabled({ SWARM_COMMAND_CENTER: '1' }, { commandCenter: false }), true);
});

test('commandCenterEnabled follows config.commandCenter true', () => {
  assert.equal(commandCenterEnabled({}, { commandCenter: true }), true);
});
