// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, resumeRun, writeRunLedger, integrateRun, validateManifest } from '../tools/swarm.mjs';
import { reserveSpend, resolveBudget } from '../tools/spend.mjs';
import { rollupRun } from '../tools/reports.mjs';
import { renderMonitorView } from '../tools/monitor-view.mjs';

const exec = promisify(execFile);
const job = (n, extra = {}) => ({ id: `job-${n}`, agent: 'ollama', model: 'test-model', prompt: `Write out/${n}.txt`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 5000, ...extra });
const manifest = (jobs, extra = {}) => ({ version: 1, concurrency: 1, jobs, ...extra });
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const paidJob = (n, extra = {}) => job(n, { agent: 'openrouter', model: 'test/model', sensitive: false, maxOutputTokens: 1000, ...extra });
function paidWorker(calls, { cost = 0.45, usage = true, delayMs = 0 } = {}) {
  return async (_url, request) => {
    if (!request?.body) return reply({ data: [{ id: 'test/model', pricing: { prompt: '0', completion: '0.0005' } }] });
    const n = Number(/out\/(\d+)\.txt/.exec(request.body)[1]);
    calls.push(n);
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return reply({ ...(usage ? { usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100, ...(cost === null ? {} : { cost }) } } : {}), choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: 'done' }] }) } }] });
  };
}
const paidOptions = options => ({ ...options, env: { ...options.env, OPENROUTER_API_KEY: 'sk-or-test', SWARM_LOGS_DIR: path.join(options.root, '.swarm/provider-logs') } });
const storeEntries = async options => Object.values(JSON.parse(await fs.readFile(path.join(options.env.SWARM_SPEND_DIR, 'daily.json'), 'utf8')).entries);
function worker(calls) {
  return async (_url, options) => {
    const n = Number(/out\/(\d+)\.txt/.exec(options.body)[1]);
    calls.push(n);
    return reply({ done: true, done_reason: 'stop', usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 }, prompt_eval_count: 60, eval_count: 40, message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: `output ${n}\n` }] }) } });
  };
}
async function fixture(t, config = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-spend-run-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'original input\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify(config));
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') }, liveDir: path.join(temp, 'live') };
}

test('run cap holds launches; resume raises explicitly and preserves complete records and ledger rows', async t => {
  const options = await fixture(t), calls = [];
  const spec = manifest(Array.from({ length: 5 }, (_, n) => job(n)), { budget: { maxTokens: 250 } });
  const state = await runManifest(options.root, spec, { ...options, fetchImpl: worker(calls) });
  assert.equal(state.status, 'paused', JSON.stringify(state.jobs.map(record => record.usage)));
  assert.deepEqual(calls, [0, 1, 2]);
  assert.deepEqual(state.jobs.map(record => record.status), ['complete', 'complete', 'complete', 'held', 'held']);
  assert.deepEqual(state.jobs.slice(3).map(record => record.attempts.length), [0, 0]);
  await assert.rejects(fs.stat(path.join(options.root, state.jobs[3].workspace)), { code: 'ENOENT' });
  const before = structuredClone(state.jobs.slice(0, 3));
  await assert.rejects(resumeRun(options.root, state.id, options), { code: 'resume-over-cap' });
  await assert.rejects(resumeRun(options.root, state.id, { ...options, raises: [{ key: 'maxTokens', value: 1000 }] }), { code: 'budget-raise-reason' });
  await assert.rejects(integrateRun(options.root, state.id, options), { code: 'run-paused' });
  const resumed = await resumeRun(options.root, state.id, { ...options, fetchImpl: worker(calls), raises: [{ key: 'maxTokens', value: 1000 }], reason: 'finish approved work' });
  assert.equal(resumed.status, 'complete', resumed.error);
  assert.deepEqual(calls, [0, 1, 2, 3, 4]);
  assert.deepEqual(resumed.jobs.slice(0, 3), before);
  assert.equal(resumed.budgetRaises[0].reason, 'finish approved work');
  assert.equal(resumed.ledgerKeys.length, 5);
  assert.deepEqual(await writeRunLedger(options.root, state.id), { path: '.swarm/usage-ledger.md', added: 0 });
  const text = await fs.readFile(path.join(options.root, resumed.ledger.path), 'utf8');
  assert.equal(text.split('\n').filter(line => line.includes('| job-')).length, 5);
  await assert.rejects(resumeRun(options.root, state.id, options), { code: 'resume-not-paused' });
});

