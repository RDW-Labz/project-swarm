// SPDX-License-Identifier: Apache-2.0
// Field lessons #204, #207, T51-fields (swarm 1.26.0 batch M, m1-pins-ship).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCheckPins } from '../tools/check-pins.mjs';
import { ship } from '../tools/ship.mjs';

async function tmpRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-m1-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// --- #204: check-pins R2b, "pin-not-vendored" -----------------------------------------------

test('#204: an exact pin on a package vendored nowhere, with no [tool.uv.sources] entry, fails pin-not-vendored', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-service"\ndependencies = [\n  "connectors==0.0.1",\n]\n`);

  const result = await runCheckPins({ root, core: 'acme-core', appPrefix: 'acme-app-' });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.findings, [{
    rule: 'pin-not-vendored', file: 'pyproject.toml', package: 'connectors',
    message: 'connectors is pinned to 0.0.1 but has no vendored wheel and no [tool.uv.sources] entry',
  }]);
});

test('#204: the same exact pin backed by an inline [tool.uv.sources] entry is not pin-not-vendored', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    `[project]\nname = "acme-service"\ndependencies = [\n  "connectors==0.0.1",\n]\n\n[tool.uv.sources]\nconnectors = { path = "../connectors" }\n`,
  );

  const result = await runCheckPins({ root, core: 'acme-core', appPrefix: 'acme-app-' });
  assert.deepEqual(result, { ok: true, exitCode: 0, findings: [] });
});

test('#204: the same exact pin backed by a [tool.uv.sources.<name>] sub-table is not pin-not-vendored', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    `[project]\nname = "acme-service"\ndependencies = [\n  "connectors==0.0.1",\n]\n\n[tool.uv.sources.connectors]\npath = "../connectors"\n`,
  );

  const result = await runCheckPins({ root, core: 'acme-core', appPrefix: 'acme-app-' });
  assert.deepEqual(result, { ok: true, exitCode: 0, findings: [] });
});

test('#204: pin-not-vendored fires without --core too (it is not one of the two core-specific rules)', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'pyproject.toml'), `[project]\nname = "acme-service"\ndependencies = [\n  "connectors==0.0.1",\n]\n`);

  const result = await runCheckPins({ root });
  assert.deepEqual(result.skippedRules, ['library-exact-core-pin', 'wheel-requirement-unsatisfied', 'vendored-core-missing-runtime-wheels']);
  assert.deepEqual(result.findings.map(f => f.rule), ['pin-not-vendored']);
});

// --- #207: ship's scratch-file guard judges the real diff, never a job's declared outputs -----

const okRes = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const failRes = (stdout = '', stderr = 'boom') => ({ code: 1, stdout, stderr });

function fakeExec({ baseSha = 'base-1', diffFiles = [], stagedFiles = [], custom = [] } = {}) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    for (const handler of custom) {
      const result = await handler(file, args, opts);
      if (result !== undefined) return result;
    }
    if (file === 'git' && args[0] === 'remote') return okRes('https://github.com/acme/widgets.git\n');
    if (file === 'git' && args[0] === 'rev-parse') return okRes('sha-fixture\n');
    if (file === 'git' && args[0] === 'status') return okRes('');
    if (file === 'git' && args[0] === 'merge-base') return baseSha ? okRes(`${baseSha}\n`) : failRes('', 'no base');
    if (file === 'git' && args[0] === 'diff' && args.includes('--cached')) return okRes(stagedFiles.join('\n'));
    if (file === 'git' && args[0] === 'diff' && args[1] === '--name-only') return okRes(diffFiles.join('\n'));
    if (file === 'git' && args[0] === 'push') return okRes('');
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return okRes('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return okRes(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return okRes(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

async function writePayload(root, payload = {}) {
  const file = path.join(root, 'pr.json');
  await fs.writeFile(file, JSON.stringify({ title: 't', head: 'feature', base: 'main', body: 'body text', ...payload }));
  return file;
}

async function shipWith(t, root, options) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-m1-ship-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return ship({
    root, repo: 'acme/widgets', payloadPath: await writePayload(root), merge: false,
    runChecks: async () => [], sleep: async () => {}, now: () => 0,
    env: { SWARM_HOME: path.join(home, '.project-swarm'), PATH: '/usr/bin' }, home,
    ...options,
  });
}

