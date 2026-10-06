// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runManifest, validateManifest, validateProject, expandOpenScopes, inspectRun, integrateRun, resolveWorktree, narrowOutputScopeWarning, doctor, doctorAll, toolchainsReport, redundantWriterWarnings, runMutantsCurrentTree, parseShipFlags, shipRun, shipBranch, executeCodexJob } from '../tools/swarm.mjs';
import { codexMessage, DESIGN_ONLY_LINE, git, prepareViteCaches, viteCacheWarnings, codexProfile } from '../tools/codex-adapter.mjs';
import { preflightProject } from '../tools/preflight.mjs';
import { ticketPipeline, parseTicketArgs } from '../tools/pipeline.mjs';
import { registerLiveRun, unregisterLiveRun } from '../tools/board.mjs';

const execFileAsync = promisify(execFile);
const job = extra => ({ id: 'writer', agent: 'codex', model: 'test-model', context: ['input.txt'], outputs: ['src/one.txt'], prompt: 'Update the file.', timeoutMs: 10000, ...extra });
const manifest = extra => ({ version: 1, jobs: [job(extra)] });
const open = extra => manifest({ scope: 'open', outputDirs: ['src'], ...extra });
const outside = (root, file) => { const rel = path.relative(root, file); return path.isAbsolute(rel) || rel.split(path.sep)[0] === '..'; };
async function put(root, file, text) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); }
async function commit(root) { await git(root, ['add', '.']); await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']); }
async function fixture(t, files = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'ag-runtime-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  for (const [file, text] of Object.entries({ 'input.txt': 'context', 'src/one.txt': 'one', 'src/two.txt': 'two', '.gitignore': '.swarm/\nnode_modules/\n', ...files })) await put(root, file, text);
  await commit(root);
  return root;
}
function fake(script = '', observe = () => {}) {
  return (command, args, options) => {
    observe(command, args, options);
    assert.equal(command, 'sandbox-exec');
    const resultPath = args[args.indexOf('-o') + 1];
    const finish = args.includes('codex') ? `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({filesChanged: ['invented.txt'], notes: []}));` : `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'{}'}));`;
    return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; ${script}; ${finish}`], options);
  };
}
const run = (root, spec, extra = {}) => runManifest(root, spec, { platform: 'darwin', spawnImpl: fake(), ...extra });
async function config(t, value) {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'ag-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify(value));
  return { ...process.env, SWARM_CONFIG: file };
}

test('AG default relocates Codex and shell worktrees without a config key', async t => {
  for (const shell of [false, true]) for (const setting of ['absent', false, true, 'override']) {
    const root = await fixture(t);
    const overrideDir = path.join(path.dirname(root), path.basename(root) + '-worktrees');
    t.after(() => fs.rm(overrideDir, { recursive: true, force: true }));
    const env = await config(t, setting === 'override' ? { worktreesDir: overrideDir } : setting === 'absent' ? {} : { worktreesOutsideRoot: setting });
    env.SWARM_CLAUDE_WORKER_API_KEY = 'sk-FAKE-ag-runtime';
    let launched;
    const state = await run(root, manifest(shell ? { agent: 'claude', model: 'sonnet', shell: true } : {}), {
      env, spawnImpl: fake("fs.writeFileSync('src/one.txt','changed')", (_cmd, _args, options) => { launched = options.cwd; }),
      keyExec: () => assert.fail('no keychain'), shellHooks: { access: async () => {}, resolveClaude: async () => '/opt/fake/bin/claude', scanListeningPorts: async () => [] },
    });
    assert.equal(state.status, 'complete', state.jobs[0]?.error ?? state.error);
    assert.equal(launched, resolveWorktree(state, state.jobs[0]));
    assert.equal(outside(root, launched), setting !== false);
    if (setting !== false) {
      assert(!state.warnings.some(warning => String(warning).includes('swarm-dir-not-ignored')));
      const copies = (await fs.readdir(root, { recursive: true })).filter(file => file.split(path.sep).includes('worktrees') && path.basename(file) === 'input.txt');
      assert.deepEqual(copies, []);
      assert.equal((await fs.readdir(root, { recursive: true })).filter(file => path.basename(file) === 'input.txt').length, 1);
    }
    if (setting === 'override') assert.equal(outside(overrideDir, launched), false);
  }
});

test('L351 open scope retains a tracked extra edit through inspect and integrate', async t => {
  for (const dirty of [false, true]) {
    const root = await fixture(t);
    const spec = open();
    const state = await run(root, spec, { spawnImpl: fake("fs.writeFileSync('src/two.txt','extra edit')") });
    assert.equal(state.status, 'complete', state.error ?? state.jobs[0]?.error);
    assert.deepEqual(spec.jobs[0].outputs, ['src/one.txt'], 'caller manifest was not widened');
    assert.deepEqual(state.jobs[0].filesChanged, ['src/two.txt']);
    const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'manifest.json')));
    assert.deepEqual(saved.jobs[0].outputs, ['src/one.txt', 'src/two.txt']);
    // A new HEAD cannot widen a saved run during inspect/integrate.
    await put(root, 'src/later.txt', 'new HEAD'); await commit(root);
    if (dirty) await put(root, 'src/two.txt', 'coordinator change');
    const inspection = await inspectRun(root, state.id);
    assert.deepEqual(inspection.filesChanged, ['src/two.txt']);
    assert(!inspection.files.some(file => file.path === 'src/later.txt'));
    assert.equal(inspection.files.find(file => file.path === 'src/two.txt').status, dirty ? 'conflict' : 'ready');
    if (dirty) await assert.rejects(integrateRun(root, state.id, { noChecks: true }), /conflict/i);
    else {
      const integrated = await integrateRun(root, state.id, { noChecks: true });
      assert.deepEqual(integrated.files, ['src/two.txt']);
      assert.deepEqual(integrated.filesChanged, ['src/two.txt']);
      assert.equal(await fs.readFile(path.join(root, 'src/two.txt'), 'utf8'), 'extra edit');
    }
  }
});

test('L351 open scope refuses escapes collisions and undeclared new files', async t => {
  const root = await fixture(t, { 'src-other/sibling.txt': 'sibling', 'elsewhere.txt': 'outside' });
  let launched = 0;
  const never = () => { launched++; assert.fail('invalid declaration dispatched'); };
  for (const dir of ['.', '/', '../src', 'src/../src', 'C:/src', 'src\\sub', 'src/*', 'src/.GIT', '.swarm', 'missing', 'src/one.txt']) {
    await assert.rejects(run(root, open({ outputDirs: [dir] }), { spawnImpl: never }), /scope-open-path/);
  }
  for (const bad of [{ scope: 'other' }, { agent: 'claude' }, { outputDirs: [] }, { outputDirs: Array(21).fill('src') }]) assert.throws(() => validateManifest(open(bad)), /scope-open-invalid/);
  assert.throws(() => validateManifest(open({ outputDirs: ['src', 'SRC'] })), /scope-open-path/);
  assert.throws(() => validateManifest(manifest({ outputDirs: ['src'] })), /scope-open-invalid/);
  await fs.symlink(path.join(root, 'src'), path.join(root, 'linked'), 'dir');
  await assert.rejects(expandOpenScopes(root, open({ outputDirs: ['linked'] })), /scope-open-path/);
  const collision = open(); collision.jobs.push(job({ id: 'other', outputs: ['SRC/TWO.TXT'] }));
  await assert.rejects(run(root, collision, { spawnImpl: never }), /collision/i);
  const liveDir = path.join(root, '.swarm/live');
  await registerLiveRun({ runId: 'other-run', root, outputs: ['SRC/TWO.TXT'], dir: liveDir });
  try { await assert.rejects(run(root, open(), { spawnImpl: never, liveDir }), /also written by live run/); }
  finally { await unregisterLiveRun('other-run', { dir: liveDir }); }
  assert.equal(launched, 0);
  await put(root, 'src/untracked.txt', 'not a grant');
  await put(root, 'src/ignored.txt', 'ignored');
  await put(root, '.gitignore', '.swarm/\nnode_modules/\nsrc/ignored.txt\n');
  await fs.symlink(path.join(root, 'elsewhere.txt'), path.join(root, 'src/link.txt'));
  await git(root, ['add', 'src/link.txt']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'tracked link']);
  const expanded = await expandOpenScopes(root, open({ outputs: ['new-explicit.txt'] }));
  assert.deepEqual(expanded.jobs[0].outputs, ['new-explicit.txt', 'src/one.txt', 'src/two.txt']);
  await fs.rm(path.join(root, 'src/two.txt'));
  assert.deepEqual((await expandOpenScopes(root, open())).jobs[0].outputs, ['src/one.txt']);
  const submoduleRoot = await fixture(t);
  const sha = (await git(submoduleRoot, ['rev-parse', 'HEAD'])).trim();
  await fs.mkdir(path.join(submoduleRoot, 'src/module'));
  await git(submoduleRoot, ['update-index', '--add', '--cacheinfo', `160000,${sha},src/module`]);
  await git(submoduleRoot, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'gitlink fixture']);
  assert.deepEqual((await expandOpenScopes(submoduleRoot, open())).jobs[0].outputs, ['src/one.txt', 'src/two.txt']);
  const many = await fixture(t);
  for (let index = 0; index < 101; index++) await put(many, `src/file-${index}.txt`, 'tracked');
  await commit(many);
  await assert.rejects(expandOpenScopes(many, open()), /scope-open-too-large/);
  for (const scenario of ['new', 'deleted', 'tampered', 'legacy']) {
    const clean = await fixture(t);
    const state = await run(clean, scenario === 'legacy' ? manifest() : open(), { spawnImpl: fake(scenario === 'new' ? "fs.writeFileSync('src/new.txt','undeclared')" : scenario === 'deleted' ? "fs.unlinkSync('src/two.txt')" : "fs.writeFileSync('src/one.txt','edit')") });
    if (scenario === 'deleted') { assert.equal(state.jobs[0].status, 'failed'); await assert.rejects(integrateRun(clean, state.id), /Only a complete/); }
    if (scenario === 'new') {
      assert.deepEqual(state.jobs[0].droppedWrites, ['src/new.txt']);
      await assert.rejects(integrateRun(clean, state.id, { noChecks: true }), /dropped-writes/);
      await assert.rejects(fs.access(path.join(clean, 'src/new.txt')));
    }
    if (scenario === 'tampered') {
      state.jobs[0].outputs.push('src/not-approved.txt');
      await put(clean, `.swarm/runs/${state.id}/state.json`, JSON.stringify(state));
      await assert.rejects(integrateRun(clean, state.id, { noChecks: true }), /metadata does not match/);
      await assert.rejects(inspectRun(clean, state.id), /metadata does not match/);
    }
    if (scenario === 'legacy') { assert.deepEqual(state.jobs[0].outputs, ['src/one.txt']); assert.deepEqual((await integrateRun(clean, state.id, { noChecks: true })).files, ['src/one.txt']); }
  }
});

test('L351 narrow prompts warn before expansion', async t => {
  const root = await fixture(t, { 'src/three.txt': 'three' });
  const spec = open({ prompt: 'Please TOUCH ONLY this part.' });
  const warning = { code: 'narrow-output-scope', jobId: 'writer', message: 'narrow-output-scope: Job writer says touch only with fewer than three outputs; include every plausible file or use scope open with outputDirs' };
  assert.deepEqual(narrowOutputScopeWarning(spec.jobs[0]), warning);
  const validated = await validateProject(root, spec);
  assert(validated.warnings.some(item => item.code === warning.code && item.message === warning.message));
  assert.equal(validated.jobs[0].outputs.length, 3);
  assert.equal(narrowOutputScopeWarning(job({ prompt: 'touch only', outputs: ['a', 'b', 'c'] })), null);
  assert.equal(narrowOutputScopeWarning(job()), null);
  const explicit = manifest({ prompt: 'touch only' });
  assert.deepEqual((await validateProject(root, explicit)).jobs[0].outputs, ['src/one.txt']);
  const brief = codexMessage((await expandOpenScopes(root, spec)).jobs[0]);
  assert.match(brief, /Deliver what you can and list what remains\./);
  assert.match(brief, /src\/two.txt/);
});

test('L351 open scope ticket commits validated expanded files', async t => {
  for (const scenario of ['ok', 'unrelated', 'lock-drift']) {
    const root = await fixture(t);
    await put(root, 'manifest.json', JSON.stringify(open()));
    await put(root, 'pr.json', JSON.stringify({ title: 'fixture', head: 'topic', base: 'main', body: 'review' }));
    let dirt = [], committed;
    const deps = {
      makeRunId: () => 'pipeline-fixture',
      exec: async (_cmd, args) => {
        if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'topic' };
        if (args[0] === 'rev-parse') return { code: 0, stdout: 'a'.repeat(40) };
        if (args[0] === 'status') {
          return { code: 0, stdout: dirt.map(file => ' M ' + file + '\0').join('') };
        }
        assert.fail('unexpected git call');
      },
      run: async () => ({ id: 'pipeline-fixture', status: 'complete', jobs: [{ status: 'complete' }] }),
      inspect: async () => ({ jobs: [{ status: 'complete' }], files: [{ status: 'ready' }] }),
      integrate: async () => { dirt = ['src/two.txt', ...(scenario === 'unrelated' ? ['unrelated.txt'] : [])]; return { status: 'integrated', files: ['src/two.txt'] }; },
      checks: async () => ({ checksPassed: true }),
      commit: async (_root, files) => { committed = files; dirt = []; return { status: 'committed', sha: 'a'.repeat(40) }; },
      ship: async () => ({ status: 'held' }),
    };
    // Post-check lock drift is injected by resuming a saved successful checks stage below.
    if (scenario === 'lock-drift') deps.commit = async () => { await put(root, 'uv.lock', 'late drift'); return { status: 'failed' }; };
    const options = parseTicketArgs(['manifest.json', '--pr', 'pr.json']);
    const result = await ticketPipeline(root, options, deps);
    if (scenario === 'ok') { assert.equal(result.status, 'complete'); assert.deepEqual(committed, ['src/one.txt', 'src/two.txt']); }
    else if (scenario === 'unrelated') { assert.equal(result.detail.code, 'pipeline-dirty'); assert.deepEqual(result.detail.paths, ['unrelated.txt']); assert.equal(committed, undefined); }
    else {
      assert.equal(result.status, 'error');
      const resumed = await ticketPipeline(root, { ...options, resume: 'pipeline-fixture' }, deps);
      assert.equal(resumed.detail.code, 'pipeline-dirty');
      assert(resumed.detail.paths.includes('uv.lock'));
      assert.equal(committed, undefined);
    }
  }
});

test('L353 Codex launch grants only prepared Vite cache directories', async t => {
  for (const linked of [false, true]) {
    const root = await fixture(t, { 'package.json': JSON.stringify({ devDependencies: { vitest: '1' } }) });
    if (linked) await put(root, 'node_modules/pkg/index.js', 'dependency');
    const directory = '.swarm/runs/cache-test';
    await fs.mkdir(path.join(root, directory), { recursive: true });
    await fs.mkdir(path.join(root, '.swarm/proposal'), { recursive: true });
    const worktree = path.join(root, '.swarm/cache-worktree');
    let inspected = false;
    const result = await executeCodexJob(root, directory, job(), path.join(root, '.swarm/proposal'), {
      env: process.env, portBase: 4500, cancelled: () => false,
      gitImpl: async (cwd, args) => {
        const output = await git(cwd, args);
        if (!linked && args[0] === 'worktree' && args[1] === 'add') await put(args[3], 'node_modules/pkg/index.js', 'dependency');
        return output;
      }, worktreePath: worktree,
      spawnImpl: fake('', (_cmd, args) => {
        inspected = true;
        const profile = readFileSync(args[args.indexOf('-f') + 1], 'utf8');
        const dependency = path.join(linked ? root : worktree, 'node_modules');
        const deny = `(deny file-write* (subpath "${dependency}"))`;
        for (const name of ['.vite-temp', '.vite']) {
          const file = path.join(dependency, name);
          assert(statSync(file).isDirectory(), 'prepared before worker launch');
          const allow = `(allow file-write* (subpath "${file}"))`;
          assert(profile.includes(allow), 'narrow cache grant reaches the actual profile');
          assert(profile.indexOf(allow) > profile.indexOf(deny));
          assert(profile.indexOf(allow) < profile.lastIndexOf('(deny file-read* file-write*'));
          assert(profile.split('\n').find(line => line.includes('(require-any')).includes(`(subpath "${file}")`));
        }
        assert(!profile.includes(`(allow file-write* (subpath "${dependency}"))`));
        assert(!profile.includes(`(allow file-write* (subpath "${path.join(dependency, 'pkg')}"))`));
      }),
    });
    assert.equal(result.status, 'complete', result.error);
    assert.equal(inspected, true);
    if (linked) for (const cache of ['.vite-temp', '.vite']) assert((await fs.stat(path.join(root, 'node_modules', cache))).isDirectory(), 'shared caches survive cleanup');
  }
  const absent = await fixture(t, { 'package.json': '{"optionalDependencies":{"vite":"1"}}' });
  assert.deepEqual(await prepareViteCaches(absent), { cacheWritePaths: [] });
  await assert.rejects(fs.access(path.join(absent, 'node_modules')));
  const unrelated = await fixture(t, { 'package.json': '{"dependencies":{"other":"1"}}' });
  await fs.mkdir(path.join(unrelated, 'node_modules'));
  assert.deepEqual(await prepareViteCaches(unrelated), { cacheWritePaths: [] });
  await assert.rejects(fs.access(path.join(unrelated, 'node_modules/.vite')));
  const grantRoot = await fixture(t, { 'package.json': '{"dependencies":{"vite":"1"}}' });
  await fs.mkdir(path.join(grantRoot, 'node_modules'));
  const grants = (await prepareViteCaches(grantRoot)).cacheWritePaths;
  const profileOptions = { worktree: grantRoot, commonDir: path.join(grantRoot, '.git'), metadataDir: path.join(grantRoot, '.git/worktrees/job') };
  assert.doesNotThrow(() => codexProfile({ ...profileOptions, cacheWritePaths: grants }));
  assert.throws(() => codexProfile({ ...profileOptions, cacheWritePaths: [grants[0], grants[0]] }), /vite-temp-not-writable/);
  await fs.mkdir(path.join(grantRoot, 'node_modules/.other-cache'));
  assert.throws(() => codexProfile({ ...profileOptions, cacheWritePaths: [grants[0], path.join(grantRoot, 'node_modules/.other-cache')] }), /vite-temp-not-writable/);
  const escapeRoot = await fixture(t, { 'package.json': '{"dependencies":{"vite":"1"}}' });
  await fs.symlink(path.join(grantRoot, 'node_modules'), path.join(escapeRoot, 'node_modules'), 'dir');
  await assert.rejects(prepareViteCaches(escapeRoot), error => error.code === 'vite-temp-not-writable');
  assert.deepEqual((await prepareViteCaches(escapeRoot, { environmentReadPaths: [path.join(grantRoot, 'node_modules')] })).cacheWritePaths, grants);
  for (const kind of ['symlink', 'file', 'escape', 'denied']) {
    const root = await fixture(t, { 'package.json': '{"dependencies":{"vite":"1"}}' });
    await fs.mkdir(path.join(root, 'node_modules'));
    if (kind === 'symlink') await fs.symlink(root, path.join(root, 'node_modules/.vite-temp'), 'dir');
    if (kind === 'file') await put(root, 'node_modules/.vite-temp', 'not a directory');
    const options = kind === 'escape' ? { fsImpl: { ...fs, realpath: async file => file.endsWith('.vite-temp') ? root : fs.realpath(file) } } : kind === 'denied' ? { home: root, config: { deniedHomeDirs: ['node_modules'] } } : {};
    await assert.rejects(prepareViteCaches(root, options), error => error.code === 'vite-temp-not-writable');
  }
  // An unsafe shared cache refuses at the real launch call site, with no worker process.
  const bad = await fixture(t, { 'package.json': '{"dependencies":{"vite":"1"}}' });
  await fs.mkdir(path.join(bad, 'node_modules'));
  await fs.symlink(bad, path.join(bad, 'node_modules/.vite-temp'), 'dir');
  const refused = await run(bad, manifest(), { spawnImpl: () => assert.fail('unsafe cache launched') });
  assert.equal(refused.jobs[0].code, 'vite-temp-not-writable');
  assert.match(refused.jobs[0].error, /prepare writable Vite caches/);
});

test('L353 preflight warns for unsafe or unwritable Vite caches without writes', async t => {
  const root = await fixture(t, { 'package.json': '{"dependencies":{"vite":"1"}}' });
  await fs.mkdir(path.join(root, 'node_modules'));
  const warnings = (await preflightProject(root, manifest())).advisories.filter(warning => warning.code === 'vite-temp-not-writable');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, `vite-temp-not-writable: ${path.join(root, 'node_modules/.vite-temp')}; prepare writable Vite caches or use an isolated dependency install`);
  assert.deepEqual(await fs.readdir(path.join(root, 'node_modules')), []);
  const reads = [], accesses = [];
  await viteCacheWarnings(root, manifest(), { lstat: async file => { reads.push(file); return fs.lstat(file); }, access: async file => { accesses.push(file); } });
  assert(reads.includes(path.join(root, 'node_modules/.vite-temp')));
  assert(accesses.includes(path.join(root, 'node_modules')), 'missing cache probes nearest existing parent');
  await prepareViteCaches(root);
  assert.deepEqual(await viteCacheWarnings(root, manifest()), []);
  assert.equal((await preflightProject(root, manifest())).advisories.some(warning => warning.code === 'vite-temp-not-writable'), false);
  assert.equal((await viteCacheWarnings(root, manifest(), { access: async () => { throw Error('EACCES'); } }))[0].code, 'vite-temp-not-writable');
  assert.deepEqual(await viteCacheWarnings(root, manifest({ agent: 'claude' }), { access: () => assert.fail('other provider') }), []);
  await fs.rename(path.join(root, 'node_modules/.vite'), path.join(root, 'cache-saved'));
  await fs.symlink(path.join(root, 'cache-saved'), path.join(root, 'node_modules/.vite'), 'dir');
  assert.equal((await viteCacheWarnings(root, manifest()))[0].code, 'vite-temp-not-writable');
  await put(root, 'package.json', '{}');
  assert.deepEqual(await viteCacheWarnings(root, manifest()), []);
});

test('L353 real seatbelt permits cache writes and denies dependency writes', { skip: process.env.SWARM_IN_SANDBOX ? 'nested sandbox: real seatbelt is coordinator-only' : process.platform !== 'darwin' ? 'macOS seatbelt required' : false }, async t => {
  const root = await fixture(t, { 'package.json': '{"dependencies":{"vite":"1"}}' });
  const worktree = path.join(root, 'worker');
  await fs.mkdir(worktree);
  await put(worktree, 'package.json', '{"dependencies":{"vite":"1"}}');
  const dependency = path.join(root, 'node_modules');
  await put(root, 'node_modules/pkg/index.js', 'original');
  await fs.symlink(dependency, path.join(worktree, 'node_modules'), 'dir');
  const { cacheWritePaths } = await prepareViteCaches(worktree, { environmentReadPaths: [dependency] });
  const profile = path.join(root, 'profile.sb');
  await fs.writeFile(profile, codexProfile({ worktree, commonDir: path.join(root, '.git'), metadataDir: path.join(root, '.git/worktrees/worker'), environmentReadPaths: [dependency], cacheWritePaths, readPaths: [path.dirname(process.execPath)] }));
  const script = `const fs=require('fs'); const paths=JSON.parse(process.argv[1]); for(const p of paths.allow)fs.writeFileSync(p,'cache'); for(const p of paths.deny){let denied=false; try{fs.writeFileSync(p,'BAD')}catch(e){denied=true} if(!denied)process.exit(12)} console.log('cache writes allowed; dependency writes denied');`;
  const { stdout } = await execFileAsync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', script, JSON.stringify({ allow: cacheWritePaths.map(dir => path.join(dir, 'probe')), deny: [path.join(dependency, 'pkg/index.js'), path.join(dependency, 'sibling'), path.join(root, 'outside')] })], { cwd: worktree });
  assert.match(stdout, /cache writes allowed; dependency writes denied/);
  assert.equal(await fs.readFile(path.join(dependency, 'pkg/index.js'), 'utf8'), 'original');
});

test('L354 CLI forwards the bounded retry option for branch and run', async t => {
  const { stdout: help } = await execFileAsync(process.execPath, [fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url)), 'ship', '--help']);
  assert.match(help, /--rerun-flaky-ci 0\|1/);
  for (const value of ['0', '1']) assert.equal(parseShipFlags(['--pr', 'pr.json', '--rerun-flaky-ci', value]).rerunFlakyCi, Number(value));
  assert(!Object.hasOwn(parseShipFlags(['--pr', 'pr.json']), 'rerunFlakyCi'));
  for (const value of ['2', '-1', 'true', '01', '']) assert.throws(() => parseShipFlags(['--pr', 'pr.json', '--rerun-flaky-ci', value]), /--rerun-flaky-ci requires 0 or 1/);
  assert.throws(() => parseShipFlags(['--pr', 'pr.json', '--rerun-flaky-ci']), /--rerun-flaky-ci requires 0 or 1/);
  for (const flags of [['--rerun-flaky', '0', '--rerun-flaky-ci', '1'], ['--rerun-flaky-ci', '0', '--rerun-flaky', '1']]) assert.throws(() => parseShipFlags(['--pr', 'pr.json', ...flags]), /rerun-flaky-ci-conflict: use only one CI retry flag/);
  assert.throws(() => parseTicketArgs(['m.json', '--pr', 'pr.json', '--rerun-flaky-ci', '1']), /unknown ticket flag/);
  const root = await fixture(t);
  await git(root, ['branch', 'base-fixture']);
  await git(root, ['switch', '-c', 'topic-fixture']);
  await put(root, 'src/one.txt', 'topic'); await commit(root);
  const pr = path.join(root, 'pr.json');
  await fs.writeFile(pr, JSON.stringify({ title: 'fixture', head: 'topic-fixture', base: 'base-fixture', body: 'review' }));
  const state = await run(root, manifest(), { spawnImpl: fake("fs.writeFileSync('src/one.txt','proposal')") });
  await integrateRun(root, state.id, { noChecks: true });
  for (const value of [undefined, 0, 1]) {
    const flags = parseShipFlags(['--pr', pr, ...(value === undefined ? [] : ['--rerun-flaky-ci', String(value)])]);
    const seen = [];
    const hooks = { exec: async () => ({ code: 0, stdout: 'topic-fixture' }), shipImpl: async options => { seen.push(options); return { status: 'ready' }; } };
    assert.equal((await shipRun(root, state.id, flags, hooks)).status, 'ready');
    assert.equal((await shipBranch(root, { ...flags, branch: 'topic-fixture' }, hooks)).status, 'ready');
    assert.equal(seen.length, 2);
    for (const options of seen) { assert.equal(options.rerunFlakyCi, value); assert.equal(Object.hasOwn(options, 'rerunFlakyCi'), value !== undefined); }
  }
});

test('L355 mutant review warns about a second writer before mutation', async t => {
  const root = await fixture(t, { 'src/first.js': 'store.approve(host);\n', 'src/second.js': 'store.approve(other);\n', 'tests/ignored.test.js': 'store.approve(test);\n', 'generated/ignored.js': 'store.approve(generated);\n' });
  const mutant = { name: 'remove-first', file: 'src/first.js', find: 'store.approve(host);', replace: '', check: [process.execPath, '-e', 'process.exit(0)'] };
  const warning = 'redundant-writer: remove-first removes store.approve; another call at src/second.js:1 may preserve the effect; target the shared store or reader';
  await put(root, 'mutants.json', JSON.stringify([mutant]));
  const before = await fs.readFile(path.join(root, 'src/first.js'));
  const dry = await runMutantsCurrentTree(root, { mutantsFile: 'mutants.json', dryRun: true }, () => assert.fail('dry-run executed a check'));
  assert(dry.warnings.includes(warning));
  assert.equal(dry.warnings.filter(value => value.startsWith('redundant-writer')).length, 1);
  assert.deepEqual(await fs.readFile(path.join(root, 'src/first.js')), before);
  const controls = new Map([['src/first.js', mutant.find], ['src/second.js', '// store.approve(comment);\n# store.approve(comment);\nother.approve(host);\nfunction store.approve(arg) {}']]);
  assert.deepEqual(redundantWriterWarnings([mutant], controls), []);
  assert.deepEqual(redundantWriterWarnings([{ ...mutant, replace: 'store.approve(other);' }], new Map([['src/first.js', mutant.find], ['src/second.js', 'store.approve(other);']])), []);
  // The planned overlay adds the second call before integration writes any source bytes.
  const overlayRoot = await fixture(t, { 'src/first.js': mutant.find, 'src/second.js': 'unrelated();\n' });
  const spec = { version: 1, jobs: [job({ agent: 'claude', model: 'sonnet', outputs: ['src/second.js'] })], mutants: [mutant] };
  const state = await run(overlayRoot, spec, { spawnImpl: (_cmd, _args, options) => spawn(process.execPath, ['-e', `require('fs').writeFileSync('src/second.js','store.approve(other);\\n');console.log(JSON.stringify({type:'result',subtype:'success',result:'{}'}))`], options) });
  assert.equal(state.status, 'complete', state.error);
  // Red project checks skip real mutant execution while still exercising prevalidated review.
  const saved = JSON.parse(await fs.readFile(path.join(overlayRoot, '.swarm/runs', state.id, 'manifest.json')));
  saved.checks = [{ name: 'fixture-red', argv: [process.execPath, '-e', 'process.exit(1)'] }];
  await put(overlayRoot, `.swarm/runs/${state.id}/manifest.json`, JSON.stringify(saved));
  const integrated = await integrateRun(overlayRoot, state.id, { mutants: true, noFlakeCheck: true });
  assert(integrated.warnings.includes(warning));
  assert.equal(integrated.mutantsSkippedRedBase, true);
});

test('L356 design-only briefs and blocked-test results are explicit', async t => {
  const docs = job({ outputs: ['docs/design.md', 'docs/map.json'] });
  assert(codexMessage(docs).startsWith(DESIGN_ONLY_LINE));
  assert(!codexMessage(docs).includes('Run relevant project tests.'));
  assert(!codexMessage(job({ outputs: [...docs.outputs, 'src/code.js'] })).includes(DESIGN_ONLY_LINE));
  assert(!codexMessage(job({ outputs: ['outside.json'] })).includes(DESIGN_ONLY_LINE));
  const root = await fixture(t);
  const state = await run(root, { version: 1, jobs: [docs] }, { spawnImpl: (_cmd, args, options) => spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(args[args.indexOf('-o') + 1])}, JSON.stringify({status:'blocked',notes:['test failed inside sandbox']}))`], options) });
  assert.equal(state.jobs[0].status, 'blocked');
  const report = await inspectRun(root, state.id);
  assert(report.warnings.some(warning => warning.code === 'design-only-blocked-on-test' && warning.jobId === 'writer'));
  await assert.rejects(integrateRun(root, state.id), error => error.details.warnings.some(warning => warning.code === 'design-only-blocked-on-test'));
  const accepted = await integrateRun(root, state.id, { acceptBlocked: true, noChecks: true });
  assert(accepted.warnings.some(warning => warning.code === 'design-only-blocked-on-test'));
});

