// SPDX-License-Identifier: Apache-2.0
import "./_isolate-config.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { manifestForGoal } from '../tools/goal.mjs';
import { estimatePlan, formatPreview, planHash, savePlan, loadPlan, recordActual, PRIORS } from '../tools/plan-preview.mjs';

const PRICE = { inPerM: 1, outPerM: 5 };
const EMPTY = { runs: [], costRatio: 1, timeRatio: 1 };
const lanes = (price = PRICE, childConcurrency = 4) => ({
  lead: { agent: 'anthropic', model: 'lead-model', concurrency: 2, price },
  child: { agent: 'anthropic', model: 'child-model', concurrency: childConcurrency, price },
  runConcurrency: 4,
});
const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);
const goal1 = (opts = {}) => manifestForGoal('add tests', { folders: ['a', 'b'], leads: 1, maxJobs: 10, concurrency: 2, ...opts });
const codes = preview => preview.risks.map(risk => risk.code);
const planFor = manifest => ({
  id: 'plan-abc123', goal: 'add tests', createdAt: '2024-01-01T00:00:00.000Z', head: 'deadbeef',
  hash: planHash(manifest), flags: { maxUsd: 5 }, manifest,
  preview: estimatePlan(manifest, { lanes: lanes(), calibration: {} }),
});

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('one lead: children from priors, costs, minutes and range', () => {
  const p = estimatePlan(goal1(), { lanes: lanes(), calibration: {} });
  near(p.estimate.costUsd, 0.261);
  assert.equal(p.estimate.tokens, 129000);
  near(p.estimate.minutes, 4);
  assert.equal(p.estimate.peakConcurrency, 2);
  assert.equal(p.jobs.expectedChildren, 6);
  assert.equal(p.jobs.maxChildren, 10);
  near(p.estimate.costRange[0], 0.1305);
  near(p.estimate.costRange[1], 0.435);
  assert.equal(p.estimate.calibrated, false);
});

test('three leads scale children and lead cost', () => {
  const m = manifestForGoal('go', { folders: ['a', 'b', 'c', 'd', 'e', 'f'], leads: 3, maxJobs: 5, concurrency: 2 });
  const p = estimatePlan(m, { lanes: lanes(PRICE, 3), calibration: {} });
  assert.equal(p.jobs.expectedChildren, 15);
  assert.equal(p.jobs.maxChildren, 15);
  near(p.estimate.costUsd, 0.663);
  near(p.estimate.minutes, 7);
  assert.equal(p.estimate.peakConcurrency, 3);
  assert.equal(p.lanes.length, 2);
});

test('manifest without leads counts each job as a child', () => {
  const m = { version: 1, jobs: [{ id: 'j1', prompt: 'x' }, { id: 'j2', prompt: 'y' }, { id: 'j3', prompt: 'z' }, { id: 'j4', prompt: 'w' }] };
  const p = estimatePlan(m, { lanes: lanes(PRICE, 2), calibration: {} });
  assert.equal(p.jobs.expectedChildren, 4);
  assert.equal(p.jobs.maxChildren, 4);
  assert.equal(p.leads.length, 0);
  assert.equal(p.estimate.peakConcurrency, 1);
  near(p.estimate.costUsd, 0.16);
});

test('calibration ratios apply once and childrenPerLead overrides the prior', () => {
  const p = estimatePlan(goal1(), { lanes: lanes(), calibration: { costRatio: 2, timeRatio: 0.5, childrenPerLead: 3 } });
  assert.equal(p.jobs.expectedChildren, 3);
  near(p.estimate.costUsd, 0.282);
  near(p.estimate.minutes, 1.5);
  assert.equal(p.estimate.calibrated, true);
});

test('childrenPerLead is clamped to 1..maxJobs', () => {
  assert.equal(estimatePlan(goal1(), { lanes: lanes(), calibration: { childrenPerLead: 50 } }).jobs.expectedChildren, 10);
  assert.equal(estimatePlan(goal1(), { lanes: lanes(), calibration: { childrenPerLead: 0 } }).jobs.expectedChildren, 1);
  assert.equal(PRIORS.childrenPerLead, 6);
});

test('recordActual divides out applied ratios and does not compound', () => {
  const c = recordActual(EMPTY, { id: 'r1', estimate: { costUsd: 0.282, minutes: 3, appliedCostRatio: 2, appliedTimeRatio: 0.5 }, actual: { costUsd: 0.282, minutes: 1.5 } });
  near(c.costRatio, 2);
  near(c.timeRatio, 0.25);
  assert.equal(c.runs.length, 1);
});