test('held dependencies stay queued and dispatch in order on resume', async t => {
  const options = await fixture(t), calls = [];
  const state = await runManifest(options.root, manifest([job(0), job(1), job(2, { after: ['job-1'] }), job(3, { after: ['job-2'] })], { budget: { maxTokens: 100 } }), { ...options, fetchImpl: worker(calls) });
  assert.equal(state.status, 'paused');
  assert.equal(state.jobs[2].status, 'queued');
  assert.equal(state.jobs[2].heldReason, 'after job-1 held');
  const resumed = await resumeRun(options.root, state.id, { ...options, fetchImpl: worker(calls), raises: [{ key: 'maxTokens', value: 1000 }], reason: 'approved' });
  assert.equal(resumed.status, 'complete', resumed.error);
  assert.deepEqual(calls, [0, 1, 2, 3]);
  assert.ok(resumed.jobs.every(record => !record.heldReason));
});

test('resume refuses a changed snapshot before dispatch', async t => {
  const options = await fixture(t), calls = [];
  const state = await runManifest(options.root, manifest([job(0), job(1)], { budget: { maxTokens: 100 } }), { ...options, fetchImpl: worker(calls) });
  await fs.writeFile(path.join(options.root, 'input.txt'), 'changed');
  await assert.rejects(resumeRun(options.root, state.id, { ...options, raises: [{ key: 'maxTokens', value: 1000 }], reason: 'approved', fetchImpl: worker(calls) }), { code: 'resume-snapshot-changed' });
  assert.deepEqual(calls, [0]);
});

test('quota pause waits with a local idle commit then resumes only held jobs', async t => {
  const options = await fixture(t), calls = [];
  let time = Date.now();
  const head = (await exec('git', ['-C', options.root, 'rev-parse', 'HEAD'])).stdout;
  const state = await runManifest(options.root, manifest([job(0), job(1)], { lanes: { ollama: { pauseMs: 60000, maxPauseMs: 1 } }, idle: [{ name: 'tidy', argv: [process.execPath, '-e', "require('fs').writeFileSync('idle.txt','done')"] }] }), { ...options, now: () => time, fetchImpl: async () => new Response('quota', { status: 402 }) });
  assert.equal(state.status, 'paused', state.error);
  assert.ok(state.jobs.every(record => record.heldReason === 'quota'));
  assert.equal(state.jobs[1].status, 'provider-limit');
  await assert.rejects(resumeRun(options.root, state.id, { ...options, now: () => time }), { code: 'resume-too-early' });
  const sleeps = [];
  const resumed = await resumeRun(options.root, state.id, { ...options, wait: true, now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; }, fetchImpl: worker(calls) });
  assert.equal(resumed.status, 'complete', resumed.error);
  assert.deepEqual(sleeps, [60000]);
  assert.deepEqual(calls, [0, 1]);
  assert.equal((await exec('git', ['-C', options.root, 'rev-parse', 'HEAD'])).stdout, head);
  const idle = JSON.parse(await fs.readFile(path.join(options.root, '.swarm/runs', state.id, 'idle.json'), 'utf8'));
  assert.equal(idle[0].results[0].status, 'committed');
  assert.equal(resumed.ledgerKeys.length, 3);
});

test('daily lane spend holds direct jobs before any provider call', async t => {
  const options = await fixture(t);
  await reserveSpend({ dir: options.env.SWARM_SPEND_DIR, key: 'earlier/paid#1', lane: 'openrouter', runId: 'earlier', root: options.root, jobId: 'paid', usd: 5, tokens: 100, budget: resolveBudget(), runTotals: {} });
  const state = await runManifest(options.root, manifest([job(0, { agent: 'openrouter', model: 'test/model', sensitive: false })]), { ...options, env: { ...options.env, OPENROUTER_API_KEY: 'sk-or-test' }, fetchImpl: async () => { throw Error('must not call provider'); } });
  assert.equal(state.status, 'paused', state.error);
  assert.equal(state.jobs[0].heldReason, 'lane-cap');
  assert.equal(state.jobs[0].attempts.length, 0);
});

test('USD cap permits the third forty-cent job and holds the last two', async t => {
  const options = await fixture(t), calls = [];
  const jobs = Array.from({ length: 5 }, (_, n) => job(n, { agent: 'openrouter', model: 'test/model', sensitive: false }));
  const state = await runManifest(options.root, manifest(jobs, { budget: { maxUsd: 1 } }), {
    ...options, env: { ...options.env, OPENROUTER_API_KEY: 'sk-or-test' },
    fetchImpl: async (_url, request) => {
      if (!request?.body) return reply({ data: [{ id: 'test/model', pricing: { prompt: '0.000002', completion: '0.00001' } }] });
      const n = Number(/out\/(\d+)\.txt/.exec(request.body)[1]); calls.push(n);
      return reply({ usage: { prompt_tokens: 100000, completion_tokens: 20000, total_tokens: 120000, cost: 0.4 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: 'done' }] }) } }] });
    },
  });
  assert.equal(state.status, 'paused', state.error);
  assert.deepEqual(calls, [0, 1, 2]);
  assert.ok(state.jobs.slice(3).every(record => record.heldReason === 'run-cap'));
});

