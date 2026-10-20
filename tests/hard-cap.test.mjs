// SPDX-License-Identifier: Apache-2.0
// The spend cap is hard: a job is refused when what is spent, plus what is already reserved for jobs in flight, plus this job's own worst case would pass the cap.
// (Parts-app stages S11 and S12 each finished about $6 over their cap: subscription-lane jobs were counted only when they finished, so a wave of parallel jobs all started under the cap.)
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { capDecision, estimateReservation, flatRateReserve, runTotals, FLAT_RATE_RESERVE_DEFAULTS } from '../tools/spend.mjs';
import { runManifest } from '../tools/swarm.mjs';

const budget = (maxUsd, lanes = {}) => ({ maxUsd, maxTokens: null, lanes });

test('capDecision: a job is refused when its own worst case would pass the cap, allowed when it fits exactly, and a token cap is unchanged', () => {
  assert.equal(capDecision({ budget: budget(1), run: { usd: 0.5, tokens: 0 }, laneToday: {}, agent: 'claude', add: { usd: 0.5, tokens: 99999 } }), null, 'exactly the cap is allowed');
  const refused = capDecision({ budget: budget(1), run: { usd: 0.6, tokens: 0 }, laneToday: {}, agent: 'claude', add: { usd: 0.5, tokens: 0 } });
  assert.equal(refused.reason, 'run-cap');
  assert.match(refused.message, /worst case \$0\.50 would pass maxUsd \$1\.00/);
  assert.equal(capDecision({ budget: budget(1), run: { usd: 1, tokens: 0 }, laneToday: {}, agent: 'claude' }).reason, 'run-cap', 'already reached, as before');
  assert.equal(capDecision({ budget: budget(1), run: { usd: 0.1, tokens: 0 }, laneToday: {}, agent: 'claude' }), null, 'no add: the earlier rule');
  const lane = capDecision({ budget: budget(null, { claude: { dailyUsd: 2 } }), run: { usd: 0, tokens: 0 }, laneToday: { claude: { usd: 1.8, tokens: 0 } }, agent: 'claude', add: { usd: 0.5 } });
  assert.equal(lane.reason, 'lane-cap');
  assert.equal(capDecision({ budget: { maxUsd: null, maxTokens: 100, lanes: {} }, run: { usd: 0, tokens: 50 }, laneToday: {}, agent: 'ollama', add: { usd: 0, tokens: 8192 } }), null, 'tokens: refused only once reached');
});

test('subscription lanes reserve an estimate while a job runs: the most a finished job of the lane and model cost (five or more), else a default per lane and model', () => {
  assert.equal(flatRateReserve({ lane: 'claude', model: 'opus' }), 1.0);
  assert.equal(flatRateReserve({ lane: 'claude', model: 'claude-sonnet-5-5' }), 0.5);
  assert.equal(flatRateReserve({ lane: 'claude', model: 'haiku' }), 0.2);
  assert.equal(flatRateReserve({ lane: 'codex' }), FLAT_RATE_RESERVE_DEFAULTS.codex);
  assert.equal(flatRateReserve({ lane: 'cursor' }), 0.4);
  assert.equal(flatRateReserve({ lane: 'hermes' }), 0, 'a free local lane reserves nothing');
  assert.equal(flatRateReserve({ lane: 'unknown-lane' }), 0);
  assert.equal(flatRateReserve({ lane: 'claude', model: 'opus', history: [0.1, 0.1, 0.1, 0.1] }), 1.0, 'fewer than five samples: the default');
  const history = [0.1, 0.12, 0.11, 0.13, 0.1, 0.12, 0.11, 0.14, 0.1, 0.9];
  assert.equal(flatRateReserve({ lane: 'claude', model: 'sonnet', history }), 0.9, 'five or more: the most any of them cost');
  assert.equal(flatRateReserve({ lane: 'claude', model: 'sonnet', history: [0.1, 0.1, 0.1, 0.1, 0.1] }), 0.1, 'learned from the run, below the default');
  assert.equal(estimateReservation({ job: {}, lane: 'claude', model: 'opus', inputChars: 0, rates: null }).usd, 1.0);
  assert.equal(estimateReservation({ job: {}, lane: 'claude', model: 'opus', inputChars: 0, rates: null }).source, 'unpaid');
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hard-cap-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'x');
  return root;
}
// Stands in for the claude CLI: each job takes a moment and reports a list cost.
const claudeFake = (cost, ms = 250) => (_c, _a, options) => spawn(process.execPath, ['--input-type=module', '-e', `await new Promise(r => setTimeout(r, ${ms}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',total_cost_usd:${cost}}));`], options);
const jobs = n => Array.from({ length: n }, (_, i) => ({ id: `j${i}`, agent: 'claude', model: 'sonnet', prompt: `Do thing ${i}.`, context: ['input.txt'], outputs: [], timeoutMs: 20000 }));

