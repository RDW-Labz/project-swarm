// SPDX-License-Identifier: Apache-2.0
// Field lesson #142 (docs/shell/uv.md): a shell job's `setup` runs once outside the sandbox, in
// its own worktree, before the worker starts, so a project's own toolchain sync (`uv sync`,
// `npm ci`) can reach the network the sandboxed worker never gets; the sandbox itself gains
// ancestor workspace-discovery grants, an offline-toolchain env, and a synced venv's own
// interpreter read path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateManifest, runManifest } from '../tools/swarm.mjs';
import { shellProfile, shellEnvironment, resolveVenvInterpreterHome, startConnectProxy } from '../tools/claude-shell.mjs';
import { git } from '../tools/codex-adapter.mjs';

const execFileAsync = promisify(execFile);
const FAKE_KEY = 'sk-FAKE-setup-0000';
const FAKE_BIN = '/opt/fake-claude/bin/claude.exe';
// CI fix (lesson #157): scanListeningPorts() shells out to lsof, absent on ubuntu-latest CI
// runners; these tests are about setup/toolchains, not the port scan, so it's faked out here.
const hooks = { access: async () => {}, resolveClaude: async () => FAKE_BIN, scanListeningPorts: async () => [] };
const noKeychain = () => assert.fail('the real keychain must never be read in tests');
const runEnv = { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: FAKE_KEY };
// Field lesson #156: a nested swarm test run cannot spawn a real sandbox-exec; skip with a named
// reason instead of a spurious failure, same as the existing macOS-only skip this test carries.
const SANDBOX_SKIP = process.env.SWARM_IN_SANDBOX ? 'nested sandbox: cannot spawn a real sandbox-exec' : process.platform !== 'darwin' && 'macOS only';
const shellJob = (overrides = {}) => ({ id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });
const codexJob = (overrides = {}) => ({ id: 'c', agent: 'codex', model: 'test-model', prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });
const plainJob = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'x', context: [], outputs: ['output.txt'], ...overrides });
const manifest = jobs => ({ version: 1, jobs });

async function repo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-setup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}

function fakeShellSpawn(script, seen = []) {
  return (command, args, options) => {
    seen.push({ command, args, options });
    if (command === 'sandbox-exec') {
      return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
    }
    // `setup` argv runs directly, outside the sandbox: spawn it for real (always a node -e probe
    // here, never a real network command) so the worktree's own writes actually happen.
    return spawn(command, args, options);
  };
}
const workerDone = `fs.writeFileSync('output.txt','proposed');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));`;

// --- validate: setup only for codex/claude-shell jobs, capped, shaped --------------------------

test('validate: setup is accepted for codex and claude shell jobs, refused elsewhere, capped at 5, each entry a non-empty argv array', () => {
  assert.doesNotThrow(() => validateManifest(manifest([shellJob({ setup: [['uv', 'sync', '--offline', '--quiet']] })])));
  assert.doesNotThrow(() => validateManifest(manifest([codexJob({ setup: [['npm', 'ci', '--offline']] })])));
  assert.throws(() => validateManifest(manifest([plainJob({ setup: [['uv', 'sync']] })])), /Job writer: setup is only supported for codex and claude shell jobs/);
  assert.throws(() => validateManifest(manifest([shellJob({ setup: Array.from({ length: 6 }, () => ['x']) })])), /Job builder: setup must be an array of at most 5/);
  assert.throws(() => validateManifest(manifest([shellJob({ setup: ['not-an-array'] })])), /each setup entry must be a non-empty array of strings/);
  assert.throws(() => validateManifest(manifest([shellJob({ setup: [[]] })])), /each setup entry must be a non-empty array of strings/);
  assert.throws(() => validateManifest(manifest([shellJob({ setup: [[1, 2]] })])), /each setup entry must be a non-empty array of strings/);
});

// --- run: setup executes before the worker, in the worktree; failure never spawns the worker ---

