// SPDX-License-Identifier: Apache-2.0
// Field lessons #158–#164 as tool checks: venv interpreter grants and a sandbox smoke check,
// a packaging build check, a per-root env file, mutant find pre-checks and per-mutant checks,
// the shared-stash rule, and `ship --branch` for a branch built outside the swarm.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runManifest, integrateRun, validateProject, runMutantsCurrentTree, shipBranch, parseShipFlags } from '../tools/swarm.mjs';
import { resolveVenvInterpreterDirs, shellEnvironment, shellMessage } from '../tools/claude-shell.mjs';
import { codexMessage, git } from '../tools/codex-adapter.mjs';
import { ship } from '../tools/ship.mjs';
import { loadSwarmEnv, validateSwarmEnv, envPrintText, gitGuardScript, NO_STASH_LINE, checkNeedsEnvWarnings } from '../tools/swarm-env.mjs';
import { packagingKeyChanges, packagingWithoutBuildCheckWarning, isBuildArgv } from '../tools/packaging-check.mjs';

const execFileAsync = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'swarm.mjs');
const FAKE_KEY = 'sk-FAKE-batch-e-0000';
const FAKE_BIN = '/opt/fake-claude/bin/claude.exe';
const hooks = { access: async () => {}, resolveClaude: async () => FAKE_BIN, scanListeningPorts: async () => [] };
const noKeychain = () => assert.fail('the real keychain must never be read in tests');
const runEnv = { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: FAKE_KEY };
const workerDone = `fs.writeFileSync('output.txt','proposed');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));`;
const shellJob = (overrides = {}) => ({ id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });
const plainJob = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], ...overrides });

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function repo(t) {
  const root = await tmp(t, 'swarm-batch-e-');
  await git(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  return root;
}
// sandbox-exec -f PROFILE <FAKE_BIN ...> is the worker; sandbox-exec -f PROFILE <argv...> is the
// smoke check, run here directly (no real sandbox) so a missing argv0 really fails to spawn.
function fakeShellSpawn(script, seen = []) {
  return (command, args, options) => {
    seen.push({ command, args, options });
    if (command === 'sandbox-exec' && args[2] === FAKE_BIN) return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
    if (command === 'sandbox-exec') return spawn(args[2], args.slice(3), options);
    return spawn(command, args, options);
  };
}
const workerLaunched = seen => seen.some(call => call.command === 'sandbox-exec' && call.args[2] === FAKE_BIN);
const writeFileArgv = (file, body) => [process.execPath, '-e', `const fs=require('fs');fs.mkdirSync(require('path').dirname(${JSON.stringify(file)}),{recursive:true});${body}`];

// --- L158: venv interpreter through symlinks, toolchains grant, smoke check ------------------------

describe('L158: a shell job grants the venv interpreter it really runs and smoke-starts the first check', () => {
  test('resolveVenvInterpreterDirs follows .venv/bin/python through a symlinked install dir to its real home', async t => {
    const worktree = await tmp(t, 'swarm-venv-wt-');
    const fakeHome = await tmp(t, 'swarm-venv-home-');
    const outside = await tmp(t, 'swarm-venv-outside-');
    await fs.mkdir(path.join(fakeHome, 'toolchains/py/bin'), { recursive: true });
    await fs.writeFile(path.join(fakeHome, 'toolchains/py/bin/python3.12'), '');
    await fs.symlink(path.join(fakeHome, 'toolchains/py'), path.join(outside, 'py-link'));
    await fs.mkdir(path.join(worktree, '.venv/bin'), { recursive: true });
    await fs.writeFile(path.join(worktree, '.venv/pyvenv.cfg'), `home = ${path.join(outside, 'py-link/bin')}\n`);
    await fs.symlink(path.join(outside, 'py-link/bin/python3.12'), path.join(worktree, '.venv/bin/python'));
    const { dirs, unresolvable } = await resolveVenvInterpreterDirs(worktree);
    assert.deepEqual(unresolvable, []);
    assert.ok(dirs.includes(path.join(fakeHome, 'toolchains/py')), `the real install dir is returned: ${dirs}`);
    assert.ok(dirs.includes(path.join(outside, 'py-link')), 'the link path itself is returned too');
  });

  test('a venv whose recorded home is outside $HOME but whose python symlinks into a hidden $HOME path is granted', async t => {
    const root = await repo(t);
    const fakeHome = await tmp(t, 'swarm-venv-home-');
    const outside = await tmp(t, 'swarm-venv-outside-');
    await fs.mkdir(path.join(fakeHome, 'py/bin'), { recursive: true });
    await fs.writeFile(path.join(fakeHome, 'py/bin/python3.12'), '');
    await fs.symlink(path.join(fakeHome, 'py'), path.join(outside, 'py-link'));
    const setupArgv = writeFileArgv('.venv/bin/x', `fs.writeFileSync('.venv/pyvenv.cfg','home = ${path.join(outside, 'py-link/bin')}\\n');fs.symlinkSync(${JSON.stringify(path.join(outside, 'py-link/bin/python3.12'))},'.venv/bin/python');`);
    const state = await runManifest(root, { version: 1, jobs: [shellJob({ setup: [setupArgv] })] }, { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone), env: { ...runEnv, HOME: fakeHome }, keyExec: noKeychain, shellHooks: hooks });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    const profile = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/sandbox.sb'), 'utf8');
    assert.ok(profile.includes(`(subpath "${path.join(fakeHome, 'py')}")`), 'the real interpreter install dir under $HOME is granted');
  });

  test('a venv python link that resolves nowhere refuses the job before the worker starts', async t => {
    const root = await repo(t);
    const seen = [];
    const setupArgv = writeFileArgv('.venv/bin/x', "fs.symlinkSync('/nonexistent/swarm-test/python3.12','.venv/bin/python');");
    const state = await runManifest(root, { version: 1, jobs: [shellJob({ setup: [setupArgv] })] }, { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone, seen), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
    assert.equal(state.jobs[0].status, 'failed');
    assert.equal(state.jobs[0].error, 'venv-interpreter-unresolvable: .venv/bin/python');
    assert.equal(workerLaunched(seen), false, 'the worker never started');
  });

  test('a first check that cannot start inside the sandbox refuses the job with sandbox-cannot-run-check', async t => {
    const root = await repo(t);
    const seen = [];
    const checks = [{ name: 'unit', argv: ['swarm-test-no-such-tool-158', 'run', 'pytest'] }];
    const state = await runManifest(root, { version: 1, jobs: [shellJob()], checks }, { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone, seen), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
    assert.equal(state.jobs[0].status, 'failed');
    assert.equal(state.jobs[0].error, 'sandbox-cannot-run-check: swarm-test-no-such-tool-158');
    assert.equal(workerLaunched(seen), false, 'refused before any worker token is spent');
    const smokeLog = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/smoke.log'), 'utf8');
    assert.match(smokeLog, /spawn-error/);
  });

  test('a first check that starts and fails (red before the work) does not refuse the job', async t => {
    const root = await repo(t);
    const seen = [];
    const checks = [{ name: 'unit', argv: [process.execPath, '-e', "console.log('FAILED tests/test_x.py::test_new');process.exit(1)"] }];
    const state = await runManifest(root, { version: 1, jobs: [shellJob()], checks }, { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone, seen), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    assert.equal(workerLaunched(seen), true);
  });

  test('the swarm toolchains dir and uv managed-python dir are granted, and uv is pointed at the real one', async t => {
    const root = await repo(t);
    const fakeHome = await tmp(t, 'swarm-venv-home-');
    const toolchains = path.join(fakeHome, '.project-swarm/toolchains');
    await fs.mkdir(path.join(toolchains, 'bin'), { recursive: true });
    await fs.mkdir(path.join(fakeHome, '.local/share/uv/python'), { recursive: true });
    const seen = [];
    const state = await runManifest(root, { version: 1, jobs: [shellJob()] }, { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone, seen), env: { ...runEnv, HOME: fakeHome, SWARM_TOOLCHAINS: toolchains }, keyExec: noKeychain, shellHooks: hooks });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    const profile = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'builder/sandbox.sb'), 'utf8');
    assert.ok(profile.includes(`(subpath "${toolchains}")`), 'the toolchains dir is readable');
    const launch = seen.find(call => call.args[2] === FAKE_BIN);
    assert.equal(launch.options.env.UV_PYTHON_INSTALL_DIR, path.join(fakeHome, '.local/share/uv/python'));
  });
});

