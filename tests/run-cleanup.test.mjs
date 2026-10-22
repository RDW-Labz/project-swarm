// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../tools/codex-adapter.mjs';
import { readJournal } from '../tools/journal.mjs';
import { cleanupRunAfterTerminal, cleanupRunWorkspaces, integrateQueueStillNeedsRunWorkspaces, jobsEligibleForCleanup, resolveKeepWorkspaces } from '../tools/gc.mjs';
import { expectedWorkspaceFor } from '../tools/swarm/core-11.mjs';
import { jsonWrite } from '../tools/swarm/core-31.mjs';

async function repoFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'swarm-cleanup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await fs.mkdir(path.join(root, '.swarm', 'workspaces'), { recursive: true });
  await fs.writeFile(path.join(root, 'README'), 'x');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  const worktreesDir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'swarm-wt-base-'));
  t.after(() => fs.rm(worktreesDir, { recursive: true, force: true }));
  const configFile = path.join(root, '.swarm', 'local-config.json');
  await fs.writeFile(configFile, JSON.stringify({ worktreesOutsideRoot: true, worktreesDir }));
  return { root, worktreesDir, env: { ...process.env, SWARM_CONFIG: configFile } };
}

async function addWorktree(root, worktreePath) {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(root, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
  await fs.writeFile(path.join(worktreePath, 'marker.txt'), 'keep');
}

test('integrated run removes worktrees and logs journal entries', async t => {
  const { root, worktreesDir, env } = await repoFixture(t);
  const id = 'run-integrated';
  const jobId = 'job-a';
  const worktreePath = path.join(worktreesDir, id, jobId);
  await addWorktree(root, worktreePath);
  const workspaceRel = expectedWorkspaceFor(id, jobId, { workspaceAttempt: 1 });
  const workspaceAbs = path.join(root, workspaceRel);
  await fs.mkdir(workspaceAbs, { recursive: true });
  await fs.writeFile(path.join(workspaceAbs, 'out.txt'), 'data');
  const state = {
    id,
    root,
    status: 'complete',
    worktreesBase: worktreesDir,
    integratedAt: new Date().toISOString(),
    integrationStatus: 'complete',
    integratedFiles: ['out.txt'],
    integratedHashes: { 'out.txt': 'abc' },
    jobs: [{ id: jobId, status: 'complete', worktreePath, workspace: workspaceRel }],
  };
  await jsonWrite(root, `.swarm/runs/${id}/state.json`, state);
  const result = await cleanupRunWorkspaces(root, id, state, { env });
  assert.ok(result.bytesFreed >= 0);
  await assert.rejects(() => fs.access(worktreePath));
  await assert.rejects(() => fs.access(workspaceAbs));
  const events = await readJournal(root, { limit: 50 });
  assert.ok(events.some(e => e.kind === 'note' && String(e.text).includes('workspace-cleanup') && String(e.text).includes(id)));
});

test('merge-queue conflicts before integrateQueue summary keep workspaces for merge prompt', async t => {
  const { root, worktreesDir, env } = await repoFixture(t);
  const id = 'run-merge-queue';
  const jobId = 'job-0';
  const worktreePath = path.join(worktreesDir, id, jobId);
  await addWorktree(root, worktreePath);
  const workspaceRel = expectedWorkspaceFor(id, jobId, { workspaceAttempt: 1 });
  const workspaceAbs = path.join(root, workspaceRel);
  await fs.mkdir(path.join(workspaceAbs, 'out'), { recursive: true });
  await fs.writeFile(path.join(workspaceAbs, 'out', '0.txt'), 'earlier proposal\n');
  const state = {
    id,
    root,
    status: 'complete',
    worktreesBase: worktreesDir,
    integratedAt: new Date().toISOString(),
    integrationStatus: 'complete',
    mergeQueue: {
      state: 'done',
      conflicts: [{ job: jobId, files: ['out/0.txt'], reason: 'content changed since worker snapshot' }],
      integrated: [],
    },
    jobs: [{ id: jobId, status: 'complete', worktreePath, workspace: workspaceRel }],
  };
  assert.equal(integrateQueueStillNeedsRunWorkspaces(state), true);
  assert.deepEqual(jobsEligibleForCleanup(state), []);
  const result = await cleanupRunWorkspaces(root, id, state, { env });
  assert.deepEqual(result.removed, []);
  await fs.access(worktreePath);
  await fs.access(workspaceAbs);
  state.mergeQueue.summary = { status: 'partial', flagged: [{ job: jobId, reason: 'merge-conflict' }] };
  assert.equal(integrateQueueStillNeedsRunWorkspaces(state), false);
  assert.ok(jobsEligibleForCleanup(state).length);
});

test('partial integration keeps all job workspaces until the run is complete', async t => {
  const { root, worktreesDir, env } = await repoFixture(t);
  const id = 'run-partial';
  const integrated = 'job-done';
  const blocked = 'job-blocked';
  const doneWt = path.join(worktreesDir, id, integrated);
  const blockedWt = path.join(worktreesDir, id, blocked);
  await addWorktree(root, doneWt);
  await addWorktree(root, blockedWt);
  const blockedWs = path.join(root, expectedWorkspaceFor(id, blocked, { workspaceAttempt: 1 }));
  const doneWs = path.join(root, expectedWorkspaceFor(id, integrated, { workspaceAttempt: 1 }));
  await fs.mkdir(blockedWs, { recursive: true });
  await fs.mkdir(doneWs, { recursive: true });
  await fs.writeFile(path.join(blockedWs, 'blocked.txt'), 'x');
  await fs.writeFile(path.join(doneWs, 'done.txt'), 'x');
  const state = {
    id,
    root,
    status: 'complete',
    worktreesBase: worktreesDir,
    integratedAt: new Date().toISOString(),
    integrationStatus: 'partial',
    jobIntegration: {
      [integrated]: { status: 'integrated' },
      [blocked]: { status: 'blocked', reason: 'checks-failed' },
    },
    jobs: [
      { id: integrated, status: 'complete', worktreePath: doneWt, workspace: expectedWorkspaceFor(id, integrated, { workspaceAttempt: 1 }) },
      { id: blocked, status: 'blocked', worktreePath: blockedWt, workspace: expectedWorkspaceFor(id, blocked, { workspaceAttempt: 1 }) },
    ],
  };
  const result = await cleanupRunWorkspaces(root, id, state, { env });
  assert.deepEqual(result.removed, []);
  await fs.access(doneWt);
  await fs.access(blockedWt);
  await fs.access(blockedWs);
  assert.deepEqual(jobsEligibleForCleanup(state), []);
});

test('running run is not cleaned', async t => {
  const { root, worktreesDir, env } = await repoFixture(t);
  const worktreePath = path.join(worktreesDir, 'run-live', 'job');
  await addWorktree(root, worktreePath);
  const state = {
    id: 'run-live',
    root,
    status: 'running',
    worktreesBase: worktreesDir,
    jobs: [{ id: 'job', status: 'running', worktreePath }],
  };
  const result = await cleanupRunWorkspaces(root, 'run-live', state, { env });
  assert.equal(result.skipped, true);
  await fs.access(worktreePath);
});

test('keepWorkspaces retains paths', async t => {
  const { root, worktreesDir, env } = await repoFixture(t);
  const worktreePath = path.join(worktreesDir, 'run-keep', 'job');
  await addWorktree(root, worktreePath);
  const state = {
    id: 'run-keep',
    root,
    status: 'cancelled',
    worktreesBase: worktreesDir,
    keepWorkspaces: true,
    jobs: [{ id: 'job', status: 'cancelled', worktreePath }],
  };
  const result = await cleanupRunWorkspaces(root, 'run-keep', state, { env, keepWorkspaces: true });
  assert.equal(result.kept, true);
  await fs.access(worktreePath);
  assert.equal(resolveKeepWorkspaces({ keepWorkspaces: true }, {}), true);
});

const terminalFailureStatuses = [
  { runStatus: 'failed', jobStatus: 'failed' },
  { runStatus: 'failed', jobStatus: 'timeout' },
  { runStatus: 'cancelled', jobStatus: 'cancelled' },
  { runStatus: 'failed', jobStatus: 'missing-output' },
  { runStatus: 'failed', jobStatus: 'launch-error' },
];

for (const { runStatus, jobStatus } of terminalFailureStatuses) {
  test(`terminal ${jobStatus} run keeps workspaces at run end`, async t => {
    const { root, worktreesDir, env } = await repoFixture(t);
    const id = `run-${jobStatus}`;
    const worktreePath = path.join(worktreesDir, id, 'job');
    await addWorktree(root, worktreePath);
    const workspaceRel = expectedWorkspaceFor(id, 'job', { workspaceAttempt: 1 });
    const workspaceAbs = path.join(root, workspaceRel);
    await fs.mkdir(workspaceAbs, { recursive: true });
    await fs.writeFile(path.join(workspaceAbs, 'evidence.txt'), 'x');
    const state = {
      id,
      root,
      status: runStatus,
      finishedAt: new Date().toISOString(),
      worktreesBase: worktreesDir,
      jobs: [{ id: 'job', status: jobStatus, worktreePath, workspace: workspaceRel }],
    };
    const ws = await cleanupRunWorkspaces(root, id, state, { env });
    assert.deepEqual(ws.removed, []);
    const after = await cleanupRunAfterTerminal(root, id, state, { env });
    assert.deepEqual(after.removed, []);
    await fs.access(worktreePath);
    await fs.access(workspaceAbs);
    assert.deepEqual(jobsEligibleForCleanup(state), []);
    assert.ok(jobsEligibleForCleanup(state, { forGc: true }).length);
  });
}

test('keptWorkspace job is never eligible for cleanup', async t => {
  const { root, worktreesDir, env } = await repoFixture(t);
  const id = 'run-kept-job';
  const worktreePath = path.join(worktreesDir, id, 'job');
  await addWorktree(root, worktreePath);
  const workspaceRel = expectedWorkspaceFor(id, 'job', { workspaceAttempt: 1 });
  const workspaceAbs = path.join(root, workspaceRel);
  await fs.mkdir(workspaceAbs, { recursive: true });
  const state = {
    id,
    root,
    status: 'failed',
    finishedAt: new Date().toISOString(),
    worktreesBase: worktreesDir,
    jobs: [{ id: 'job', status: 'failed', worktreePath, workspace: workspaceRel, keptWorkspace: workspaceAbs }],
  };
  assert.deepEqual(jobsEligibleForCleanup(state, { forGc: true }), []);
  await cleanupRunWorkspaces(root, id, state, { env });
  await fs.access(worktreePath);
  await fs.access(workspaceAbs);
});

test('paths outside bases are never removed', async t => {
  const { root, worktreesDir, env } = await repoFixture(t);
  const outside = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
  const state = {
    id: 'run-evil',
    root,
    status: 'cancelled',
    worktreesBase: worktreesDir,
    jobs: [{ id: 'job', status: 'cancelled', worktreePath: outside }],
  };
  await cleanupRunWorkspaces(root, 'run-evil', state, { env });
  await fs.access(outside);
});
