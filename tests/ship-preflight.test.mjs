// SPDX-License-Identifier: Apache-2.0
// E2: `ship --preflight` collects every pre-push content guard into one pass and reports every
// failure instead of stopping at the first one; an ordinary ship still refuses on its own first
// hit (unchanged, for compatibility) but now also names every other failure in `failures`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ship, preflightReport } from '../tools/ship.mjs';
import { parseShipFlags } from '../tools/swarm.mjs';

const execFileAsync = promisify(execFile);

// A term that only ever exists in this fixture's own private-names list, never a real name.
const FAKE_TERM = 'zzfakename';

function gitAt(dir) {
  return (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

// A base repo with a private-names list, a .gitignore'd fixture directory, and `origin/main`
// pointed at the base commit (no real remote needed: every guard below only ever reads local refs).
async function realRepo(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ship-preflight-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = gitAt(dir);
  git('init', '-q');
  git('checkout', '-q', '-b', 'main');
  git('config', 'user.email', 'worker@example.com');
  git('config', 'user.name', 'Worker');
  await fs.mkdir(path.join(dir, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(dir, 'coordination/private-names.txt'), `${FAKE_TERM}\n`);
  await fs.writeFile(path.join(dir, '.gitignore'), '.swarm-manifests/\n');
  await fs.writeFile(path.join(dir, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base commit');
  const baseSha = git('rev-parse', 'HEAD').trim();
  git('update-ref', 'refs/remotes/origin/main', baseSha);
  return { dir, git };
}

// Adds three violations at once: the private term in an earlier commit's own message, the same
// term in a later commit's added test-file lines, and (in that same test file) a quoted path git
// would refuse to track.
function addViolations(dir, git) {
  git('commit', '-q', '--allow-empty', '-m', `note: ${FAKE_TERM} mentioned here`);
  git('rev-parse', 'HEAD');
  return fs.mkdir(path.join(dir, 'tests'), { recursive: true }).then(async () => {
    await fs.writeFile(path.join(dir, 'tests/test_thing.py'), [
      `# reference: ${FAKE_TERM}`,
      'def test_placeholder():',
      '    path = ".swarm-manifests/fixture.json"',
      '    assert path',
      '',
    ].join('\n'));
    git('add', 'tests/test_thing.py');
    git('commit', '-q', '-m', 'add test file');
  });
}

// Every real git call runs for real against the fixture repo (no actual remote/network anywhere);
// only `git remote`/`git push` and `gh` are stubbed, the same seam every other ship test uses.
function realGitExec(dir) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'git' && args[0] === 'remote') return { code: 0, stdout: 'https://github.com/acme/widgets.git\n', stderr: '' };
    if (file === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' };
    if (file === 'gh' && args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ visibility: 'PUBLIC' }), stderr: '' };
    if (file === 'gh') return { code: 0, stdout: '[]', stderr: '' };
    if (file === 'git') {
      try {
        const { stdout } = await execFileAsync('git', args, { cwd: opts?.cwd ?? dir });
        return { code: 0, stdout, stderr: '' };
      } catch (err) {
        return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message ?? '') };
      }
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

async function writePayload(dir) {
  const file = path.join(dir, 'pr.json');
  await fs.writeFile(file, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: 'body text' }));
  return file;
}

// ship() itself prints/sets process.exitCode for --preflight; captured and restored so a failing
// fixture in this suite never leaks a nonzero exit code into the real `node --test` run.
async function captureShip(t, options) {
  const prevExitCode = process.exitCode;
  t.after(() => { process.exitCode = prevExitCode; });
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true; };
  let result;
  try {
    result = await ship(options);
  } finally {
    process.stdout.write = originalWrite;
  }
  return { result, printed: chunks.join('').trim(), exitCode: process.exitCode };
}

test('baseline ship() refuses on the first violation only, private-name-in-diff, before any push', async t => {
  const { dir, git } = await realRepo(t);
  await addViolations(dir, git);
  const { exec, calls } = realGitExec(dir);
  const result = await ship({
    root: dir, repo: 'acme/widgets', payloadPath: await writePayload(dir),
    integratedFiles: ['tests/test_thing.py'],
    runChecks: async () => { throw new Error('checks must not run'); },
    sleep: async () => {}, now: () => 0, exec,
  });
  assert.equal(result.status, 'refused', JSON.stringify(result));
  assert.equal(result.code, 'private-name-in-diff');
  // E2: the ordinary refusal keeps its first code/reason, but now also names every other failure.
  assert.deepEqual(result.failures.map(f => f.code).sort(), ['private-name-in-diff', 'private-term-in-commit', 'test-reads-git-ignored-path']);
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
});

test('--preflight reports all three violations in one report, never touching the remote', async t => {
  const { dir, git } = await realRepo(t);
  await addViolations(dir, git);
  const { exec, calls } = realGitExec(dir);
  const { printed, exitCode } = await captureShip(t, {
    root: dir, repo: 'acme/widgets', payloadPath: await writePayload(dir),
    integratedFiles: ['tests/test_thing.py'],
    runChecks: async () => { throw new Error('checks must not run'); },
    sleep: async () => {}, now: () => 0, exec, preflight: true,
  });
  const line = JSON.parse(printed);
  assert.equal(line.status, 'preflight');
  assert.equal(line.ok, false);
  assert.deepEqual(line.failures.map(f => f.code).sort(), ['private-name-in-diff', 'private-term-in-commit', 'test-reads-git-ignored-path']);
  assert.equal(exitCode, 1);
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
});

