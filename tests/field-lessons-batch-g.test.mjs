// SPDX-License-Identifier: Apache-2.0
// Field lessons #169–#172 as tool checks: path flags (scout --brief, ship/go --pr) resolve
// against the cwd first, then --root; the git guard also refuses a hand mutant-revert; `swarm
// mutants` accepts `id` as an alias for `name`, and `env --print` carries the exact mutants file
// shape line; the uv lock check resolves `uv` like any other toolchain binary and reports a clear
// reason when it cannot even start.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runManifest, scoutRun, runMutantsCurrentTree, shipBranch, resolvePathCwdThenRoot,
} from '../tools/swarm.mjs';
import { briefPathCandidates } from '../tools/scout.mjs';
import { gitGuardScript, envPrintText, MUTANTS_SHAPE, MUTANTS_BY_HAND_LINE } from '../tools/swarm-env.mjs';
import { ship, resolveUv } from '../tools/ship.mjs';
import { git, codexMessage } from '../tools/codex-adapter.mjs';
import { shellMessage } from '../tools/claude-shell.mjs';

const execFileAsync = promisify(execFile);

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Changing the process cwd affects only this worker (each test file is its own process under
// `node --test`); always paired with a `t.after` restore so later tests in this file are unaffected.
async function withCwd(t, dir, run) {
  const original = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(original));
  return run();
}

// --- L169: scout --brief (and ship/go --pr) resolve against the cwd first, then --root ---------

describe('L169: a relative path flag is tried against the cwd first, then --root', () => {
  test('briefPathCandidates: cwd and root differ -> both, in cwd-first order; equal -> one; absolute -> one, unchanged', () => {
    const root = '/project/root';
    const cwd = '/somewhere/else';
    assert.deepEqual(briefPathCandidates('brief.txt', root, cwd), [path.resolve(cwd, 'brief.txt'), path.resolve(root, 'brief.txt')]);
    assert.deepEqual(briefPathCandidates('brief.txt', root, root), [path.resolve(root, 'brief.txt')]);
    const outside = '/etc/some-brief.txt';
    assert.deepEqual(briefPathCandidates(outside, root, cwd), [outside]);
  });

  test('scout --brief resolves against the cwd the user is sitting in, not only against --root', async t => {
    const root = await tmp(t, 'swarm-lessons-g-scout-root-');
    const cwdDir = await tmp(t, 'swarm-lessons-g-scout-cwd-');
    await fs.writeFile(path.join(cwdDir, 'brief.txt'), 'from cwd, not root');
    const scoutSpawn = (_cmd, _args, options) => spawn(process.execPath, ['-e', `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ picks: [], rejected: [], top: [] }))}}));`], options);
    const result = await withCwd(t, cwdDir, () => scoutRun(root, { model: 'sonnet', brief: 'brief.txt', goal: 'find a library' }, { spawnImpl: scoutSpawn }));
    assert.equal(result.status, 'complete');
    const copied = await fs.readFile(path.join(root, '.swarm/scouts', result.id, 'brief.md'), 'utf8');
    assert.equal(copied, 'from cwd, not root');
  });

  test('scout --brief not found names every path actually tried (cwd, then root)', async t => {
    const root = await tmp(t, 'swarm-lessons-g-scout-root2-');
    const cwdDir = await tmp(t, 'swarm-lessons-g-scout-cwd2-');
    await assert.rejects(
      withCwd(t, cwdDir, () => scoutRun(root, { model: 'sonnet', brief: 'missing.txt', goal: 'x' }, { spawnImpl: () => assert.fail('must never spawn') })),
      error => {
        assert.equal(error.message, `scout brief not found: missing.txt (tried: ${path.resolve(cwdDir, 'missing.txt')}, ${path.resolve(root, 'missing.txt')})`);
        return true;
      },
    );
  });

  test('resolvePathCwdThenRoot: finds a relative path at the cwd first, falls back to root, passes an absolute path through, and names every path tried when none exist', async t => {
    const root = await tmp(t, 'swarm-lessons-g-resolve-root-');
    const cwdDir = await tmp(t, 'swarm-lessons-g-resolve-cwd-');
    await fs.writeFile(path.join(cwdDir, 'in-cwd.json'), 'x');
    assert.equal(await resolvePathCwdThenRoot('in-cwd.json', root, { cwd: cwdDir }), path.resolve(cwdDir, 'in-cwd.json'));

    await fs.writeFile(path.join(root, 'in-root.json'), 'x');
    assert.equal(await resolvePathCwdThenRoot('in-root.json', root, { cwd: cwdDir }), path.resolve(root, 'in-root.json'));

    const absolute = '/definitely/not/anywhere/z.json';
    await assert.rejects(resolvePathCwdThenRoot(absolute, root, { cwd: cwdDir, label: 'PR payload' }), error => {
      assert.equal(error.message, `PR payload not found: ${absolute} (tried: ${absolute})`);
      return true;
    });

    await assert.rejects(resolvePathCwdThenRoot('missing.json', root, { cwd: cwdDir, label: 'PR payload' }), error => {
      assert.equal(error.message, `PR payload not found: missing.json (tried: ${path.resolve(cwdDir, 'missing.json')}, ${path.resolve(root, 'missing.json')})`);
      return true;
    });
  });

  test('ship --branch resolves --pr against the cwd first: a decoy payload at --root is ignored in favor of the one at the cwd', async t => {
    const root = await tmp(t, 'swarm-lessons-g-shipbranch-');
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['config', 'user.name', 'Fixture']);
    await git(root, ['config', 'user.email', 'fixture@example.invalid']);
    await fs.writeFile(path.join(root, 'f.txt'), 'x');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
    const cwdDir = await tmp(t, 'swarm-lessons-g-shipbranch-cwd-');
    // A decoy at --root: if it were used (the old root-only resolution), the head mismatch would
    // refuse here, before ever reaching a merge-base lookup.
    await fs.writeFile(path.join(root, 'pr.json'), JSON.stringify({ title: 't', head: 'decoy-branch', base: 'main', body: 'b' }));
    // The real payload the user meant, at the cwd they are sitting in; its `base` names a ref that
    // cannot exist, so reaching this file (not the decoy) fails at a distinct, later step instead.
    await fs.writeFile(path.join(cwdDir, 'pr.json'), JSON.stringify({ title: 't', head: 'main', base: 'no-such-ref-anywhere', body: 'b' }));
    const exec = async (file, args) => {
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main\n', stderr: '' };
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const result = await withCwd(t, cwdDir, () => shipBranch(root, { branch: 'main', payloadPath: 'pr.json', requireSections: [], merge: true }, { exec }));
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /cannot find the merge base of main and no-such-ref-anywhere/);
  });
});