// --- L159: packaging changes need a build check ------------------------------------------------

describe('L159: packaging config that no check builds is flagged', () => {
  const hatchBefore = '[project]\nname = "demo"\nversion = "1.0.0"\n\n[tool.hatch.build.targets.wheel]\npackages = ["src/demo"]\n';
  const hatchAfter = `${hatchBefore}\n[tool.hatch.build.targets.wheel.force-include]\n"src/demo/data" = "demo/data"\n`;

  test('packagingKeyChanges names a hatch build section edit, not a version bump', () => {
    assert.deepEqual(packagingKeyChanges('pyproject.toml', hatchBefore, hatchAfter), ['[tool.hatch.build.targets.wheel.force-include]']);
    assert.deepEqual(packagingKeyChanges('pyproject.toml', hatchBefore, hatchBefore.replace('1.0.0', '1.0.1')), []);
    assert.deepEqual(packagingKeyChanges('package.json', '{"version":"1.0.0"}', '{"version":"1.0.1"}'), []);
    assert.deepEqual(packagingKeyChanges('package.json', '{"files":["a"]}', '{"files":["a","b"]}'), ['files']);
    assert.equal(isBuildArgv(['/home/x/toolchains/bin/uv', 'build', '--wheel']), true);
    assert.equal(isBuildArgv(['uv', 'run', 'pytest', 'tests/test_build.py']), false);
  });

  test('validate warns packaging-change-without-build-check for a job writing pyproject.toml with no build check', async t => {
    const root = await repo(t);
    await fs.writeFile(path.join(root, 'pyproject.toml'), hatchBefore);
    const job = plainJob({ context: ['input.txt'], outputs: ['pyproject.toml'], prompt: 'Add [tool.hatch.build.targets.wheel.force-include] for the package data.' });
    const report = await validateProject(root, { version: 1, jobs: [job], checks: [{ name: 'unit', argv: ['uv', 'run', 'pytest'] }] });
    assert.ok(report.warnings.some(w => w.code === 'packaging-change-without-build-check' && w.jobId === 'writer'), JSON.stringify(report.warnings));
    const quiet = await validateProject(root, { version: 1, jobs: [job], checks: [{ name: 'wheel', argv: ['uv', 'build', '--wheel'] }] });
    assert.equal(quiet.warnings.some(w => w.code === 'packaging-change-without-build-check'), false);
    assert.equal(packagingWithoutBuildCheckWarning({ checks: [] }, plainJob()), null, 'a job with no packaging output is never flagged');
  });

  test('integrate warns and ship refuses a packaging-key change with no build check', async t => {
    const root = await repo(t);
    await fs.writeFile(path.join(root, 'pyproject.toml'), hatchBefore);
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'pyproject']);
    const job = plainJob({ context: ['input.txt'], outputs: ['pyproject.toml'] });
    const fake = (_c, _a, options) => spawn(process.execPath, ['-e', `require('fs').writeFileSync('pyproject.toml',${JSON.stringify(hatchAfter)});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}))`], options);
    const state = await runManifest(root, { version: 1, jobs: [job] }, { spawnImpl: fake });
    const integrated = await integrateRun(root, state.id);
    assert.ok(integrated.warnings?.some(w => w.startsWith('packaging-change-without-build-check: pyproject.toml: [tool.hatch.build.targets.wheel.force-include]')), JSON.stringify(integrated.warnings));
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 't', head: 'b', base: 'main', body: 'x' }));
    const exec = async (file, args) => file === 'git' && args[0] === 'remote' ? { code: 0, stdout: 'https://github.com/acme/widgets.git', stderr: '' } : file === 'git' && args[0] === 'rev-parse' ? { code: 0, stdout: 'sha1\n', stderr: '' } : { code: 0, stdout: '', stderr: '' };
    const changes = [{ file: 'pyproject.toml', keys: packagingKeyChanges('pyproject.toml', hatchBefore, hatchAfter) }];
    const refused = await ship({ root, repo: 'acme/widgets', payloadPath, packagingChanges: changes, checkArgvs: [['uv', 'run', 'pytest']], runChecks: async () => assert.fail('no check runs once refused'), exec, sleep: async () => {} });
    assert.equal(refused.status, 'refused');
    assert.match(refused.reason, /packaging-change-without-build-check: pyproject\.toml/);
    const allowed = await ship({ root, repo: 'acme/widgets', payloadPath, packagingChanges: changes, checkArgvs: [['uv', 'build', '--wheel']], runChecks: async () => [{ name: 'wheel', status: 'failed', exitCode: 1, tail: 'A second file is being added to the wheel archive at the same path' }], exec, sleep: async () => {} });
    assert.equal(allowed.status, 'checks-failed', 'with a build check, a broken wheel fails the ship as a red check');
  });
});