test('auto routing treats a capped cheap lane as paused and selects the next cheap lane', async t => {
  const options = await fixture(t, { spend: { lanes: { hermes: { dailyTokens: 100 } } } });
  await reserveSpend({ dir: options.env.SWARM_SPEND_DIR, key: 'earlier/paid#1', lane: 'hermes', runId: 'earlier', root: options.root, jobId: 'paid', usd: 0, tokens: 100, budget: resolveBudget(), runTotals: {} });
  const auto = job(0, { agent: 'auto', sensitive: false }); delete auto.model;
  const state = await runManifest(options.root, manifest([auto], { lanes: { hermes: { model: 'test-model' }, openrouter: { model: 'test/model' } } }), {
    ...options, env: { ...options.env, OPENROUTER_API_KEY: 'sk-or-test' },
    spawnImpl: () => { throw Error('capped Hermes must not launch'); },
    fetchImpl: async (_url, request) => !request?.body ? reply({ data: [{ id: 'test/model', pricing: { prompt: '0.000002', completion: '0.00001' } }] }) : reply({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: 'out/0.txt', content: 'done' }] }) } }] }),
  });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(state.jobs[0].agent, 'openrouter');
});

test('resume CLI returns 75 if a quota-held job meets a lane cap before dispatch', async t => {
  const options = await fixture(t);
  const state = await runManifest(options.root, manifest([job(0)], { budget: { lanes: { ollama: { dailyTokens: 100 } } }, lanes: { ollama: { pauseMs: 1 } } }), { ...options, fetchImpl: async () => new Response('quota', { status: 402 }) });
  assert.equal(state.status, 'paused');
  await reserveSpend({ dir: options.env.SWARM_SPEND_DIR, key: 'earlier/paid#1', lane: 'ollama', runId: 'earlier', root: options.root, jobId: 'paid', usd: 0, tokens: 100, budget: resolveBudget(), runTotals: {} });
  const result = spawnSync(process.execPath, ['tools/swarm.mjs', '--root', options.root, 'resume', state.id], { encoding: 'utf8', env: options.env });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'paused');
});

test('ledger selects the existing docs path and rejects output collisions', async t => {
  const options = await fixture(t), calls = [];
  await fs.mkdir(path.join(options.root, 'docs/state'), { recursive: true });
  await fs.writeFile(path.join(options.root, 'docs/state/usage-ledger.md'), '');
  const state = await runManifest(options.root, manifest([job(0)]), { ...options, fetchImpl: worker(calls) });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(state.ledger.path, 'docs/state/usage-ledger.md');
  assert.throws(() => validateManifest(manifest([job(0)], { ledger: { path: 'out/0.txt' } })), { code: 'ledger-is-output' });
  assert.throws(() => validateManifest(manifest([job(0)], { ledger: { typo: true } })), /Unknown ledger field/);
  assert.throws(() => validateManifest(manifest([job(0)], { idle: [{ name: 'ok', argv: ['true'], model: 'no' }] })), { code: 'idle-invalid' });
});

test('monitor displays pause reasons and held ids', () => {
  const text = renderMonitorView({ id: 'paused-run', status: 'paused', jobs: [], pause: { reasons: ['run-cap'], until: null, jobs: ['a', 'b'] } }, { width: 200 });
  assert.match(text, /paused: run-cap until n\/a; held 2 \(a, b\)/);
});

test('ledger CLI writes no duplicate rows', async t => {
  const options = await fixture(t), calls = [];
  const state = await runManifest(options.root, manifest([job(0), job(1)], { budget: { maxTokens: 100 } }), { ...options, fetchImpl: worker(calls) });
  const result = spawnSync(process.execPath, ['tools/swarm.mjs', '--root', options.root, 'ledger', state.id], { encoding: 'utf8', env: options.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).added, 0);
});

