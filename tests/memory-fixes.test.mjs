// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { constants as fsConstants } from 'node:fs';
import {
  DARWIN_MEMORY_PROBE_UNKNOWN_WARNING,
  DARWIN_SYSCTL_PATH,
  DARWIN_VM_STAT_PATH,
  defaultMemoryExec,
  memoryPressureLevel,
  parseDarwinVmStatAndSwap,
  readAvailableMemory,
  readMachine,
} from '../tools/autotune.mjs';
import {
  applyNodeTestConcurrency,
  effectiveMachineLimit,
  jobStartsForBatch,
  MEMORY_HARD_WAIT_MS,
  MEMORY_POLL_MS,
  projectedMemoryJobCap,
  testConcurrencyFor,
  tickAutotune,
} from '../tools/machine-limit.mjs';
import { runChecks } from '../tools/swarm/core-31.mjs';
import {
  loadOrCreateBoardIdentity,
  boardIdentityPath,
  portBusyError,
} from '../tools/board-keepalive.mjs';
import { readyAutopilotDeps } from '../tools/autopilot-ready-deps.mjs';
import {
  autopilotStep,
  startReadyCooldownOpen,
  START_READY_HOLD_BACKOFF_MS,
} from '../tools/autopilot.mjs';
import { runWatchCommand } from '../tools/watch-cli.mjs';

const ROOT = '/tmp/memory-fixes-root';
const UID = 502;

const DARWIN_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
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

describe('readAvailableMemory default exec', () => {
  it('uses defaultMemoryExec when exec is omitted', async () => {
    const execFileCalls = [];
    const fakeExecFile = async (file, args, opts) => {
      execFileCalls.push({ file, args, opts });
      if (file === DARWIN_VM_STAT_PATH) return { stdout: DARWIN_VM_STAT };
      if (file === DARWIN_SYSCTL_PATH) return { stdout: `${DARWIN_SWAP}\n` };
      throw new Error(`unexpected execFile ${file}`);
    };
    const rDarwin = await readAvailableMemory({
      platform: 'darwin',
      os: { platform: () => 'darwin', freemem: () => 1 },
      defaultMemoryExecOptions: { execFile: fakeExecFile },
    });
    const expectedDarwin = parseDarwinVmStatAndSwap(DARWIN_VM_STAT, `${DARWIN_SWAP}\n`);
    assert.ok(expectedDarwin);
    assert.equal(rDarwin.availRamGb, expectedDarwin.availRamGb);
    assert.equal(execFileCalls.length, 2);
    assert.equal(execFileCalls[0].file, '/usr/bin/vm_stat');
    assert.deepEqual(execFileCalls[0].args, []);
    assert.equal(execFileCalls[1].file, '/usr/sbin/sysctl');
    assert.deepEqual(execFileCalls[1].args, ['-n', 'vm.swapusage']);

    const readPaths = [];
    const fakeFs = {
      readFile: async (p, enc) => {
        readPaths.push(p);
        assert.equal(enc, 'utf8');
        return LINUX_MEMINFO;
      },
    };
    const rLinux = await readAvailableMemory({
      platform: 'linux',
      os: { platform: () => 'linux', freemem: () => 1 },
      defaultMemoryExecOptions: { fs: fakeFs },
    });
    assert.deepEqual(readPaths, ['/proc/meminfo']);
    assert.equal(rLinux.availRamGb, 8);
    assert.equal(rLinux.swapUsedGb, 1);
  });

  it('uses pressure-unknown on darwin when probes fail (not freemem)', async () => {
    const r = await readAvailableMemory({
      platform: 'darwin',
      exec: async () => { throw new Error('fail'); },
      os: { platform: () => 'darwin', freemem: () => 3 * 1024 ** 3 },
    });
    assert.equal(r.pressureUnknown, true);
    assert.equal(r.availRamGb, null);
    assert.equal(r.warning, DARWIN_MEMORY_PROBE_UNKNOWN_WARNING);
    assert.equal(memoryPressureLevel(r, 'darwin'), 'ok');
    assert.equal(r.swapUsedGb, 0);
  });

  it('keeps vm_stat when sysctl swap probe fails on darwin', async () => {
    const r = await readAvailableMemory({
      platform: 'darwin',
      exec: async (cmd) => {
        if (cmd === 'vm_stat') return DARWIN_VM_STAT;
        if (cmd === 'sysctl') throw new Error('sysctl denied');
        throw new Error(`unexpected ${cmd}`);
      },
    });
    const expected = parseDarwinVmStatAndSwap(DARWIN_VM_STAT, '');
    assert.ok(expected);
    assert.equal(r.availRamGb, expected.availRamGb);
    assert.equal(r.swapUsedGb, 0);
  });

  it('falls back to freemem on linux when default path fails', async () => {
    const r = await readAvailableMemory({
      platform: 'linux',
      exec: async () => { throw new Error('fail'); },
      os: { platform: () => 'linux', freemem: () => 3 * 1024 ** 3 },
    });
    assert.equal(r.availRamGb, 3);
    assert.equal(r.swapUsedGb, 0);
    assert.equal(r.pressureUnknown, undefined);
  });

  it('defaultMemoryExec uses absolute darwin binary paths', () => {
    assert.equal(DARWIN_VM_STAT_PATH, '/usr/bin/vm_stat');
    assert.equal(DARWIN_SYSCTL_PATH, '/usr/sbin/sysctl');
  });
});

