// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  boardLine,
  loadTunerState,
  resolveMachineLimit,
  saveTunerState,
  tickAutotune,
  validateMachineLimitConfig,
} from '../tools/machine-limit.mjs';

const machine = { cores: 8, freeRamGb: 16, totalRamGb: 32, cpuPercent: 20 };

test('resolveMachineLimit uses config number', () => {
  const r = resolveMachineLimit({ config: { machineConcurrency: 12 }, machine, env: {} });
  assert.deepEqual(r, { limit: 12, source: 'config', reason: 'fixed' });
});

test('resolveMachineLimit auto without state uses hardware default', () => {
  const r = resolveMachineLimit({ config: { machineConcurrency: 'auto' }, state: null, machine, env: {} });
  assert.equal(r.source, 'auto-default');
  assert.equal(r.reason, 'auto-default');
  assert.equal(r.limit, 16);
});

test('resolveMachineLimit auto with persisted state', () => {
  const r = resolveMachineLimit({
    config: { machineConcurrencyAuto: true },
    state: { version: 1, limit: 22 },
    machine,
    env: {},
  });
  assert.deepEqual(r, { limit: 22, source: 'auto-state', reason: 'auto-state' });
});

test('resolveMachineLimit env overrides config and state', () => {
  const r = resolveMachineLimit({
    config: { machineConcurrency: 5 },
    state: { version: 1, limit: 40 },
    machine,
    env: { SWARM_MACHINE_CONCURRENCY: '9' },
  });
  assert.deepEqual(r, { limit: 9, source: 'env', reason: 'env' });
});

test('validateMachineLimitConfig rejects invalid values', () => {
  assert.deepEqual(validateMachineLimitConfig({ machineConcurrency: 'auto' }), []);
  assert.deepEqual(validateMachineLimitConfig({ machineConcurrency: 8 }), []);
  assert.deepEqual(
    validateMachineLimitConfig({ machineConcurrency: 0 }),
    ['machineConcurrency must be a positive integer or auto'],
  );
  assert.deepEqual(
    validateMachineLimitConfig({ machineConcurrency: 'fast' }),
    ['machineConcurrency must be a positive integer or auto'],
  );
  assert.deepEqual(
    validateMachineLimitConfig({ machineConcurrency: 300 }),
    ['machineConcurrency must be at most 256'],
  );
});

test('loadTunerState tolerates missing and corrupt files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ml-'));
  const file = path.join(dir, 'autotune-state.json');
  assert.equal(await loadTunerState(file, fs), null);
  await fs.writeFile(file, '{not json');
  assert.equal(await loadTunerState(file, fs), null);
  await fs.writeFile(file, JSON.stringify({ version: 1, limit: 999 }));
  assert.equal(await loadTunerState(file, fs), null);
  await fs.writeFile(file, JSON.stringify({ version: 1, limit: 10 }));
  assert.deepEqual(await loadTunerState(file, fs), { version: 1, limit: 10 });
});

test('saveTunerState writes atomically with version', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ml-save-'));
  const file = path.join(dir, 'nested', 'autotune-state.json');
  await saveTunerState(file, { limit: 14, laneCaps: { version: 1, initial: 14, min: 1, lanes: {} } }, fs);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.limit, 14);
  const entries = await fs.readdir(dir);
  assert.ok(!entries.some(name => name.endsWith('.tmp')));
});

test('tickAutotune raises limit when idle and work waits', () => {
  const first = tickAutotune({
    state: { version: 1, limit: 10 },
    machine: { ...machine, cpuPercent: 10 },
    inUse: 2,
    waiting: 3,
    now: 1_000,
  });
  assert.equal(first.limit, 11);
  assert.equal(first.reason, 'none');
  assert.equal(first.capped, 'none');
});

test('tickAutotune backs off on rate limited lane and records lane cap', () => {
  const before = tickAutotune({
    state: { version: 1, limit: 20 },
    machine: { ...machine, cpuPercent: 10 },
    inUse: 5,
    waiting: 2,
    rateLimitedLanes: ['claude'],
    now: 5_000,
  });
  assert.equal(before.reason, 'lane-rate-limit');
  assert.equal(before.capped, 'lane-rate-limit');
  assert.equal(before.limit, 15);
  assert.equal(before.laneCaps.cap('claude'), 15);
  assert.ok(before.state.laneCaps.lanes.claude);
});

test('boardLine describes each capped reason', () => {
  assert.equal(
    boardLine({ limit: 8, inUse: 3, capped: 'none', cpuPercent: 10, freeRamGb: 16 }),
    'limit 8, in use 3, not capped',
  );
  assert.equal(
    boardLine({ limit: 8, inUse: 3, capped: 'cpu', cpuPercent: 90, freeRamGb: 16 }),
    'limit 8, in use 3, capped by CPU 90 percent',
  );
  assert.equal(
    boardLine({ limit: 8, inUse: 3, capped: 'ram', cpuPercent: 10, freeRamGb: 3 }),
    'limit 8, in use 3, capped by RAM 3 GB free',
  );
  assert.equal(
    boardLine({ limit: 8, inUse: 3, capped: 'lane-rate-limit', cpuPercent: 10, freeRamGb: 16 }),
    'limit 8, in use 3, capped by lane rate limit',
  );
  assert.equal(
    boardLine({ limit: 8, inUse: 3, capped: 'no-ready-tickets', cpuPercent: 10, freeRamGb: 16 }),
    'limit 8, in use 3, capped by no ready tickets',
  );
});
