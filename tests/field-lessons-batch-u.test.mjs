// SPDX-License-Identifier: Apache-2.0
// Swarm batch U: field lessons 256-261 (see .swarm-manifests/contract-u.md).
// #258: `ship` scans every commit it would publish, not just the cumulative diff, for a configured
// private term in that commit's own added lines or message.
// #256: a worker result may report `deviations`; `integrate` refuses a run carrying a non-empty
// list unless `--accept-deviation`.
// #257: the shared contract template requires one test that forces a new platform-bound
// dependency's backend to fail on a startup path.
// #259: a held PR (isHeld(body)) gets a fixed three-field summary (`reviewNote`).
// #260: `inspect` warns when a job's own "passed" checksRun entry is contradicted by a nonzero
// fail count in the same result.
// #261: `check-path-missing` only warns about a program the check's own argv actually invokes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { ship } from '../tools/ship.mjs';
import { runManifest, integrateRun, inspectResults, checkPathMissingWarnings } from '../tools/swarm.mjs';

const FAKE_SHELL_BIN = '/opt/fake-claude/bin/claude.exe';
const shellHooksWithScratch = createScratchDir => ({ access: async () => {}, resolveClaude: async () => FAKE_SHELL_BIN, scanListeningPorts: async () => [], createScratchDir });
function fakeSandboxRun(script, seen = []) {
  return (command, args, options) => {
    seen.push({ command, args, options });
    return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
  };
}
const shellWorked = `fs.writeFileSync('output.txt','proposed');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-u-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const resultLine = result => `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify(result))}}));`;
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;
const noWrites = fake(done);

// --- #258: per-commit private-names scan in ship ------------------------------------------------

function gitAt(dir) {
  return (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

async function realRepo(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-u-repo-'));
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
  await fs.mkdir(path.join(dir, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(dir, 'coordination/private-names.txt'), 'acmecorp\n');
  return { dir, git };
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });

// A fake exec answering by which git/gh command was called (never by call order): every real git
// operation (log/diff for the per-commit scan itself, plus every commit made in `realRepo`) still
// runs for real against the repo on disk, through the separate `commitScanExec`/`authorEmailExec`
// seams ship() already uses for exactly this reason (field lesson #213's author-email guard);
// this fake only stubs the push/gh layer plus the small set of `exec`-driven git calls ship() also
// makes along the way.
function fakeShipExec({ visibility = 'PUBLIC' } = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'merge-base') return ok('');
    if (file === 'git' && args[0] === 'diff' && args[1] === '--name-only') return ok('');
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'rev-parse') return ok('sha-fixture\n');
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'repo' && args[1] === 'view') return ok(JSON.stringify({ visibility }));
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

describe('#258: ship scans every commit it would publish for a private term, not just the cumulative diff', () => {
  test('(a) a term added in commit 1 and removed in commit 2 refuses, naming commit 1, before any push', async t => {
    const { dir, git } = await realRepo(t);
    await fs.writeFile(path.join(dir, 'notes.txt'), 'the acmecorp deal closes friday\n');
    git('add', 'notes.txt');
    git('commit', '-q', '-m', 'add notes');
    const firstSha = git('rev-parse', 'HEAD').trim().slice(0, 7);
    await fs.writeFile(path.join(dir, 'notes.txt'), 'nothing to see here\n');
    git('add', 'notes.txt');
    git('commit', '-q', '-m', 'remove notes');
    const { exec, calls } = fakeShipExec();
    const result = await shipRepo(dir, { exec });
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.equal(result.code, 'private-term-in-commit');
    assert.match(result.reason, new RegExp(`^private-term-in-commit: ${firstSha}`));
    assert.equal(result.reason.includes('acmecorp'), false, result.reason);
    assert.ok(!calls.some(c => c.file === 'git' && c.args[0] === 'push'));
  });

  test('(b) a clean multi-commit branch with no private term anywhere proceeds to push', async t => {
    const { dir, git } = await realRepo(t);
    for (const message of ['first change', 'second change', 'third change']) {
      await fs.writeFile(path.join(dir, 'notes.txt'), `${message}\n`);
      git('add', 'notes.txt');
      git('commit', '-q', '-m', message);
    }
    const { exec } = fakeShipExec();
    const result = await shipRepo(dir, { exec });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.privateNames, { checked: true, hits: 0 });
  });

  test('(c) a term only in a commit message (no file changes) refuses, naming that commit', async t => {
    const { dir, git } = await realRepo(t);
    git('commit', '-q', '--allow-empty', '-m', 'mentions acmecorp in passing');
    const sha = git('rev-parse', 'HEAD').trim().slice(0, 7);
    const { exec } = fakeShipExec();
    const result = await shipRepo(dir, { exec });
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.match(result.reason, new RegExp(`^private-term-in-commit: ${sha}`));
  });
});

// --- #256: worker result `deviations`; integrate refuses unless --accept-deviation --------------

describe('#256: a worker\'s own reported contract deviations gate integrate unless accepted', () => {
  test('(d) a resultFile-free result with one deviation refuses integrate with contract-deviation, before any file is written', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()]), {
      spawnImpl: fake(resultLine({ status: 'complete', deviations: [{ contract: 'some-path', did: 'used Y instead', why: 'X was denied' }] })),
    });
    await assert.rejects(() => integrateRun(root, state.id), /contract-deviation: writer: some-path/);
    assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
  });

  test('(e) the same result with --accept-deviation integrates and records the acceptance', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()]), {
      spawnImpl: fake(resultLine({ status: 'complete', deviations: [{ contract: 'some-path', did: 'used Y instead', why: 'X was denied' }] })),
    });
    const result = await integrateRun(root, state.id, { acceptDeviation: true });
    assert.equal(result.status, 'integrated');
    assert.deepEqual(result.acceptedDeviations, [{ job: 'writer', contract: 'some-path', did: 'used Y instead', why: 'X was denied' }]);
    const persisted = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'state.json'), 'utf8'));
    assert.deepEqual(persisted.acceptedDeviations, result.acceptedDeviations);
  });

  test('(f) the job prompt boilerplate tells a worker to report an unmet contract MUST in deviations, never substitute it', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()]), { spawnImpl: noWrites });
    const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer', 'message.txt'), 'utf8');
    assert.match(message, /status "blocked" naming the denied path, or report it in deviations/);
    assert.match(message, /never silently substitute a design/);
  });
});

// --- #259: ship's reviewNote field for a held PR --------------------------------------------------

function shipMakeExec(script) {
  let index = 0;
  const exec = async (file, args) => {
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'merge-base') return fail('no package');
    if (index >= script.length) throw new Error(`Unexpected exec call #${index + 1}: ${file} ${args.join(' ')}`);
    const entry = script[index++];
    return typeof entry === 'function' ? entry(file, args) : entry;
  };
  return exec;
}
const clean = () => ok('');
const rev = sha => ok(`${sha}\n`);
const prJson = () => JSON.stringify({ number: 7, html_url: 'https://example.com/pr/7' });
const rollupView = () => JSON.stringify({ state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
function greenScript() {
  return [clean(), rev('sha123'), clean(), ok('[]'), ok(prJson()), ok(rollupView())];
}

async function shipWithBody(t, body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-u-held-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body }));
  const exec = shipMakeExec(greenScript());
  const originalWrite = process.stderr.write;
  const chunks = [];
  process.stderr.write = chunk => { chunks.push(String(chunk)); return true; };
  let result;
  try {
    result = await ship({
      root, repo: 'acme/widgets', payloadPath, exec,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      sleep: async () => {}, now: () => 0, merge: false,
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  return { result, stderr: chunks.join('') };
}

describe('#259: a held PR gets a fixed three-field summary (reviewNote)', () => {
  test('(h) a PR whose body starts with **needs review** gains reviewNote and prints it to stderr', async t => {
    const body = [
      '**needs review**',
      '## Summary',
      '- Item 1',
      '- Item 2',
      '## Could break',
      'This breaks X',
      '## Mutation check',
      'test_X killed',
    ].join('\n');
    const { result, stderr } = await shipWithBody(t, body);
    assert.equal(result.status, 'held', JSON.stringify(result));
    assert.deepEqual(result.reviewNote, {
      changed: '- Item 1\n- Item 2',
      couldBreak: 'This breaks X',
      proof: 'test_X killed (https://example.com/pr/7)',
    });
    assert.match(stderr, /Changed: - Item 1\n- Item 2/);
    assert.match(stderr, /Could break: This breaks X/);
    assert.match(stderr, /Proof: test_X killed \(https:\/\/example\.com\/pr\/7\)/);
  });

  test('(i) a normal PR body (no held marker) has no reviewNote field', async t => {
    const body = '## Summary\ndone\n## Mutation check\nall good';
    const { result } = await shipWithBody(t, body);
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal('reviewNote' in result, false);
  });

  test('(j) a held body with no Could break section gets the literal FILL IN placeholder', async t => {
    const body = [
      '**needs review**',
      '## Summary',
      '- Item 1',
      '- Item 2',
      '## Mutation check',
      'test_Y killed',
    ].join('\n');
    const { result } = await shipWithBody(t, body);
    assert.equal(result.status, 'held', JSON.stringify(result));
    assert.equal(result.reviewNote.couldBreak, 'FILL IN before sending');
  });
});

// --- #260: inspect warns self-report-contradiction ------------------------------------------------

describe('#260: inspect warns self-report-contradiction when a "passed" checksRun entry is contradicted by the result\'s own fail count', () => {
  test('(k) a result naming "558 fail" alongside a passed npm test entry warns', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()]), {
      spawnImpl: fake(resultLine({ status: 'complete', checksRun: [{ name: 'npm test', status: 'passed' }], note: '505 pass/558 fail' })),
    });
    const results = await inspectResults(root, state.id);
    assert.ok(results.warnings.includes('self-report-contradiction: writer: npm test'), JSON.stringify(results.warnings));
  });

  test('(l) a result naming "0 fail" alongside the same passed entry does not warn', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()]), {
      spawnImpl: fake(resultLine({ status: 'complete', checksRun: [{ name: 'npm test', status: 'passed' }], note: '1067 pass/0 fail' })),
    });
    const results = await inspectResults(root, state.id);
    assert.ok(!results.warnings.some(w => w.startsWith('self-report-contradiction')), JSON.stringify(results.warnings));
  });
});

