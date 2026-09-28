// SPDX-License-Identifier: Apache-2.0
// Field lesson #145 (docs/shell/scratch.md): a shell job's own TMPDIR/HOME must live outside every
// git repo — some tools (pytest included) refuse to write scratch data under a path that is
// itself version controlled, so the parent creates a per-job scratch dir under the OS tmp dir
// instead of the previous `<run>/<job>/shell/tmp`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runManifest } from '../tools/swarm.mjs';
import { createShellScratchDir, shellProfile, shellEnvironment, validateShellTestEnvKey } from '../tools/claude-shell.mjs';
import { git } from '../tools/codex-adapter.mjs';

const FAKE_KEY = 'sk-FAKE-scratch-0000';
const FAKE_BIN = '/opt/fake-claude/bin/claude.exe';
// CI fix (lesson #157): scanListeningPorts() shells out to lsof, absent on ubuntu-latest CI
// runners; these tests are about the scratch dir, not the port scan, so it's faked out here.
const hooks = { access: async () => {}, resolveClaude: async () => FAKE_BIN, scanListeningPorts: async () => [] };
const noKeychain = () => assert.fail('the real keychain must never be read in tests');
const runEnv = { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: FAKE_KEY };
const shellJob = (overrides = {}) => ({ id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Run the checks.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });
const manifest = jobs => ({ version: 1, jobs });

async function repo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-scratch-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}

function fakeSandbox(script, seen = []) {
  return (command, args, options) => {
    seen.push({ command, args, options });
    return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
  };
}
const worked = `fs.writeFileSync('output.txt','proposed');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({status:'done',checksRun:[]})}));`;

// --- createShellScratchDir -----------------------------------------------------------------------

test('createShellScratchDir makes tmp/ and home/ under a fresh 0700 dir, with no .git in any ancestor', async t => {
  const scratch = await createShellScratchDir({ runId: 'r1', jobId: 'j1' });
  t.after(() => fs.rm(scratch.scratchDir, { recursive: true, force: true }));
  assert.equal(scratch.tmp, path.join(scratch.scratchDir, 'tmp'));
  assert.equal(scratch.home, path.join(scratch.scratchDir, 'home'));
  assert.ok((await fs.stat(scratch.tmp)).isDirectory());
  assert.ok((await fs.stat(scratch.home)).isDirectory());
  assert.equal((await fs.stat(scratch.scratchDir)).mode & 0o777, 0o700);
  for (let dir = scratch.scratchDir; ; dir = path.dirname(dir)) {
    await assert.rejects(fs.access(path.join(dir, '.git')), `no .git at ${dir}`);
    if (dir === path.parse(dir).root) break;
  }
});

test('createShellScratchDir refuses with scratch-inside-repo when os.tmpdir() resolves inside a repo, walking up to /', async () => {
  const access = async file => { if (file === '/home/project/.git') return; throw Error('ENOENT'); };
  await assert.rejects(createShellScratchDir({ runId: 'r', jobId: 'j' }, { tmpdir: () => '/home/project/sub/tmp', realpath: async value => value, access }), /scratch-inside-repo/);
  // A tmp root with no repo ancestor at all never refuses.
  const neverFinds = async () => { throw Error('ENOENT'); };
  const clean = await createShellScratchDir({ runId: 'r', jobId: 'j' }, { tmpdir: () => '/no/repo/here', realpath: async value => value, access: neverFinds, mkdtemp: async prefix => `${prefix}abc123`, chmod: async () => {}, mkdir: async () => {} });
  assert.equal(clean.scratchDir, '/no/repo/here/swarm-r-j-abc123');
});

// --- shellProfile: the scratch allow -------------------------------------------------------------

test('shell profile: scratch dir gets a realpathd read+write allow, placed before the final denies', () => {
  const base = { home: '/Users/example', worktree: '/Users/example/repo/.swarm/runs/r/worktrees/j', commonDir: '/Users/example/repo/.git', shellDir: '/Users/example/repo/.swarm/runs/r/j/shell', proxyPort: 1 };
  const withoutScratch = shellProfile(base);
  assert.equal(withoutScratch.includes('scratch-fixture'), false);
  const profile = shellProfile({ ...base, scratchDir: '/private/var/folders/xx/scratch-fixture' });
  assert.ok(profile.includes('(subpath "/private/var/folders/xx/scratch-fixture")'));
  const writable = '(subpath "/Users/example/repo/.swarm/runs/r/worktrees/j") (subpath "/Users/example/repo/.swarm/runs/r/j/shell") (subpath "/private/var/folders/xx/scratch-fixture") (literal "/dev/null") (regex #"^/dev/tty.*$")';
  assert.ok(profile.includes(`(allow file-write* ${writable})\n(deny file-write* (require-not (require-any ${writable})))`));
  const scratchIndex = profile.indexOf('(subpath "/private/var/folders/xx/scratch-fixture")');
  assert.ok(scratchIndex > -1);
  assert.ok(scratchIndex < profile.indexOf('(subpath "/Library/Keychains")'), 'scratch allow comes before the keychain deny');
  assert.ok(scratchIndex < profile.lastIndexOf('(deny mach-lookup'), 'scratch allow comes before the final deny');
  // Every existing generic deny (.claude, .ssh, .aws, keychain, securityd) still appears; an
  // arbitrary project-specific directory is denied only when a project's config names it.
  for (const part of ['.ssh', '.aws', '.claude']) assert.ok(profile.includes(`(subpath "/Users/example/${part}")`), part);
  assert.equal(profile.includes('/Users/example/.acme-app'), false, 'no directory outside the generic deny list by default');
  for (const service of ['com.apple.SecurityServer', 'com.apple.securityd.xpc', 'com.apple.secd', 'com.apple.security.agent']) assert.ok(profile.includes(`(global-name "${service}")`), service);
  const configured = shellProfile({ ...base, scratchDir: '/private/var/folders/xx/scratch-fixture', config: { deniedHomeDirs: ['.acme-app'] } });
  assert.ok(configured.includes('(subpath "/Users/example/.acme-app")'));
});

