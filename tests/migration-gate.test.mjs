import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MIGRATION_DEFAULTS,
  validateMigrationsConfig,
  isMigrationFile,
  downFileFor,
  destructiveStatements,
  checkMigrations,
  runRoundTrip,
  migrationEnv,
} from '../tools/migration-gate.mjs';
const NL = String.fromCharCode(10);
const sha = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');
const base = { dir: 'supabase/migrations', down: 'sibling' };
const cfg = (over) => validateMigrationsConfig({ ...base, ...over }).config;
test('config: defaults are applied', () => {
  const r = validateMigrationsConfig({});
  assert.equal(r.ok, true);
  assert.equal(r.config.dir, MIGRATION_DEFAULTS.dir);
  assert.equal(r.config.down, 'sibling');
});
test('config: unknown keys, bad down, bad commands and bad dir are errors', () => {
  const r = validateMigrationsConfig({ down: 'nope', extra: 1, dir: '../x', commands: { up: 'x', bogus: ['a'] } });
  assert.equal(r.ok, false);
  assert.equal(r.config, null);
  assert.ok(r.errors.some((e) => e.includes('unknown key: extra')));
  assert.ok(r.errors.some((e) => e.includes('down must be')));
  assert.ok(r.errors.some((e) => e.includes('unknown command: bogus')));
  assert.ok(r.errors.some((e) => e.includes('commands.up must be')));
  assert.ok(r.errors.some((e) => e.includes('dir must be')));
});
test('config: accepts argv commands', () => {
  const r = validateMigrationsConfig({ commands: { up: ['npx', 'migrate', 'up'] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.commands.up, ['npx', 'migrate', 'up']);
});
test('isMigrationFile and downFileFor', () => {
  const c = cfg({});
  assert.equal(isMigrationFile('supabase/migrations/001_x.sql', c), true);
  assert.equal(isMigrationFile('supabase/migrations/001_x.down.sql', c), false);
  assert.equal(isMigrationFile('other/001_x.sql', c), false);
  assert.equal(downFileFor('a/001_x.sql'), 'a/001_x.down.sql');
});
test('down sibling: missing and empty down files are problems', async () => {
  const c = cfg({});
  const files = ['supabase/migrations/001_a.sql'];
  const up = async () => Buffer.from('create table t (id int);');
  const missing = await checkMigrations({ files, config: c, read: up, exists: async () => false });
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].check, 'no-down');
  assert.equal(missing.problems[0].message, 'migration supabase/migrations/001_a.sql has no down step (add supabase/migrations/001_a.down.sql)');
  const empty = await checkMigrations({
    files,
    config: c,
    read: async (f) => (f.endsWith('.down.sql') ? Buffer.alloc(0) : Buffer.from('create table t (id int);')),
    exists: async () => true,
  });
  assert.equal(empty.problems[0].check, 'no-down');
  const good = await checkMigrations({
    files,
    config: c,
    read: async (f) => Buffer.from(f.endsWith('.down.sql') ? 'drop table t;' : 'create table t (id int);'),
    exists: async () => true,
  });
  assert.equal(good.ok, true);
});
test('down section: marker must be followed by a statement', async () => {
  const c = cfg({ down: 'section' });
  const files = ['supabase/migrations/001_a.sql'];
  const noMarker = Buffer.from('create table t (id int);');
  const emptyMarker = Buffer.from(['create table t (id int);', '-- migrate:down', ''].join(NL));
  const good = Buffer.from(['create table t (id int);', '-- migrate:down', 'drop table t;'].join(NL));
  const a = await checkMigrations({ files, config: c, read: async () => noMarker, exists: async () => false });
  assert.equal(a.problems[0].check, 'no-down');
  const b = await checkMigrations({ files, config: c, read: async () => emptyMarker, exists: async () => false });
  assert.equal(b.problems[0].check, 'no-down');
  const g = await checkMigrations({ files, config: c, read: async () => good, exists: async () => false });
  assert.equal(g.ok, true);
});
test('destructive: comments and string literals are ignored', () => {
  const sql = ['-- drop table x;', '/* truncate t; */', `insert into t values ('delete from t; drop table y');`, 'select 1;'].join(NL);
  assert.deepEqual(destructiveStatements(sql), []);
});
test('destructive: delete and update without where are flagged, with where are not', () => {
  assert.deepEqual(
    destructiveStatements('delete from users;').map((s) => s.kind),
    ['delete-all'],
  );
  assert.equal(destructiveStatements('delete from users;')[0].line, 1);
  assert.deepEqual(destructiveStatements('delete from users where id = 2;'), []);
  assert.deepEqual(
    destructiveStatements('update users set x = 1;').map((s) => s.kind),
    ['update-all'],
  );
  assert.deepEqual(destructiveStatements('update users set x = 1 where id = 2;'), []);
});
test('destructive: drop, truncate, alter type and rename are flagged with line numbers', () => {
  const sql = [
    'select 1;',
    'drop table t;',
    'alter table t drop column c;',
    'truncate t;',
    'alter table t alter column c type text;',
    'alter table t rename column a to b;',
  ].join(NL);
  const found = destructiveStatements(sql);
  assert.deepEqual(
    found.map((s) => s.kind),
    ['drop-table', 'drop-column', 'truncate', 'alter-type', 'rename'],
  );
  assert.equal(found[0].line, 2);
  assert.equal(found[4].line, 6);
});
test('approval is bound to the file hash', async () => {
  const file = 'supabase/migrations/002_drop.sql';
  const body = 'drop table t;';
  const down = 'create table t (id int);';
  const read = async (f) => Buffer.from(f.endsWith('.down.sql') ? down : body);
  const exists = async () => true;
  const c = cfg({});
  const first = await checkMigrations({ files: [file], config: c, read, exists });
  assert.equal(first.ok, false);
  assert.equal(first.problems[0].check, 'needs-approval');
  assert.equal(first.needsApproval[0].sha256, sha(body));
  const approved = await checkMigrations({ files: [file], config: c, read, exists, approvals: [{ file, sha256: sha(body), at: 'x', note: 'y' }] });
  assert.equal(approved.ok, true);
  const edited = await checkMigrations({
    files: [file],
    config: c,
    read: async (f) => Buffer.from(f.endsWith('.down.sql') ? down : body + ' '),
    exists,
    approvals: [{ file, sha256: sha(body), at: 'x', note: 'y' }],
  });
  assert.equal(edited.ok, false);
  const otherFile = await checkMigrations({
    files: [file],
    config: c,
    read,
    exists,
    approvals: [{ file: 'supabase/migrations/003_x.sql', sha256: sha(body), at: 'x', note: 'y' }],
  });
  assert.equal(otherFile.ok, false);
});
test('seed looks real is refused', async () => {
  const bad = [
    ['node', 'scripts/seed.mjs', '--from', 'backups/prod.sql'],
    ['pg_restore', 'dump.sql.gz'],
    ['load', 'my_dump_file'],
  ];
  for (const seed of bad) {
    const config = validateMigrationsConfig({ commands: { up: ['u'], down: ['d'], seed } }).config;
    const r = await checkMigrations({ files: [], config, read: async () => Buffer.alloc(0), exists: async () => false });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.check === 'seed-looks-real'));
  }
  const good = validateMigrationsConfig({
    commands: { up: ['u'], down: ['d'], seed: ['node', 'scripts/seed.mjs', '--fixture', 'synthetic'] },
  }).config;
  const g = await checkMigrations({ files: [], config: good, read: async () => Buffer.alloc(0), exists: async () => false });
  assert.equal(
    g.problems.some((p) => p.check === 'seed-looks-real'),
    false,
  );
});
test('round trip runs up seed down up in order', async () => {
  const config = validateMigrationsConfig({ commands: { up: ['u'], down: ['d'], seed: ['s'] } }).config;
  const calls = [];
  const exec = async (argv, opts) => {
    calls.push(argv[0]);
    assert.equal(opts.cwd, '/tmp/x');
    return { code: 0, stdout: 'ok', stderr: '' };
  };
  const r = await runRoundTrip({ root: '/tmp/x', config, exec });
  assert.deepEqual(calls, ['u', 's', 'd', 'u']);
  assert.deepEqual(
    r.steps.map((s) => s.name),
    ['up', 'seed', 'down', 'up'],
  );
  assert.equal(r.ok, true);
});
test('round trip stops at first failure', async () => {
  const config = validateMigrationsConfig({ commands: { up: ['u'], down: ['d'], seed: ['s'] } }).config;
  const calls = [];
  const exec = async (argv) => {
    calls.push(argv[0]);
    return argv[0] === 'd' ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '', stderr: '' };
  };
  const r = await runRoundTrip({ root: '/tmp/x', config, exec });
  assert.deepEqual(calls, ['u', 's', 'd']);
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[2].ok, false);
  assert.equal(r.steps[2].tail, 'boom');
});
test('round trip skips seed when not set and does nothing without up and down', async () => {
  const calls = [];
  const exec = async (argv) => {
    calls.push(argv[0]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const noSeed = validateMigrationsConfig({ commands: { up: ['u'], down: ['d'] } }).config;
  const r = await runRoundTrip({ root: '/tmp/x', config: noSeed, exec });
  assert.deepEqual(calls, ['u', 'd', 'u']);
  assert.deepEqual(
    r.steps.map((s) => s.name),
    ['up', 'down', 'up'],
  );
  const none = await runRoundTrip({ root: '/tmp/x', config: validateMigrationsConfig({}).config, exec });
  assert.deepEqual(none, { ok: true, steps: [] });
});
test('round trip tail is the last 400 characters', async () => {
  const config = validateMigrationsConfig({ commands: { up: ['u'], down: ['d'] } }).config;
  const exec = async () => ({ code: 0, stdout: 'x'.repeat(500), stderr: '' });
  const r = await runRoundTrip({ root: '/tmp/x', config, exec });
  assert.equal(r.steps[0].tail.length, 400);
});

test('review findings: quoted identifiers, dollar quotes, E strings, DROP without COLUMN, CTE deletes, privileged calls are all found', () => {
  const kinds = (sql) => destructiveStatements(sql).map((s) => s.kind);
  assert.deepEqual(kinds('DELETE FROM "users";'), ['delete-all']);
  assert.deepEqual(kinds('ALTER TABLE "t" DROP COLUMN "c";'), ['drop-column']);
  assert.deepEqual(kinds('alter table t drop c;'), ['drop-column']);
  assert.deepEqual(kinds('alter table t alter c type text;'), ['alter-type']);
  assert.deepEqual(kinds('alter table "t" rename to u;'), ['rename']);
  assert.deepEqual(kinds('DO $$ BEGIN DROP TABLE users; END $$;'), ['drop-table'], 'a DO body is code');
  assert.deepEqual(kinds("DO $f$ BEGIN PERFORM 'it''s'; DELETE FROM t; END $f$;"), ['delete-all']);
  assert.deepEqual(kinds("select E'\\'' ; DROP TABLE x; -- '"), ['drop-table'], 'an E string with an escaped quote does not hide the next statement');
  assert.deepEqual(kinds('with d as (delete from t returning *) select 1;'), ['delete-all']);
  assert.deepEqual(kinds('delete from t where id in (select id from u);'), []);
  assert.deepEqual(kinds('delete from t where id in (select 1 where true);'), []);
  assert.deepEqual(kinds('delete from t using u;'), ['delete-all']);
  assert.deepEqual(kinds('drop view v; drop materialized view m; drop sequence s; drop database d;'), ['drop-other', 'drop-other', 'drop-other', 'drop-other']);
  assert.deepEqual(kinds("copy t from program 'curl x'; create extension file_fdw; select pg_read_file('/etc/passwd');"), ['privileged', 'privileged', 'privileged']);
  assert.deepEqual(kinds('drop index i; alter table t drop constraint c; alter table t drop default; insert into t values (1) on conflict (id) do update set a = 1; select * from t for update;'), []);
  assert.deepEqual(kinds('/* drop table x; */ select 1; -- delete from t'), [], 'comments hide nothing real');
});

test('review findings: section marker in a comment or string, dir normalisation, case, down-only edits, whitespace down files, env names', async () => {
  const cfg = (raw) => { const r = validateMigrationsConfig(raw); assert.ok(r.ok, r.errors.join()); return r.config; };
  assert.equal(cfg({ dir: './supabase//migrations/' }).dir, 'supabase/migrations');
  assert.equal(validateMigrationsConfig({ dir: '././' }).ok, false);
  assert.equal(validateMigrationsConfig({ env: ['lower'] }).ok, false);
  assert.deepEqual(cfg({ env: ['DATABASE_URL'] }).env, ['DATABASE_URL']);
  const section = cfg({ down: 'section' });
  const files = new Map();
  const read = async (f) => Buffer.from(files.get(f));
  const exists = async (f) => files.has(f);
  const run = (names) => checkMigrations({ files: names, config: cfg({}), read, exists });
  files.set('supabase/migrations/001_a.sql', "select '-- migrate:down'; drop table a;\n");
  const fake = await checkMigrations({ files: ['supabase/migrations/001_a.sql'], config: section, read, exists });
  assert.ok(fake.problems.some((p) => p.check === 'no-down'), 'a marker inside a string is not a down section');
  files.set('supabase/migrations/002_b.sql', '/* -- migrate:down */ drop table b;\n');
  assert.ok((await checkMigrations({ files: ['supabase/migrations/002_b.sql'], config: section, read, exists })).problems.some((p) => p.check === 'no-down'));
  files.set('supabase/migrations/003_c.SQL', 'create table c (id int);\n');
  assert.ok((await run(['supabase/migrations/003_c.SQL'])).problems.some((p) => p.check === 'no-down'), 'an upper-case .SQL file is checked');
  files.set('supabase/migrations/004_d.sql', 'create table d (id int);\n');
  files.set('supabase/migrations/004_d.down.sql', '   \n-- nothing\n');
  assert.ok((await run(['supabase/migrations/004_d.sql'])).problems.some((p) => p.check === 'no-down'), 'a down file with only comments is empty');
  files.set('supabase/migrations/004_d.down.sql', 'drop table d;\n');
  assert.equal((await run(['supabase/migrations/004_d.down.sql'])).ok, true, 'a real down file passes');
  files.set('supabase/migrations/004_d.down.sql', '-- only a comment\n');
  assert.ok((await run(['supabase/migrations/004_d.down.sql'])).problems.some((p) => p.check === 'no-down'), 'an edit of the down file alone re-checks the pair');
});

test('runRoundTrip hands the commands a short environment', async () => {
  const seen = [];
  await runRoundTrip({ root: '/x', config: { commands: { up: ['u'], down: ['d'] }, env: ['DATABASE_URL'] }, exec: async (argv, o) => { seen.push(o.env); return { exitCode: 0, stdout: '', stderr: '' }; } });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].ANTHROPIC_API_KEY, undefined);
  assert.equal(typeof seen[0].PATH, 'string');
  assert.deepEqual(migrationEnv([], { PATH: 'p', OPENAI_API_KEY: 'k', DATABASE_URL: 'db' }), { PATH: 'p' });
  assert.deepEqual(migrationEnv(['DATABASE_URL'], { PATH: 'p', DATABASE_URL: 'db' }), { PATH: 'p', DATABASE_URL: 'db' });
});