// --- #261: check-path-missing only for a program the check's own argv actually invokes ------------

describe('#261: check-path-missing warns only about the program a check\'s own argv actually invokes', () => {
  test('(m) env PATH=... uv run pytest -q: no warning for gh/node/npm', async t => {
    const wideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-u-wide-'));
    t.after(() => fs.rm(wideDir, { recursive: true, force: true }));
    for (const program of ['gh', 'node', 'npm']) await fs.writeFile(path.join(wideDir, program), '');
    const narrowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-u-narrow-'));
    t.after(() => fs.rm(narrowDir, { recursive: true, force: true }));
    const check = { name: 'ci-check', argv: ['env', `PATH=${narrowDir}`, 'uv', 'run', 'pytest', '-q'] };
    const warnings = await checkPathMissingWarnings({ checks: [check] }, { env: { PATH: wideDir } });
    assert.ok(!warnings.some(w => ['gh', 'node', 'npm'].includes(w.prog)), JSON.stringify(warnings));
  });

  test('(n) env PATH=... npm test on a machine PATH that has node/npm: warning names npm or node', async t => {
    const wideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-u-wide2-'));
    t.after(() => fs.rm(wideDir, { recursive: true, force: true }));
    for (const program of ['npm', 'node']) await fs.writeFile(path.join(wideDir, program), '');
    const narrowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-u-narrow2-'));
    t.after(() => fs.rm(narrowDir, { recursive: true, force: true }));
    const check = { name: 'ci-check', argv: ['env', `PATH=${narrowDir}`, 'npm', 'test'] };
    const warnings = await checkPathMissingWarnings({ checks: [check] }, { env: { PATH: wideDir } });
    assert.ok(warnings.some(w => w.prog === 'npm' || w.prog === 'node'), JSON.stringify(warnings));
  });
});

