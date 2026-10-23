// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupJobScratchDir } from '../tools/swarm/core-71.mjs';

test('scratch cleanup retries while a background writer briefly refills the tree', async t => {
  const scratchDir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'swarm-scratch-cleanup-'));
  const nested = path.join(scratchDir, 'swarm-test-tmp-nested');
  let active = true;
  const refill = setInterval(() => {
    if (!active) return;
    fs.mkdir(nested, { recursive: true })
      .then(() => fs.writeFile(path.join(nested, 'marker'), 'busy'))
      .catch(() => {});
  }, 15);
  t.after(async () => {
    active = false;
    clearInterval(refill);
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  });
  setTimeout(() => { active = false; }, 350);
  const result = { status: 'complete' };
  await cleanupJobScratchDir(scratchDir, result, { SWARM_KEEP_TMP: '0' });
  assert.equal(result.status, 'complete');
  assert.equal(result.cleanupError, undefined);
  await assert.rejects(fs.access(scratchDir), { code: 'ENOENT' });
});

test('scratch cleanup records cleanupError without changing a complete job when removal is impossible', { skip: process.platform === 'win32' ? 'parent chmod does not block rmdir here' : false }, async t => {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'swarm-scratch-cleanup-ro-'));
  const scratchDir = path.join(base, 'scratch');
  await fs.mkdir(scratchDir, { recursive: true });
  await fs.writeFile(path.join(scratchDir, 'leftover'), 'x');
  await fs.chmod(base, 0o555);
  t.after(async () => {
    await fs.chmod(base, 0o700).catch(() => {});
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });
  const result = { status: 'complete' };
  await cleanupJobScratchDir(scratchDir, result, { SWARM_KEEP_TMP: '0' });
  assert.equal(result.status, 'complete');
  assert.ok(typeof result.cleanupError === 'string' && result.cleanupError.length > 0);
  await fs.access(scratchDir);
});
