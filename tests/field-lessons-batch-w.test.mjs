// SPDX-License-Identifier: Apache-2.0
// Swarm batch W: field lessons 280 (first), 262, 264-267, 273-280 (see
// .swarm-manifests/contract-w.md). Part 1 (w1a) covers 280, 262, 264-267, 274; 264 is docs-only
// (templates/coordination/CONTRACT.md) and gets no test here. Part 2 (w1b, appended below) covers
// the remaining six: 273, 275, 276, 277, 278, 279.
// #280: the shell job scratch base lives outside the install checkout, not just "the install root".
// #262: a contract or job prompt for a PUBLIC repo passes the private-names scan before dispatch.
// #265: a standing warning names a root a live rig-service checkout is actually running from.
// #266: a model/provider route change warns without a smoke check declared, and (orchestrator
// answer #2) refuses `ship` when it matches an explicit configured list with no PR body section.
// #267: a mutant per pass-bar comparison line, not one per changed file.
// #274: a real test-failure exit (with a real failure line in the tail) is a kill; a formatter
// that rewrites a mutant-target file between the pre-snapshot and the mutant run is a warning.
// #273: `ship` warns when a new test eats too much of the per-test CI timeout.
// #275: `--accept-pre-existing` verifies against the base scoped to just the failing tests.
// #276: `swarm squash` resets to the merge-base only, and refuses an unexpected staged file.
// #277: a running daily spend total, checked before every dispatch.
// #278: the sandbox's UV_CACHE_DIR points at the real, shared, read-only uv cache.
// #279: default rerun-flaky also covers a failing test whose file the PR never touches; a flake log.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import {
  runManifest, integrateRun, runMutantsCurrentTree, swarmVersion, validateProject,
  privateNamesDispatchGuard, liveServiceCheckoutWarning, modelRouteChangeNoSmokeTestWarning,
  mutantMissingForComparisonLineWarnings, squashBranch, todaySpendUsd, spendGuard,
} from '../tools/swarm.mjs';
import { createShellScratchDir, scratchRootDir, assertScratchOutsideRepo, resolveSharedUvCacheDir, shellEnvironment } from '../tools/claude-shell.mjs';
import {
  ship, modelRouteFilesMissingVerification, scopedBaseArgv, verifyPreExistingOnBase, renderChecks,
  parsePytestDurations, slowNewTestWarnings,
} from '../tools/ship.mjs';
import { loadLocalConfig } from '../tools/local-config.mjs';
import { git } from '../tools/codex-adapter.mjs';

const TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp-test-w');
async function mkTemp(prefix) {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(TMP_ROOT, prefix));
}

async function fixture(t) {
  const root = await mkTemp('field-lessons-w-');
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
// A local config file must live outside any git work tree (loadLocalConfig's own
// config-inside-repo guard); this checkout's own worktree is itself one, so a config fixture
// lives directly under the OS tmp dir instead of under this repo's own gitignored scratch dir.
async function mkConfigDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-test-w-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;

// Shared, command-matched fake exec for the full ship() integration tests below (#273/#279):
// answers by which git/gh command was called, never by call order, same shape as
// tests/field-lessons-batch-r.test.mjs's own fakeShipExec.
function fakeShipExecFull(handlers = {}) {
  const calls = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const exec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts?.cwd });
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
    if (file === 'git' && args[0] === 'status') return ok('');
    if (file === 'git' && args[0] === 'rev-parse') return ok(`${handlers.sha ?? 'sha-fixture'}\n`);
    if (file === 'git' && args[0] === 'merge-base') return handlers.baseSha ? ok(`${handlers.baseSha}\n`) : ok('');
    if (file === 'git' && args[0] === 'diff') return ok(handlers.addedFiles ? handlers.addedFiles.join('\n') : '');
    if (file === 'git' && args[0] === 'push') return ok('');
    if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
    if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      const jsonIdx = args.indexOf('--json');
      const fields = jsonIdx >= 0 ? args[jsonIdx + 1] : '';
      if (fields.includes('mergeCommit')) return (handlers.mergedView ?? (() => ok(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'merged-sha' } }))))();
      return (handlers.prView ?? (() => ok(JSON.stringify({ state: 'OPEN', headRefOid: handlers.sha ?? 'sha-fixture', statusCheckRollup: [] }))))();
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return ok(JSON.stringify({ code: 0 }));
    if (file === 'gh' && args[0] === 'run') return (handlers.ghRun ?? (() => ok('')))(args);
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

// --- #280 (FIRST): scratch base lives outside the install checkout ---------------------------------

