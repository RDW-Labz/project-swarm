// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { acquireIntegrationLock, runManifest, integrateRun, integrateQueue, redcheckRun } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');
const absent = (root, file) => assert.rejects(fs.stat(path.join(root, file)), { code: 'ENOENT' });
async function fixture(t, checks = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-integrate-safety-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const liveDir = path.join(root, 'live');
  await fs.writeFile(path.join(root, 'old.txt'), 'before\n');
  await fs.chmod(path.join(root, 'old.txt'), 0o755);
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\nlive/\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  const run = await runManifest(root, { version: 1, checks, jobs: [{ id: 'worker', agent: 'ollama', model: 'test-model', prompt: 'Update the files.', context: ['old.txt'], outputs: ['old.txt', 'new.txt'] }] }, {
    liveDir,
    fetchImpl: async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: 'old.txt', content: 'after\n' }, { path: 'new.txt', content: 'created\n' }] }) } })),
  });
  assert.equal(run.status, 'complete', run.jobs[0].error);
  return { root, liveDir, id: run.id };
}
async function noLocks(root, liveDir) {
  await absent(root, '.swarm/integration.lock');
  assert.deepEqual(await fs.readdir(path.join(liveDir, 'locks')), []);
}
async function before(root) {
  assert.equal(await read(root, 'old.txt'), 'before\n');
  assert.equal((await fs.stat(path.join(root, 'old.txt'))).mode & 0o777, 0o755);
  await absent(root, 'new.txt');
}
function launch(t, { root, liveDir, id }) {
  const child = spawn(process.execPath, [cli, '--root', root, 'integrate', id, '--queue'], { env: { ...process.env, SWARM_LIVE_DIR: liveDir }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, stderr })); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, exited };
}
async function marker(root) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await fs.stat(path.join(root, 'checking')).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('queue check did not start');
}
const sleepingCheck = [{ name: 'sleep', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('checking','ready');setTimeout(()=>{},30000)"] }];

test('SIGKILL leaves a durable journal; the next queue recovers bytes, modes and new files before replanning', { timeout: 20000 }, async t => {
  const f = await fixture(t, sleepingCheck);
  const previous = await fs.readFile(path.join(f.root, 'old.txt'));
  const previousMode = (await fs.stat(path.join(f.root, 'old.txt'))).mode & 0o777;
  await absent(f.root, 'new.txt');
  const { child, exited } = launch(t, f);
  await marker(f.root);
  assert.equal(await read(f.root, 'old.txt'), 'after\n');
  assert.equal(await read(f.root, 'new.txt'), 'created\n');
  child.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  const journal = JSON.parse(await read(f.root, '.swarm/integration-journal.json'));
  assert.equal(journal.kind, 'queue-batch');
  assert.deepEqual(journal.entries.map(entry => [entry.file, entry.previous, entry.mode]), [['old.txt', previous.toString('base64'), previousMode], ['new.txt', null, 0o644]]);
  // Simulate a check which chmods a file too; recovery must restore the saved mode.
  await fs.chmod(path.join(f.root, 'old.txt'), 0o600);
  const savedManifest = path.join(f.root, `.swarm/runs/${f.id}/manifest.json`);
  const spec = JSON.parse(await fs.readFile(savedManifest, 'utf8'));
  spec.preChecks = [[process.execPath, '-e', `const fs=require('node:fs');if(fs.readFileSync('old.txt').toString('base64')!==${JSON.stringify(previous.toString('base64'))}||fs.existsSync('new.txt')||(fs.statSync('old.txt').mode&511)!==${previousMode})process.exit(7)`]];
  await fs.writeFile(savedManifest, JSON.stringify(spec));
  const result = await integrateQueue(f.root, f.id, { liveDir: f.liveDir, noChecks: true });
  assert.deepEqual(result.recoveredJournal, { runId: f.id, kind: 'queue-batch', jobs: ['worker'], files: 2 });
  assert.ok(result.warnings.some(warning => warning.startsWith('integrate-journal-rolled-back:')));
  assert.equal(result.status, 'integrated');
  assert.equal(await read(f.root, 'old.txt'), 'after\n');
  assert.equal(await read(f.root, 'new.txt'), 'created\n');
  await absent(f.root, '.swarm/integration-journal.json');
  await noLocks(f.root, f.liveDir);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) test(`${signal} rolls back the batch and releases both locks without waiting for the sleeping check`, { timeout: 15000 }, async t => {
  const f = await fixture(t, sleepingCheck);
  const { child, exited } = launch(t, f);
  await marker(f.root);
  await fs.chmod(path.join(f.root, 'old.txt'), 0o600);
  const start = Date.now();
  child.kill(signal);
  assert.equal((await exited).code, code);
  assert.ok(Date.now() - start < 5000);
  await before(f.root);
  await absent(f.root, '.swarm/integration-journal.json');
  await noLocks(f.root, f.liveDir);
});

test('live owner refuses plain, queue and redcheck; dead owner clears with a warning', async t => {
  const f = await fixture(t);
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => sleeper.once('exit', resolve));
  t.after(() => sleeper.kill('SIGKILL'));
  const held = await acquireIntegrationLock(f.root, { runId: 'owner', liveDir: f.liveDir, pid: sleeper.pid });
  for (const options of [{}, { queue: true }]) await assert.rejects(integrateRun(f.root, f.id, { ...options, liveDir: f.liveDir, noChecks: true }), { code: 'integrate-locked' });
  const red = await redcheckRun(f.root, f.id, [process.execPath, '-e', '0'], { liveDir: f.liveDir });
  assert.equal(red.status, 'error');
  assert.match(red.tail, /integrate-locked/);
  sleeper.kill('SIGKILL'); await exited;
  const result = await integrateRun(f.root, f.id, { liveDir: f.liveDir, noChecks: true });
  assert.equal(result.warnings.filter(warning => warning.startsWith('integrate-lock-stale-cleared:')).length, 2);
  await absent(f.root, '.swarm/integration-journal.json');
  await noLocks(f.root, f.liveDir);
  // Ownership has moved and been released; do not release the old holder.
  assert.equal(typeof held.release, 'function');
});

test('worktrees share the repository lock, and a refused root lock releases the repo lock', async t => {
  const f = await fixture(t);
  const other = path.join(f.root, 'other');
  await exec('git', ['-C', f.root, 'worktree', 'add', '--detach', other, 'HEAD']);
  const lock = await acquireIntegrationLock(f.root, { runId: 'first', liveDir: f.liveDir });
  try { await assert.rejects(acquireIntegrationLock(other, { runId: 'second', liveDir: f.liveDir }), { code: 'integrate-locked' }); }
  finally { await lock.release(); }
  await fs.mkdir(path.join(f.root, '.swarm/integration.lock'));
  await assert.rejects(integrateRun(f.root, f.id, { liveDir: f.liveDir }), { code: 'integrate-locked' });
  assert.deepEqual(await fs.readdir(path.join(f.liveDir, 'locks')), []);
  await fs.rmdir(path.join(f.root, '.swarm/integration.lock'));
  await fs.writeFile(path.join(f.root, 'old.txt'), 'conflict');
  await assert.rejects(integrateRun(f.root, f.id, { liveDir: f.liveDir }), /Integration conflict/);
  await noLocks(f.root, f.liveDir);
});

test('fresh ownerless locks refuse; old malformed locks clear, and remote owners stay held', async t => {
  const f = await fixture(t);
  const lock = path.join(f.root, '.swarm/integration.lock');
  await fs.mkdir(lock);
  await assert.rejects(acquireIntegrationLock(f.root, { runId: f.id, liveDir: f.liveDir }), { code: 'integrate-locked' });
  await fs.writeFile(path.join(lock, 'owner.json'), '{broken');
  const old = new Date(Date.now() - 61000);
  await fs.utimes(lock, old, old);
  const held = await acquireIntegrationLock(f.root, { runId: f.id, liveDir: f.liveDir });
  assert.equal(held.warnings.length, 1);
  assert.match(held.warnings[0], /integrate-lock-stale-cleared: .*pid unknown/);
  await held.release();
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 1, host: `${os.hostname()}-remote` }));
  await fs.utimes(lock, old, old);
  await assert.rejects(acquireIntegrationLock(f.root, { runId: f.id, liveDir: f.liveDir, isAlive: () => false }), { code: 'integrate-locked' });
  assert.deepEqual(await fs.readdir(path.join(f.liveDir, 'locks')), []);
});

