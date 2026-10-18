// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../tools/init.mjs';
import { validateProfile } from '../tools/init-profile.mjs';
import { migrationQueueCheck } from '../tools/migration-queue.mjs';
import { downFileFor } from '../tools/migration-gate.mjs';

// A model of which files `supabase db push` / `supabase migration up` pick up. The CLI lists ONLY the files directly inside supabase/migrations
// (not subfolders, not sibling folders), keeps the ones named <digits>_<name>.sql, and takes <digits> as the version; two files with the same
// version are a duplicate-key error. This is the behaviour the parts app hit with 0009_x.down.sql next to 0009_x.sql (the name part is
// "x.down"). The real CLI is not run here (it needs Docker and a database); this models its documented file rule.
async function supabasePushPlan(migrationsDir) {
  const versions = new Map();
  for (const entry of await fs.readdir(migrationsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^([0-9]+)_(.*)\.sql$/.exec(entry.name);
    if (!match) continue;
    if (versions.has(match[1])) throw new Error(`duplicate migration version ${match[1]}: ${versions.get(match[1])} and ${entry.name}`);
    versions.set(match[1], entry.name);
  }
  return [...versions.values()].sort();
}

async function supabaseProject(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-down-dir-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'supabase/migrations'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}');
  return root;
}
const source = process.cwd();

test('model of the Supabase CLI file rule: a Supabase project\'s down files stay out of the migrations folder, while sibling files collide', async t => {
  const root = await supabaseProject(t);
  const { profile } = await initProject(root, { source });
  const config = profile.migrations;
  assert.equal(config.down, 'dir');
  const up = 'supabase/migrations/0009_add_x.sql';
  await fs.writeFile(path.join(root, up), 'create table x (id int);');
  const down = downFileFor(up, config);
  assert.equal(down, 'supabase/migrations_down/0009_add_x.sql');
  await fs.mkdir(path.dirname(path.join(root, down)), { recursive: true });
  await fs.writeFile(path.join(root, down), 'drop table x;');
  assert.deepEqual(await supabasePushPlan(path.join(root, 'supabase/migrations')), ['0009_add_x.sql'], 'only the up file is applied');
  assert.ok(!down.startsWith('supabase/migrations/'), 'the down folder is outside the migrations folder');
  // The old layout: the sibling down file is a second migration with the same version.
  await fs.writeFile(path.join(root, 'supabase/migrations/0009_add_x.down.sql'), 'drop table x;');
  await assert.rejects(supabasePushPlan(path.join(root, 'supabase/migrations')), /duplicate migration version 0009/);
});

test('the profile accepts down dir with downDir, and down none', () => {
  assert.deepEqual(validateProfile({ version: 1, migrations: { dir: 'supabase/migrations', down: 'dir' } }).profile?.migrations ?? {}, { dir: 'supabase/migrations', down: 'dir', downDir: 'supabase/migrations_down' });
  assert.deepEqual(validateProfile({ version: 1, migrations: { dir: 'db/m', down: 'dir', downDir: 'db/d' } }).profile?.migrations, { dir: 'db/m', down: 'dir', downDir: 'db/d' });
  assert.deepEqual(validateProfile({ version: 1, migrations: { dir: 'db/m', down: 'none' } }).profile?.migrations, { dir: 'db/m', down: 'none' });
  assert.ok(validateProfile({ version: 1, migrations: { dir: 'supabase/migrations', down: 'dir', downDir: 'supabase/migrations/down' } }).errors.some(e => /separate folder/.test(e)));
});

test('the merge queue check sees a change in the down folder and checks its migration', async t => {
  const root = await supabaseProject(t);
  const profile = { migrations: { dir: 'supabase/migrations', down: 'dir', downDir: 'supabase/migrations_down' } };
  await fs.writeFile(path.join(root, 'supabase/migrations/0009_a.sql'), 'create table a (id int);');
  const exec = async () => ({ code: 0, stdout: '', stderr: '' });
  const missingDown = await migrationQueueCheck({ root, changes: [{ file: 'supabase/migrations/0009_a.sql', bytes: Buffer.from('create table a (id int);') }], profile, exec });
  assert.match(missingDown.blocks[0].message, /no-down: migration supabase\/migrations\/0009_a\.sql has no down step \(add supabase\/migrations_down\/0009_a\.sql\)/);
  const withDown = await migrationQueueCheck({ root, changes: [{ file: 'supabase/migrations/0009_a.sql', bytes: Buffer.from('create table a (id int);') }, { file: 'supabase/migrations_down/0009_a.sql', bytes: Buffer.from('drop table a;') }], profile, exec });
  assert.deepEqual(withDown.blocks, []);
  // Only the down file changed: its migration is checked again (and an emptied down file blocks).
  await fs.mkdir(path.join(root, 'supabase/migrations_down'), { recursive: true });
  await fs.writeFile(path.join(root, 'supabase/migrations_down/0009_a.sql'), '');
  const downOnly = await migrationQueueCheck({ root, changes: [{ file: 'supabase/migrations_down/0009_a.sql', bytes: Buffer.from('') }], profile, exec });
  assert.match(downOnly.blocks[0]?.message ?? '', /no-down/);
});

