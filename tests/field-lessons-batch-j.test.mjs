// SPDX-License-Identifier: Apache-2.0
// Field lessons #177-#178 as tool checks:
// #177: a hand-typed `ship --check` list drifts from a repo's CI — a format check CI never ran
// failed on files the repo had already committed unformatted, costing one wasted re-ship once
// ship's own (passing) hand-typed list never caught it. `ship --checks-from-ci [path]` reads a CI
// workflow's own `run:` steps as ship's own checks and warns `check-not-in-ci` for any hand check
// CI does not also run; a check that fails is re-verified against the base commit's own tree and
// reported `pre-existing` (still listed, no longer blocking) when it fails there too.
// #178: ship stopped on `ci-failed` when the failing CI tests were not in the PR diff (flaky
// Windows timing tests); a manual rerun passed. `ship --rerun-flaky N` reruns CI's failed jobs up
// to N times when none of the tests they failed on are in the PR's own diff.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ship } from '../tools/ship.mjs';
import { shipBranch, parseShipFlags } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });

// A command-matched fake exec (matches L175's own style in field-lessons-batch-h.test.mjs): answers
// by which git/gh command was called, not by call order, so adding a new call ship() makes along
// the way never breaks an unrelated existing case.
function fakeShipExec(handlers = {}) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts?.cwd });
    for (const handler of handlers.custom ?? []) {
      const result = handler(file, args, opts);
      if (result !== undefined) return result;
    }
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok(`${handlers.branch ?? 'feature-branch'}\n`);
    if (file === 'git' && args[0] === 'rev-parse') return ok(`${handlers.sha ?? 'sha-fixture'}\n`);
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'merge-base') return handlers.baseSha ? ok(`${handlers.baseSha}\n`) : fail('no base');
    if (file === 'git' && args[0] === 'worktree') return ok('');
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return (handlers.prView ?? (() => ok(JSON.stringify({ state: 'OPEN', headRefOid: handlers.sha ?? 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }))))();
    if (file === 'gh' && args[0] === 'run') return (handlers.ghRun ?? (() => ok('')))(args);
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

async function writePayload(root, payload) {
  const file = path.join(root, 'pr.json');
  await fs.writeFile(file, JSON.stringify(payload));
  return file;
}

describe('L177(a)/(b): ship --checks-from-ci reads CI\'s own run: steps as checks and warns on hand-check drift', () => {
  test('shipBranch: --checks-from-ci merges CI-derived checks and warns check-not-in-ci for a hand check CI does not also run', async t => {
    const root = await tmp(t, 'swarm-lessons-j-cifromci-');
    await git(root, ['init', '-q', '-b', 'main']);
    await fs.mkdir(path.join(root, '.github/workflows'), { recursive: true });
    // Two run: steps: one a real checker CI runs (kept), one a shell pipeline (skipped, not a
    // single check). "npm --version" is a command every dev machine running this suite already has.
    await fs.writeFile(path.join(root, '.github/workflows/ci.yml'), [
      'jobs:',
      '  test:',
      '    steps:',
      '      - run: npm --version',
      '      - run: echo building && npm run build',
      '',
    ].join('\n'));
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    await git(root, ['checkout', '-q', '-b', 'feature-branch']);
    await fs.writeFile(path.join(root, 'a.txt'), 'change');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'change']);
    const payloadPath = await writePayload(root, { title: 't', head: 'feature-branch', base: 'main', body: 'b' });

    // Field lesson #177: before the fix, ship has no --checks-from-ci flag at all.
    let flags;
    assert.doesNotThrow(() => {
      flags = parseShipFlags(['--branch', 'feature-branch', '--pr', payloadPath, '--no-merge', '--checks-from-ci', '--check', JSON.stringify(['npm', 'run', 'this-script-does-not-exist'])]);
    }, 'ship should accept --checks-from-ci (optionally with a path)');

    const { exec } = fakeShipExec({ branch: 'feature-branch' });
    const result = await shipBranch(root, flags, { exec, sleep: async () => {} });

    assert.ok(
      result.warnings.some(w => w.startsWith('check-not-in-ci: check-1')),
      `expected a check-not-in-ci warning for the hand check, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.checks.some(c => c.name.includes('npm') && c.status === 'passed'),
      `expected the CI-derived "npm --version" check to run and pass, got: ${JSON.stringify(result.checks)}`,
    );
    assert.ok(
      result.warnings.some(w => w.startsWith('checks-from-ci-skipped') && w.includes('shell-operator')),
      `expected the shell-pipeline run: line to be reported skipped, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  test('shipBranch: --checks-from-ci warns (does not throw) when the CI file is missing', async t => {
    const root = await tmp(t, 'swarm-lessons-j-cimissing-');
    await git(root, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(root, 'a.txt'), 'x');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    await git(root, ['checkout', '-q', '-b', 'feature-branch']);
    await fs.writeFile(path.join(root, 'a.txt'), 'y');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'change']);
    const payloadPath = await writePayload(root, { title: 't', head: 'feature-branch', base: 'main', body: 'b' });
    const flags = parseShipFlags(['--branch', 'feature-branch', '--pr', payloadPath, '--no-merge', '--checks-from-ci', '--check', JSON.stringify([process.execPath, '-e', 'process.exit(0)'])]);
    const { exec } = fakeShipExec({ branch: 'feature-branch' });
    const result = await shipBranch(root, flags, { exec, sleep: async () => {} });
    assert.ok(result.warnings.some(w => w === 'checks-from-ci: .github/workflows/ci.yml not found'));
  });
});

