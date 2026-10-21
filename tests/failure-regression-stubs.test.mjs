// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  failureCausesFromRuns,
  newFailureCauses,
  regressionStubFor,
} from '../tools/failure-regression.mjs';

const execFileAsync = promisify(execFile);

function failJob(over = {}) {
  return {
    id: 'job-1',
    status: 'failed',
    agent: 'cursor',
    error: 'ENOENT: no such file',
    finishedAt: '2026-02-01T12:00:00.000Z',
    ...over,
  };
}

test('normalization merges two runs of the same failure cause', () => {
  const homeSegment = path.join('Users', 'alice', 'proj', 'a.txt');
  const otherSegment = path.join('Users', 'alice', 'proj', 'b.txt');
  const runStates = {
    'run-newer': {
      startedAt: '2026-02-02T00:00:00.000Z',
      jobs: [
        failJob({
          id: 'job-new',
          error: `ENOENT: no such file /${homeSegment}`,
          finishedAt: '2026-02-02T10:00:00.000Z',
        }),
      ],
    },
    'run-older': {
      startedAt: '2026-01-01T00:00:00.000Z',
      jobs: [
        failJob({
          id: 'job-old',
          error: `ENOENT: no such file /${otherSegment}`,
          finishedAt: '2026-01-15T08:00:00.000Z',
        }),
      ],
    },
  };
  const causes = failureCausesFromRuns(runStates);
  assert.equal(causes.length, 1);
  assert.equal(causes[0].runId, 'run-older');
  assert.equal(causes[0].jobId, 'job-old');
  assert.equal(causes[0].firstSeenAt, '2026-01-15T08:00:00.000Z');
});

test('a known cause is not reported as new', () => {
  const causes = failureCausesFromRuns({
    'run-1': { jobs: [failJob({ error: 'TypeError: cannot read property x' })] },
  });
  assert.equal(causes.length, 1);
  const fresh = newFailureCauses(causes, []);
  assert.equal(fresh.length, 1);
  const none = newFailureCauses(causes, [{ key: causes[0].key }]);
  assert.deepEqual(none, []);
});

test('regression stub is valid JS with test.todo and includes the run id', async () => {
  const cause = failureCausesFromRuns({
    'run-stub-42': {
      jobs: [failJob({ id: 'job-stub', error: 'integration refused: missing output' })],
    },
  })[0];
  const stub = regressionStubFor(cause);
  assert.match(stub.path, /^tests\/regressions\/[a-z0-9-]+\.test\.mjs$/);
  assert.match(stub.content, /test\.todo\(/);
  assert.match(stub.content, /run-stub-42/);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'failure-regression-stub-'));
  const file = path.join(tmp, 'stub.test.mjs');
  await fs.writeFile(file, stub.content, 'utf8');
  await execFileAsync(process.execPath, ['--check', file]);
});

test('summaries are sanitized and omit absolute home paths', () => {
  const rawPath = '/Users/fakeperson/secret/token.txt';
  const causes = failureCausesFromRuns({
    'run-home': {
      jobs: [
        failJob({
          error: `blocked: missing file at ${rawPath}`,
        }),
      ],
    },
  });
  assert.equal(causes.length, 1);
  assert.ok(causes[0].summary.length <= 120);
  assert.doesNotMatch(causes[0].summary, /\/Users\/fakeperson/);
  assert.match(causes[0].summary, /<home>/);
});
