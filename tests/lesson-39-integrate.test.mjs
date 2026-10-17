// SPDX-License-Identifier: Apache-2.0
// Lesson 39, real integration: a ticket's delete goes through integrate; deleting a lockfile or a workflow is blocked by the security gate
// unless --approve-manifest names it, and that approval works only when the file is truly absent in the job's result.
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
import * as swarm from '../tools/swarm.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { parseScope } from '../tools/scope.mjs';
import { readJournal } from '../tools/journal.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const put = async (root, file, bytes) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), bytes); };
const exists = async file => fs.access(file).then(() => true, () => false);
const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo.', '', '## Stages', '- S1: Core', '', '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '## Protected', '- .env', ''].join('\n');

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'l39-int-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await put(root, 'input.txt', 'source');
  await put(root, 'src/old.ts', 'export const old = 1;\n');
  await put(root, 'src/new.ts', 'export const v = 1;\n');
  await put(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  await put(root, '.github/workflows/ci.yml', 'name: ci\n');
  return root;
}

// A saved, complete run of `job` where the worker wrote `written` and removed `removed` from its copy of the project.
async function savedRun(root, job, { written = {}, removed = [], kept = [] } = {}) {
  const id = `saved-${crypto.randomBytes(4).toString('hex')}`;
  const workspace = `.swarm/workspaces/${id}/${job.id}`;
  const baseHashes = {};
  for (const file of job.outputs) {
    const current = await fs.readFile(path.join(root, file)).catch(() => null);
    baseHashes[file] = current === null ? null : hash(current);
    if (removed.includes(file)) continue;
    if (written[file] !== undefined) await put(root, `${workspace}/${file}`, written[file]);
    else if (current !== null && kept.includes(file)) await put(root, `${workspace}/${file}`, current);
  }
  await put(root, `.swarm/runs/${id}/manifest.json`, JSON.stringify({ version: 1, jobs: [job] }));
  await put(root, `.swarm/runs/${id}/${job.id}/response.txt`, '{"notes":[]}');
  await put(root, `.swarm/runs/${id}/state.json`, JSON.stringify({ id, root, status: 'complete', startedAt: new Date().toISOString(), jobs: [{ id: job.id, status: 'complete', agent: job.agent, model: job.model, workspace, outputs: job.outputs, baseHashes, droppedWrites: [] }] }));
  return id;
}
const handJob = extra => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Remove the file.', context: ['input.txt'], outputs: [], ...extra });
const cliRun = (root, ...args) => exec(process.execPath, [cli, '--root', root, ...args], { env: { ...process.env, SWARM_CONFIG_DIR: path.join(root, '.cfg') } }).then(r => ({ code: 0, out: r.stdout + r.stderr }), e => ({ code: e.code, out: `${e.stdout}${e.stderr}` }));

test('a ticket that deletes a file: the job, the worker\'s result and integrate remove it from the project', async t => {
  const root = await project(t);
  const ticket = { id: 'T-0001', title: 'Replace old with new', type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['old is gone'], files: ['src/new.ts'], deletes: ['src/old.ts'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'ready', stage: 'S1' };
  const contextEnv = { exists: () => true, sizes: {}, listFiles: () => [], profileContext: {} };
  const job = ticketsToManifest([ticket], { ledger: { tickets: [] }, scope: parseScope(SCOPE), ready: true, contextEnv }).manifest.jobs[0];
  // The ticket's own job declares the deletion in outputs and deletes (an old ticket path declared only `deletes`, so integrate never removed the file).
  assert.deepEqual(job.deletes, ['src/old.ts']);
  assert.deepEqual([...job.outputs].sort(), ['src/new.ts', 'src/old.ts']);
  assert.equal(job.shell, true);
  const id = await savedRun(root, job, { written: { 'src/new.ts': 'export const v = 2;\n' }, removed: ['src/old.ts'] });
  const result = await swarm.integrateRun(root, id, { noChecks: true });
  assert.equal(result.status, 'integrated');
  assert.equal(await exists(path.join(root, 'src/old.ts')), false, 'the deleted file is gone from the project');
  assert.equal(await fs.readFile(path.join(root, 'src/new.ts'), 'utf8'), 'export const v = 2;\n');
  // A worker that deletes something it did not declare is refused (undeclared delete): nothing is removed.
  const root2 = await project(t);
  const sneaky = { ...job, deletes: undefined, outputs: ['src/new.ts', 'src/old.ts'] };
  delete sneaky.deletes;
  const id2 = await savedRun(root2, sneaky, { written: { 'src/new.ts': 'export const v = 2;\n' }, removed: ['src/old.ts'] });
  await assert.rejects(swarm.integrateRun(root2, id2, { noChecks: true }), /undeclared-delete/);
  assert.equal(await exists(path.join(root2, 'src/old.ts')), true);
});

test('deleting a lockfile through the queue is blocked without --approve-manifest and succeeds with it only when the file is truly absent in the result', async t => {
  const root = await project(t);
  const job = handJob({ outputs: ['package-lock.json'], deletes: ['package-lock.json'] });
  // Blocked: the security gate sees the deletion.
  const id = await savedRun(root, job, { removed: ['package-lock.json'] });
  const blocked = await cliRun(root, 'integrate', id, '--queue', '--no-checks');
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(blocked.out, /package-lock\.json is deleted; the owner must review it, then rerun integrate with --approve-manifest package-lock\.json \(after a --queue block/);
  assert.equal(await exists(path.join(root, 'package-lock.json')), true, 'blocked: the lockfile is still there');
  // Approved but the worker's result still has the file (it did not really delete it): refused before anything is approved or recorded.
  const idKept = await savedRun(root, job, { kept: ['package-lock.json'] });
  const fake = await cliRun(root, 'integrate', idKept, '--queue', '--no-checks', '--approve-manifest', 'package-lock.json');
  assert.notEqual(fake.code, 0);
  assert.match(fake.out, /package-lock\.json is not a real deletion/);
  assert.equal(await exists(path.join(root, 'package-lock.json')), true);
  assert.equal((await readJournal(root, { kinds: ['decision'], limit: Infinity })).filter(e => /approve-manifest/.test(String(e.id))).length, 0, 'nothing was recorded');
  // Approved and truly absent: the deletion goes through, and the decision is recorded. (A --queue block finishes that run, so this is the job run again.)
  const again = await savedRun(root, job, { removed: ['package-lock.json'] });
  const ok = await cliRun(root, 'integrate', again, '--queue', '--no-checks', '--approve-manifest', 'package-lock.json');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(await exists(path.join(root, 'package-lock.json')), false, 'approved and absent: deleted');
  const decisions = (await readJournal(root, { kinds: ['decision'], limit: Infinity })).filter(e => /approve-manifest/.test(String(e.id)));
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].text, /reviewed the deletion of package-lock\.json by hand and approved it past the security gate for run/);
});

test('deleting a workflow with a plain integrate is blocked, then approved and removed', async t => {
  const root = await project(t);
  const job = handJob({ outputs: ['.github/workflows/ci.yml'], deletes: ['.github/workflows/ci.yml'] });
  const id = await savedRun(root, job, { removed: ['.github/workflows/ci.yml'] });
  const blocked = await cliRun(root, 'integrate', id, '--no-checks');
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(blocked.out, /\.github\/workflows\/ci\.yml/);
  assert.equal(await exists(path.join(root, '.github/workflows/ci.yml')), true);
  const ok = await cliRun(root, 'integrate', id, '--no-checks', '--approve-manifest', '.github/workflows/ci.yml');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(await exists(path.join(root, '.github/workflows/ci.yml')), false);
});
