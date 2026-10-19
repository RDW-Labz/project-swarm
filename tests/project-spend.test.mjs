// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { noCapWarning, NO_CAP_WARNING, projectSpend, projectCap, projectCapInfo, projectCapDecision, projectSummary, checkProjectCap } from '../tools/project-spend.mjs';
import { runManifest, resumeRun } from '../tools/swarm.mjs';
import { resolveBudget, mergeLedger, ledgerRows, parseLedgerRow } from '../tools/spend.mjs';
import { validateProfile } from '../tools/init-profile.mjs';
import { renderTui } from '../tools/watch-tui.mjs';

const exec = promisify(execFile);
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function repo(t, { profile, config = {} } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-project-spend-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  if (profile) await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ install: temp, version: '0', profile }));
  await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify(config));
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, temp, env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') }, liveDir: path.join(temp, 'live') };
}
async function oldRun(root, id, costs) {
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs: costs.map((costUsd, i) => ({ id: `j${i}`, costUsd, usage: { total_tokens: 100 } })) }));
}

test('projectSpend adds every run of the project, including a rental and unreadable runs', async t => {
  const { root } = await repo(t);
  await oldRun(root, 'run-a', [1.25, 2]);
  await oldRun(root, 'run-b', [0.5]);
  await fs.mkdir(path.join(root, '.swarm/runs/run-bad'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/run-bad/state.json'), '{nope');
  const spent = await projectSpend(root);
  assert.equal(spent.usd, 3.75);
  assert.equal(spent.runs, 2);
  assert.deepEqual(spent.unreadable, ['run-bad']);
  // A state that is valid JSON but the wrong shape is unreadable too, never a crash.
  await fs.mkdir(path.join(root, '.swarm/runs/run-null'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/run-null/state.json'), 'null');
  await fs.mkdir(path.join(root, '.swarm/runs/run-shape'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/run-shape/state.json'), JSON.stringify({ jobs: 5 }));
  assert.deepEqual((await projectSpend(root)).unreadable.sort(), ['run-bad', 'run-null', 'run-shape']);
});

test('projectCap takes the lower of profile and config, and a malformed cap is an error, not "no cap"', () => {
  assert.equal(projectCap({}), null);
  assert.equal(projectCap({ profile: { budget: { projectMaxUsd: 20 } }, config: { spend: { projectMaxUsd: 10 } } }), 10);
  assert.equal(projectCap({ profile: { budget: { projectMaxUsd: 20 } } }), 20);
  assert.throws(() => projectCap({ profile: { budget: { projectMaxUsd: -1 } } }), /project-cap-invalid/);
  assert.throws(() => projectCap({ config: { spend: { projectMaxUsd: 'ten' } } }), /project-cap-invalid/);
  assert.equal(projectCapDecision({ spent: { usd: 9.99, runs: 3 }, cap: 10 }), null);
  assert.match(projectCapDecision({ spent: { usd: 10, runs: 3 }, cap: 10 }).message, /project-cap: this project has spent \$10\.00 across 3 runs/);
});

test('the profile and the config accept projectMaxUsd and reject bad values', () => {
  assert.doesNotThrow(() => resolveBudget({ config: { spend: { projectMaxUsd: 25 } } }));
  assert.throws(() => resolveBudget({ config: { spend: { projectMaxUsd: 0 } } }), /projectMaxUsd/);
  const ok = validateProfile({ version: 1, budget: { projectMaxUsd: 30 } });
  assert.ok(!ok.errors.some(error => /projectMaxUsd|budget/.test(error)), ok.errors.join('; '));
  assert.ok(validateProfile({ version: 1, budget: { projectMaxUsd: 'x' } }).errors.some(error => /projectMaxUsd/.test(error)));
});

test('a new run is refused once all runs together reached the project cap (--max-usd stays per run)', async t => {
  const fx = await repo(t, { profile: { budget: { projectMaxUsd: 5 } } });
  await oldRun(fx.root, 'old-1', [3]);
  await oldRun(fx.root, 'old-2', [2]);
  let called = 0;
  const m = { version: 1, concurrency: 1, jobs: [{ id: 'job-1', agent: 'ollama', model: 'test-model', prompt: 'Write out/1.txt', context: ['input.txt'], outputs: ['out/1.txt'], timeoutMs: 5000 }] };
  await assert.rejects(runManifest(fx.root, m, { env: fx.env, liveDir: fx.liveDir, maxUsd: 100, fetchImpl: async () => { called++; return reply({}); } }), /project-cap: this project has spent \$5\.00 across 2 runs/);
  assert.equal(called, 0, 'no worker was called');
});

test('a project under its cap, or without one, still runs', async t => {
  const fx = await repo(t, { profile: { budget: { projectMaxUsd: 50 } } });
  await oldRun(fx.root, 'old-1', [3]);
  const m = { version: 1, concurrency: 1, jobs: [{ id: 'job-1', agent: 'ollama', model: 'test-model', prompt: 'Write out/1.txt', context: ['input.txt'], outputs: ['out/1.txt'], timeoutMs: 5000 }] };
  const state = await runManifest(fx.root, m, { env: fx.env, liveDir: fx.liveDir, fetchImpl: async () => reply({ done: true, done_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, message: { content: JSON.stringify({ summary: 'done', files: [{ path: 'out/1.txt', content: 'ok\n' }] }) } }) });
  assert.equal(state.status, 'complete');
});

test('project summary for swarm watch shows the total, the cap and whether it is reached', async t => {
  const fx = await repo(t, { profile: { budget: { projectMaxUsd: 4 } } });
  await oldRun(fx.root, 'old-1', [3]);
  assert.deepEqual(await projectSummary(fx.root, { env: fx.env, ttlMs: 0 }), { spendUsd: 3, runs: 1, capUsd: 4, noCap: false, reached: false, unknownUsd: 0, unreadable: 0 });
  await oldRun(fx.root, 'old-2', [1.5]);
  const summary = await projectSummary(fx.root, { env: fx.env, ttlMs: 0 });
  assert.equal(summary.spendUsd, 4.5);
  assert.equal(summary.reached, true);
  const frame = renderTui({ runId: 'r', status: 'running', kpi: {}, lanes: [], project: summary }, { width: 120, color: false });
  assert.match(frame, /project total \$4\.50 over 2 runs {2}cap \$4\.00 {2}CAP REACHED: no new runs/);
  assert.match(renderTui({ runId: 'r', status: 'running', kpi: {}, lanes: [], project: { spendUsd: 1, runs: 1, capUsd: null, noCap: true } }, { width: 120, color: false }), /project total \$1\.00 over 1 runs {2}NO CAP/);
});

const attempt = (id, cost, agent = 'anthropic', task = 'build a thing') => ({ id, agent, model: 'm', status: 'complete', costUsd: cost, usage: { total_tokens: 1000 }, report: { summary: task }, attempts: [{ status: 'complete', finishedAt: '2026-10-18T10:00:00Z' }] });

test('ledger: the summary adds up to the detail rows and ends with a total row', () => {
  const rows = ledgerRows({ id: 'r1', jobs: [attempt('a', 1.1), attempt('b', 2.2), attempt('c', 0.34, 'claude')] });
  const text = mergeLedger('', rows);
  assert.match(text, /\| 2026-10-18 \| anthropic \| 2 \| 2 \| 0 \| 2,000 \| \$3\.30 \|/);
  assert.match(text, /\| 2026-10-18 \| claude \| 1 \| 1 \| 0 \| 1,000 \| \$0\.34 \|/);
  assert.match(text, /\| \*\*total\*\* \| all \| 3 \| 3 \| 0 \| 3,000 \| \$3\.64 \|/);
});

test('ledger: writing the same rows again twice does not change the totals', () => {
  const rows = ledgerRows({ id: 'r1', jobs: [attempt('a', 1.1), attempt('b', 2.2)] });
  const once = mergeLedger('', rows);
  assert.equal(mergeLedger(once, []), once, 'merging nothing changes nothing');
  assert.match(mergeLedger(once, []), /\$3\.30 \|\n/);
});

test('ledger: a task with a pipe or a hand-written row with extra cells is counted under the right day and tier (columns do not shift)', () => {
  const rows = ledgerRows({ id: 'r1', jobs: [attempt('a', 1, 'anthropic', 'split a|b|c cells')] });
  assert.equal(rows[0].task.includes('|'), false, 'a pipe never reaches a cell');
  // A shifted row: two extra cells inside the task.
  const shifted = '| 2026-10-18 | p | T-1: a | b | c | anthropic | m | pass | 1,000 | $2.00 |';
  assert.deepEqual(parseLedgerRow(shifted), { date: '2026-10-18', worker: 'anthropic', result: 'pass', tokens: '1,000', cost: '$2.00' });
  const base = mergeLedger('', rows);
  const lines = base.split('\n');
  const header = lines.findIndex(line => line.startsWith('| date | phase'));
  lines.splice(header + 3, 0, shifted);
  const text = mergeLedger(lines.join('\n'), []);
  assert.match(text, /\| 2026-10-18 \| anthropic \| 2 \| 2 \| 0 \| 2,000 \| \$3\.00 \|/);
  assert.match(text, /\*\*total\*\* \| all \| 2 \|/);
});

test('ledger: a row that cannot be read is reported, not silently dropped from the total', () => {
  const base = mergeLedger('', ledgerRows({ id: 'r1', jobs: [attempt('a', 1)] }));
  const lines = base.split('\n');
  const header = lines.findIndex(line => line.startsWith('| date | phase'));
  lines.splice(header + 3, 0, '| 2026-10-18 | only | four | cells |');
  const text = mergeLedger(lines.join('\n'), []);
  assert.match(text, /1 ledger row that could not be read is not in these totals\./);
  assert.match(text, /\$1\.00 \|/);
});

test('null or bad caps are errors, and the message names which source set the cap', () => {
  assert.throws(() => projectCap({ profile: { budget: { projectMaxUsd: null } } }), /project-cap-invalid/);
  assert.deepEqual(projectCapInfo({ profile: { budget: { projectMaxUsd: 20 } }, config: { spend: { projectMaxUsd: 10 } } }), { cap: 10, source: 'config spend.projectMaxUsd' });
  assert.match(projectCapDecision({ spent: { usd: 10, runs: 1 }, cap: 10, source: 'config spend.projectMaxUsd' }).message, /\(config spend\.projectMaxUsd\)/);
});

test('an unreadable pointer file or run state refuses new runs instead of dropping the cap or shrinking the total', async t => {
  const fx = await repo(t, { profile: { budget: { projectMaxUsd: 50 } } });
  await fs.writeFile(path.join(fx.root, '.project-swarm.json'), '{broken');
  await assert.rejects(checkProjectCap(fx.root, { env: fx.env }), /project-cap-invalid: \.project-swarm\.json cannot be read/);
  await fs.writeFile(path.join(fx.root, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 50 } } }));
  assert.equal(await checkProjectCap(fx.root, { env: fx.env }), null);
  await fs.mkdir(path.join(fx.root, '.swarm/runs/run-bad'), { recursive: true });
  await fs.writeFile(path.join(fx.root, '.swarm/runs/run-bad/state.json'), '{nope');
  const decision = await checkProjectCap(fx.root, { env: fx.env });
  assert.match(decision.message, /1 run state could not be read \(run-bad\), so the project total is unknown/);
  const summary = await projectSummary(fx.root, { env: fx.env, ttlMs: 0 });
  assert.equal(summary.unreadable, 1);
});

test('runs still going count with what their own --max-usd lets them spend, so runs started together cannot all slip under the cap', async t => {
  const fx = await repo(t, { profile: { budget: { projectMaxUsd: 10 } } });
  await oldRun(fx.root, 'live', [2]);
  const file = path.join(fx.root, '.swarm/runs/live/state.json');
  await fs.writeFile(file, JSON.stringify({ id: 'live', status: 'running', budget: { maxUsd: 5 }, jobs: [{ id: 'j', costUsd: 2, usage: { total_tokens: 1 } }] }));
  assert.equal(await checkProjectCap(fx.root, { env: fx.env }), null, '2 spent + 3 exposure < 10');
  await oldRun(fx.root, 'done', [5]);
  const decision = await checkProjectCap(fx.root, { env: fx.env });
  assert.match(decision.message, /spent \$7\.00 across 2 runs and runs still going may spend \$3\.00 more >= the project cap \$10\.00/);
});

test('the real refusal carries the project-cap code, and resume is refused over the cap too (it would start paid jobs again)', async t => {
  const fx = await repo(t, { profile: { budget: { projectMaxUsd: 5 } } });
  await oldRun(fx.root, 'old-1', [6]);
  const m = { version: 1, concurrency: 1, jobs: [{ id: 'job-1', agent: 'ollama', model: 'test-model', prompt: 'Write out/1.txt', context: ['input.txt'], outputs: ['out/1.txt'], timeoutMs: 5000 }] };
  await assert.rejects(runManifest(fx.root, m, { env: fx.env, liveDir: fx.liveDir }), { code: 'project-cap' });
  await fs.writeFile(path.join(fx.root, '.swarm/runs/old-1/state.json'), JSON.stringify({ id: 'old-1', root: await fs.realpath(fx.root), status: 'paused', jobs: [{ id: 'j0', costUsd: 6, usage: { total_tokens: 1 } }], pause: { until: null } }));
  await assert.rejects(resumeRun(fx.root, 'old-1', { env: fx.env, raises: [{ key: 'maxUsd', value: 50 }], reason: 'try' }), { code: 'project-cap', message: /resume-over-cap: project-cap/ });
});

test('ledger: the unreadable-rows note is replaced, not repeated, and goes away when the row is fixed; a repeated header or divider is not a bad row', () => {
  const base = mergeLedger('', ledgerRows({ id: 'r1', jobs: [attempt('a', 1)] }));
  const lines = base.split('\n');
  const header = lines.findIndex(line => line.startsWith('| date | phase'));
  lines.splice(header + 3, 0, '| 2026-10-18 | only | four | cells |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  let text = mergeLedger(lines.join('\n'), []);
  text = mergeLedger(text, []);
  text = mergeLedger(text, []);
  assert.equal(text.match(/could not be read/g).length, 1, 'one note');
  assert.match(text, /1 ledger row that could not be read is not in these totals\./);
  const fixed = mergeLedger(text.replace('| 2026-10-18 | only | four | cells |\n', ''), []);
  assert.doesNotMatch(fixed, /could not be read/);
});

test('ledger: the total row keeps the estimate and subscription notes', () => {
  const est = { ...attempt('a', 1), costSource: 'estimated-from-tokens' };
  assert.match(mergeLedger('', ledgerRows({ id: 'r1', jobs: [est] })), /\*\*total\*\* \| all \| 1 \| 1 \| 0 \| 1,000 \| \$1\.00 \(incl\. estimates\) \|/);
  const sub = { ...attempt('b', null, 'codex'), costUsd: undefined };
  assert.match(mergeLedger('', ledgerRows({ id: 'r1', jobs: [sub] })), /\*\*total\*\* \| all \| 1 \| 1 \| 0 \| 1,000 \| subscription \|/);
});

test('no project cap: swarm go warns (stderr text) and swarm watch says NO CAP; a set cap or an invalid one does not warn; nothing is defaulted', async t => {
  const none = await repo(t, { profile: { budget: { maxUsd: 5 } } });
  assert.equal(await noCapWarning(none.root, { env: none.env }), NO_CAP_WARNING);
  assert.match(NO_CAP_WARNING, /NO CAP/);
  assert.equal((await projectSummary(none.root, { env: none.env, ttlMs: 0 })).noCap, true);
  assert.equal((await projectSummary(none.root, { env: none.env, ttlMs: 0 })).capUsd, null, 'no value is invented');
  const set = await repo(t, { profile: { budget: { projectMaxUsd: 9 } } });
  assert.equal(await noCapWarning(set.root, { env: set.env }), null);
  const bad = await repo(t, { profile: { budget: { projectMaxUsd: -1 } } });
  assert.equal(await noCapWarning(bad.root, { env: bad.env }), null);
  const web = await fs.readFile(new URL('../tools/watch-assets/run-kpis.js', import.meta.url), 'utf8');
  assert.match(web, /NO CAP/);
});

test('swarm go prints the NO CAP warning on stderr for a project without a cap', async t => {
  const fx = await repo(t, { profile: { budget: { maxUsd: 5 } } });
  const swarm = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tools', 'swarm.mjs');
  await fs.writeFile(path.join(fx.root, 'dirty.txt'), 'x'); // a dirty tree is refused by go itself before any model is called
  const result = await exec(process.execPath, [swarm, '--root', fx.root, 'go', 'noop goal'], { cwd: fx.root, env: fx.env }).catch(error => error);
  assert.match(String(result.stderr), /warning: NO CAP: this project has no project-wide spend cap/);
});

test('swarm watch tells an invalid cap from no cap', () => {
  const frame = project => renderTui({ runId: 'r', status: 'running', kpi: {}, lanes: [], project }, { width: 120, color: false });
  assert.match(frame({ spendUsd: 1, runs: 1, capUsd: null, noCap: false, capError: 'project-cap-invalid: x' }), /CAP INVALID/);
  assert.doesNotMatch(frame({ spendUsd: 1, runs: 1, capUsd: null, noCap: false, capError: 'x' }), /NO CAP/);
  assert.match(frame({ spendUsd: 1, runs: 1, capUsd: null, noCap: true }), /NO CAP/);
});
