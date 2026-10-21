// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteOnlyTicketPasses, migrationTicketCheck, renameTicketCheck, syncCheckForTicket } from '../tools/ticket-sync-checks.mjs';

test('delete-only and rename checks use the physical tree state', async () => {
  const deleteTicket = { type: 'build', files: [], deletes: ['src/old.mjs'] };
  assert.equal(deleteOnlyTicketPasses(deleteTicket, { exists: file => file === 'src/old.mjs' }), false);
  assert.equal(deleteOnlyTicketPasses(deleteTicket, { exists: () => false }), true);
  assert.equal((await syncCheckForTicket(deleteTicket, { exists: () => false })).kind, 'delete-only');

  const rename = { type: 'rename', files: ['src/new.mjs'], deletes: ['src/old.mjs'] };
  assert.equal(renameTicketCheck(rename, { exists: file => file === 'src/old.mjs' }).ok, false);
  assert.equal(renameTicketCheck(rename, { exists: () => false }).ok, false);
  assert.equal(renameTicketCheck(rename, { exists: file => file === 'src/new.mjs' }).ok, true);
});

test('migration sync preserves the DDL-only rule', async () => {
  const ticket = { type: 'migration', files: ['supabase/migrations/0001_change.sql'] };
  const dml = await migrationTicketCheck(ticket, { readFile: async () => Buffer.from('insert into items values (1);') });
  assert.equal(dml.ok, false);
  assert.match(dml.problems[0], /DDL only.*INSERT/);
  const ddl = await migrationTicketCheck(ticket, { readFile: async () => Buffer.from('create table items (id integer);') });
  assert.equal(ddl.ok, true);
});
