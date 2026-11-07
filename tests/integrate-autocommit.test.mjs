// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, integrateRun, readState } from '../tools/swarm.mjs';
import { integrationBlocker, integrateCheckoutDirtyFromPorcelain } from '../tools/autopilot.mjs';
import { readJournal } from '../tools/journal.mjs';

const exec = promisify(execFile);
const gitEnv = root => ({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', TMPDIR: root });

const job = (n, overrides = {}) => ({
  id: overrides.id ?? `job-${n}`,
  agent: 'ollama',
  model: 'test-model',
  prompt: `Update out/${n}.txt with the intended change.`,
  context: ['input.txt'],
  outputs: [`out/${n}.txt`],
  timeoutMs: 5000,
  ...overrides,
});
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 32, jobs, ...overrides });
const reply = files => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files }) } }), { headers: { 'content-type': 'application/json' } });
const worker = contents => async (_url, options) => {
  const m = /out\/(\d+)\.txt/.exec(options.body);
  const n = m ? Number(m[1]) : 0;
  return reply([{ path: `out/${n}.txt`, content: contents[n] ?? `proposed ${n}\n` }]);
};

async function git(root, ...args) {
  return exec('git', ['-C', root, ...args], { env: { ...process.env, ...gitEnv(root) } });
}

async function fixture(t, { branch = 'swarm/test' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-integrate-commit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.writeFile(path.join(root, 'input.txt'), 'input\n');
  await fs.writeFile(path.join(root, 'out/0.txt'), 'base 0\n');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.name', 'Swarm Test');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'fixture');
  if (branch) {
    if (branch === 'main') {
      await git(root, 'branch', '-M', 'main');
      await git(root, 'checkout', '-q', 'main');
    } else {
      await git(root, 'checkout', '-q', '-b', branch);
    }
  }
  return root;
}

async function log(root) {
  const { stdout } = await git(root, 'log', '-1', '--format=%an|%ae%n%B');
  return stdout;
}

async function porcelain(root) {
  const { stdout } = await git(root, 'status', '--porcelain');
  return stdout.split('\n').filter(line => {
    if (!line.trim()) return false;
    const path = line.slice(3).trim().replace(/^"|"$/g, '');
    if (path === '.swarm' || path.startsWith('.swarm/')) return false;
    return true;
  }).join('\n');
}

test('integrate commits verified output on swarm branch with ticket in message', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0, { id: 'T-0001' })]), { fetchImpl: worker({ 0: 'integrated\n' }) });
  assert.equal(run.status, 'complete');
  const result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.status, 'integrated');
  assert.equal(result.commit?.status, 'committed');
  assert.equal(await porcelain(root), '');
  const message = await log(root);
  assert.match(message, /Swarm Test\|test@example\.invalid/);
  assert.match(message, /swarm integrate: run .+ \(T-0001\): 1 files/);
  assert.match(message, /Swarm-Tickets: T-0001/);
  const state = await readState(root, run.id);
  assert.equal(state.integrationCommit?.status, 'committed');
});

test('second integrate works after first run committed', async t => {
  const root = await fixture(t);
  const run1 = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'first\n' }) });
  await integrateRun(root, run1.id, { noChecks: true });
  const run2 = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'second\n' }) });
  const result = await integrateRun(root, run2.id, { noChecks: true });
  assert.equal(result.commit?.status, 'committed');
  assert.equal(await porcelain(root), '');
});

test('queue integrate commits on swarm branch', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0), job(1)]), { fetchImpl: worker({ 0: 'a\n', 1: 'b\n' }) });
  const result = await integrateRun(root, run.id, { queue: true, batchSize: 1, noChecks: true });
  assert.equal(result.status, 'integrated');
  assert.equal(result.commit?.status, 'committed');
  assert.equal(await porcelain(root), '');
});

test('integrate skips commit on main', async t => {
  const root = await fixture(t, { branch: 'main' });
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'x\n' }) });
  const result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.commit?.status, 'skipped');
  assert.match(result.commit?.reason, /not a swarm/);
  assert.notEqual(await porcelain(root), '');
});

test('integrate skips commit on feature branch and detached HEAD', async t => {
  const root = await fixture(t, { branch: 'feature/x' });
  let run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'x\n' }) });
  let result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.commit?.status, 'skipped');
  await git(root, 'checkout', '-q', '--detach');
  run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'y\n' }) });
  result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.commit?.status, 'skipped');
  assert.match(result.commit?.reason, /not on a branch/);
});

test('failed checks roll back and commit nothing', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)], { checks: [{ name: 'fail', argv: ['false'] }] }), { fetchImpl: worker({ 0: 'bad\n' }) });
  const result = await integrateRun(root, run.id);
  assert.equal(result.status, 'checks-failed');
  assert.equal(result.commit, undefined);
  const { stdout } = await git(root, 'log', '--oneline');
  assert.equal(stdout.trim().split('\n').length, 1);
});