describe('#280: the shell scratch base lives outside the install checkout, not just "the install root"', () => {
  test('(a) scratchRootDir honors SWARM_INSTALL_ROOT, but its own default is a sibling of the home dir, never a child of it', () => {
    assert.equal(scratchRootDir({ env: { SWARM_INSTALL_ROOT: '/fake/install-root' }, home: '/fake/home' }), '/fake/install-root');
    assert.equal(scratchRootDir({ env: {}, home: '/fake/home' }), '/fake/home/.project-swarm-scratch');
    assert.notEqual(scratchRootDir({ env: {}, home: '/fake/home' }), '/fake/home/.project-swarm');
  });

  test('(b) createShellScratchDir succeeds even when the old install-checkout path (a sibling, not this run\'s base) has its own .git', async t => {
    const fakeHomeWithNoGit = await mkTemp('field-lessons-w-home-');
    t.after(() => fs.rm(fakeHomeWithNoGit, { recursive: true, force: true }));
    // Simulates the 1.37.0 regression: the OLD default scratch base (<home>/.project-swarm) is
    // itself a git checkout. The new default (<home>/.project-swarm-scratch) never resolves
    // through that path at all, so this must never throw scratch-inside-repo.
    const access = async file => { if (file === path.join(fakeHomeWithNoGit, '.project-swarm', '.git')) return; throw Error('ENOENT'); };
    const scratch = await createShellScratchDir({ runId: 'r1', jobId: 'j1' }, { tmpdir: () => '/no/repo/here', realpath: async value => value, access, env: {}, home: fakeHomeWithNoGit });
    t.after(() => fs.rm(scratch.scratchDir, { recursive: true, force: true }));
    assert.equal(scratch.scratchDir.startsWith(path.join(fakeHomeWithNoGit, '.project-swarm-scratch')), true, scratch.scratchDir);
  });

  test('(c) version --check reports scratchOutsideRepo: false and names the scratch root, but never throws', async t => {
    const root = await mkTemp('field-lessons-w-install-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'project-swarm', version: '1.0.0' }));
    // A fake scratch root that DOES carry its own .git, standing in for a machine whose scratch
    // base still resolves inside a checkout; version --check must report it, never refuse.
    const fakeScratchRoot = await mkTemp('field-lessons-w-scratch-with-git-');
    t.after(() => fs.rm(fakeScratchRoot, { recursive: true, force: true }));
    await fs.mkdir(path.join(fakeScratchRoot, '.git'));
    const previousScratchRoot = process.env.SWARM_SCRATCH_ROOT;
    process.env.SWARM_SCRATCH_ROOT = fakeScratchRoot;
    t.after(() => { if (previousScratchRoot === undefined) delete process.env.SWARM_SCRATCH_ROOT; else process.env.SWARM_SCRATCH_ROOT = previousScratchRoot; });
    const result = await swarmVersion(root, { check: true });
    assert.equal(result.scratchOutsideRepo, false);
    assert.equal(result.scratchRoot, fakeScratchRoot);
  });

  test('(d) the original upward .git scan over the OS tmp dir is still layered, unchanged, over the new base', async () => {
    const repoLikeTmp = '/fake/os-tmp-inside-a-repo';
    const access = async file => { if (file === `${repoLikeTmp}/.git`) return; throw Error('ENOENT'); };
    await assert.rejects(assertScratchOutsideRepo(repoLikeTmp, access), /scratch-inside-repo/);
  });
});

// --- #262: a contract or job prompt for a PUBLIC repo passes the private-names scan -----------------

function fakeNamesExec(visibility = 'PUBLIC') {
  return async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/acme/widgets.git\n', stderr: '' };
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') return { stdout: JSON.stringify({ visibility }), stderr: '' };
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
  };
}
async function namesFixture(t, { contractLines, promptLines } = {}) {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/private-names.txt'), 'jane-doe-private\n');
  if (contractLines) await fs.writeFile(path.join(root, 'coordination/contract.md'), contractLines.join('\n'));
  return root;
}

describe('#262: a contract or job prompt for a PUBLIC repo passes the private-names scan before dispatch', () => {
  test('(a) validateProject\'s own wiring refuses private-term-in-contract, naming the real line', async t => {
    const root = await namesFixture(t, { contractLines: ['line one', 'line two', 'line three', 'this line names jane-doe-private directly'] });
    const m = { ...manifest([job({ context: ['input.txt', 'coordination/contract.md'] })]), contract: 'coordination/contract.md' };
    await assert.rejects(
      () => validateProject(root, m, { exec: fakeNamesExec() }),
      /private-term-in-contract: coordination\/contract\.md:4/,
    );
  });

  test('(b) a clean contract but a job prompt naming the term refuses private-term-in-prompt', async t => {
    const root = await namesFixture(t, { contractLines: ['line one', 'nothing here'] });
    const m = { ...manifest([job({ context: ['input.txt', 'coordination/contract.md'], prompt: 'first line\nsecond line names jane-doe-private here' })]), contract: 'coordination/contract.md' };
    await assert.rejects(
      () => validateProject(root, m, { exec: fakeNamesExec() }),
      /private-term-in-prompt: job:writer:2/,
    );
  });

  test('(c) a PRIVATE repo never refuses even though the term is present, and never even reads the contract', async t => {
    const root = await namesFixture(t, { contractLines: ['this line names jane-doe-private directly'] });
    const m = { ...manifest([job()]), contract: 'coordination/contract.md' };
    await privateNamesDispatchGuard(root, m, { exec: fakeNamesExec('PRIVATE') }); // must not throw
  });
});

// --- #265: a standing warning names a root a live rig-service checkout is actually running from -----

