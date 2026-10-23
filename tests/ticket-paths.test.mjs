// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listTicketPaths,
  closestRepoPath,
  levenshteinDistance,
  validateTicketPaths,
} from '../tools/ticket-paths.mjs';

const REPO = [
  'package.json',
  'docs/plan.md',
  'docs/scope/context/overview.md',
  'src/lib/utils.ts',
  'tests/utils.test.mjs',
  'tools/tickets.mjs',
];

function ticket(over = {}) {
  return {
    id: 'T-0001',
    files: ['src/lib/utils.ts'],
    context: ['docs/plan.md'],
    contracts: [],
    tests: [],
    deletes: [],
    ...over,
  };
}

test('listTicketPaths: collects writes, reads, tests and deletes', () => {
  const paths = listTicketPaths(ticket({
    files: ['src/a.ts'],
    context: ['docs/plan.md', 'T-0099'],
    contracts: ['contracts/api.json'],
    tests: ['tests/a.test.mjs'],
    deletes: ['src/old.ts'],
  }));
  assert.deepEqual(
    paths.map((x) => `${x.field}:${x.path}`).sort(),
    [
      'context:docs/plan.md',
      'contracts:contracts/api.json',
      'deletes:src/old.ts',
      'files:src/a.ts',
      'tests:tests/a.test.mjs',
    ].sort(),
  );
});

test('closestRepoPath: picks the smallest edit distance', () => {
  assert.equal(closestRepoPath('docs/plan.mdd', REPO), 'docs/plan.md');
  assert.equal(closestRepoPath('src/lib/util.ts', REPO), 'src/lib/utils.ts');
  assert.equal(closestRepoPath('tools/ticket.mjs', REPO), 'tools/tickets.mjs');
});

test('levenshteinDistance: matches known distances', () => {
  assert.equal(levenshteinDistance('kitten', 'sitting'), 3);
  assert.equal(levenshteinDistance('a', 'a'), 0);
});

test('AC1: every file a ticket writes or reads as context is checked against the repo tree', () => {
  const exists = (p) => REPO.includes(p);
  const ok = validateTicketPaths(ticket(), { repoFiles: REPO, exists });
  assert.equal(ok.ok, true);
  const bad = validateTicketPaths(ticket({ context: ['docs/missing.md'] }), { repoFiles: REPO, exists });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].field, 'context');
  assert.equal(bad.errors[0].path, 'docs/missing.md');
  const writeTypo = validateTicketPaths(ticket({ files: ['src/lib/util.ts'] }), { repoFiles: REPO, exists });
  assert.equal(writeTypo.ok, true);
  assert.equal(writeTypo.errors.length, 0);
  assert.equal(writeTypo.warnings.length, 1);
  assert.equal(writeTypo.warnings[0].code, 'similar-new-file');
  assert.equal(writeTypo.warnings[0].field, 'files');
});

test('AC1: delete-field typo and read-field missing file stay errors', () => {
  const exists = (p) => REPO.includes(p);
  const deleteTypo = validateTicketPaths(ticket({ deletes: ['tools/ticket.mjs'] }), { repoFiles: REPO, exists });
  assert.equal(deleteTypo.ok, false);
  assert.equal(deleteTypo.errors[0].field, 'deletes');
  assert.equal(deleteTypo.errors[0].reason, 'likely typo');
  const readMissing = validateTicketPaths(ticket({ context: ['docs/missing.md'] }), { repoFiles: REPO, exists });
  assert.equal(readMissing.ok, false);
  assert.equal(readMissing.errors[0].field, 'context');
});

test('AC1: a genuinely new write path with no close match is allowed', () => {
  const r = validateTicketPaths(
    ticket({ files: ['src/features/brand-new.ts'], context: [], tests: ['tests/brand-new.test.mjs'] }),
    { repoFiles: REPO, exists: (p) => REPO.includes(p) },
  );
  assert.equal(r.ok, true);
});

test('AC2: a ticket naming a missing file is rejected with the closest real path suggested', () => {
  const r = validateTicketPaths(ticket({ context: ['docs/plan.mdd'] }), { repoFiles: REPO });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].suggestion, 'docs/plan.md');
  assert.match(r.errors[0].message, /did you mean docs\/plan\.md\?/);
});

test('AC2: delete paths must exist and name the closest file when they do not', () => {
  const r = validateTicketPaths(ticket({ deletes: ['tools/ticket.mjs'] }), { repoFiles: REPO });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].suggestion, 'tools/tickets.mjs');
});