test('#207: a declared output matching a scratch pattern that is git-ignored and never committed does not refuse ship', async t => {
  const root = await tmpRoot(t);
  // The real diff carries none of this: the file was never actually committed.
  const { exec } = fakeExec({ diffFiles: ['tools/a.mjs'], stagedFiles: [] });
  const result = await shipWith(t, root, { exec, integratedFiles: ['tools/a.mjs', '.swarm-manifests/t48c-mutants.json'] });
  assert.equal(result.status, 'ready', JSON.stringify(result));
});

test('#207: the same file, actually committed (present in the real diff), refuses with scratch-file-in-diff', async t => {
  const root = await tmpRoot(t);
  const { exec, calls } = fakeExec({ diffFiles: ['tools/a.mjs', '.swarm-manifests/t48c-mutants.json'] });
  const result = await shipWith(t, root, { exec, integratedFiles: ['tools/a.mjs', '.swarm-manifests/t48c-mutants.json'] });
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'scratch-file-in-diff');
  assert.match(result.reason, /scratch-file-in-diff: \.swarm-manifests\/t48c-mutants\.json/);
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
});

// --- T51-fields: ship() result gains timing ----------------------------------------------------

function fakeClock(startMs = 0) {
  let t = startMs;
  return { now: () => t, advance: ms => { t += ms; return t; } };
}

test('T51: timing.checksSeconds, ciWaitSeconds and attempts on a clean, single-poll ship', async t => {
  const root = await tmpRoot(t);
  const clock = fakeClock();
  const { exec } = fakeExec({
    custom: [(file, args) => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return okRes(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      }
      return undefined;
    }],
  });
  const result = await shipWith(t, root, {
    exec, now: clock.now, sleep: async ms => { clock.advance(ms); },
    pollMs: 20000,
    runChecks: async () => { clock.advance(2500); return []; },
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.deepEqual(result.timing, { checksSeconds: 2.5, ciWaitSeconds: 0, attempts: 1, rerunCount: 0 });
});

test('T51: timing.attempts and ciWaitSeconds count a real CI poll wait, seconds rounded to 0.1', async t => {
  const root = await tmpRoot(t);
  const clock = fakeClock();
  let viewCalls = 0;
  const { exec } = fakeExec({
    custom: [(file, args) => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        viewCalls += 1;
        if (viewCalls === 1) return okRes(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] }));
        return okRes(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      }
      return undefined;
    }],
  });
  const result = await shipWith(t, root, {
    exec, now: clock.now, sleep: async ms => { clock.advance(ms); },
    pollMs: 12340, // 12.34s -> rounds to 12.3
    runChecks: async () => [],
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.equal(result.timing.attempts, 1);
  assert.equal(result.timing.ciWaitSeconds, 12.3);
});

test('T51: rerunCount and attempts after one automatic flaky rerun', async t => {
  const root = await tmpRoot(t);
  const clock = fakeClock();
  let viewCalls = 0;
  const { exec } = fakeExec({
    custom: [(file, args) => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        viewCalls += 1;
        // First round: ci fails. Second round (after the automatic rerun): ci passes.
        const status = viewCalls === 1 ? { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', target_url: 'https://x/actions/runs/555' } : { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' };
        return okRes(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [status] }));
      }
      if (file === 'gh' && args[0] === 'run' && args[1] === 'view') return okRes('no matching failures here');
      if (file === 'gh' && args[0] === 'run' && args[1] === 'rerun') return okRes('');
      return undefined;
    }],
  });
  const result = await shipWith(t, root, {
    exec, now: clock.now, sleep: async ms => { clock.advance(ms); },
    pollMs: 1000, rerunFlaky: 1, integratedFiles: [],
    runChecks: async () => [],
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.equal(result.timing.attempts, 2);
  assert.equal(result.timing.rerunCount, 1);
});
