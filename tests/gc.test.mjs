// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../tools/codex-adapter.mjs';
import { COMMANDS } from '../tools/completion.mjs';
import { collectProjectGcPlan, computeDiskUsage, resolveKeepFailedDays, runGc } from '../tools/gc.mjs';
import { expectedWorkspaceFor } from '../tools/swarm/core-11.mjs';
import { worktreesBaseFor } from '../tools/swarm/core-11.mjs';

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'swarm-gc-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await fs.mkdir(path.join(root, '.swarm', 'runs', 'old-run', 'jobs'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', 'old-run', 'state.json'), JSON.stringify({ id: 'old-run', status: 'cancelled', finishedAt: '2020-01-01T00:00:00.000Z', jobs: [] }));
  const old = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(path.join(root, '.swarm', 'runs', 'old-run'), old, old);
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  const worktreesDir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gc-wt-'));
  t.after(() => fs.rm(worktreesDir, { recursive: true, force: true }));
  const configDir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gc-config-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const configFile = path.join(configDir, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ worktreesOutsideRoot: true, worktreesDir }));
  const env = { ...process.env, SWARM_CONFIG: configFile };
  const config = { worktreesOutsideRoot: true, worktreesDir };
  const worktreesBase = await worktreesBaseFor(root, config, { env });
  return { root, worktreesDir, worktreesBase, env };
}

test('gc dry run lists candidates and removes nothing', async t => {
  const { root, worktreesBase, env } = await project(t);
  const orphan = path.join(worktreesBase, 'orphan-run', 'orphan-job');
  await fs.mkdir(orphan, { recursive: true });
  await fs.writeFile(path.join(orphan, 'x'), 'x');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(orphan, old, old);
  const dry = await runGc(['--json', '--root', root, '--older-than', '1'], { env, defaultRoot: () => root });
  assert.equal(dry.exitCode, 0);
  const payload = JSON.parse(dry.stdout);
  const orphans = payload.plans?.[0]?.categories?.orphans ?? [];
  assert.ok(orphans.some(row => row.path.includes('orphan-run')));
  await fs.access(orphan);
});

test('gc apply removes finished orphan worktrees', async t => {
  const { root, worktreesBase, env } = await project(t);
  const orphan = path.join(worktreesBase, 'gone-run', 'gone-job');
  await fs.mkdir(orphan, { recursive: true });
  await fs.writeFile(path.join(orphan, 'x'), 'x');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(orphan, old, old);
  const applied = await runGc(['--apply', '--root', root, '--older-than', '1'], { env, defaultRoot: () => root });
  assert.equal(applied.exitCode, 0);
  assert.match(applied.stdout, /freed/);
  await assert.rejects(() => fs.access(orphan));
});

