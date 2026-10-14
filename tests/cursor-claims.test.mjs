// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { git } from '../tools/codex-adapter.mjs';
import { cursorClaimConflicts, validateManifest, validateProject, runManifest, integrateRun } from '../tools/swarm.mjs';

const KEY = 'crsr_FAKE_TEST_KEY_0123456789';
const job = (overrides = {}) => ({ id: 'writer', agent: 'cursor', model: 'composer-2.5', prompt: 'Update the output and test it.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });
const manifest = overrides => ({ version: 1, jobs: [job(overrides)] });
const envelope = { files_changed: ['output.txt'], notes: ['Fake cursor worker completed.'] };
const cursorResult = text => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 12, result: text, session_id: 'fake-session' });
const sq = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

async function tempDir(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t) {
  const root = await tempDir(t, 'swarm-cursor-claims-');
  await git(root, ['init']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return root;
}
async function fakeCursor(t, body) {
  const dir = await tempDir(t, 'swarm-fake-cursor-');
  const versionDir = path.join(dir, 'versions', '1'), binDir = path.join(dir, 'bin');
  await fs.mkdir(versionDir, { recursive: true });
  await fs.mkdir(binDir);
  const real = path.join(versionDir, 'cursor-agent');
  await fs.writeFile(real, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await fs.symlink(real, path.join(binDir, 'cursor-agent'));
  return { dir, real, versionDir, binDir };
}
const success = `printf 'proposed by cursor' > output.txt
printf '%s\\n' ${sq(cursorResult(`Done.\n${JSON.stringify(envelope)}`))}`;
function viaFake(observe = () => {}) {
  return (command, args, options) => {
    assert.equal(command, 'sandbox-exec');
    assert.equal(args[0], '-f');
    assert.equal(options.detached, true);
    assert.equal(options.shell, false);
    assert.equal(options.stdio[0], 'ignore');
    observe(args, options);
    return spawn(args[2], args.slice(3), options);
  };
}
const runEnv = (fake, extra = {}) => ({ ...process.env, PATH: `${fake.binDir}:/usr/bin:/bin`, CURSOR_API_KEY: KEY, SWARM_KEEP_TMP: '0', ...extra });
const options = (fake, extra = {}) => ({ platform: 'darwin', env: runEnv(fake), spawnImpl: viaFake(), ...extra });
async function writeClaims(root, claims) {
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/cursor-claims.json'), typeof claims === 'string' ? claims : JSON.stringify(claims));
}

test('a cursor job completes with no claims file', async t => {
  const root = await fixture(t), fake = await fakeCursor(t, success);
  assert.deepEqual(await cursorClaimConflicts(root, manifest().jobs), []);
  const state = await runManifest(root, manifest(), options(fake));
  assert.equal(state.status, 'complete', state.jobs[0]?.error);
});

test('a claimed output refuses before spawn, registration or run state', async t => {
  const root = await fixture(t), fake = await fakeCursor(t, success);
  await writeClaims(root, { 'cursor-owner': { files: ['output.txt'], base: 'abc' } });
  const id = 'claimed-output', liveDir = path.join(root, '.swarm/live');
  let spawns = 0;
  await assert.rejects(runManifest(root, manifest(), options(fake, { id, liveDir, spawnImpl: () => { spawns++; assert.fail('must not spawn'); } })), error => {
    assert.equal(error.code, 'cursor-claim-conflict');
    assert.equal(error.message, 'Refusing to run: output.txt is claimed by Cursor lane job cursor-owner (coordination/cursor-claims.json); release it with `python3 tools/cursor_lane_guard.py release cursor-owner` or drop it from outputs');
    assert.deepEqual(error.details, { cursorClaims: [{ claim: 'cursor-owner', files: ['output.txt'], jobIds: ['writer'] }] });
    return true;
  });
  assert.equal(spawns, 0);
  await assert.rejects(fs.access(path.join(root, '.swarm/runs', id)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(liveDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
});

test('an unrelated claim allows a cursor job to complete', async t => {
  const root = await fixture(t), fake = await fakeCursor(t, success);
  await writeClaims(root, { owner: { files: ['unrelated.txt'], base: 'abc' } });
  const state = await runManifest(root, manifest(), options(fake));
  assert.equal(state.status, 'complete', state.jobs[0]?.error);
});

for (const [name, claims] of [
  ['malformed JSON', '{'],
  ['files not an array', { owner: { files: 'output.txt', base: 'abc' } }],
  ['top-level array', []],
  ['null entry', { owner: null }],
  ['non-string file', { owner: { files: [42], base: 'abc' } }],
  ['missing base', { owner: { files: [] } }],
]) {
  test(`${name} refuses run and produces a validation warning`, async t => {
    const root = await fixture(t), fake = await fakeCursor(t, success);
    await writeClaims(root, claims);
    await assert.rejects(runManifest(root, manifest(), options(fake, { spawnImpl: () => assert.fail('must not spawn') })), error => {
      assert.equal(error.code, 'cursor-claims-invalid');
      assert.ok(error.message.startsWith('cursor-claims-invalid: coordination/cursor-claims.json '));
      return true;
    });
    const result = await validateProject(root, manifest(), { env: runEnv(fake) });
    assert.ok(result.warnings.some(warning => warning.code === 'cursor-claims-invalid' && warning.message.startsWith('cursor-claims-invalid: coordination/cursor-claims.json ')));
  });
}

test('validateProject warns with claim, files and jobIds without throwing', async t => {
  const root = await fixture(t), fake = await fakeCursor(t, success);
  await writeClaims(root, { owner: { files: ['output.txt'], base: 'abc' } });
  const result = await validateProject(root, manifest(), { env: runEnv(fake) });
  assert.deepEqual(result.warnings.filter(warning => warning.code === 'cursor-claim-conflict'), [{
    code: 'cursor-claim-conflict', claim: 'owner', files: ['output.txt'], jobIds: ['writer'],
    message: 'cursor-claim-conflict: output.txt is claimed by Cursor lane job owner; startable jobs: (none)',
  }]);
});

test('claim conflicts sort and deduplicate; open scope checks both containment directions', async t => {
  const root = await fixture(t);
  await fakeCursor(t, success);
  await writeClaims(root, {
    z: { files: ['tree/child.txt', 'tree/child.txt', 'other.txt'], base: 'abc' },
    a: { files: ['tree'], base: 'abc' },
  });
  const jobs = [job({ id: 'z', scope: 'open', outputs: ['tree'] }), job({ id: 'a', scope: 'open', outputs: ['tree/child.txt'] }), job({ id: 'exact', outputs: ['tree/child.txt'] })];
  assert.deepEqual(await cursorClaimConflicts(root, jobs), [
    { claim: 'a', files: ['tree'], jobIds: ['a', 'z'] },
    { claim: 'z', files: ['tree/child.txt'], jobIds: ['a', 'exact', 'z'] },
  ]);
  assert.deepEqual(await cursorClaimConflicts(root, [job({ outputs: ['tree'] })]), [{ claim: 'a', files: ['tree'], jobIds: ['writer'] }]);
});

test('the cursor smoke example validates, runs with a fake and integrates its output', async t => {
  const smoke = JSON.parse(await fs.readFile(new URL('../examples/cursor-smoke.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateManifest(smoke));
  const root = await fixture(t);
  const output = 'coordination/cursor-handshake.md';
  const fake = await fakeCursor(t, `mkdir -p coordination\nprintf 'proposed by cursor' > ${sq(output)}\nprintf '%s\\n' ${sq(cursorResult(JSON.stringify({ files_changed: [output], notes: ['Smoke complete.'] })))}`);
  const state = await runManifest(root, smoke, options(fake));
  assert.equal(state.status, 'complete', state.jobs[0]?.error);
  assert.deepEqual((await integrateRun(root, state.id, { env: runEnv(fake) })).files, [output]);
  assert.equal(await fs.readFile(path.join(root, output), 'utf8'), 'proposed by cursor');
});