// --- L160: per-root env file -------------------------------------------------------------------

describe('L160: .swarm/env.json reaches every check, mutant and worker; env --print pastes it', () => {
  const needsEnv = [process.execPath, '-e', "process.exit(process.env.PLAYWRIGHT_BROWSERS_PATH==='/opt/fake-browsers'?0:1)"];
  const writeEnv = async (root, data) => { await fs.mkdir(path.join(root, '.swarm'), { recursive: true }); await fs.writeFile(path.join(root, '.swarm/env.json'), JSON.stringify(data)); };

  test('integrate checks see PLAYWRIGHT_BROWSERS_PATH from the root env file', async t => {
    const root = await repo(t);
    await writeEnv(root, { PLAYWRIGHT_BROWSERS_PATH: '/opt/fake-browsers' });
    const fake = (_c, _a, options) => spawn(process.execPath, ['-e', "require('fs').writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}))"], options);
    const state = await runManifest(root, { version: 1, jobs: [plainJob()], checks: [{ name: 'harness', argv: needsEnv }] }, { spawnImpl: fake });
    const integrated = await integrateRun(root, state.id);
    assert.equal(integrated.checksPassed, true, JSON.stringify(integrated.checks));
  });

  test('current-tree mutants and a shell worker get it too; a linked worktree falls back to its main root', async t => {
    const root = await repo(t);
    await writeEnv(root, { PLAYWRIGHT_BROWSERS_PATH: '/opt/fake-browsers' });
    await fs.writeFile(path.join(root, 'target.js'), 'const a = 1;\n');
    const mutantsPath = path.join(await tmp(t, 'swarm-env-mutants-'), 'm.json');
    await fs.writeFile(mutantsPath, JSON.stringify([{ name: 'a', file: 'target.js', find: 'a = 1', replace: 'a = 2' }]));
    const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck: JSON.stringify(needsEnv) }, spawn);
    assert.equal(result.mutants[0].status, 'survived', 'the baseline passed only because the env file reached it');
    const env = shellEnvironment({ parentEnv: { PATH: '/usr/bin' }, home: '/j/home', tmp: '/j/tmp', configDir: '/j/c', proxyPort: 1, apiKey: FAKE_KEY, userId: 'swarm-worker:j', swarmEnv: { PLAYWRIGHT_BROWSERS_PATH: '/opt/fake-browsers', TMPDIR: '/not/allowed' } });
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/opt/fake-browsers');
    assert.equal(env.TMPDIR, '/j/tmp', 'a key the runner fixes is never overridden by the env file');
    const linked = path.join(await tmp(t, 'swarm-env-linked-'), 'wt');
    await git(root, ['worktree', 'add', '-q', '--detach', linked, 'HEAD']);
    const loaded = await loadSwarmEnv(linked);
    assert.equal(loaded.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/fake-browsers');
    assert.equal(loaded.source, path.join(root, '.swarm/env.json'));
  });

  test('validate refuses a secret-looking or reserved key and warns check-needs-env with no file', async t => {
    assert.throws(() => validateSwarmEnv({ OPENAI_API_KEY: 'sk-FAKE-0000' }), /looks like a secret/);
    assert.throws(() => validateSwarmEnv({ PATH: '/x' }), /reserved/);
    const root = await repo(t);
    const report = await validateProject(root, { version: 1, jobs: [plainJob()], checks: [{ name: 'e2e', argv: ['npx', 'playwright', 'test'] }] });
    assert.ok(report.warnings.some(w => w.code === 'check-needs-env' && w.checks.includes('e2e')), JSON.stringify(report.warnings));
    assert.deepEqual(checkNeedsEnvWarnings({ checks: [{ name: 'e2e', argv: ['npx', 'x'] }] }, true), []);
    await writeEnv(root, { GH_TOKEN: 'gh-FAKE' });
    await assert.rejects(validateProject(root, { version: 1, jobs: [plainJob()] }), /looks like a secret/);
  });

  test('swarm env --print prints export lines, the port block and the no-stash rule', async t => {
    const root = await repo(t);
    await writeEnv(root, { PLAYWRIGHT_BROWSERS_PATH: "/opt/it's here" });
    const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'env', '--print']);
    assert.match(stdout, /^export PLAYWRIGHT_BROWSERS_PATH='\/opt\/it'\\''s here'$/m);
    assert.match(stdout, /^export SWARM_PORT_BASE=\d+/m);
    assert.ok(stdout.includes(NO_STASH_LINE));
    assert.equal(envPrintText({ env: {}, source: null }).includes('no .swarm/env.json found'), true);
  });
});

