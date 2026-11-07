// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readyAutopilotDeps } from '../tools/autopilot-ready-deps.mjs';
import { runChecks } from '../tools/swarm/core-31.mjs';

const ROOT = '/tmp/memwire-wiring';

describe('autopilot startScope memory', () => {
  it('holds at hard pressure without spawning', async () => {
    let spawned = false;
    const logs = [];
    const deps = readyAutopilotDeps(ROOT, {
      spawnImpl: () => { spawned = true; throw new Error('should not spawn'); },
      readMachine: async () => ({ availRamGb: 2, swapUsedGb: 0, swapTotalGb: 8, cores: 8 }),
      log: (line) => logs.push(line),
      readTickets: async () => [],
      readPending: async () => [],
      listLiveRuns: async () => [],
      liveBusyMarkers: async () => [],
      checkProjectCap: async () => true,
    });
    const out = await deps.startScope({ root: ROOT, maxJobs: 8 });
    assert.equal(spawned, false);
    assert.deepEqual(out, { ok: true, result: 'held-memory' });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /held by memory pressure/);
  });

  it('shrinks --max-jobs at soft pressure', async () => {
    let seenArgs = null;
    const deps = readyAutopilotDeps(ROOT, {
      spawnImpl: (cmd, args) => {
        seenArgs = args;
        return {
          unref() {},
          once(event, cb) {
            if (event === 'error') return;
            queueMicrotask(() => cb?.());
          },
        };
      },
      readMachine: async () => ({ availRamGb: 5, swapUsedGb: 0, swapTotalGb: 8, cores: 16 }),
      readTickets: async () => [],
      readPending: async () => [],
      listLiveRuns: async () => [],
      liveBusyMarkers: async () => [],
      checkProjectCap: async () => true,
    });
    await deps.startScope({ root: ROOT, maxJobs: 16 });
    const maxIdx = seenArgs.indexOf('--max-jobs');
    assert.ok(maxIdx >= 0);
    const jobs = Number(seenArgs[maxIdx + 1]);
    assert.ok(jobs < 16);
    assert.ok(jobs >= 2);
  });
});

describe('runChecks tests memory', () => {
  it('rewrites --test-concurrency for node --test only', async () => {
    const captured = [];
    const spawn = (cmd, args) => {
      captured.push([cmd, ...args]);
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event, cb) => { if (event === 'close') queueMicrotask(() => cb(0)); },
        kill: () => {},
      };
    };
    const machine = { availRamGb: 16, swapUsedGb: 0, swapTotalGb: 8, cores: 10 };
    const root = ROOT;
    const nodeTests = await runChecks(root, [{
      name: 'tests',
      argv: [process.execPath, '--test', 'suite.mjs', '--test-concurrency=8'],
    }], [], [], spawn, { readMachine: async () => machine });
    assert.equal(nodeTests.checks[0].status, 'passed');
    assert.ok(captured[0].includes('--test-concurrency=4'));

    const lint = await runChecks(root, [{
      name: 'lint',
      argv: [process.execPath, '-e', 'process.exit(0)'],
    }], [], [], spawn, { readMachine: async () => machine });
    assert.equal(lint.checks[0].status, 'passed');
    assert.equal(captured.length, 2);
    assert.ok(!captured[1].some(a => String(a).startsWith('--test-concurrency')));
  });

  it('waits then runs at concurrency 1 when pressure stays hard', async () => {
    const sleeps = [];
    let reads = 0;
    let spawnedArgv = null;
    const hardMachine = { availRamGb: 2, swapUsedGb: 0, swapTotalGb: 8, cores: 8 };
    const spawn = (cmd, args) => {
      spawnedArgv = [cmd, ...args];
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event, cb) => { if (event === 'close') queueMicrotask(() => cb(0)); },
        kill: () => {},
      };
    };
    const out = await runChecks(ROOT, [{
      name: 'tests',
      argv: [process.execPath, '--test', 'a.mjs'],
    }], [], [], spawn, {
      readMachine: async () => {
        reads += 1;
        return hardMachine;
      },
      memoryPressureSleep: async (ms) => { sleeps.push(ms); },
    });
    assert.ok(sleeps.length >= 1);
    assert.equal(sleeps[0], 15_000);
    assert.equal(out.checks[0].warning, 'ran under memory pressure');
    assert.ok(reads > 1);
    assert.ok(spawnedArgv?.includes('--test-concurrency=1'));
  });
});
