// SPDX-License-Identifier: Apache-2.0
// `run`'s base-check gate (field lesson #253) runs the manifest's `checks` in the live project
// root before any dispatch. A check whose argv names an integrate-only placeholder
// ({integrated}, {integrated:.ext}, {new}, {new:.ext}) has no file list to expand to at base, so
// it must never be spawned with the literal placeholder (e.g. `prettier --write {integrated}`
// reads the pattern as a file name and fails, turning every base red). It is recorded as skipped,
// with its reason, never as a failure. `{root}` is expanded at base exactly as integrate does,
// and a check may opt out of the base gate with `"base": false`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runBaseChecks, runManifest, validateManifest } from '../tools/swarm.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'base-checks-placeholders-')));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...overrides });
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;
const fake = script => (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
// Fails exactly when it is handed an unexpanded integrate-only placeholder, the way a formatter
// given `{integrated}` as a literal file name does.
const placeholderCheck = (name, placeholder) => ({ name, argv: [process.execPath, '-e', 'process.exit(process.argv.slice(1).some(a => /^\\{(integrated|new)/.test(a)) ? 2 : 0)', placeholder] });

describe('base checks never run with an unexpanded integrate-only placeholder', () => {
  for (const placeholder of ['{integrated}', '{integrated:.ts}', '{new}', '{new:.py}']) {
    test(`a ${placeholder} check is skipped at base (never spawned) and recorded with its reason; the base stays green`, async t => {
      const root = await fixture(t);
      const spawned = [];
      const recording = (command, args, options) => { spawned.push(args); return spawn(command, args, options); };
      const record = await runBaseChecks(root, manifest([], { checks: [placeholderCheck('format', placeholder)] }), { spawnImpl: recording, baseSha: `sha-${placeholder.replace(/\W/g, '')}` });
      assert.equal(record.status, 'green', JSON.stringify(record));
      assert.deepEqual(record.failures, []);
      assert.equal(spawned.length, 0, 'the placeholder check must not be spawned at base');
      assert.deepEqual(record.skipped, [{ name: 'format', reason: `integrate-only placeholder ${placeholder}` }]);
    });
  }

  test('other checks in the same manifest still run at base, and a real failure still reads red', async t => {
    const root = await fixture(t);
    const checks = [placeholderCheck('format', '{integrated}'), { name: 'ok', argv: [process.execPath, '-e', 'process.exit(0)'] }, { name: 'broken', argv: [process.execPath, '-e', 'process.exit(1)'] }];
    const record = await runBaseChecks(root, manifest([], { checks }), { spawnImpl: spawn, baseSha: 'sha-mixed' });
    assert.equal(record.status, 'red');
    assert.deepEqual(record.failures, ['broken']);
    assert.deepEqual(record.skipped.map(item => item.name), ['format']);
  });

  test('{root} inside an argv item is expanded to the project root at base, as integrate does', async t => {
    const root = await fixture(t);
    const check = { name: 'rooted', argv: [process.execPath, '-e', 'process.exit(process.argv[1] === process.argv[2] + "/target" ? 0 : 3)', '{root}/target', root] };
    const record = await runBaseChecks(root, manifest([], { checks: [check] }), { spawnImpl: spawn, baseSha: 'sha-root' });
    assert.equal(record.status, 'green', JSON.stringify(record));
  });

  test('a check with "base": false is skipped at base with its reason; validate accepts only a boolean', async t => {
    const root = await fixture(t);
    const spawned = [];
    const recording = (command, args, options) => { spawned.push(args); return spawn(command, args, options); };
    const heavy = { name: 'e2e', argv: [process.execPath, '-e', 'process.exit(1)'], base: false };
    validateManifest(manifest(undefined, { checks: [heavy] }));
    assert.throws(() => validateManifest(manifest(undefined, { checks: [{ ...heavy, base: 'no' }] })), /Check base must be true or false: e2e/);
    const record = await runBaseChecks(root, manifest([], { checks: [heavy] }), { spawnImpl: recording, baseSha: 'sha-optout' });
    assert.equal(record.status, 'green');
    assert.equal(spawned.length, 0);
    assert.deepEqual(record.skipped, [{ name: 'e2e', reason: 'base: false' }]);
  });

  test('a cached verdict is reused only for the same checks: a stale red record from other checks is recomputed', async t => {
    const root = await fixture(t);
    // What an earlier runner left at this sha: red, because it ran the placeholder literally.
    await fs.mkdir(path.join(root, '.swarm/base-checks'), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm/base-checks/sha-stale.json'), JSON.stringify({ baseSha: 'sha-stale', status: 'red', failures: ['format'], failureLocations: { format: [] } }));
    const checks = [placeholderCheck('format', '{integrated}')];
    const first = await runBaseChecks(root, manifest([], { checks }), { spawnImpl: spawn, baseSha: 'sha-stale' });
    assert.equal(first.status, 'green', JSON.stringify(first));
    let spawns = 0;
    const counting = (...args) => { spawns++; return spawn(...args); };
    const ok = [{ name: 'ok', argv: [process.execPath, '-e', 'process.exit(0)'] }];
    await runBaseChecks(root, manifest([], { checks: ok }), { spawnImpl: counting, baseSha: 'sha-cache' });
    await runBaseChecks(root, manifest([], { checks: ok }), { spawnImpl: counting, baseSha: 'sha-cache' });
    assert.equal(spawns, 1, 'same sha and same checks still hit the cache');
    await runBaseChecks(root, manifest([], { checks: [...ok, { name: 'ok2', argv: [process.execPath, '-e', 'process.exit(0)'] }] }), { spawnImpl: counting, baseSha: 'sha-cache' });
    assert.equal(spawns, 3, 'different checks at the same sha are recomputed');
  });

  test('run is not refused when the only base "failure" would have been an unexpanded placeholder', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()], { checks: [placeholderCheck('format', '{integrated}')] }), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');${done}`), checkBase: true, baseChecks: { spawnImpl: spawn, baseSha: 'sha-run' } });
    assert.equal(state.jobs[0].status, 'complete');
  });
});