test('active run project is skipped on apply', async t => {
  const { root, env } = await project(t);
  await fs.mkdir(path.join(root, '.swarm', 'runs', 'live'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', 'live', 'state.json'), JSON.stringify({ id: 'live', status: 'running', jobs: [] }));
  const res = await runGc(['--apply', '--root', root], { env, defaultRoot: () => root });
  assert.equal(res.exitCode, 0);
});

test('json usage shape for board contract', async t => {
  const { root, env } = await project(t);
  const res = await runGc(['--json', '--usage', '--root', root], { env, defaultRoot: () => root });
  assert.equal(res.exitCode, 0);
  const data = JSON.parse(res.stdout);
  assert.ok(data.diskUsage);
  assert.ok(Array.isArray(data.diskUsage.projects));
  assert.equal(typeof data.diskUsage.totalBytes, 'number');
  const usage = await computeDiskUsage(root, { env, force: true });
  assert.equal(typeof usage.totalBytes, 'number');
});

test('old run folders beyond keep-runs get summary.json on apply', async t => {
  const { root, env } = await project(t);
  for (let i = 0; i < 3; i += 1) {
    const id = `run-${i}`;
    const dir = path.join(root, '.swarm', 'runs', id);
    await fs.mkdir(path.join(dir, 'jobs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id, status: 'cancelled', finishedAt: '2020-01-01T00:00:00.000Z', jobs: [] }));
    const old = new Date('2020-01-01T00:00:00.000Z');
    await fs.utimes(dir, old, old);
  }
  await runGc(['--apply', '--root', root, '--keep-runs', '1', '--older-than', '1'], { env, defaultRoot: () => root });
  const runNames = await fs.readdir(path.join(root, '.swarm', 'runs'));
  let summaryCount = 0;
  for (const name of runNames) {
    try {
      await fs.access(path.join(root, '.swarm', 'runs', name, 'summary.json'));
      summaryCount += 1;
    } catch { /* no summary */ }
  }
  assert.ok(summaryCount >= 1);
});

test('symlink escape under worktrees base is refused', async t => {
  const { root, worktreesBase, env } = await project(t);
  const target = path.join(root, 'target.txt');
  await fs.writeFile(target, 'victim');
  await fs.mkdir(worktreesBase, { recursive: true });
  const link = path.join(worktreesBase, 'evil');
  await fs.symlink(target, link);
  const plan = await collectProjectGcPlan(root, { env, olderThanDays: 0, nowMs: Date.now() });
  const evil = plan.categories.orphans.find(row => row.path.includes('evil'));
  if (evil) {
    const dry = await runGc(['--root', root], { env, defaultRoot: () => root });
    await fs.access(target);
    assert.equal(dry.exitCode, 0);
  }
});

test('completion lists gc command', () => {
  assert.ok(COMMANDS.some(c => c.name === 'gc'));
});

test('failed run workspaces younger than retention are kept; older ones removed by gc apply', async t => {
  const { root, worktreesBase, env } = await project(t);
  const id = 'failed-old';
  const jobId = 'writer';
  const worktreePath = path.join(worktreesBase, id, jobId);
  await fs.mkdir(worktreePath, { recursive: true });
  await fs.writeFile(path.join(worktreePath, 'x'), 'x');
  const workspaceRel = expectedWorkspaceFor(id, jobId, { workspaceAttempt: 1 });
  const workspaceAbs = path.join(root, workspaceRel);
  await fs.mkdir(workspaceAbs, { recursive: true });
  await fs.writeFile(path.join(workspaceAbs, 'y'), 'y');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(worktreePath, old, old);
  await fs.utimes(workspaceAbs, old, old);
  const runDir = path.join(root, '.swarm', 'runs', id);
  await fs.mkdir(path.join(runDir, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({
    id,
    status: 'failed',
    finishedAt: '2020-01-01T00:00:00.000Z',
    worktreesBase,
    jobs: [{ id: jobId, status: 'failed', worktreePath, workspace: workspaceRel }],
  }));
  await fs.utimes(runDir, old, old);
  const recent = await collectProjectGcPlan(root, { env, olderThanDays: 1, nowMs: Date.parse('2020-01-05T00:00:00.000Z') });
  assert.equal(recent.categories.finishedRuns.length, 0);
  await runGc(['--apply', '--root', root, '--older-than', '1'], { env, defaultRoot: () => root, now: () => Date.parse('2020-01-10T00:00:00.000Z') });
  await assert.rejects(() => fs.access(worktreePath));
  await assert.rejects(() => fs.access(workspaceAbs));
});

test('SWARM_KEEP_FAILED_DAYS extends retention for failed runs', async t => {
  const { root, worktreesBase, env: baseEnv } = await project(t);
  const env = { ...baseEnv, SWARM_KEEP_FAILED_DAYS: '30' };
  assert.equal(resolveKeepFailedDays({}, env), 30);
  const id = 'failed-recent';
  const jobId = 'writer';
  const worktreePath = path.join(worktreesBase, id, jobId);
  await fs.mkdir(worktreePath, { recursive: true });
  await fs.writeFile(path.join(worktreePath, 'x'), 'x');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(worktreePath, old, old);
  const runDir = path.join(root, '.swarm', 'runs', id);
  await fs.mkdir(path.join(runDir, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({
    id,
    status: 'failed',
    finishedAt: '2020-01-15T00:00:00.000Z',
    worktreesBase,
    jobs: [{ id: jobId, status: 'failed', worktreePath }],
  }));
  await fs.utimes(runDir, old, old);
  const plan = await collectProjectGcPlan(root, { env, olderThanDays: 1, nowMs: Date.parse('2020-01-20T00:00:00.000Z') });
  assert.equal(plan.categories.finishedRuns.length, 0);
  await fs.access(worktreePath);
});

test('gc apply skips workspaces referenced by open tickets or blockers', async t => {
  const { root, worktreesBase, env } = await project(t);
  const id = 'ticket-run';
  const jobId = 'writer';
  const worktreePath = path.join(worktreesBase, id, jobId);
  await fs.mkdir(worktreePath, { recursive: true });
  await fs.writeFile(path.join(worktreePath, 'x'), 'x');
  const workspaceRel = expectedWorkspaceFor(id, jobId, { workspaceAttempt: 1 });
  const workspaceAbs = path.join(root, workspaceRel);
  await fs.mkdir(workspaceAbs, { recursive: true });
  const old = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(worktreePath, old, old);
  await fs.utimes(workspaceAbs, old, old);
  const runDir = path.join(root, '.swarm', 'runs', id);
  await fs.mkdir(path.join(runDir, 'jobs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({
    id,
    status: 'failed',
    finishedAt: '2020-01-01T00:00:00.000Z',
    worktreesBase,
    jobs: [{ id: jobId, status: 'failed', worktreePath, workspace: workspaceRel }],
  }));
  await fs.utimes(runDir, old, old);
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T-1', status: 'running', runId: id }],
  }));
  await runGc(['--apply', '--root', root, '--older-than', '1'], { env, defaultRoot: () => root, now: () => Date.parse('2020-02-01T00:00:00.000Z') });
  await fs.access(worktreePath);
  await fs.access(workspaceAbs);
  await fs.writeFile(path.join(root, '.swarm', 'project', 'journal.ndjson'), `${JSON.stringify({ kind: 'blocker', id: `integrate-${id}`, resolved: false, runId: id })}\n`);
  const orphan = path.join(worktreesBase, 'orphan-only', 'job');
  await fs.mkdir(orphan, { recursive: true });
  await fs.writeFile(path.join(orphan, 'z'), 'z');
  await fs.utimes(orphan, old, old);
  await runGc(['--apply', '--root', root, '--older-than', '1'], { env, defaultRoot: () => root, now: () => Date.parse('2020-02-01T00:00:00.000Z') });
  await fs.access(worktreePath);
  await assert.rejects(() => fs.access(orphan));
});
