// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, validateManifest, parseGoFlags } from '../tools/swarm.mjs';
import { usageCostUsd, ledgerPath, readLedger } from '../tools/anthropic.mjs';
import { estimatePlan, formatPreview } from '../tools/plan-preview.mjs';
import { manifestForGoal } from '../tools/goal.mjs';

const exec = promisify(execFile);
const KEY = 'sk-ant-test-0123456789';
const USAGE = { input_tokens: 1000, output_tokens: 200 };
const job = (n, extra = {}) => ({ id: `job-${n}`, agent: 'anthropic', model: 'claude-haiku-5-5', sensitive: true, prompt: `Write out/${n}.txt`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 20000, ...extra });

async function repo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'i']);
  return root;
}
const message = n => ({ type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: 'ok', files: [{ path: `out/${n}.txt`, content: `o${n}\n` }], edits: [] }) }], usage: USAGE });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// Plays the Anthropic API: ordinary messages answer at once; batches are created, polled and read back.
function fakeAnthropic() {
  const seen = { direct: 0, created: [], polls: 0, cancels: 0 };
  const batches = new Map();
  const fetchImpl = async (url, init = {}) => {
    const href = String(url), method = init.method ?? 'GET';
    const n = body => /out\/(\d+)\.txt/.exec(JSON.stringify(body))[1];
    if (href.endsWith('/v1/messages') && method === 'POST') { seen.direct++; return json(message(n(JSON.parse(init.body)))); }
    if (href.endsWith('/v1/messages/batches') && method === 'POST') {
      assert.equal(init.headers['x-api-key'], KEY);
      const { requests } = JSON.parse(init.body);
      const id = `msgbatch_${batches.size + 1}`;
      batches.set(id, requests);
      seen.created.push(requests.map(request => request.custom_id));
      return json({ id, processing_status: 'in_progress', request_counts: {} });
    }
    const batch = /\/v1\/messages\/batches\/(msgbatch_\d+)(\/cancel|\/results)?$/.exec(href);
    if (batch && batch[2] === '/cancel') { seen.cancels++; return json({ id: batch[1], processing_status: 'canceling' }); }
    if (batch && batch[2] === '/results') return new Response(batches.get(batch[1]).map(request => JSON.stringify({ custom_id: request.custom_id, result: { type: 'succeeded', message: message(n(request.params)) } })).join('\n'));
    if (batch) { seen.polls++; return json({ id: batch[1], processing_status: seen.polls > 1 ? 'ended' : 'in_progress', results_url: `https://api.anthropic.com/v1/messages/batches/${batch[1]}/results`, request_counts: {} }); }
    throw new Error(`unexpected ${method} ${href}`);
  };
  return { seen, fetchImpl };
}
const options = (root, fetchImpl, extra = {}) => ({ env: { SWARM_CONFIG: process.env.SWARM_CONFIG, SWARM_SPEND_DIR: path.join(root, '.swarm/spend'), SWARM_LOGS_DIR: path.join(root, '.swarm/logs'), SWARM_ANTHROPIC_API_KEY: KEY }, fetchImpl, batchLimits: { collectMs: 400, pollMs: 10 }, ...extra });

test('--batch sends eligible Anthropic jobs as one batch, at half price, with the usual result', async t => {
  const root = await repo(t), { seen, fetchImpl } = fakeAnthropic();
  // concurrency 2 (the default) would cap how many jobs wait at once if batch jobs held slots; they do not
  const state = await runManifest(root, { version: 1, concurrency: 2, jobs: [job(0), job(1), job(2)] }, { ...options(root, fetchImpl, { batch: true }), id: 'batched' });
  assert.equal(state.status, 'complete', state.jobs.map(entry => entry.error).join('; '));
  assert.equal(seen.direct, 0);
  assert.equal(seen.created.length, 1);
  assert.equal(seen.created[0].length, 3);
  assert.ok(state.jobs.every(entry => entry.batch === true));
  const standard = usageCostUsd('claude-haiku-5-5', USAGE);
  for (const entry of state.jobs) assert.ok(Math.abs(entry.costUsd - standard / 2) < 1e-9, `${entry.costUsd} vs ${standard / 2}`);
  assert.equal(await fs.readFile(path.join(root, state.jobs[1].workspace, 'out/1.txt'), 'utf8'), 'o1\n');
  const rows = readLedger(ledgerPath(options(root, fetchImpl).env));
  // each batch job wrote its worst case before the request and settled it to the real half price when the answer came back
  assert.deepEqual(rows.map(row => row.kind).sort(), ['batch-reservation', 'batch-reservation', 'batch-reservation', 'batch-settle', 'batch-settle', 'batch-settle']);
  assert.ok(rows.filter(row => row.kind === 'batch-reservation').every(row => row.costUsd > standard), 'the reservation is a worst case');
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.costUsd, 0) - 3 * standard / 2) < 1e-9, 'the ledger nets to the real cost');
});