// --- shellEnvironment: TMPDIR/TMP/TEMP/HOME + reservation ----------------------------------------

test('shell env: TMPDIR, TMP, TEMP and CLAUDE_CODE_TMPDIR all point at the scratch tmp dir; HOME at the scratch home dir', () => {
  const env = shellEnvironment({ parentEnv: { PATH: '/usr/bin' }, home: '/scratch/home', tmp: '/scratch/tmp', configDir: '/scratch/home/.claude', proxyPort: 1, apiKey: 'k', userId: 'swarm-worker:j' });
  assert.equal(env.HOME, '/scratch/home');
  assert.equal(env.TMPDIR, '/scratch/tmp');
  assert.equal(env.TMP, '/scratch/tmp');
  assert.equal(env.TEMP, '/scratch/tmp');
  assert.equal(env.CLAUDE_CODE_TMPDIR, '/scratch/tmp');
});

test('a manifest testEnv can never override TMP or TEMP: reserved for the shell sandbox', () => {
  assert.equal(validateShellTestEnvKey('TMP'), false);
  assert.equal(validateShellTestEnvKey('TEMP'), false);
  assert.throws(() => shellEnvironment({ parentEnv: { PATH: '/usr/bin' }, home: '/h', tmp: '/t', configDir: '/c', proxyPort: 1, apiKey: 'k', userId: 'swarm-worker:j', testEnv: { TMP: '/evil' } }), /reserved or looks like a secret/);
});

// --- end to end: the scratch dir wired through a real run ----------------------------------------

test('a real run wires the scratch dir into the env and profile, then removes it after a clean job', async t => {
  const root = await repo(t);
  const seen = [];
  const state = await runManifest(root, manifest([shellJob()]), { platform: 'darwin', spawnImpl: fakeSandbox(worked, seen), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  const [launch] = seen;
  const scratchDir = state.jobs[0].scratchDir;
  assert.ok(scratchDir, 'scratchDir is recorded on the job');
  assert.equal(scratchDir.startsWith(root), false, 'the scratch dir is outside the project');
  assert.equal(scratchDir.includes('.swarm'), false, 'the scratch dir is outside the run tree too');
  assert.equal(launch.options.env.HOME, path.join(scratchDir, 'home'));
  assert.equal(launch.options.env.TMPDIR, path.join(scratchDir, 'tmp'));
  assert.equal(launch.options.env.TMP, launch.options.env.TMPDIR);
  assert.equal(launch.options.env.TEMP, launch.options.env.TMPDIR);
  const profile = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/sandbox.sb'), 'utf8');
  assert.ok(profile.includes(`(subpath "${scratchDir}")`));
  await assert.rejects(fs.access(scratchDir), 'removed after a clean job');
});

test('keepScratch: true keeps the scratch dir after the job; validate refuses it on non-shell jobs and non-booleans', async t => {
  const root = await repo(t);
  const seen = [];
  const state = await runManifest(root, manifest([shellJob({ id: 'kept', keepScratch: true })]), { platform: 'darwin', spawnImpl: fakeSandbox(worked, seen), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
  assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
  const scratchDir = state.jobs[0].scratchDir;
  t.after(() => fs.rm(scratchDir, { recursive: true, force: true }));
  await fs.access(scratchDir);

  const { validateManifest } = await import('../tools/swarm.mjs');
  assert.throws(() => validateManifest(manifest([{ id: 'w', agent: 'claude', model: 'sonnet', prompt: 'x', context: [], outputs: [], keepScratch: true }])), /keepScratch is only supported for claude shell jobs/);
  assert.throws(() => validateManifest(manifest([shellJob({ keepScratch: 'yes' })])), /keepScratch must be true or false/);
  assert.doesNotThrow(() => validateManifest(manifest([shellJob({ keepScratch: false })])));
});

test('scratch-inside-repo refuses the job before any worker spawns, the same shape as loopback-scan-failed', async t => {
  const root = await repo(t);
  const spawnImpl = () => assert.fail('the worker must never spawn after a scratch refusal');
  const failingHooks = { ...hooks, createScratchDir: async () => { throw Error('scratch-inside-repo'); } };
  const state = await runManifest(root, manifest([shellJob()]), { platform: 'darwin', spawnImpl, env: runEnv, keyExec: noKeychain, shellHooks: failingHooks });
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error, 'scratch-inside-repo');
  await assert.rejects(fs.access(path.join(root, '.swarm/workspaces', state.id, 'builder/output.txt')));
});

// --- non-shell claude jobs: byte-identical, no scratch dir, no env change -------------------------

test('non-shell claude jobs get no scratch dir and no env change: byte-identical to before', async t => {
  const root = await repo(t);
  const seen = [];
  const plainJob = { id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000 };
  const spawnImpl = (command, args, options) => { seen.push({ command, args, options }); return spawn(process.execPath, ['-e', "console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}))"], options); };
  const state = await runManifest(root, manifest([plainJob]), { spawnImpl, keyExec: noKeychain });
  assert.equal(state.status, 'complete');
  assert.equal(seen[0].options.env, process.env, 'env is untouched: no scratch dir is merged in');
  assert.equal('scratchDir' in state.jobs[0], false);
  assert.equal('shell' in state.jobs[0], false);
});
