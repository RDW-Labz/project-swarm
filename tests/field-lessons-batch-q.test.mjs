// SPDX-License-Identifier: Apache-2.0
// Swarm batch Q: field lessons 238-241 (see .swarm-manifests/contract-q.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  validateManifest, validateProject, runManifest, integrateRun, contractFilesLinePaths,
} from '../tools/swarm.mjs';
import { validateNetworkAllow } from '../tools/claude-shell.mjs';
import { git } from '../tools/codex-adapter.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-q-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const manifest = jobs => ({ version: 1, concurrency: 1, jobs });
const job = (overrides = {}) => ({ id: 'w', agent: 'claude', model: 'sonnet', prompt: 'Do the task.', context: [], outputs: ['out.txt'], timeoutMs: 5000, ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));`;

// --- #238: networkAllow HTTPS-only named hosts; a check's integrateOnly is skipped in the worker -

test('#238: validateNetworkAllow requires an https:// scheme, refusing invalid-networkAllow-host', () => {
  assert.throws(() => validateNetworkAllow(['raw.githubusercontent.com'], 'w'), /invalid-networkAllow-host/);
  assert.throws(() => validateNetworkAllow(['http://raw.githubusercontent.com'], 'w'), /invalid-networkAllow-host/);
  assert.throws(() => validateNetworkAllow(['https://bad host'], 'w'), /invalid-networkAllow-host/);
  // A well-formed https host still refuses (this release ships no per-host proxy rules yet), but
  // with the "not yet supported" message, never invalid-networkAllow-host.
  assert.throws(() => validateNetworkAllow(['https://raw.githubusercontent.com'], 'w'), /networkAllow is not yet supported/);
});

test('#238: validateManifest refuses a shell job\'s networkAllow host lacking an https:// scheme', () => {
  const shellJob = overrides => job({ agent: 'claude', shell: true, ...overrides });
  assert.throws(() => validateManifest(manifest([shellJob({ networkAllow: ['raw.githubusercontent.com'] })])), /invalid-networkAllow-host/);
});

async function shellRepo(t) {
  const root = await fixture(t);
  await git(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  return root;
}
const FAKE_KEY = 'sk-FAKE-batch-q-0000';
const FAKE_BIN = '/opt/fake-claude/bin/claude.exe';
const shellHooks = { access: async () => {}, resolveClaude: async () => FAKE_BIN, scanListeningPorts: async () => [] };
const noKeychain = () => assert.fail('the real keychain must never be read in tests');
const runEnv = { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: FAKE_KEY };
const workerDone = `fs.writeFileSync('output.txt','proposed');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));`;
const shellJobFixture = (overrides = {}) => ({ id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });
function fakeShellSpawn(script, seen = []) {
  return (command, args, options) => {
    seen.push({ command, args, options });
    if (command === 'sandbox-exec' && args[2] === FAKE_BIN) return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
    if (command === 'sandbox-exec') return spawn(args[2], args.slice(3), options);
    return spawn(command, args, options);
  };
}
const workerLaunched = seen => seen.some(call => call.command === 'sandbox-exec' && call.args[2] === FAKE_BIN);

test('#238: a check marked integrateOnly never refuses the job (skipped by the smoke check) and is marked skipped-integrate-only in the worker\'s own prompt', async t => {
  const root = await shellRepo(t);
  const seen = [];
  const checks = [{ name: 'unit', argv: ['swarm-test-no-such-tool-238', 'run'], integrateOnly: true }];
  const state = await runManifest(root, { version: 1, jobs: [shellJobFixture()], checks }, { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone, seen), env: runEnv, keyExec: noKeychain, shellHooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  assert.equal(workerLaunched(seen), true, 'the integrateOnly check never gated the smoke check, so the worker still ran');
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/message.txt'), 'utf8');
  assert.match(message, /unit \(skipped-integrate-only\)/);
});

// --- #239: a check's output naming a sandbox_apply/Operation not permitted denial is sandbox-only -

test('#239: integrate tags a check whose output shows "Operation not permitted" as sandbox-only, excluded from fail counts', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  const checkScript = "console.error('sandbox_apply: Operation not permitted: Failed to bind');process.exit(1)";
  const m = { ...manifest([job({ id: 'w', context: ['input.txt'], outputs: ['input.txt'] })]), checks: [{ name: 'unit', argv: [process.execPath, '-e', checkScript] }] };
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated');${done}`);
  const state = await runManifest(root, m, { spawnImpl });
  const result = await integrateRun(root, state.id);
  assert.equal(result.checks[0].status, 'sandbox-only');
  assert.equal(result.checksPassed, true, 'a sandbox-only check is never counted as a real failure');
  assert.deepEqual(result.failures, []);
});

test('#239: integrate still fails a real check failure that never mentions a sandbox denial', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  const checkScript = "console.error('AssertionError: expected 1 to equal 2');process.exit(1)";
  const m = { ...manifest([job({ id: 'w', context: ['input.txt'], outputs: ['input.txt'] })]), checks: [{ name: 'unit', argv: [process.execPath, '-e', checkScript] }] };
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated');${done}`);
  const state = await runManifest(root, m, { spawnImpl });
  const result = await integrateRun(root, state.id);
  assert.equal(result.checks[0].status, 'failed');
  assert.equal(result.checksPassed, false);
});

// --- #240: validate warns contract-file-not-found for a missing 'Files:' path --------------------

test('#240: contractFilesLinePaths reads one or more comma-separated paths off a Files: line, dropping trailing line-number hints', () => {
  assert.deepEqual(contractFilesLinePaths('- #1: fix. Files: tools/swarm.mjs, tools/claude-shell.mjs.'), ['tools/swarm.mjs', 'tools/claude-shell.mjs']);
  assert.deepEqual(contractFilesLinePaths('no files line here'), []);
});

test('#240: validateProject warns contract-file-not-found when a contract Files: line names a missing path', async t => {
  const root = await fixture(t);
  const contractText = ['# Contract', '- #999: some fix. Files: tools/does-not-exist-238.mjs.'].join('\n');
  await fs.writeFile(path.join(root, 'CONTRACT.md'), contractText);
  const m = { ...manifest([job({ context: ['CONTRACT.md'] })]), contract: 'CONTRACT.md' };
  const report = await validateProject(root, m);
  assert.ok(report.warnings.some(w => w.code === 'contract-file-not-found' && w.path === 'tools/does-not-exist-238.mjs'));
});

test('#240: validateProject does not warn contract-file-not-found when the Files: path exists', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools/present.mjs'), '// ok\n');
  const contractText = ['# Contract', '- #999: some fix. Files: tools/present.mjs.'].join('\n');
  await fs.writeFile(path.join(root, 'CONTRACT.md'), contractText);
  const m = { ...manifest([job({ context: ['CONTRACT.md'] })]), contract: 'CONTRACT.md' };
  const report = await validateProject(root, m);
  assert.ok(!report.warnings.some(w => w.code === 'contract-file-not-found'));
});

// --- #241: contract template asks for one test per named failure class ---------------------------

test('#241: templates/coordination/CONTRACT.md Tests section asks for one test per named failure class', async () => {
  const text = await fs.readFile(new URL('../templates/coordination/CONTRACT.md', import.meta.url), 'utf8');
  const testsSection = text.slice(text.indexOf('## Tests'), text.indexOf('## Release'));
  assert.match(testsSection, /one test per failure class/);
  assert.ok(text.split('\n').length <= 40);
});