describe('readMachine probe metadata', () => {
  it('passes darwin pressure-unknown through readMachine', async () => {
    const m = await readMachine({
      platform: 'darwin',
      exec: async () => { throw new Error('fail'); },
      os: {
        platform: () => 'darwin',
        freemem: () => 1,
        totalmem: () => 16 * 1024 ** 3,
        cpus: () => [{ times: { idle: 1, user: 0 } }],
      },
      measureCpu: async () => 0,
    });
    assert.equal(m.pressureUnknown, true);
    assert.equal(m.availRamGb, null);
    assert.equal(m.freeRamGb, null);
    assert.equal(m.warning, DARWIN_MEMORY_PROBE_UNKNOWN_WARNING);
    assert.equal(memoryPressureLevel(m, 'darwin'), 'ok');
  });
});

describe('unknown memory pressure skips RAM limits', () => {
  const unknownMachine = {
    availRamGb: null,
    freeRamGb: null,
    pressureUnknown: true,
    swapUsedGb: 0,
    swapTotalGb: 0,
    cores: 16,
    cpuPercent: 10,
  };

  it('does not project a job cap from null availability', () => {
    assert.equal(projectedMemoryJobCap(unknownMachine), Infinity);
    const { effective, projectionCap, pressure } = effectiveMachineLimit({
      limit: 32,
      machine: unknownMachine,
      config: {},
    });
    assert.equal(pressure, 'ok');
    assert.equal(projectionCap, Infinity);
    assert.equal(effective, 32);
  });

  it('testConcurrencyFor and jobStartsForBatch behave like ok pressure', () => {
    assert.equal(testConcurrencyFor(unknownMachine), 4);
    const batch = jobStartsForBatch({
      limit: 16,
      running: 2,
      machine: unknownMachine,
      config: {},
    });
    assert.equal(batch.pressure, 'ok');
    assert.equal(batch.starts, 14);
    assert.equal(batch.effectiveLimit, 16);
  });

  it('tickAutotune does not RAM-backoff when pressure is unknown', () => {
    const out = tickAutotune({
      state: { version: 1, limit: 20 },
      machine: unknownMachine,
      inUse: 0,
      waiting: 5,
      config: {},
    });
    assert.equal(out.memoryPressure, 'ok');
    assert.equal(out.capped, 'none');
    assert.ok(out.limit >= 20);
  });
});

describe('memoryPressureLevel darwin', () => {
  it('ignores swap-only hard triggers on darwin', () => {
    assert.equal(memoryPressureLevel({ availRamGb: 10, swapUsedGb: 5 }, 'darwin'), 'ok');
    assert.equal(memoryPressureLevel({ availRamGb: 10, swapUsedGb: 3, swapTotalGb: 4 }, 'darwin'), 'ok');
    assert.equal(memoryPressureLevel({ availRamGb: 2.5 }, 'darwin'), 'hard');
    assert.equal(memoryPressureLevel({ availRamGb: 16, swapUsedGb: 9 }, 'darwin'), 'soft');
  });
});

