// SPDX-License-Identifier: Apache-2.0
// Download batching: the shared npm cache resolution + the batch prefetch tool (tools/dep-prefetch.mjs).
// Fetch mechanics only — these tests pin WHERE downloads land and HOW a batch is fetched, never what npm resolves.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveSharedNpmCacheDir } from '../tools/dep-install.mjs';
import { prefetchDependencies, resolveDownloadConcurrency, specsFromManifest } from '../tools/dep-prefetch.mjs';

test('shared npm cache dir: env override wins, off disables, default is the machine npm cache', () => {
  assert.equal(resolveSharedNpmCacheDir({ env: { SWARM_NPM_CACHE_DIR: '/data/npm' }, home: '/home/x' }), '/data/npm');
  assert.equal(resolveSharedNpmCacheDir({ env: { SWARM_NPM_CACHE_DIR: 'off' }, home: '/home/x' }), null);
  assert.equal(resolveSharedNpmCacheDir({ env: {}, home: '/home/x' }), path.join('/home/x', '.npm'));
});

test('download concurrency: config-driven, clamped to 1..64, npm default when unset or invalid', () => {
  assert.equal(resolveDownloadConcurrency({ env: {} }), 15);
  assert.equal(resolveDownloadConcurrency({ env: { SWARM_DL_CONCURRENCY: '32' } }), 32);
  assert.equal(resolveDownloadConcurrency({ env: { SWARM_DL_CONCURRENCY: '500' } }), 64);
  assert.equal(resolveDownloadConcurrency({ env: { SWARM_DL_CONCURRENCY: '0' } }), 1);
  assert.equal(resolveDownloadConcurrency({ env: { SWARM_DL_CONCURRENCY: 'wide' } }), 15);
});

test('specsFromManifest: unions jobs and tickets, deduplicates, ignores entries without dependencies', () => {
  const manifest = { jobs: [{ id: 'a', dependencies: ['zod', 'lodash'] }, { id: 'b' }], tickets: [{ id: 'T-1', dependencies: ['lodash', 'nanoid'] }] };
  assert.deepEqual(specsFromManifest(manifest).sort(), ['lodash', 'nanoid', 'zod']);
  assert.deepEqual(specsFromManifest({}), []);
  assert.deepEqual(specsFromManifest(null), []);
});

test('prefetch: one npm invocation for the whole deduped batch, into the shared cache, scripts off', async () => {
  const calls = [];
  const exec = async (argv, opts) => { calls.push({ argv, opts }); return { exitCode: 0, stdout: '', stderr: '' }; };
  const result = await prefetchDependencies({ specs: ['zod', 'lodash', 'zod'], exec, cacheDir: '/cache/npm', concurrency: 24 });
  assert.equal(calls.length, 1, 'the batch is fetched in a single invocation, not one per ticket');
  assert.ok(calls[0].argv.includes('--package-lock-only') && calls[0].argv.includes('--ignore-scripts'));
  assert.ok(calls[0].argv.includes('--maxsockets=24'), 'fetch width comes from config');
  assert.deepEqual(calls[0].argv.filter(a => ['zod', 'lodash'].includes(a)).sort(), ['lodash', 'zod'], 'specs are deduplicated');
  assert.equal(calls[0].opts.env.npm_config_cache, '/cache/npm', 'downloads land in the shared cache');
  assert.deepEqual(result.specs.sort(), ['lodash', 'zod']);
  // The scratch folder is throwaway: nothing remains under tmp after the run.
  const leftovers = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('swarm-prefetch-'));
  assert.deepEqual(leftovers, []);
});

test('prefetch: refuses non-registry specs and a disabled cache, and no-ops on an empty batch', async () => {
  const exec = async () => { throw new Error('exec must not run'); };
  await assert.rejects(prefetchDependencies({ specs: ['file:../x'], exec, cacheDir: '/c' }), /not a registry package name/);
  await assert.rejects(prefetchDependencies({ specs: ['zod'], exec, cacheDir: null }), /nowhere to land/);
  assert.deepEqual((await prefetchDependencies({ specs: [], exec, cacheDir: '/c' })).specs, []);
});
