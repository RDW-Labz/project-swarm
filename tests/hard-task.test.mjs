// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TASK_DIR, HARD_TIMEOUT_MS, parseTapSummary, gradeSolution, prepareRepo, hardManifest, runHardTask } from '../bench/gpu-bakeoff/hard-task.mjs';

const SOLUTION = path.join(TASK_DIR, 'solution', 'planWaves.mjs');
const STUB = path.join(TASK_DIR, 'planWaves.mjs');

function fakeExec(behavior) {
  return (program, args, opts) => {
    if (program === process.execPath && args[0] === 'fake-runner.mjs') {
      const root = args[args.indexOf('--root') + 1];
      return behavior(root);
    }
    return spawnSync(program, args, opts);
  };
}

test('parseTapSummary reads pass and total lines, or zeros when absent', () => {
  assert.deepEqual(parseTapSummary('# tests 16\n# pass 12\n# fail 4'), { passed: 12, total: 16 });
  assert.deepEqual(parseTapSummary('no summary here'), { passed: 0, total: 0 });
});

test('gradeSolution scores the stub 0/16, the solution 16/16, and a missing file as no solution file', () => {
  const stub = gradeSolution({ file: STUB });
  assert.equal(stub.passed, 0);
  assert.equal(stub.total, 16);
  assert.equal(stub.passedAll, false);
  const sol = gradeSolution({ file: SOLUTION });
  assert.equal(sol.passed, 16);
  assert.equal(sol.total, 16);
  assert.equal(sol.passedAll, true);
  const missing = gradeSolution({ file: path.join(TASK_DIR, 'missing.mjs') });
  assert.equal(missing.passedAll, false);
  assert.equal(missing.error, 'no solution file');
});

test('prepareRepo leaves only the task files in a git repo with the stub', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-task-test-'));
  try {
    const dir = path.join(root, 'repo');
    prepareRepo({ dir });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.git', '.gitignore', 'TASK.md', 'planWaves.mjs'].sort());
    const ls = spawnSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' });
    assert.deepEqual(ls.stdout.split('\n').filter(Boolean).sort(), ['.gitignore', 'TASK.md', 'planWaves.mjs'].sort());
    assert.equal(fs.readFileSync(path.join(dir, 'planWaves.mjs'), 'utf8'), fs.readFileSync(STUB, 'utf8'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hardManifest builds one rented job with the expected fields', () => {
  const m = hardManifest({ model: 'm/x', bestOf: 3, maxUsd: 15 });
  assert.equal(m.jobs.length, 1);
  const [job] = m.jobs;
  assert.equal(job.agent, 'rented');
  assert.equal(job.model, 'm/x');
  assert.equal(job.sensitive, false);
  assert.deepEqual(job.context, ['TASK.md', 'planWaves.mjs']);
  assert.deepEqual(job.outputs, ['planWaves.mjs']);
  assert.equal(job.contract, 'TASK.md');
  assert.ok(Array.isArray(job.acceptance) && job.acceptance.length > 0);
  assert.equal(job.timeoutMs, HARD_TIMEOUT_MS);
  assert.equal(HARD_TIMEOUT_MS, 600000);
  assert.equal(job.bestOf, 3);
  assert.equal(m.budget.maxUsd, 15);
  assert.equal('bestOf' in hardManifest({ model: 'm/x', bestOf: 1 }).jobs[0], false);
  assert.doesNotMatch(JSON.stringify([job.context, job.outputs]), /solution|test\//);
});

test('runHardTask grades the copied solution and reports run stats', () => {
  const exec = fakeExec(root => {
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    fs.copyFileSync(SOLUTION, path.join(root, 'ws', 'planWaves.mjs'));
    const state = { jobs: [{ id: 'hard-planwaves', status: 'complete', workspace: 'ws', durationMs: 31000, attempts: [{}], usage: { total_tokens: 1234 } }] };
    return { status: 0, stdout: JSON.stringify(state) + '\n', stderr: '' };
  });
  const r = runHardTask({ model: 'm/x', bestOf: 3, runner: 'fake-runner.mjs', exec });
  assert.equal(r.passed, 16);
  assert.equal(r.total, 16);
  assert.equal(r.passedAll, true);
  assert.equal(r.seconds, 31);
  assert.equal(r.attempts, 1);
  assert.equal(r.tokens, 1234);
  assert.equal(r.status, 'complete');
});

test('runHardTask with no output reports the failure status and error', () => {
  const exec = fakeExec(() => {
    const state = { jobs: [{ id: 'hard-planwaves', status: 'failed', workspace: 'ws', error: 'truncated', durationMs: 1000 }] };
    return { status: 0, stdout: JSON.stringify(state) + '\n', stderr: '' };
  });
  const r = runHardTask({ model: 'm/x', bestOf: 3, runner: 'fake-runner.mjs', exec });
  assert.equal(r.passed, 0);
  assert.equal(r.passedAll, false);
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'truncated');
});

test('runHardTask throws when the runner prints non-JSON', () => {
  const exec = fakeExec(() => ({ status: 1, stdout: 'not json\n', stderr: '' }));
  assert.throws(
    () => runHardTask({ model: 'm/x', bestOf: 3, runner: 'fake-runner.mjs', exec }),
    err => err.message.startsWith('hard task run failed: ')
  );
});
