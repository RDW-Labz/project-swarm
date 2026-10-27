// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLanes } from '../tools/lanes.mjs';
import { readWorkerKey, resolveWorkerKey } from '../tools/claude-shell.mjs';
import { workerKeyGuard } from '../tools/swarm/core-32.mjs';

const TIMEOUT = { timeout: 60000 };

test('resolveLanes accepts claude.shellPaused true and false', TIMEOUT, () => {
  assert.equal(resolveLanes({ config: { lanes: { claude: { shellPaused: true } } } }).claude.shellPaused, true);
  assert.equal(resolveLanes({ config: { lanes: { claude: { shellPaused: false } } } }).claude.shellPaused, false);
});

test('resolveLanes refuses non-boolean claude.shellPaused', TIMEOUT, () => {
  for (const shellPaused of ['yes', 1, null, {}]) {
    assert.throws(
      () => resolveLanes({ config: { lanes: { claude: { shellPaused } } } }),
      error => error.code === 'lanes-invalid' && error.message.includes('claude.shellPaused'),
    );
  }
});

test('readWorkerKey resolves while paused; resolveWorkerKey refuses', TIMEOUT, async () => {
  const fakeKey = 'ab'.repeat(8);
  const exec = async () => ({ stdout: `${fakeKey}\n` });
  const config = { lanes: { anthropic: { paused: true } } };
  assert.equal(await readWorkerKey({ env: {}, exec, config }), fakeKey);
  await assert.rejects(resolveWorkerKey({ env: {}, exec, config }), error => error.code === 'claude-shell-paused');
});

test('workerKeyGuard resolves the key through injected exec while anthropic is paused', TIMEOUT, async t => {
  const fakeKey = 'cd'.repeat(8);
  await fs.writeFile(process.env.SWARM_CONFIG, JSON.stringify({ lanes: { anthropic: { paused: true } } }));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-shell-pause-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { jobs: [{ shell: true }] };
  await workerKeyGuard(root, 'run-paused', state, {
    env: process.env,
    keyExec: async () => ({ stdout: `${fakeKey}\n` }),
  });
});
