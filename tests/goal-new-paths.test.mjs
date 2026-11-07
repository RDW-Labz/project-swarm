// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../tools/swarm.mjs';
import { goalNewPaths, manifestForGoal } from '../tools/goal.mjs';

test('Add docs/fleet.md with folders scripts and fleet puts docs/ in a lead scope', () => {
  const m = manifestForGoal('Add docs/fleet.md', { folders: ['scripts', 'fleet'], files: [] });
  validateManifest(m);
  const scopes = m.jobs.flatMap(job => job.area.scope);
  assert.ok(scopes.some(scope => scope === 'docs/'), scopes);
});

test('goalNewPaths ignores paths under an existing top-level folder', () => {
  assert.deepEqual(goalNewPaths('Update app/new.js', { folders: ['app'], files: [] }), []);
});

test('goalNewPaths adds a new root file as an exact entry', () => {
  assert.deepEqual(goalNewPaths('Add CHANGELOG.md', { folders: ['src'], files: ['README.md'] }), ['CHANGELOG.md']);
  const m = manifestForGoal('Add CHANGELOG.md', { folders: ['src'], files: ['README.md'] });
  validateManifest(m);
  const scopes = m.jobs.flatMap(job => job.area.scope);
  assert.ok(scopes.includes('CHANGELOG.md'));
});

test('goalNewPaths ignores URLs, absolute paths, parent segments, and dotfiles', () => {
  const goal = 'See https://example.com/a.md and /etc/passwd and ../x.md plus .env';
  assert.deepEqual(goalNewPaths(goal, { folders: [], files: [] }), []);
});

test('a repo with no folders and no tracked files still plans one lead for a named new path', () => {
  const m = manifestForGoal('Add docs/fleet.md', { folders: [], files: [] });
  validateManifest(m);
  assert.equal(m.jobs.length, 1);
  assert.deepEqual(m.jobs[0].area.scope, ['docs/']);
  assert.match(m.jobs[0].prompt, /^You own only these folders: docs\/\./);
});

test('goalNewPaths deduplicates, sorts, and caps at 10 entries', () => {
  const goal = 'Add docs/a.md docs/b.md wiki/c.md';
  const paths = goalNewPaths(goal, { folders: ['src'], files: [] });
  assert.deepEqual(paths, ['docs/', 'wiki/']);
  const many = Array.from({ length: 15 }, (_, n) => `dir${n}/file.md`).join(' ');
  assert.equal(goalNewPaths(`Add ${many}`, { folders: [], files: [] }).length, 10);
});