describe('runChecks memory probe warning', () => {
  it('logs once and attaches probe warning on the tests check result', async () => {
    const stderrChunks = [];
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(String(chunk));
      return stderrWrite(chunk, ...args);
    };
    try {
      const spawnImpl = () => ({
        stdout: { on() {} },
        stderr: { on() {} },
        on(event, cb) {
          if (event === 'close') queueMicrotask(() => cb(0));
        },
      });
      const machine = {
        availRamGb: null,
        freeRamGb: null,
        pressureUnknown: true,
        warning: DARWIN_MEMORY_PROBE_UNKNOWN_WARNING,
        cores: 8,
      };
      const { checks } = await runChecks(ROOT, [{
        name: 'tests',
        argv: [process.execPath, '--test', 'ok.mjs'],
      }], [], [], spawnImpl, {
        readMachine: async () => machine,
      });
      assert.equal(checks[0].warning, DARWIN_MEMORY_PROBE_UNKNOWN_WARNING);
      const logged = stderrChunks.join('');
      assert.equal((logged.match(new RegExp(DARWIN_MEMORY_PROBE_UNKNOWN_WARNING, 'g')) ?? []).length, 1);
    } finally {
      process.stderr.write = stderrWrite;
    }
  });
});

describe('runChecks hard memory wait', () => {
  it('waits at most 60s in 15s polls before running node --test', async () => {
    assert.equal(MEMORY_HARD_WAIT_MS, 60_000);
    assert.equal(MEMORY_POLL_MS, 15_000);
    const sleeps = [];
    let reads = 0;
    const spawnImpl = () => ({
      stdout: { on() {} },
      stderr: { on() {} },
      on(event, cb) {
        if (event === 'close') queueMicrotask(() => cb(0));
      },
    });
    const readMachineFn = async () => {
      reads += 1;
      return { availRamGb: reads < 5 ? 1 : 10, swapUsedGb: 0, cores: 8 };
    };
    const checkArgv = [process.execPath, '--test', '--test-concurrency=8', 'ok.mjs'];
    await runChecks(ROOT, [{
      name: 'tests',
      argv: checkArgv,
    }], [], [], spawnImpl, {
      readMachine: readMachineFn,
      memoryPressureSleep: ms => { sleeps.push(ms); },
    });
    assert.deepEqual(sleeps, [15_000, 15_000, 15_000, 15_000]);
    assert.equal(reads, 5);
  });
});

describe('applyNodeTestConcurrency lowers only', () => {
  it('never raises an existing lower concurrency cap', () => {
    const argv = ['node', '--test', 'suite.mjs', '--test-concurrency=8'];
    const out = applyNodeTestConcurrency(argv, 2);
    assert.ok(out.includes('--test-concurrency=2'));
    const kept = applyNodeTestConcurrency(argv, 16);
    assert.ok(kept.includes('--test-concurrency=8'));
  });
});

