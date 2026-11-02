// SPDX-License-Identifier: Apache-2.0
// Swarm batch V: field lessons 263r, 268-272 (see .swarm-manifests/contract-v.md).
// #271: a dropped write (an edit outside job.outputs) is saved the moment it is detected;
// `integrate` refuses unless `--accept-dropped`/`--salvage-dropped` is passed.
// #269: a worker's own `deviations` array may hold a plain string, not just a
// `{contract, did, why}` object; every place that renders or records one keeps its real text.
// #270: a trailing `:line`/`:a-b` suffix on a self-reported path is the same path; no false
// dropped-write warning.
// #272: `ship` refuses (`inspect` warns) when a test file's own added lines reference a path git
// would refuse to track.
// #268: `run` auto-accepts a red base when every failing location is covered by this run's own
// outputs; `inspect` runs a collect-only preflight against a proposed test file.
// #263r: a shell job's scratch directory (TMPDIR/HOME) lives under the swarm install root, never
// the OS tmp dir.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { ship } from '../tools/ship.mjs';
import { runManifest, integrateRun, inspectResults, inspectRun, normalizeChangedEntry } from '../tools/swarm.mjs';
import { createShellScratchDir, shellProfile } from '../tools/claude-shell.mjs';

// A handful of sandboxed CI/dev environments give a per-session OS tmp dir whose own realpath
// resolution reaches outside anywhere this test is allowed to read (or, worse, resolves back
// inside this very checkout); fixture roots live under the repo's own gitignored scratch dir
// instead of `os.tmpdir()` so they behave the same everywhere this suite runs.
const TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp-test-v');
async function mkTemp(prefix) {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(TMP_ROOT, prefix));
}

