// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../tools/swarm.mjs';
import { goGoal, isGoalArgument, manifestForGoal } from '../tools/goal.mjs';

test('a sentence is a goal and a manifest path or run id is not', () => {
  assert.equal(isGoalArgument('Add a health check'), true);
  assert.equal(isGoalArgument('run-0001'), false);
  assert.equal(isGoalArgument('examples/smoke.json'), false);
  assert.equal(isGoalArgument('smoke.json'), false);
});

test('a goal manifest is one strict lead the runner can validate', () => {
  const manifest = manifestForGoal('Add a health check', { checks: [{ name: 'test', argv: ['npm', 'test'] }] });
  validateManifest(manifest);
  assert.equal(manifest.report, 'short');
  assert.equal(manifest.jobs[0].type, 'lead');
  assert.equal(manifest.jobs[0].area.goal, 'Add a health check');
  assert.deepEqual(manifest.checks, [{ name: 'test', argv: ['npm', 'test'] }]);
});

test('go on a goal plans, runs, merges through the queue, then rolls up', async () => {
  const order = [];
  const result = await goGoal('/tmp/repo', 'Add a health check', {}, {
    plan: () => { order.push('plan'); return manifestForGoal('Add a health check'); },
    run: async () => { order.push('run'); return { id: 'run-1' }; },
    wait: async () => { order.push('wait'); return { status: 'complete', costUsd: 0.1, warnings: [] }; },
    integrate: async (_root, id, options) => { order.push(`integrate:${id}:${options.queue}`); return { status: 'integrated', checkFailed: [] }; },
    rollup: async () => { order.push('rollup'); return { id: 'run-1', status: 'complete' }; },
  });
  assert.deepEqual(order, ['plan', 'run', 'wait', 'integrate:run-1:true', 'rollup']);
  assert.equal(result.status, 'complete');
  assert.equal(result.stage, 'rollup');
  assert.equal(result.runId, 'run-1');
  assert.equal(result.cost, 0.1);
});

test('a goal that does not finish is not integrated', async () => {
  let integrated = false;
  const result = await goGoal('/tmp/repo', 'Add a health check', {}, {
    plan: () => manifestForGoal('Add a health check'),
    run: async () => ({ id: 'run-1' }),
    wait: async () => ({ status: 'failed', costUsd: null, warnings: [] }),
    integrate: async () => { integrated = true; return { status: 'integrated' }; },
    rollup: async () => ({ id: 'run-1' }),
  });
  assert.equal(integrated, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'run');
});

test('a goal does not commit or open a pull request', async () => {
  const result = await goGoal('/tmp/repo', 'Add a health check', { commitMessage: 'x' }, {});
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'plan');
});
