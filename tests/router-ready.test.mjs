// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeJob } from '../tools/router.mjs';

const lanes = { anthropic: { model: 'anthropic-model' }, rented: { model: 'rented-model' } };
const job = { id: 'ready-job', agent: 'auto', sensitive: false, outputs: ['src/a.js'], context: ['src/a.js', 'docs/contract.md'], contract: 'docs/contract.md', acceptance: ['tests/a.test.mjs'] };

test('rented is not chosen at 699 ready jobs', () => {
  assert.equal(routeJob(job, { lanes, ready: 699 }).agent, 'anthropic');
});

test('rented is chosen at exactly 700 ready jobs for a complete non-sensitive contract job', () => {
  assert.equal(routeJob(job, { lanes, ready: 700 }).agent, 'rented');
});

test('a sensitive job never routes to rented, at any ready count', () => {
  for (const ready of [699, 700, 100000]) {
    assert.notEqual(routeJob({ ...job, sensitive: true }, { lanes, ready }).agent, 'rented');
  }
});

test('lanes.rented.minReady overrides the default threshold', () => {
  const lowered = { ...lanes, rented: { model: 'rented-model', minReady: 5 } };
  assert.equal(routeJob(job, { lanes: lowered, ready: 5 }).agent, 'rented');
  assert.equal(routeJob(job, { lanes: lowered, ready: 4 }).agent, 'anthropic');
});