describe('#265: a live rig-service checkout gets a standing warning, never a silent HEAD change', () => {
  test('(a) a configured rig.portFile that cannot be read falls back to the documented default port, and warns', async t => {
    const root = await fixture(t);
    const warning = await liveServiceCheckoutWarning(root, { config: { rig: { portFile: path.join(root, 'no-such-port-file') } } });
    assert.equal(warning.code, 'protected-checkout-live-service');
    assert.match(warning.message, new RegExp(`protected-checkout-live-service: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} has a live rig service on port 4405`));
  });

  test('(b) no rig.portFile configured (the default config) never warns', async t => {
    const root = await fixture(t);
    const warning = await liveServiceCheckoutWarning(root, { config: {} });
    assert.equal(warning, null);
  });

  test('(c) a run whose root has a live rig service records the warning in the saved run state', async t => {
    const root = await fixture(t);
    const configFile = path.join(await mkConfigDir(t), 'fake-config.json');
    await fs.writeFile(configFile, JSON.stringify({ rig: { portFile: path.join(root, 'no-such-port-file') } }));
    const state = await runManifest(root, manifest([job()]), {
      spawnImpl: fake(done),
      env: { ...process.env, SWARM_CONFIG: configFile },
    });
    assert.ok(state.warnings.some(w => w.startsWith('protected-checkout-live-service:') && w.includes('port 4405')), JSON.stringify(state.warnings));
  });
});

// --- #266: a model/provider route change warns without a smoke check; refuses on an explicit list ---

describe('#266: a model/provider route change needs a real streaming smoke test before it lands', () => {
  test('(a) a job outputting a file that looks like a model route, no checks declared, warns naming the file', () => {
    const j = job({ outputs: ['src/chat/modelRouter.ts'] });
    const warning = modelRouteChangeNoSmokeTestWarning(manifest([j]), j);
    assert.equal(warning.code, 'model-route-no-smoke-test');
    assert.ok(warning.files.includes('src/chat/modelRouter.ts'), JSON.stringify(warning));
  });

  test('(b) a declared check named model-route-smoke silences the warning', () => {
    const j = job({ outputs: ['src/chat/modelRouter.ts'] });
    const m = manifest([j], { checks: [{ name: 'model-route-smoke', argv: ['npm', 'test'] }] });
    assert.equal(modelRouteChangeNoSmokeTestWarning(m, j), null);
  });

  test('(h) validateProject\'s own wiring surfaces the warning, not just the helper function', async t => {
    const root = await fixture(t);
    const j = job({ outputs: ['src/chat/modelRouter.ts'] });
    const result = await validateProject(root, manifest([j]));
    assert.ok(result.warnings.some(w => (typeof w === 'string' ? w : w?.message)?.startsWith('model-route-no-smoke-test:')), JSON.stringify(result.warnings));
  });

  test('(c) an unrelated check whose own argv contains the literal streaming-smoke also silences it', () => {
    const j = job({ outputs: ['src/chat/modelRouter.ts'] });
    const m = manifest([j], { checks: [{ name: 'ci', argv: ['npm', 'run', 'streaming-smoke'] }] });
    assert.equal(modelRouteChangeNoSmokeTestWarning(m, j), null);
  });

  test('(d) (orchestrator answer #2) an explicitly configured route file with no PR-body section is a missing-verification hit', () => {
    const hits = modelRouteFilesMissingVerification(['src/chat/modelRouter.ts', 'README.md'], ['src/chat/modelRouter.ts'], 'plain body, no sections at all');
    assert.deepEqual(hits, ['src/chat/modelRouter.ts']);
  });

  test('(e) a PR body carrying a ## Model verification section clears the same configured file', () => {
    const hits = modelRouteFilesMissingVerification(['src/chat/modelRouter.ts'], ['src/chat/modelRouter.ts'], 'Summary\n\n## Model verification\nSent one real streaming message through our own client.\n');
    assert.equal(hits, null);
  });

  function gitAt(dir) {
    return (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  }
  async function shipRealRepo(t) {
    const dir = await mkTemp('field-lessons-w-ship-repo-');
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
    return dir;
  }
  function fakeShipExec() {
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    return async (file, args) => {
      if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git');
      if (file === 'git' && args[0] === 'status') return ok('');
      if (file === 'git' && args[0] === 'rev-parse') return ok('sha-fixture\n');
      if (file === 'git' && (args[0] === 'merge-base' || args[0] === 'diff')) return ok('');
      if (file === 'git' && args[0] === 'push') return ok('');
      if (file === 'gh' && args[0] === 'repo' && args[1] === 'view') return ok(JSON.stringify({ visibility: 'PUBLIC' }));
      if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
      if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [] }));
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
  }

  test('(f) ship() itself refuses model-route-verification-missing end to end, and never refuses once the section is present', async t => {
    const root = await shipRealRepo(t);
    const configFile = path.join(await mkConfigDir(t), 'fake-config.json');
    await fs.writeFile(configFile, JSON.stringify({ modelRouteFiles: ['src/chat/modelRouter.ts'] }));
    const exec = fakeShipExec();
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: 'no sections here' }));
    const refused = await ship({
      root, repo: 'acme/widgets', payloadPath, exec, runChecks: async () => [], sleep: async () => {}, now: () => 0, merge: false,
      integratedFiles: ['src/chat/modelRouter.ts'], env: { SWARM_CONFIG: configFile, HOME: root },
    });
    assert.equal(refused.status, 'refused', JSON.stringify(refused));
    assert.equal(refused.code, 'model-route-verification-missing');

    await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: '## Model verification\nran the real client once.' }));
    const stillBlocked = await ship({
      root, repo: 'acme/widgets', payloadPath, exec, runChecks: async () => [], sleep: async () => {}, now: () => 0, merge: false, noCiGraceMs: 0,
      integratedFiles: ['src/chat/modelRouter.ts'], env: { SWARM_CONFIG: configFile, HOME: root },
    });
    assert.notEqual(stillBlocked.code, 'model-route-verification-missing', JSON.stringify(stillBlocked));
  });

  test('(g) legacy default: a config.json on disk from before this field existed never refuses (from-disk)', async t => {
    const configDir = await mkConfigDir(t);
    const configFile = path.join(configDir, 'legacy-config.json');
    // A real, pre-#266 config file: no modelRouteFiles key at all.
    await fs.writeFile(configFile, JSON.stringify({ rig: { portFile: 'x' } }));
    const config = loadLocalConfig({ env: { SWARM_CONFIG: configFile, HOME: configDir } });
    assert.equal(config.modelRouteFiles, undefined);
    assert.equal(modelRouteFilesMissingVerification(['src/chat/modelRouter.ts'], config.modelRouteFiles, 'no sections'), null);
  });
});

