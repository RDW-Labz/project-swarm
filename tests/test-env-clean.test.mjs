// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { withE2eCleanup, createE2eDataTracker, cleanupE2eData } from '../tools/e2e-data-cleanup.mjs';
import { assertLocalDatabaseUrl, cleanupTestDatabase } from '../tools/test-db-cleanup.mjs';
import { cacheKey, imagesFromCompose, mirroredRef } from '../tools/ci-image-cache.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(repoRoot, 'templates/coordination/ci-docker-hub-mirror.yml');

const e2eRoot = path.join('/var', 'swarm-regression-project');
const e2eTmp = path.join('/var', 'swarm-regression-tmp');
const mirrorHost = 'mirror.gcr.io';

function e2eDeps() {
  const rmCalls = [];
  const dropCalls = [];
  return {
    rm: async (target, options) => {
      rmCalls.push({ target, options });
    },
    dropDb: async (name) => {
      dropCalls.push(name);
    },
    rmCalls,
    dropCalls,
  };
}

function localPostgresUrl(hostSegment, dbName = 'swarm_e2e') {
  return `postgres://${hostSegment}/${dbName}`;
}

function remoteHostUrl(host) {
  return `postgres://${host}/app`;
}

function credentialsOnRemoteHost() {
  const url = new URL(`postgres://${'remote-db.example.invalid'}/prod`);
  url.username = 'u';
  return url.href;
}

describe('regression: e2e data lifecycle cleans up on success and on throw', () => {
  test('tracked artifacts are removed after a successful run', async () => {
    const { rm, dropDb, rmCalls, dropCalls } = e2eDeps();
    const tmpDir = path.join(e2eTmp, 'success-run');
    const dbName = 'swarm_e2e_success';

    const value = await withE2eCleanup(
      async (tracker) => {
        tracker.track('tmpdir', tmpDir);
        tracker.track('db', dbName);
        tracker.track('file', tracker.e2ePath('state.json'));
        return 'done';
      },
      { root: e2eRoot, runId: 'regression-ok', rm, dropDb, tmpdir: e2eTmp },
    );

    assert.equal(value, 'done');
    assert.deepEqual(dropCalls, [dbName]);
    assert.equal(rmCalls.length, 2);
    assert.ok(rmCalls.some((c) => c.target === tmpDir));
    assert.ok(rmCalls.some((c) => c.target.endsWith(path.join('.swarm', 'e2e', 'regression-ok', 'state.json'))));
  });

  test('cleanup still runs when the e2e body throws', async () => {
    const { rm, dropDb, rmCalls, dropCalls } = e2eDeps();
    const tmpDir = path.join(e2eTmp, 'throw-run');
    const dbName = 'swarm_e2e_throw';

    await assert.rejects(
      () =>
        withE2eCleanup(
          async (tracker) => {
            tracker.track('tmpdir', tmpDir);
            tracker.track('db', dbName);
            throw new Error('simulated e2e failure');
          },
          { root: e2eRoot, runId: 'regression-throw', rm, dropDb, tmpdir: e2eTmp },
        ),
      /simulated e2e failure/,
    );

    assert.deepEqual(dropCalls, [dbName]);
    assert.deepEqual(rmCalls.map((c) => c.target), [tmpDir]);
  });

  test('e2e db name can be guarded by local-only cleanup before drop', async () => {
    const { rm, dropDb, dropCalls } = e2eDeps();
    const localUrl = localPostgresUrl('localhost:5432', 'swarm_e2e_guarded');
    assertLocalDatabaseUrl(localUrl);

    const tracker = createE2eDataTracker({ root: e2eRoot, runId: 'db-guard', tmpdir: e2eTmp });
    tracker.track('db', 'swarm_e2e_guarded');

    await cleanupE2eData(tracker, { rm, dropDb });
    assert.deepEqual(dropCalls, ['swarm_e2e_guarded']);

    await assert.rejects(
      () =>
        cleanupTestDatabase(remoteHostUrl('db.example.invalid'), {
          dropSchema: async () => {
            throw new Error('must not run');
          },
        }),
      (err) => err.code === 'test-db-not-local',
    );
  });
});