// ---- down: "dir" and down: "none" (parts-app: Supabase reads 0009.down.sql as a duplicate migration; "section" runs the down right after the up) ----
const dirCfg = (over) => validateMigrationsConfig({ dir: 'supabase/migrations', down: 'dir', ...over });
test('down dir: the default folder is <dir>_down, the down file has the same name, and the path is mirrored', () => {
  const r = dirCfg({});
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.config.downDir, 'supabase/migrations_down');
  assert.equal(downFileFor('supabase/migrations/0009_add_x.sql', r.config), 'supabase/migrations_down/0009_add_x.sql');
  assert.equal(downFileFor('supabase/migrations/sub/0010_y.sql', r.config), 'supabase/migrations_down/sub/0010_y.sql');
  assert.equal(dirCfg({ downDir: 'db/down' }).config.downDir, 'db/down');
});
test('down dir: the down folder must be separate (never the migrations folder, inside it, or containing it) and downDir needs down "dir"', () => {
  for (const downDir of ['supabase/migrations', 'supabase/migrations/down', 'supabase', '../x', '/abs']) {
    const r = dirCfg({ downDir });
    assert.equal(r.ok, false, downDir);
  }
  assert.ok(validateMigrationsConfig({ dir: 'supabase/migrations', down: 'sibling', downDir: 'x' }).errors.some((e) => e.includes('downDir needs down')));
  assert.ok(validateMigrationsConfig({ down: 'bogus' }).errors.some((e) => e.includes('sibling, section, dir or none')));
});
test('down dir: a missing or empty down file in the down folder is a problem naming the folder; a good one passes; a down-only edit re-checks its migration', async () => {
  const c = dirCfg({}).config;
  const up = 'supabase/migrations/0009_a.sql', down = 'supabase/migrations_down/0009_a.sql';
  const files = new Map([[up, 'create table t (id int);']]);
  const io = { read: async (f) => Buffer.from(files.get(f) ?? ''), exists: async (f) => files.has(f) };
  const missing = await checkMigrations({ files: [up], config: c, ...io });
  assert.equal(missing.problems[0].message, `migration ${up} has no down step (add ${down})`);
  files.set(down, '-- nothing');
  assert.equal((await checkMigrations({ files: [up], config: c, ...io })).problems[0].check, 'no-down', 'comment-only down file');
  files.set(down, 'drop table t;');
  assert.equal((await checkMigrations({ files: [up], config: c, ...io })).ok, true);
  // A sibling-style .down.sql next to the migration does NOT count in dir mode.
  files.delete(down); files.set('supabase/migrations/0009_a.down.sql', 'drop table t;');
  assert.equal((await checkMigrations({ files: [up], config: c, ...io })).ok, false);
  // Editing only the down file checks the migration again, and a bad edit is caught.
  files.set(down, '');
  assert.equal((await checkMigrations({ files: [down], config: c, ...io })).problems[0].file, up);
});
test('down dir: destructive SQL still needs approval, and the approval is bound to the file hash', async () => {
  const c = dirCfg({}).config;
  const up = 'supabase/migrations/0010_drop.sql', down = 'supabase/migrations_down/0010_drop.sql';
  const bytes = Buffer.from('drop table old_things;');
  const io = { read: async (f) => (f === up ? bytes : Buffer.from('create table old_things (id int);')), exists: async () => true };
  const need = await checkMigrations({ files: [up], config: c, ...io });
  assert.equal(need.needsApproval.length, 1);
  assert.equal((await checkMigrations({ files: [up], config: c, ...io, approvals: [{ file: up, sha256: sha('drop table old_things;') }] })).ok, true);
  assert.equal((await checkMigrations({ files: [up], config: c, ...io, approvals: [{ file: up, sha256: sha('other') }] })).ok, false);
  assert.equal(isMigrationFile(down, c), false, 'a down file is never itself a migration');
});
test('down none: no down step is required, but the destructive scan and approval still apply', async () => {
  const r = validateMigrationsConfig({ dir: 'supabase/migrations', down: 'none' });
  assert.equal(r.ok, true);
  assert.equal(r.config.downDir, undefined);
  const up = 'supabase/migrations/0011_a.sql';
  const safe = await checkMigrations({ files: [up], config: r.config, read: async () => Buffer.from('create table t (id int);'), exists: async () => false });
  assert.equal(safe.ok, true, JSON.stringify(safe.problems));
  const bad = await checkMigrations({ files: [up], config: r.config, read: async () => Buffer.from('drop table t;'), exists: async () => false });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.map((p) => p.check), ['needs-approval']);
  const priv = await checkMigrations({ files: [up], config: r.config, read: async () => Buffer.from('create extension pg_stat_statements;'), exists: async () => false });
  assert.equal(priv.ok, false, 'privileged SQL still needs approval');
  assert.equal((await checkMigrations({ files: [up], config: r.config, read: async () => Buffer.from('drop table t;'), exists: async () => false, approvals: [{ file: up, sha256: sha('drop table t;') }] })).ok, true);
});