test('recordActual clamps ratios to 0.1..10', () => {
  const c = recordActual(EMPTY, { id: 'big', estimate: { costUsd: 1, minutes: 1 }, actual: { costUsd: 1000, minutes: 0.0001 } });
  near(c.costRatio, 10);
  near(c.timeRatio, 0.1);
});

test('recordActual ignores zero estimates and keeps ratios at 1', () => {
  const c = recordActual(EMPTY, { id: 'zero', estimate: { costUsd: 0, minutes: 1 }, actual: { costUsd: 5, minutes: 1 } });
  near(c.costRatio, 1);
  near(c.timeRatio, 1);
  assert.equal(c.childrenPerLead, undefined);
});

test('every risk code is reported when it applies', () => {
  assert.ok(codes(estimatePlan(manifestForGoal('x', { folders: ['secrets', 'b'], leads: 1, maxJobs: 5, concurrency: 1 }), { lanes: lanes(), calibration: {} })).includes('sensitive-folder'));
  const plain = {
    version: 1,
    jobs: [
      { id: 'a', prompt: 'x', context: ['config/.env.local'], deletes: [] },
      ...Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, prompt: 'x', deletes: Array.from({ length: 8 }, (__, k) => `old/${i}-${k}.txt`) })),
    ],
  };
  const plainCodes = codes(estimatePlan(plain, { lanes: lanes(), calibration: {} }));
  assert.ok(plainCodes.includes('sensitive-folder'));
  assert.ok(plainCodes.includes('big-delete'));
  assert.ok(!plainCodes.includes('deletes-unknown'));
  assert.ok(codes(estimatePlan(goal1({ maxUsd: 0.1 }), { lanes: lanes(), calibration: {} })).includes('over-budget'));
  assert.ok(codes(estimatePlan(goal1({ maxTokens: 1000 }), { lanes: lanes(), calibration: {} })).includes('over-tokens'));
  assert.ok(codes(estimatePlan(manifestForGoal('x', { folders: ['a'], leads: 1, maxJobs: 120, concurrency: 1 }), { lanes: lanes(), calibration: {} })).includes('many-jobs'));
  assert.ok(codes(estimatePlan(goal1(), { lanes: lanes(), calibration: {} })).includes('deletes-unknown'));
});

test('subscription lanes cost zero and formatPreview strips control characters', () => {
  const m = manifestForGoal('fix\u0007 the\nbug', { folders: ['a'], leads: 1, maxJobs: 5, concurrency: 1 });
  const p = estimatePlan(m, { lanes: lanes(null), calibration: {} });
  assert.equal(p.estimate.costUsd, 0);
  const text = formatPreview(p);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text));
  assert.match(text, /subscription lanes are not counted/);
  assert.match(text, /Leads: 1/);
  assert.match(text, /Risks:/);
  assert.ok(text.split('\n').length < 40);
});

test('save and load round trip', async t => {
  const root = await tempRoot(t);
  const m = goal1();
  const plan = planFor(m);
  const file = await savePlan(root, plan);
  assert.match(file, /plan-abc123\.json$/);
  const back = await loadPlan(root, 'plan-abc123');
  assert.equal(back.id, plan.id);
  assert.deepEqual(back.manifest, m);
  assert.equal(back.hash, planHash(m));
});

test('loadPlan refuses a bad id', async t => {
  const root = await tempRoot(t);
  await assert.rejects(loadPlan(root, '../etc/passwd'), /plan-invalid: id/);
});

test('loadPlan reports a missing plan', async t => {
  const root = await tempRoot(t);
  await assert.rejects(loadPlan(root, 'plan-missing-1'), /plan-not-found: plan-missing-1/);
});

test('loadPlan refuses a tampered manifest', async t => {
  const root = await tempRoot(t);
  const plan = planFor(goal1());
  const file = await savePlan(root, plan);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.manifest.budget.maxUsd = 999;
  await fs.writeFile(file, JSON.stringify(stored));
  await assert.rejects(loadPlan(root, plan.id), /plan-invalid: hash/);
});

test('savePlan refuses an existing plan id', async t => {
  const root = await tempRoot(t);
  const plan = planFor(goal1());
  await savePlan(root, plan);
  await assert.rejects(savePlan(root, plan));
});

test('savePlan refuses a symlinked .swarm/plans', async t => {
  const root = await tempRoot(t);
  const outside = await tempRoot(t);
  await fs.mkdir(path.join(root, '.swarm'));
  await fs.symlink(outside, path.join(root, '.swarm', 'plans'));
  await assert.rejects(savePlan(root, planFor(goal1())));
  assert.deepEqual(await fs.readdir(outside), []);
});