test('plain integrate and redcheck recover a leftover plain journal before validation', async t => {
  for (const redcheck of [false, true]) {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, 'old.txt'), 'interrupted write');
    await fs.chmod(path.join(f.root, 'old.txt'), 0o600);
    await fs.writeFile(path.join(f.root, 'new.txt'), 'interrupted creation');
    await fs.writeFile(path.join(f.root, '.swarm/integration-journal.json'), JSON.stringify({ version: 1, runId: 'crashed', pid: 1, startedAt: new Date().toISOString(), kind: 'integrate', jobs: ['worker'], entries: [{ file: 'old.txt', previous: Buffer.from('before\n').toString('base64'), mode: 0o755 }, { file: 'new.txt', previous: null, mode: 0o644 }] }));
    const result = redcheck
      ? await redcheckRun(f.root, f.id, [process.execPath, '-e', 'process.exit(1)'], { liveDir: f.liveDir })
      : await integrateRun(f.root, f.id, { noChecks: true, liveDir: f.liveDir });
    assert.deepEqual(result.recoveredJournal, { runId: 'crashed', kind: 'integrate', jobs: ['worker'], files: 2 });
    assert.ok(result.warnings.some(warning => warning.startsWith('integrate-journal-rolled-back: run crashed integrate')));
    assert.equal(await read(f.root, 'old.txt'), 'after\n');
    await absent(f.root, '.swarm/integration-journal.json');
    await noLocks(f.root, f.liveDir);
  }
});

test('resuming a running pass skips already applied jobs and replans unfinished jobs', async t => {
  const f = await fixture(t);
  const stateFile = path.join(f.root, `.swarm/runs/${f.id}/state.json`);
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  saved.integratedAt = new Date().toISOString();
  saved.integrationStatus = 'queued';
  saved.mergeQueue = { state: 'running', integrated: ['worker'] };
  await fs.writeFile(stateFile, JSON.stringify(saved));
  await fs.writeFile(path.join(f.root, 'old.txt'), 'after\n');
  await fs.writeFile(path.join(f.root, 'new.txt'), 'created\n');
  const result = await integrateRun(f.root, f.id, { queue: true, liveDir: f.liveDir, spawnImpl: () => assert.fail('already applied jobs need no check') });
  assert.deepEqual(result.mergeQueue.conflicts, []);
  assert.deepEqual(result.mergeQueue.integrated, ['worker']);
  assert.deepEqual(result.files, []);
  await noLocks(f.root, f.liveDir);
});
