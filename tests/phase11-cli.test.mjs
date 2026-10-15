// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { extractPlanFlags, approveRun, recordRun, buildGoalPlan, loadApprovedPlan } from '../tools/plan-commands.mjs';
import { readCalibration, savePlan } from '../tools/plan-preview.mjs';
import { manifestForGoal } from '../tools/goal.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');
const temp = async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-p11-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
const commit = (root, message) => exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', message, '--allow-empty']);
async function project(t) {
  const root = await temp(t);
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/a.txt'), 'a\n');
  await exec('git', ['-C', root, 'add', '.']);
  await commit(root, 'init');
  return root;
}
const run = (root, home, args) => exec(process.execPath, [swarm, '--root', root, ...args], { env: { ...process.env, HOME: home, SWARM_CONFIG: process.env.SWARM_CONFIG }, input: '' });
const fail = (root, home, args) => run(root, home, args).then(() => assert.fail('expected failure'), error => error);

test('extractPlanFlags pulls out the approval flags and leaves the rest', () => {
  assert.deepEqual(extractPlanFlags(['goal', '--yes', '--max-usd', '2', '--plan', 'plan-abc123', '--accept-stale', '--json']),
    { yes: true, acceptStale: true, planId: 'plan-abc123', json: true, rest: ['goal', '--max-usd', '2'] });
  assert.throws(() => extractPlanFlags(['--plan']), /plan id/);
  assert.throws(() => extractPlanFlags(['--plan', '--yes']), /plan id/);
});

test('approval: a person is asked; anything unattended needs --yes and a budget', async () => {
  const ask = answer => async () => answer;
  assert.equal((await approveRun({ yes: false, interactive: true, hasBudget: false, ask: ask('y') })).approved, true);
  assert.equal((await approveRun({ yes: false, interactive: true, hasBudget: false, ask: ask('YES') })).approved, true);
  for (const answer of ['', 'n', 'no', 'maybe']) assert.equal((await approveRun({ yes: false, interactive: true, hasBudget: false, ask: ask(answer) })).code, 'plan-declined');
  assert.equal((await approveRun({ yes: false, interactive: false, hasBudget: true, ask: ask('y') })).code, 'plan-approval-required');
  assert.equal((await approveRun({ yes: true, interactive: false, hasBudget: false, ask: ask('y') })).code, 'plan-budget-required');
  assert.equal((await approveRun({ yes: true, interactive: false, hasBudget: true })).approved, true);
  assert.equal((await approveRun({ yes: true, interactive: true, hasBudget: false })).approved, true);
});

test('swarm plan previews, saves, and runs nothing', async t => {
  const root = await project(t), home = await temp(t);
  const { stdout } = await run(root, home, ['plan', 'add a thing to src', '--leads', '1']);
  assert.match(stdout, /Leads: 1 \(scopes: src\/\)/);
  assert.match(stdout, /Cost: about/);
  assert.match(stdout, /Risks:/);
  const id = /plan saved: (\S+)/.exec(stdout)[1];
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/plans', `${id}.json`), 'utf8'));
  assert.equal(saved.manifest.jobs[0].type, 'lead');
  await assert.rejects(fs.stat(path.join(root, '.swarm/runs')));
  const json = JSON.parse((await run(root, home, ['plan', 'add a thing to src', '--json'])).stdout);
  assert.ok(json.id && json.preview.estimate.costUsd >= 0);
  assert.equal((await fail(root, home, ['plan', 'x', '--pr', 'p.json'])).code, 1);
});

test('swarm go without a terminal and --yes asks nothing and runs nothing; --yes needs a budget', async t => {
  const root = await project(t), home = await temp(t);
  const noYes = JSON.parse((await fail(root, home, ['go', 'add a thing to src'])).stdout);
  assert.equal(noYes.status, 'cancelled');
  assert.match(noYes.reason, /--yes/);
  const noBudget = JSON.parse((await fail(root, home, ['go', 'add a thing to src', '--yes'])).stdout);
  assert.match(noBudget.reason, /--max-usd/);
  await assert.rejects(fs.stat(path.join(root, '.swarm/runs')));
});

test('go --plan: a changed repo is stale, a tampered plan is invalid, --accept-stale goes on to go itself', async t => {
  const root = await project(t), home = await temp(t);
  const id = /plan saved: (\S+)/.exec((await run(root, home, ['plan', 'add a thing to src'])).stdout)[1];
  const planFile = path.join(root, '.swarm/plans', `${id}.json`);
  await commit(root, 'moved');
  const stale = await fail(root, home, ['go', '--plan', id, '--yes']);
  assert.match(stale.stdout + stale.stderr, /plan-stale/);
  // past the stale check, a dirty tree is still refused by go itself and nothing runs
  await fs.writeFile(path.join(root, 'dirty.txt'), 'x\n');
  const dirty = JSON.parse((await run(root, home, ['go', '--plan', id, '--yes', '--accept-stale']).catch(error => error)).stdout);
  assert.equal(dirty.stage, 'plan');
  assert.match(dirty.reason, /goal-dirty/);
  await assert.rejects(fs.stat(path.join(root, '.swarm/runs')));
  const saved = JSON.parse(await fs.readFile(planFile, 'utf8'));
  saved.manifest.jobs[0].prompt += ' and delete everything';
  await fs.writeFile(planFile, JSON.stringify(saved));
  const bad = await fail(root, home, ['go', '--plan', id, '--yes', '--accept-stale']);
  assert.match(bad.stdout + bad.stderr, /plan-invalid: hash/);
  const missing = await fail(root, home, ['go', '--plan', 'plan-nothere']);
  assert.match(missing.stdout + missing.stderr, /plan-not-found/);
});

test('buildGoalPlan, loadApprovedPlan and recordRun fit together and feed the calibration', async t => {
  const root = await project(t);
  const deps = { folders: async () => ['src', 'docs'], manifestForGoal, laneInfo: async () => ({ lead: { agent: 'codex', concurrency: 6, price: null }, child: { agent: 'anthropic', model: 'claude-haiku-5-5', concurrency: 16, price: { inPerM: 1, outPerM: 5 } }, runConcurrency: 8 }), defaults: { maxUsd: 5, maxTokens: 2000000 }, head: async () => 'abc1234', now: () => 1700000000000 };
  const plan = await buildGoalPlan(root, 'do it', { leads: 2 }, deps);
  assert.match(plan.id, /^plan-[a-z0-9]+-[0-9a-f]{6}$/);
  assert.equal(plan.preview.jobs.leads, 2);
  await savePlan(root, plan);
  assert.equal((await loadApprovedPlan(root, plan.id, { head: 'abc1234' })).hash, plan.hash);
  await assert.rejects(loadApprovedPlan(root, plan.id, { head: 'ffff999' }), { code: 'plan-stale' });
  assert.ok(await loadApprovedPlan(root, plan.id, { head: 'ffff999', acceptStale: true }));
  const compare = await recordRun(root, plan, { costUsd: plan.preview.estimate.costUsd * 2, minutes: plan.preview.estimate.minutes * 3, children: 8 });
  assert.equal(compare.actual.children, 8);
  const calibration = await readCalibration(root);
  assert.equal(calibration.costRatio, 2);
  assert.equal(calibration.timeRatio, 3);
  assert.equal(calibration.childrenPerLead, 4);
  const next = await buildGoalPlan(root, 'again', { leads: 2 }, deps);
  assert.ok(next.preview.estimate.calibrated);
});
