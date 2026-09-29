// SPDX-License-Identifier: Apache-2.0
// Swarm batch R: field lessons 242-243 (see .swarm-manifests/contract-r.md).
// #243: when --rerun-flaky is absent, ship defaults to one automatic rerun only when every failed
// check is platform-only (platformOnlyFailures(ciRollup) covers every failed name); an explicit
// --rerun-flaky N (including 0) always wins over that default, and the in-diff skip / second-fail
// rule from lesson #178 are unchanged.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ship } from '../tools/ship.mjs';

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });

// Command-matched fake exec (same style as tests/field-lessons-batch-j.test.mjs's own fakeShipExec):
// answers by which git/gh command was called, never by call order.
function fakeShipExec(handlers = {}) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts?.cwd });
    for (const handler of handlers.custom ?? []) {
      const result = await handler(file, args, opts);
      if (result !== undefined) return result;
    }
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'rev-parse') return ok(`${handlers.sha ?? 'sha-fixture'}\n`);
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'merge-base') return handlers.baseSha ? ok(`${handlers.baseSha}\n`) : fail('no base');
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      const jsonIdx = args.indexOf('--json');
      const fields = jsonIdx >= 0 ? args[jsonIdx + 1] : '';
      if (fields.includes('mergeCommit')) return (handlers.mergedView ?? (() => ok(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'merged-sha' } }))))();
      return handlers.prView();
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return ok(JSON.stringify({ code: 0 }));
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

const payload = (fields = {}) => ({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text', ...fields });

// A 3-OS matrix (ubuntu/windows/macos) where "test" fails on windows only, everything else green.
const PLATFORM_ONLY_ROLLUP = [
  { name: 'test (ubuntu-latest, 20.x)', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'test (windows-latest, 20.x)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/555/job/1' },
  { name: 'test (macos-latest, 20.x)', status: 'COMPLETED', conclusion: 'SUCCESS' },
];
const GREEN_ROLLUP = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const WINDOWS_LOG = 'FAILED tests/test_windows_timing.py::test_delay - AssertionError\n';

function rollupOk(rollup) {
  return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: rollup }));
}

describe('#243: ship rerun-flaky default applies only when every failed check is platform-only', () => {
  test('(a) default + all fails platform-only + failing test not in diff: one rerun, then merge on green', async t => {
    const root = await tmp(t, 'swarm-r-rerun-a-');
    const payloadPath = await writePayload(root, payload());
    let prViewCalls = 0;
    const { exec, calls } = fakeShipExec({
      prView: () => { prViewCalls++; return prViewCalls === 1 ? rollupOk(PLATFORM_ONLY_ROLLUP) : rollupOk(GREEN_ROLLUP); },
      ghRun: args => (args[1] === 'view' ? ok(WINDOWS_LOG) : ok('')),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['src/feature.py'],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'merged', JSON.stringify(result));
    assert.deepEqual(result.flakyRerun, { attempts: 1, result: 'passed', tests: ['tests/test_windows_timing.py'] });
    assert.equal(result.timing.rerunCount, 1);
    const rerunCalls = calls.filter(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun' && c.args[2] === '555');
    assert.equal(rerunCalls.length, 1);
    assert.ok(result.warnings.includes('rerun-flaky-default: 1 (platform-only)'));
  });

  test('(b) default + one platform-only and one cross-OS fail: no rerun, ci-failed', async t => {
    const root = await tmp(t, 'swarm-r-rerun-b-');
    const payloadPath = await writePayload(root, payload());
    const rollup = [
      { name: 'test (ubuntu-latest)', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test (windows-latest)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/601/job/1' },
      { name: 'build (ubuntu-latest)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/602/job/1' },
      { name: 'build (windows-latest)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/603/job/1' },
    ];
    const { exec, calls } = fakeShipExec({ prView: () => rollupOk(rollup) });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['src/feature.py'],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ci-failed', JSON.stringify(result));
    assert.equal(result.flakyRerun, undefined);
    assert.ok(!calls.some(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun'));
    assert.ok(!result.warnings.some(w => w.startsWith('rerun-flaky-default:')));
  });

  test('(c) explicit --rerun-flaky 0 + platform-only: no rerun, no default warning', async t => {
    const root = await tmp(t, 'swarm-r-rerun-c-');
    const payloadPath = await writePayload(root, payload());
    const { exec, calls } = fakeShipExec({ prView: () => rollupOk(PLATFORM_ONLY_ROLLUP) });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['src/feature.py'],
      rerunFlaky: 0,
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ci-failed', JSON.stringify(result));
    assert.ok(!calls.some(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun'));
    assert.ok(!result.warnings.some(w => w.startsWith('rerun-flaky-default:')));
  });

  test('(d) default + platform-only + second fail: ci-failed after exactly one rerun', async t => {
    const root = await tmp(t, 'swarm-r-rerun-d-');
    const payloadPath = await writePayload(root, payload());
    const { exec, calls } = fakeShipExec({
      prView: () => rollupOk(PLATFORM_ONLY_ROLLUP),
      ghRun: args => (args[1] === 'view' ? ok(WINDOWS_LOG) : ok('')),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['src/feature.py'],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ci-failed', JSON.stringify(result));
    assert.deepEqual(result.flakyRerun, { attempts: 1, result: 'failed', tests: ['tests/test_windows_timing.py'] });
    assert.equal(result.timing.rerunCount, 1);
    const rerunCalls = calls.filter(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun');
    assert.equal(rerunCalls.length, 1);
  });

  test('(e) default + failing test in the diff: no rerun (inDiff skip)', async t => {
    const root = await tmp(t, 'swarm-r-rerun-e-');
    const payloadPath = await writePayload(root, payload());
    const { exec, calls } = fakeShipExec({
      prView: () => rollupOk(PLATFORM_ONLY_ROLLUP),
      ghRun: args => (args[1] === 'view' ? ok(WINDOWS_LOG) : ok('')),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['tests/test_windows_timing.py'],
      exec, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ci-failed', JSON.stringify(result));
    assert.ok(!calls.some(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun'));
    assert.ok(result.warnings.some(w => w.startsWith('rerun-flaky-skipped:')));
  });
});

// --- #242: contract template names the spend-cap mid-case test requirement -----------------------

test('#242: templates/coordination/CONTRACT.md Tests section requires a mid-case cap-trip test for spend-cap contracts', async () => {
  const text = await fs.readFile(new URL('../templates/coordination/CONTRACT.md', import.meta.url), 'utf8');
  const testsSection = text.slice(text.indexOf('## Tests'), text.indexOf('## Release'));
  assert.match(testsSection, /single case trips the cap mid-way/);
  assert.match(testsSection, /each request, not each case\/task/);
});