// --- #257: the shared contract template requires a platform-backend-failure test ------------------

describe('#257: templates/coordination/CONTRACT.md requires a platform-backend-failure test for a new platform-bound startup dependency', () => {
  test('(g) the Tests section states the requirement', async () => {
    const text = await fs.readFile(new URL('../templates/coordination/CONTRACT.md', import.meta.url), 'utf8');
    assert.match(
      text,
      /For any new platform-bound dependency \(keychain, OS API\) on a startup path, one test forces the platform backend to fail and proves startup still succeeds; construct it lazily via a factory\./,
    );
  });
});

// --- #263: a shell job's TMPDIR/TMP/TEMP point at its own scratch directory ------------------------

describe('#263: a shell job\'s launch env has TMPDIR/TMP/TEMP under its own scratch directory; a non-shell job is unaffected', () => {
  test('(o) a shell job\'s env has TMPDIR/TMP/TEMP under its own scratch dir', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-u-shell-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const git = gitAt(root);
    git('init', '-q');
    await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
    await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
    await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const seen = [];
    const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-u-scratch-'));
    t.after(() => fs.rm(scratchRoot, { recursive: true, force: true }));
    const fakeScratch = { scratchDir: scratchRoot, tmp: path.join(scratchRoot, 'tmp'), home: path.join(scratchRoot, 'home') };
    const shellJob = { id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000 };
    const state = await runManifest(root, manifest([shellJob]), {
      platform: 'darwin',
      spawnImpl: fakeSandboxRun(shellWorked, seen),
      env: { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: 'sk-FAKE-0000' },
      keyExec: async () => { throw new Error('must not read the keychain'); },
      shellHooks: shellHooksWithScratch(async () => fakeScratch),
    });
    const launch = seen.find(call => call.args[2] === FAKE_SHELL_BIN);
    assert.ok(launch, `the claude launch was recorded (run ${state.status}: ${state.jobs[0].error ?? ''})`);
    assert.equal(launch.options.env.TMPDIR, fakeScratch.tmp);
    assert.equal(launch.options.env.TMP, fakeScratch.tmp);
    assert.equal(launch.options.env.TEMP, fakeScratch.tmp);
  });

  test('(p) a non-shell job\'s env is unchanged', async t => {
    const root = await fixture(t);
    const seen = [];
    const spawnImpl = (command, args, options) => { seen.push({ command, args, options }); return spawn(process.execPath, ['-e', `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}))`], options); };
    await runManifest(root, manifest([job()]), { spawnImpl });
    assert.equal(seen[0].options.env, process.env);
  });
});