test('--preflight on a clean branch reports ok:true and exit 0', async t => {
  const { dir } = await realRepo(t);
  const { exec, calls } = realGitExec(dir);
  const { printed, exitCode } = await captureShip(t, {
    root: dir, repo: 'acme/widgets', payloadPath: await writePayload(dir),
    integratedFiles: [],
    runChecks: async () => { throw new Error('checks must not run'); },
    sleep: async () => {}, now: () => 0, exec, preflight: true,
  });
  const line = JSON.parse(printed);
  assert.equal(line.status, 'preflight');
  assert.equal(line.ok, true);
  assert.deepEqual(line.failures, []);
  assert.equal(exitCode, 0);
  assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
});

test('--preflight never calls push even on a failing branch (push stubbed, asserted unused)', async t => {
  const { dir, git } = await realRepo(t);
  await addViolations(dir, git);
  const { exec: baseExec } = realGitExec(dir);
  let pushCalled = false;
  const exec = async (file, args, opts) => {
    if (file === 'git' && args[0] === 'push') { pushCalled = true; return { code: 0, stdout: '', stderr: '' }; }
    return baseExec(file, args, opts);
  };
  const { printed } = await captureShip(t, {
    root: dir, repo: 'acme/widgets', payloadPath: await writePayload(dir),
    integratedFiles: ['tests/test_thing.py'],
    runChecks: async () => { throw new Error('checks must not run'); },
    sleep: async () => {}, now: () => 0, exec, preflight: true,
  });
  assert.equal(JSON.parse(printed).ok, false);
  assert.equal(pushCalled, false);
});

test('preflightReport: ok:true and empty failures on a clean branch', async t => {
  const { dir } = await realRepo(t);
  const { exec } = realGitExec(dir);
  const report = await preflightReport({ root: dir, payloadBase: 'main', exec, repo: 'acme/widgets', integratedFiles: [] });
  assert.deepEqual(report, { ok: true, failures: [] });
});

// --- CLI wiring: `swarm ship --preflight` must reach ship() through the parser ------------------
// 1.39.0 shipped the option on ship() and the CHANGELOG line, but the `ship` subcommand parser
// never learned the flag, so the documented command refused with `Unknown flag: --preflight`.

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'swarm.mjs');

test('parseShipFlags accepts --preflight as a boolean and passes preflight: true through', () => {
  assert.equal(parseShipFlags(['--branch', 'feature', '--pr', 'pr.json', '--preflight']).preflight, true);
  assert.equal(parseShipFlags(['--preflight', '--branch', 'feature', '--pr', 'pr.json']).preflight, true);
  assert.ok(!('preflight' in parseShipFlags(['--branch', 'feature', '--pr', 'pr.json'])), 'absent flag leaves the option out, as every other boolean ship flag does');
});

// Fake gh: passes the binary preflight and answers the one visibility question the private-names
// guard asks; anything else is a test failure (nothing here may reach GitHub).
async function fakeGhDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ship-preflight-gh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'gh'), `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then echo "gh version 2.60.0 (2024-10-01)"; exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo '{"visibility":"PUBLIC"}'; exit 0; fi
echo "Unexpected fake gh invocation: $*" >&2
exit 1
`, { mode: 0o755 });
  return dir;
}

// A branch `feature` off the base with the three violations, an origin URL git can answer
// `remote get-url` for (never contacted), and a payload whose head names that branch.
async function cliFixture(t) {
  const { dir, git } = await realRepo(t);
  git('checkout', '-q', '-b', 'feature');
  await addViolations(dir, git);
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  await fs.writeFile(path.join(dir, 'pr.json'), JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: 'body text' }));
  const ghDir = await fakeGhDir(t);
  const env = { ...process.env, PATH: `${ghDir}${path.delimiter}${process.env.PATH ?? ''}` };
  const run = async (...shipArgs) => {
    try {
      const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', dir, 'ship', ...shipArgs], { env, cwd: dir });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.code, stdout: err.stdout ?? '' };
    }
  };
  return { dir, run };
}

test('CLI: swarm ship --preflight --branch ... is accepted by the parser and prints the preflight report', async t => {
  const { run } = await cliFixture(t);
  const { code, stdout } = await run('--preflight', '--branch', 'feature', '--repo', 'acme/widgets', '--pr', 'pr.json');
  const lines = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(!lines.some(line => line.status === 'error' && /Unknown flag/.test(line.error ?? '')), stdout);
  const report = lines.find(line => line.status === 'preflight');
  assert.ok(report, `expected a preflight report line, got: ${stdout}`);
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map(f => f.code).sort(), ['private-name-in-diff', 'private-term-in-commit', 'test-reads-git-ignored-path']);
  assert.equal(code, 1);
});

test('CLI: swarm ship --branch ... without --preflight still refuses on its first hit as before', async t => {
  const { run } = await cliFixture(t);
  const { code, stdout } = await run('--branch', 'feature', '--repo', 'acme/widgets', '--pr', 'pr.json');
  const lines = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(!lines.some(line => line.status === 'preflight'), stdout);
  const result = lines.at(-1);
  assert.equal(result.status, 'refused', stdout);
  assert.equal(result.code, 'private-name-in-diff');
  assert.equal(code, 1);
});