// --- L161: mutant find pre-check ---------------------------------------------------------------

describe('L161: mutants refuses a find that is missing, duplicated or a no-op before anything runs', () => {
  test('three distinct refusals, nothing mutated, the check never ran', async t => {
    const root = await tmp(t, 'swarm-mutants-161-');
    const original = 'const a = 1;\nconst b = 1;\n';
    await fs.writeFile(path.join(root, 'target.js'), original);
    const marker = path.join(root, 'check-ran');
    const mutantsPath = path.join(await tmp(t, 'swarm-m161-'), 'm.json');
    await fs.writeFile(mutantsPath, JSON.stringify([
      { name: 'missing', file: 'target.js', find: '    const a = 1;', replace: 'const a = 2;' },
      { name: 'duplicate', file: 'target.js', find: '= 1;', replace: '= 2;' },
      { name: 'noop', file: 'target.js', find: 'const a', replace: 'const a' },
      { name: 'fine', file: 'target.js', find: 'const a = 1;', replace: 'const a = 2;' },
    ]));
    const check = JSON.stringify([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`]);
    await assert.rejects(runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck: check }, spawn), error => {
      assert.match(error.message, /3 invalid mutant\(s\), nothing mutated/);
      assert.match(error.message, /missing: invalid-find \(target\.js: find matched 0 times\)/);
      assert.match(error.message, /duplicate: ambiguous-find \(target\.js: find matched 2 times\)/);
      assert.match(error.message, /noop: no-op \(target\.js: find equals replace\)/);
      assert.equal(error.message.includes('fine:'), false);
      assert.deepEqual(error.details.mutantProblems.map(p => p.code), ['invalid-find', 'ambiguous-find', 'no-op']);
      return true;
    });
    assert.equal(await fs.readFile(path.join(root, 'target.js'), 'utf8'), original);
    await assert.rejects(fs.access(marker), 'no baseline or mutant check ran');
  });

  test('--dry-run only validates: valid mutants are listed and no check runs', async t => {
    const root = await tmp(t, 'swarm-mutants-161-');
    await fs.writeFile(path.join(root, 'target.js'), 'const a = 1;\n');
    const marker = path.join(root, 'check-ran');
    const mutantsPath = path.join(await tmp(t, 'swarm-m161-'), 'm.json');
    await fs.writeFile(mutantsPath, JSON.stringify([{ name: 'fine', file: 'target.js', find: 'a = 1', replace: 'a = 2' }]));
    const check = JSON.stringify([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`]);
    const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'mutants', '--mutants-file', mutantsPath, '--mutant-check', check, '--dry-run']);
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'dry-run');
    assert.equal(result.mutantsValid, true);
    assert.deepEqual(result.mutants.map(m => [m.name, m.status]), [['fine', 'valid']]);
    await assert.rejects(fs.access(marker));
  });
});

