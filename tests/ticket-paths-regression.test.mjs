// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTicketPaths,
  formatTicketPathRefusal,
  pathIsDirectory,
  closestRepoPath,
} from '../tools/ticket-paths.mjs';

const REPO = [
  'lessons/swarm/lesson-299.md',
  'tools/scope-commands.mjs',
  'src/lib/utils.ts',
  'package.json',
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

test('regression: a new output in a new folder is allowed', () => {
  const r = validateTicketPaths(
    {
      id: 'T-1',
      files: ['src/features/brand-new.ts'],
      context: [],
      contracts: [],
      tests: [],
      deletes: [],
    },
    { repoFiles: REPO },
  );
  assert.equal(r.ok, true);
});

test('regression: a missing delete path is allowed', () => {
  const r = validateTicketPaths(
    {
      id: 'T-1',
      files: [],
      context: [],
      contracts: [],
      tests: [],
      deletes: ['src/old.ts'],
    },
    { repoFiles: REPO },
  );
  assert.equal(r.ok, true);
});

test('regression: a far miss on context has no closest-path suggestion', () => {
  const r = validateTicketPaths(
    {
      id: 'T-1',
      files: ['src/lib/utils.ts'],
      context: ['docs/x.md'],
      contracts: [],
      tests: [],
      deletes: [],
    },
    { repoFiles: REPO },
  );
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].path, 'docs/x.md');
  assert.equal(r.errors[0].suggestion, null);
  assert.match(formatTicketPathRefusal('T-1', r.errors[0]), /docs\/x\.md missing file/);
  assert.doesNotMatch(formatTicketPathRefusal('T-1', r.errors[0]), /closest real path/);
});

test('regression: closestRepoPath does not suggest package.json for unrelated paths', () => {
  assert.equal(closestRepoPath('docs/x.md', REPO), null);
});

test('regression: on edits only newly added paths are validated', () => {
  const prior = {
    id: 'T-1',
    files: ['src/a.ts'],
    context: ['docs/missing-on-ticket.md'],
    contracts: [],
    tests: [],
    deletes: ['src/gone.ts'],
  };
  const next = {
    ...prior,
    files: ['src/a.ts', 'src/b.ts'],
    context: ['docs/missing-on-ticket.md', 'docs/also-missing.md'],
    deletes: ['src/gone.ts', 'src/another-gone.ts'],
  };
  const r = validateTicketPaths(next, { repoFiles: REPO, priorTicket: prior });
  assert.equal(r.ok, true, 'unchanged missing context/delete and new outputs/deletes pass');
  const bad = validateTicketPaths(
    { ...next, context: [...next.context, 'lessons/swarm'] },
    { repoFiles: REPO, priorTicket: prior },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].path, 'lessons/swarm');
});