describe('regression: test database cleanup refuses non-local hosts', () => {
  test('allows loopback hostnames only (not prefix impersonation)', () => {
    assertLocalDatabaseUrl(localPostgresUrl('localhost:5432'));
    assertLocalDatabaseUrl(localPostgresUrl('127.0.0.1:5432'));
    assertLocalDatabaseUrl(localPostgresUrl('[::1]'));

    const evilLocal = remoteHostUrl('localhost.evil.example');
    assert.throws(
      () => assertLocalDatabaseUrl(evilLocal),
      (err) => {
        assert.equal(err.code, 'test-db-not-local');
        assert.match(err.message, /localhost\.evil\.example/);
        return true;
      },
    );
  });

  test('refuses remote hosts and credential-bearing URLs aimed at remote hosts', () => {
    assert.throws(
      () => assertLocalDatabaseUrl(remoteHostUrl('db.example.invalid')),
      (err) => err.code === 'test-db-not-local',
    );

    const credRemote = credentialsOnRemoteHost();
    assert.throws(
      () => assertLocalDatabaseUrl(credRemote),
      (err) => {
        assert.equal(err.code, 'test-db-not-local');
        assert.match(err.message, /remote-db\.example\.invalid/);
        assert.doesNotMatch(err.message, /\bu\b.*@/);
        return true;
      },
    );
  });

  test('dry-run local cleanup resolves schema name without calling drop', async () => {
    let dropped = false;
    const result = await cleanupTestDatabase(localPostgresUrl('127.0.0.1', 'tenant_reg'), {
      dryRun: true,
      dropSchema: async () => {
        dropped = true;
      },
    });
    assert.deepEqual(result, { dryRun: true, name: 'tenant_reg' });
    assert.equal(dropped, false);
  });
});

describe('regression: CI mirrors Docker Hub images and caches tarballs', () => {
  test('compose image list is mirrored for Hub refs and keyed for cache', () => {
    const compose = `
services:
  web:
    image: nginx:1.25
  cache:
    image: redis:7
  sidecar:
    image: ghcr.io/org/sidecar:v1
`;
    const images = imagesFromCompose(compose);
    assert.deepEqual(images.sort(), ['ghcr.io/org/sidecar:v1', 'nginx:1.25', 'redis:7'].sort());

    const mirrored = images.map((img) => mirroredRef(img, mirrorHost));
    assert.ok(mirrored.includes(`${mirrorHost}/library/nginx:1.25`));
    assert.ok(mirrored.includes(`${mirrorHost}/library/redis:7`));
    assert.ok(mirrored.includes('ghcr.io/org/sidecar:v1'));

    const key = cacheKey(images);
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(key, cacheKey([...images].reverse()));
  });

  test('workflow template declares cache restore and mirror pull with retry', () => {
    const text = fs.readFileSync(templatePath, 'utf8');

    assert.match(text, /uses:\s*actions\/cache@/);
    assert.match(text, /\.ci-image-cache\/tars/);
    assert.match(text, /pull_with_retry/);
    assert.match(text, /docker pull/);
    assert.match(text, /\$\{MIRROR\}/);
    assert.match(text, /max_attempts/);

    const hubSample = 'postgres:16';
    const mirrored = mirroredRef(hubSample, mirrorHost);
    assert.equal(mirrored, `${mirrorHost}/library/postgres:16`);
    assert.match(text, /\$\{MIRROR\}\/library\//);
  });

  test('removing mirror rewrite would break Hub image resolution', () => {
    const before = mirroredRef('docker.io/library/postgres:16', mirrorHost);
    assert.equal(before, `${mirrorHost}/library/postgres:16`);
    assert.notEqual(before, 'docker.io/library/postgres:16');
  });
});
