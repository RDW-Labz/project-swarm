// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTicket, TICKET_TYPES } from '../tools/tickets.mjs';
import { migrationTicketCheck } from '../tools/ticket-sync-checks.mjs';

const base = {
  id: 'T-0099',
  title: 'Rename module',
  type: 'rename',
  epic: 'E',
  scopeRefs: ['R-001'],
  acceptance: [],
  files: ['src/new.ts'],
  deletes: ['src/old.ts'],
  context: [],
  contracts: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'todo',
  stage: 'S1',
};

test('TICKET_TYPES includes rename', () => {
  assert.ok(TICKET_TYPES.includes('rename'));
});

test('validateTicket accepts a rename with exactly one file and one delete', () => {
  const r = validateTicket(base);
  assert.equal(r.ok, true, r.errors?.join('; '));
});

test('validateTicket rejects rename tickets with wrong file/delete counts', () => {
  let r = validateTicket({ ...base, files: [], deletes: ['src/old.ts'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /exactly one new file in files and exactly one path in deletes/);

  r = validateTicket({ ...base, files: ['a.ts', 'b.ts'], deletes: ['src/old.ts'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /exactly one new file/);

  r = validateTicket({ ...base, files: ['src/new.ts'], deletes: ['a', 'b'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /exactly one path in deletes/);
});

test('validateTicket: migration ticket files under supabase/migrations must be .sql', () => {
  const mig = {
    ...base,
    type: 'migration',
    acceptance: ['schema'],
    files: ['supabase/migrations/0001_init.sql'],
    deletes: undefined,
  };
  assert.equal(validateTicket(mig).ok, true);

  const bad = { ...mig, files: ['supabase/migrations/readme.md'] };
  const r = validateTicket(bad);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /supabase\/migrations/);
});

test('migration ticket DDL check still applies to supabase/migrations SQL', async () => {
  const ticket = {
    ...base,
    type: 'migration',
    acceptance: ['ddl'],
    files: ['supabase/migrations/0002.sql'],
    deletes: undefined,
  };
  const readFile = async () => Buffer.from('CREATE TABLE t (id int);\n', 'utf8');
  assert.equal((await migrationTicketCheck(ticket, { readFile })).ok, true);

  const readDml = async () => Buffer.from('INSERT INTO t VALUES (1);\n', 'utf8');
  const r = await migrationTicketCheck(ticket, { readFile: readDml });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /DDL only/);
});
