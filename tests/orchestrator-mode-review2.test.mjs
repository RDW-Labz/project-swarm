// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  orchestratorModeCommandAllowed,
  orchestratorModeEnabled,
  isVerifiedSwarmWorkerCwd,
  ORCHESTRATOR_MODE_DENY_REASON,
  ORCHESTRATOR_MODE_OFF_FILE,
  SWARM_WORKER_RUN_ID_ENV,
} from '../tools/shell-writes.mjs';
import {
  guardDecision,
  ORCHESTRATOR_MODE_RULE_ID,
  createRequest,
  decideRequest,
  GUARD_ERROR_DENY_REASON,
} from '../tools/handbuild.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-om-r2-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function swarmProject(t, { withGit = true } = {}) {
  const root = await tmp(t);
  if (withGit) await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm', 'runs'), { recursive: true });
  return root;
}

const omReason = d => d.reason === ORCHESTRATOR_MODE_DENY_REASON && d.ruleId === ORCHESTRATOR_MODE_RULE_ID;

test('orchestrator mode stays on when cwd is an unverified workspaces path (cd bypass)', async t => {
  const root = await swarmProject(t);
  const fakeWs = path.join(root, '.swarm', 'workspaces', 'fake-run', 'job-1');
  await fs.mkdir(fakeWs, { recursive: true });
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    assert.equal(isVerifiedSwarmWorkerCwd(root, fakeWs), false);
    assert.equal(orchestratorModeEnabled(root, root), true);
    const d = guardDecision({
      tool: 'Bash',
      toolInput: { command: 'cd .swarm/workspaces/fake-run/job-1 && npm test' },
      root,
      cwd: root,
      now: () => T0,
    });
    assert.equal(d.allow, false);
    assert.ok(omReason(d));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('verified worker workspace cwd exempts orchestrator mode', async t => {
  const root = await swarmProject(t);
  const runId = 'run-verified';
  await fs.mkdir(path.join(root, '.swarm', 'runs', runId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', runId, 'state.json'), '{}');
  const workspace = path.join(root, '.swarm', 'workspaces', runId, 'job-1');
  await fs.mkdir(workspace, { recursive: true });
  const prev = process.env.CLAUDE_PROJECT_DIR;
  const prevRun = process.env[SWARM_WORKER_RUN_ID_ENV];
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env[SWARM_WORKER_RUN_ID_ENV] = runId;
  try {
    assert.equal(isVerifiedSwarmWorkerCwd(root, workspace), true);
    assert.equal(orchestratorModeEnabled(root, workspace), false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
    if (prevRun === undefined) delete process.env[SWARM_WORKER_RUN_ID_ENV];
    else process.env[SWARM_WORKER_RUN_ID_ENV] = prevRun;
  }
});

test('orchestrator mode blocks git commit/push and gh pr create/merge even with handbuild approval', async t => {
  const root = await swarmProject(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  const r = createRequest(root, {
    kind: 'tiny',
    reason: 'approval should not bypass orchestrator git',
    files: 'src/a.ts',
    minutes: 30,
    git: 'commit,push,gh',
  }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  try {
    for (const command of [
      'git commit -m "x"',
      'git push origin main',
      'gh pr create --title t --body b',
      'gh pr merge 1',
    ]) {
      const d = guardDecision({
        tool: 'Bash',
        toolInput: { command },
        root,
        cwd: root,
        now: () => T0,
      });
      assert.equal(d.allow, false, command);
      if (command.startsWith('gh pr merge')) assert.match(d.reason, /swarm merge/i, command);
      else assert.ok(omReason(d), command);
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('orchestrator mode blocks writes under .swarm/orchestrator-mode with case variants', async t => {
  const root = await swarmProject(t);
  await fs.mkdir(path.join(root, '.swarm', 'orchestrator-mode'), { recursive: true });
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    const offPath = path.join(root, '.swarm', 'orchestrator-mode', 'OFF');
    const d = guardDecision({
      tool: 'Write',
      toolInput: { file_path: offPath, content: '' },
      root,
      cwd: root,
      now: () => T0,
    });
    assert.equal(d.allow, false);
    assert.ok(omReason(d));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('orchestrator mode on with only .git when CLAUDE_PROJECT_DIR unset', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm', 'runs'), { recursive: true });
  const prev = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    assert.equal(orchestratorModeEnabled(root, root), true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('scratch path shape does not disable orchestrator mode when scratch exempt flag is off', async t => {
  const root = await swarmProject(t);
  const prevScratch = process.env.SWARM_OMODE_SCRATCH_EXEMPT;
  const prevTestTmp = process.env.SWARM_TEST_TMP;
  const prevEnv = process.env.NODE_ENV;
  delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
  delete process.env.SWARM_TEST_TMP;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(orchestratorModeEnabled(root, root), true);
  } finally {
    if (prevScratch === undefined) delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
    else process.env.SWARM_OMODE_SCRATCH_EXEMPT = prevScratch;
    if (prevTestTmp === undefined) delete process.env.SWARM_TEST_TMP;
    else process.env.SWARM_TEST_TMP = prevTestTmp;
    process.env.NODE_ENV = prevEnv;
  }
});

test('handbuild-guard denies invalid JSON when CLAUDE_PROJECT_DIR is set and stdin non-empty', async t => {
  const root = await swarmProject(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  const r = spawnSync(process.execPath, [GUARD], {
    input: '{bad-json',
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', CLAUDE_PROJECT_DIR: root },
  });
  if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prev;
  assert.equal(r.status, 0);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  const parsed = JSON.parse(line);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, GUARD_ERROR_DENY_REASON);
});

test('orchestratorModeCommandAllowed refuses non-allowlisted swarm subcommands', async () => {
  const binDir = path.join(process.env.HOME, '.local', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const swarmMjs = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
  const wrapper = `#!/bin/sh\n# managed by project-swarm\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(swarmMjs)} "$@"\n`;
  await fs.writeFile(path.join(binDir, 'swarm'), wrapper, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  assert.equal(orchestratorModeCommandAllowed('swarm init'), false);
  assert.equal(orchestratorModeCommandAllowed('swarm mutants'), false);
  assert.equal(orchestratorModeCommandAllowed('swarm status'), true);
  assert.equal(orchestratorModeCommandAllowed('swarm tickets --status blocked'), true);
});
