// SPDX-License-Identifier: Apache-2.0
// swarm120-ship: lessons #147 (ship half), #150, #151, #154, #156.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ship, selectLockCheck, platformOnlyFailures, undocumentedBinaryWarnings, swarmEnvInTestWarnings,
  DOCUMENTED_TEST_BINARIES,
} from '../tools/ship.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ship120-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writePayload(root, payload) {
  const file = path.join(root, 'pr.json');
  await fs.writeFile(file, JSON.stringify(payload));
  return file;
}

const payload = (fields = {}) => ({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text', ...fields });

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });
const clean = () => ok('');
const rev = sha => ok(`${sha}\n`);
const prJson = (overrides = {}) => JSON.stringify({ number: 7, html_url: 'https://example.com/pr/7', ...overrides });
const rollupView = (overrides = {}) => JSON.stringify({ state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [], ...overrides });

// Same shape as tests/ship.test.mjs's own fake: answers a fixed script in order, and auto-resolves
// `git remote`/`git merge-base` (origin URL / no prior release) the same way every ship() call does.
function makeExec(script) {
  const calls = [];
  let index = 0;
  const exec = async (file, args, opts) => {
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'merge-base') return fail('no package');
    calls.push({ file, args, opts });
    if (index >= script.length) throw new Error(`Unexpected exec call #${index + 1}: ${file} ${args.join(' ')}`);
    const entry = script[index++];
    return typeof entry === 'function' ? entry(file, args, opts) : entry;
  };
  return { exec, calls };
}

function baseOptions(root, payloadPath, overrides = {}) {
  return {
    root, repo: 'acme/widgets', payloadPath,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  };
}

function greenScript(extra = []) {
  return [
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    ok(rollupView({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
    ...extra,
  ];
}

// --- lesson #147: pre-push lock check -----------------------------------------------------

test('selectLockCheck: picks npm-lock-check for package.json/package-lock.json, uv-lock-check for pyproject.toml/uv.lock, null otherwise', () => {
  assert.deepEqual(selectLockCheck(['package.json']), { name: 'npm-lock-check', argv: ['npm', 'ci', '--dry-run'] });
  assert.deepEqual(selectLockCheck(['sub/dir/package-lock.json']), { name: 'npm-lock-check', argv: ['npm', 'ci', '--dry-run'] });
  assert.deepEqual(selectLockCheck(['pyproject.toml']), { name: 'uv-lock-check', argv: ['uv', 'lock', '--check'] });
  assert.deepEqual(selectLockCheck(['uv.lock']), { name: 'uv-lock-check', argv: ['uv', 'lock', '--check'] });
  assert.equal(selectLockCheck(['README.md']), null);
  assert.equal(selectLockCheck([]), null);
  assert.equal(selectLockCheck(undefined), null);
});

test('ship: a stale lockfile refuses before push (fixture: run touched package.json, npm-lock-check fails)', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([
    clean(), rev('sha123'),
    fail('npm ci can only install packages when your package.json and package-lock.json are in sync'),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec, integratedFiles: ['package.json'] }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /^npm-lock-check failed:/);
  const lockCall = calls.find(c => c.file === 'npm');
  assert.deepEqual(lockCall.args, ['ci', '--dry-run']);
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
});

test('ship: a run with no version/manifest file in its outputs never runs a lock check', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec(greenScript());
  const result = await ship(baseOptions(root, payloadPath, { exec, merge: false, integratedFiles: ['docs/notes.md'] }));
  assert.equal(result.status, 'ready');
  assert.ok(!calls.some(c => c.file === 'npm' || c.file === 'uv'));
});

test('ship: a passing lock check does not block the push', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([
    clean(), rev('sha123'),
    ok('would install 10 packages'),
    clean(), ok('[]'), ok(prJson()),
    ok(rollupView({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec, merge: false, integratedFiles: ['pyproject.toml'] }));
  assert.equal(result.status, 'ready');
  const lockCall = calls.find(c => c.file === 'uv');
  assert.deepEqual(lockCall.args, ['lock', '--check']);
});

// --- lesson #150: lease push for the coordinator's own amended branch ---------------------

test('ship: lease-pushes with --force-with-lease when the remote head diverged but the coordinator moved it', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([
    clean(), rev('sha123'),
    fail('! [rejected]        feature-branch -> feature-branch (non-fast-forward)\nerror: failed to push some refs'),
    ok('deadbeef00\trefs/heads/feature-branch\n'),
    ok('swarm-bot\n'),
    ok('swarm-bot\n'),
    clean(),
    ok('[]'), ok(prJson()),
    ok(rollupView({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec, merge: false }));
  assert.equal(result.status, 'ready');
  const leaseCall = calls.find(c => c.file === 'git' && c.args[0] === 'push' && c.args.some(a => a.startsWith('--force-with-lease=')));
  assert.ok(leaseCall);
  assert.ok(leaseCall.args.includes('--force-with-lease=feature-branch:deadbeef00'));
});

test('ship: refuses (does not lease-force) when the diverged remote head was moved by someone else', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([
    clean(), rev('sha123'),
    fail('! [rejected]        feature-branch -> feature-branch (non-fast-forward)\nerror: failed to push some refs'),
    ok('deadbeef00\trefs/heads/feature-branch\n'),
    ok('swarm-bot\n'),
    ok('someone-else\n'),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /moved by someone-else/);
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push' && c.args.some(a => a.startsWith('--force-with-lease='))));
});

test('ship: a push failure unrelated to a non-fast-forward rejection never attempts a lease push', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([clean(), rev('sha123'), fail('no permission')]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'push failed: no permission');
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'ls-remote'));
});

