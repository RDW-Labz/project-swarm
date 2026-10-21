// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HERMES_CAP_BYTES,
  CHEAP_LANE_ORDER,
  capBytesForLane,
  isInPlaceLane,
  sizeTicketForLane,
  fittingLanes,
  adviseTicketLane,
  ticketByteTotal,
} from '../tools/lane-size.mjs';

function outputsTicket(files, extra) {
  const ticket = { id: 't1', files: files.slice(), outputs: files.slice() };
  return Object.assign(ticket, extra || {});
}

test('AC1: Hermes lane rejects a single file above 80% of the 15 KB cap', () => {
  const ticket = outputsTicket(['big.js']);
  const result = sizeTicketForLane(ticket, 'hermes', { sizes: { 'big.js': 12289 } });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('big.js') && r.includes('bytes')));
});

test('AC1: in-place cursor lane allows the same file bytes Hermes rejects', () => {
  const ticket = outputsTicket(['big.js']);
  const sizes = { 'big.js': 12289 };
  assert.equal(sizeTicketForLane(ticket, 'hermes', { sizes }).ok, false);
  assert.equal(sizeTicketForLane(ticket, 'cursor', { sizes }).ok, true);
});

test('AC1: per-lane capBytes overrides change which API lane fits', () => {
  const ticket = outputsTicket(['a.js']);
  const sizes = { 'a.js': 3500 };
  assert.equal(sizeTicketForLane(ticket, 'hermes', { sizes, laneCaps: { hermes: 4000 } }).ok, false);
  assert.equal(sizeTicketForLane(ticket, 'anthropic', { sizes, laneCaps: { anthropic: 8000 } }).ok, true);
});

test('AC1: ticketByteTotal sums declared output files only', () => {
  const ticket = outputsTicket(['a.js', 'b.js', 'dir/']);
  assert.equal(ticketByteTotal(ticket, { 'a.js': 10, 'b.js': 20 }), 30);
});

test('AC2: advise routes to an in-place lane when every API cheap lane is over byte budget', () => {
  const ticket = outputsTicket(['huge.js']);
  const sizes = { 'huge.js': 20000 };
  const advice = adviseTicketLane(ticket, { sizes, lanes: CHEAP_LANE_ORDER });
  assert.equal(advice.ok, true);
  assert.equal(advice.action, 'route-in-place');
  assert.equal(isInPlaceLane(advice.lane), true);
  assert.ok(advice.reasons.length > 0);
});

test('AC2: advise returns split when the ticket exceeds file limits for every lane', () => {
  const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
  const advice = adviseTicketLane(outputsTicket(files), { sizes: {} });
  assert.equal(advice.ok, false);
  assert.equal(advice.action, 'split');
  assert.equal(advice.lane, null);
  assert.ok(advice.reasons.some((r) => r.includes('output files')));
});

test('fittingLanes lists API and in-place lanes that pass byte and file checks', () => {
  const ticket = outputsTicket(['small.js']);
  const sizes = { 'small.js': 100 };
  const fits = fittingLanes(ticket, { sizes });
  assert.ok(fits.includes('hermes'));
  assert.ok(fits.includes('cursor'));
});

test('capBytesForLane returns null for codex and the Hermes default for API lanes', () => {
  assert.equal(capBytesForLane('cursor'), null);
  assert.equal(capBytesForLane('codex:default'), null);
  assert.equal(capBytesForLane('hermes'), HERMES_CAP_BYTES);
});
