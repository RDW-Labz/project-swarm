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
  initOrchestratorModeTrustedBins,
} from '../tools/shell-writes.mjs';
import {
  guardDecision,
  OFF_FILE,
  ORCHESTRATOR_MODE_RULE_ID,
  ORCHESTRATOR_MODE_DENY_REASON,
} from '../tools/handbuild.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-om-r4-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function swarmRoot(t) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm', 'runs'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'line\n');
  return root;
}

async function installLocalSwarmShim() {
  const binDir = path.join(process.env.HOME, '.local', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const wrapper = `#!/bin/sh\n# managed by project-swarm\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SWARM_MJS)} "$@"\n`;
  await fs.writeFile(path.join(binDir, 'swarm'), wrapper, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
}

const omReason = d => d.reason === ORCHESTRATOR_MODE_DENY_REASON && d.ruleId === ORCHESTRATOR_MODE_RULE_ID;

test('R4-1 sed: only sed -n N,Mp file; refuse -e and substitution-looking operands', async t => {
  const root = await swarmRoot(t);
  const ctx = { root, cwd: root };
  assert.equal(orchestratorModeCommandAllowed("sed -n '1,5p' src/a.ts", ctx), true);
  assert.equal(orchestratorModeCommandAllowed("sed -e '1p' src/a.ts", ctx), false);
  assert.equal(orchestratorModeCommandAllowed("sed -n 's/a/b/' src/a.ts", ctx), false);
  assert.equal(orchestratorModeCommandAllowed('sed --expression=1p src/a.ts', ctx), false);
  assert.equal(orchestratorModeCommandAllowed('sed --in-place=1 s/a/b/ src/a.ts', ctx), false);
});

test('R4-2 node: no flags before swarm.mjs; preload refused', async () => {
  await installLocalSwarmShim();
  initOrchestratorModeTrustedBins();
  assert.equal(orchestratorModeCommandAllowed('node --import=x tools/swarm.mjs status'), false);
  assert.equal(orchestratorModeCommandAllowed(`node -e "1"`), false);
});

test('R4-3 redirects: refuse bare >& and <> tokens', () => {
  assert.equal(orchestratorModeCommandAllowed('git status >&'), false);
  assert.equal(orchestratorModeCommandAllowed('git status <>'), false);
  assert.equal(orchestratorModeCommandAllowed('git status 2>&1'), true);
});

test('R4-4 orchestrator mode on without CLAUDE_PROJECT_DIR when cwd is project root', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    const d = guardDecision({
      tool: 'Bash',
      toolInput: { command: 'npm test' },
      root,
      cwd: root,
      now: () => T0,
      enforceOrchestratorMode: orchestratorModeEnabled(root, root),
    });
    assert.ok(omReason(d));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('R4-5 handbuild off still denies npm via orchestrator hook path', async t => {
  const root = await swarmRoot(t);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, OFF_FILE), '');
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      session_id: 'r4-5',
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 0);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  assert.equal(JSON.parse(line).hookSpecificOutput.permissionDecision, 'deny');
});

test('R4-6 invalid JSON denied in swarm project without CLAUDE_PROJECT_DIR', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [GUARD], {
    input: '{bad',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '' },
    cwd: root,
  });
  if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prev;
  assert.equal(r.status, 0);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  assert.equal(JSON.parse(line).hookSpecificOutput.permissionDecision, 'deny');
});

test('R4-7 MultiEdit is guarded like Write', async t => {
  const root = await swarmRoot(t);
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      session_id: 'r4-7',
      cwd: root,
      tool_name: 'MultiEdit',
      tool_input: { file_path: 'src/a.ts', edits: [] },
    }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 0);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  assert.ok(line);
  assert.equal(JSON.parse(line).hookSpecificOutput.permissionDecision, 'deny');
});

test('R4-8 jq builtins and $ refused', async t => {
  const root = await swarmRoot(t);
  const ctx = { root, cwd: root };
  assert.equal(orchestratorModeCommandAllowed('jq .name package.json | head -n 5', ctx), true);
  assert.equal(orchestratorModeCommandAllowed('jq env package.json | head -n 5', ctx), false);
  assert.equal(orchestratorModeCommandAllowed('jq $ENV package.json | head -n 5', ctx), false);
});

