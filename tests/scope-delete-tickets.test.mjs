// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger, writeLedger, createLedger } from '../tools/tickets.mjs';

const tmp = async (t, prefix) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

const writeState = (root, state) =>
  fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true }).then(() =>
    fs.writeFile(path.join(root, '.swarm/runs/r9/state.json'), JSON.stringify(state)),
  );

async function project(t, tickets) {
  const root = await tmp(t, 'scope-del-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets }));
  await fs.writeFile(
    path.join(root, '.project-swarm.json'),
    JSON.stringify({
      version: 1,
      profile: { sensitive: true, acceptance: { enforce: false }, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] } },
    }),
  );
  await fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r9/manifest.json'), JSON.stringify({ checks: [{ name: 'typecheck', argv: ['x'] }, { name: 'lint', argv: ['x'] }] }));
  return root;
}

const tk = (id, extra = {}) => ({
  id,
  title: id,
  type: 'build',
  epic: 'E',
  scopeRefs: ['R-001'],
  acceptance: ['ok'],
  files: [],
  context: [],
  contracts: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'review',
  stage: 'S1',
  runId: 'r9',
  ...extra,
});

const baseState = (job, integratedFiles = []) => ({
  id: 'r9',
  integratedAt: 'now',
  integratedFiles,
  jobs: [job],
  checks: [{ name: 'typecheck', status: 'passed' }, { name: 'lint', status: 'passed' }],
  mergeQueue: { integrated: [job.id], integratedIn: {}, checkFailed: [], batches: [] },
});

const syncIntegrated = root => runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);

test('a delete-only ticket whose file is gone syncs to done', async t => {
  const root = await project(t, [tk('T-0001', { deletes: ['src/old.ts'] })]);
  const ws = '.swarm/workspaces/r9/T-0001';
  await fs.mkdir(path.join(root, ws), { recursive: true });
  const job = { id: 'T-0001', status: 'complete', outputs: ['src/old.ts'], workspace: ws };
  await writeState(root, baseState(job, []));
  const synced = await syncIntegrated(root);
  assert.match(synced.stdout, /1 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets[0].status, 'done');
});

test('a delete ticket whose file still exists is refused', async t => {
  const root = await project(t, [tk('T-0001', { deletes: ['src/old.ts'] })]);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/old.ts'), 'export const old = 1;\n');
  const ws = '.swarm/workspaces/r9/T-0001';
  await fs.mkdir(path.join(root, ws), { recursive: true });
  const job = { id: 'T-0001', status: 'complete', outputs: ['src/old.ts'], workspace: ws };
  await writeState(root, baseState(job, []));
  const synced = await syncIntegrated(root);
  assert.match(synced.stdout, /stay in review/);
  assert.match(synced.stdout, /job files are not in the integrated files/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
});

test('a delete of a directory path still present is refused', async t => {
  const root = await project(t, [tk('T-0001', { deletes: ['src/pkg'] })]);
  await fs.mkdir(path.join(root, 'src/pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/pkg/index.ts'), 'export {};\n');
  const ws = '.swarm/workspaces/r9/T-0001';
  await fs.mkdir(path.join(root, ws), { recursive: true });
  const job = { id: 'T-0001', status: 'complete', outputs: ['src/pkg'], workspace: ws };
  await writeState(root, baseState(job, []));
  const synced = await syncIntegrated(root);
  assert.match(synced.stdout, /stay in review/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
});

test('a non-ENOENT lstat error on a declared delete fails sync', async t => {
  const root = await project(t, [tk('T-0001', { deletes: ['src/old.ts'] })]);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/old.ts'), 'x\n');
  await fs.chmod(path.join(root, 'src'), 0);
  const ws = '.swarm/workspaces/r9/T-0001';
  await fs.mkdir(path.join(root, ws), { recursive: true });
  const job = { id: 'T-0001', status: 'complete', outputs: ['src/old.ts'], workspace: ws };
  await writeState(root, baseState(job, []));
  const synced = await syncIntegrated(root);
  await fs.chmod(path.join(root, 'src'), 0o755);
  assert.match(synced.stdout, /stay in review/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
});

test('a ticket with a write and a delete passes only when both hold', async t => {
  const root = await project(t, [tk('T-0001', { files: ['src/new.ts'], deletes: ['src/old.ts'] })]);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/new.ts'), 'export const v = 2;\n');
  const ws = '.swarm/workspaces/r9/T-0001';
  await fs.mkdir(path.join(root, ws, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'src/new.ts'), 'export const v = 2;\n');
  const job = { id: 'T-0001', status: 'complete', outputs: ['src/new.ts', 'src/old.ts'], workspace: ws };
  // old still in tree: refuse
  await fs.writeFile(path.join(root, 'src/old.ts'), 'export const old = 1;\n');
  await writeState(root, baseState(job, ['src/new.ts']));
  let synced = await syncIntegrated(root);
  assert.match(synced.stdout, /stay in review/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
  // old gone, write matches: done
  await fs.rm(path.join(root, 'src/old.ts'));
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [tk('T-0001', { files: ['src/new.ts'], deletes: ['src/old.ts'] })] }));
  await writeState(root, baseState(job, ['src/new.ts']));
  synced = await syncIntegrated(root);
  assert.match(synced.stdout, /1 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets[0].status, 'done');
});

test('a normal write ticket is unchanged', async t => {
  const root = await project(t, [tk('T-0001', { files: ['src/T-0001.ts'] })]);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/T-0001.ts'), 'export const a = 1;\n');
  const ws = '.swarm/workspaces/r9/T-0001';
  await fs.mkdir(path.join(root, ws, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'src/T-0001.ts'), 'export const a = 1;\n');
  const job = { id: 'T-0001', status: 'complete', outputs: ['src/T-0001.ts'], workspace: ws };
  await writeState(root, { ...baseState(job, []), mergeQueue: { integrated: ['T-0001'], integratedIn: {}, checkFailed: [], batches: [] } });
  const first = await syncIntegrated(root);
  assert.match(first.stdout, /1 ticket\(s\) marked done/);
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [tk('T-0001', { files: ['src/T-0001.ts'] })] }));
  await fs.writeFile(path.join(root, 'src/T-0001.ts'), 'export const a = 2;\n');
  await writeState(root, baseState(job, []));
  const second = await syncIntegrated(root);
  assert.match(second.stdout, /stay in review.*job files are not in the integrated files/);
});