test('eight parallel subscription jobs under a $1.00 cap: never more than the cap is spent (before: all eight started and cost $3.20)', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, { version: 1, concurrency: 8, budget: { maxUsd: 1 }, jobs: jobs(8) }, { spawnImpl: claudeFake(0.4), env: { ...process.env, SWARM_SPEND_DIR: path.join(root, 'spend') } });
  const total = runTotals(state).usd;
  assert.ok(total <= 1.0 + 1e-9, `spent ${total}`);
  const done = state.jobs.filter(j => j.status === 'complete').length;
  assert.ok(done >= 1 && done <= 2, `${done} jobs ran`);
  assert.ok(state.jobs.some(j => j.status === 'held'), 'the rest are held, not started');
  assert.equal(state.status, 'paused');
});

test('the same jobs with no cap all run; with a cap that fits them all they all run', async t => {
  const root = await fixture(t);
  const env = { ...process.env, SWARM_SPEND_DIR: path.join(root, 'spend') };
  const none = await runManifest(root, { version: 1, concurrency: 8, jobs: jobs(4) }, { spawnImpl: claudeFake(0.4, 50), env });
  assert.equal(none.jobs.filter(j => j.status === 'complete').length, 4);
  const roomy = await runManifest(root, { version: 1, concurrency: 8, budget: { maxUsd: 10 }, jobs: jobs(4) }, { spawnImpl: claudeFake(0.4, 50), env });
  assert.equal(roomy.jobs.filter(j => j.status === 'complete').length, 4);
});

test('a cap that holds every job\'s reservation lets them all run and stays under the cap ($3.00 for six $0.30 jobs)', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, { version: 1, concurrency: 8, budget: { maxUsd: 3 }, jobs: jobs(6) }, { spawnImpl: claudeFake(0.3, 80), env: { ...process.env, SWARM_SPEND_DIR: path.join(root, 'spend') } });
  assert.ok(runTotals(state).usd <= 3.0 + 1e-9);
  assert.equal(state.jobs.filter(j => j.status === 'complete').length, 6, state.jobs.map(j => j.status).join());
  assert.equal(state.status, 'complete');
});

// ---- Opus review fixes ----
const claudeFakeBy = byId => (_c, args, options) => {
  const text = `${options.cwd ?? ''} ${args.join(' ')}`;   // the job's workspace folder carries its id
  const spec = Object.entries(byId).find(([id]) => text.includes(id))?.[1] ?? { cost: 0.1, ms: 100 };
  const script = spec.fail ? "console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'boom'}));process.exit(1);" : `await new Promise(r => setTimeout(r, ${spec.ms ?? 100}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',total_cost_usd:${spec.cost}}));`;
  return spawn(process.execPath, ['--input-type=module', '-e', script], options);
};
const named = (id, model = 'sonnet', extra = {}) => ({ id, agent: 'claude', model, prompt: `Do ${id}.`, context: ['input.txt'], outputs: [], timeoutMs: 20000, ...extra });
const spendEnv = root => ({ ...process.env, SWARM_SPEND_DIR: path.join(root, 'spend') });

test('a refusal that exists only because of money reserved for running jobs waits for them: six $0.10 jobs under a $2.00 cap all run (they were held for good before)', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, { version: 1, concurrency: 6, budget: { maxUsd: 2 }, jobs: jobs(6) }, { spawnImpl: claudeFake(0.1, 120), env: spendEnv(root) });
  assert.equal(state.jobs.filter(j => j.status === 'complete').length, 6, state.jobs.map(j => j.status).join());
  assert.ok(runTotals(state).usd <= 2 + 1e-9);
});