test('legacy spend settings and claim-only or malformed earlier runs do not block dispatch', async t => {
  const options = await fixture(t, { spend: { dailyCapUsd: 10, warnUsd: 5, lanes: { ollama: { dailyTokens: 1000 } } } }), calls = [];
  for (const id of ['claim-only', 'malformed']) await fs.mkdir(path.join(options.root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(options.root, '.swarm/runs/claim-only/claim'), '');
  await fs.writeFile(path.join(options.root, '.swarm/runs/malformed/state.json'), 'null');
  const state = await runManifest(options.root, manifest([job(0)]), { ...options, fetchImpl: worker(calls) });
  assert.equal(state.status, 'complete', state.error);
  assert.deepEqual(calls, [0]);
  assert.equal(state.budget.lanes.ollama.dailyTokens, 1000);
});

test('a ledger write failure warns without failing a successful run', async t => {
  const options = await fixture(t), calls = [];
  await fs.mkdir(path.join(options.root, 'ledger-directory'));
  const state = await runManifest(options.root, manifest([job(0)], { ledger: { path: 'ledger-directory' } }), { ...options, fetchImpl: worker(calls) });
  assert.equal(state.status, 'complete', state.error);
  assert.ok(state.warnings.some(warning => warning.startsWith('ledger-write-failed:')));
});

test('daily spend is shared by two roots and survives deletion of the first run directory', async t => {
  const a = paidOptions(await fixture(t)), b = paidOptions(await fixture(t));
  b.env.SWARM_SPEND_DIR = a.env.SWARM_SPEND_DIR;
  const calls = [];
  const first = await runManifest(a.root, manifest([paidJob(0)]), { ...a, fetchImpl: paidWorker(calls, { cost: 5 }) });
  assert.equal(first.status, 'complete', first.error);
  for (let n = 0; n < 2; n++) {
    if (n) await fs.rm(path.join(a.root, '.swarm'), { recursive: true, force: true });
    const state = await runManifest(b.root, manifest([paidJob(n)]), { ...b, fetchImpl: paidWorker(calls) });
    assert.equal(state.status, 'paused');
    assert.equal(state.jobs[0].heldReason, 'lane-cap');
    assert.equal(state.jobs[0].attempts.length, 0);
  }
  assert.deepEqual(calls, [0]);
  assert.equal((await storeEntries(b)).reduce((sum, entry) => sum + entry.usd, 0), 5);
});

test('64 concurrent paid launches reserve under the machine-wide daily cap', async t => {
  const options = paidOptions(await fixture(t)), calls = [];
  const state = await runManifest(options.root, manifest(Array.from({ length: 64 }, (_, n) => paidJob(n)), { concurrency: 64, lanes: { openrouter: { concurrency: 64 } } }), { ...options, fetchImpl: paidWorker(calls, { delayMs: 1000 }) });
  assert.equal(state.status, 'paused');
  assert.ok(calls.length > 0 && calls.length <= 11, `${calls.length} completion calls`);
  assert.equal(state.jobs.filter(record => record.status === 'complete').length, calls.length);
  assert.ok(state.jobs.filter(record => record.status !== 'complete').every(record => record.heldReason === 'lane-cap' && record.attempts.length === 0));
  const entries = await storeEntries(options);
  assert.equal(entries.length, calls.length);
  assert.ok(entries.every(entry => entry.kind === 'actual'));
  assert.ok(entries.reduce((sum, entry) => sum + entry.usd, 0) <= 5.5);
});

test('unreported paid costs are estimated from tokens or retained from the reservation', async t => {
  for (const usage of [true, false]) {
    const options = paidOptions(await fixture(t)), calls = [];
    const state = await runManifest(options.root, manifest([paidJob(0)]), { ...options, fetchImpl: paidWorker(calls, { cost: null, usage }) });
    assert.equal(state.status, 'complete', state.error);
    assert.equal(state.jobs[0].costUsd, usage ? 0.02 : 0.5);
    assert.equal(state.jobs[0].costSource, usage ? 'estimated-from-tokens' : 'reservation');
    assert.deepEqual(rollupRun(state).spend.estimatedJobs, ['job-0']);
    const ledger = await fs.readFile(path.join(options.root, state.ledger.path), 'utf8');
    assert.match(ledger, usage ? /\$0\.02 est/ : /\$0\.50 reserved/);
    assert.match(ledger, /incl\. estimates/);
    const [entry] = await storeEntries(options);
    assert.equal(entry.kind, usage ? 'estimated' : 'reserved-as-cost');
    assert.equal(entry.flagged, true);
    assert.ok(entry.usd > 0);
  }
});

test('a paid job refused before a completion request releases its reservation', async t => {
  const options = paidOptions(await fixture(t)), calls = [];
  // The adapter's existing per-job guard refuses this worst case after public pricing,
  // before the completion endpoint is contacted.
  const state = await runManifest(options.root, manifest([paidJob(0, { maxOutputTokens: 20000 })]), { ...options, fetchImpl: paidWorker(calls) });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /job cap/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await storeEntries(options), []);
});
