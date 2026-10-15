// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runManifest, integrateRun } from '../tools/swarm.mjs';
import { percentile, prepareScaleRepo, queueLatencyMs, scaleStub, stubManifest } from '../tools/scale.mjs';

test('percentile and queue latency use startedAt minus queuedAt', () => {
  assert.equal(percentile([10, 30, 20], 50), 20);
  assert.equal(percentile([], 95), null);
  const latency = queueLatencyMs([
    { queuedAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.010Z' },
    { queuedAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.040Z' },
    { queuedAt: '2026-01-01T00:00:00.000Z', startedAt: null },
  ]);
  assert.equal(latency.count, 2);
  assert.equal(latency.max, 40);
});

test('the stub manifest is 500 ollama jobs with no model route', () => {
  const manifest = stubManifest(500, 500);
  assert.equal(manifest.jobs.length, 500);
  assert.equal(manifest.concurrency, 500);
  assert.equal(manifest.jobs.every(job => job.agent === 'ollama' && job.model === 'stub'), true);
  assert.equal(new Set(manifest.jobs.flatMap(job => job.outputs)).size, 500);
  assert.throws(() => stubManifest(501, 1), { code: 'scale-jobs' });
});

test('a stub scale run spends nothing, stays inside the cap, and merges the files', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-scale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepareScaleRepo(root);
  const result = await scaleStub(root, { jobs: 8, concurrency: 4, holdMs: 30, runManifest, integrateRun });
  assert.equal(result.complete, 8);
  assert.equal(result.failed, 0);
  assert.equal(result.costUsd, 0);
  assert.equal(result.peakConcurrency, 4);
  assert.ok(result.peakRssBytes > 0);
  assert.equal(result.queueLatencyMs.count, 8);
  assert.ok(result.queueLatencyMs.p95 >= 0);
  assert.equal(result.merge.files, 8);
  assert.ok(result.merge.filesPerSecond > 0);
  assert.equal(await fs.readFile(path.join(root, 'out/3.txt'), 'utf8'), 'output 3\n');
});
