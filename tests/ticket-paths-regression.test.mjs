// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTicketPaths,
  formatTicketPathRefusal,
  pathIsDirectory,
} from '../tools/ticket-paths.mjs';

const REPO = [
  'lessons/swarm/lesson-299.md',
  'tools/scope-commands.mjs',
  'src/lib/utils.ts',
];

test('regression: lessons/swarm is a directory, not a context file', () => {
  const ticket = {
    id: 'T-0220',
    files: ['src/lib/utils.ts'],
    context: ['lessons/swarm'],
    contracts: [],
    tests: [],
    deletes: [],
  };
  const r = validateTicketPaths(ticket, { repoFiles: REPO });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].path, 'lessons/swarm');
  assert.equal(r.errors[0].reason, 'is a directory');
  assert.match(formatTicketPathRefusal('T-0220', r.errors[0]), /^T-0220: lessons\/swarm is a directory/);
});

test('regression: scope-comands typo suggests scope-commands.mjs', () => {
  const ticket = {
    id: 'T-0036',
    files: ['tools/scope-comands.mjs'],
    context: [],
    contracts: [],
    tests: [],
    deletes: [],
  };
  const r = validateTicketPaths(ticket, { repoFiles: REPO });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].suggestion, 'tools/scope-commands.mjs');
  const line = formatTicketPathRefusal('T-0036', r.errors[0]);
  assert.match(line, /tools\/scope-comands\.mjs likely typo/);
  assert.match(line, /closest real path: tools\/scope-commands\.mjs/);
});

test('pathIsDirectory matches tracked children without listing the folder itself', () => {
  assert.equal(pathIsDirectory('lessons/swarm', REPO), true);
  assert.equal(pathIsDirectory('tools/scope-commands.mjs', REPO), false);
});