// --- L170: the git guard also refuses a hand mutant-revert -------------------------------------

describe('L170: the git guard refuses git checkout/restore of a path with uncommitted changes ("commit WIP first"), and job boilerplate says never to hand-revert', () => {
  async function guardFixture(t) {
    const dir = await tmp(t, 'swarm-lessons-g-guard-');
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'f.txt'), 'original\n');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: dir });
    const { stdout: realGitPath } = await execFileAsync('/bin/sh', ['-c', 'command -v git']);
    const guard = path.join(dir, 'git');
    await fs.writeFile(guard, gitGuardScript(realGitPath.trim()), { mode: 0o755 });
    return { dir, guard };
  }

  test('git checkout <path> / git checkout -- <path> / git restore <path> are each refused, with "commit WIP first", when that path has uncommitted changes', async t => {
    const { dir, guard } = await guardFixture(t);
    for (const args of [['checkout', 'f.txt'], ['checkout', '--', 'f.txt'], ['restore', 'f.txt']]) {
      await fs.writeFile(path.join(dir, 'f.txt'), 'dirty\n');
      await assert.rejects(execFileAsync(guard, args, { cwd: dir }), error => {
        assert.equal(error.code, 2, args.join(' '));
        assert.match(error.stderr, /commit WIP first/);
        assert.match(error.stderr, /run mutants with `swarm mutants`, never by hand/);
        return true;
      });
      // Refused, so the file must still be dirty: nothing was actually reverted.
      assert.equal(await fs.readFile(path.join(dir, 'f.txt'), 'utf8'), 'dirty\n');
    }
  });

  test('a staged-only change is refused too, and a clean path or a plain branch checkout passes through to the real git', async t => {
    const { dir, guard } = await guardFixture(t);
    await fs.writeFile(path.join(dir, 'f.txt'), 'staged-change\n');
    await execFileAsync('git', ['add', 'f.txt'], { cwd: dir });
    await assert.rejects(execFileAsync(guard, ['restore', 'f.txt'], { cwd: dir }), error => {
      assert.equal(error.code, 2);
      return true;
    });
    await execFileAsync('git', ['reset', 'f.txt'], { cwd: dir });
    await execFileAsync('git', ['checkout', '-q', '--', 'f.txt'], { cwd: dir });

    // Clean path: checkout is a no-op and must be allowed through.
    const clean = await execFileAsync(guard, ['checkout', 'f.txt'], { cwd: dir });
    assert.match(clean.stdout + clean.stderr, /Updated 0 paths|^$/);

    // A plain branch checkout never has a diff against the pathspec "main", so it must pass through.
    await execFileAsync('git', ['checkout', '-qb', 'other'], { cwd: dir });
    const branchSwitch = await execFileAsync(guard, ['checkout', 'main'], { cwd: dir });
    assert.equal(branchSwitch.stderr.includes('refused'), false);
  });

  test('git stash is still refused (regression, lesson #163) and --version still passes through', async t => {
    const { dir, guard } = await guardFixture(t);
    await assert.rejects(execFileAsync(guard, ['stash'], { cwd: dir }), error => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /git stash is not allowed here/);
      return true;
    });
    const { stdout } = await execFileAsync(guard, ['--version'], { cwd: dir });
    assert.match(stdout, /^git version/);
  });

  test('a global -C is honored by the diff check itself, so a clean path reached through -C is never a false refusal', async t => {
    const { dir, guard } = await guardFixture(t);
    const result = await execFileAsync(guard, ['-C', dir, 'checkout', 'f.txt'], { cwd: os.tmpdir() });
    assert.equal(result.stdout.includes('refused'), false);
  });

  test('job boilerplate: a shell or codex worker (both can run git) is told to run `swarm mutants`, never hand-revert one; a plain worker (no shell tool at all) carries no such line', () => {
    const shellJob = { id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Update.', context: [], outputs: ['output.txt'] };
    assert.ok(shellMessage(shellJob, { files: [] }).includes(MUTANTS_BY_HAND_LINE));
    const codexJob = { id: 'builder', agent: 'codex', model: 'test-model', prompt: 'Update.', context: [], outputs: ['output.txt'] };
    assert.ok(codexMessage(codexJob).includes(MUTANTS_BY_HAND_LINE));
  });

  test('env --print carries the same rule', () => {
    const text = envPrintText({ env: {}, source: null });
    assert.ok(text.includes(MUTANTS_BY_HAND_LINE));
  });
});