// --- L162: per-mutant check ----------------------------------------------------------------------

describe('L162: a mutant may carry its own check argv, overriding the shared mutant check', () => {
  test('two mutants, one with its own check: each runs only its own check, and the report names it', async t => {
    const root = await tmp(t, 'swarm-mutants-162-');
    const original = 'const a = 1;\nconst b = 2;\n';
    await fs.writeFile(path.join(root, 'target.js'), original);
    const log = path.join(await tmp(t, 'swarm-m162-log-'), 'log.txt');
    const checkFor = (label, guard) => [process.execPath, '-e', `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${label}\\n');process.exit(fs.readFileSync('target.js','utf8').includes('${guard}')?0:1)`];
    const shared = checkFor('shared', 'a = 1');
    const own = checkFor('own', 'b = 2');
    const mutantsPath = path.join(await tmp(t, 'swarm-m162-'), 'm.json');
    await fs.writeFile(mutantsPath, JSON.stringify([
      { name: 'unit-rule', file: 'target.js', find: 'a = 1', replace: 'a = 9' },
      // The shared check never reads `b`, so this mutant would survive it; only its own check kills it.
      { name: 'layout-rule', file: 'target.js', find: 'b = 2', replace: 'b = 9', check: own },
    ]));
    const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck: JSON.stringify(shared) }, spawn);
    const byName = Object.fromEntries(result.mutants.map(m => [m.name, m]));
    assert.equal(byName['unit-rule'].status, 'killed');
    assert.equal(byName['unit-rule'].check, 'default');
    assert.equal(byName['layout-rule'].status, 'killed');
    assert.equal(byName['layout-rule'].check, 'mutant');
    assert.deepEqual(byName['layout-rule'].checkArgv, own);
    // Baselines (shared, own), then each mutant with exactly its own check.
    assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'), ['shared', 'own', 'shared', 'own']);
    assert.equal(await fs.readFile(path.join(root, 'target.js'), 'utf8'), original);
  });

  test('with every mutant carrying its own check, --mutant-check is not required; a bad check shape is refused', async t => {
    const root = await tmp(t, 'swarm-mutants-162-');
    await fs.writeFile(path.join(root, 'target.js'), 'const b = 2;\n');
    const mutantsPath = path.join(await tmp(t, 'swarm-m162-'), 'm.json');
    await fs.writeFile(mutantsPath, JSON.stringify([{ name: 'own-only', file: 'target.js', find: 'b = 2', replace: 'b = 9', check: [process.execPath, '-e', "process.exit(require('fs').readFileSync('target.js','utf8').includes('b = 2')?0:1)"] }]));
    const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath }, spawn);
    assert.equal(result.mutants[0].status, 'killed');
    await fs.writeFile(mutantsPath, JSON.stringify([{ name: 'bad', file: 'target.js', find: 'b = 2', replace: 'b = 9', check: 'npm test' }]));
    await assert.rejects(runMutantsCurrentTree(root, { mutantsFile: mutantsPath }, spawn), /Mutant check must be a non-empty argv array of strings: bad/);
  });
});