// --- #267: a mutant per pass-bar comparison, not one per changed file -------------------------------

describe('#267: a mutant is required per pass-bar comparison line, not just once per changed file', () => {
  test('(a) a brand-new comparison line with no mutant on the file at all warns mutant-missing-for-comparison', () => {
    const writes = [{ file: 'tools/x.mjs', previous: Buffer.from("const y = 1;\n"), bytes: Buffer.from("const y = 1;\nif (total < 0) fail('x');\n") }];
    const warnings = mutantMissingForComparisonLineWarnings(writes, []);
    assert.ok(warnings.some(w => w === 'mutant-missing-for-comparison: tools/x.mjs:2'), JSON.stringify(warnings));
  });

  test('(b) a mutant whose find is exactly the new comparison clears that line', () => {
    const writes = [{ file: 'tools/x.mjs', previous: Buffer.from("const y = 1;\n"), bytes: Buffer.from("const y = 1;\nif (total < 0) fail('x');\n") }];
    const warnings = mutantMissingForComparisonLineWarnings(writes, [{ name: 'm1', file: 'tools/x.mjs', find: 'total < 0', replace: 'total <= 0' }]);
    assert.ok(!warnings.some(w => w.includes(':2')), JSON.stringify(warnings));
  });

  test('(c) a comparison line unchanged from `previous` (only a comment above it moved) is never flagged', () => {
    const previousText = "// old comment\nif (total < 0) fail('x');\n";
    const newText = "// a new, different comment\nif (total < 0) fail('x');\n";
    const writes = [{ file: 'tools/x.mjs', previous: Buffer.from(previousText), bytes: Buffer.from(newText) }];
    const warnings = mutantMissingForComparisonLineWarnings(writes, []);
    assert.deepEqual(warnings, []);
  });

  test('(d) integrateRun\'s own wiring surfaces the warning for a real run, not just the helper function', async t => {
    const root = await fixture(t);
    const writeScript = `fs.mkdirSync('tools',{recursive:true});fs.writeFileSync('tools/x.mjs',"const label = 'demo';\\nif (total < 0) fail('x');\\n");${done}`;
    const m = manifest([job({ outputs: ['tools/x.mjs'] })], {
      // Covers the file (so mutant-missing-for-changed-file stays quiet) but not the new
      // comparison line itself, which lives on a different line entirely.
      mutants: [{ name: 'unrelated', file: 'tools/x.mjs', find: "'demo'", replace: "'other'", check: [process.execPath, '-e', 'process.exit(0)'] }],
    });
    const state = await runManifest(root, m, { spawnImpl: fake(writeScript) });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    const result = await integrateRun(root, state.id, { mutants: true });
    assert.ok((result.warnings ?? []).includes('mutant-missing-for-comparison: tools/x.mjs:2'), JSON.stringify(result.warnings));
  });
});

// --- #274: a real test-failure exit (with a real failure line) is a kill; a formatter is a warning ---

