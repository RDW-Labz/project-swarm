// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteOnlyTicketPasses,
  renameTicketCheck,
  migrationTicketCheck,
  syncCheckForTicket,
  sqlMigrationDdlOnlyProblems,
} from '../tools/ticket-sync-checks.mjs';

const base = {
  id: 'T-0001',
  title: 'x',
  epic: 'E',
  scopeRefs: ['R-001'],
  acceptance: ['ok'],
  context: [],
  contracts: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'review',
  stage: 'S1',
};

test('deleteOnlyTicketPasses: true when files is empty and every delete path is gone', () => {
  const ticket = { ...base, type: 'build', files: [], deletes: ['src/old.ts', 'src/other.ts'] };
  const exists = p => p === 'src/other.ts';
  assert.equal(deleteOnlyTicketPasses(ticket, { exists }), false);
  assert.equal(deleteOnlyTicketPasses(ticket, { exists: () => false }), true);
});

test('deleteOnlyTicketPasses: false when files is non-empty or deletes is empty', () => {
  const exists = () => false;
  assert.equal(deleteOnlyTicketPasses({ ...base, type: 'build', files: ['src/a.ts'], deletes: ['src/old.ts'] }, { exists }), false);
  assert.equal(deleteOnlyTicketPasses({ ...base, type: 'build', files: [], deletes: [] }, { exists }), false);
});

test('syncCheckForTicket: delete-only kind passes once paths are absent', async () => {
  const ticket = { ...base, type: 'build', files: [], deletes: ['src/old.ts'] };
  let onDisk = new Set(['src/old.ts']);
  let r = await syncCheckForTicket(ticket, { exists: p => onDisk.has(p) });
  assert.equal(r.kind, 'delete-only');
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /still exists/);
  onDisk = new Set();
  r = await syncCheckForTicket(ticket, { exists: p => onDisk.has(p) });
  assert.equal(r.ok, true);
});

test('renameTicketCheck: shape and post-work paths', () => {
  const rename = { ...base, type: 'rename', files: ['src/new.ts'], deletes: ['src/old.ts'] };
  let r = renameTicketCheck(rename, { exists: p => p === 'src/old.ts' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /does not exist yet/);
  assert.match(r.problems.join(' '), /still exists/);

  r = renameTicketCheck(rename, { exists: p => p === 'src/new.ts' });
  assert.equal(r.ok, true);

  r = renameTicketCheck({ ...rename, files: ['a', 'b'], deletes: ['src/old.ts'] }, { exists: () => false });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /exactly one new file/);

  r = renameTicketCheck({ ...rename, files: ['src/new.ts'], deletes: [] }, { exists: () => false });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /exactly one path in deletes/);
});

test('syncCheckForTicket: rename kind', async () => {
  const ticket = { ...base, type: 'rename', files: ['src/new.ts'], deletes: ['src/old.ts'] };
  const r = await syncCheckForTicket(ticket, { exists: p => p === 'src/new.ts' });
  assert.equal(r.kind, 'rename');
  assert.equal(r.ok, true);
});

test('migrationTicketCheck: DDL-only under supabase/migrations', async () => {
  const ddl = 'CREATE TABLE notes (id uuid primary key);\n';
  const dml = 'INSERT INTO notes VALUES (gen_random_uuid());\n';
  const ticket = {
    ...base,
    type: 'migration',
    files: ['supabase/migrations/0001.sql', 'tests/db/notes.test.sql'],
  };
  const files = new Map([
    ['supabase/migrations/0001.sql', ddl],
    ['tests/db/notes.test.sql', 'SELECT plan(1);\n'],
  ]);
  const readFile = async f => Buffer.from(files.get(f) ?? '', 'utf8');
  let r = await migrationTicketCheck(ticket, { readFile });
  assert.equal(r.ok, true);

  files.set('supabase/migrations/0001.sql', dml);
  r = await migrationTicketCheck(ticket, { readFile });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /DDL only/);
  assert.match(r.problems.join(' '), /INSERT/i);
});

test('sqlMigrationDdlOnlyProblems: rejects UPDATE', () => {
  const problems = sqlMigrationDdlOnlyProblems('UPDATE users SET name = $1 WHERE id = $2;', 'supabase/migrations/x.sql');
  assert.ok(problems.length);
  assert.match(problems[0], /UPDATE/);
});

test('syncCheckForTicket: normal kind for ordinary build ticket', async () => {
  const ticket = { ...base, type: 'build', files: ['src/a.ts'], deletes: [] };
  const r = await syncCheckForTicket(ticket, { exists: () => true });
  assert.equal(r.kind, 'normal');
  assert.equal(r.ok, true);
});