// --- L171: `swarm mutants` accepts "id" as an alias for "name", and env --print states the shape -

describe('L171: a worker-written mutants file may use "id" for "name" (aliased, with a warning); env --print states the exact shape', () => {
  test('runMutantsCurrentTree accepts a mutants file whose entries use "id" instead of "name", aliasing it with a warning', async t => {
    const root = await tmp(t, 'swarm-lessons-g-mutants-root-');
    await fs.writeFile(path.join(root, 'target.js'), 'const a = 1;\n');
    const mutantsDir = await tmp(t, 'swarm-lessons-g-mutants-file-');
    const mutantsPath = path.join(mutantsDir, 'm.json');
    await fs.writeFile(mutantsPath, JSON.stringify([{ id: 'kill-a', file: 'target.js', find: 'a = 1', replace: 'a = 9' }]));
    const check = [process.execPath, '-e', "process.exit(require('fs').readFileSync('target.js','utf8').includes('a = 1')?0:1)"];
    const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck: JSON.stringify(check) }, spawn);
    assert.equal(result.mutants.length, 1);
    assert.equal(result.mutants[0].name, 'kill-a');
    assert.equal(result.mutants[0].status, 'killed');
    assert.ok(result.warnings?.some(w => w.includes('"kill-a"') && w.includes('"id"') && w.includes('"name"')), JSON.stringify(result.warnings));
  });

  test('a mutants file already shaped with "name" produces no aliasing warning', async t => {
    const root = await tmp(t, 'swarm-lessons-g-mutants-root2-');
    await fs.writeFile(path.join(root, 'target.js'), 'const a = 1;\n');
    const mutantsDir = await tmp(t, 'swarm-lessons-g-mutants-file2-');
    const mutantsPath = path.join(mutantsDir, 'm.json');
    await fs.writeFile(mutantsPath, JSON.stringify([{ name: 'kill-a', file: 'target.js', find: 'a = 1', replace: 'a = 9' }]));
    const check = [process.execPath, '-e', "process.exit(require('fs').readFileSync('target.js','utf8').includes('a = 1')?0:1)"];
    const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck: JSON.stringify(check) }, spawn);
    assert.equal(result.warnings, undefined);
  });

  test('env --print includes the exact mutants file shape line, byte-identical to a job\'s own mutantsFile preamble', async t => {
    const text = envPrintText({ env: {}, source: null });
    assert.ok(text.includes(MUTANTS_SHAPE), text);

    const root = await tmp(t, 'swarm-lessons-g-shape-root-');
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
    await fs.writeFile(path.join(root, 'input.txt'), 'original');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: root });
    const job = { id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Build.', context: ['input.txt'], outputs: ['input.txt', 'mutants.json'], mutantsFile: 'mutants.json' };
    const spawnImpl = (_cmd, _args, options) => spawn(process.execPath, ['-e', "const fs=require('fs');fs.writeFileSync('input.txt','updated');fs.writeFileSync('mutants.json','[]');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));"], options);
    const state = await runManifest(root, { version: 1, jobs: [job] }, { spawnImpl });
    const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer', 'message.txt'), 'utf8');
    assert.ok(message.includes(MUTANTS_SHAPE), message);
  });
});

