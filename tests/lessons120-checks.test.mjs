// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runManifest, integrateRun, validateManifest, validateProject, askRun, scoutRun } from '../tools/swarm.mjs';
import { readSessionMetrics, writeSessionMetric } from '../tools/session-metrics.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lessons120-checks-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, extra = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...extra });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;
const update = fake(`fs.writeFileSync('input.txt','updated'); ${done}`);

// --- lesson #152: a check that exits 127 is unrunnable, with a hint, not a plain failure -------

test('a check that exits 127 is classified unrunnable with a hint, not failed, and checksErrored is true', async t => {
  const root = await fixture(t);
  let calls = 0;
  const spawnImpl = (command, args, options) => { if (command === process.execPath) calls++; return spawn(command, args, options); };
  const checks = [{ name: 'missing-tool', argv: [process.execPath, '-e', 'process.exit(127)'] }];
  const state = await runManifest(root, manifest([job()], { checks }), { spawnImpl: update });
  const result = await integrateRun(root, state.id, { spawnImpl });
  assert.equal(result.checks[0].status, 'unrunnable');
  assert.match(result.checks[0].hint, /npm ci|uv sync/);
  assert.equal(result.checksPassed, false);
  assert.equal(result.checksErrored, true);
  // one initial run plus exactly one automatic retry, since no preChecks were declared
  assert.equal(calls, 2);
  assert.equal(result.checks[0].retriedAfterError, true);
});

// --- lesson #134/#138: a bad spawn is spawn-error, distinct from failed, and also retries once --

test('a bad spawn (missing binary) is classified spawn-error with a hint and retried exactly once', async t => {
  const root = await fixture(t);
  const missingBinary = path.join(root, 'no-such-binary-xyz');
  let calls = 0;
  const spawnImpl = (command, args, options) => { if (command === missingBinary) calls++; return spawn(command, args, options); };
  const checks = [{ name: 'ghost', argv: [missingBinary] }];
  const state = await runManifest(root, manifest([job()], { checks }), { spawnImpl: update });
  const result = await integrateRun(root, state.id, { spawnImpl });
  assert.equal(result.checks[0].status, 'spawn-error');
  assert.match(result.checks[0].hint, /could not start/);
  assert.equal(result.checksPassed, false);
  assert.equal(result.checksErrored, true);
  assert.equal(calls, 2);
});

