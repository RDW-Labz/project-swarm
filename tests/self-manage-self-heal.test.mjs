// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSelfHealLeakCandidate,
  selfHealCandidates,
  selfHealOrphanedLeaks,
} from '../tools/self-manage/self-heal.mjs';

const TMP = '/var/folders/fake-tmp';
const NOW = 1_700_000_000_000;
const AGE_MS = 2 * 60 * 60 * 1000;
const THRESHOLD_MS = 60 * 60 * 1000;
const EXPECTED_PORTS = [18_765, 18_766];

const LEAK_PATH =
  '/Users/x/.project-swarm-scratch/worktrees/wt-1/node_modules/.bin/node --test';

function leakProc(overrides = {}) {
  return {
    pid: 4242,
    ppid: 1,
    pgid: 4242,
    argv: [LEAK_PATH],
    ageMs: AGE_MS,
    startTimeMs: NOW - AGE_MS,
    port: EXPECTED_PORTS[0],
    lane: 'local-agent-7',
    ...overrides,
  };
}

test('process matching path, ppid, age, and port is selected, killed, and fix-attempt logged', async () => {
  const proc = leakProc();
  const killCalls = [];
  const fixLogs = [];
  let probePass = 0;
  const getProcesses = () => {
    probePass += 1;
    if (probePass === 1) return [proc];
    return [];
  };

  const outcomes = await selfHealOrphanedLeaks({
    processes: [proc],
    getProcesses,
    expectedPorts: EXPECTED_PORTS,
    kill: (pid, signal) => {
      killCalls.push({ pid, signal });
    },
    wait: async () => {},
    reprobeDelayMs: 10,
    ageThresholdMs: THRESHOLD_MS,
    now: NOW,
    osTmpDir: TMP,
    ownPgid: 99_999,
    log: (msg, detail) => {
      if (msg === 'self-heal: fix attempt') fixLogs.push(detail);
    },
  });

  assert.equal(selfHealCandidates([proc], { expectedPorts: EXPECTED_PORTS, ageThresholdMs: THRESHOLD_MS, now: NOW, osTmpDir: TMP }).length, 1);
  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0].signal, 'SIGTERM');
  assert.equal(killCalls[0].pid, -4242);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'terminated');
  assert.equal(fixLogs.length, 1);
  assert.equal(fixLogs[0].lane, 'local-agent-7');
  assert.equal(fixLogs[0].action, 'kill-attempted');
  assert.equal(fixLogs[0].result, 'terminated');
});

test('process matching all criteria except port is never selected or killed', async () => {
  const proc = leakProc({ port: 44_444, listeningPorts: [44_444] });
  const killCalls = [];
  const fixLogs = [];

  const outcomes = await selfHealOrphanedLeaks({
    processes: [proc],
    getProcesses: () => [proc],
    expectedPorts: EXPECTED_PORTS,
    kill: (pid, signal) => killCalls.push({ pid, signal }),
    wait: async () => {},
    ageThresholdMs: THRESHOLD_MS,
    now: NOW,
    osTmpDir: TMP,
    ownPgid: 99_999,
    log: (msg, detail) => {
      if (msg === 'self-heal: fix attempt') fixLogs.push(detail);
    },
  });

  assert.equal(isSelfHealLeakCandidate(proc, { ageThresholdMs: THRESHOLD_MS, now: NOW, osTmpDir: TMP, expectedPorts: EXPECTED_PORTS }), false);
  assert.equal(killCalls.length, 0);
  assert.equal(fixLogs.length, 0);
  assert.equal(outcomes.length, 0);
});

test('process matching port but missing swarm path is never selected', async () => {
  const proc = leakProc({
    argv: ['/usr/local/bin/node'],
    port: EXPECTED_PORTS[0],
  });
  const killCalls = [];

  await selfHealOrphanedLeaks({
    processes: [proc],
    getProcesses: () => [proc],
    expectedPorts: EXPECTED_PORTS,
    kill: (pid, signal) => killCalls.push({ pid, signal }),
    wait: async () => {},
    ageThresholdMs: THRESHOLD_MS,
    now: NOW,
    osTmpDir: TMP,
    ownPgid: 99_999,
  });

  assert.equal(killCalls.length, 0);
});

test('EPERM on kill is logged as skipped-eperm with result skipped-eperm', async () => {
  const proc = leakProc({ pid: 50, pgid: 50, lane: 'cloud-lane-2' });
  const fixLogs = [];
  const killCalls = [];

  const outcomes = await selfHealOrphanedLeaks({
    processes: [proc],
    getProcesses: () => [proc],
    expectedPorts: EXPECTED_PORTS,
    kill: (pid, signal) => {
      killCalls.push({ pid, signal });
      const err = new Error('not permitted');
      err.code = 'EPERM';
      throw err;
    },
    wait: async () => {},
    ageThresholdMs: THRESHOLD_MS,
    now: NOW,
    osTmpDir: TMP,
    ownPgid: 99_999,
    log: (msg, detail) => {
      if (msg === 'self-heal: fix attempt') fixLogs.push(detail);
    },
  });

  assert.equal(killCalls.length, 1);
  assert.equal(outcomes[0].status, 'skipped');
  assert.equal(outcomes[0].reason, 'EPERM');
  assert.equal(fixLogs.length, 1);
  assert.equal(fixLogs[0].lane, 'cloud-lane-2');
  assert.equal(fixLogs[0].action, 'skipped-eperm');
  assert.equal(fixLogs[0].result, 'skipped-eperm');
});