test('without an opt-in nothing is batched; a job can opt in or out; types and the manifest field work', async t => {
  const root = await repo(t);
  let fake = fakeAnthropic();
  let state = await runManifest(root, { version: 1, jobs: [job(0), job(1)] }, { ...options(root, fake.fetchImpl), id: 'plain' });
  assert.equal(state.status, 'complete');
  assert.equal(fake.seen.direct, 2);
  assert.equal(fake.seen.created.length, 0);
  assert.ok(state.jobs.every(entry => entry.batch === undefined));
  fake = fakeAnthropic();
  state = await runManifest(root, { version: 1, jobs: [job(0, { batch: true }), job(1, { batch: false }), job(2)] }, { ...options(root, fake.fetchImpl, { batch: true }), id: 'mixed' });
  assert.equal(state.status, 'complete');
  assert.deepEqual(state.jobs.map(entry => Boolean(entry.batch)), [true, false, true]);
  assert.equal(fake.seen.direct, 1);
  fake = fakeAnthropic();
  state = await runManifest(root, { version: 1, batch: { types: ['build'] }, jobs: [job(0, { type: 'build' }), job(1, { type: 'fix' })] }, { ...options(root, fake.fetchImpl), id: 'types' });
  assert.deepEqual(state.jobs.map(entry => Boolean(entry.batch)), [true, false]);
  fake = fakeAnthropic();
  state = await runManifest(root, { version: 1, batch: true, jobs: [job(0), job(1)] }, { ...options(root, fake.fetchImpl), id: 'manifestflag' });
  assert.ok(state.jobs.every(entry => entry.batch === true));
});

test('batch jobs obey the same caps and reservations: the standard price is reserved, so the cap is never looser', { timeout: 60000 }, async t => {
  const root = await repo(t), { seen, fetchImpl } = fakeAnthropic();
  const jobs = Array.from({ length: 40 }, (_, n) => job(n, { maxOutputTokens: 4000 }));
  const state = await runManifest(root, { version: 1, concurrency: 40, lanes: { anthropic: { concurrency: 40 } }, budget: { maxUsd: 0.05, lanes: { anthropic: { dailyUsd: 0.05 } } }, jobs }, { ...options(root, fetchImpl, { batch: true }), id: 'capped' });
  const sent = seen.created.flat().length;
  const held = state.jobs.filter(entry => entry.status === 'held');
  assert.ok(sent >= 1 && sent < 40, `${sent} requests were sent`);
  assert.equal(held.length + sent, 40);
  assert.ok(held.every(entry => ['run-cap', 'lane-cap'].includes(entry.heldReason)));
  assert.equal(state.status, 'paused');
});