describe('board identity port bookmark', () => {
  function makeMemFs(seed = {}) {
    const files = new Map(Object.entries(seed));
    return {
      files,
      async mkdir() {},
      async chmod() {},
      async lstat(file) {
        const entry = files.get(file);
        if (!entry) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return {
          isSymbolicLink: () => Boolean(entry.symlink),
          uid: entry.uid ?? UID,
          mode: entry.mode ?? 0o100600,
        };
      },
      async stat(file) {
        const entry = files.get(file);
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { mode: entry.mode ?? 0o100600, uid: entry.uid ?? UID, isFile: () => true };
      },
      async open(file, flags) {
        const entry = files.get(file);
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        entry.lastOpenFlags = flags;
        return {
          async fstat() {
            return { mode: entry.mode ?? 0o100600, uid: entry.uid ?? UID, isFile: () => true };
          },
          async readFile() { return entry.content; },
          async close() {},
        };
      },
      async readFile(file) {
        return files.get(file)?.content ?? (() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); })();
      },
      async writeFile(file, content, { mode, flag } = {}) {
        if (flag === 'wx' && files.has(file)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        files.set(file, { content, mode: (mode ?? 0o600) | 0o100000, uid: UID });
      },
      async rename(from, to) {
        const entry = files.get(from);
        files.delete(from);
        files.set(to, entry);
      },
      async rm(file) { files.delete(file); },
    };
  }

  it('rejects a conflicting --port when identity already exists', async () => {
    const dir = '/cfg/.project-swarm';
    const file = boardIdentityPath(dir);
    const fs = makeMemFs({
      [file]: { content: `{"token":"${'a'.repeat(48)}","port":51058}\n`, mode: 0o100600, uid: UID },
    });
    await assert.rejects(
      () => loadOrCreateBoardIdentity({ dir, fs, randomBytes: n => Buffer.alloc(n, 1), port: 52000, uid: UID }),
      err => err.code === 'board-port-mismatch',
    );
  });

  it('opens identity with O_NONBLOCK so a FIFO cannot block', async () => {
    const dir = '/cfg/.project-swarm';
    const file = boardIdentityPath(dir);
    const fs = makeMemFs({
      [file]: { content: `{"token":"${'d'.repeat(48)}","port":51058}\n`, mode: 0o100600, uid: UID },
    });
    await loadOrCreateBoardIdentity({
      dir,
      fs,
      randomBytes: n => Buffer.alloc(n, 1),
      uid: UID,
      isPortFree: async () => true,
    });
    const entry = fs.files.get(file);
    assert.ok(entry.lastOpenFlags & fsConstants.O_NONBLOCK);
  });

  it('refuses a symlink config directory', async () => {
    const dir = '/cfg/.project-swarm';
    const fs = makeMemFs();
    fs.files.set(dir, { mode: 0o40700, uid: UID, symlink: true });
    await assert.rejects(
      () => loadOrCreateBoardIdentity({
        dir,
        fs,
        randomBytes: n => Buffer.alloc(n, 1),
        uid: UID,
        isPortFree: async () => true,
      }),
      err => err.code === 'board-config-dir-symlink',
    );
  });

  it('refuses to write when config directory is not owned by the user', async () => {
    const dir = '/cfg/.project-swarm';
    const file = boardIdentityPath(dir);
    const fs = makeMemFs();
    fs.files.set(dir, { mode: 0o40700, uid: UID + 1 });
    await assert.rejects(
      () => loadOrCreateBoardIdentity({
        dir,
        fs,
        randomBytes: n => Buffer.alloc(n, 1),
        uid: UID,
        isPortFree: async () => true,
      }),
      err => err.code === 'board-config-dir-untrusted',
    );
    assert.equal(fs.files.has(file), false);
  });

  it('reuses saved port when --port matches', async () => {
    const dir = '/cfg/.project-swarm';
    const file = boardIdentityPath(dir);
    const fs = makeMemFs({
      [file]: { content: `{"token":"${'b'.repeat(48)}","port":51058}\n`, mode: 0o100600, uid: UID },
    });
    const out = await loadOrCreateBoardIdentity({
      dir,
      fs,
      randomBytes: n => Buffer.alloc(n, 1),
      port: 51058,
      uid: UID,
      isPortFree: async () => true,
    });
    assert.equal(out.port, 51058);
    assert.equal(out.token, 'b'.repeat(48));
  });
});

