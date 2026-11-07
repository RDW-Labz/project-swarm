// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeJob } from '../tools/router.mjs';
import { validateManifest } from '../tools/swarm.mjs';
import { applyReviewEscalation, needsOpusFix, reviewFailuresFromEnv } from '../tools/review-escalation.mjs';

const lanes = {
  cursor: { model: 'cursor-model' },
  codex: { model: 'codex-model' },
  anthropic: { model: 'claude-haiku-5-5' },
  openrouter: { model: 'deepseek/deepseek-v4.1-flash-1017', allowCodeOutputs: true },
  claude: { model: 'claude-model', expensiveModel: 'claude-opus-5-5' },
};
const fix = { id: 'fix-1', agent: 'auto', type: 'fix', sensitive: false, prompt: 'Fix the review findings.', context: ['src/a.js'], outputs: ['src/a.js'] };

test('the env count is read strictly', () => {
  assert.equal(reviewFailuresFromEnv({}), 0);
  assert.equal(reviewFailuresFromEnv({ SWARM_REVIEW_FAILURES: '2' }), 2);
  for (const bad of ['-1', '2.5', 'two', '999']) assert.equal(reviewFailuresFromEnv({ SWARM_REVIEW_FAILURES: bad }), 0);
});

test('one failed review changes nothing; two send build and fix jobs to Opus as auto', () => {
  const once = applyReviewEscalation({ version: 1, jobs: [{ ...fix, agent: 'cursor', model: 'm' }] }, { SWARM_REVIEW_FAILURES: '1' });
  assert.deepEqual(once.jobs[0], { ...fix, agent: 'cursor', model: 'm' });
  const twice = applyReviewEscalation({ version: 1, jobs: [{ ...fix, agent: 'cursor', model: 'm' }, { ...fix, id: 'r', type: 'review', outputs: [] }, { ...fix, id: 'lead', type: 'lead' }] }, { SWARM_REVIEW_FAILURES: '2' });
  assert.deepEqual(
    (({ agent, model, tier, reviewFailures }) => ({ agent, model, tier, reviewFailures }))(twice.jobs[0]),
    { agent: 'auto', model: undefined, tier: 'expensive', reviewFailures: 2 },
  );
  assert.match(twice.jobs[0].tierReason, /2 failed reviews/);
  assert.equal(twice.jobs[1].reviewFailures, undefined, 'reviews are not escalated');
  assert.equal(twice.jobs[2].reviewFailures, undefined, 'leads are not escalated');
});

test('a job already carrying reviewFailures keeps the lane it was routed to', () => {
  const routed = { ...fix, agent: 'anthropic', model: 'claude-opus-5-5', reviewFailures: 2, tier: 'expensive', tierReason: 'x' };
  assert.deepEqual(applyReviewEscalation({ version: 1, jobs: [{ ...routed }] }, { SWARM_REVIEW_FAILURES: '3' }).jobs[0], routed);
});

test('the escalated fix routes to the anthropic lane on Opus, then claude; doctor gate still applies', () => {
  const job = applyReviewEscalation({ version: 1, jobs: [{ ...fix }] }, { SWARM_REVIEW_FAILURES: '2' }).jobs[0];
  assert.ok(needsOpusFix(job));
  const first = routeJob(job, { lanes });
  assert.deepEqual({ agent: first.agent, model: first.model }, { agent: 'anthropic', model: 'claude-opus-5-5' });
  assert.match(first.reason, /2 failed reviews: Opus/);
  const noAnthropic = routeJob(job, { lanes, laneReady: agent => agent !== 'anthropic' });
  assert.deepEqual({ agent: noAnthropic.agent, model: noAnthropic.model }, { agent: 'claude', model: 'claude-opus-5-5' });
  assert.throws(() => routeJob(job, { lanes, laneReady: agent => !['anthropic', 'claude'].includes(agent) }), /route-exhausted/);
});

test('without failed reviews the same fix still goes Cursor first', () => {
  assert.equal(routeJob({ ...fix }, { lanes }).agent, 'cursor');
});

test('validateManifest applies the env count and accepts the escalated job', () => {
  const manifest = { version: 1, jobs: [{ ...fix }] };
  validateManifest(manifest, { env: { ...process.env, SWARM_REVIEW_FAILURES: '2' } });
  assert.equal(manifest.jobs[0].tier, 'expensive');
  assert.equal(manifest.jobs[0].reviewFailures, 2);
  assert.throws(() => validateManifest({ version: 1, jobs: [{ ...fix, reviewFailures: -1 }] }), /reviewFailures must be an integer/);
});
