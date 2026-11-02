// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentsToCheck, doctor } from '../tools/swarm.mjs';
import { manifestForGoal } from '../tools/goal.mjs';

test('auto is never sent to doctor, so a manifest with auto jobs can run', async () => {
  const manifest = { version: 1, jobs: [{ id: 'a', agent: 'auto' }, { id: 'b', agent: 'codex' }, { id: 'c', agent: 'auto' }, { id: 'd', agent: 'anthropic' }] };
  assert.deepEqual(agentsToCheck(manifest), ['codex', 'anthropic']);
  assert.deepEqual(agentsToCheck({ jobs: [{ id: 'a', agent: 'auto' }] }), []);
  await assert.rejects(doctor({ agent: 'auto' }), /Unsupported API adapter/);
});

test('every manifest swarm go plans passes the agent check', () => {
  const planned = manifestForGoal('add a thing', { folders: ['src', 'docs'], leads: 'auto', maxJobs: 5, concurrency: 2, checks: [], maxUsd: 1, maxTokens: 1000 });
  const agents = agentsToCheck(planned);
  assert.equal(agents.includes('auto'), false);
});