async function mutantTreeFixture(t) {
  const root = await mkTemp('field-lessons-w-mutants-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'target.js'), 'function ok(v){return v<=10}\n');
  return root;
}
async function writeMutantsFile(t, mutants) {
  const dir = await mkTemp('field-lessons-w-mutants-file-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mutants.json');
  await fs.writeFile(file, JSON.stringify(mutants));
  return file;
}
// Passes (exit 0) while target.js still contains the guard text; once mutated, exits 101 (a Rust
// `cargo test` exit) with either a real test-failure tail or a build-error-looking one.
const rustLikeCheck = tail => [process.execPath, '-e', `const ok=require('fs').readFileSync('target.js','utf8').includes('v<=10');if(ok){process.exit(0);}else{process.stdout.write(${JSON.stringify(tail)});process.exit(101);}`];

describe('#274: a known test-failure exit only counts as a kill with a real failure line in the tail', () => {
  test('(a) exit 101 with a real cargo test-failure tail is killed', async t => {
    const root = await mutantTreeFixture(t);
    const mutantsPath = await writeMutantsFile(t, [{ name: 'rust-like', file: 'target.js', find: 'v<=10', replace: 'v<10', check: rustLikeCheck('test result: FAILED. 3 passed; 1 failed\n') }]);
    const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath }, spawn);
    assert.equal(result.mutants[0].status, 'killed');
    assert.equal(result.mutants[0].exitCode, 101);
  });

  test('(b) exit 101 with a compile-error tail (no test-failure line) is invalid-build, never killed', async t => {
    const root = await mutantTreeFixture(t);
    const mutantsPath = await writeMutantsFile(t, [{ name: 'rust-like-build-error', file: 'target.js', find: 'v<=10', replace: 'v<10', check: rustLikeCheck('error[E0308]: mismatched types\n') }]);
    const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath }, spawn);
    assert.equal(result.mutants[0].status, 'invalid-build');
    assert.equal(result.mutants[0].exitCode, 101);
  });

  test('(c) a preChecks step that rewrites a mutant-target file\'s bytes between the snapshot and the mutant run warns formatter-changed-mutant-target', async t => {
    const root = await fixture(t);
    const writeTarget = `fs.writeFileSync('target.js','function ok(v){return v<=10}\\n');${done}`;
    const m = manifest([job({ outputs: ['target.js'] })], {
      mutants: [{ name: 'demo', file: 'target.js', find: 'v<=10', replace: 'v<10', check: [process.execPath, '-e', 'process.exit(0)'] }],
      // Stands in for a formatter (e.g. `cargo fmt`) run as part of preChecks: rewrites the same
      // mutant-target file's bytes (reformatted, but the mutant's own find text survives) before
      // any mutant is actually applied.
      preChecks: [[process.execPath, '-e', "require('fs').writeFileSync('target.js', 'function ok(v) { return v<=10; }\\n')"]],
    });
    const state = await runManifest(root, m, { spawnImpl: fake(writeTarget) });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    const result = await integrateRun(root, state.id, { mutants: true });
    assert.ok((result.warnings ?? []).includes('formatter-changed-mutant-target: target.js'), JSON.stringify(result.warnings));
  });
});

// --- #273: `ship` warns on a new test that eats too much of the per-test CI timeout ------------------

