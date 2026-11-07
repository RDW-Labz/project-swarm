// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeJob } from '../tools/router.mjs';
import { resolveLanes } from '../tools/lanes.mjs';

const lanes = {
  cursor: { model: 'cursor-model' },
  codex: { model: 'codex-model' },
  anthropic: { model: 'haiku' },
  openrouter: { model: 'deepseek/deepseek-v4.1-flash-1017', reviewModel: 'google/gemini-3.1-pro-preview', allowCodeOutputs: true },
};
const notCursorOrCodex = agent => !['cursor', 'codex'].includes(agent);

test('a review routed to OpenRouter is graded by reviewModel; build jobs keep the lane model', () => {
  const review = { id: 'r', agent: 'auto', type: 'review', sensitive: false, outputs: [], context: ['src/a.js'] };
  const build = { id: 'b', agent: 'auto', type: 'build', sensitive: false, outputs: ['src/a.js'] };
  assert.deepEqual(
    (({ agent, model }) => ({ agent, model }))(routeJob(review, { lanes, laneReady: notCursorOrCodex })),
    { agent: 'openrouter', model: 'google/gemini-3.1-pro-preview' },
  );
  assert.equal(routeJob(build, { lanes, laneReady: notCursorOrCodex }).model, 'deepseek/deepseek-v4.1-flash-1017');
});

test('Cursor still grades first when it is healthy', () => {
  const review = { id: 'r', agent: 'auto', type: 'review', sensitive: false, outputs: [], context: ['src/a.js'] };
  assert.equal(routeJob(review, { lanes }).agent, 'cursor');
});

test('sensitive and restricted reviews never reach Gemini', () => {
  const sensitive = { id: 's', agent: 'auto', type: 'review', sensitive: true, outputs: [], context: ['src/a.js'] };
  const payments = { id: 'p', agent: 'auto', type: 'review', sensitive: false, outputs: [], context: ['src/payments/square.js'] };
  for (const job of [sensitive, payments]) {
    const route = routeJob(job, { lanes, laneReady: notCursorOrCodex });
    assert.notEqual(route.agent, 'openrouter');
  }
});

test('lane config accepts reviewModel and refuses a bad one', () => {
  const resolved = resolveLanes({ config: { lanes: { openrouter: { model: 'x/y', reviewModel: 'google/gemini-3.1-pro-preview' } } }, env: {} });
  assert.equal(resolved.openrouter.reviewModel, 'google/gemini-3.1-pro-preview');
  assert.throws(() => resolveLanes({ config: { lanes: { openrouter: { reviewModel: 'bad model!' } } }, env: {} }), /openrouter.reviewModel/);
});
