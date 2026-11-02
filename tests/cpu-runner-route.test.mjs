// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readCpuRunnerCompletions, runBurstCommand } from '../tools/burst-commands.mjs';

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-cpu-runner-route-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

const sleepMs = ms =>
  `node -e "import('node:timers/promises').then(({setTimeout})=>setTimeout(${ms}))"`;

test('swarm burst run-cpu records pass with elapsed durations and appends completion', async t => {
  const root = await tmp(t);
  const res = await runBurstCommand(
    root,
    ['run-cpu', '--ticket-test', sleepMs(40), '--e2e', sleepMs(40), '--ticket-id', 'T-0418'],
    { cwd: root },
  );
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /ticket-tests: pass \(\d+ms\)/);
  assert.match(res.stdout, /e2e-suite: pass \(\d+ms\)/);
  assert.match(res.stdout, /overall: pass/);

  const completions = await readCpuRunnerCompletions(root);
  assert.equal(completions.length, 1);
  const entry = completions[0];
  assert.equal(entry.type, 'cpu-runner.completed');
  assert.equal(entry.ticketId, 'T-0418');
  assert.equal(entry.ticketTests.status, 'pass');
  assert.equal(entry.e2eSuite.status, 'pass');
  assert.ok(entry.ticketTests.durationMs >= 35);
  assert.ok(entry.e2eSuite.durationMs >= 35);
  assert.ok(entry.completedAt);
  assert.ok(entry.recordedAt);
});

test('swarm burst run-cpu still runs e2e when ticket tests fail and records failure', async t => {
  const root = await tmp(t);
  const marker = path.join(root, 'e2e-ran.marker');
  const res = await runBurstCommand(
    root,
    [
      'run-cpu',
      '--ticket-test',
      'exit 1',
      '--e2e',
      `touch "${marker}" && exit 0`,
      '--runner-id',
      'cpu-runner-1',
    ],
    { cwd: root },
  );
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /ticket-tests: fail/);
  assert.match(res.stdout, /e2e-suite: pass/);
  assert.match(res.stdout, /overall: fail/);

  await fs.access(marker);

  const completions = await readCpuRunnerCompletions(root);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].runnerId, 'cpu-runner-1');
  assert.equal(completions[0].ticketTests.status, 'fail');
  assert.notEqual(completions[0].ticketTests.exitCode, 0);
  assert.equal(completions[0].e2eSuite.status, 'pass');
  assert.equal(completions[0].e2eSuite.exitCode, 0);
});

test('swarm burst run-cpu appends sequential runs without overwriting', async t => {
  const root = await tmp(t);
  const first = await runBurstCommand(
    root,
    ['run-cpu', '--ticket-test', 'exit 0', '--e2e', 'exit 0', '--ticket-id', 'T-A'],
    { cwd: root },
  );
  const second = await runBurstCommand(
    root,
    ['run-cpu', '--ticket-test', 'exit 0', '--e2e', 'exit 0', '--ticket-id', 'T-B'],
    { cwd: root },
  );
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);

  const completions = await readCpuRunnerCompletions(root);
  assert.equal(completions.length, 2);
  assert.equal(completions[0].ticketId, 'T-A');
  assert.equal(completions[1].ticketId, 'T-B');
});
