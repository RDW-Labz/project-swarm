// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOTAL_CAP_USD, DAY_CAP_USD, JOB_CAP_USD, caps, dayCapWouldRefuse, assertWithinCaps, usageCostUsd,
} from '../tools/anthropic.mjs';
import { routeJob } from '../tools/router.mjs';
import { applyJobType } from '../tools/job-types.mjs';
import { resolveLanes } from '../tools/lanes.mjs';
import { batchEligible, batchPolicyFor } from '../tools/batch.mjs';
import { anthropicUserContent, inlineContext } from '../tools/api-adapters.mjs';

test('anthropic spend caps: owner-approved day $20, total $500, job $5; day mode stop refuses before send', () => {
  assert.equal(DAY_CAP_USD, 20);
  assert.equal(TOTAL_CAP_USD, 500);
  assert.equal(JOB_CAP_USD, 5);
  const limits = caps({ SWARM_CONFIG: '/nonexistent/config.json' });
  assert.equal(limits.dayUsd, 20);
  assert.equal(limits.dayMode, 'stop');
  assert.equal(dayCapWouldRefuse({ worstUsd: 0.5, spent: { today: 19.6, job: 0, total: 0 }, limits }), true);
  assert.throws(() => assertWithinCaps({ worstUsd: 0.5, spent: { today: 19.6, job: 0, total: 0 }, limits }), /day cap/);
  const notify = { ...limits, dayMode: 'notify' };
  assert.doesNotThrow(() => assertWithinCaps({ worstUsd: 0.5, spent: { today: 19.6, job: 0, total: 0 }, limits: notify }));
});

test('codex is paused in default lane config; router skips it unless paused is false', () => {
  const resolved = resolveLanes();
  assert.equal(resolved.codex.paused, true);
  const lanes = {
    cursor: { model: 'u', paused: false },
    codex: { model: 'c' },
    anthropic: { model: 'claude-haiku-5-5' },
  };
  const job = { id: 'j', agent: 'auto', sensitive: false, outputs: ['src/a.js'] };
  assert.equal(routeJob(job, { lanes: { ...lanes, codex: { model: 'c', paused: true } } }).agent, 'cursor');
  assert.equal(routeJob(job, { lanes: { ...lanes, codex: { model: 'c', paused: false } } }).agent, 'cursor');
});

test('local lane is first for docs when healthy; unknown local slot is skipped', () => {
  const job = { id: 'd', agent: 'auto', type: 'docs', sensitive: false, outputs: ['README.md'], typeRoute: ['local', 'anthropic', 'cursor'] };
  const lanes = { anthropic: { model: 'claude-haiku-5-5' }, cursor: { model: 'u' } };
  assert.equal(routeJob(job, { lanes }).agent, 'anthropic');
  const withLocal = { local: { model: 'qwen-local' }, ...lanes };
  assert.equal(routeJob(job, { lanes: withLocal }).agent, 'local');
});

test('anthropic model tiering: Haiku builds, Sonnet for hard build or review, Opus for security review only', () => {
  const lanes = { anthropic: { model: 'claude-haiku-5-5' }, cursor: { model: 'u' } };
  const build = { id: 'b', agent: 'auto', type: 'build', sensitive: true, outputs: ['src/a.js'], typeRoute: ['anthropic', 'cursor'] };
  assert.equal(routeJob(build, { lanes }).model, 'claude-haiku-5-5');
  assert.equal(routeJob({ ...build, risk: 'high' }, { lanes }).model, 'claude-sonnet-5-5');
  assert.equal(routeJob(build, { lanes, failures: { anthropic: 1 } }).model, 'claude-sonnet-5-5');
  const review = { id: 'r', agent: 'auto', type: 'review', sensitive: false, outputs: [], typeRoute: ['anthropic', 'cursor'] };
  assert.equal(routeJob(review, { lanes }).model, 'claude-sonnet-5-5');
  const sec = { ...review, sensitive: true, securityReview: true, tier: 'expensive' };
  assert.equal(routeJob(sec, { lanes }).model, 'claude-opus-5-5');
});

test('API anthropic lane concurrency follows machineConcurrency', () => {
  assert.equal(resolveLanes({ config: { machineConcurrency: 12 } }).anthropic.concurrency, 12);
  assert.equal(resolveLanes({ config: {} }).anthropic.concurrency, 64);
});

test('prompt cache: identical shared context yields the same cached prefix across jobs', () => {
  const files = [{ path: 'b.txt', content: 'b' }, { path: 'a.txt', content: 'shared' }];
  const { inlined } = inlineContext(files);
  const base = { prompt: 'task', outputs: ['out.txt'], cacheContext: ['a.txt'] };
  const one = anthropicUserContent({ ...base, id: '1' }, inlined);
  const two = anthropicUserContent({ ...base, id: '2', prompt: 'other task' }, inlined);
  assert.ok(Array.isArray(one) && Array.isArray(two));
  assert.deepEqual(one[0], two[0]);
  assert.deepEqual(one[0].cache_control, { type: 'ephemeral' });
  assert.equal(one[1].cache_control, undefined);
  const usage = { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 50 };
  const cost = usageCostUsd('claude-haiku-5-5', usage);
  assert.ok(cost < usageCostUsd('claude-haiku-5-5', { input_tokens: 6100, output_tokens: 50 }));
});

test('batch reviews default on listed projects; urgent bypasses batch', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'api-workers-batch-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await fs.promises.writeFile(file, JSON.stringify({ batch: { enabled: true, projects: [path.join(dir, 'proj')], reviews: true } }));
  const env = { ...process.env, SWARM_CONFIG: file };
  const policy = batchPolicyFor({}, false, env, path.join(dir, 'proj'));
  assert.deepEqual(policy.types, ['review']);
  const review = { agent: 'anthropic', type: 'review' };
  assert.equal(batchEligible(review, policy), true);
  assert.equal(batchEligible({ ...review, urgent: true }, policy), false);
  assert.equal(batchEligible({ ...review, batch: false }, policy), false);
});
