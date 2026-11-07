// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTuner,
  DARWIN_MEMORY_PROBE_UNKNOWN_WARNING,
  memoryPressureLevel,
  parseDarwinVmStatAndSwap,
  parseLinuxMeminfo,
  projectedMemoryJobCap,
  readAvailableMemory,
} from '../tools/autotune.mjs';
import {
  applyNodeTestConcurrency,
  effectiveMachineLimit,
  gateVerifyArgvWithMemory,
  isNodeTestCommand,
  jobStartsForBatch,
  memoryPressureHoldLine,
  testConcurrencyFor,
} from '../tools/machine-limit.mjs';

const DARWIN_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
Pages active:                            50000.
Pages inactive:                          20000.
Pages speculative:                         500.
Pages purgeable:                           250.
`;

const DARWIN_SWAP = 'total = 8.00G  used = 2.50G  free = 5.50G  (encrypted)';

const LINUX_MEMINFO = `MemTotal:       32768000 kB
MemAvailable:    8388608 kB
SwapTotal:       4194304 kB
SwapFree:        3145728 kB
`;

describe('parseDarwinVmStatAndSwap', () => {
  it('sums reclaimable pages and parses swap usage', () => {
    const r = parseDarwinVmStatAndSwap(DARWIN_VM_STAT, DARWIN_SWAP);
    assert.ok(r);
    const expectedPages = 1000 + 20000 + 500 + 250;
    const expectedGb = (expectedPages * 16384) / 1024 ** 3;
    assert.ok(Math.abs(r.availRamGb - expectedGb) < 0.001);
    assert.ok(Math.abs(r.swapUsedGb - 2.5) < 0.01);
    assert.ok(Math.abs(r.swapTotalGb - 8) < 0.01);
  });
});

describe('parseLinuxMeminfo', () => {
  it('reads MemAvailable and swap counters', () => {
    const r = parseLinuxMeminfo(LINUX_MEMINFO);
    assert.ok(r);
    assert.ok(Math.abs(r.availRamGb - 8) < 0.01);
    assert.ok(Math.abs(r.swapTotalGb - 4) < 0.01);
    assert.ok(Math.abs(r.swapUsedGb - 1) < 0.01);
  });
});

describe('readAvailableMemory injectable exec', () => {
  it('uses exec on darwin without touching the real machine', async () => {
    const r = await readAvailableMemory({
      platform: 'darwin',
      exec: async (cmd, args = []) => {
        if (cmd === 'vm_stat') return DARWIN_VM_STAT;
        if (cmd === 'sysctl' && args[0] === 'vm.swapusage') return DARWIN_SWAP;
        throw new Error(`unexpected ${cmd}`);
      },
      os: { platform: () => 'darwin', freemem: () => 1 },
    });
    assert.ok(r.availRamGb > 0);
    assert.equal(r.swapUsedGb, 2.5);
  });

  it('falls back to os.freemem when parsing fails on linux', async () => {
    const r = await readAvailableMemory({
      platform: 'linux',
      exec: async () => {
        throw new Error('meminfo unavailable');
      },
      os: { platform: () => 'linux', freemem: () => 4 * 1024 ** 3 },
    });
    assert.equal(r.availRamGb, 4);
    assert.equal(r.swapUsedGb, 0);
    assert.equal(r.pressureUnknown, undefined);
  });

  it('darwin failed probe returns pressure-unknown (not freemem fallback)', async () => {
    const r = await readAvailableMemory({
      platform: 'darwin',
      exec: async () => 'garbage',
      os: { platform: () => 'darwin', freemem: () => 4 * 1024 ** 3 },
    });
    assert.equal(r.availRamGb, null);
    assert.equal(r.swapUsedGb, 0);
    assert.equal(r.pressureUnknown, true);
    assert.equal(r.warning, DARWIN_MEMORY_PROBE_UNKNOWN_WARNING);
    assert.equal(memoryPressureLevel(r, 'darwin'), 'ok');
  });
});

describe('memoryPressureLevel', () => {
  it('classifies hard, soft, and ok', () => {
    assert.equal(memoryPressureLevel({ availRamGb: 2.5 }, 'linux'), 'hard');
    assert.equal(memoryPressureLevel({ availRamGb: 2.5 }, 'darwin'), 'hard');
    assert.equal(memoryPressureLevel({ availRamGb: 10, swapUsedGb: 5 }, 'linux'), 'hard');
    assert.equal(memoryPressureLevel({ availRamGb: 10, swapUsedGb: 3, swapTotalGb: 4 }, 'linux'), 'hard');
    assert.equal(memoryPressureLevel({ availRamGb: 10, swapUsedGb: 5 }, 'darwin'), 'ok');
    assert.equal(memoryPressureLevel({ availRamGb: 10, swapUsedGb: 9 }, 'darwin'), 'soft');
    assert.equal(memoryPressureLevel({ availRamGb: 5 }, 'linux'), 'soft');
    assert.equal(memoryPressureLevel({ availRamGb: 5 }, 'darwin'), 'soft');
    assert.equal(memoryPressureLevel({ availRamGb: 10, swapUsedGb: 1.5 }, 'linux'), 'soft');
    assert.equal(memoryPressureLevel({ availRamGb: 10, swapUsedGb: 0.5 }, 'linux'), 'ok');
    assert.equal(memoryPressureLevel({ availRamGb: 10, swapUsedGb: 0.5 }, 'darwin'), 'ok');
    assert.equal(memoryPressureLevel({ pressureUnknown: true, availRamGb: null }), 'ok');
  });
});

describe('projectedMemoryJobCap', () => {
  it('caps by available memory minus 3 GB headroom', () => {
    assert.equal(projectedMemoryJobCap({ availRamGb: 9 }, 0.6), Math.floor(6 / 0.6));
    assert.equal(projectedMemoryJobCap({ availRamGb: 2 }, 0.6), 0);
  });
});

describe('createTuner memory pressure', () => {
  it('drops to floor at hard and never steps up under soft', () => {
    const tuner = createTuner({ limit: 20, min: 4, memoryFloor: 2 });
    const hard = tuner.tune({
      cpuPercent: 10,
      availRamGb: 2,
      freeRamGb: 2,
      swapUsedGb: 0,
      swapTotalGb: 0,
      inUse: 0,
      waiting: 5,
      rateLimitedLanes: [],
    });
    assert.equal(hard.limit, 2);
    assert.equal(hard.memoryPressure, 'hard');

    const soft = createTuner({ limit: 20, min: 4, memoryFloor: 2 });
    const softMachine = {
      cpuPercent: 10,
      availRamGb: 5,
      freeRamGb: 5,
      swapUsedGb: 0,
      swapTotalGb: 8,
      inUse: 0,
      waiting: 5,
      rateLimitedLanes: [],
    };
    const first = soft.tune(softMachine);
    assert.equal(first.memoryPressure, 'soft');
    const projectedCap = projectedMemoryJobCap({ availRamGb: softMachine.availRamGb });
    const expectedSoftLimit = Math.min(15, projectedCap > 0 ? projectedCap : 15);
    assert.equal(first.limit, expectedSoftLimit);
    const second = soft.tune({ ...softMachine, waiting: 10 });
    assert.ok(second.limit <= first.limit);
    assert.notEqual(second.limit, 21);
  });
});

describe('testConcurrencyFor', () => {
  it('returns 1 at hard, 2 at soft, else min(4, cores/2)', () => {
    assert.equal(testConcurrencyFor({ availRamGb: 2, cores: 16 }), 1);
    assert.equal(testConcurrencyFor({ availRamGb: 5, cores: 16 }), 2);
    assert.equal(testConcurrencyFor({ availRamGb: 16, cores: 10 }), 4);
    assert.equal(testConcurrencyFor({ availRamGb: 16, cores: 4 }), 2);
  });
});

describe('job start wiring', () => {
  it('starts zero jobs at hard and logs hold line', () => {
    const logs = [];
    const machine = { availRamGb: 2, swapUsedGb: 0, swapTotalGb: 8, cores: 8 };
    const r = jobStartsForBatch({
      limit: 16,
      running: 2,
      machine,
      log: (line) => logs.push(line),
    });
    assert.equal(r.starts, 0);
    assert.equal(r.pressure, 'hard');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /held by memory pressure/);
    assert.equal(memoryPressureHoldLine(machine), logs[0]);
  });

  it('shrinks headroom at soft pressure', () => {
    const machine = { availRamGb: 5, swapUsedGb: 0, swapTotalGb: 8, cores: 8 };
    const ok = jobStartsForBatch({ limit: 16, running: 2, machine: { ...machine, availRamGb: 16 } });
    const soft = jobStartsForBatch({ limit: 16, running: 2, machine });
    assert.ok(soft.starts < ok.starts);
    assert.equal(soft.pressure, 'soft');
  });
});

describe('gate verify argv', () => {
  it('only adjusts node --test commands', () => {
    assert.equal(isNodeTestCommand(['node', '--test', 'a.test.mjs']), true);
    assert.equal(isNodeTestCommand(['npm', 'test']), false);
    const out = applyNodeTestConcurrency(['node', '--test', 'x.mjs'], 2);
    assert.deepEqual(out, ['node', '--test', 'x.mjs', '--test-concurrency=2']);
    const replaced = applyNodeTestConcurrency(['node', '--test', '--test-concurrency=8', 'x.mjs'], 2);
    assert.ok(replaced.includes('--test-concurrency=2'));
    const npm = applyNodeTestConcurrency(['npm', 'run', 'test'], 2);
    assert.deepEqual(npm, ['npm', 'run', 'test']);
  });

  it('gateVerifyArgvWithMemory applies test concurrency from machine pressure', () => {
    const argv = ['node', '--test', 'suite.mjs'];
    const hard = gateVerifyArgvWithMemory({
      argv,
      config: { machineConcurrency: 16 },
      machine: { availRamGb: 2, cores: 8 },
    });
    assert.ok(hard.includes('--test-concurrency=1'));
    const soft = gateVerifyArgvWithMemory({
      argv,
      config: { machineConcurrency: 16 },
      machine: { availRamGb: 5, cores: 8 },
    });
    assert.ok(soft.includes('--test-concurrency=2'));
  });
});

describe('effectiveMachineLimit', () => {
  it('applies projection before pressure', () => {
    const machine = { availRamGb: 9, cores: 8 };
    const r = effectiveMachineLimit({ limit: 64, machine, config: { jobMemoryGb: 0.6 } });
    assert.equal(r.projectionCap, Math.floor(6 / 0.6));
    assert.equal(r.effective, r.projectionCap);
  });
});