describe('#273: ship warns when a new test eats too much of the per-test CI timeout', () => {
  test('(a) parsePytestDurations reads one line of a pytest --durations block', () => {
    const text = '12.34s call     tests/test_new.py::test_slow\n';
    assert.deepEqual(parsePytestDurations(text), [{ id: 'tests/test_new.py::test_slow', seconds: 12.34 }]);
  });

  test('(b) slowNewTestWarnings warns when a test this PR added ate more than 30% of the per-test timeout', () => {
    const durations = [{ id: 'tests/test_new.py::test_slow', seconds: 12.34 }];
    assert.deepEqual(slowNewTestWarnings(durations, ['tests/test_new.py'], 30), ['slow-new-test: tests/test_new.py::test_slow 12.34s']);
  });

  test('(c) the same slow duration is silent when the file is not one this PR added', () => {
    const durations = [{ id: 'tests/test_new.py::test_slow', seconds: 12.34 }];
    assert.deepEqual(slowNewTestWarnings(durations, [], 30), []);
  });

  test('(d) ship() itself warns slow-new-test end to end, from a full (non-log-failed) CI log', async t => {
    const root = await mkTemp('field-lessons-w-slow-ship-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: 'body text' }));
    const { exec } = fakeShipExecFull({
      prView: () => ({ code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/widgets/actions/runs/777/job/1' }] }), stderr: '' }),
      baseSha: 'base-sha',
      addedFiles: ['tests/test_new.py'],
      ghRun: args => (args[1] === 'view' ? { code: 0, stdout: '12.34s call     tests/test_new.py::test_slow\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, exec,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['tests/test_new.py'],
      merge: false, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.ok(result.warnings.includes('slow-new-test: tests/test_new.py::test_slow 12.34s'), JSON.stringify(result.warnings));
  });
});

// --- #275: `--accept-pre-existing` verifies against the base scoped to just the failing tests --------

describe('#275: --accept-pre-existing verifies against the base scoped to just the failing tests', () => {
  test('(a) scopedBaseArgv appends each failing test\'s own file to the argv', () => {
    assert.deepEqual(
      scopedBaseArgv(['npx', 'vitest', 'run'], [{ id: 'tests/x.test.ts::y', baseStatus: 'unknown' }]),
      ['npx', 'vitest', 'run', 'tests/x.test.ts'],
    );
  });

  test('(b) verifyPreExistingOnBase reaches a real verdict for the failing test even though the unscoped argv alone would not', async t => {
    const root = await mkTemp('field-lessons-w-preexisting-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const exec = async (file, args) => {
      if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        const checkoutPath = args[3];
        await fs.mkdir(path.join(checkoutPath, 'tests'), { recursive: true });
        // The literal substring `def y(` is only ever read by baseStatusForTest's own fallback
        // function-name check below; it is never executed.
        await fs.writeFile(path.join(checkoutPath, 'tests/x.test.ts'), 'def y(\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (file === 'git' && args[0] === 'worktree' && args[1] === 'remove') return { code: 0, stdout: '', stderr: '' };
      if (file === 'npx') {
        if (args.includes('tests/x.test.ts')) return { code: 1, stdout: '1 failed\nFAILED tests/x.test.ts::y\n', stderr: '' };
        return { code: 2, stdout: 'unrelated crash, no useful test id here\n', stderr: '' };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const result = await verifyPreExistingOnBase({
      root, argv: ['npx', 'vitest', 'run'], integratedFiles: [], baseSha: 'deadbeef', exec,
      failingTests: ['tests/x.test.ts::y'],
    });
    assert.equal(result.checked, true, JSON.stringify(result));
    assert.equal(result.tests[0].baseStatus, 'fail', JSON.stringify(result));
  });

  test('(c) renderChecks names the exact failing test ids a pre-existing verdict was reached for', () => {
    const text = renderChecks([{ name: 'test', status: 'pre-existing', failingTests: [{ id: 'tests/serviceClientAvatars.test.ts::y' }] }]);
    assert.match(text, /pre-existing on base: tests\/serviceClientAvatars\.test\.ts::y/);
  });
});

// --- #276: `swarm squash` resets to the merge-base only, and refuses an unexpected staged file --------

describe('#276: swarm squash resets to the merge-base only, and refuses an unexpected staged file', () => {
  function fakeSquashExec({ currentBranch, mergeBase, preResetFiles, stagedFiles, mergeBaseFails = false }) {
    const calls = [];
    const exec = async (_cmd, args) => {
      calls.push(args);
      if (args[2] === 'rev-parse' && args[3] === '--abbrev-ref') return { stdout: `${currentBranch}\n` };
      if (args[2] === 'merge-base') { if (mergeBaseFails) throw new Error('no merge base'); return { stdout: `${mergeBase}\n` }; }
      if (args[2] === 'diff' && args.includes('--cached')) return { stdout: `${(stagedFiles ?? []).join('\n')}\n` };
      if (args[2] === 'diff') return { stdout: `${(preResetFiles ?? []).join('\n')}\n` };
      if (args[2] === 'reset') return { stdout: '' };
      throw new Error(`unexpected exec: git ${args.join(' ')}`);
    };
    return { exec, calls };
  }

  test('(a) a clean squash: resets to the merge-base, stages exactly the expected files, never undoes', async t => {
    const root = await mkTemp('field-lessons-w-squash-a-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { exec, calls } = fakeSquashExec({ currentBranch: 'feature-x', mergeBase: 'mbsha', preResetFiles: ['a.js'], stagedFiles: ['a.js'] });
    const result = await squashBranch(root, { branch: 'feature-x', exec });
    assert.deepEqual(result.files, ['a.js']);
    assert.ok(!calls.some(args => args.includes('HEAD@{1}')));
  });

  test('(b) a staged file the branch never touched at its merge-base is undone and refused', async t => {
    const root = await mkTemp('field-lessons-w-squash-b-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { exec, calls } = fakeSquashExec({ currentBranch: 'feature-x', mergeBase: 'mbsha', preResetFiles: ['a.js'], stagedFiles: ['a.js', 'unrelated/b.js'] });
    await assert.rejects(
      () => squashBranch(root, { branch: 'feature-x', exec }),
      /squash-unexpected-files: unrelated\/b\.js; undone, nothing committed/,
    );
    assert.ok(calls.some(args => args.includes('HEAD@{1}')));
  });

  test('(c) HEAD is on the wrong branch: refuses before any merge-base or reset call', async t => {
    const root = await mkTemp('field-lessons-w-squash-c-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { exec, calls } = fakeSquashExec({ currentBranch: 'main' });
    await assert.rejects(
      () => squashBranch(root, { branch: 'feature-x', exec }),
      /swarm squash: HEAD is on main, not --branch feature-x; check it out first/,
    );
    assert.ok(!calls.some(args => args.includes('merge-base') || args.includes('reset')));
  });
});

// --- #277: a running daily spend total, checked before every dispatch ---------------------------------

describe('#277: a running daily spend total, checked before every dispatch', () => {
  async function writeSpendRun(root, id, { startedAt, jobs }) {
    const dir = path.join(root, '.swarm/runs', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id, root, status: 'complete', startedAt, jobs }));
  }

  test('(a) spendGuard refuses cap once today\'s spend across two registered project roots crosses it', async t => {
    const root1 = await mkTemp('field-lessons-w-spend-a1-');
    t.after(() => fs.rm(root1, { recursive: true, force: true }));
    const root2 = await mkTemp('field-lessons-w-spend-a2-');
    t.after(() => fs.rm(root2, { recursive: true, force: true }));
    await fs.writeFile(path.join(root1, '.swarm-projects.json'), JSON.stringify([root2]));
    const todayIso = new Date().toISOString();
    await writeSpendRun(root1, 'run1', { startedAt: todayIso, jobs: [{ id: 'j1', costUsd: 30.8 }] });
    await writeSpendRun(root2, 'run2', { startedAt: todayIso, jobs: [{ id: 'j1', costUsd: 35 }] });
    const configDir = await mkConfigDir(t);
    const configFile = path.join(configDir, 'config.json');
    await fs.writeFile(configFile, JSON.stringify({ spend: { dailyCapUsd: 60 } }));
    const guard = await spendGuard(root1, { env: { SWARM_CONFIG: configFile } });
    assert.equal(guard.status, 'cap', JSON.stringify(guard));
    assert.equal(guard.spendUsd, 65.8);
  });

  test('(b) CLI: run refuses spend-cap before ever dispatching, and creates no new run directory', async t => {
    const root = await mkTemp('field-lessons-w-spend-cli-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await writeSpendRun(root, 'existing-run', { startedAt: new Date().toISOString(), jobs: [{ id: 'j1', costUsd: 65.8 }] });
    const configDir = await mkConfigDir(t);
    const configFile = path.join(configDir, 'config.json');
    await fs.writeFile(configFile, JSON.stringify({ spend: { dailyCapUsd: 60 } }));
    const manifestPath = path.join(root, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest([job()])));
    const swarmCliPath = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
    let failure;
    try {
      execFileSync(process.execPath, [swarmCliPath, 'run', manifestPath, '--root', root], { encoding: 'utf8', env: { ...process.env, SWARM_CONFIG: configFile } });
    } catch (error) { failure = error; }
    assert.ok(failure, 'expected the run command to exit nonzero');
    assert.match(String(failure.stderr ?? failure.stdout ?? ''), /spend-cap:/);
    const runsAfter = await fs.readdir(path.join(root, '.swarm/runs'));
    assert.deepEqual(runsAfter, ['existing-run']);
  });

  test('(c) todaySpendUsd only counts a run started at/after today\'s own UTC midnight', async t => {
    const root = await mkTemp('field-lessons-w-spend-c-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await writeSpendRun(root, 'yesterday-run', { startedAt: '2026-01-14T23:59:00.000Z', jobs: [{ id: 'j1', costUsd: 100 }] });
    await writeSpendRun(root, 'today-run', { startedAt: '2026-01-15T00:01:00.000Z', jobs: [{ id: 'j1', costUsd: 5 }] });
    const spendUsd = await todaySpendUsd(root, { now: () => new Date('2026-01-15T00:05:00.000Z') });
    assert.equal(spendUsd, 5);
  });

  test('(d, time zone) the UTC-day boundary is unaffected by the process\'s own local time zone', async t => {
    const root = await mkTemp('field-lessons-w-spend-d-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await writeSpendRun(root, 'yesterday-run', { startedAt: '2026-01-14T23:59:00.000Z', jobs: [{ id: 'j1', costUsd: 100 }] });
    await writeSpendRun(root, 'today-run', { startedAt: '2026-01-15T00:01:00.000Z', jobs: [{ id: 'j1', costUsd: 5 }] });
    const previousTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    t.after(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });
    const spendUsd = await todaySpendUsd(root, { now: () => new Date('2026-01-15T00:05:00.000Z') });
    assert.equal(spendUsd, 5);
  });
});

// --- #278: the sandbox's UV_CACHE_DIR points at the real, shared, read-only cache ----------------------

describe('#278: the sandbox\'s UV_CACHE_DIR points at the real, shared, read-only cache', () => {
  test('(a) resolveSharedUvCacheDir defaults to the real per-OS uv cache under home', () => {
    assert.equal(resolveSharedUvCacheDir({ env: {}, home: '/Users/x', platform: 'darwin' }), '/Users/x/Library/Caches/uv');
    assert.equal(resolveSharedUvCacheDir({ env: {}, home: '/home/x', platform: 'linux' }), '/home/x/.cache/uv');
  });

  test('(b) an explicit UV_CACHE_DIR always wins', () => {
    assert.equal(resolveSharedUvCacheDir({ env: { UV_CACHE_DIR: '/custom/cache' }, home: '/Users/x' }), '/custom/cache');
  });

  test('(c) the constructed shell job env points UV_CACHE_DIR under home, never beside the worktree in shellDir', () => {
    const home = '/fake/home';
    const env = shellEnvironment({
      parentEnv: {}, home, tmp: '/fake/home/tmp', configDir: '/fake/home/config', proxyPort: 12345,
      apiKey: 'test-key', userId: 'swarm-worker:job1',
      uvCacheDir: resolveSharedUvCacheDir({ env: {}, home, platform: 'darwin' }),
    });
    assert.equal(env.UV_CACHE_DIR, '/fake/home/Library/Caches/uv');
    assert.ok(!env.UV_CACHE_DIR.endsWith('/uv-cache'));
  });

  test('(d) a real run\'s shell job env points UV_CACHE_DIR at the real home\'s uv cache, never the job\'s own per-run scratch home or shellDir', async t => {
    const root = await mkTemp('field-lessons-w-uvcache-run-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await git(root, ['init', '-q']);
    await fs.writeFile(path.join(root, 'input.txt'), 'original');
    await fs.writeFile(path.join(root, 'output.txt'), 'original');
    await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    // A fake HOME must live outside any git work tree (loadLocalConfig's own config-inside-repo
    // guard); this checkout's own worktree is itself one, so this lives directly under the OS
    // tmp dir instead, same as mkConfigDir above.
    const realHome = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-test-w-realhome-'));
    t.after(() => fs.rm(realHome, { recursive: true, force: true }));
    const seen = [];
    const fakeUvCacheSpawn = (command, args, options) => {
      seen.push({ command, args, options });
      if (command === 'sandbox-exec') return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\nfs.writeFileSync('output.txt','proposed');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));`], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: options.detached });
      return spawn(command, args, options);
    };
    const shellHooksForRun = { access: async () => {}, resolveClaude: async () => '/opt/fake-claude/bin/claude.exe', scanListeningPorts: async () => [] };
    const shellJobSpec = { id: 'builder', agent: 'claude', model: 'sonnet', shell: true, prompt: 'x', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000 };
    // A CI runner's own setup-uv step can export UV_CACHE_DIR (and sometimes
    // UV_PYTHON_INSTALL_DIR/UV_TOOL_DIR) into the ambient process env; stripped here (same pattern
    // as tests/shell-setup.test.mjs's own parentEnvNoUvCache) so this exercises the real per-HOME
    // default, never an explicit-override branch winning by accident.
    const { UV_CACHE_DIR: _ignoredUvCacheDir, UV_PYTHON_INSTALL_DIR: _ignoredUvPythonInstallDir, UV_TOOL_DIR: _ignoredUvToolDir, ...parentEnvNoUvVars } = process.env;
    const runEnvForThisTest = { ...parentEnvNoUvVars, HOME: realHome, SWARM_CLAUDE_WORKER_API_KEY: 'sk-FAKE-uvcache-0000' };
    const state = await runManifest(root, { version: 1, jobs: [shellJobSpec] }, {
      platform: 'darwin',
      spawnImpl: fakeUvCacheSpawn,
      env: runEnvForThisTest,
      keyExec: () => assert.fail('the real keychain must never be read in tests'),
      shellHooks: shellHooksForRun,
    });
    assert.equal(state.status, 'complete', state.jobs[0].error ?? '');
    const [launch] = seen;
    // Computed with the same helper the code uses (field lesson #278), never a hard-coded macOS
    // path, so this holds on a Linux CI runner's own process.platform too.
    assert.equal(launch.options.env.UV_CACHE_DIR, resolveSharedUvCacheDir({ env: runEnvForThisTest, home: realHome }));
    assert.ok(!launch.options.env.UV_CACHE_DIR.startsWith(realHome + '/.project-swarm-scratch'), launch.options.env.UV_CACHE_DIR);
  });
});

// --- #279: default rerun-flaky also covers a failing test whose file the PR never touches -------------

describe('#279: default rerun-flaky also covers a failing test whose file this PR never touches', () => {
  test('(a) a single, non-platform-only failing check whose only failing test file is untouched gets the default rerun', async t => {
    const root = await mkTemp('field-lessons-w-279a-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: 'body text' }));
    let prViewCalls = 0;
    const { exec, calls } = fakeShipExecFull({
      prView: () => {
        prViewCalls++;
        if (prViewCalls === 1) return { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/900/job/1' }] }), stderr: '' };
        return { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }), stderr: '' };
      },
      ghRun: args => (args[1] === 'view' ? { code: 0, stdout: 'FAILED tests/unrelated_file.py::test_x - AssertionError\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, exec,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['src/feature.py'],
      merge: false, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.ok(result.warnings.includes('rerun-flaky-default: 1 (file-not-in-diff)'), JSON.stringify(result.warnings));
    const rerunCalls = calls.filter(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun' && c.args[2] === '900');
    assert.equal(rerunCalls.length, 1);
  });

  test('(b) a repeat offender (2nd hit within the rolling window) also warns flake-repeat-offender', async t => {
    const root = await mkTemp('field-lessons-w-279b-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
    const priorHit = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(path.join(root, '.swarm/flake-log.json'), JSON.stringify({ 'tests/unrelated_file.py': { hitTimestamps: [priorHit], hits: 1, lastSeenAt: priorHit } }));
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: 'body text' }));
    let prViewCalls = 0;
    const { exec } = fakeShipExecFull({
      prView: () => {
        prViewCalls++;
        if (prViewCalls === 1) return { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/901/job/1' }] }), stderr: '' };
        return { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }), stderr: '' };
      },
      ghRun: args => (args[1] === 'view' ? { code: 0, stdout: 'FAILED tests/unrelated_file.py::test_x - AssertionError\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, exec,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['src/feature.py'],
      merge: false, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.ok(result.warnings.includes('flake-repeat-offender: tests/unrelated_file.py (2 hits); dispatch a fix job'), JSON.stringify(result.warnings));
  });

  test('(c) a failing test whose file IS in this PR\'s diff is never rerun, and the flake log is never written', async t => {
    const root = await mkTemp('field-lessons-w-279c-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature', base: 'main', body: 'body text' }));
    const { exec, calls } = fakeShipExecFull({
      prView: () => ({ code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/902/job/1' }] }), stderr: '' }),
      ghRun: args => (args[1] === 'view' ? { code: 0, stdout: 'FAILED tests/feature.py::test_x - AssertionError\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath, exec,
      runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
      integratedFiles: ['tests/feature.py'],
      merge: false, sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ci-failed', JSON.stringify(result));
    assert.ok(!calls.some(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun'));
    await assert.rejects(fs.access(path.join(root, '.swarm/flake-log.json')));
  });
});
