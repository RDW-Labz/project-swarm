// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criticalPathLength, ticketsToManifest } from '../tools/ticket-manifest.mjs';

function ticket(over = {}) {
  return {
    id: 'T-0040', title: 'Build feature', type: 'build', stage: 'S1', scopeRefs: [],
    acceptance: ['feature works'], files: ['src/feature.mjs'], context: [], contracts: [],
    dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'ready', ...over,
  };
}

test('a build ticket owns and is prompted to write the tests it lists', () => {
  const { manifest } = ticketsToManifest([ticket({ tests: ['tests/feature.test.mjs'] })], { ready: false });
  const job = manifest.jobs[0];
  assert.deepEqual(job.outputs, ['src/feature.mjs', 'tests/feature.test.mjs']);
  assert.match(job.prompt, /owns and must write these test files: tests\/feature\.test\.mjs/);
});

test('a test file owned by another open ticket stays context-only', () => {
  const owner = ticket({ id: 'T-0041', type: 'test', files: [], tests: ['tests/shared.test.mjs'] });
  const build = ticket({ id: 'T-0042', tests: ['tests/shared.test.mjs'] });
  const { manifest } = ticketsToManifest([owner, build], { ready: false });
  const job = manifest.jobs.find(item => item.id === 'T-0042');
  assert.deepEqual(job.outputs, ['src/feature.mjs']);
  assert.deepEqual(job.context, ['tests/shared.test.mjs']);
  assert.doesNotMatch(job.prompt, /owns and must write these test files/);
});

test('build-owned tests shorten the critical path compared with a separate test ticket per build', () => {
  const buildOwnsTests = [
    { id: 'T-0101', dependsOn: [] },
    { id: 'T-0102', dependsOn: ['T-0101'] },
  ];
  const separateTestTickets = [
    { id: 'T-0101', dependsOn: [] },
    { id: 'T-0101-test', dependsOn: ['T-0101'] },
    { id: 'T-0102', dependsOn: ['T-0101-test'] },
    { id: 'T-0102-test', dependsOn: ['T-0102'] },
  ];
  assert.equal(criticalPathLength(buildOwnsTests), 2);
  assert.equal(criticalPathLength(separateTestTickets), 4);
  assert.ok(criticalPathLength(buildOwnsTests) < criticalPathLength(separateTestTickets));
});
