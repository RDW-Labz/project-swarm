// SPDX-License-Identifier: Apache-2.0
// Field lessons #180, #186, #187, #192 as ship checks:
// #192: a failing check was labelled pre-existing (and merged) although both failing tests were
// NEW in the PR; the tests also failed only because ship's checks lacked the toolchains bin dir on
// PATH. A failing test is pre-existing only when the same test id fails on the base commit; every
// failing check carries `baseStatus`, and checks ship spawns get the toolchains bin dir on PATH.
// #186: the test suite wrote fixture rows into the real exemption audit log.
// #187: `ship --help` was an unknown flag, and a ship result did not name its run.
// #180: a scratch PR body was committed into a release.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ship, extractFailingTestIds, exemptionLogPath, logExemption, toolchainCheckEnv, SHIP_USAGE, shipHelpRequested,
  scratchFileMatches, parseExemptFlag, EXEMPTION_GUARD_IDS,
} from '../tools/ship.mjs';

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stdout = '', stderr = 'boom') => ({ code: 1, stdout, stderr });

// Command-matched fake exec: answers by which git/gh command was called, never by call order.
function fakeShipExec(handlers = {}) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    for (const handler of handlers.custom ?? []) {
      const result = await handler(file, args, opts);
      if (result !== undefined) return result;
    }
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'rev-parse') return ok('sha-fixture\n');
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'merge-base') return handlers.baseSha ? ok(`${handlers.baseSha}\n`) : fail('', 'no base');
    // #207: the scratch guard judges `git diff --name-only <base>...HEAD` (the real diff), not a
    // run's declared outputs; a fixture names exactly which paths that diff reports as changed.
    if (file === 'git' && args[0] === 'diff' && args[1] === '--name-only') return ok((handlers.diffFiles ?? []).join('\n'));
    if (file === 'git' && args[0] === 'worktree') return ok('');
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

async function writePayload(root, payload = {}) {
  const file = path.join(root, 'pr.json');
  await fs.writeFile(file, JSON.stringify({ title: 't', head: 'feature', base: 'main', body: 'body text', ...payload }));
  return file;
}

// Every ship() here runs with a temp home, so no test touches the real install dir (lesson #186).
async function shipWith(t, root, options) {
  const home = await tmp(t, 'swarm-125-home-');
  return ship({
    root, repo: 'acme/widgets', payloadPath: await writePayload(root), merge: false,
    runChecks: async () => [], sleep: async () => {}, now: () => 0,
    env: { SWARM_HOME: path.join(home, '.project-swarm'), PATH: '/usr/bin' }, home,
    ...options,
  });
}

// The base checkout `git worktree add` would create, holding the given files.
function worktreeWith(files) {
  return async (file, args) => {
    if (file !== 'git' || args[0] !== 'worktree' || args[1] !== 'add') return undefined;
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(args[3], name)), { recursive: true });
      await fs.writeFile(path.join(args[3], name), text);
    }
    return ok('');
  };
}

const PYTEST_NEW_TESTS = [
  'FAILED tests/test_wheel.py::test_wheel_declares_agent_core_as_a_range_not_a_pin - AssertionError',
  'FAILED tests/test_wheel.py::test_wheel_version_is_0_5_1 - AssertionError',
  '2 failed, 40 passed',
].join('\n');

