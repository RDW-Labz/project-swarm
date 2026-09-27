// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runManifest, integrateRun, inspectRun, inspectResults, runMutantsCurrentTree, runCheck } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lessons120-mutants-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function gitFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lessons120-mutants-git-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  return root;
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, extra = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...extra });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;
const update = fake(`fs.writeFileSync('input.txt','updated'); ${done}`);

async function plainFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lessons120-mutants-tree-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function writeMutantsFile(t, mutants) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lessons120-mutants-file-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mutants.json');
  await fs.writeFile(file, JSON.stringify(mutants));
  return file;
}

// --- #136: mutants need a green baseline; a non-test-failure exit is invalid, never killed --------

test('mutants refuses to start when the check does not pass on the unmutated tree (a missing test file)', async t => {
  const root = await plainFixture(t);
  const original = 'function ok(v){return v<=10}\n';
  await fs.writeFile(path.join(root, 'target.js'), original);
  const mutantsPath = await writeMutantsFile(t, [{ name: 'off-by-one', file: 'target.js', find: 'v<=10', replace: 'v<10' }]);
  // Simulates a wrong test path: always exits 4 (pytest's own "file or directory not found"),
  // regardless of the file under test, so it fails identically for every mutant.
  const mutantCheck = JSON.stringify([process.execPath, '-e', "process.exit(require('fs').existsSync('missing-test-file.py')?0:4)"]);
  await assert.rejects(runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck }, spawn), /Refusing to run mutants/);
  assert.equal(await fs.readFile(path.join(root, 'target.js'), 'utf8'), original);
});

test('a mutant run that exits via a collection/usage error is invalid, never killed', async t => {
  const root = await plainFixture(t);
  const original = 'function ok(v){return v<=10}\n';
  await fs.writeFile(path.join(root, 'target.js'), original);
  const mutantsPath = await writeMutantsFile(t, [{ name: 'off-by-one', file: 'target.js', find: 'v<=10', replace: 'v<10' }]);
  // Passes (exit 0) on the unmutated tree (the guard text is still present); once mutated, the
  // guard text is gone, but the check reports it via a usage/collection-style exit (4), not the
  // real-test-failure exit (1) — never a genuine assertion failure.
  const mutantCheck = JSON.stringify([process.execPath, '-e', "process.exit(require('fs').readFileSync('target.js','utf8').includes('v<=10')?0:4)"]);
  const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck }, spawn);
  assert.equal(result.mutants[0].status, 'invalid');
  assert.equal(result.mutants[0].exitCode, 4);
  assert.deepEqual(result.mutantsSummary, { killed: 0, survived: 0, invalid: 1 });
  assert.equal(result.mutantsPassed, false);
  assert.equal(await fs.readFile(path.join(root, 'target.js'), 'utf8'), original);
});

test('a real test failure (exit 1) is still reported killed once the baseline is green', async t => {
  const root = await plainFixture(t);
  const original = 'function ok(v){return v<=10}\n';
  await fs.writeFile(path.join(root, 'target.js'), original);
  const mutantsPath = await writeMutantsFile(t, [{ name: 'off-by-one', file: 'target.js', find: 'v<=10', replace: 'v<10' }]);
  const mutantCheck = JSON.stringify([process.execPath, '-e', "process.exit(require('fs').readFileSync('target.js','utf8').includes('v<=10')?0:1)"]);
  const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck }, spawn);
  assert.equal(result.mutants[0].status, 'killed');
  assert.equal(result.mutantsSummary.killed, 1);
});

// --- #130: --mutants-file/--mutant-check implies --mutants on integrate ---------------------------

test('integrate --mutants-file/--mutant-check implies --mutants instead of silently skipping it', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: update });
  const mutantsPath = await writeMutantsFile(t, [{ name: 'flip', file: 'input.txt', find: 'updated', replace: 'mutated' }]);
  const mutantCheck = JSON.stringify([process.execPath, '-e', "process.exit(require('fs').readFileSync('input.txt','utf8')==='mutated'?1:0)"]);
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'integrate', state.id, '--mutants-file', mutantsPath, '--mutant-check', mutantCheck]);
  const result = JSON.parse(stdout);
  assert.ok(result.mutantsSummary, 'mutants must have actually run, not been silently skipped');
  assert.equal(result.mutantsSummary.killed, 1);
});