test('review fixes: a deleted down file blocks, a stray .down.sql in the migrations folder is flagged and scanned, a symlinked down file is not a down step', async t => {
  const root = await supabaseProject(t);
  const profile = { migrations: { dir: 'supabase/migrations', down: 'dir', downDir: 'supabase/migrations_down' } };
  const exec = async () => ({ code: 0, stdout: '', stderr: '' });
  await fs.mkdir(path.join(root, 'supabase/migrations_down'), { recursive: true });
  await fs.writeFile(path.join(root, 'supabase/migrations/0009_a.sql'), 'create table a (id int);');
  await fs.writeFile(path.join(root, 'supabase/migrations_down/0009_a.sql'), 'drop table a;');
  // Only a deletion of the down file: the migration loses its down step (the file is gone from the tree after the batch).
  await fs.rm(path.join(root, 'supabase/migrations_down/0009_a.sql'));
  const deleted = await migrationQueueCheck({ root, changes: [{ file: 'supabase/migrations_down/0009_a.sql', bytes: null }], profile, exec });
  assert.match(deleted.blocks[0]?.message ?? '', /no-down: migration supabase\/migrations\/0009_a\.sql has no down step/);
  // A stray 0010_x.down.sql in the migrations folder is applied by the tool: flagged, and its destructive SQL is still scanned.
  const stray = await migrationQueueCheck({ root, changes: [{ file: 'supabase/migrations/0010_x.down.sql', bytes: Buffer.from('drop table users;') }], profile, exec });
  assert.ok(stray.blocks.some(b => /down-in-migrations-dir/.test(b.message)), JSON.stringify(stray.blocks));
  assert.ok(stray.blocks.some(b => /needs-approval/.test(b.message)), 'drop table in the stray file needs approval');
  const none = await migrationQueueCheck({ root, changes: [{ file: 'supabase/migrations/0010_x.down.sql', bytes: Buffer.from('drop table users;') }], profile: { migrations: { dir: 'supabase/migrations', down: 'none' } }, exec });
  assert.ok(none.blocks.some(b => /needs-approval/.test(b.message)));
  // A down file that is a symlink to the migration itself is not a down step.
  await fs.symlink(path.join(root, 'supabase/migrations/0009_a.sql'), path.join(root, 'supabase/migrations_down/0009_a.sql'));
  const linked = await migrationQueueCheck({ root, changes: [{ file: 'supabase/migrations/0009_a.sql', bytes: Buffer.from('create table a (id int);') }], profile, exec });
  assert.match(linked.blocks[0]?.message ?? '', /no-down/);
});

test('review fixes: folder separation is case-insensitive, backslashes and drive letters are refused, downDir null is an error, case-variant migration paths are still checked', async () => {
  const { validateMigrationsConfig, isMigrationFile } = await import('../tools/migration-gate.mjs');
  for (const downDir of ['Supabase/Migrations', 'supabase/Migrations/down', 'supabase\\migrations\\down', 'C:/x', null]) {
    assert.equal(validateMigrationsConfig({ dir: 'supabase/migrations', down: 'dir', downDir }).ok, false, String(downDir));
  }
  assert.equal(validateMigrationsConfig({ dir: 'supabase\\migrations', down: 'none' }).ok, false);
  const config = validateMigrationsConfig({ dir: 'supabase/migrations', down: 'dir' }).config;
  assert.equal(isMigrationFile('supabase/Migrations/0011_x.sql', config), true, 'case-variant path is still a migration');
  assert.equal(downFileFor('other/0011_x.sql', config), null);
  assert.equal(downFileFor('supabase/migrations/../x.sql', config), null);
  // The profile keeps migrations.env.
  assert.deepEqual(validateProfile({ version: 1, migrations: { dir: 'db/m', down: 'none', env: ['DATABASE_URL'] } }).profile?.migrations, { dir: 'db/m', down: 'none', env: ['DATABASE_URL'] });
});