describe('autopilot held-memory backoff', () => {
  it('records hold timestamp and blocks cooldown for 60s', () => {
    const memory = {};
    const t0 = 1_000_000;
    assert.equal(startReadyCooldownOpen(memory, t0), true);
    memory.startReadyHoldAt = t0;
    assert.equal(startReadyCooldownOpen(memory, t0 + START_READY_HOLD_BACKOFF_MS - 1), false);
    assert.equal(startReadyCooldownOpen(memory, t0 + START_READY_HOLD_BACKOFF_MS), true);
  });

  it('writes held-memory start-ready as incidental', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memfix-autopilot-'));
    await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
    const journal = [];
    const memory = {};
    const deps = {
      readJournal: async () => journal,
      appendEvent: async (_root, event) => { journal.push(event); return event; },
      loadRuns: async () => [{ id: 'r1', status: 'complete', integrated: true, jobCount: 1 }],
      readPlan: async () => null,
      readyTickets: async () => [{ id: 't1', status: 'ready', files: ['a.ts'] }],
      pendingApprovals: async () => [],
      liveRuns: async () => [],
      busyMarkers: async () => [],
      capRoom: async () => true,
      workerSlots: async () => ({ max: 4, free: 2 }),
      readTickets: async () => [{ id: 't1', status: 'ready' }],
      autopilotStartReadySettings: async () => ({ maxJobs: 2, skipSkeleton: false }),
      startScope: async () => ({ ok: true, result: 'held-memory' }),
    };
    const step = await autopilotStep(root, deps, { now: () => 5_000, memory });
    assert.equal(memory.startReadyHoldAt, 5_000);
    assert.ok(!step.stepWroteJournal);
    assert.ok(step.actions.some(a => a.action === 'start-ready' && a.result === 'held-memory'));
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('watch keep-up EADDRINUSE', () => {
  it('prints board port-busy message and exits 1', async () => {
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const identity = { port: 51058, token: 'c'.repeat(48) };
    const out = await runWatchCommand(ROOT, ['--all', '--keep-up'], {
      write: () => {},
      loadOrCreateBoardIdentity: async () => identity,
      startBoardServer: async () => { throw err; },
    });
    assert.equal(out.exitCode, 1);
    assert.match(out.stdout, /board keep-up: port .* already in use/);
    assert.equal(out.stdout.trim(), portBusyError(identity.port).message);
  });
});

describe('readyAutopilotDeps unknown memory pressure', () => {
  it('does not hold or pin max-jobs when probe pressure is unknown', async () => {
    const logs = [];
    let seenArgs = null;
    const deps = readyAutopilotDeps(ROOT, {
      log: line => logs.push(line),
      spawnImpl: (cmd, args) => {
        seenArgs = args;
        return { unref() {}, once(event, cb) { if (event !== 'error') queueMicrotask(() => cb?.()); } };
      },
      readMachine: async () => ({
        availRamGb: null,
        freeRamGb: null,
        pressureUnknown: true,
        warning: DARWIN_MEMORY_PROBE_UNKNOWN_WARNING,
        swapUsedGb: 0,
        swapTotalGb: 0,
        cores: 16,
      }),
      readTickets: async () => [],
      readPending: async () => [],
      listLiveRuns: async () => [],
      liveBusyMarkers: async () => [],
      checkProjectCap: async () => true,
    });
    const out = await deps.startScope({ root: ROOT, maxJobs: 16 });
    assert.notEqual(out.result, 'held-memory');
    const idx = seenArgs.indexOf('--max-jobs');
    assert.equal(seenArgs[idx + 1], '16');
    assert.equal(logs.filter(l => l === DARWIN_MEMORY_PROBE_UNKNOWN_WARNING).length, 1);
  });
});

describe('readyAutopilotDeps machine reader errors', () => {
  it('does not hold when readMachine throws', async () => {
    let spawned = false;
    const deps = readyAutopilotDeps(ROOT, {
      spawnImpl: () => { spawned = true; return { unref() {}, once() {} }; },
      readMachine: async () => { throw new Error('probe failed'); },
      readTickets: async () => [],
      readPending: async () => [],
      listLiveRuns: async () => [],
      liveBusyMarkers: async () => [],
      checkProjectCap: async () => true,
    });
    const out = await deps.startScope({ root: ROOT, maxJobs: 4 });
    assert.equal(spawned, true);
    assert.notEqual(out.result, 'held-memory');
  });
});

describe('memoryAware option', () => {
  it('defaults on so injected env still caps jobs', async () => {
    let seenArgs = null;
    const deps = readyAutopilotDeps(ROOT, {
      env: { SWARM_HOME: '/tmp/fake-home' },
      spawnImpl: (cmd, args) => {
        seenArgs = args;
        return { unref() {}, once(event, cb) { if (event !== 'error') queueMicrotask(() => cb?.()); } };
      },
      readMachine: async () => ({ availRamGb: 5, swapUsedGb: 0, swapTotalGb: 8, cores: 16 }),
      readTickets: async () => [],
      readPending: async () => [],
      listLiveRuns: async () => [],
      liveBusyMarkers: async () => [],
      checkProjectCap: async () => true,
    });
    await deps.startScope({ root: ROOT, maxJobs: 16 });
    const idx = seenArgs.indexOf('--max-jobs');
    assert.ok(Number(seenArgs[idx + 1]) < 16);
  });

  it('can be turned off explicitly', async () => {
    let seenArgs = null;
    const deps = readyAutopilotDeps(ROOT, {
      memoryAware: false,
      spawnImpl: (cmd, args) => {
        seenArgs = args;
        return { unref() {}, once(event, cb) { if (event !== 'error') queueMicrotask(() => cb?.()); } };
      },
      readMachine: async () => ({ availRamGb: 2, swapUsedGb: 0, swapTotalGb: 8, cores: 8 }),
      readTickets: async () => [],
      readPending: async () => [],
      listLiveRuns: async () => [],
      liveBusyMarkers: async () => [],
      checkProjectCap: async () => true,
    });
    await deps.startScope({ root: ROOT, maxJobs: 8 });
    const idx = seenArgs.indexOf('--max-jobs');
    assert.equal(seenArgs[idx + 1], '8');
  });
});
