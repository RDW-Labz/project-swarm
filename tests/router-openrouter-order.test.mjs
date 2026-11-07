// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeJob } from '../tools/router.mjs';

const codeJob = { id: 'or-order', agent: 'auto', sensitive: false, outputs: ['src/a.js'] };
const lanes = {
  cursor: { model: 'cursor-model' },
  codex: { model: 'codex-model' },
  anthropic: { model: 'haiku' },
  openrouter: { model: 'deepseek/deepseek-v4.1-flash', allowCodeOutputs: true },
  claude: { model: 'claude-model' },
};

test('allowCodeOutputs: non-sensitive code routes cursor → codex → openrouter → anthropic', () => {
  assert.equal(routeJob(codeJob, { lanes }).agent, 'cursor');
  assert.equal(routeJob(codeJob, { lanes, laneReady: agent => agent !== 'cursor' }).agent, 'codex');
  assert.equal(
    routeJob(codeJob, { lanes, laneReady: agent => !['cursor', 'codex'].includes(agent) }).agent,
    'openrouter',
  );
  assert.equal(
    routeJob(codeJob, { lanes, laneReady: agent => !['cursor', 'codex', 'openrouter'].includes(agent) }).agent,
    'anthropic',
  );
});

test('allowCodeOutputs: failures on cursor and codex fall back to openrouter', () => {
  assert.equal(
    routeJob(codeJob, { lanes, failures: { cursor: 2, codex: 2 } }).agent,
    'openrouter',
  );
});

test('allowCodeOutputs off: the same code job never gets openrouter', () => {
  const noCode = { ...lanes, openrouter: { model: lanes.openrouter.model, allowCodeOutputs: false } };
  assert.notEqual(routeJob(codeJob, { lanes: noCode }).agent, 'openrouter');
  assert.equal(
    routeJob(codeJob, { lanes: noCode, laneReady: agent => !['cursor', 'codex'].includes(agent) }).agent,
    'anthropic',
  );
});

test('sensitive code jobs never get openrouter even with allowCodeOutputs', () => {
  const sensitive = { ...codeJob, sensitive: true };
  assert.notEqual(routeJob(sensitive, { lanes }).agent, 'openrouter');
  const onlyOr = { openrouter: lanes.openrouter, claude: lanes.claude };
  assert.throws(() => routeJob(sensitive, { lanes: onlyOr }), { code: 'route-exhausted' });
});

test('restricted topics never get openrouter when cursor and codex are not ready', () => {
  const notCheap = { lanes, laneReady: agent => !['cursor', 'codex'].includes(agent) };
  assert.equal(routeJob({ ...codeJob, outputs: ['migrations/001.sql'] }, notCheap).agent, 'anthropic');
  assert.equal(routeJob({ ...codeJob, context: ['src/auth/login.mjs'] }, notCheap).agent, 'anthropic');
  assert.equal(routeJob({ ...codeJob, prompt: 'Wire up Square payment flow.' }, notCheap).agent, 'anthropic');
  assert.equal(routeJob({ ...codeJob, type: 'migration', outputs: ['src/a.js'] }, notCheap).agent, 'anthropic');
});

test('review and tier expensive never return a lane with laneReady false', () => {
  const review = { id: 'rev', agent: 'auto', type: 'review', sensitive: false, outputs: ['src/a.js'], context: ['src/a.js'] };
  const expensive = { ...codeJob, tier: 'expensive' };
  const noClaude = { lanes, laneReady: agent => agent !== 'claude' };
  assert.notEqual(routeJob(review, noClaude).agent, 'claude');
  assert.throws(() => routeJob(expensive, { lanes, laneReady: () => false }), { code: 'route-exhausted' });
  assert.equal(routeJob(review, noClaude).agent, 'cursor');
});