async function fixture(t) {
  const root = await mkTemp('field-lessons-v-');
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
function routedSpawn(map) {
  return (command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${map[command] ?? map.default}`], options);
}
const resultLine = result => `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify(result))}}));`;
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;
const noWrites = fake(done);

// --- #271: dropped writes saved; integrate refuses unless --accept-dropped/--salvage-dropped ----

async function completedRunWithDroppedWrite(t, droppedFile, droppedBytes) {
  const root = await fixture(t);
  const state = await runManifest(root, manifest([job()]), { spawnImpl: noWrites });
  const statePath = path.join(root, '.swarm/runs', state.id, 'state.json');
  const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
  saved.jobs[0].droppedWrites = [droppedFile];
  await fs.writeFile(statePath, JSON.stringify(saved));
  const droppedPath = path.join(root, '.swarm/runs', state.id, 'dropped', droppedFile);
  await fs.mkdir(path.dirname(droppedPath), { recursive: true });
  await fs.writeFile(droppedPath, droppedBytes);
  return { root, id: state.id };
}

describe('#271: a dropped write is saved the moment it is detected; integrate gates on it', () => {
  test('(a) integrate with no flags refuses, naming the dropped path, before any file is written', async t => {
    const { root, id } = await completedRunWithDroppedWrite(t, 'src/x.js', 'dropped bytes');
    await assert.rejects(() => integrateRun(root, id), /dropped-writes: writer: src\/x\.js/);
    assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
  });

  test('(b) --accept-dropped integrates without applying the dropped path', async t => {
    const { root, id } = await completedRunWithDroppedWrite(t, 'src/x.js', 'dropped bytes');
    const result = await integrateRun(root, id, { acceptDropped: true });
    assert.equal(result.status, 'integrated');
    await assert.rejects(fs.access(path.join(root, 'src/x.js')));
  });

  test('(c) --salvage-dropped integrates and applies the dropped path with its saved bytes', async t => {
    const { root, id } = await completedRunWithDroppedWrite(t, 'src/x.js', 'dropped bytes');
    const result = await integrateRun(root, id, { salvageDropped: true });
    assert.equal(result.status, 'integrated');
    assert.equal(await fs.readFile(path.join(root, 'src/x.js'), 'utf8'), 'dropped bytes');
  });

  test('(t) a worker\'s dropped .env write is named in droppedWrites but the real repo secret is never saved to disk', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, '.env'), 'SECRET=root-value-FAKE');
    const writeEnv = fake(`fs.writeFileSync('.env', 'malicious secret attempt');${done}`);
    const state = await runManifest(root, manifest([job()]), { spawnImpl: writeEnv });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    assert.ok(state.jobs[0].droppedWrites?.includes('.env'), JSON.stringify(state.jobs[0].droppedWrites));
    const droppedDir = path.join(root, '.swarm/runs', state.id, 'dropped');
    const droppedFiles = [];
    async function walk(dir) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else droppedFiles.push(full);
      }
    }
    await walk(droppedDir);
    for (const file of droppedFiles) {
      assert.ok(!(await fs.readFile(file, 'utf8')).includes('root-value-FAKE'), file);
    }
    await assert.rejects(() => integrateRun(root, state.id), /dropped-writes/);
  });
});

// --- #269: string deviations render intact --------------------------------------------------------

describe('#269: a plain-string deviation renders as its own real text everywhere, never empty or char-indexed', () => {
  test('(d) integrate refuses, naming the string deviation intact', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()]), {
      spawnImpl: fake(resultLine({ status: 'complete', deviations: ['some/path.py'] })),
    });
    await assert.rejects(() => integrateRun(root, state.id), error => {
      assert.match(error.message, /contract-deviation: writer: some\/path\.py/);
      assert.equal(error.message.trim().endsWith('writer:'), false, error.message);
      return true;
    });
  });

  test('(e) --accept-deviation integrates and records a real object, not a char-indexed one', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()]), {
      spawnImpl: fake(resultLine({ status: 'complete', deviations: ['some/path.py'] })),
    });
    const result = await integrateRun(root, state.id, { acceptDeviation: true });
    assert.deepEqual(result.acceptedDeviations, [{ job: 'writer', contract: 'some/path.py' }]);
  });

  test('(f) inspectResults warns for every string deviation in the list', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()]), {
      spawnImpl: fake(resultLine({ status: 'complete', deviations: ['a/b.py', 'c/d.py'] })),
    });
    const results = await inspectResults(root, state.id);
    assert.ok(results.warnings.includes('contract-deviation: writer: a/b.py'), JSON.stringify(results.warnings));
    assert.ok(results.warnings.includes('contract-deviation: writer: c/d.py'), JSON.stringify(results.warnings));
  });
});

// --- #270: a :line/:a-b suffix is the same path -----------------------------------------------------

describe('#270: a trailing :line or :a-b suffix on a self-reported path is the same path', () => {
  test('(g) normalizeChangedEntry strips a trailing :line suffix', () => {
    assert.equal(normalizeChangedEntry('src/x.py:1009'), 'src/x.py');
  });

  test('(h) normalizeChangedEntry strips a trailing :a-b range suffix', () => {
    assert.equal(normalizeChangedEntry('tests/t.py:40-45'), 'tests/t.py');
  });

  test('(i) inspectResults never warns dropped write for a declared output only differing by a line suffix', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job({ context: ['input.txt'], outputs: ['src/x.py', 'tests/t.py'] })]), {
      spawnImpl: fake(resultLine({ status: 'complete', changed: ['src/x.py:1009', 'tests/t.py:40-45'] })),
    });
    const results = await inspectResults(root, state.id);
    assert.ok(!results.warnings.some(w => w.startsWith('dropped write')), JSON.stringify(results.warnings));
  });
});

// --- #272: a changed test file naming a git-ignored path ---------------------------------------------

function gitAt(dir) {
  return (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}
async function realRepo(t) {
  const dir = await mkTemp('field-lessons-v-repo-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = gitAt(dir);
  git('init', '-q');
  git('checkout', '-q', '-b', 'main');
  git('config', 'user.email', 'worker@example.com');
  git('config', 'user.name', 'Worker');
  await fs.writeFile(path.join(dir, 'base.txt'), 'base\n');
  git('add', 'base.txt');
  git('commit', '-q', '-m', 'base commit');
  const baseSha = git('rev-parse', 'HEAD').trim();
  git('update-ref', 'refs/remotes/origin/main', baseSha);
  return { dir, git };
}
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });
function fakeShipExecWithIgnore({ ignoredPaths = [] } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'git' && args[0] === 'check-ignore') return ignoredPaths.includes(args.at(-1)) ? ok('') : fail('');
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'merge-base') return ok('');
    if (file === 'git' && args[0] === 'diff' && args[1] === '--name-only') return ok('');
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'rev-parse') return ok('sha-fixture\n');
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'repo' && args[1] === 'view') return ok(JSON.stringify({ visibility: 'PUBLIC' }));
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}
async function writePayload(dir, overrides = {}) {
  const file = path.join(dir, 'pr.json');
  await fs.writeFile(file, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: 'body text', ...overrides }));
  return file;
}
async function shipRepo(dir, options = {}) {
  return ship({
    root: dir, repo: 'acme/widgets', payloadPath: await writePayload(dir),
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => 0, merge: false,
    ...options,
  });
}

describe('#272: ship refuses (inspect warns) a changed test file naming a git-ignored path', () => {
  test('(j) a test file referencing a git-ignored fixture path refuses before any push', async t => {
    const { dir, git } = await realRepo(t);
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tests/test_x.py'), 'FIXTURE = ".swarm-manifests/fixture.json"\n');
    git('add', 'tests/test_x.py');
    git('commit', '-q', '-m', 'add test');
    // Lesson 331: only an ignored path that exists on disk is a fixture; create it here.
    await fs.mkdir(path.join(dir, '.swarm-manifests'), { recursive: true });
    await fs.writeFile(path.join(dir, '.swarm-manifests/fixture.json'), '{}\n');
    const { exec, calls } = fakeShipExecWithIgnore({ ignoredPaths: ['.swarm-manifests/fixture.json'] });
    const result = await shipRepo(dir, { exec, integratedFiles: ['tests/test_x.py'] });
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.match(result.reason, /^test-reads-git-ignored-path:/);
    assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
  });

  test('(k) a test file referencing a tracked fixture path proceeds past this guard', async t => {
    const { dir, git } = await realRepo(t);
    await fs.mkdir(path.join(dir, 'tests'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tests/test_x.py'), 'FIXTURE = "tests/fixtures/fixture.json"\n');
    git('add', 'tests/test_x.py');
    git('commit', '-q', '-m', 'add test');
    const { exec } = fakeShipExecWithIgnore({ ignoredPaths: [] });
    const result = await shipRepo(dir, { exec, integratedFiles: ['tests/test_x.py'] });
    assert.notEqual(result.code, 'test-reads-git-ignored-path');
    assert.equal(result.status, 'ready', JSON.stringify(result));
  });

  test('(l) inspectRun warns git-ignored-fixture for a job\'s own proposed test file', async t => {
    const root = await fixture(t);
    const script = `fs.mkdirSync('tests',{recursive:true});fs.writeFileSync('tests/test_x.py','FIXTURE = ".swarm-manifests/fixture.json"\\n');${done}`;
    const state = await runManifest(root, manifest([job({ outputs: ['tests/test_x.py'] })]), { spawnImpl: fake(script) });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    // Lesson 331: only an ignored path that exists on disk is a fixture; create it here.
    await fs.mkdir(path.join(root, '.swarm-manifests'), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm-manifests/fixture.json'), '{}\n');
    const exec = async (file, args) => {
      if (file === 'git' && args[0] === 'check-ignore') return ok('');
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const results = await inspectRun(root, state.id, { exec, programOnPathImpl: async () => false });
    assert.ok(results.warnings.includes('git-ignored-fixture: writer: tests/test_x.py -> .swarm-manifests/fixture.json'), JSON.stringify(results.warnings));
  });
});

// --- #268: run auto-accepts a covered red base; inspect runs a collect-only preflight --------------

const FAILING_CHECK_SCRIPT = `process.stdout.write('FAILED tests/test_t61b_fixb.py::test_x\\n');process.exitCode=1;`;

describe('#268: a covered red base auto-accepts with a warning; inspect collect-only-checks a proposed test file', () => {
  test('(m) every failing check location covered by this run\'s own outputs proceeds, warning red-base-auto-accepted', async t => {
    const root = await fixture(t);
    const spawnImpl = routedSpawn({ 'fake-check': FAILING_CHECK_SCRIPT, default: done });
    const state = await runManifest(root, manifest([job({ outputs: ['tests/test_t61b_fixb.py'] })], { checks: [{ name: 'ci', argv: ['fake-check'] }] }), {
      spawnImpl, checkBase: true, baseChecks: { baseSha: 'fixture-sha-m' },
    });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    assert.ok(state.warnings.some(w => w.startsWith('red-base-auto-accepted:') && w.includes('tests/test_t61b_fixb.py')), JSON.stringify(state.warnings));
  });

  test('(n) a failing location outside this run\'s own outputs still refuses', async t => {
    const root = await fixture(t);
    const spawnImpl = routedSpawn({ 'fake-check': FAILING_CHECK_SCRIPT, default: done });
    await assert.rejects(
      () => runManifest(root, manifest([job({ outputs: ['other.txt'] })], { checks: [{ name: 'ci', argv: ['fake-check'] }] }), {
        spawnImpl, checkBase: true, baseChecks: { baseSha: 'fixture-sha-n' },
      }),
      /Refusing: base is red/,
    );
  });

  test('(o) inspectRun warns collect-only-failed for a proposed test file with a bad import', async t => {
    const root = await fixture(t);
    const script = `fs.mkdirSync('tests',{recursive:true});fs.writeFileSync('tests/x.test.mjs','this is not valid js (((');${done}`;
    const state = await runManifest(root, manifest([job({ outputs: ['tests/x.test.mjs'] })]), { spawnImpl: fake(script) });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    const results = await inspectRun(root, state.id);
    assert.ok(results.warnings.some(w => w.startsWith('collect-only-failed: writer: tests/x.test.mjs:')), JSON.stringify(results.warnings));
  });

  test('(p) inspectRun skips a python collect-only check, naming why, and never spawns pytest', async t => {
    const root = await fixture(t);
    const script = `fs.mkdirSync('tests',{recursive:true});fs.writeFileSync('tests/test_y.py','def test_ok():\\n    assert True\\n');${done}`;
    const state = await runManifest(root, manifest([job({ outputs: ['tests/test_y.py'] })]), { spawnImpl: fake(script) });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    const guardSpawn = command => { assert.notEqual(command, 'python', 'pytest must never be spawned'); return spawn(process.execPath, ['-e', '0']); };
    const results = await inspectRun(root, state.id, { programOnPathImpl: async () => false, spawnImpl: guardSpawn });
    assert.ok(results.warnings.includes('collect-only-skipped: writer: pytest not on PATH'), JSON.stringify(results.warnings));
  });
});

// --- #263r: a shell job's scratch dir lives under the swarm install root, never the OS tmp dir ------

describe('#263r: a shell job\'s scratch dir bases itself on the swarm install root, never the OS tmp dir', () => {
  test('(q) createShellScratchDir bases the scratch dir on SWARM_INSTALL_ROOT, not the (faked) OS tmp dir', async t => {
    const fakeInstallRoot = await mkTemp('field-lessons-v-install-');
    t.after(() => fs.rm(fakeInstallRoot, { recursive: true, force: true }));
    const scratch = await createShellScratchDir(
      { runId: 'r1', jobId: 'j1' },
      { tmpdir: () => '/should-not-be-used', realpath: async value => value, access: async () => { throw Error('ENOENT'); }, env: { SWARM_INSTALL_ROOT: fakeInstallRoot } },
    );
    t.after(() => fs.rm(scratch.scratchDir, { recursive: true, force: true }));
    assert.equal(scratch.scratchDir.startsWith(fakeInstallRoot), true, scratch.scratchDir);
    assert.equal(scratch.scratchDir.includes('should-not-be-used'), false);
    assert.equal(scratch.tmp, path.join(scratch.scratchDir, 'tmp'));
    assert.equal(scratch.home, path.join(scratch.scratchDir, 'home'));
  });

  test('(r) the original upward .git scan is kept (layered, not replaced) over the new install-root base', async t => {
    const fakeInstallRoot = await mkTemp('field-lessons-v-install2-');
    t.after(() => fs.rm(fakeInstallRoot, { recursive: true, force: true }));
    // The OS tmp dir itself still resolves inside a repo — exactly the scenario this lesson
    // reopens — so the original scan still refuses on it, even though the scratch dir this
    // function actually builds is never placed there at all (mutant reverting to the old
    // tmpdir-based base would build the scratch dir at this exact refused location instead).
    const repoLikeTmp = '/fake/os-tmp-inside-a-repo';
    const access = async file => { if (file === `${repoLikeTmp}/.git`) return; throw Error('ENOENT'); };
    await assert.rejects(
      createShellScratchDir({ runId: 'r2', jobId: 'j2' }, { tmpdir: () => repoLikeTmp, realpath: async value => value, access, env: { SWARM_INSTALL_ROOT: fakeInstallRoot } }),
      /scratch-inside-repo/,
    );
    // With a clean OS tmp dir, the real returned scratch dir (a plain directory this test itself
    // created, never a checkout) has no `.git` of its own, and a real `git rev-parse --git-dir` run
    // from inside it never reports one belonging to this scratch dir.
    const scratch = await createShellScratchDir({ runId: 'r3', jobId: 'j3' }, { tmpdir: () => '/no/repo/here', realpath: async value => value, access: async () => { throw Error('ENOENT'); }, env: { SWARM_INSTALL_ROOT: fakeInstallRoot } });
    t.after(() => fs.rm(scratch.scratchDir, { recursive: true, force: true }));
    await assert.rejects(fs.access(path.join(scratch.scratchDir, '.git')));
  });

  test('(s) shellProfile grants the scratch dir a write allow, not just a read one', () => {
    const scratchDir = '/Users/example/.project-swarm/tmp/r/j';
    const profile = shellProfile({ home: '/Users/example', worktree: '/Users/example/repo/.swarm/runs/r/worktrees/j', commonDir: '/Users/example/repo/.git', shellDir: '/Users/example/repo/.swarm/runs/r/j/shell', proxyPort: 1, scratchDir });
    assert.match(profile, /\(allow file-write\* [^\n]*\(subpath "\/Users\/example\/\.project-swarm\/tmp\/r\/j"\)/);
  });
});