// --- L163: never git stash -------------------------------------------------------------------------

describe('L163: workers are told never to git stash, and a shell worker cannot', () => {
  test('the git guard refuses stash (after global options) with a plain message and passes anything else through', async t => {
    const dir = await tmp(t, 'swarm-git-guard-');
    const guard = path.join(dir, 'git');
    const { stdout: realGitPath } = await execFileAsync('/bin/sh', ['-c', 'command -v git']);
    await fs.writeFile(guard, gitGuardScript(realGitPath.trim()), { mode: 0o755 });
    for (const args of [['stash'], ['stash', 'pop'], ['-C', dir, 'stash', 'list'], ['-c', 'user.name=x', 'stash']]) {
      await assert.rejects(execFileAsync('/bin/sh', [guard, ...args]), error => {
        assert.equal(error.code, 2, args.join(' '));
        assert.match(error.stderr, /git stash is not allowed here\. The stash stack is shared by every worktree/);
        return true;
      });
    }
    const { stdout } = await execFileAsync('/bin/sh', [guard, '--version']);
    assert.match(stdout, /^git version/);
  });

  test('shell and codex prompts carry the rule; a shell worker gets the guard first on PATH', async t => {
    const job = shellJob();
    assert.ok(shellMessage(job, { files: [] }).includes(NO_STASH_LINE));
    assert.ok(codexMessage({ ...job, agent: 'codex', model: 'm' }).includes(NO_STASH_LINE));
    const root = await repo(t);
    const seen = [];
    const state = await runManifest(root, { version: 1, jobs: [shellJob()] }, { platform: 'darwin', spawnImpl: fakeShellSpawn(workerDone, seen), env: runEnv, keyExec: noKeychain, shellHooks: hooks });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    const launch = seen.find(call => call.args[2] === FAKE_BIN);
    const guardDir = path.join(root, '.swarm/runs', state.id, 'builder/shell/bin');
    assert.ok(launch.options.env.PATH.startsWith(`${guardDir}:`), launch.options.env.PATH);
    assert.match(await fs.readFile(path.join(guardDir, 'git'), 'utf8'), /git stash is not allowed here/);
  });
});

// --- L164: ship --branch -----------------------------------------------------------------------------