describe('L177(c): a failing check is verified against the base commit\'s tree and reported pre-existing when it fails there too', () => {
  test('ship: a check that also fails on the base tree is reported pre-existing and does not block the ship', async t => {
    const root = await tmp(t, 'swarm-lessons-j-preexisting-pass-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec, calls } = fakeShipExec({
      baseSha: 'base-sha-1',
      custom: [(file, args) => (file === 'fake-checker' ? fail('still unformatted') : undefined)],
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'format-check', status: 'failed', exitCode: 1, tail: 'unformatted' }],
      checkArgvs: [['fake-checker']],
      integratedFiles: [],
      merge: false,
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', `expected ship to proceed past a pre-existing failure, got: ${JSON.stringify(result)}`);
    assert.equal(result.checks[0].status, 'pre-existing');
    assert.ok(calls.some(c => c.file === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add'));
    assert.ok(calls.some(c => c.file === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove'));
  });

  test('ship: a check that only fails on the new tree (passes on base) is a genuine failure and still blocks the ship', async t => {
    const root = await tmp(t, 'swarm-lessons-j-preexisting-block-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec } = fakeShipExec({
      baseSha: 'base-sha-1',
      custom: [(file, args) => (file === 'fake-checker' ? ok('') : undefined)],
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'format-check', status: 'failed', exitCode: 1, tail: 'newly broken' }],
      checkArgvs: [['fake-checker']],
      integratedFiles: [],
      merge: false,
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'checks-failed');
    assert.equal(result.checks[0].status, 'failed');
  });
});

describe('L178: ship --rerun-flaky reruns CI\'s failed jobs when the failing tests are not in the PR diff', () => {
  test('ship: reruns once and reports flakyRerun on success when the failing test is not in the diff', async t => {
    const root = await tmp(t, 'swarm-lessons-j-flaky-pass-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    let prViewCalls = 0;
    const { exec, calls } = fakeShipExec({
      sha: 'sha-ci',
      prView: () => {
        prViewCalls++;
        if (prViewCalls === 1) {
          return ok(JSON.stringify({
            state: 'OPEN', headRefOid: 'sha-ci',
            statusCheckRollup: [{ name: 'windows-tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/555/job/1' }],
          }));
        }
        return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-ci', statusCheckRollup: [{ name: 'windows-tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      },
      ghRun: args => (args[1] === 'view' ? ok('FAILED tests/test_windows_timing.py::test_delay - AssertionError\n') : ok('')),
    });
    // Field lesson #178: before the fix, ship() never accepts/uses rerunFlaky and never reruns.
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['src/feature.py'],
      merge: false, rerunFlaky: 1,
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', `expected the rerun to succeed and ship to proceed, got: ${JSON.stringify(result)}`);
    assert.deepEqual(result.flakyRerun, { attempts: 1, result: 'passed', tests: ['tests/test_windows_timing.py'] });
    assert.ok(calls.some(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun' && c.args[2] === '555'));
  });

  test('ship: never reruns when a failing test file is in the PR\'s own diff', async t => {
    const root = await tmp(t, 'swarm-lessons-j-flaky-indiff-');
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const { exec, calls } = fakeShipExec({
      sha: 'sha-ci',
      prView: () => ok(JSON.stringify({
        state: 'OPEN', headRefOid: 'sha-ci',
        statusCheckRollup: [{ name: 'unit-tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/999/job/1' }],
      })),
      ghRun: args => (args[1] === 'view' ? ok('FAILED tests/test_feature.py::test_new_behavior - AssertionError\n') : ok('')),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['tests/test_feature.py'],
      merge: false, rerunFlaky: 1,
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ci-failed');
    assert.ok(!calls.some(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun'), 'a failing test in the diff must never be rerun');
  });
});
