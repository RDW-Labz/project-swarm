// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, integrateRun, readState } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const TARGET = 'tests/browser/test_standalone_offline.py';

const job = {
  id: 'T-0060',
  agent: 'ollama',
  model: 'test-model',
  prompt: 'Update the offline test line.',
  context: [TARGET],
  outputs: [TARGET],
  timeoutMs: 5000,
};
const manifest = { version: 1, concurrency: 4, jobs: [job] };
const intended = 'assert driver.title == "offline-fixed"\n';
const workerReply = () => new Response(JSON.stringify({
  done: true,
  done_reason: 'stop',
  message: { content: JSON.stringify({ summary: 'done', files: [{ path: TARGET, content: intended }] }) },
}), { headers: { 'content-type': 'application/json' } });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-integrate-silent-noop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'tests/browser'), { recursive: true });
  await fs.writeFile(path.join(root, TARGET), 'assert driver.title == "offline-old"\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}

test('stale workspace matching the tree cannot integrate as a silent no-op', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest, { fetchImpl: async () => workerReply() });
  assert.equal(run.status, 'complete', run.jobs?.[0]?.error ?? run.error);
  const state = await readState(root, run.id);
  const record = state.jobs[0];
  const workspace = path.join(root, record.workspace ?? `.swarm/workspaces/${run.id}/${job.id}`);
  const resultJson = JSON.stringify({ summary: 'done', files: [{ path: TARGET, content: intended }] });
  await fs.writeFile(path.join(root, `.swarm/runs/${run.id}/${job.id}/response.txt`), `${resultJson}\n`);
  await fs.writeFile(path.join(workspace, TARGET), 'assert driver.title == "offline-old"\n');
  const result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.status, 'integrated');
  assert.equal(await fs.readFile(path.join(root, TARGET), 'utf8'), intended);
  const after = await readState(root, run.id);
  assert.ok(after.integrationOutputsVerified);
  assert.deepEqual(after.integrateUnverified, []);
});

test('recorded integration without tree bytes is cleared and re-integrated', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest, { fetchImpl: async () => workerReply() });
  assert.equal(run.status, 'complete', run.jobs?.[0]?.error ?? run.error);
  const state = await readState(root, run.id);
  state.integratedAt = new Date().toISOString();
  state.integrationStatus = 'complete';
  state.integratedFiles = [TARGET];
  state.checksPassed = true;
  await fs.writeFile(path.join(root, `.swarm/runs/${run.id}/state.json`), JSON.stringify(state));
  assert.equal(await fs.readFile(path.join(root, TARGET), 'utf8'), 'assert driver.title == "offline-old"\n');
  const result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.status, 'integrated');
  assert.equal(await fs.readFile(path.join(root, TARGET), 'utf8'), intended);
});

test('integrateUnverified and a warning when on-disk bytes differ from the job output after integrate', async t => {
  const root = await fixture(t);
  const stale = 'assert driver.title == "offline-old"\\n';
  const run = await runManifest(root, {
    ...manifest,
    preChecks: [[process.execPath, '-e', `require('fs').writeFileSync('${TARGET}', ${JSON.stringify(stale)})`]],
  }, { fetchImpl: async () => workerReply() });
  assert.equal(run.status, 'complete', run.jobs?.[0]?.error ?? run.error);
  const result = await integrateRun(root, run.id, { noChecks: true });
  assert.equal(result.status, 'integrated');
  assert.deepEqual(result.integrateUnverified, [{ job: job.id, path: TARGET }]);
  assert.ok((result.warnings ?? []).some(w => w === `integrate-no-op: ${TARGET} differs from the job output (${job.id})`));
  assert.equal(await fs.readFile(path.join(root, TARGET), 'utf8'), stale);
  const after = await readState(root, run.id);
  assert.deepEqual(after.integrateUnverified, result.integrateUnverified);
});
