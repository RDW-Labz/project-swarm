// SPDX-License-Identifier: Apache-2.0
// Field lesson #141: a per-worktree port block (docs/shell/ports.md), so two concurrent checks
// never collide on the same fixed dev-server port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { portBlockFor, resolvePortBlock } from '../tools/ports.mjs';
import { validateManifest, runManifest, integrateRun } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const BUSY_BLOCK = 24670;

// --- portBlockFor: pure, stable, in range --------------------------------------------------

test('portBlockFor: same path always gives the same base; a sample of different paths differs; base is a multiple of 10 in [20000,27990] and never the busy block', async t => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ports-a-'));
  const b = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ports-b-'));
  t.after(() => Promise.all([fs.rm(a, { recursive: true, force: true }), fs.rm(b, { recursive: true, force: true })]));
  const paths = [a, b, 'relative/one', 'relative/two', '/no/such/path/at/all/12345'];
  for (const candidate of paths) {
    const base = portBlockFor(candidate);
    assert.equal(portBlockFor(candidate), base, `stable for ${candidate}`);
    assert.equal(base % 10, 0, `multiple of 10: ${candidate}`);
    assert.ok(base >= 20000 && base <= 27990, `${candidate}: ${base} in range`);
    assert.notEqual(base, BUSY_BLOCK, `never the busy block: ${candidate}`);
  }
  const bases = new Set(paths.map(portBlockFor));
  assert.ok(bases.size > 1, 'different paths produce more than one base among this sample');
});

// --- resolvePortBlock: stepping, moved, and the busy-after-50-tries fallback ----------------

test('resolvePortBlock: the first free block wins with moved:false', async () => {
  const root = '/no/such/path/resolve-free';
  const original = portBlockFor(root);
  const result = await resolvePortBlock(root, { isFree: async () => true });
  assert.deepEqual(result, { base: original, moved: false });
});

test('resolvePortBlock: two busy blocks then a free one steps forward and reports moved:true', async () => {
  const root = '/no/such/path/resolve-step';
  const original = portBlockFor(root);
  const calls = [];
  const isFree = async port => { calls.push(port); return calls.length === 3; };
  const result = await resolvePortBlock(root, { isFree });
  assert.equal(calls.length, 3);
  assert.equal(calls[0], original);
  assert.notEqual(result.base, original);
  assert.equal(result.moved, true);
});

test('resolvePortBlock: every block busy for 50 tries returns the original base with moved:true', async () => {
  const root = '/no/such/path/resolve-busy';
  const original = portBlockFor(root);
  const calls = [];
  const result = await resolvePortBlock(root, { isFree: async port => { calls.push(port); return false; } });
  assert.equal(calls.length, 50);
  assert.equal(result.base, original);
  assert.equal(result.moved, true);
  assert.ok(!calls.includes(BUSY_BLOCK), 'the busy block is never handed out as a candidate');
});

// --- end-to-end fixtures shared with the integrate/shell/codex tests below -----------------

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, checks) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...(checks ? { checks } : {}) });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;
const update = fake(`fs.writeFileSync('input.txt','updated'); ${done}`);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ports-plain-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('integrate: a check sees the resolved SWARM_PORT_BASE for this project root', async t => {
  const root = await fixture(t);
  const checks = [{ name: 'port-check', argv: [process.execPath, '-e', "require('fs').writeFileSync('port-seen.txt', process.env.SWARM_PORT_BASE || 'none')"] }];
  const state = await runManifest(root, manifest([job()], checks), { spawnImpl: update });
  const result = await integrateRun(root, state.id);
  assert.equal(result.checks[0].status, 'passed');
  assert.equal(typeof result.portBase, 'number');
  assert.equal(result.portBase % 10, 0);
  assert.ok(result.portBase >= 20000 && result.portBase <= 27990);
  assert.equal(await fs.readFile(path.join(root, 'port-seen.txt'), 'utf8'), String(result.portBase));
});

test('a non-shell claude job env and prompt are unchanged', async t => {
  // Field lesson 190: save and clear SWARM_PORT_BASE to prevent inherited ambient port from failing this test
  const savedPortBase = process.env.SWARM_PORT_BASE;
  delete process.env.SWARM_PORT_BASE;
  t.after(() => {
    if (savedPortBase !== undefined) {
      process.env.SWARM_PORT_BASE = savedPortBase;
    }
  });
  const root = await fixture(t);
  const seen = [];
  const spawnImpl = (command, args, options) => { seen.push({ command, args, options }); return spawn(process.execPath, ['-e', "console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}))"], options); };
  const state = await runManifest(root, manifest([job()]), { spawnImpl });
  assert.equal(state.status, 'complete');
  assert.equal(seen[0].options.env, process.env);
  assert.equal('SWARM_PORT_BASE' in seen[0].options.env, false);
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
  assert.equal(message.includes('Ports:'), false);
});