test('a cancelled run cancels its batch', async t => {
  const root = await repo(t), { seen, fetchImpl } = fakeAnthropic();
  const slow = async (url, init) => (/\/batches\/msgbatch_\d+$/.test(String(url)) && (init?.method ?? 'GET') === 'GET' ? json({ id: 'msgbatch_1', processing_status: 'in_progress' }) : fetchImpl(url, init));
  const controller = new AbortController();
  const running = runManifest(root, { version: 1, jobs: [job(0), job(1)] }, { ...options(root, slow, { batch: true }), id: 'cancelled', signal: controller.signal });
  while (seen.created.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  const state = await running;
  assert.ok(['cancelled', 'failed'].includes(state.status));
  assert.equal(seen.cancels, 1);
});

test('batch is validated, parsed from --batch, and shown in the plan as an estimated saving', () => {
  validateManifest({ version: 1, batch: true, jobs: [job(0)] });
  validateManifest({ version: 1, batch: { types: ['docs'] }, jobs: [job(0)] });
  assert.throws(() => validateManifest({ version: 1, jobs: [job(0, { batch: 'yes' })] }), /batch must be true or false/);
  assert.equal(parseGoFlags(['--batch']).batch, true);
  assert.equal(parseGoFlags([]).batch, undefined);
  const manifest = manifestForGoal('do it', { folders: ['src'], leads: 1, maxJobs: 6, concurrency: 2 });
  const lanes = batch => ({ lead: { agent: 'codex', concurrency: 6, price: null }, child: { agent: 'anthropic', model: 'claude-haiku-5-5', concurrency: 16, price: { inPerM: 1, outPerM: 5 }, ...(batch ? { batch: true } : {}) }, runConcurrency: 8 });
  const plain = estimatePlan(manifest, { lanes: lanes(false), calibration: {} });
  const batched = estimatePlan(manifest, { lanes: lanes(true), calibration: {} });
  assert.equal(plain.estimate.batchSavingsUsd, undefined);
  assert.ok(batched.estimate.batchSavingsUsd > 0);
  assert.equal(batched.estimate.costUsd, plain.estimate.costUsd, 'the standard price stays the headline number');
  assert.ok(Math.abs(batched.estimate.batchSavingsUsd - plain.estimate.costUsd / 2) < 1e-3, 'half of the child cost (the lead is free here)');
  assert.match(formatPreview(batched), /Batch: saves about \$[\d.]+ of \$[\d.]+ \(50% on the child jobs\); results can take up to 24 hours/);
  assert.doesNotMatch(formatPreview(plain), /Batch:/);
});

test('review fixes: the worst case is reserved in the Anthropic ledger, so many batch jobs cannot overshoot the day cap', { timeout: 60000 }, async t => {
  const root = await repo(t), { seen, fetchImpl } = fakeAnthropic();
  const configFile = path.join(root, '..', `batch-cap-${path.basename(root)}.json`);
  await fs.writeFile(configFile, JSON.stringify({ spend: { lanes: { anthropic: { dailyUsd: 0.05 } } } }));
  t.after(() => fs.rm(configFile, { force: true }));
  const base = options(root, fetchImpl, { batch: true });
  const env = { ...base.env, SWARM_CONFIG: configFile };
  const jobs = Array.from({ length: 40 }, (_, n) => job(n, { maxOutputTokens: 4000 }));
  const state = await runManifest(root, { version: 1, concurrency: 40, lanes: { anthropic: { concurrency: 40 } }, jobs }, { ...base, env, id: 'ledger-cap' });
  const rows = readLedger(ledgerPath(env));
  const reservations = rows.filter(row => row.kind === 'batch-reservation');
  const worst = Math.max(...reservations.map(row => row.costUsd));
  const sent = seen.created.flat().length;
  assert.ok(sent >= 1 && sent < 40, `${sent} requests were sent`);
  assert.equal(reservations.length, sent);
  const net = rows.reduce((sum, row) => sum + row.costUsd, 0);
  assert.ok(net <= 0.05 + worst, `net ledger ${net} against a day cap of 0.05`);
  // the lane day cap (spend store) holds most; the ledger's own day cap is the second line if anything got past it
  const refused = state.jobs.filter(entry => ['failed', 'held'].includes(entry.status));
  assert.equal(refused.length + sent, 40, 'every job either went out or was stopped by a cap');
  assert.ok(refused.length >= 1 && refused.every(entry => entry.status === 'held' ? /spend-cap|lane-cap|run-cap/.test(entry.error ?? entry.heldReason ?? '') || entry.heldReason : /Anthropic day cap/.test(entry.error)), 'the rest were stopped by a cap, not sent');
});

test('review fixes: an aborted batch request keeps its worst case as spent; the batch id is saved on the job; private data is never batched; the manifest field is validated', async t => {
  const root = await repo(t), { seen, fetchImpl } = fakeAnthropic();
  const stuck = async (url, init) => (/\/batches\/msgbatch_\d+$/.test(String(url)) && (init?.method ?? 'GET') === 'GET' ? json({ id: 'msgbatch_1', processing_status: 'in_progress' }) : fetchImpl(url, init));
  const controller = new AbortController();
  const running = runManifest(root, { version: 1, jobs: [job(0)] }, { ...options(root, stuck, { batch: true }), id: 'aborted', signal: controller.signal });
  while (seen.created.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort();
  const state = await running;
  assert.equal(state.jobs[0].batchId, 'msgbatch_1');
  assert.match(state.jobs[0].batchCustomId, /^job-0-\d+$/);
  const rows = readLedger(ledgerPath(options(root, fetchImpl).env));
  assert.equal(rows.length, 1, 'only the reservation: the real cost is unknown, so the worst case stays');
  assert.equal(rows[0].kind, 'batch-reservation');
  const { batchEligible } = await import('../tools/batch.mjs');
  assert.equal(batchEligible({ agent: 'anthropic', type: 'docs', privateData: true }, { all: true }), false);
  assert.throws(() => validateManifest({ version: 1, batch: 'yes', jobs: [job(0)] }), /batch must be true, false or/);
  assert.throws(() => validateManifest({ version: 1, batch: { types: ['nonsense'] }, jobs: [job(0)] }), /batch must be true, false or/);
  assert.throws(() => validateManifest({ version: 1, batch: { types: 'docs' }, jobs: [job(0)] }), /batch must be true, false or/);
});
