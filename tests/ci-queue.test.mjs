// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, integrateQueue } from '../tools/swarm.mjs';
import { hookScriptNames } from '../tools/init-profile.mjs';
import { createLedger, writeLedger, readLedger, approveLedger, isApproved } from '../tools/tickets.mjs';

const exec = promisify(execFile);
const git = (root, ...args) => exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args]);
const job = n => ({ id: `job-${n}`, agent: 'ollama', model: 'test-model', prompt: `Update out/${n}.txt with the intended change.`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 30000 });
const completion = (n, content) => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content }] }) } }), { headers: { 'content-type': 'application/json' } });
const stub = async (_url, options) => { const n = Number(/out\/(\d+)\.txt/.exec(options.body)[1]); return completion(n, `proposed ${n}\n`); };
const node = (code, ...args) => ['node', '-e', code, ...args];

async function fixture(t, count, ci) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ci-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(root, 'input.txt'), 'input\n');
  for (let n = 0; n < count; n++) await fs.writeFile(path.join(root, `out/${n}.txt`), `base ${n}\n`);
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, ...(ci ? { ci } : {}) } }, null, 2));
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\nci-log.txt\n');
  await exec('git', ['init', '-q', root]);
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'fixture');
  return root;
}
const state = async (root, id) => JSON.parse(await fs.readFile(path.join(root, `.swarm/runs/${id}/state.json`), 'utf8'));
// The text to log is passed as an argument, never spliced into the code.
const APPEND = "require('fs').appendFileSync('ci-log.txt', process.argv[1] + String.fromCharCode(10))";

test('smoke and preview hooks run after each green batch and a preview url is recorded', async t => {
  const root = await fixture(t, 2, { smoke: { argv: node(APPEND, 'smoke'), everyBatches: 1 }, preview: { argv: node(`${APPEND};console.log('Ready https://p-1.example.dev')`, 'preview'), everyBatches: 2 } });
  const run = await runManifest(root, { version: 1, concurrency: 4, jobs: [job(0), job(1)] }, { fetchImpl: stub });
  assert.equal(run.status, 'complete', String(run.error));
  const result = await integrateQueue(root, run.id, { batchSize: 1, noChecks: true });
  assert.equal(result.status, 'integrated');
  assert.equal((await fs.readFile(path.join(root, 'ci-log.txt'), 'utf8')), 'smoke\nsmoke\npreview\n');
  const ci = (await state(root, run.id)).mergeQueue.ci;
  assert.deepEqual(ci.map(r => `${r.batch}:${r.kind}:${r.status}`), ['1:smoke:passed', '2:smoke:passed', '2:preview:passed']);
  assert.equal(ci[2].url, 'https://p-1.example.dev');
});

test('a failing smoke hook keeps the batch, warns, and makes a fix ticket; the approval is resealed and records it', async t => {
  const root = await fixture(t, 1, { smoke: { argv: node("console.error('boom in the checkout flow');process.exit(1)"), everyBatches: 1 } });
  const scope = { name: 'Demo', version: 1, hash: 'a'.repeat(64) };
  const base = { title: 'A ticket', type: 'build', stage: 'S1', epic: 'E-01', scopeRefs: ['R-001'], acceptance: ['works'], files: ['out/0.txt'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo' };
  await writeLedger(root, approveLedger(createLedger({ scope, tickets: [{ ...base, id: 'T-0001' }] })));
  const run = await runManifest(root, { version: 1, concurrency: 4, jobs: [job(0)] }, { fetchImpl: stub });
  const result = await integrateQueue(root, run.id, { batchSize: 1, noChecks: true });
  assert.equal(result.status, 'integrated');
  assert.deepEqual(result.integrated.map(entry => entry.job), ['job-0']);
  const saved = await state(root, run.id);
  assert.equal(saved.mergeQueue.ci[0].status, 'failed');
  assert.equal(saved.mergeQueue.ci[0].ticket, 'T-0002');
  const ledger = await readLedger(root);
  const fix = ledger.tickets.find(t => t.id === 'T-0002');
  assert.equal(fix.origin, 'ci');
  assert.match(fix.title, /smoke failure after batch 1/);
  assert.equal(isApproved(ledger), true);
  assert.deepEqual(ledger.approved.ciTickets, ['T-0002']);
});

test('the profile protects the script file a hook runs; a job writing it is refused', async t => {
  const { validateProfile } = await import('../tools/init-profile.mjs');
  const checked = validateProfile({ ci: { smoke: { argv: ['node', 'scripts/smoke.mjs'] }, preview: { argv: ['npm', 'run', 'preview'] } } });
  assert.deepEqual(checked.errors, []);
  assert.ok(checked.profile.protectedPaths.includes('scripts/smoke.mjs'));
  // package.json is not protected as a whole (scaffold tickets must write it); the scripts a hook runs are guarded by the gate.
  assert.ok(!checked.profile.protectedPaths.includes('package.json'));
  assert.deepEqual(hookScriptNames(checked.profile).sort(), ['postpreview', 'prepreview', 'preview']);
  const root = await fixture(t, 1, { smoke: { argv: ['node', 'out/hook.mjs'], everyBatches: 1 } });
  await fs.writeFile(path.join(root, 'out/hook.mjs'), 'process.exit(0);\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'hook script');
  const hookJob = { ...job(0), id: 'job-hook', outputs: ['out/hook.mjs'], prompt: 'Update out/hook.mjs with the intended change.' };
  const fetchImpl = async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: 'out/hook.mjs', content: 'process.exit(1);\n' }] }) } }), { headers: { 'content-type': 'application/json' } });
  // A job that would write the script a hook runs is refused before it starts: the profile protects it.
  const run = await runManifest(root, { version: 1, concurrency: 4, jobs: [hookJob] }, { fetchImpl });
  assert.equal(run.status, 'failed');
  assert.match(String(run.error), /protected-path.*out\/hook\.mjs/);
});

test('without a ci profile no hook runs', async t => {
  const root = await fixture(t, 1, undefined);
  const run = await runManifest(root, { version: 1, concurrency: 4, jobs: [job(0)] }, { fetchImpl: stub });
  await integrateQueue(root, run.id, { batchSize: 1, noChecks: true });
  await assert.rejects(fs.access(path.join(root, 'ci-log.txt')));
  assert.equal((await state(root, run.id)).mergeQueue.ci, undefined);
});
