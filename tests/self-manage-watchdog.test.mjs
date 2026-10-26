// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSwarmScratchProcessPath,
  isOrphanedSwarmLeakCandidate,
  selectOrphanedSwarmLeakCandidates,
  cleanupOrphanedSwarmLeaks,
  terminateProcessGroup,
  narrowWaveCloudLaneAllowance,
  runWatchdog,
} from '../tools/self-manage/watchdog.mjs';

const TMP = '/var/folders/fake-tmp';
const NOW = 1_700_000_000_000;
const AGE_MS = 2 * 60 * 60 * 1000;
const THRESHOLD_MS = 60 * 60 * 1000;

const LEAK_PATH =
  '/Users/x/.project-swarm-scratch/worktrees/wt-1/node_modules/.bin/node --test';

test('leak candidate matching all criteria is cleaned via SIGTERM on process group and re-probed', async () => {
  const proc = {
    pid: 4242,
    ppid: 1,
    pgid: 4242,
    argv: [LEAK_PATH],
    ageMs: AGE_MS,
    startTimeMs: NOW - AGE_MS,
  };
  const killCalls = [];
  let probePass = 0;
  const getProcesses = () => {
    probePass += 1;
    if (probePass === 1) return [proc];
    return [];
  };

  const outcomes = await cleanupOrphanedSwarmLeaks({
    processes: [proc],
    getProcesses,
    kill: (pid, signal) => {
      killCalls.push({ pid, signal });
    },
    wait: async () => {},
    reprobeDelayMs: 10,
    ageThresholdMs: THRESHOLD_MS,
    now: NOW,
    osTmpDir: TMP,
    ownPgid: 99_999,
  });

  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0].signal, 'SIGTERM');
  assert.equal(killCalls[0].pid, -4242);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'terminated');
  assert.equal(outcomes[0].reprobed, true);
});

test('process missing swarm path is never selected', async () => {
  const proc = { pid: 1, ppid: 1, argv: ['/usr/local/bin/node'], ageMs: AGE_MS };
  assert.equal(
    selectOrphanedSwarmLeakCandidates([proc], {
      ageThresholdMs: THRESHOLD_MS,
      now: NOW,
      osTmpDir: TMP,
    }).length,
    0,
  );
});

test('process with non-init ppid is never selected', async () => {
  const proc = {
    pid: 2,
    ppid: 999,
    argv: [LEAK_PATH],
    ageMs: AGE_MS,
  };
  assert.equal(
    isOrphanedSwarmLeakCandidate(proc, {
      ageThresholdMs: THRESHOLD_MS,
      now: NOW,
      osTmpDir: TMP,
    }),
    false,
  );
});

test('process younger than threshold is never selected', async () => {
  const proc = { pid: 3, ppid: 1, argv: [LEAK_PATH], ageMs: 30_000 };
  assert.equal(
    isOrphanedSwarmLeakCandidate(proc, {
      ageThresholdMs: THRESHOLD_MS,
      now: NOW,
      osTmpDir: TMP,
    }),
    false,
  );
});

test('docker/cursor-like argv with swarm in name but not scratch path fails path gate', () => {
  const dockerLike =
    '/Applications/Docker.app/Contents/Resources/bin/docker-swarm-agent --name cursor-helper';
  const cursorLike = '/Applications/Cursor.app/Contents/Resources/swarm-lane-worker';
  assert.equal(isSwarmScratchProcessPath(dockerLike, { osTmpDir: TMP }), false);
  assert.equal(isSwarmScratchProcessPath(cursorLike, { osTmpDir: TMP }), false);
  const dockerProc = { pid: 10, ppid: 1, argv: [dockerLike], ageMs: AGE_MS };
  const cursorProc = { pid: 11, ppid: 1, argv: [cursorLike], ageMs: AGE_MS };
  assert.equal(
    selectOrphanedSwarmLeakCandidates([dockerProc, cursorProc], {
      ageThresholdMs: THRESHOLD_MS,
      now: NOW,
      osTmpDir: TMP,
    }).length,
    0,
  );
});

test('EPERM on kill is logged and skipped without retry or SIGKILL', async () => {
  const proc = {
    pid: 50,
    ppid: 1,
    pgid: 50,
    argv: [LEAK_PATH],
    ageMs: AGE_MS,
    startTimeMs: NOW - AGE_MS,
  };
  const logs = [];
  const killCalls = [];
  const outcomes = await cleanupOrphanedSwarmLeaks({
    processes: [proc],
    getProcesses: () => [proc],
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
    log: (msg, detail) => logs.push({ msg, detail }),
  });
  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0].signal, 'SIGTERM');
  assert.ok(logs.some(l => String(l.msg).includes('EPERM')));
  assert.equal(outcomes[0].status, 'skipped');
  assert.equal(outcomes[0].reason, 'EPERM');
});