describe('L164: ship --branch ships a finished branch that has no swarm run', () => {
  async function branchRepo(t) {
    const root = await repo(t);
    await git(root, ['checkout', '-q', '-b', 'slice-5']);
    await fs.writeFile(path.join(root, 'slice.txt'), 'built outside the swarm');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'slice 5']);
    return root;
  }
  let payloads = 0;
  const writePayload = async (root, fields = {}) => {
    const file = path.join(root, `pr-${++payloads}.json`);
    await fs.writeFile(file, JSON.stringify({ title: 'Slice 5', head: 'slice-5', base: 'main', body: '## Checks\n<!-- swarm:checks -->\n', ...fields }));
    return file;
  };
  // Answers by command, not by order: every gh/git step ship() takes on a green, mergeable PR.
  function fakeExec(calls, { branch = 'slice-5' } = {}) {
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    return async (file, args, opts) => {
      calls.push({ file, args, input: opts?.input });
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok(`${branch}\n`);
      if (file === 'git' && args[0] === 'rev-parse') return ok('sha164\n');
      if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
      if (file === 'git' && args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'none' };
      if (file === 'git') return ok('');
      if (file === 'gh' && args[0] === 'api' && args[1].includes('/pulls?head=')) return ok('[]');
      if (file === 'gh' && args[0] === 'api' && args[1].endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('state,mergeCommit')) return ok(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'merge164' } }));
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha164', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return ok('');
      throw Error(`unexpected exec ${file} ${args.join(' ')}`);
    };
  }

  test('a branch with no .swarm/runs ships: its --check runs, fills the checks section, pushes, opens the PR and merges', async t => {
    const root = await branchRepo(t);
    const calls = [];
    const flags = parseShipFlags(['--branch', 'slice-5', '--pr', await writePayload(root), '--require-section', 'Checks', '--check', JSON.stringify([process.execPath, '-e', 'process.exit(0)'])]);
    const result = await shipBranch(root, flags, { exec: fakeExec(calls), sleep: async () => {} });
    assert.equal(result.status, 'merged', result.reason ?? '');
    assert.deepEqual(result.checks.map(c => [c.name, c.status]), [['check-1', 'passed']]);
    assert.ok(calls.some(c => c.file === 'git' && c.args[0] === 'push' && c.args.includes('HEAD:refs/heads/slice-5')));
    const created = calls.find(c => c.file === 'gh' && c.args[1] === 'repos/acme/widgets/pulls');
    assert.match(JSON.parse(created.input).body, /check-1 -> passed/);
    await assert.rejects(fs.access(path.join(root, '.swarm/runs')), 'no swarm run was needed');
  });

  test('the needs-a-human hold, required sections, a failing check and a wrong checkout all apply', async t => {
    const root = await branchRepo(t);
    const passing = JSON.stringify([process.execPath, '-e', 'process.exit(0)']);
    const held = await shipBranch(root, parseShipFlags(['--branch', 'slice-5', '--pr', await writePayload(root, { body: '**needs review** first\n\n## Checks\n<!-- swarm:checks -->\n' }), '--check', passing]), { exec: fakeExec([]), sleep: async () => {} });
    assert.equal(held.status, 'held');
    const missing = await shipBranch(root, parseShipFlags(['--branch', 'slice-5', '--pr', await writePayload(root), '--require-section', 'Mutation check', '--check', passing]), { exec: fakeExec([]), sleep: async () => {} });
    assert.equal(missing.status, 'refused');
    assert.match(missing.reason, /missing sections: Mutation check/);
    const red = await shipBranch(root, parseShipFlags(['--branch', 'slice-5', '--pr', await writePayload(root), '--check', JSON.stringify([process.execPath, '-e', 'process.exit(1)'])]), { exec: fakeExec([]), sleep: async () => {} });
    assert.equal(red.status, 'checks-failed');
    const elsewhere = await shipBranch(root, parseShipFlags(['--branch', 'slice-5', '--pr', await writePayload(root)]), { exec: fakeExec([], { branch: 'main' }), sleep: async () => {} });
    assert.equal(elsewhere.status, 'refused');
    assert.match(elsewhere.reason, /is not checked out/);
    const mismatch = await shipBranch(root, parseShipFlags(['--branch', 'slice-5', '--pr', await writePayload(root, { head: 'other' })]), { exec: fakeExec([]), sleep: async () => {} });
    assert.match(mismatch.reason, /does not match --branch slice-5/);
    const unchecked = await shipBranch(root, parseShipFlags(['--branch', 'slice-5', '--pr', await writePayload(root)]), { exec: fakeExec([]), sleep: async () => {} });
    assert.ok(unchecked.warnings.some(w => w.startsWith('no-checks:')));
    assert.throws(() => parseShipFlags(['--pr', 'x.json', '--check', passing]), /--check is only for ship --branch/);
  });
});
