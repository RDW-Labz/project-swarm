// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  SPLIT_WAVE_LIMITS,
  simulateBeforeIngest,
  simulateSplitWaves,
  assessSplitWaveSimulation,
} from '../tools/split-wave-sim.mjs';

const fixture = async file => JSON.parse(await fs.readFile(new URL(`./fixtures/ledgers/${file}`, import.meta.url), 'utf8'));

test('roadmap ledger remains healthy at the injected 16-slot machine limit', async () => {
  const ledger = await fixture('roadmap-ledger.json');
  const sim = simulateBeforeIngest(ledger.tickets, 16);
  assert.equal(sim.ticketCount, 225);
  assert.equal(sim.waveCount, 15);
  assert.equal(sim.criticalPathLength, 15);
  assert.equal(Math.round(sim.criticalPathTicketRatio * 100), 7);
  assert.equal(Math.round(sim.averageFill * 100), 59);
  assert.equal(sim.ok, true);
  assert.deepEqual(sim.reasons, []);
});

test('anonymized parts-app ledger is assessed without crashing', async () => {
  const ledger = await fixture('parts-app-ledger.anon.json');
  const sim = simulateBeforeIngest(ledger.tickets, 8);
  assert.equal(sim.ticketCount, 340);
  assert.equal(sim.waveCount, 21);
  assert.equal(sim.criticalPathLength, 21);
  assert.equal(sim.ok, true);
  assert.equal(sim.reasons.length, 0);
  assert.ok(sim.averageFill > SPLIT_WAVE_LIMITS.minAverageFillFraction);
});

test('cancelled and proposed tickets do not distort wave thresholds', () => {
  const sim = simulateSplitWaves([
    { id: 'T-0001', status: 'todo', dependsOn: [] },
    { id: 'T-0002', status: 'cancelled', dependsOn: ['T-0001'] },
    { id: 'T-0003', status: 'proposed', dependsOn: ['T-0002'] },
  ], 2);
  assert.equal(sim.ticketCount, 1);
  assert.equal(sim.criticalPathLength, 1);
  assert.equal(sim.averageFill, 0.5);
  const assessment = assessSplitWaveSimulation(sim);
  assert.equal(assessment.ok, false);
  assert.deepEqual(assessment.reasons.map(reason => reason.code), ['critical-path-long']);
});

test('R-012 thresholds fail only when strictly beyond their limits', () => {
  const healthy = simulateBeforeIngest([
    { id: 'T-0001', status: 'todo', dependsOn: [] },
    { id: 'T-0002', status: 'todo', dependsOn: [] },
    { id: 'T-0003', status: 'todo', dependsOn: [] },
    { id: 'T-0004', status: 'todo', dependsOn: [] },
  ], 8);
  assert.equal(healthy.averageFill, SPLIT_WAVE_LIMITS.minAverageFillFraction);
  assert.equal(healthy.criticalPathTicketRatio, SPLIT_WAVE_LIMITS.maxCriticalPathTicketFraction);
  assert.equal(healthy.ok, true);

  const failing = simulateBeforeIngest([
    { id: 'T-0001', status: 'todo', dependsOn: [] },
    { id: 'T-0002', status: 'todo', dependsOn: ['T-0001'] },
    { id: 'T-0003', status: 'todo', dependsOn: ['T-0002'] },
    { id: 'T-0004', status: 'todo', dependsOn: ['T-0003'] },
  ], 8);
  assert.equal(failing.ok, false);
  assert.ok(failing.reasons.some(reason => reason.code === 'critical-path-long'));
  assert.ok(failing.reasons.some(reason => reason.code === 'low-wave-fill'));
});