// --- #131: integrate --accept-blocked -------------------------------------------------------------

test('integrate --accept-blocked applies a blocked job\'s declared outputs, tags integrated-blocked, and carries the reason forward', async t => {
  const root = await fixture(t);
  const blockedReply = JSON.stringify({ status: 'blocked', summary: 'unexpected break outside scope (tests/test_catalog.py)' });
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(blockedReply)}}));`);
  const state = await runManifest(root, manifest(), { spawnImpl });
  assert.equal(state.jobs[0].status, 'blocked');
  await assert.rejects(integrateRun(root, state.id), /Only a complete/);
  const result = await integrateRun(root, state.id, { acceptBlocked: true });
  assert.equal(result.status, 'integrated');
  assert.equal(result.integrationStatus, 'integrated-blocked');
  assert.deepEqual(result.files, ['input.txt']);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
  assert.equal(result.blockedEvidence.length, 1);
  assert.equal(result.blockedEvidence[0].name, 'writer');
  assert.match(result.blockedEvidence[0].lines[0], /unexpected break outside scope/);
  // A second, ordinary integrate no longer accepts a blocked run once already integrated.
  await assert.rejects(integrateRun(root, state.id), /already integrated/);
});

test('a fully complete run is tagged integrationStatus complete even with --accept-blocked passed', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: update });
  const result = await integrateRun(root, state.id, { acceptBlocked: true });
  assert.equal(result.integrationStatus, 'complete');
  assert.equal('blockedEvidence' in result, false);
});

test('integrate --accept-blocked still refuses a run whose saved job outputs differ from the manifest', async t => {
  const root = await fixture(t);
  const blockedReply = JSON.stringify({ status: 'blocked', summary: 'unexpected break outside scope (tests/test_catalog.py)' });
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(blockedReply)}}));`);
  const state = await runManifest(root, manifest(), { spawnImpl });
  assert.equal(state.jobs[0].status, 'blocked');

  // Tamper the saved state: add an extra output not in the manifest
  const stateFile = path.join(root, '.swarm', 'runs', state.id, 'state.json');
  const savedState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  savedState.jobs[0].outputs.push('tampered-extra-file.txt');
  await fs.writeFile(stateFile, JSON.stringify(savedState));

  // integrateRun should reject even with acceptBlocked due to metadata mismatch
  await assert.rejects(integrateRun(root, state.id, { acceptBlocked: true }), /Worker metadata does not match manifest/);

  // Verify the extra file was not written
  await assert.rejects(() => fs.readFile(path.join(root, 'tampered-extra-file.txt')), { code: 'ENOENT' });
});

// --- #128: invented-hash -----------------------------------------------------------------------

test('invented-hash warns for a new sha-shaped string absent from context, silent for one copied from context', async t => {
  const root = await fixture(t);
  const copiedSha = 'c'.repeat(40);
  const inventedSha = 'd'.repeat(64);
  await fs.writeFile(path.join(root, 'reference.txt'), `known sha: ${copiedSha}\n`);
  const jobWithRef = job({ context: ['input.txt', 'reference.txt'] });
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated ${copiedSha} ${inventedSha}');${done}`);
  const state = await runManifest(root, manifest([jobWithRef]), { spawnImpl });
  const inspected = await inspectRun(root, state.id);
  assert.ok(inspected.warnings.some(w => w === `invented-hash: writer: input.txt: ${inventedSha}`));
  assert.equal(inspected.warnings.some(w => w.includes(copiedSha)), false);
  const result = await integrateRun(root, state.id);
  assert.ok(result.warnings.some(w => w === `invented-hash: writer: input.txt: ${inventedSha}`));
  assert.equal(result.warnings.some(w => w.includes(copiedSha)), false);
});

test('invented-hash stays silent when the hex string already existed in the file before the job ran', async t => {
  const root = await fixture(t);
  const priorSha = 'e'.repeat(40);
  await fs.writeFile(path.join(root, 'input.txt'), `original ${priorSha}\n`);
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated ${priorSha}');${done}`);
  const state = await runManifest(root, manifest(), { spawnImpl });
  const result = await integrateRun(root, state.id);
  assert.equal((result.warnings ?? []).some(w => w.includes('invented-hash')), false);
});

// --- #137: run/validate accept an absolute manifest path under --root -----------------------------

