// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runChecks } from '../tools/swarm/core-31.mjs';

const ROOT = '/tmp/guard-backup-fixes3';

describe('runChecks readMachine resilience', () => {
  it('runs the tests check when readMachine throws (no memory gate)', async () => {
    const stderrChunks = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(String(chunk));
      return write(chunk, ...rest);
    };
    try {
      let spawned = false;
      const spawn = (cmd, args) => {
        spawned = true;
        assert.ok(args.includes('--test-concurrency=8'));
        return {
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (event, cb) => { if (event === 'close') queueMicrotask(() => cb(0)); },
          kill: () => {},
        };
      };
      const out = await runChecks(ROOT, [{
        name: 'tests',
        argv: [process.execPath, '--test', 'suite.mjs', '--test-concurrency=8'],
      }], [], [], spawn, {
        readMachine: async () => { throw new Error('probe denied'); },
        memoryPressureSleep: async () => { throw new Error('should not sleep'); },
      });
      assert.equal(spawned, true);
      assert.equal(out.checks.length, 1);
      assert.equal(out.checks[0].name, 'tests');
      assert.equal(out.checks[0].status, 'passed');
      assert.equal(out.checksPassed, true);
      assert.equal(out.checks[0].warning, undefined);
      assert.equal(stderrChunks.join(''), '');
    } finally {
      process.stderr.write = write;
    }
  });

  it('counts a failing tests check when readMachine throws', async () => {
    const spawn = () => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, cb) => { if (event === 'close') queueMicrotask(() => cb(1)); },
      kill: () => {},
    });
    const out = await runChecks(ROOT, [{
      name: 'tests',
      argv: [process.execPath, '--test', 'bad.mjs'],
    }], [], [], spawn, {
      readMachine: async () => { throw new Error('probe denied'); },
    });
    assert.equal(out.checks[0].status, 'failed');
    assert.equal(out.checksPassed, false);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0].name, 'tests');
  });
});
