// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateSplitWaves,
  assessSplitWaveSimulation,
  simulateBeforeIngest,
  SPLIT_WAVE_LIMITS,
} from '../tools/split-wave-sim.mjs';

const t = (id, over = {}) => ({
  id,
  title: id,
  type: 'build',
  stage: 'S1',
  scopeRefs: ['R-001'],
  acceptance: ['ok'],
  files: [`src/${id}.mjs`],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  status: 'todo',
  ...over,
});

test('AC1: simulates ingest waves for the current slot count', () => {
  const tickets = [
    t('T-0001'),
    t('T-0002', { dependsOn: ['T-0001'] }),
    t('T-0003'),
    t('T-0004', { status: 'cancelled' }),
    t('T-0005', { status: 'proposed' }),
  ];
  const sim = simulateSplitWaves(tickets, 4);
  assert.equal(sim.slots, 4);
  assert.equal(sim.ticketCount, 3);
  assert.equal(sim.waveCount, 2);
  assert.deepEqual(sim.waves.map((w) => w.ticketIds), [['T-0001', 'T-0003'], ['T-0002']]);
  assert.equal(sim.waves[0].fill, 2 / 4);
  assert.equal(sim.waves[1].fill, 1 / 4);
  assert.ok(sim.averageFill > 0 && sim.averageFill <= 1);
  assert.equal(sim.criticalPathLength, 2);
});

test('AC2: recommends re-split or ask when critical path exceeds 25% of tickets', () => {
  const chain = ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005'].map((id, i, ids) =>
    t(id, { dependsOn: i ? [ids[i - 1]] : [] }),
  );
  const sim = simulateSplitWaves(chain, 8);
  assert.equal(sim.criticalPathLength, 5);
  assert.equal(sim.ticketCount, 5);
  assert.ok(sim.criticalPathTicketRatio > SPLIT_WAVE_LIMITS.maxCriticalPathTicketFraction);
  const assessment = assessSplitWaveSimulation(sim);
  assert.equal(assessment.ok, false);
  assert.equal(assessment.action, 'resplit-or-ask');
  assert.ok(assessment.reasons.some((r) => r.code === 'critical-path-long'));
});

test('AC2: recommends re-split or ask when average fill is under 50% of slots', () => {
  const tickets = [t('T-0001'), t('T-0002'), t('T-0003')];
  const sim = simulateSplitWaves(tickets, 8);
  assert.equal(sim.waveCount, 1);
  assert.equal(sim.averageFill, 3 / 8);
  assert.ok(sim.averageFill < SPLIT_WAVE_LIMITS.minAverageFillFraction);
  const gate = simulateBeforeIngest(tickets, 8);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.some((r) => r.code === 'low-wave-fill'));
});

test('healthy split proceeds before ingest', () => {
  const tickets = Array.from({ length: 20 }, (_, i) =>
    t(`T-${String(i + 1).padStart(4, '0')}`, { dependsOn: i >= 4 ? [`T-${String(i - 3).padStart(4, '0')}`] : [] }),
  );
  const gate = simulateBeforeIngest(tickets, 4);
  assert.equal(gate.ok, true);
  assert.equal(gate.action, 'proceed');
  assert.equal(gate.reasons.length, 0);
});

test('rejects non-positive slot counts', () => {
  assert.throws(() => simulateSplitWaves([], 0), { code: 'bad-slots' });
});