test('validate accepts an absolute manifest path that resolves inside --root', async t => {
  const root = await fs.realpath(await fixture(t));
  const manifestPath = path.join(root, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest()));
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'validate', manifestPath]);
  assert.equal(JSON.parse(stdout).status, 'valid');
});

test('validate still refuses a bare absolute path outside --root', async t => {
  const root = await fs.realpath(await fixture(t));
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'validate', '/definitely/outside/manifest.json']), error => {
    assert.match(JSON.parse(error.stderr).error, /Invalid relative path/);
    return true;
  });
});

// --- #139: runCheck group-spawn + group-kill on cancel ---------------------------------------------

test('runCheck kills its child as a whole process group once cancelled, leaving no descendant running', async t => {
  const root = await plainFixture(t);
  const pidFile = path.join(root, 'grandchild.pid');
  // The grandchild inherits the parent's process group (no `detached` of its own) and ignores
  // nothing special; only a signal sent to the whole group reaches it.
  const script = `const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000);", ${JSON.stringify(pidFile)}], { stdio: 'ignore' }); setInterval(()=>{}, 1000);`;
  let cancelled = false;
  const resultPromise = runCheck('sleeper', [process.execPath, '-e', script], root, 300000, spawn, false, () => {}, process.env, { cancelled: async () => cancelled });
  const deadline = Date.now() + 5000;
  let pid = NaN;
  while (Date.now() < deadline) {
    // The name can appear (via writeFileSync's open()) a hair before its content is visible to a
    // racing reader; poll on a fully-parsed pid, not just on the file existing.
    try { pid = Number((await fs.readFile(pidFile, 'utf8')).trim()); if (Number.isInteger(pid) && pid > 0) break; } catch {}
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(Number.isInteger(pid) && pid > 0, 'grandchild pid file must be fully written within the deadline');
  cancelled = true;
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the grandchild must not survive a group cancel');
});

// --- #156/#157: shell-job dropped-write matching + sandbox env var ---------------------------------

const FAKE_KEY = 'sk-FAKE-mutants-0000';
const FAKE_BIN = '/opt/fake-claude/bin/claude.exe';
const shellHooks = { access: async () => {}, resolveClaude: async () => FAKE_BIN, scanListeningPorts: async () => [] };
const noKeychain = () => assert.fail('the real keychain must never be read in tests');
const runEnv = { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: FAKE_KEY };
function fakeSandbox(script) {
  return (_command, args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
}
const shellJob = (overrides = {}) => ({ id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Create the new file.', context: ['input.txt'], outputs: ['new-output.txt'], timeoutMs: 10000, ...overrides });

test('shell-job completion: a NEW file that is a declared output is never warned as a dropped write', async t => {
  const root = await gitFixture(t);
  const worked = "fs.writeFileSync('new-output.txt','brand new content');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({status:'done',checksRun:[]})}));";
  const state = await runManifest(root, manifest([shellJob()]), { platform: 'darwin', spawnImpl: fakeSandbox(worked), env: runEnv, keyExec: noKeychain, shellHooks });
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].droppedWrites, undefined);
  const inspected = await inspectResults(root, state.id);
  assert.equal(inspected.warnings.some(w => w.startsWith('dropped write')), false);
  const result = await integrateRun(root, state.id, { env: runEnv, keyExec: noKeychain });
  assert.equal((result.warnings ?? []).some(w => w.startsWith('dropped write')), false);
  assert.equal(await fs.readFile(path.join(root, 'new-output.txt'), 'utf8'), 'brand new content');
});

test('shell-job completion: a stray new file that is NOT a declared output is warned as a dropped write, tagged (new)', async t => {
  const root = await gitFixture(t);
  const worked = "fs.writeFileSync('new-output.txt','brand new content');fs.writeFileSync('stray.txt','oops');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({status:'done',checksRun:[]})}));";
  const state = await runManifest(root, manifest([shellJob()]), { platform: 'darwin', spawnImpl: fakeSandbox(worked), env: runEnv, keyExec: noKeychain, shellHooks });
  assert.equal(state.status, 'complete');
  assert.deepEqual(state.jobs[0].droppedWrites, ['stray.txt']);
  assert.deepEqual(state.jobs[0].droppedWritesNew, ['stray.txt']);
  const inspected = await inspectResults(root, state.id);
  assert.ok(inspected.warnings.includes('dropped write: stray.txt (new) (not in outputs)'));
});
