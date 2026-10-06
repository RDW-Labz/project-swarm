import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ship } from '../tools/ship.mjs';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'failure') => ({ code: 1, stdout: '', stderr });

async function fixture(t, { held = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-ship-'));
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests', 'flake.py'), 'def test_flake(): pass\n');
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: held ? '**needs review' : 'body text' }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, payloadPath };
}

function rollup(head, run, conclusion = 'FAILURE') {
  return [{ name: 'unit', status: 'COMPLETED', conclusion, detailsUrl: `https://github.com/acme/widgets/actions/runs/${run}/job/1` }].map(item => ({ ...item, headRefOid: head }));
}

function fakeShip({ root, payloadPath, views, probe = () => ok('1 passed tests/flake.py\n'), baseProbe = probe, log = 'FAILED tests/flake.py::test_flake - AssertionError\n', rerun = ok(''), runChecks = async () => [{ name: 'local', status: 'passed', exitCode: 0, tail: '' }], rerunFlakyCi, rerunFlaky, held = false }) {
  let viewIndex = 0;
  const calls = [];
  const exec = async (file, args, options = {}) => {
    calls.push({ file, args, options });
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'rev-parse') return args[1] === 'origin/main' ? ok('base-sha\n') : ok('head-sha\n');
    if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      await fs.mkdir(path.join(args[3], 'tests'), { recursive: true });
      await fs.writeFile(path.join(args[3], 'tests', 'flake.py'), 'def test_flake(): pass\n');
      return ok('');
    }
    if (file === 'git' && args[0] === 'worktree') return ok('');
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'pytest') return options.cwd === root ? probe() : baseProbe();
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 7, html_url: 'https://example.test/pr/7' }));
    if (file === 'gh' && args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed')) return ok(log);
    if (file === 'gh' && args[0] === 'run' && args[1] === 'view') return ok('');
    if (file === 'gh' && args[0] === 'gh') return ok('');
    if (file === 'gh' && args[0] === 'run' && args[1] === 'rerun') return rerun;
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'head-sha', statusCheckRollup: views[Math.min(viewIndex++, views.length - 1)] }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return ok('');
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  const options = {
    root, repo: 'acme/widgets', payloadPath, exec, runChecks, checkArgvs: [['pytest', 'tests/flake.py']], integratedFiles: ['src/feature.py'],
    authorEmailExec: async () => ok(''), commitScanExec: async () => ok(''), sleep: async () => {}, now: () => 0, merge: false,
  };
  if (rerunFlakyCi !== undefined) options.rerunFlakyCi = rerunFlakyCi;
  if (rerunFlaky !== undefined) options.rerunFlaky = rerunFlaky;
  return { exec, calls, options };
}

test('L354 verified changed-file CI failure gets one fresh retry and confirmed flake row', async t => {
  const { root, payloadPath } = await fixture(t);
  const { calls, options } = fakeShip({ root, payloadPath, rerunFlakyCi: 1, views: [rollup('head-sha', 100), [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/widgets/actions/runs/101/job/1' }]] });
  const result = await ship(options);
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.deepEqual(result.flakyRerun.tests, ['tests/flake.py']);
  assert.ok(result.warnings.includes('rerun-flaky-ci: verified three local passes and a base pass; rerunning failed jobs once'));
  assert.deepEqual(result.flakyRerun.evidence, { headSha: 'head-sha', baseSha: 'base-sha', runIds: ['100'] });
  assert.equal(result.timing.rerunCount, 1);
  assert.equal(calls.filter(call => call.file === 'pytest').length, 4);
  assert.equal(calls.filter(call => call.file === 'gh' && call.args[0] === 'run' && call.args[1] === 'rerun').length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.swarm', 'flake-log.json'), 'utf8'))['tests/flake.py'].hits, 1);
});

test('L354 incomplete evidence and a second red never become a flake', async t => {
  await t.test('two local passes are ineligible', async subtest => {
    const { root, payloadPath } = await fixture(subtest);
    let probes = 0;
    const { calls, options } = fakeShip({ root, payloadPath, rerunFlakyCi: 1, views: [rollup('head-sha', 110)], probe: () => (++probes < 3 ? ok('1 passed tests/flake.py\n') : fail('FAILED tests/flake.py::test_flake')), baseProbe: () => ok('1 passed tests/flake.py\n') });
    const result = await ship(options);
    assert.equal(result.status, 'ci-failed');
    assert.equal(probes, 3);
    assert.ok(result.warnings.some(warning => warning.startsWith('rerun-flaky-ci-ineligible:')));
    assert.equal(calls.filter(call => call.file === 'gh' && call.args[1] === 'rerun').length, 0);
    await assert.rejects(fs.access(path.join(root, '.swarm', 'flake-log.json')));
  });

  await t.test('a fresh second red is never recorded', async subtest => {
    const { root, payloadPath } = await fixture(subtest);
    const { calls, options } = fakeShip({ root, payloadPath, rerunFlakyCi: 1, views: [rollup('head-sha', 120), [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/121/job/1' }]] });
    const result = await ship(options);
    assert.equal(result.status, 'ci-failed');
    assert.equal(calls.filter(call => call.file === 'gh' && call.args[1] === 'rerun').length, 1);
    await assert.rejects(fs.access(path.join(root, '.swarm', 'flake-log.json')));
  });

  await t.test('explicit zero does not enter the evidence path', async subtest => {
    const { root, payloadPath } = await fixture(subtest);
    const { calls, options } = fakeShip({ root, payloadPath, rerunFlakyCi: 0, views: [rollup('head-sha', 130)], log: '' });
    const result = await ship(options);
    assert.equal(result.status, 'ci-failed');
    assert.equal(calls.filter(call => call.file === 'pytest').length, 0);
  });

  await t.test('a green held PR still never merges', async subtest => {
    const { root, payloadPath } = await fixture(subtest, { held: true });
    const { calls, options } = fakeShip({ root, payloadPath, rerunFlakyCi: 1, views: [[{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }]] });
    const result = await ship(options);
    assert.equal(result.status, 'held');
    assert.equal(calls.filter(call => call.file === 'gh' && call.args[0] === 'pr' && call.args[1] === 'merge').length, 0);
  });
});
