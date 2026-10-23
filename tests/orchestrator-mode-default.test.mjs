// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardDecision } from '../tools/handbuild.mjs';
import { orchestratorModeEnabled } from '../tools/shell-writes.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-omdef-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function defaultSwarmProject(t) {
  const root = await tmp(t);
  execFileSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
  // Intentional swarm root (not guard bootstrap only): keeps orchestrator mode on after hook logging.
  await fs.writeFile(path.join(root, '.swarm', '.gitkeep'), '');
  return root;
}

function withOrchestratorModeEnv(fn) {
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    SWARM_TEST_TMP: process.env.SWARM_TEST_TMP,
    SWARM_OMODE_SCRATCH_EXEMPT: process.env.SWARM_OMODE_SCRATCH_EXEMPT,
  };
  delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
  delete process.env.SWARM_TEST_TMP;
  process.env.NODE_ENV = 'production';
  try {
    return fn();
  } finally {
    if (prev.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.NODE_ENV;
    if (prev.SWARM_TEST_TMP === undefined) delete process.env.SWARM_TEST_TMP;
    else process.env.SWARM_TEST_TMP = prev.SWARM_TEST_TMP;
    if (prev.SWARM_OMODE_SCRATCH_EXEMPT === undefined) delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
    else process.env.SWARM_OMODE_SCRATCH_EXEMPT = prev.SWARM_OMODE_SCRATCH_EXEMPT;
  }
}

function guardHook(root, cwd, command) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      session_id: 'om-default',
      cwd,
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SWARM_TEST_TMP: '',
      SWARM_OMODE_SCRATCH_EXEMPT: '',
      CLAUDE_PROJECT_DIR: root,
    },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return { denied: false };
  try {
    const parsed = JSON.parse(line);
    const deny = parsed?.hookSpecificOutput?.permissionDecision === 'deny';
    return { denied: deny, reason: parsed?.hookSpecificOutput?.permissionDecisionReason };
  } catch {
    return { denied: false };
  }
}

test('default project root: orchestrator mode active with only .swarm (no orchestrator-mode dir)', async t => {
  const root = await defaultSwarmProject(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    withOrchestratorModeEnv(() => {
      assert.equal(orchestratorModeEnabled(root, root), true);
    });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('handbuild-guard subprocess: default-on allowlist at project root', async t => {
  const root = await defaultSwarmProject(t);
  const denyCommands = [
    'node -e 1',
    'python3 -c 1',
    'ls; node x.js',
    'git log | head -300',
    'cat a | sh',
  ];
  for (const command of denyCommands) {
    const { denied } = guardHook(root, root, command);
    assert.equal(denied, true, command);
  }
  const allowCommands = [
    'git status -s | head -n 5',
    'swarm tickets --status blocked',
    'grep -n foo f | head -n 50',
    'gh pr view 3',
  ];
  for (const command of allowCommands) {
    const { denied } = guardHook(root, root, command);
    assert.equal(denied, false, command);
  }
});

test('worker workspace and scratch tmp cwd are not subject to orchestrator mode', async t => {
  const root = await defaultSwarmProject(t);
  const workspace = path.join(root, '.swarm', 'workspaces', 'run1', 'job-1');
  await fs.mkdir(workspace, { recursive: true });
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
  assert.equal(orchestratorModeEnabled(root, workspace), false);
  const dWs = guardDecision({
    tool: 'Bash',
    toolInput: { command: 'node -e 1' },
    root,
    cwd: workspace,
    now: () => T0,
  });
  assert.equal(dWs.allow, true);

  const testTmp = process.env.SWARM_TEST_TMP;
  assert.ok(testTmp, 'SWARM_TEST_TMP from isolate config');
  const scratchCwd = path.join(testTmp, 'tmp', 'orchestrator-worker');
  await fs.mkdir(scratchCwd, { recursive: true });
  assert.equal(orchestratorModeEnabled(root, scratchCwd), false);
  const dScratch = guardDecision({
    tool: 'Bash',
    toolInput: { command: 'node -e 1' },
    root,
    cwd: scratchCwd,
    now: () => T0,
  });
  assert.equal(dScratch.allow, true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});