test('a failed job gives its reservation back, so the jobs waiting behind it start', async t => {
  const root = await fixture(t);
  const list = [named('fails'), named('a'), named('b'), named('c')];
  const state = await runManifest(root, { version: 1, concurrency: 4, budget: { maxUsd: 1 }, jobs: list }, { spawnImpl: claudeFakeBy({ fails: { fail: true }, a: { cost: 0.1, ms: 150 }, b: { cost: 0.1, ms: 150 }, c: { cost: 0.1, ms: 150 } }), env: spendEnv(root) });
  const status = Object.fromEntries(state.jobs.map(j => [j.id, j.status]));
  assert.notEqual(status.fails, 'complete');
  assert.deepEqual([status.a, status.b, status.c], ['complete', 'complete', 'complete'], JSON.stringify(status));
  assert.ok(runTotals(state).usd <= 1 + 1e-9);
});

test('the reservation is per lane AND model: cheap Haiku history does not lower what an Opus job reserves', async t => {
  const root = await fixture(t);
  const list = [...Array.from({ length: 5 }, (_, i) => named(`h${i}`, 'haiku')), named('big', 'opus', { after: ['h0', 'h1', 'h2', 'h3', 'h4'] })];
  const state = await runManifest(root, { version: 1, concurrency: 1, budget: { maxUsd: 1 }, jobs: list }, { spawnImpl: claudeFakeBy({ big: { cost: 1.2, ms: 50 } }), env: spendEnv(root) });
  const status = Object.fromEntries(state.jobs.map(j => [j.id, j.status]));
  assert.equal(status.big, 'held', 'five $0.10 Haiku jobs said nothing about Opus: its default $1.00 would pass the $1.00 cap with $0.50 spent');
  assert.ok(runTotals(state).usd <= 1 + 1e-9);
});

test('a subscription lane\'s daily dollar cap is enforced with reservations too', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, { version: 1, concurrency: 4, budget: { lanes: { claude: { dailyUsd: 0.6 } } }, jobs: jobs(4) }, { spawnImpl: claudeFake(0.4, 150), env: spendEnv(root) });
  const done = state.jobs.filter(j => j.status === 'complete').length;
  assert.equal(done, 1, state.jobs.map(j => j.status).join());
  assert.ok(runTotals(state).usd <= 0.6 + 1e-9);
});

test('a job and the cap with a float edge: $0.10 spent, $0.20 reserved, $0.30 cap is allowed', () => {
  assert.equal(capDecision({ budget: budget(0.3), run: { usd: 0.1, tokens: 0 }, laneToday: {}, agent: 'claude', add: { usd: 0.2 } }), null);
});

test('the project cap is hard for a new run: its own cap is never more than what the project has left', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ profile: { sensitive: false, protectedPaths: [], budget: { maxUsd: 5, maxTokens: 1000000, projectMaxUsd: 1 }, baseCheck: { status: 'none' } } }));
  const env = spendEnv(root);
  // Spend 0.8 of the $1.00 project cap in a first run.
  const first = await runManifest(root, { version: 1, concurrency: 1, jobs: [named('a')] }, { spawnImpl: claudeFake(0.8, 30), env });
  assert.equal(runTotals(first).usd, 0.8);
  // The second run asks for $5.00 and gets what is left: about $0.20.
  const second = await runManifest(root, { version: 1, concurrency: 1, jobs: [named('b')] }, { spawnImpl: claudeFake(0.1, 30), env, maxUsd: 5 });
  assert.ok(Math.abs(second.budget.maxUsd - 0.2) < 1e-6, `run cap ${second.budget.maxUsd}`);
  // A manifest cap that is already lower stays as it is.
  const third = await runManifest(root, { version: 1, concurrency: 1, budget: { maxUsd: 0.05 }, jobs: [named('c')] }, { spawnImpl: claudeFake(0.01, 30), env });
  assert.equal(third.budget.maxUsd, 0.05);
});