test('R4-9 find and wc operands checked after pipe', async t => {
  const root = await swarmRoot(t);
  const ctx = { root, cwd: root };
  await fs.writeFile(path.join(root, 'pkg.json'), '{}');
  assert.equal(orchestratorModeCommandAllowed('find src -name "*.ts" | wc -l', ctx), true);
  assert.equal(orchestratorModeCommandAllowed('find src -name "*.ts" | wc -l /etc/passwd', ctx), false);
});

test('R4-10 swarm --root must match project; run flags limited', async t => {
  await installLocalSwarmShim();
  const root = await swarmRoot(t);
  assert.equal(orchestratorModeCommandAllowed('swarm --root /tmp status', { root, cwd: root }), false);
  assert.equal(orchestratorModeCommandAllowed('swarm run --evil x', { root, cwd: root }), false);
  assert.equal(orchestratorModeCommandAllowed('swarm decide handbuild-hb-1 approve', { root, cwd: root }), false);
});

test('R4-11 SWARM_WORKER_RUN_ID does not disable orchestrator mode in a workspace', async t => {
  const root = await swarmRoot(t);
  const runId = 'run-r4';
  await fs.mkdir(path.join(root, '.swarm', 'runs', runId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', runId, 'state.json'), '{}');
  const workspace = path.join(root, '.swarm', 'workspaces', runId, 'job-1');
  await fs.mkdir(workspace, { recursive: true });
  const prev = process.env.SWARM_WORKER_RUN_ID;
  process.env.SWARM_WORKER_RUN_ID = runId;
  try {
    assert.equal(orchestratorModeEnabled(root, root), true);
    assert.equal(orchestratorModeEnabled(root, workspace), true);
    const d = guardDecision({
      tool: 'Bash',
      toolInput: { command: 'npm test' },
      root,
      cwd: workspace,
      now: () => T0,
      enforceOrchestratorMode: true,
    });
    assert.ok(omReason(d));
  } finally {
    if (prev === undefined) delete process.env.SWARM_WORKER_RUN_ID;
    else process.env.SWARM_WORKER_RUN_ID = prev;
  }
});

test('R4-12 protected write path resolves through missing leaf', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    const d = guardDecision({
      tool: 'Write',
      toolInput: { file_path: '.swarm/orchestrator-mode/nested/off', content: 'x' },
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

test('R4-13 handbuild approval does not bypass shell allowlist', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  const { createRequest, decideRequest } = await import('../tools/handbuild.mjs');
  const r = createRequest(root, {
    kind: 'tiny',
    reason: 'allowlist still applies with approval',
    files: 'src/a.ts',
    minutes: 30,
  }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  try {
    const d = guardDecision({
      tool: 'Bash',
      toolInput: { command: 'sed -i "" s/a/b/ src/a.ts' },
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

test('R4-14 scratch env no longer disables orchestrator mode', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.SWARM_OMODE_SCRATCH_EXEMPT;
  process.env.SWARM_OMODE_SCRATCH_EXEMPT = '1';
  try {
    assert.equal(orchestratorModeEnabled(root, root), true);
  } finally {
    if (prev === undefined) delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
    else process.env.SWARM_OMODE_SCRATCH_EXEMPT = prev;
  }
});

test('R4-15 relative cd refused when CDPATH is set', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.CDPATH;
  process.env.CDPATH = '/tmp';
  try {
    assert.equal(orchestratorModeCommandAllowed('cd src && git status', { root, cwd: root }), false);
  } finally {
    if (prev === undefined) delete process.env.CDPATH;
    else process.env.CDPATH = prev;
  }
});

test('R4-16 orchestrator-hook imports child_process fs and hookScriptPath', async () => {
  const text = await fs.readFile(fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url)), 'utf8');
  assert.match(text, /child_process/);
  assert.match(text, /from 'node:fs'/);
  assert.match(text, /hookScriptPath/);
});