test('a check whose own binary does not exist yet gets one preChecks run and one retry, ending green once the preCheck creates it', async t => {
  const root = await fixture(t);
  const helperScript = path.join(root, 'helper.mjs');
  // A dynamic import of a missing ESM module surfaces Node's own ERR_MODULE_NOT_FOUND, exactly
  // the case lesson #152 names, distinct from a plain nonzero-exit failure.
  const checks = [{ name: 'helper', argv: [process.execPath, '--input-type=module', '-e', 'await import(process.argv[1]);', helperScript] }];
  const preChecks = [[process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(helperScript)}, 'console.log(0)')`]];
  const state = await runManifest(root, manifest([job()], { checks, preChecks }), { spawnImpl: update });
  const result = await integrateRun(root, state.id, { spawnImpl: spawn });
  assert.equal(result.checks[0].status, 'passed');
  assert.equal(result.checks[0].retriedAfterError, true);
  assert.equal(result.checksPassed, true);
  assert.equal(result.checksErrored, false);
  assert.equal(result.retryPreChecks.length, 1);
  assert.equal(result.retryPreChecks[0].status, 'passed');
});

test('CLI integrate exits non-zero when checksErrored, even without --require-checks', async t => {
  const root = await fixture(t);
  const checks = [{ name: 'missing-tool', argv: [process.execPath, '-e', 'process.exit(127)'] }];
  const state = await runManifest(root, manifest([job()], { checks }), { spawnImpl: update, id: 'checks-errored-cli' });
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'integrate', state.id]), error => {
    assert.equal(error.code, 1);
    const parsed = JSON.parse(error.stdout);
    assert.equal(parsed.checksErrored, true);
    return true;
  });
});

// --- lesson #127/#148: stale-env-risk ------------------------------------------------------------

test('validate warns stale-env-risk for a version-only pyproject.toml bump with no preChecks declared', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nversion = "0.1.0"\n');
  const withoutPreChecks = job({ context: ['input.txt', 'pyproject.toml'], outputs: ['pyproject.toml'] });
  const report = await validateProject(root, manifest([withoutPreChecks]));
  assert.ok(report.warnings.some(w => w.code === 'stale-env-risk' && w.path === 'pyproject.toml'));
});

test('validate does not warn stale-env-risk when the manifest declares preChecks', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nversion = "0.1.0"\n');
  const withPreChecks = job({ context: ['input.txt', 'pyproject.toml'], outputs: ['pyproject.toml'] });
  const report = await validateProject(root, manifest([withPreChecks], { preChecks: [[process.execPath, '-e', 'process.exit(0)']] }));
  assert.equal(report.warnings.some(w => w.code === 'stale-env-risk'), false);
});

// --- lesson #149: tight-test-timeout -------------------------------------------------------------

test('validate warns tight-test-timeout for a timeout literal under 5s in a test file, silent for the same line outside tests/', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'tests', 'race.test.mjs'), "await wait_for(barrier.wait(), timeout=1)\n");
  const testsJob = job({ id: 'w1', context: ['input.txt'], outputs: ['tests/race.test.mjs'] });
  const report = await validateProject(root, manifest([testsJob]));
  assert.ok(report.warnings.some(w => w.code === 'tight-test-timeout' && w.path === 'tests/race.test.mjs'));

  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'race.mjs'), "await wait_for(barrier.wait(), timeout=1)\n");
  const srcJob = job({ id: 'w2', context: ['input.txt'], outputs: ['src/race.mjs'] });
  const report2 = await validateProject(root, manifest([srcJob]));
  assert.equal(report2.warnings.some(w => w.code === 'tight-test-timeout'), false);
});

test('validate warns tight-test-timeout for a short JS setTimeout in a test file', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'tests', 'flaky.test.mjs'), "await new Promise(r => setTimeout(r, 200));\n");
  const testsJob = job({ context: ['input.txt'], outputs: ['tests/flaky.test.mjs'] });
  const report = await validateProject(root, manifest([testsJob]));
  assert.ok(report.warnings.some(w => w.code === 'tight-test-timeout' && w.path === 'tests/flaky.test.mjs'));
});

// --- lesson #153: runtime-check-no-shell extension -----------------------------------------------

test('validate warns runtime-check-no-shell when a check argv contains a repeat construct (seq N) and the job has no shell', async t => {
  const root = await fixture(t);
  const checks = [{ name: 'race', argv: ['bash', '-c', 'seq 20 | while read i; do echo $i; done'] }];
  const report = await validateProject(root, manifest([job()], { checks }));
  assert.ok(report.warnings.some(w => w.code === 'runtime-check-no-shell' && w.jobId === 'writer'));
});

test('runtime-check-no-shell stays silent for a doc-only job even with a repeat-construct check', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'NOTES.md'), '# notes');
  const checks = [{ name: 'race', argv: ['bash', '-c', 'seq 20 | while read i; do echo $i; done'] }];
  const docJob = job({ context: ['input.txt'], outputs: ['NOTES.md'] });
  const report = await validateProject(root, manifest([docJob], { checks }));
  assert.equal(report.warnings.some(w => w.code === 'runtime-check-no-shell'), false);
});

test('runtime-check-no-shell fires when the prompt names a race/flaky bug and the job has no shell', async t => {
  const root = await fixture(t);
  const flakyJob = job({ prompt: 'Fix the race condition seen in CI; it is intermittent.' });
  const report = await validateProject(root, manifest([flakyJob]));
  assert.ok(report.warnings.some(w => w.code === 'runtime-check-no-shell' && w.jobId === 'writer'));
});

// --- lesson #133: scouts/asks write a state.json-compatible session-metrics record ---------------

test('an ask run writes a session-metrics record read back by readSessionMetrics', async t => {
  const root = await fixture(t);
  const script = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ answer: 'yes' }))},total_cost_usd:0.02}));`;
  const result = await askRun(root, { model: 'sonnet', context: ['input.txt'], question: 'Should we ship?' }, { spawnImpl: fake(script) });
  const records = await readSessionMetrics(root, { kinds: ['ask'] });
  const record = records.find(r => r.id === result.id);
  assert.ok(record, 'expected a session-metrics record for the ask run');
  assert.equal(typeof record.startedAt, 'string');
  assert.equal(typeof record.finishedAt, 'string');
  assert.equal(record.costUsd, 0.02);
});

