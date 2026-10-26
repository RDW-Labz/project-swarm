// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';

function ticket(over = {}) {
  return {
    id: 'T-0100',
    title: 'Work',
    type: 'build',
    stage: 'S1',
    scopeRefs: [],
    acceptance: ['done'],
    files: ['src/x.mjs'],
    context: [],
    contracts: [],
    dependsOn: [],
    size: 'S',
    risk: 'low',
    sensitive: false,
    status: 'ready',
    ...over,
  };
}

test('human tickets do not count against maxJobs', () => {
  const humans = Array.from({ length: 6 }, (_, i) =>
    ticket({
      id: `T-000${i + 1}`,
      type: 'human',
      title: `Human ${i + 1}`,
      steps: ['step'],
      files: [],
      acceptance: [],
    }),
  );
  const builds = [
    ticket({ id: 'T-0101', stage: 'S1' }),
    ticket({ id: 'T-0102', stage: 'S1' }),
    ticket({ id: 'T-0103', stage: 'S1' }),
  ];
  const r = ticketsToManifest([...humans, ...builds], { ready: false, maxJobs: 2 });
  const buildJobs = r.manifest.jobs.filter(j => j.type !== 'human');
  assert.equal(buildJobs.length, 2);
  assert.deepEqual(buildJobs.map(j => j.id), ['T-0101', 'T-0102']);
  assert.equal(r.manifest.jobs.filter(j => j.type === 'human').length, 6);
});

test('round-robin across stages picks one ticket per stage before repeating', () => {
  const tickets = [
    ticket({ id: 'T-0001', stage: 'S3' }),
    ticket({ id: 'T-9999', stage: 'S10' }),
    ticket({ id: 'T-0002', stage: 'S3' }),
  ];
  const r = ticketsToManifest(tickets, { ready: false, maxJobs: 2 });
  assert.deepEqual(r.manifest.jobs.map(j => j.id), ['T-0001', 'T-9999']);
  assert.equal(r.skipped.length, 1);
  assert.ok(r.warnings.some(w => w === 'T-0002: over maxJobs, skipped'));
});

test('without maxJobs every ready ticket is included', () => {
  const tickets = [
    ticket({ id: 'T-0001', stage: 'S1' }),
    ticket({ id: 'T-0002', stage: 'S2' }),
    ticket({ id: 'T-0003', type: 'human', steps: ['a'], files: [], acceptance: [] }),
  ];
  const r = ticketsToManifest(tickets, { ready: false });
  assert.equal(r.manifest.jobs.length, 3);
  assert.deepEqual(r.skipped, []);
  assert.ok(!r.warnings.some(w => w.includes('over maxJobs')));
});

test('skipped tickets still get over maxJobs warnings', () => {
  const tickets = [
    ticket({ id: 'T-0001' }),
    ticket({ id: 'T-0002' }),
    ticket({ id: 'T-0003' }),
  ];
  const r = ticketsToManifest(tickets, { ready: false, maxJobs: 1 });
  assert.equal(r.manifest.jobs.length, 1);
  assert.deepEqual(r.skipped, ['T-0002', 'T-0003']);
  assert.ok(r.warnings.includes('T-0002: over maxJobs, skipped'));
  assert.ok(r.warnings.includes('T-0003: over maxJobs, skipped'));
});