test('pre-existing staged file blocks integration commit', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'other.txt'), 'staged\n');
  await git(root, 'add', 'other.txt');
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'x\n' }) });
  const result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.commit?.status, 'skipped');
  assert.match(result.commit?.reason, /already staged/);
  const { stdout } = await git(root, 'diff', '--cached', '--name-only');
  assert.equal(stdout.trim(), 'other.txt');
});

test('hash mismatch skips commit', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'x\n' }) });
  await integrateRun(root, run.id, { noChecks: true, noCommit: true });
  await fs.writeFile(path.join(root, 'out/0.txt'), 'hand edit\n');
  const state = await readState(root, run.id);
  const { commitIntegratedRun } = await import('../tools/go.mjs');
  const out = await commitIntegratedRun(root, { runId: run.id, state, manifest: manifest([job(0)]), autoCommit: true });
  assert.equal(out.commit?.status, 'skipped');
  assert.match(out.commit?.reason, /hash mismatch/);
});

test('generated state files are not committed', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs/state'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/HANDOFF.md'), 'dirty\n');
  await fs.writeFile(path.join(root, 'coordination/TASK.md'), 'dirty\n');
  await fs.writeFile(path.join(root, 'docs/state/usage-ledger.md'), 'dirty\n');
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'ok\n' }) });
  const result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.commit?.status, 'committed');
  const { stdout } = await git(root, 'show', '--name-only', '--pretty=format:', 'HEAD');
  const files = stdout.trim().split('\n').filter(Boolean);
  assert.deepEqual(files, ['out/0.txt']);
});

test('--no-commit and autoCommit false skip commit', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'x\n' }) });
  let result = await integrateRun(root, run.id, { noChecks: true, noCommit: true });
  assert.equal(result.commit, undefined);
  const run2 = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'y\n' }) });
  result = await integrateRun(root, run2.id, { noChecks: true, autoCommit: false });
  assert.equal(result.commit, undefined);
});

test('go flow does not double commit through integrate', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'go path\n' }) });
  const integrated = await integrateRun(root, run.id, { noChecks: true, autoCommit: false });
  assert.equal(integrated.commit, undefined);
  const { commitOutputs } = await import('../tools/go.mjs');
  const committed = await commitOutputs(root, integrated.files, 'go commit');
  assert.equal(committed.status, 'committed');
  const { stdout } = await git(root, 'log', '--oneline');
  assert.equal(stdout.trim().split('\n').length, 2);
  assert.match(await log(root), /go commit/);
});

test('failing pre-commit hook leaves nothing staged', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.git/hooks'), { recursive: true });
  await fs.writeFile(path.join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', 'utf8');
  await fs.chmod(path.join(root, '.git/hooks/pre-commit'), 0o755);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'x\n' }) });
  const result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.commit?.status, 'failed');
  const { stdout } = await git(root, 'diff', '--cached', '--name-only');
  assert.equal(stdout.trim(), '');
});

test('index.lock retry eventually commits', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'x\n' }) });
  await integrateRun(root, run.id, { noChecks: true, noCommit: true });
  const state = await readState(root, run.id);
  const manifestObj = manifest([job(0)]);
  let commitAttempts = 0;
  const baseExec = (file, args, opts) => new Promise(resolve => {
    execFile(file, args, { ...opts, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...gitEnv(root) } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
  const execImpl = (file, args, opts) => {
    if (file === 'git' && args.includes('commit')) {
      commitAttempts += 1;
      if (commitAttempts === 1) return Promise.resolve({ code: 1, stdout: '', stderr: 'Unable to create .git/index.lock: File exists' });
    }
    return baseExec(file, args, opts);
  };
  const { commitIntegratedRun } = await import('../tools/go.mjs');
  const out = await commitIntegratedRun(root, {
    runId: run.id,
    state,
    manifest: manifestObj,
    exec: execImpl,
    sleepMs: async () => {},
  });
  assert.equal(out.commit?.status, 'committed');
  assert.ok(commitAttempts >= 2);
});

test('journal records integration commit line', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'x\n' }) });
  await integrateRun(root, run.id, { noChecks: true });
  const journal = await readJournal(root, { kinds: ['integration'] });
  const items = Array.isArray(journal) ? journal : journal.items;
  assert.ok(items.some(e => e.status === 'committed' && e.run === run.id));
});

test('autopilot checkout ignores generated state files only', async t => {
  const dirtyGenerated = integrateCheckoutDirtyFromPorcelain(' M coordination/HANDOFF.md\n M docs/state/usage-ledger.md\n');
  assert.equal(dirtyGenerated, false);
  assert.equal(integrationBlocker({ branch: 'swarm/x', dirty: false }), null);
  assert.equal(integrationBlocker({ branch: 'swarm/x', dirty: true }), 'the checkout has uncommitted changes (or could not be checked)');
  const dirtyReal = integrateCheckoutDirtyFromPorcelain(' M src/real.txt\n');
  assert.equal(dirtyReal, true);
});