test('L352 doctor reports missing inventory executables without running reinstall text', async t => {
  const root = await fixture(t);
  const env = { PATH: '', SWARM_TOOLCHAINS: path.join(root, 'durable') };
  const options = { root, env, home: root, agent: 'openai', access: async file => { if (file !== path.join(env.SWARM_TOOLCHAINS, 'bin', 'present')) throw Error('missing'); }, exec: () => assert.fail('inventory must not execute commands') };
  const absent = await doctor(options);
  assert(!Object.hasOwn(absent.toolchains, 'inventory'));
  await put(root, 'coordination/toolchain-versions.md', '| binary | version | reinstall |\n| --- | --- | --- |\n| `missing` | `1.2` | `$(touch HACKED)` |\n| present | 2 | installer --safe |\n');
  const report = await doctor(options);
  assert.equal(report.status, absent.status);
  assert.deepEqual(report.toolchains.inventory, { rows: [{ binary: 'missing', version: '1.2', reinstall: '$(touch HACKED)', path: null }, { binary: 'present', version: '2', reinstall: 'installer --safe', path: path.join(env.SWARM_TOOLCHAINS, 'bin', 'present') }], warnings: [{ code: 'toolchain-missing', message: 'toolchain-missing: missing (1.2); reinstall: $(touch HACKED)' }] });
  await assert.rejects(fs.access(path.join(root, 'HACKED')));
  const all = await doctorAll({ ...options, platform: 'linux' });
  assert(all.providers.find(provider => provider.agent === 'openai').toolchains.inventory.warnings.length);
  for (const text of ['install missing now', '| binary | version | reinstall |\n| --- | --- | --- |\n| ../bad | 1 | run |', '| binary | version | reinstall |\n| --- | --- | --- |']) {
    await put(root, 'coordination/toolchain-versions.md', text);
    assert.equal((await doctor(options)).toolchains.inventory.warnings[0].code, 'toolchain-inventory-invalid');
  }
  await fs.rename(path.join(root, 'coordination/toolchain-versions.md'), path.join(root, 'saved-inventory.md'));
  await put(root, 'saved-inventory.md', '| binary | version | reinstall |\n| --- | --- | --- |\n| missing | 1 | inert |\n');
  await fs.symlink(path.join(root, 'saved-inventory.md'), path.join(root, 'coordination/toolchain-versions.md'));
  assert.equal((await doctor(options)).toolchains.inventory.warnings[0].code, 'toolchain-inventory-invalid');
  const ancestorRoot = await fixture(t);
  await fs.symlink(path.join(root, 'coordination'), path.join(ancestorRoot, 'coordination'), 'dir');
  assert.equal((await doctor({ ...options, root: ancestorRoot })).toolchains.inventory.warnings[0].code, 'toolchain-inventory-invalid');
  let reads = 0;
  const windows = await toolchainsReport({ root: 'C:\\project', home: 'C:\\home', platform: 'win32', env: { PATH: 'D:\\bin;E:\\tools' }, fsImpl: { stat: async () => ({ isDirectory: () => false }), lstat: async file => ({ isSymbolicLink: () => false, isDirectory: () => !file.endsWith('.md'), isFile: () => file.endsWith('.md'), size: 20 }), readFile: async () => { reads++; return 'binary | version | reinstall\n--- | --- | ---\nuv | 1 | inert'; } }, access: async file => { if (file !== 'E:\\tools\\uv.cmd') throw Error('missing'); } });
  assert.equal(windows.inventory.rows[0].path, 'E:\\tools\\uv.cmd');
  assert.equal(reads, 1);
  assert.deepEqual(windows.inventory.warnings, []);
});
