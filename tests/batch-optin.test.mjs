// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { batchPolicyFor } from '../tools/swarm.mjs';

test('the machine batch default applies only to projects listed in batch.projects; flags and manifests still work anywhere', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-optin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ batch: { enabled: true, projects: [path.join(dir, 'ok')], types: ['docs'] } }));
  const env = { ...process.env, SWARM_CONFIG: file };
  assert.deepEqual(batchPolicyFor({}, false, env, path.join(dir, 'ok')), { all: false, types: ['docs'] });
  assert.deepEqual(batchPolicyFor({}, false, env, path.join(dir, 'bingo')), { all: false, types: [] }, 'an unlisted project never batches by default');
  assert.deepEqual(batchPolicyFor({}, false, env, undefined), { all: false, types: [] });
  assert.equal(batchPolicyFor({}, true, env, path.join(dir, 'bingo')).all, true, '--batch is an explicit choice');
  assert.equal(batchPolicyFor({ batch: true }, false, env, path.join(dir, 'bingo')).all, true, 'so is the manifest');
});