// --- lesson #151: platform-only CI failures -----------------------------------------------

test('platformOnlyFailures: silent when every OS is red, or only one OS is in the matrix', () => {
  const allRed = [
    { name: 'test (ubuntu-latest)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'test (windows-latest)', status: 'COMPLETED', conclusion: 'FAILURE' },
  ];
  assert.deepEqual(platformOnlyFailures(allRed), []);
  const oneOs = [{ name: 'test (ubuntu-latest)', status: 'COMPLETED', conclusion: 'FAILURE' }];
  assert.deepEqual(platformOnlyFailures(oneOs), []);
  assert.deepEqual(platformOnlyFailures([]), []);
});

test('platformOnlyFailures: names the OS and failing ids when only some OS entries in the matrix are red', () => {
  const rollup = [
    { name: 'test (ubuntu-latest, 20.x)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'lint (ubuntu-latest, 20.x)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'test (windows-latest, 20.x)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'test (macos-latest, 20.x)', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  assert.deepEqual(platformOnlyFailures(rollup), [{ os: 'ubuntu', testIds: ['test (ubuntu-latest, 20.x)', 'lint (ubuntu-latest, 20.x)'] }]);
});

test('ship: ci-failed on a 1/3 OS matrix prints the platform-only failure line naming the OS and failing ids', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const rollup = [
    { name: 'test (ubuntu-latest, 20.x)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'test (windows-latest, 20.x)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'test (macos-latest, 20.x)', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  const { exec } = makeExec([
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    ok(rollupView({ statusCheckRollup: rollup })),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'ci-failed');
  assert.ok(result.warnings.includes('platform-only failure: ubuntu: test (ubuntu-latest, 20.x)'));
});

test('ship: a CI failure red on every OS gets no platform-only line', async t => {
  const root = await fixture(t);
  const payloadPath = await writePayload(root, payload());
  const rollup = [
    { name: 'test (ubuntu-latest)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'test (windows-latest)', status: 'COMPLETED', conclusion: 'FAILURE' },
  ];
  const { exec } = makeExec([
    clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()),
    ok(rollupView({ statusCheckRollup: rollup })),
  ]);
  const result = await ship(baseOptions(root, payloadPath, { exec }));
  assert.equal(result.status, 'ci-failed');
  assert.ok(!result.warnings.some(w => w.startsWith('platform-only failure:')));
});

// --- lesson #154: check:ci-like allowlist / fake-or-skip seam -----------------------------

test('undocumentedBinaryWarnings: flags a spawned binary outside the documented allowlist, skips one with a nearby fake/skip seam', () => {
  const files = new Map([
    ['tests/a.test.mjs', "execFileSync('lsof', []);"],
    ['tests/b.test.mjs', "// fake lsof in this file\nexecFileSync('lsof', []);"],
    ['tests/c.test.mjs', "execFileSync('git', ['status']);"],
  ]);
  assert.deepEqual(undocumentedBinaryWarnings(files), [{ file: 'tests/a.test.mjs', bin: 'lsof' }]);
});

test('DOCUMENTED_TEST_BINARIES: names the already-vetted binaries ship itself relies on', () => {
  for (const bin of ['git', 'gh', 'node', 'npm', 'npx']) assert.ok(DOCUMENTED_TEST_BINARIES.has(bin));
});

test('ship: refuses when a test file spawns a binary outside the documented allowlist with no fake/skip seam', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  const testFile = 'tests/fixture.test.mjs';
  await fs.writeFile(path.join(root, testFile), "import { execFileSync } from 'node:child_process';\nexecFileSync('lsof', ['-i']);\n");
  const payloadPath = await writePayload(root, payload());
  const { exec, calls } = makeExec([clean(), rev('sha123')]);
  const result = await ship(baseOptions(root, payloadPath, { exec, integratedFiles: [testFile] }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /lsof/);
  assert.ok(!calls.some(c => c.args?.[0] === 'push'));
});

test('ship: a spawned binary with a nearby fake/skip seam is not refused', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  const testFile = 'tests/fixture.test.mjs';
  await fs.writeFile(path.join(root, testFile), "// skip: lsof is faked in CI\nimport { execFileSync } from 'node:child_process';\nexecFileSync('lsof', ['-i']);\n");
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec(greenScript());
  const result = await ship(baseOptions(root, payloadPath, { exec, merge: false, integratedFiles: [testFile] }));
  assert.equal(result.status, 'ready');
});

// --- lesson #156: a swarm-exported env var read by a project test file -------------------

test('swarmEnvInTestWarnings: flags a test file referencing a swarm-exported env var', () => {
  const files = new Map([
    ['tests/a.test.mjs', 'const base = process.env.SWARM_PORT_BASE;'],
    ['tests/b.test.mjs', 'const other = process.env.OTHER_VAR;'],
  ]);
  assert.deepEqual(swarmEnvInTestWarnings(files), [{ file: 'tests/a.test.mjs', name: 'SWARM_PORT_BASE' }]);
});

test('ship: warns swarm-env-in-tests with a stub/unset hint when a test file references SWARM_PORT_BASE, without refusing', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  const testFile = 'tests/fixture.test.mjs';
  await fs.writeFile(path.join(root, testFile), 'const base = process.env.SWARM_PORT_BASE;\n');
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec(greenScript());
  const result = await ship(baseOptions(root, payloadPath, { exec, merge: false, integratedFiles: [testFile] }));
  assert.equal(result.status, 'ready');
  assert.ok(result.warnings.includes(`swarm-env-in-tests: ${testFile}: references SWARM_PORT_BASE; stub or unset it in this test (lesson #156)`));
});

test('ship: a test file outside tests/ referencing SWARM_PORT_BASE is not scanned', async t => {
  const root = await fixture(t);
  const srcFile = 'src/config.mjs';
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, srcFile), 'const base = process.env.SWARM_PORT_BASE;\n');
  const payloadPath = await writePayload(root, payload());
  const { exec } = makeExec(greenScript());
  const result = await ship(baseOptions(root, payloadPath, { exec, merge: false, integratedFiles: [srcFile] }));
  assert.equal(result.status, 'ready');
  assert.ok(!result.warnings.some(w => w.startsWith('swarm-env-in-tests:')));
});