test('setup runs in the job worktree before the worker starts; the worker sees what setup wrote; setup.log is saved', async t => {
  const root = await repo(t);
  const seen = [];
  const setupArgv = [process.execPath, '-e', "console.log('setup ran'); require('fs').writeFileSync('setup-marker.txt', 'ran')"];
  const checkMarker = `if(!fs.existsSync('setup-marker.txt'))process.exit(9);${workerDone}`;
  const state = await runManifest(root, manifest([shellJob({ setup: [setupArgv] })]), { platform: 'darwin', spawnImpl: fakeShellSpawn(checkMarker, seen), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  const setupCalls = seen.filter(call => call.command !== 'sandbox-exec');
  assert.equal(setupCalls.length, 1);
  assert.deepEqual(setupCalls[0].args, setupArgv.slice(1));
  const sandboxCalls = seen.filter(call => call.command === 'sandbox-exec');
  assert.equal(sandboxCalls.length, 1, 'the worker starts exactly once, after setup');
  assert.ok(seen.indexOf(setupCalls[0]) < seen.indexOf(sandboxCalls[0]), 'setup is spawned before the worker');
  const setupLog = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/setup.log'), 'utf8');
  assert.match(setupLog, /setup ran/);
  assert.ok(setupLog.includes(`$ ${setupArgv.join(' ')}`));
});

test('a failing setup fails the job with setup-failed and the worker is never spawned', async t => {
  const root = await repo(t);
  const seen = [];
  const setupArgv = [process.execPath, '-e', "console.error('boom'); process.exit(3)"];
  const spawnImpl = (command, args, options) => {
    seen.push({ command, args, options });
    if (command === 'sandbox-exec') assert.fail('the worker must never be spawned after a failing setup');
    return spawn(command, args, options);
  };
  const state = await runManifest(root, manifest([shellJob({ setup: [setupArgv] })]), { platform: 'darwin', spawnImpl, env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error, `setup-failed: ${setupArgv[0]} exit 3`);
  assert.equal(state.status, 'failed');
  const setupLog = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/setup.log'), 'utf8');
  assert.match(setupLog, /boom/);
  await assert.rejects(fs.access(path.join(root, '.swarm/workspaces', state.id, 'builder/output.txt')));
});

test('a codex job also runs setup before its worker, in the same worktree', async t => {
  const root = await repo(t);
  const seen = [];
  const setupArgv = [process.execPath, '-e', "require('fs').writeFileSync('setup-marker.txt', 'ran')"];
  const okScript = "if(!fs.existsSync('setup-marker.txt'))process.exit(9); fs.writeFileSync('output.txt','proposed'); fs.writeFileSync(result, JSON.stringify({files_changed:['output.txt'],notes:[]}));";
  const spawnImpl = (command, args, options) => {
    seen.push({ command, args, options });
    if (command === 'sandbox-exec') return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; const result = ${JSON.stringify(args[args.indexOf('-o') + 1])}; ${okScript}`], options);
    return spawn(command, args, options);
  };
  const state = await runManifest(root, manifest([codexJob({ setup: [setupArgv] })]), { platform: 'darwin', spawnImpl });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  assert.equal(seen.filter(call => call.command !== 'sandbox-exec').length, 1);
});

// --- sandbox profile: ancestor workspace-discovery grants ---------------------------------------

test('shell profile: file-read-metadata for every worktree ancestor up to /, file-read* for each ancestor pyproject.toml/uv.toml/package.json', () => {
  const profile = shellProfile({ home: '/Users/example', worktree: '/Users/example/repo/.swarm/runs/r/worktrees/j', commonDir: '/Users/example/repo/.git', shellDir: '/Users/example/repo/.swarm/runs/r/j/shell', proxyPort: 40123 });
  assert.match(profile, /\(allow file-read-metadata /);
  for (const dir of ['/Users/example/repo/.swarm/runs/r/worktrees', '/Users/example/repo/.swarm/runs/r', '/Users/example/repo/.swarm/runs', '/Users/example/repo/.swarm', '/Users/example/repo', '/Users/example', '/Users', '/']) {
    assert.ok(profile.includes(`(literal "${dir}")`), dir);
  }
  for (const name of ['pyproject.toml', 'uv.toml', 'package.json']) {
    assert.ok(profile.includes(`(literal "/Users/example/repo/${name}")`), name);
  }
});

// --- venv interpreter: parsing, and the end-to-end read-path grant ------------------------------

test('resolveVenvInterpreterHome reads the home= line of .venv/pyvenv.cfg, else null', async () => {
  const read = async () => 'version = 3.12\nhome = /opt/toolchain/py/bin\ninclude-system-site-packages = false\n';
  assert.equal(await resolveVenvInterpreterHome('/w', { read }), '/opt/toolchain/py/bin');
  assert.equal(await resolveVenvInterpreterHome('/w', { read: async () => { throw Error('ENOENT'); } }), null);
  assert.equal(await resolveVenvInterpreterHome('/w', { read: async () => 'version = 3.12\n' }), null);
});

test('a synced venv pointing inside $HOME adds its interpreter parent as a read path; outside $HOME it is left alone', async t => {
  const root = await repo(t);
  const fakeHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-setup-home-')));
  t.after(() => fs.rm(fakeHome, { recursive: true, force: true }));
  await fs.mkdir(path.join(fakeHome, 'py/bin'), { recursive: true });
  const setupArgv = [process.execPath, '-e', `require('fs').mkdirSync('.venv',{recursive:true});require('fs').writeFileSync('.venv/pyvenv.cfg','home = ${path.join(fakeHome, 'py/bin')}\\n')`];
  const envWithFakeHome = { ...runEnv, HOME: fakeHome };
  const state = await runManifest(root, manifest([shellJob({ setup: [setupArgv] })]), { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone), env: envWithFakeHome, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  const profile = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/sandbox.sb'), 'utf8');
  assert.ok(profile.includes(`(subpath "${path.join(fakeHome, 'py')}")`), 'the interpreter parent is granted');

  const outsideHome = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-setup-outside-'));
  t.after(() => fs.rm(outsideHome, { recursive: true, force: true }));
  const setupArgv2 = [process.execPath, '-e', `require('fs').mkdirSync('.venv',{recursive:true});require('fs').writeFileSync('.venv/pyvenv.cfg','home = ${path.join(outsideHome, 'bin')}\\n')`];
  const state2 = await runManifest(root, manifest([shellJob({ id: 'builder2', setup: [setupArgv2] })]), { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone), env: envWithFakeHome, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state2.status, 'complete', state2.jobs[0].error ?? '');
  const profile2 = await fs.readFile(path.join(root, '.swarm/runs', state2.id, 'builder2/sandbox.sb'), 'utf8');
  assert.equal(profile2.includes(outsideHome), false);
  assert.equal('venvInterpreterDenied' in state2.jobs[0], false);
});

test('a venv interpreter inside $HOME but under a denied subdirectory is skipped with a warning, never granted', async t => {
  const root = await repo(t);
  const deniedDir = path.join(os.homedir(), '.ssh', 'swarm-setup-test-probe');
  const setupArgv = [process.execPath, '-e', `require('fs').mkdirSync('.venv',{recursive:true});require('fs').writeFileSync('.venv/pyvenv.cfg','home = ${path.join(deniedDir, 'bin')}\\n')`];
  const state = await runManifest(root, manifest([shellJob({ setup: [setupArgv] })]), { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  assert.deepEqual(state.jobs[0].venvInterpreterDenied, [`venv-interpreter-denied: ${deniedDir}`]);
  assert.ok(state.warnings.includes(`venv-interpreter-denied: ${deniedDir}`));
  const profile = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/sandbox.sb'), 'utf8');
  assert.equal(profile.includes(deniedDir), false);
});

// --- env: the offline toolchain keys, and their testEnv reservation -----------------------------

test('shell env: setup-related offline keys are added only when a uv cache dir is given, and are reserved in testEnv', () => {
  const parentEnv = { PATH: '/usr/bin:/bin', HOME: '/Users/example' };
  const withoutCache = shellEnvironment({ parentEnv, home: '/j/home', tmp: '/j/tmp', configDir: '/j/home/.claude', proxyPort: 1, apiKey: FAKE_KEY, userId: 'swarm-worker:j' });
  for (const key of ['UV_OFFLINE', 'UV_PYTHON_DOWNLOADS', 'UV_CACHE_DIR', 'npm_config_offline']) assert.equal(key in withoutCache, false, key);
  const withCache = shellEnvironment({ parentEnv, home: '/j/home', tmp: '/j/tmp', configDir: '/j/home/.claude', proxyPort: 1, apiKey: FAKE_KEY, userId: 'swarm-worker:j', uvCacheDir: '/j/shell/uv-cache' });
  assert.equal(withCache.UV_OFFLINE, '1');
  assert.equal(withCache.UV_PYTHON_DOWNLOADS, 'never');
  assert.equal(withCache.UV_CACHE_DIR, '/j/shell/uv-cache');
  assert.equal(withCache.npm_config_offline, 'true');
  for (const bad of ['UV_OFFLINE', 'UV_CACHE_DIR']) {
    assert.throws(() => shellEnvironment({ parentEnv, home: '/j/home', tmp: '/j/tmp', configDir: '/j/home/.claude', proxyPort: 1, apiKey: FAKE_KEY, userId: 'swarm-worker:j', testEnv: { [bad]: 'x' } }), /reserved or looks like a secret/, bad);
  }
});

test('validate refuses a shell job testEnv that sets UV_OFFLINE', () => {
  assert.throws(() => validateManifest(manifest([shellJob({ testEnv: { UV_OFFLINE: '0' } })])), /reserved for the shell sandbox/);
});

test('a real run sets the offline toolchain env for the worker', async t => {
  const root = await repo(t);
  const seen = [];
  const state = await runManifest(root, manifest([shellJob()]), { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone, seen), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  const [launch] = seen;
  assert.equal(launch.options.env.UV_OFFLINE, '1');
  assert.equal(launch.options.env.UV_PYTHON_DOWNLOADS, 'never');
  assert.match(launch.options.env.UV_CACHE_DIR, /shell\/uv-cache$/);
  assert.equal(launch.options.env.npm_config_offline, 'true');
});

// --- prompt: the setup line ----------------------------------------------------------------------

test('a shell job with setup states, in its prompt, that setup already ran and must not run again', async t => {
  const root = await repo(t);
  const setupArgv = [process.execPath, '-e', "require('fs').writeFileSync('setup-marker.txt','ran')"];
  const state = await runManifest(root, manifest([shellJob({ setup: [setupArgv] })]), { platform: 'darwin', spawnImpl: fakeShellSpawn(`if(!fs.existsSync('setup-marker.txt'))process.exit(9);${workerDone}`), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/message.txt'), 'utf8');
  assert.ok(message.includes(`Setup already ran outside the sandbox: ${setupArgv.join(' ')}. Do not run it again; the network is blocked.`));
  const plain = await runManifest(root, manifest([shellJob({ id: 'nosetup' })]), { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  const plainMessage = await fs.readFile(path.join(root, '.swarm/runs', plain.id, 'nosetup/message.txt'), 'utf8');
  assert.equal(plainMessage.includes('Setup already ran'), false);
});

// --- the generated profile under the real sandbox-exec (macOS only) -----------------------------

test('the generated profile lets a real shell read an ancestor pyproject.toml but not an unrelated ancestor file', { skip: SANDBOX_SKIP }, async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-setup-seatbelt-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  // The project root must sit inside the denied `home` subtree (as it does for a real coordinator
  // whose worktrees live under their own home) so the ancestor grant is actually load-bearing:
  // without it, `pyproject.toml` would already be readable via the profile's own default allow.
  const home = path.join(base, 'home');
  const projectRoot = path.join(home, 'project');
  const worktree = path.join(projectRoot, '.swarm/runs/r/worktrees/j');
  const shellDir = path.join(projectRoot, '.swarm/runs/r/j/shell');
  for (const dir of [worktree, path.join(shellDir, 'home'), path.join(shellDir, 'tmp')]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'pyproject.toml'), '[project]\nname = "x"\n');
  await fs.writeFile(path.join(projectRoot, 'other.txt'), 'not readable via ancestor grants');
  const proxy = await startConnectProxy();
  t.after(() => proxy.close());
  const profile = path.join(projectRoot, '.swarm/runs/r/j/sandbox.sb');
  await fs.writeFile(profile, shellProfile({ home, worktree, commonDir: path.join(worktree, '.git'), shellDir, proxyPort: proxy.port }));
  const up = path.relative(worktree, projectRoot);
  const probe = `cat '${up}/pyproject.toml' >/dev/null 2>&1 && echo pyproject=allowed || echo pyproject=blocked; cat '${up}/other.txt' >/dev/null 2>&1 && echo other=allowed || echo other=blocked`;
  const { stdout } = await execFileAsync('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sh', '-c', probe], { cwd: worktree, env: process.env });
  const result = Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=')));
  assert.deepEqual(result, { pyproject: 'allowed', other: 'blocked' });
});
