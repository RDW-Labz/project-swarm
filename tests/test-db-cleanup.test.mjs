// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertLocalDatabaseUrl, cleanupTestDatabase } from '../tools/test-db-cleanup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'tools', 'test-db-cleanup.mjs');
const isolateImport = path.join(here, '_isolate-config.mjs');

function runtimePassword() {
  return ['p', 'a', 's', 's', 'w', 'o', 'r', 'd', '-', 'x'].join('');
}

function expectLocal(url) {
  assertLocalDatabaseUrl(url);
}

function expectRemote(url, hostFragment) {
  assert.throws(
    () => assertLocalDatabaseUrl(url),
    (err) => {
      assert.equal(err.code, 'test-db-not-local');
      assert.match(err.message, new RegExp(hostFragment, 'i'));
      assert.doesNotMatch(err.message, /password-x/i);
      assert.doesNotMatch(err.message, new RegExp(runtimePassword()));
      return true;
    },
  );
}

test('accepts postgres and postgresql on localhost and loopback', () => {
  const pw = runtimePassword();
  expectLocal(`postgres://user:${pw}@localhost/mydb`);
  expectLocal(`postgresql://user:${pw}@127.0.0.1/mydb`);
  expectLocal(`postgres://user:${pw}@[::1]/mydb`);
});

test('accepts mysql on local hosts', () => {
  const pw = runtimePassword();
  expectLocal(`mysql://user:${pw}@localhost/app`);
  expectLocal(`mysql://user:${pw}@127.0.0.1/app`);
});

test('accepts sqlite and file URLs without a remote host', () => {
  expectLocal('sqlite:///tmp/test.db');
  expectLocal('sqlite:relative.db');
  expectLocal('file:/var/data/app.db');
});

test('accepts postgres unix socket via host query param', () => {
  const pw = runtimePassword();
  expectLocal(`postgres://user:${pw}@/mydb?host=/var/run/postgresql`);
});

test('refuses remote hostnames and cloud providers', () => {
  const pw = runtimePassword();
  expectRemote(`postgres://user:${pw}@db.example.com/mydb`, 'db\\.example\\.com');
  expectRemote(`postgres://user:${pw}@myhost.local/mydb`, 'myhost\\.local');
  expectRemote(`postgres://user:${pw}@xyz.supabase.co/postgres`, 'supabase');
  expectRemote(`postgres://user:${pw}@cluster.neon.tech/neondb`, 'neon');
  expectRemote(`postgres://user:${pw}@mydb.abcdef.us-east-1.rds.amazonaws.com/app`, 'rds');
  expectRemote(`postgres://user:${pw}@aws.connect.psdb.cloud/main`, 'planetscale|psdb');
});

test('refuses non-local IP addresses', () => {
  const pw = runtimePassword();
  expectRemote(`postgres://user:${pw}@10.0.0.5/db`, '10\\.0\\.0\\.5');
  expectRemote(`postgres://user:${pw}@192.168.1.1/db`, '192\\.168\\.1\\.1');
});

test('refuses disallowed protocols and unparseable URLs', () => {
  const pw = runtimePassword();
  assert.throws(() => assertLocalDatabaseUrl(`mongodb://user:${pw}@localhost/db`), (err) => {
    assert.equal(err.code, 'test-db-not-local');
    return true;
  });
  assert.throws(() => assertLocalDatabaseUrl('not-a-valid-url'), (err) => {
    assert.equal(err.code, 'test-db-not-local');
    assert.match(err.message, /parseable host/i);
    return true;
  });
});

test('error text never includes the password', () => {
  const pw = runtimePassword();
  const url = `postgres://dbuser:${pw}@remote-db.example.org/production`;
  let caught;
  try {
    assertLocalDatabaseUrl(url);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'test-db-not-local');
  const text = `${caught.message}`;
  assert.ok(!text.includes(pw));
  assert.ok(!text.includes(url));
  assert.match(text, /remote-db\.example\.org/);
});

test('cleanupTestDatabase asserts before dropSchema', async () => {
  let called = false;
  await assert.rejects(
    () =>
      cleanupTestDatabase('postgres://u:p@remote.example.com/db', {
        dropSchema: async () => {
          called = true;
        },
      }),
    (err) => err.code === 'test-db-not-local',
  );
  assert.equal(called, false);
});

test('cleanupTestDatabase dryRun skips dropSchema', async () => {
  const result = await cleanupTestDatabase('postgres://u:p@localhost/myapp', { dryRun: true });
  assert.deepEqual(result, { dryRun: true, name: 'myapp' });
});

test('cleanupTestDatabase invokes dropSchema with database name', async () => {
  const names = [];
  await cleanupTestDatabase('postgresql://u:p@127.0.0.1/tenant_one', {
    dropSchema: async (name) => {
      names.push(name);
    },
  });
  assert.deepEqual(names, ['tenant_one']);
});

test('CLI exits 1 for non-local URL', () => {
  const pw = runtimePassword();
  const url = `postgres://user:${pw}@prod.neon.tech/main`;
  const r = spawnSync(process.execPath, ['--import', isolateImport, cliPath, url], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /neon/i);
  assert.ok(!`${r.stderr}${r.stdout}`.includes(pw));
});

test('CLI accepts local URL with dry-run', () => {
  const pw = runtimePassword();
  const url = `postgres://user:${pw}@localhost/testdb`;
  const r = spawnSync(process.execPath, ['--import', isolateImport, cliPath, url, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  assert.equal(r.status, 0);
});
