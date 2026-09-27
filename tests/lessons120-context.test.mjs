// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  preflightProject,
  probeCheckInterpreters,
  resolveCheckProbe,
  describeProbeFailure,
} from '../tools/preflight.mjs';
import {
  findUncoveredTests,
  directoryGuardCoverage,
  registryPinningWarnings,
} from '../tools/context-check.mjs';

const job = (id, fields = {}) => ({ id, agent: 'claude', model: 'sonnet', prompt: 'Implement the stated behavior and report its acceptance check.', context: [], outputs: [], ...fields });
const manifest = (...jobs) => ({ version: 1, concurrency: 2, jobs });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lessons120-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Field lesson 129: interpreter/module probe, including env-prefix argv resolution.

test('resolveCheckProbe: resolves the real argv[0] after env VAR=... prefixes, including a uv-wrapped python -m form', () => {
  assert.deepEqual(resolveCheckProbe(['env', 'PYTHONPATH=/x', 'python3', '--version']), {
    program: 'python3', kind: 'interpreter', probeArgv: ['python3', '--version'],
  });
  assert.deepEqual(resolveCheckProbe(['env', 'FOO=bar', 'uv', 'run', '--no-sync', 'python3', '-m', 'pytest']), {
    program: 'python3', module: 'pytest', kind: 'module',
    probeArgv: ['uv', 'run', '--no-sync', 'python3', '-c', 'import pytest'],
  });
});

test('probeCheckInterpreters: a missing python module is refused with a clear message naming the check and module', async () => {
  const failingExec = async probeArgv => {
    if (probeArgv.includes('-c')) throw new Error("ModuleNotFoundError: No module named 'nope'");
  };
  const failures = await probeCheckInterpreters(
    { checks: [{ name: 'pytest', argv: ['python3', '-m', 'nope'] }] },
    { exec: failingExec },
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].check, 'pytest');
  assert.equal(failures[0].module, 'nope');
  assert.match(describeProbeFailure(failures[0]), /pytest/);
  assert.match(describeProbeFailure(failures[0]), /nope/);
});

test('preflightProject: refuses a manifest whose check names a missing python module', async t => {
  const root = await fixture(t);
  const failingExec = async probeArgv => { if (probeArgv.includes('-c')) throw new Error('no module'); };
  const input = { ...manifest(job('a')), checks: [{ name: 'pytest', argv: ['python3', '-m', 'nope'] }] };
  await assert.rejects(preflightProject(root, input, { exec: failingExec }), error => {
    assert.match(error.message, /pytest/);
    assert.match(error.message, /nope/);
    return true;
  });
});

test('preflightProject: a check argv with a present interpreter/module passes', async t => {
  const root = await fixture(t);
  const passingExec = async () => ({});
  const input = { ...manifest(job('a')), checks: [{ name: 'pytest', argv: ['python3', '-m', 'pytest'] }] };
  const report = await preflightProject(root, input, { exec: passingExec });
  assert.equal(report.status, 'preflight');
});

test('probeCheckInterpreters: probes cheaply — one exec call per distinct resolved probe command', async () => {
  let calls = 0;
  const exec = async () => { calls += 1; };
  await probeCheckInterpreters({
    checks: [
      { name: 'a', argv: ['python3', '-m', 'pytest'] },
      { name: 'b', argv: ['python3', '-m', 'pytest'] },
    ],
  }, { exec });
  assert.equal(calls, 1);
});

// Field lesson 140: a directory/extension-glob guard test covers a new same-kind side file.

test('directoryGuardCoverage: recognizes a readdirSync + extension filter as directory coverage', () => {
  const text = "const files = fs.readdirSync('src/quick').filter(f => f.endsWith('.css'));";
  const covered = directoryGuardCoverage(text);
  assert.ok(covered.some(entry => entry.dir === 'src/quick' && entry.ext === '.css'));
});

test('findUncoveredTests: a new .css side output alongside a guarded main stylesheet is recognized as covered by a directory glob guard', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src', 'quick'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'quick', 'styles.css'), 'body{color:red}');
  await fs.writeFile(path.join(root, 'src', 'quick', 'extra.css'), '.tile{color:blue}');
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(
    path.join(root, 'tests', 'guard.test.mjs'),
    "import { readFileSync, globSync } from 'node:fs';\nconst files = globSync('src/quick/**/*.css');\nfor (const f of files) readFileSync(f, 'utf8');\n",
  );
  const found = findUncoveredTests(root, { id: 'w', context: [], outputs: ['src/quick/extra.css'] });
  assert.deepEqual(found, [{ output: 'src/quick/extra.css', test: 'tests/guard.test.mjs' }]);
});

// Field lesson 155: registry-pinning-tests.

test('registryPinningWarnings: a job adding catalog/x/connector.yaml with a test that globs catalog/ warns, naming the test', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(
    path.join(root, 'tests', 'test_catalog.py'),
    "import glob\n\ndef load_catalog():\n    return glob.glob('catalog/*/connector.yaml')\n",
  );
  const found = registryPinningWarnings(root, { id: 'w', context: [], outputs: ['catalog/x/connector.yaml'], ignoreTests: [] });
  assert.equal(found.length, 1);
  assert.equal(found[0].code, 'registry-pinning-tests');
  assert.deepEqual(found[0].tests, ['tests/test_catalog.py']);
  assert.match(found[0].message, /test_catalog\.py/);
});

test('registryPinningWarnings: silent when the enumerating test is already in the job\'s context/outputs/ignoreTests', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(
    path.join(root, 'tests', 'test_catalog.py'),
    "import glob\n\ndef load_catalog():\n    return glob.glob('catalog/*/connector.yaml')\n",
  );
  const covered = { id: 'w', context: ['tests/test_catalog.py'], outputs: ['catalog/x/connector.yaml'] };
  assert.deepEqual(registryPinningWarnings(root, covered), []);
});