describe('L192: a failing test is pre-existing only when the same test id fails on base', () => {
  test('extractFailingTestIds reads pytest, node TAP/spec, vitest and go failure lines', () => {
    assert.deepEqual(extractFailingTestIds(PYTEST_NEW_TESTS), ['tests/test_wheel.py::test_wheel_declares_agent_core_as_a_range_not_a_pin', 'tests/test_wheel.py::test_wheel_version_is_0_5_1']);
    assert.deepEqual(extractFailingTestIds('ok 1 - fine\nnot ok 2 - widget parses input\n  ---'), ['widget parses input']);
    assert.deepEqual(extractFailingTestIds('✖ widget parses input (12.5ms)\n✖ failing tests:\n'), ['widget parses input']);
    assert.deepEqual(extractFailingTestIds(' FAIL  src/a.test.ts > widget > parses'), ['src/a.test.ts > widget > parses']);
    assert.deepEqual(extractFailingTestIds('--- FAIL: TestWidget (0.00s)'), ['TestWidget']);
    assert.deepEqual(extractFailingTestIds('all good'), []);
  });

  test('tests the PR adds (file absent on base) are never pre-existing, even when the base run also fails', async t => {
    const root = await tmp(t, 'swarm-125-absent-');
    const { exec } = fakeShipExec({ baseSha: 'base-1', custom: [(file) => (file === 'fake-pytest' ? fail('FAILED tests/test_other.py::test_old - boom') : undefined)] });
    const result = await shipWith(t, root, {
      exec, checkArgvs: [['fake-pytest']],
      runChecks: async () => [{ name: 'ci-2-uv', status: 'failed', exitCode: 1, tail: PYTEST_NEW_TESTS }],
    });
    assert.equal(result.status, 'checks-failed', JSON.stringify(result));
    assert.equal(result.checks[0].status, 'failed');
    assert.equal(result.checks[0].baseStatus, 'absent');
    assert.ok(result.checks[0].failingTests.every(entry => entry.baseStatus === 'absent'));
  });

  test('a test whose file exists on base but whose function does not is absent', async t => {
    const root = await tmp(t, 'swarm-125-absent-fn-');
    const { exec } = fakeShipExec({ baseSha: 'base-1', custom: [worktreeWith({ 'tests/test_wheel.py': 'def test_something_else():\n    pass\n' }), (file) => (file === 'fake-pytest' ? fail('FAILED tests/test_other.py::test_old') : undefined)] });
    const result = await shipWith(t, root, {
      exec, checkArgvs: [['fake-pytest']],
      runChecks: async () => [{ name: 'ci', status: 'failed', exitCode: 1, tail: PYTEST_NEW_TESTS }],
    });
    assert.equal(result.status, 'checks-failed');
    assert.equal(result.checks[0].baseStatus, 'absent');
  });

  test('the same test ids failing on base are pre-existing (baseStatus fail) and do not block', async t => {
    const root = await tmp(t, 'swarm-125-same-');
    const { exec } = fakeShipExec({ baseSha: 'base-1', custom: [worktreeWith({ 'tests/test_wheel.py': 'def test_wheel_declares_agent_core_as_a_range_not_a_pin():\n    pass\ndef test_wheel_version_is_0_5_1():\n    pass\n' }), (file) => (file === 'fake-pytest' ? fail(PYTEST_NEW_TESTS) : undefined)] });
    const result = await shipWith(t, root, {
      exec, checkArgvs: [['fake-pytest']],
      runChecks: async () => [{ name: 'ci', status: 'failed', exitCode: 1, tail: PYTEST_NEW_TESTS }],
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(result.checks[0].status, 'pre-existing');
    assert.equal(result.checks[0].baseStatus, 'fail');
  });

  test('a check that passes on base is baseStatus pass and blocks', async t => {
    const root = await tmp(t, 'swarm-125-pass-');
    const { exec } = fakeShipExec({ baseSha: 'base-1', custom: [worktreeWith({ 'tests/test_wheel.py': 'def test_wheel_declares_agent_core_as_a_range_not_a_pin():\n    pass\ndef test_wheel_version_is_0_5_1():\n    pass\n' }), (file) => (file === 'fake-pytest' ? ok('42 passed') : undefined)] });
    const result = await shipWith(t, root, {
      exec, checkArgvs: [['fake-pytest']],
      runChecks: async () => [{ name: 'ci', status: 'failed', exitCode: 1, tail: PYTEST_NEW_TESTS }],
    });
    assert.equal(result.status, 'checks-failed');
    assert.equal(result.checks[0].baseStatus, 'pass');
  });

  test('a base that cannot be established is baseStatus unknown and blocks', async t => {
    const root = await tmp(t, 'swarm-125-unknown-');
    const { exec } = fakeShipExec({});
    const result = await shipWith(t, root, {
      exec, checkArgvs: [['fake-pytest']],
      runChecks: async () => [{ name: 'ci', status: 'failed', exitCode: 1, tail: PYTEST_NEW_TESTS }],
    });
    assert.equal(result.status, 'checks-failed');
    assert.equal(result.checks[0].baseStatus, 'unknown');
  });

  test('head names failing tests but the base run names none: unknown, blocks', async t => {
    const root = await tmp(t, 'swarm-125-unknown-ids-');
    const { exec } = fakeShipExec({ baseSha: 'base-1', custom: [worktreeWith({ 'tests/test_wheel.py': 'def test_wheel_version_is_0_5_1():\n    pass\n' }), (file) => (file === 'fake-pytest' ? fail('collection error') : undefined)] });
    const result = await shipWith(t, root, {
      exec, checkArgvs: [['fake-pytest']],
      runChecks: async () => [{ name: 'ci', status: 'failed', exitCode: 1, tail: 'FAILED tests/test_wheel.py::test_wheel_version_is_0_5_1' }],
    });
    assert.equal(result.status, 'checks-failed');
    assert.equal(result.checks[0].baseStatus, 'unknown');
  });

  test('checks ship spawns (the base re-run, and runChecks) get the toolchains bin dir first on PATH', async t => {
    const root = await tmp(t, 'swarm-125-path-');
    const home = await tmp(t, 'swarm-125-path-home-');
    const toolchains = path.join(home, 'toolchains');
    let seenEnv = null, runChecksArg = null;
    const { exec } = fakeShipExec({ baseSha: 'base-1', custom: [(file, args, opts) => { if (file === 'fake-check') { seenEnv = opts?.env; return fail('x'); } return undefined; }] });
    await ship({
      root, repo: 'acme/widgets', payloadPath: await writePayload(root), merge: false, sleep: async () => {}, now: () => 0,
      env: { SWARM_TOOLCHAINS: toolchains, SWARM_HOME: path.join(home, 'sh'), PATH: '/usr/bin:/bin' }, home,
      exec, checkArgvs: [['fake-check']],
      runChecks: async arg => { runChecksArg = arg; return [{ name: 'c', status: 'failed', exitCode: 1, tail: 'x' }]; },
    });
    assert.equal(seenEnv?.PATH, `${path.join(toolchains, 'bin')}:/usr/bin:/bin`);
    assert.equal(runChecksArg?.env?.PATH, `${path.join(toolchains, 'bin')}:/usr/bin:/bin`);
    assert.equal(toolchainCheckEnv({ env: { PATH: '/bin' }, home }).PATH, `${path.join(home, '.project-swarm/toolchains/bin')}:/bin`);
  });
});

describe('L186: the exemption audit log honours SWARM_HOME and never lands in the real home under tests', () => {
  test('exemptionLogPath: SWARM_LOGS_DIR, then SWARM_HOME/logs, then home', () => {
    assert.equal(exemptionLogPath({ env: { SWARM_LOGS_DIR: '/x/logs' }, home: '/h' }), '/x/logs/ship-exemptions.jsonl');
    assert.equal(exemptionLogPath({ env: { SWARM_HOME: '/sh' }, home: '/h' }), '/sh/logs/ship-exemptions.jsonl');
    assert.equal(exemptionLogPath({ env: {}, home: '/h' }), '/h/.project-swarm/logs/ship-exemptions.jsonl');
  });

  test('logExemption writes under SWARM_HOME', async t => {
    const home = await tmp(t, 'swarm-125-log-');
    const file = await logExemption({ guard: 'env-var' }, { env: { SWARM_HOME: home }, home: '/nonexistent-home' });
    assert.equal(file, path.join(home, 'logs/ship-exemptions.jsonl'));
    assert.match(await fs.readFile(file, 'utf8'), /env-var/);
  });

  test('under the test runner with no override, the default path is never the real home', () => {
    const file = exemptionLogPath({ env: { NODE_TEST_CONTEXT: 'child-v8' }, home: os.homedir() });
    assert.ok(!file.startsWith(path.join(os.homedir(), '.project-swarm')), file);
  });
});

describe('L187: ship --help, and every result names its run', () => {
  test('shipHelpRequested and SHIP_USAGE', () => {
    assert.equal(shipHelpRequested(['--help']), true);
    assert.equal(shipHelpRequested(['run-1', '-h']), true);
    assert.equal(shipHelpRequested(['run-1', '--pr', 'p.json']), false);
    assert.match(SHIP_USAGE, /ship RUN/);
    assert.match(SHIP_USAGE, /--branch BRANCH/);
    assert.match(SHIP_USAGE, /--exempt GUARD:FILE=REASON/);
  });

  test('runId (or branch) is on a refusal and on a ready result', async t => {
    const root = await tmp(t, 'swarm-125-runid-');
    const refused = await shipWith(t, root, { exec: fakeShipExec({}).exec, runId: 'run-123-abcd', mergeMethod: 'admin' });
    assert.equal(refused.status, 'refused');
    assert.equal(refused.runId, 'run-123-abcd');
    const ready = await shipWith(t, root, { exec: fakeShipExec({}).exec, branch: 'feature' });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.branch, 'feature');
  });
});

describe('L180: ship refuses a diff that adds a scratch file', () => {
  test('scratchFileMatches covers the scratch patterns', () => {
    for (const file of ['.pr-body.md', 'docs/.pr-body.md', '125-pr-create.json', '.swarm-manifests/contract-125.md', '.swarm-manifests/a/b.md', 'npm-test.out']) assert.equal(scratchFileMatches(file), true, file);
    for (const file of ['README.md', 'pr-body.md', 'tools/ship.mjs', 'docs/swarm-manifests.md', 'out/a.js']) assert.equal(scratchFileMatches(file), false, file);
  });

  test('an added scratch file refuses with scratch-file-in-diff before anything is pushed', async t => {
    const root = await tmp(t, 'swarm-125-scratch-');
    const { exec, calls } = fakeShipExec({ baseSha: 'base-1', diffFiles: ['tools/a.mjs', '.pr-body.md'] });
    const result = await shipWith(t, root, { exec, integratedFiles: ['tools/a.mjs', '.pr-body.md'] });
    assert.equal(result.status, 'refused');
    assert.equal(result.code, 'scratch-file-in-diff');
    assert.match(result.reason, /scratch-file-in-diff: \.pr-body\.md/);
    assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
  });

  test('a scratch-pattern file already on base is not "added"', async t => {
    const root = await tmp(t, 'swarm-125-scratch-base-');
    // Unchanged since base: absent from `git diff --name-only <base>...HEAD`, even though it is a
    // declared output of this run.
    const { exec } = fakeShipExec({ baseSha: 'base-1', diffFiles: [] });
    const result = await shipWith(t, root, { exec, integratedFiles: ['.swarm-manifests/old.md'] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
  });

  test('--exempt scratch:<file>=<reason> lets it through and records the exemption', async t => {
    const root = await tmp(t, 'swarm-125-scratch-exempt-');
    assert.ok(EXEMPTION_GUARD_IDS.includes('scratch'));
    const exemption = parseExemptFlag('scratch:fixtures/sample.out=fixture output the tests compare against');
    assert.equal(exemption.error, undefined);
    const { exec } = fakeShipExec({ baseSha: 'base-1', diffFiles: ['fixtures/sample.out'] });
    const result = await shipWith(t, root, { exec, integratedFiles: ['fixtures/sample.out'], exemptions: [exemption] });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.exemptions, [exemption]);
  });
});
