// SPDX-License-Identifier: Apache-2.0
// Field lessons #165–#167 as tool checks: a validate warning for a shared output file already
// claimed by another open run of the same repo, shipRun actually passing integratedFiles through
// to ship() (so the #147 pre-push lock check runs on a real `ship <id>`), and a per-root
// .swarm/gotchas.md appended to every job prompt and to `env --print`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runManifest, integrateRun, validateProject } from '../tools/swarm.mjs';
import { registerLiveRun, unregisterLiveRun } from '../tools/board.mjs';
import { shellMessage } from '../tools/claude-shell.mjs';
import { codexMessage, git } from '../tools/codex-adapter.mjs';
import { envPrintText, NO_STASH_LINE, materializeGitGuard, GIT_GUARD_DIR } from '../tools/swarm-env.mjs';
import { loadGotchas, gotchasPromptBlock, windowsCiGotchasWarnings, GOTCHAS_FILE } from '../tools/gotchas.mjs';

const execFileAsync = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'swarm.mjs');

async function tmp(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function repo(t) {
  const root = await tmp(t, 'swarm-batch-f-');
  await git(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  return root;
}
const plainJob = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const doneResult = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));`;
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}

// --- L165: validate warns about an output shared with an already-open run elsewhere -------------

describe('L165: validate warns shared-output-across-open-jobs against an already-open run of the same repo', () => {
  test('an already-open run in a sibling worktree listing the same output file is named; no warning for a different file, a different repo, or a dead process', async t => {
    const upstream = await tmp(t, 'swarm-165-repo-');
    await git(upstream, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(upstream, 'shared.txt'), 'base');
    await fs.writeFile(path.join(upstream, '.gitignore'), '.swarm/\n');
    await git(upstream, ['add', '.']);
    await git(upstream, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    const worktreeA = path.join(upstream, 'wt-a'), worktreeB = path.join(upstream, 'wt-b');
    await git(upstream, ['worktree', 'add', '--detach', worktreeA, 'HEAD']);
    await git(upstream, ['worktree', 'add', '--detach', worktreeB, 'HEAD']);
    const rootA = await fs.realpath(worktreeA), rootB = await fs.realpath(worktreeB);
    const liveDir = await tmp(t, 'swarm-165-live-');
    await registerLiveRun({ runId: 'open-elsewhere', root: rootA, outputs: ['shared.txt'], dir: liveDir });
    t.after(() => unregisterLiveRun('open-elsewhere', { dir: liveDir }));

    const manifest = { version: 1, jobs: [plainJob({ context: ['shared.txt'], outputs: ['shared.txt'] })] };
    const report = await validateProject(rootB, manifest, { liveDir });
    assert.ok(report.warnings.some(w => w.code === 'shared-output-across-open-jobs' && w.path === 'shared.txt' && w.runIds.includes('open-elsewhere')), JSON.stringify(report.warnings));
    // validate warns; it never refuses the run the way run()'s own exact-collision check does.
    assert.equal(report.status, 'valid');

    // A different output file: no warning.
    const otherFile = { version: 1, jobs: [plainJob({ context: ['input.txt'], outputs: ['input.txt'] })] };
    await fs.writeFile(path.join(rootB, 'input.txt'), 'x');
    await git(rootB, ['add', 'input.txt']);
    await git(rootB, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'input']);
    const quiet = await validateProject(rootB, otherFile, { liveDir });
    assert.equal(quiet.warnings.some(w => w.code === 'shared-output-across-open-jobs'), false);

    // Same file, a wholly different repo: no warning (checked before the destructive dead-process
    // case below, which prunes the live record it treats as dead).
    const otherRepo = await repo(t);
    await fs.writeFile(path.join(otherRepo, 'shared.txt'), 'x');
    await git(otherRepo, ['add', 'shared.txt']);
    await git(otherRepo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'shared']);
    const differentRepoReport = await validateProject(otherRepo, manifest, { liveDir });
    assert.equal(differentRepoReport.warnings.some(w => w.code === 'shared-output-across-open-jobs'), false);

    // Same file, but the other live run's process is treated as dead: no warning (and the stale
    // record is pruned, same as listLiveRuns always does for a dead pid).
    const deadIsAlive = () => false;
    const deadReport = await validateProject(rootB, manifest, { liveDir, isAlive: deadIsAlive });
    assert.equal(deadReport.warnings.some(w => w.code === 'shared-output-across-open-jobs'), false);
  });
});

// --- L166: shipRun passes integratedFiles through to ship() --------------------------------------

describe('L166: shipRun wires integratedFiles into ship(), so the #147 lock check runs on a real ship', () => {
  test('CLI `ship <id>` refuses on a stale lockfile via the #147 lock check (not a push failure), proving integratedFiles reached ship()', async t => {
    const root = await repo(t);
    const job = plainJob({ context: ['input.txt'], outputs: ['package.json'], prompt: 'Add a package.json.' });
    const pkgContent = JSON.stringify({ name: 'demo', version: '1.0.0' });
    const writeJob = fake(`fs.writeFileSync('package.json', ${JSON.stringify(pkgContent)}); ${doneResult}`);
    const state = await runManifest(root, { version: 1, jobs: [job] }, { spawnImpl: writeJob });
    const integrated = await integrateRun(root, state.id);
    assert.equal(integrated.status, 'integrated', JSON.stringify(integrated));
    await git(root, ['add', 'package.json']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'package.json']);

    // A fake npm on PATH ahead of the real one: always fails npm-lock-check's `npm ci --dry-run`.
    const binDir = await tmp(t, 'swarm-166-bin-');
    const marker = path.join(binDir, 'npm-called');
    await fs.writeFile(path.join(binDir, 'npm'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho "npm ci can only install packages when your package.json and package-lock.json are in sync" >&2\nexit 1\n`, { mode: 0o755 });

    await fs.writeFile(path.join(root, 'pr.json'), JSON.stringify({ title: 't', head: 'main', base: 'main', body: 'body' }));
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, '--root', root, 'ship', state.id, '--repo', 'acme/widgets', '--pr', 'pr.json'], { env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` } }),
      error => {
        const result = JSON.parse(error.stdout);
        assert.equal(result.status, 'refused');
        assert.match(result.reason, /^npm-lock-check failed:/, JSON.stringify(result));
        return true;
      },
    );
    await fs.access(marker); // the fake npm-lock-check really ran; without the fix, ship() never gets integratedFiles and skips it entirely, instead failing later at a real `git push` with an unrelated reason.
  });
});

// --- L167: per-root gotchas file --------------------------------------------------------------

describe('L167: .swarm/gotchas.md reaches every job prompt and env --print', () => {
  test('loadGotchas: the root\'s own file wins; a linked worktree with none falls back to its main root\'s file; missing is null', async t => {
    const root = await repo(t);
    assert.deepEqual(await loadGotchas(root), { text: null, source: null });
    await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
    await fs.writeFile(path.join(root, GOTCHAS_FILE), '- Windows refuses a private file created under a raw pytest tmp_path.\n');
    const own = await loadGotchas(root);
    assert.equal(own.source, path.join(root, GOTCHAS_FILE));
    assert.match(own.text, /pytest tmp_path/);

    const linked = path.join(await tmp(t, 'swarm-167-linked-'), 'wt');
    await git(root, ['worktree', 'add', '-q', '--detach', linked, 'HEAD']);
    const fallback = await loadGotchas(linked);
    assert.equal(fallback.source, path.join(root, GOTCHAS_FILE));
    assert.match(fallback.text, /pytest tmp_path/);
  });

  test('gotchasPromptBlock is appended to a codex and a shell job prompt; empty with no file', () => {
    assert.equal(gotchasPromptBlock(null), '');
    assert.equal(gotchasPromptBlock('  \n '), '');
    const block = gotchasPromptBlock('- a real platform gotcha\n');
    assert.match(block, /Known platform gotchas for this project:/);
    assert.match(block, /a real platform gotcha/);
    const job = { id: 'j', agent: 'codex', model: 'm', prompt: 'Do it.', context: [], outputs: ['out.txt'] };
    assert.ok(codexMessage(job, { gotchas: block }).includes('a real platform gotcha'));
    assert.equal(codexMessage(job).includes('Known platform gotchas'), false, 'no gotchas param: no change to the prompt');
    assert.ok(shellMessage(job, { files: [], gotchas: block }).includes('a real platform gotcha'));
    assert.equal(shellMessage(job, { files: [] }).includes('Known platform gotchas'), false);
  });

  test('a real run appends the project\'s own gotchas.md to a plain claude job\'s saved prompt', async t => {
    const root = await repo(t);
    await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
    await fs.writeFile(path.join(root, GOTCHAS_FILE), '- A real, project-specific platform gotcha.\n');
    const job = plainJob();
    const state = await runManifest(root, { version: 1, jobs: [job] }, { spawnImpl: fake(`fs.writeFileSync('input.txt','updated'); ${doneResult}`) });
    assert.equal(state.status, 'complete', JSON.stringify(state.jobs[0]));
    const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, job.id, 'message.txt'), 'utf8');
    assert.match(message, /A real, project-specific platform gotcha\./);
  });

  test('env --print includes the gotchas block (from its source); the plain env JSON carries it too', async t => {
    const root = await repo(t);
    await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
    await fs.writeFile(path.join(root, GOTCHAS_FILE), '- Prints in env --print too.\n');
    const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'env', '--print']);
    assert.match(stdout, /Known platform gotchas for this project \(from .*gotchas\.md\):/);
    assert.match(stdout, /Prints in env --print too\./);
    const { stdout: jsonOut } = await execFileAsync(process.execPath, [CLI, '--root', root, 'env']);
    const parsed = JSON.parse(jsonOut);
    assert.match(parsed.gotchas.text, /Prints in env --print too\./);
    assert.equal(parsed.gotchas.source, path.join(root, GOTCHAS_FILE));
    // envPrintText itself: no gotchas passed at all still renders exactly as before (lesson #160/#163 shape unchanged).
    assert.equal(envPrintText({ env: {}, source: null }).includes('Known platform gotchas'), false);
  });

  test('validate warns windows-ci-no-gotchas for a repo with a Windows CI workflow and no gotchas file; quiet once one exists or CI never mentions Windows', async t => {
    const root = await repo(t);
    await fs.mkdir(path.join(root, '.github/workflows'), { recursive: true });
    await fs.writeFile(path.join(root, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    runs-on: windows-latest\n');
    const manifest = { version: 1, jobs: [plainJob()] };
    const withoutGotchas = await validateProject(root, manifest);
    assert.ok(withoutGotchas.warnings.some(w => w.code === 'windows-ci-no-gotchas'), JSON.stringify(withoutGotchas.warnings));

    await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
    await fs.writeFile(path.join(root, GOTCHAS_FILE), '- covers the Windows case\n');
    const withGotchas = await validateProject(root, manifest);
    assert.equal(withGotchas.warnings.some(w => w.code === 'windows-ci-no-gotchas'), false);

    assert.deepEqual(await windowsCiGotchasWarnings(await tmp(t, 'swarm-167-nowin-')), []);
  });
});

// --- L168: an outside agent (not a sandboxed shell worker) gets the stash-refusing git too -------

describe('L168: env / env --print materializes a stable per-root git-stash guard for outside agents', () => {
  test('env --print carries a PATH export for the materialized wrapper; the wrapper refuses stash and passes everything else to the real git', async t => {
    const root = await repo(t);
    const wrapperDir = path.join(root, GIT_GUARD_DIR);
    const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'env', '--print']);
    assert.ok(stdout.includes(`export PATH='${wrapperDir}':"$PATH"`), stdout);

    const guard = path.join(wrapperDir, 'git');
    for (const args of [['stash'], ['stash', 'pop']]) {
      await assert.rejects(execFileAsync(guard, args, { cwd: root }), error => {
        assert.notEqual(error.code, 0, args.join(' '));
        assert.match(error.stderr, /git stash is not allowed here/);
        return true;
      });
    }
    const version = await execFileAsync(guard, ['--version'], { cwd: root });
    assert.match(version.stdout, /^git version/);
    await execFileAsync(guard, ['status'], { cwd: root }); // does not reject: a real git status runs

    // The plain (non --print) `env` JSON also materializes the wrapper and names its path.
    const { stdout: jsonOut } = await execFileAsync(process.execPath, [CLI, '--root', root, 'env']);
    assert.equal(JSON.parse(jsonOut).wrapperPath, wrapperDir);
  });

  test('materializeGitGuard resolves the real git even when the wrapper dir is already first on PATH, so the wrapper never execs itself', async t => {
    const root = await repo(t);
    const wrapperDir = await materializeGitGuard(root, { parentEnv: process.env });
    assert.equal(wrapperDir, path.join(root, GIT_GUARD_DIR));
    const realGitLine = script => script.match(/^exec '(.+)' "\$@"$/m);

    const first = realGitLine(await fs.readFile(path.join(wrapperDir, 'git'), 'utf8'));
    assert.ok(first, 'wrapper script must exec a real git');
    assert.notEqual(path.resolve(first[1]), path.join(wrapperDir, 'git'));

    // Simulate an outside agent that already pasted the block: the wrapper dir is now first on
    // PATH for this second run. Without excluding it, findRealGit would "discover" the wrapper
    // itself as git and the script would exec itself forever instead of the real git.
    const pastedPath = `${wrapperDir}${path.delimiter}${process.env.PATH}`;
    await materializeGitGuard(root, { parentEnv: { ...process.env, PATH: pastedPath } });
    const second = realGitLine(await fs.readFile(path.join(wrapperDir, 'git'), 'utf8'));
    assert.ok(second, 'wrapper script must still exec a real git');
    assert.notEqual(path.resolve(second[1]), path.join(wrapperDir, 'git'));
    assert.equal(second[1], first[1]);

    await assert.rejects(execFileAsync(path.join(wrapperDir, 'git'), ['stash'], { cwd: root }), error => {
      assert.match(error.stderr, /git stash is not allowed here/);
      return true;
    });
  });
});
