// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ship, classifyCiFailureLog, extractFailureBlocks, swarmCheckWarnings,
} from '../tools/ship.mjs';
import { loadChecksFromCi } from '../tools/checks-from-ci.mjs';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });

async function tmp(t, prefix = 'swarm-ai-ship-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function payload(root, value = { title: 't', head: 'feature', base: 'main', body: 'body' }) {
  const file = path.join(root, 'pr.json');
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}

function fakeExec({ prViews = [], runLog = '', onCreate } = {}) {
  const calls = [];
  let viewIndex = 0;
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'symbolic-ref') return ok('refs/remotes/origin/main\n');
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'rev-parse') return ok('sha-fixture\n');
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'git' && args[0] === 'merge-base') return fail('no base');
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) {
      onCreate?.(opts?.input);
      return ok(JSON.stringify({ number: 7, html_url: 'https://example.test/pr/7' }));
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return ok(JSON.stringify(prViews[Math.min(viewIndex++, prViews.length - 1)]));
    }
    if (file === 'gh' && args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed')) return ok(runLog);
    if (file === 'gh' && args[0] === 'run' && args[1] === 'view') return ok('');
    if (file === 'gh' && args[0] === 'run' && args[1] === 'rerun') return ok('');
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

describe('L372 local flaky checks and failure blocks', () => {
  test('retains TAP failure details and reruns only the failed fixture file', async t => {
    const root = await tmp(t);
    const fixtureFile = 'tests/fixture-once.test.mjs';
    const failure = [
      'not ok 1 - fixture fails once',
      '  ---',
      `  location: ${fixtureFile}:12:5`,
      '  operator: strictEqual',
      '  expected: 1',
      '  actual: 2',
      '  ...',
    ].join('\n');
    const { exec } = fakeExec({ prViews: [{ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }] });
    let runs = 0;
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath: await payload(root), merge: false,
      rerunFlaky: 1, exec, sleep: async () => {}, now: () => 0,
      runChecks: async options => {
        runs++;
        if (runs === 1) return [{ name: 'fixture', status: 'failed', exitCode: 1, output: failure, tail: failure }];
        assert.deepEqual(options.onlyFiles, [fixtureFile]);
        assert.deepEqual(options.failedTestFiles, [fixtureFile]);
        return [{ name: 'fixture', status: 'passed', exitCode: 0, output: `${fixtureFile}: passed`, tail: '' }];
      },
      checkArgvs: [['node', '--test', fixtureFile]],
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(runs, 2);
    assert.deepEqual(result.flakyRerun, { attempts: 1, result: 'passed', tests: [fixtureFile] });
    assert.deepEqual(extractFailureBlocks(failure), [{
      name: 'fixture fails once', location: `${fixtureFile}:12:5`, assertion: 'operator: strictEqual', block: failure,
    }]);
  });
});

describe('L374b CI timeout classification', () => {
  const timeoutLog = '2580 passed, 0 failed\n##[error]The action Tests has timed out after 12 minutes\n';

  test('classifies zero-failure summaries followed by step timeout as timeout', () => {
    assert.equal(classifyCiFailureLog(timeoutLog), 'timeout');
    assert.equal(classifyCiFailureLog('1 failed, 2579 passed\nThe action Tests has timed out'), null);
    assert.equal(classifyCiFailureLog('2580 passed, 0 failed\nrunner error'), null);
  });

  test('retries a timed-out failed job once and then proceeds when CI is green', async t => {
    const root = await tmp(t);
    const { exec, calls } = fakeExec({
      runLog: timeoutLog,
      prViews: [
        { state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'windows-tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/555/job/1' }] },
        { state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'windows-tests', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/widgets/actions/runs/555/job/1' }] },
      ],
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath: await payload(root), merge: false,
      exec, runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }], sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(result.ciTimeoutRetry.attempts, 1);
    assert.ok(calls.some(call => call.file === 'gh' && call.args.slice(0, 3).join(' ') === 'run rerun 555'));
  });
});

describe('L378/L381 CI check expansion and scratch warnings', () => {
  test('expands shell globs and adds a .swarm ignore to direct lint checks', async t => {
    const root = await tmp(t);
    await fs.mkdir(path.join(root, '.github/workflows'), { recursive: true });
    await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(path.join(root, 'tests/test_browser_a.py'), '');
    await fs.writeFile(path.join(root, 'tests/test_browser_b.py'), '');
    await fs.writeFile(path.join(root, '.github/workflows/ci.yml'), [
      'jobs:', '  test:', '    steps:', '      - run: pytest tests/test_browser_*.py', '      - run: eslint .',
    ].join('\n'));
    const result = await loadChecksFromCi(root);
    assert.deepEqual(result.checks[0].argv, ['pytest', 'tests/test_browser_a.py', 'tests/test_browser_b.py', '--ignore=.swarm']);
    assert.deepEqual(result.checks[1].argv, ['eslint', '.', '--ignore-pattern', '.swarm/**']);
  });

  test('warns when raw check output cites a .swarm path', () => {
    const warnings = swarmCheckWarnings([{ name: 'lint', status: 'failed', tail: 'eslint .swarm/runs/base/file.mjs' }]);
    assert.deepEqual(warnings, ['check-hit-swarm-dir: ignored 1 check output lines under .swarm/']);
  });

  test('ship --branch fills missing payload head and base from the remote default branch', async t => {
    const root = await tmp(t);
    let created;
    const { exec } = fakeExec({
      onCreate: input => { created = JSON.parse(input); },
      prViews: [{ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }],
    });
    const result = await ship({
      root, repo: 'acme/widgets', branch: 'feature-branch', payloadPath: await payload(root, { title: 't', body: 'body' }),
      merge: false, exec, runChecks: async () => [], sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(created.head, 'feature-branch');
    assert.equal(created.base, 'main');
  });
});