// --- validate: SWARM_PORT_BASE is reserved for both testEnv-capable job kinds --------------

test('validate refuses a manifest testEnv that sets SWARM_PORT_BASE, for codex and for shell jobs', () => {
  const codexJob = { id: 'c', agent: 'codex', model: 'test-model', prompt: 'x', context: [], outputs: ['o.txt'], testEnv: { SWARM_PORT_BASE: '1' } };
  assert.throws(() => validateManifest({ version: 1, jobs: [codexJob] }), /Job c: testEnv key SWARM_PORT_BASE is reserved/);
  const shellJob = { id: 's', agent: 'claude', model: 'sonnet', shell: true, prompt: 'x', context: [], outputs: ['o.txt'], testEnv: { SWARM_PORT_BASE: '1' } };
  assert.throws(() => validateManifest({ version: 1, jobs: [shellJob] }), /Job s: testEnv key SWARM_PORT_BASE is reserved/);
});

// --- a codex job's env carries SWARM_PORT_BASE ----------------------------------------------

function fakeCodex(script, observe = () => {}) {
  return (command, args, options) => {
    observe(command, args, options);
    return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; const result = ${JSON.stringify(args[args.indexOf('-o') + 1])}; ${script}`], options);
  };
}

async function codexRepo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ports-codex-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return root;
}

test("a codex job's env carries its own SWARM_PORT_BASE", async t => {
  const root = await codexRepo(t);
  const codexJob = { id: 'writer', agent: 'codex', model: 'test-model', prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 5000 };
  const envelope = JSON.stringify({ files_changed: ['output.txt'], notes: [] });
  const success = `fs.writeFileSync('output.txt','proposed');fs.writeFileSync(result,${JSON.stringify(envelope)});`;
  let received;
  const spawnImpl = fakeCodex(success, (command, args, options) => { received = { command, args, options }; });
  const state = await runManifest(root, { version: 1, jobs: [codexJob] }, { platform: 'darwin', spawnImpl });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  assert.equal(received.command, 'sandbox-exec');
  assert.match(received.options.env.SWARM_PORT_BASE, /^\d+$/);
  assert.equal(Number(received.options.env.SWARM_PORT_BASE) % 10, 0);
});

// --- a shell job's env carries SWARM_PORT_BASE and its prompt states the port range --------

const FAKE_KEY = 'sk-FAKE-ports-0000';
const FAKE_BIN = '/opt/fake-claude/bin/claude.exe';
// CI fix (lesson #157): scanListeningPorts() shells out to lsof, absent on ubuntu-latest CI
// runners; this test is about SWARM_PORT_BASE, not the port scan, so it's faked out here.
const shellHooks = { access: async () => {}, resolveClaude: async () => FAKE_BIN, scanListeningPorts: async () => [] };
const noKeychain = () => assert.fail('the real keychain must never be read in tests');
const runEnv = { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: FAKE_KEY };

function fakeSandbox(script, seen = []) {
  return (command, args, options) => {
    seen.push({ command, args, options });
    return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
  };
}
const shellWorked = `fs.writeFileSync('output.txt','proposed');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ status: 'done' }))}}));`;

async function shellRepo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ports-shell-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}

test("a shell job's env carries SWARM_PORT_BASE and its prompt states the Ports line", async t => {
  const root = await shellRepo(t);
  const shellJob = { id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000 };
  const seen = [];
  const state = await runManifest(root, { version: 1, jobs: [shellJob] }, { platform: 'darwin', spawnImpl: fakeSandbox(shellWorked, seen), env: runEnv, keyExec: noKeychain, shellHooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  const [launch] = seen;
  assert.match(launch.options.env.SWARM_PORT_BASE, /^\d+$/);
  const base = Number(launch.options.env.SWARM_PORT_BASE);
  assert.equal(base % 10, 0);
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/message.txt'), 'utf8');
  assert.match(message, new RegExp(`Ports: this worktree owns ${base}\\.\\.${base + 9} \\(SWARM_PORT_BASE\\)\\. Start any dev server or test server on these, never on a fixed default port\\.`));
});