test('a scout run writes a session-metrics record read back by readSessionMetrics', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'brief.md'), '# brief');
  const script = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ picks: [], rejected: [], top: [] }))},total_cost_usd:0.05}));`;
  const result = await scoutRun(root, { model: 'sonnet', brief: 'brief.md', goal: 'find libraries' }, { spawnImpl: fake(script) });
  const records = await readSessionMetrics(root, { kinds: ['scout'] });
  const record = records.find(r => r.id === result.id);
  assert.ok(record, 'expected a session-metrics record for the scout run');
  assert.equal(typeof record.startedAt, 'string');
  assert.equal(record.costUsd, 0.05);
});

test('integrate records a checks session-metrics window', async t => {
  const root = await fixture(t);
  const checks = [{ name: 'ok', argv: [process.execPath, '-e', 'process.exit(0)'] }];
  const state = await runManifest(root, manifest([job()], { checks }), { spawnImpl: update });
  await integrateRun(root, state.id);
  const records = await readSessionMetrics(root, { kinds: ['checks'] });
  const record = records.find(r => r.id === state.id);
  assert.ok(record, 'expected a session-metrics record for the checks phase');
  assert.equal(typeof record.startedAt, 'string');
  assert.equal(typeof record.finishedAt, 'string');
});

test('writeSessionMetric/readSessionMetrics round-trip a record and skip corrupt entries', async t => {
  const root = await fixture(t);
  await writeSessionMetric(root, 'checks', 'abc123', { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', costUsd: null });
  await fs.mkdir(path.join(root, '.swarm/session-metrics/checks'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/session-metrics/checks/corrupt.json'), 'not json');
  const records = await readSessionMetrics(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'abc123');
  assert.equal(records[0].kind, 'checks');
});

// --- hook (a): the bare `validate` command also probes check interpreters -----------------------

test('CLI validate refuses when a check names a missing interpreter (probeCheckInterpreters hook)', async t => {
  const root = await fixture(t);
  const check = { name: 'ghost', argv: ['definitely-not-a-real-binary-xyz-120', '--version'] };
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest([job()], { checks: [check] })));
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'validate', 'manifest.json']), error => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stderr).error, /definitely-not-a-real-binary-xyz-120/);
    return true;
  });
});

test('CLI validate still succeeds when every check interpreter is present', async t => {
  const root = await fixture(t);
  const check = { name: 'ok', argv: [process.execPath, '--version'] };
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest([job()], { checks: [check] })));
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'validate', 'manifest.json']);
  assert.equal(JSON.parse(stdout).status, 'valid');
});

// --- hook (b): registryPinningWarnings wired into validateProject --------------------------------

test('validateProject surfaces registryPinningWarnings for a job adding a new file under a directory an existing test enumerates', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(
    path.join(root, 'tests', 'test_catalog.py'),
    "import glob\n\ndef load_catalog():\n    return glob.glob('catalog/*/connector.yaml')\n",
  );
  const catalogJob = job({ context: ['input.txt'], outputs: ['catalog/x/connector.yaml'] });
  const report = await validateProject(root, manifest([catalogJob]));
  const warning = report.warnings.find(w => w.code === 'registry-pinning-tests');
  assert.ok(warning, 'expected a registry-pinning-tests warning');
  assert.match(warning.message, /test_catalog\.py/);
});

test('validateProject stays silent on registry-pinning-tests once the enumerating test is in context', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(
    path.join(root, 'tests', 'test_catalog.py'),
    "import glob\n\ndef load_catalog():\n    return glob.glob('catalog/*/connector.yaml')\n",
  );
  const catalogJob = job({ context: ['input.txt', 'tests/test_catalog.py'], outputs: ['catalog/x/connector.yaml'] });
  const report = await validateProject(root, manifest([catalogJob]));
  assert.equal(report.warnings.some(w => w.code === 'registry-pinning-tests'), false);
});
