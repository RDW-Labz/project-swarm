// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { git } from '../tools/codex-adapter.mjs';
import { resolveWorktree, worktreesBaseFor, listOrphanWorktrees, executeCodexJob, runManifest, inspectRun, integrateRun, cancelRun } from '../tools/swarm.mjs';

const job = (overrides = {}) => ({ id: 'writer', agent: 'codex', model: 'test-model', prompt: 'Update the output and test it.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 5000, ...overrides });
const manifest = overrides => ({ version: 1, jobs: [job(overrides)] });
const envelope = JSON.stringify({ files_changed: ['output.txt'], notes: ['Fake worker completed.'] });
const success = `if(fs.readFileSync('input.txt','utf8')!=='committed context')process.exit(8);fs.writeFileSync('output.txt','proposed');fs.writeFileSync(result,${JSON.stringify(envelope)});`;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t86-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await fs.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fs.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return root;
}

async function worktreeConfig(t) {
  const worktreesDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t86-worktrees-')));
  t.after(() => fs.rm(worktreesDir, { recursive: true, force: true }));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t86-config-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const config = { worktreesOutsideRoot: true, worktreesDir };
  const configFile = path.join(configDir, 'config.json');
  await fs.writeFile(configFile, JSON.stringify(config));
  return { configFile, config, worktreesDir };
}

function fake(script, observe = () => {}) {
  return (command, args, options) => {
    observe(command, args, options);
    assert.equal(command, 'sandbox-exec');
    assert.equal(options.detached, true);
    assert.equal(options.shell, false);
    assert.equal(options.stdio[0], 'ignore');
    return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; const result = ${JSON.stringify(args[args.indexOf('-o') + 1])}; ${script}`], options);
  };
}

test('run places worktree outside root when flag on', async t => {
  const root = await fixture(t);
  const { configFile } = await worktreeConfig(t);
  const env = { ...process.env, SWARM_CONFIG: configFile };
  let received;
  const state = await runManifest(root, manifest(), { platform: 'darwin', env, spawnImpl: fake(success, (command, args, options) => { received = { options }; }) });
  assert.equal(state.status, 'complete', state.error ?? state.jobs[0]?.error);
  const worktreePath = state.jobs[0].worktreePath;
  assert.equal(received.options.cwd, worktreePath);
  const relative = path.relative(root, worktreePath);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative));
  assert.equal(typeof state.worktreesBase === 'string' && state.worktreesBase.length > 0, true);
  const shimLocation = resolveWorktree({ root, id: state.id }, { id: 'writer' });
  await assert.rejects(fs.access(path.dirname(shimLocation)));
  await assert.rejects(fs.access(worktreePath));
});

test('state records worktreePath before checkout', async t => {
  const root = await fixture(t);
  const { configFile, config } = await worktreeConfig(t);
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const id = 'worktree-precreate';
  const base = await worktreesBaseFor(root, config, { env });
  const expected = resolveWorktree({ root, id, worktreesBase: base }, { id: 'writer' });
  await fs.mkdir(expected, { recursive: true });
  await fs.writeFile(path.join(expected, 'blocker.txt'), 'occupied');
  let firstWorktreeGitExists;
  const onState = state => {
    const record = state.jobs[0];
    if (firstWorktreeGitExists === undefined && record?.worktreePath) firstWorktreeGitExists = existsSync(path.join(record.worktreePath, '.git'));
  };
  const state = await runManifest(root, manifest(), { platform: 'darwin', env, id, onState });
  assert.equal(state.jobs[0].worktreePath, expected);
  const onDisk = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'runs', id, 'state.json'), 'utf8'));
  assert.equal(onDisk.jobs[0].worktreePath, expected);
  assert.equal(firstWorktreeGitExists, false);
});

test('inspect follows recorded path for failed job', async t => {
  const root = await fixture(t);
  const { configFile } = await worktreeConfig(t);
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const script = `fs.writeFileSync('output.txt','proposed');process.exit(7);`;
  const state = await runManifest(root, manifest(), { platform: 'darwin', env, spawnImpl: fake(script) });
  assert.equal(state.jobs[0].status, 'failed');
  const worktreePath = state.jobs[0].worktreePath;
  const inspected = await inspectRun(root, state.id);
  assert.equal(inspected.jobs[0].worktree, worktreePath);
  await fs.access(worktreePath);
  assert.equal(worktreePath.startsWith(root + path.sep), false);
});

test('blocked reply keeps evidence at recorded path', async t => {
  const root = await fixture(t);
  const { configFile } = await worktreeConfig(t);
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const blockedReply = JSON.stringify({ status: 'blocked', summary: 'needs x' });
  const script = `fs.writeFileSync('output.txt','proposed');fs.writeFileSync(result,${JSON.stringify(blockedReply)});`;
  const state = await runManifest(root, manifest({ outputs: ['output.txt', 'missing.txt'] }), { platform: 'darwin', env, spawnImpl: fake(script) });
  assert.equal(state.jobs[0].status, 'blocked');
  const worktreePath = state.jobs[0].worktreePath;
  assert.equal(state.jobs[0].keptWorkspace, worktreePath);
  assert.equal(await fs.readFile(path.join(worktreePath, 'output.txt'), 'utf8'), 'proposed');
});

test('no-json reply with changed outputs falls back to worktree result at recorded path', async t => {
  const root = await fixture(t);
  const { configFile } = await worktreeConfig(t);
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const script = `fs.writeFileSync('output.txt','proposed');fs.writeFileSync(result,'no JSON in this reply, just prose');`;
  const state = await runManifest(root, manifest(), { platform: 'darwin', env, spawnImpl: fake(script) });
  assert.equal(state.status, 'complete', state.error ?? state.jobs[0]?.error);
  assert.equal(state.jobs[0].envelopeFallback, 'worktree');
  const worktreePath = state.jobs[0].worktreePath;
  assert.equal(state.jobs[0].keptWorkspace, worktreePath);
  await fs.access(worktreePath);
  assert.equal(worktreePath.startsWith(root + path.sep), false);
  assert.equal((await git(root, ['worktree', 'list', '--porcelain'])).includes(worktreePath), true);
});

test('shim finds worktree in old location when worktreePath missing', async t => {
  const root = await fixture(t);
  const { configFile } = await worktreeConfig(t);
  await fs.writeFile(configFile, JSON.stringify({ worktreesOutsideRoot: false }));
  const script = `fs.writeFileSync('output.txt','proposed');process.exit(7);`;
  const state = await runManifest(root, manifest(), { platform: 'darwin', env: { ...process.env, SWARM_CONFIG: configFile }, spawnImpl: fake(script) });
  assert.equal(state.jobs[0].status, 'failed');
  const stateFile = path.join(root, '.swarm', 'runs', state.id, 'state.json');
  const onDisk = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  delete onDisk.jobs[0].worktreePath;
  await fs.writeFile(stateFile, JSON.stringify(onDisk));
  // The one shim literal this contract allows by hand (section 4.1 test 6): it is what the shim under test must reproduce.
  const oldLocation = path.join(root, '.swarm', 'runs', state.id, 'worktrees', 'writer');
  const inspected = await inspectRun(root, state.id);
  assert.equal(inspected.jobs[0].worktree, oldLocation);
  await fs.access(oldLocation);

  const recordedWins = resolveWorktree({ root, id: state.id, worktreesBase: '/outside/base' }, { id: 'writer', worktreePath: '/recorded/path' });
  assert.equal(recordedWins, '/recorded/path');
  const baseWins = resolveWorktree({ root, id: state.id, worktreesBase: '/outside/base' }, { id: 'writer' });
  assert.equal(baseWins, path.join('/outside/base', state.id, 'writer'));
  const neitherGivesOldLayout = resolveWorktree({ root, id: state.id }, { id: 'writer' });
  assert.equal(neitherGivesOldLayout, oldLocation);
});

test('root tree walk finds no swarm copy', async t => {
  const root = await fixture(t);
  const { configFile } = await worktreeConfig(t);
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const script = `fs.writeFileSync('output.txt','proposed');fs.writeFileSync(result,'no JSON in this reply, just prose');`;
  const state = await runManifest(root, manifest(), { platform: 'darwin', env, spawnImpl: fake(script) });
  assert.equal(state.jobs[0].envelopeFallback, 'worktree');
  const worktreePath = state.jobs[0].worktreePath;
  const rootEntries = await fs.readdir(root, { recursive: true });
  assert.equal(rootEntries.filter(entry => entry === 'input.txt').length, 1);
  await fs.access(path.join(worktreePath, 'input.txt'));
});

test('integrate copies from recorded path', async t => {
  const root = await fixture(t);
  const { configFile } = await worktreeConfig(t);
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const script = `fs.writeFileSync('output.txt','proposed');fs.writeFileSync(result,'no JSON in this reply, just prose');`;
  const state = await runManifest(root, manifest(), { platform: 'darwin', env, spawnImpl: fake(script) });
  const worktreePath = state.jobs[0].worktreePath;
  const result = await integrateRun(root, state.id);
  assert.deepEqual(result.files, ['output.txt']);
  assert.equal(await fs.readFile(path.join(root, 'output.txt'), 'utf8'), await fs.readFile(path.join(worktreePath, 'output.txt'), 'utf8'));
});

test('cancel removes scratch dir but keeps failed-job dirs', async t => {
  const root = await fixture(t);
  const { configFile } = await worktreeConfig(t);
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const id = 'cancel-worktree-dirs';
  let cancelTriggered = false;
  const state = await runManifest(root, { version: 1, concurrency: 2, jobs: [job({ id: 'writer' }), job({ id: 'slow', outputs: ['slow.txt'] })] }, {
    platform: 'darwin', env, id,
    onState: s => {
      const writer = s.jobs.find(j => j.id === 'writer');
      if (!cancelTriggered && writer?.status === 'failed') { cancelTriggered = true; cancelRun(root, id).catch(() => {}); }
    },
    spawnImpl: (command, args, options) => {
      const isWriter = options.cwd.endsWith(path.sep + 'writer');
      return fake(isWriter ? `fs.writeFileSync('output.txt','proposed');process.exit(7);` : `setInterval(()=>{},1000)`)(command, args, options);
    },
  });
  assert.equal(state.status, 'cancelled');
  const writerRecord = state.jobs.find(j => j.id === 'writer');
  const slowRecord = state.jobs.find(j => j.id === 'slow');
  await fs.access(writerRecord.worktreePath);
  assert.equal(typeof slowRecord.worktreePath === 'string' && slowRecord.worktreePath.length > 0, true);
  await assert.rejects(fs.access(slowRecord.worktreePath));
});

test('symlinked temp root resolves to real path', async t => {
  const root = await fixture(t);
  const target = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t86-target-')));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  const aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t86-alias-'));
  t.after(() => fs.rm(aliasParent, { recursive: true, force: true }));
  const worktreesDir = path.join(aliasParent, 'alias');
  await fs.symlink(target, worktreesDir, 'dir');
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t86-config-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const configFile = path.join(configDir, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ worktreesOutsideRoot: true, worktreesDir }));
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const state = await runManifest(root, manifest(), { platform: 'darwin', env, spawnImpl: fake(success) });
  assert.equal(state.status, 'complete', state.error ?? state.jobs[0]?.error);
  const worktreePath = state.jobs[0].worktreePath;
  const realTarget = await fs.realpath(target);
  assert.equal(worktreePath.startsWith(realTarget + path.sep), true);
  assert.equal(worktreePath.startsWith(worktreesDir), false);
});

test('low free space refuses checkout with worktree-disk-low', async t => {
  const root = await fixture(t);
  const scratchParent = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t86-disk-'));
  t.after(() => fs.rm(scratchParent, { recursive: true, force: true }));
  const worktreePath = path.join(scratchParent, 'run-id', 'writer');
  const gitImpl = async (dir, args) => {
    if (args[0] === 'worktree' && args[1] === 'add') throw new Error('must not reach worktree add');
    return `${root}\n`;
  };
  const statfsImpl = async () => ({ bavail: 1, bsize: 4096 });
  const result = await executeCodexJob(root, '.swarm/runs/disk-low', job(), root, {
    spawnImpl: () => assert.fail('must not spawn'), env: process.env, portBase: 40000, worktreePath, gitImpl, statfsImpl,
  });
  assert.equal(result.refusedBeforeStart, true);
  assert.match(result.error, /^worktree-disk-low:/);
});

test('orphans lists unreferenced scratch dirs without deleting', async t => {
  const root = await fixture(t);
  const { configFile, config } = await worktreeConfig(t);
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const base = await worktreesBaseFor(root, config, { env });
  const ghostDir = path.join(base, 'ghost-run', 'job');
  await fs.mkdir(ghostDir, { recursive: true });
  const report = await listOrphanWorktrees(root, { env });
  assert.equal(report.orphans.includes(ghostDir), true);
  assert.equal(report.deleted, 0);
  await fs.access(ghostDir);
});
