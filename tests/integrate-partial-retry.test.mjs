// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { integrateRun } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const put = async (root, file, bytes) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), bytes);
};
const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');
const exists = file => fs.access(file).then(() => true, () => false);

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'partial-retry-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await put(root, 'input.txt', 'source');
  await put(root, 'src/a.ts', 'export const a = 1;\n');
  await put(root, 'src/b.ts', 'export const b = 1;\n');
  await put(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}

async function savedTwoJobRun(root, { aWritten, bRemoved }) {
  const id = `run-${crypto.randomBytes(4).toString('hex')}`;
  const jobA = { id: 'job-a', agent: 'claude', model: 'sonnet', prompt: 'Update a.', context: ['input.txt'], outputs: ['src/a.ts'] };
  const jobB = { id: 'job-b', agent: 'claude', model: 'sonnet', prompt: 'Remove lockfile.', context: ['input.txt'], outputs: ['package-lock.json'], deletes: ['package-lock.json'] };
  const jobs = [jobA, jobB];
  const records = [];
  for (const job of jobs) {
    const workspace = `.swarm/workspaces/${id}/${job.id}`;
    const baseHashes = {};
    for (const file of job.outputs) {
      const current = await fs.readFile(path.join(root, file)).catch(() => null);
      baseHashes[file] = current === null ? null : hash(current);
      if (job.id === 'job-a') await put(root, `${workspace}/${file}`, aWritten);
      else if (bRemoved) continue;
      else if (current !== null) await put(root, `${workspace}/${file}`, current);
    }
    records.push({ id: job.id, status: 'complete', agent: job.agent, model: job.model, workspace, outputs: job.outputs, baseHashes, droppedWrites: [] });
  }
  await put(root, `.swarm/runs/${id}/manifest.json`, JSON.stringify({ version: 1, jobs }));
  await put(root, `.swarm/runs/${id}/job-a/response.txt`, '{"notes":[]}');
  await put(root, `.swarm/runs/${id}/job-b/response.txt`, '{"notes":[]}');
  await put(root, `.swarm/runs/${id}/state.json`, JSON.stringify({ id, root, status: 'complete', startedAt: new Date().toISOString(), jobs: records }));
  return { id, jobA, jobB };
}

const cliRun = (root, ...args) => exec(process.execPath, [cli, '--root', root, ...args], { env: { ...process.env, SWARM_CONFIG_DIR: path.join(root, '.cfg') } }).then(
  r => ({ code: 0, out: r.stdout + r.stderr }),
  e => ({ code: e.code, out: `${e.stdout}${e.stderr}` }),
);

test('partial queue: manifest-blocked job retries; integrated job is not rewritten; full run refuses retry', async t => {
  const root = await project(t);
  const aWritten = 'export const a = 2;\n';
  const { id } = await savedTwoJobRun(root, { aWritten, bRemoved: true });

  const pass1 = await integrateRun(root, id, { queue: true, noChecks: true });
  assert.equal(pass1.status, 'partial');
  assert.equal(pass1.integrationStatus, 'partial');
  assert.equal(await read(root, 'src/a.ts'), aWritten);
  assert.equal(await exists(path.join(root, 'package-lock.json')), true);
  assert.deepEqual(pass1.mergeQueue.integrated, ['job-a']);
  assert.equal(pass1.mergeQueue.securityBlocked.length, 1);
  assert.equal(pass1.mergeQueue.securityBlocked[0].job, 'job-b');

  const stateAfter1 = JSON.parse(await fs.readFile(path.join(root, `.swarm/runs/${id}/state.json`), 'utf8'));
  assert.equal(stateAfter1.jobIntegration['job-a'].status, 'integrated');
  assert.equal(stateAfter1.jobIntegration['job-b'].status, 'blocked');
  assert.equal(stateAfter1.integrationPasses.length, 1);

  const pass2 = await integrateRun(root, id, {
    queue: true,
    noChecks: true,
    securityGate: { approveManifests: [{ file: 'package-lock.json', sha256: 'deleted' }] },
  });
  assert.equal(pass2.status, 'integrated');
  assert.equal(pass2.integrationStatus, 'complete');
  assert.equal(await read(root, 'src/a.ts'), aWritten, 'job-a file untouched on second pass');
  assert.equal(await exists(path.join(root, 'package-lock.json')), false);

  const stateAfter2 = JSON.parse(await fs.readFile(path.join(root, `.swarm/runs/${id}/state.json`), 'utf8'));
  assert.equal(stateAfter2.integrationStatus, 'complete');
  assert.equal(stateAfter2.jobIntegration['job-a'].status, 'integrated');
  assert.equal(stateAfter2.jobIntegration['job-b'].status, 'integrated');
  assert.equal(stateAfter2.integrationPasses.length, 2);
  assert.ok(stateAfter2.integratedFiles.includes('src/a.ts'));
  assert.ok(stateAfter2.integratedFiles.includes('package-lock.json'));
  assert.ok(stateAfter2.integratedHashes['src/a.ts']);
  assert.ok(stateAfter2.integratedHashes['package-lock.json'] === undefined || typeof stateAfter2.integratedHashes['package-lock.json'] === 'string');

  const pass3 = await cliRun(root, 'integrate', id, '--queue', '--no-checks');
  assert.notEqual(pass3.code, 0);
  assert.match(pass3.out, /Run already integrated/);
});

test('conflicting retry of an integrated job is refused and names the files', async t => {
  const root = await project(t);
  const aWritten = 'export const a = 2;\n';
  const { id } = await savedTwoJobRun(root, { aWritten, bRemoved: true });
  const first = await integrateRun(root, id, { queue: true, noChecks: true });
  assert.equal(first.status, 'partial');

  await put(root, `.swarm/workspaces/${id}/job-a/src/a.ts`, 'export const a = 9;\n');
  await assert.rejects(integrateRun(root, id, { noChecks: true, jobs: ['job-a'] }), /Integration conflict: src\/a\.ts/);
  assert.equal(await read(root, 'src/a.ts'), aWritten);
});