test('argv with .swarm as substring in a filename segment is not a scratch path', () => {
  const falsePositives = [
    '/Users/me/code/app.swarmconfig',
    'foo.swarm.json',
    `${process.env.HOME ?? '/Users/me'}/.swarmrc`,
    '--config=/tmp/app.swarm.json',
  ];
  for (const argv of falsePositives) {
    assert.equal(isSwarmScratchProcessPath(argv, { osTmpDir: TMP }), false);
  }
  const proc = { pid: 20, ppid: 1, argv: ['/Users/me/code/app.swarmconfig'], ageMs: AGE_MS };
  assert.equal(
    selectOrphanedSwarmLeakCandidates([proc], {
      ageThresholdMs: THRESHOLD_MS,
      now: NOW,
      osTmpDir: TMP,
    }).length,
    0,
  );
});

test('tmpdir plus unrelated swarm flag in separate argv tokens is not matched', () => {
  const argv = [path.join(TMP, 'unrelated-job.log'), '--swarm', 'docker'];
  assert.equal(isSwarmScratchProcessPath(argv, { osTmpDir: TMP }), false);
  const realTmpWorkspace = `${TMP}/swarm-ui-check-abc123`;
  assert.equal(isSwarmScratchProcessPath([realTmpWorkspace], { osTmpDir: TMP }), true);
});

test('unsafe pgid 0 or 1 is never passed to kill; self pid and self pgid are rejected', async () => {
  const killCalls = [];
  const kill = (pid, signal) => {
    killCalls.push({ pid, signal });
  };
  const base = { ppid: 1, argv: [LEAK_PATH], ageMs: AGE_MS, startTimeMs: NOW - AGE_MS };
  const ownPgid = 88_888;

  for (const pgid of [0, 1]) {
    killCalls.length = 0;
    const proc = { ...base, pid: 5000 + pgid, pgid };
    await terminateProcessGroup(proc, kill, { ownPgid });
    assert.equal(killCalls.length, 0);
  }

  killCalls.length = 0;
  await terminateProcessGroup(
    { ...base, pid: process.pid, pgid: process.pid },
    kill,
    { ownPgid },
  );
  assert.equal(killCalls.length, 0);

  killCalls.length = 0;
  await terminateProcessGroup(
    { ...base, pid: 6000, pgid: ownPgid },
    kill,
    { ownPgid },
  );
  assert.equal(killCalls.length, 0);
});

test('stale or PID-reused candidate is skipped at pre-kill reprobe', async () => {
  const original = {
    pid: 7000,
    ppid: 1,
    pgid: 7000,
    argv: [LEAK_PATH],
    ageMs: AGE_MS,
    startTimeMs: NOW - AGE_MS,
  };
  const reusedPidOtherProcess = {
    pid: 7000,
    ppid: 1,
    argv: ['/usr/bin/node'],
    ageMs: 5_000,
    startTimeMs: NOW - 5_000,
  };
  const killCalls = [];
  let phase = 0;
  const getProcesses = () => {
    phase += 1;
    if (phase === 1) return [reusedPidOtherProcess];
    return [];
  };

  const outcomes = await cleanupOrphanedSwarmLeaks({
    processes: [original],
    getProcesses,
    kill: (pid, signal) => killCalls.push({ pid, signal }),
    wait: async () => {},
    ageThresholdMs: THRESHOLD_MS,
    now: NOW,
    osTmpDir: TMP,
    ownPgid: 99_999,
  });

  assert.equal(killCalls.length, 0);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'skipped');
  assert.equal(outcomes[0].reason, 'stale_candidate');
});

test('hard memory pressure yields cloud-lane allowance of 1, never 0', () => {
  const machine = { availRamGb: 1.5, swapUsedGb: 0, swapTotalGb: 8, platform: 'linux' };
  const allowance = narrowWaveCloudLaneAllowance(machine);
  assert.equal(allowance.cloudLaneJobs, 1);
  assert.notEqual(allowance.cloudLaneJobs, 0);
});

test('soft memory pressure yields cloud-lane allowance of 2', () => {
  const machine = { availRamGb: 4.5, swapUsedGb: 0, swapTotalGb: 8, platform: 'linux' };
  const allowance = narrowWaveCloudLaneAllowance(machine);
  assert.equal(allowance.cloudLaneJobs, 2);
});

test('runWatchdog under hard pressure reports allowance 1-2 in resources and degraded lane health', async () => {
  const machine = { availRamGb: 2, swapUsedGb: 5, swapTotalGb: 8, platform: 'linux' };
  const result = await runWatchdog({
    processes: [],
    machine,
    disk: { usedGb: 400, totalGb: 500 },
    now: NOW,
  });
  assert.ok(result.resources.cloudLaneAllowance >= 1 && result.resources.cloudLaneAllowance <= 2);
  assert.equal(result.laneHealth.status, 'degraded');
  assert.ok(result.laneHealth.reason.includes('narrow-wave'));
  assert.equal(result.resources.disk.usedGb, 400);
});