// --- L172: the uv lock check resolves uv like any other toolchain binary -----------------------

describe('L172: the uv lock check resolves uv (toolchains dir, then PATH) before spawning it, and reports every path tried when it cannot start', () => {
  test('resolveUv: finds uv in the toolchains dir before PATH, falls back to PATH, and reports null + every path tried when missing', async () => {
    const found = ['/opt/toolchains/uv'];
    const foundInToolchains = await resolveUv({ env: { SWARM_TOOLCHAINS: '/opt/toolchains', PATH: '/usr/bin' }, access: async file => { if (file !== '/opt/toolchains/uv') throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); } });
    assert.equal(foundInToolchains.path, '/opt/toolchains/uv');
    assert.equal(foundInToolchains.tried[0], '/opt/toolchains/uv');

    const foundOnPath = await resolveUv({ env: { SWARM_TOOLCHAINS: '/opt/toolchains', PATH: '/usr/bin:/usr/local/bin' }, access: async file => { if (file !== '/usr/local/bin/uv') throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); } });
    assert.equal(foundOnPath.path, '/usr/local/bin/uv');
    assert.ok(foundOnPath.tried.includes('/opt/toolchains/uv'), 'tries the toolchains dir before PATH');
    assert.ok(foundOnPath.tried.indexOf('/opt/toolchains/uv') < foundOnPath.tried.indexOf('/usr/local/bin/uv'));

    const missing = await resolveUv({ env: { SWARM_TOOLCHAINS: '/opt/toolchains', PATH: '/usr/bin' }, access: async () => { throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); } });
    assert.equal(missing.path, null);
    assert.ok(missing.tried.length > 0);
    void found;
  });

  test('ship reports lock-check-cannot-run with every path tried when uv cannot be resolved, and never spawns it', async t => {
    const root = await tmp(t, 'swarm-lessons-g-ship-uv-');
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 't', head: 'feature-branch', base: 'main', body: 'b' }));
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const calls = [];
    const exec = async (file, args, opts) => {
      calls.push({ file, args, opts });
      if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
      if (file === 'git' && args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'no package' };
      if (file === 'git' && args[0] === 'status') return ok('');
      if (file === 'git' && args[0] === 'rev-parse') return ok('sha123\n');
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const tried = ['/opt/.project-swarm/toolchains/uv', '/opt/.project-swarm/toolchains/bin/uv', '/usr/bin/uv'];
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      sleep: async () => {}, now: () => 0,
      exec, integratedFiles: ['pyproject.toml'],
      resolveUv: async () => ({ path: null, tried }),
    });
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, `lock-check-cannot-run: uv not found (tried ${tried.join(', ')})`);
    assert.ok(!calls.some(c => c.file === 'uv' || tried.includes(c.file)), 'uv must never be spawned once it cannot be resolved');
  });
});
