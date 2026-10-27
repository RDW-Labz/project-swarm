// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  maskCommand,
  maskEnvironmentForRecord,
  redactJobRunRecordFields,
} from '../tools/orchestrator-events.mjs';
import { WORKER_TOKEN_ENV } from '../tools/worker-token.mjs';

const testTmpBase = process.env.SWARM_TEST_TMP || os.tmpdir();
const TEST_TIMEOUT_MS = 60_000;

function fakeToken() {
  return ['a', 'b', 'c', 'd'].join('').repeat(16);
}

test('job output and error fields are redacted before run-record storage', { timeout: TEST_TIMEOUT_MS }, () => {
  const proof = fakeToken();
  const rawJob = {
    id: 'job-redact',
    status: 'failed',
    stdout: `stdout leak ${proof}`,
    stderr: `stderr leak ${proof}`,
    error: `Worker exited 1: ${proof}`,
    outputTail: proof,
    stderrTail: `tail ${proof}`,
  };
  const stored = redactJobRunRecordFields(rawJob, proof);
  const blob = JSON.stringify(stored);
  assert.ok(!blob.includes(proof));
  assert.match(blob, /redacted/);
  assert.equal(stored.stdout, rawJob.stdout.replaceAll(proof, 'redacted'));
  assert.equal(stored.error, rawJob.error.replaceAll(proof, 'redacted'));
});

test('maskCommand hides worker token values in command text', { timeout: TEST_TIMEOUT_MS }, () => {
  const proof = fakeToken();
  const cmd = `env ${WORKER_TOKEN_ENV}=${proof} node -e "console.log('x')"`;
  const masked = maskCommand(cmd, 500);
  assert.ok(!masked.includes(proof));
  assert.match(masked, new RegExp(`${WORKER_TOKEN_ENV}=redacted`));
});

test('environment dump for run records never includes the raw worker token', { timeout: TEST_TIMEOUT_MS }, () => {
  const proof = fakeToken();
  const dump = maskEnvironmentForRecord({ PATH: '/bin', [WORKER_TOKEN_ENV]: proof, HOME: '/tmp' });
  const text = JSON.stringify(dump);
  assert.ok(!text.includes(proof));
  assert.equal(dump[WORKER_TOKEN_ENV], 'redacted');
  assert.equal(dump.PATH, '/bin');
});

test('run state.json written from redacted job records never contains the token', { timeout: TEST_TIMEOUT_MS }, async t => {
  const proof = fakeToken();
  const runId = 'run-redact-test';
  const root = await fs.mkdtemp(path.join(testTmpBase, 'worker-redact-state-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const runDir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });

  const job = redactJobRunRecordFields(
    {
      id: 'job-one',
      status: 'failed',
      stdout: proof,
      stderr: `${WORKER_TOKEN_ENV}=${proof}`,
      error: `failed: ${proof}`,
    },
    proof,
  );
  const state = { id: runId, status: 'failed', jobs: [job] };
  const statePath = path.join(runDir, 'state.json');
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  const onDisk = await fs.readFile(statePath, 'utf8');
  assert.ok(!onDisk.includes(proof));
  assert.match(onDisk, /redacted/);
});
