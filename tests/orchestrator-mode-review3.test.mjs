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
  orchestratorModeApplies,
  orchestratorResolvedRoot,
  orchestratorTestHarnessSigned,
  isVerifiedSwarmWorkerCwd,
  SWARM_WORKER_RUN_ID_ENV,
  ORCHESTRATOR_TEST_MARKER_REL,
  ORCHESTRATOR_TEST_MARKER_BODY,
} from '../tools/shell-writes.mjs';
import {
  guardDecision,
  guardTimeoutMs,
  guardHarnessAllowsFaultInjection,
  ORCHESTRATOR_MODE_RULE_ID,
  ORCHESTRATOR_MODE_DENY_REASON,
} from '../tools/handbuild.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-om-r3-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function swarmRoot(t) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm', 'runs'), { recursive: true });
  return root;
}

async function installLocalSwarmShim() {
  const binDir = path.join(process.env.HOME, '.local', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const wrapper = `#!/bin/sh\n# managed by project-swarm\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SWARM_MJS)} "$@"\n`;
  await fs.writeFile(path.join(binDir, 'swarm'), wrapper, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
}

async function writeMarker(root) {
  await fs.mkdir(path.join(root, '.swarm', 'orchestrator-mode'), { recursive: true });
  await fs.writeFile(path.join(root, ORCHESTRATOR_TEST_MARKER_REL), ORCHESTRATOR_TEST_MARKER_BODY);
}

const omReason = d => d.reason === ORCHESTRATOR_MODE_DENY_REASON && d.ruleId === ORCHESTRATOR_MODE_RULE_ID;

test('H1: guard uses CLAUDE_PROJECT_DIR over nested .swarm marker under cwd', async t => {
  const root = await swarmRoot(t);
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(path.join(nested, '.swarm', 'runs'), { recursive: true });
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      session_id: 'h1',
      cwd: nested,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prev;
  assert.equal(r.status, 0);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  const parsed = JSON.parse(line);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});

test('H2: cd into .swarm/workspaces does not disable orchestrator mode', async t => {
  const root = await swarmRoot(t);
  const fakeWs = path.join(root, '.swarm', 'workspaces', 'fake', 'job');
  await fs.mkdir(fakeWs, { recursive: true });
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    assert.equal(orchestratorModeEnabled(root, root), true);
    assert.equal(orchestratorModeCommandAllowed('cd .swarm/workspaces/fake/job && npm test', { root, cwd: root }), false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('H3: missing CLAUDE_PROJECT_DIR still applies mode; scratch env alone does not exempt', async t => {
  const root = await swarmRoot(t);
  const prev = {
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    NODE_ENV: process.env.NODE_ENV,
    SWARM_TEST_TMP: process.env.SWARM_TEST_TMP,
    SWARM_OMODE_SCRATCH_EXEMPT: process.env.SWARM_OMODE_SCRATCH_EXEMPT,
  };
  delete process.env.CLAUDE_PROJECT_DIR;
  process.env.NODE_ENV = 'test';
  delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
  try {
    assert.equal(orchestratorModeApplies(null, root), true);
    assert.equal(orchestratorModeEnabled(root, root), true);
  } finally {
    Object.assign(process.env, prev);
    if (prev.CLAUDE_PROJECT_DIR === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    if (prev.SWARM_OMODE_SCRATCH_EXEMPT === undefined) delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
  }
});

test('H4: sed substitution commands are refused', () => {
  assert.equal(orchestratorModeCommandAllowed("sed 's/a/b/' file"), false);
  assert.equal(orchestratorModeCommandAllowed('sed -n 1,5p src/a.ts'), true);
});

test('H5: gh api is refused (including piped)', () => {
  assert.equal(orchestratorModeCommandAllowed('gh api repos/o/r/pulls'), false);
  assert.equal(orchestratorModeCommandAllowed('gh api repos/o/r/pulls | head -n 5'), false);
});

test('M1: invalid JSON is denied when CLAUDE_PROJECT_DIR is set', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  const r = spawnSync(process.execPath, [GUARD], {
    input: '{not-json',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prev;
  assert.equal(r.status, 0);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  assert.equal(JSON.parse(line).hookSpecificOutput.permissionDecision, 'deny');
});

test('M2: unknown swarm global flag refuses allowlist', async () => {
  await installLocalSwarmShim();
  assert.equal(orchestratorModeCommandAllowed('swarm --evil status'), false);
});

test('M3: handbuild off file does not disable orchestrator mode', async t => {
  const root = await swarmRoot(t);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'handbuild', 'off'), '');
  await fs.writeFile(path.join(root, '.swarm', '.gitkeep'), '');
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    assert.equal(orchestratorModeEnabled(root, root), true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('M4: bash write to orchestrator-mode off path blocked before approval', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    const d = guardDecision({
      tool: 'Bash',
      toolInput: { command: 'echo x > .swarm/orchestrator-mode/off' },
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

test('M5: glob operands on read commands are refused', async t => {
  const root = await swarmRoot(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  assert.equal(orchestratorModeCommandAllowed('grep foo src/*.ts | head -n 5', { root, cwd: root }), false);
});

test('M6: gh auth status rejects extra flags', () => {
  assert.equal(orchestratorModeCommandAllowed('gh auth status'), true);
  assert.equal(orchestratorModeCommandAllowed('gh auth status --show-token'), false);
});

test('L1: cd inside subshell does not affect outer allowlist', () => {
  assert.equal(orchestratorModeCommandAllowed('( cd /tmp && git status )', { root: '/p', cwd: '/p' }), false);
});

test('L2: guard timeout override ignored without harness marker', async t => {
  const root = await swarmRoot(t);
  await writeMarker(root);
  const prev = process.env.SWARM_GUARD_TIMEOUT_MS;
  process.env.SWARM_GUARD_TIMEOUT_MS = '10';
  assert.equal(guardTimeoutMs(root), 50);
  assert.equal(guardHarnessAllowsFaultInjection(root), true);
  delete process.env.SWARM_GUARD_TIMEOUT_MS;
  assert.equal(guardTimeoutMs(root), 15000);
  if (prev === undefined) delete process.env.SWARM_GUARD_TIMEOUT_MS;
  else process.env.SWARM_GUARD_TIMEOUT_MS = prev;
});

test('L3: path-qualified swarm binary is refused', async () => {
  await installLocalSwarmShim();
  assert.equal(orchestratorModeCommandAllowed('/tmp/evil-swarm status'), false);
});

test('worker exemption requires launcher run id env', async t => {
  const root = await swarmRoot(t);
  const runId = 'run-env-only';
  await fs.mkdir(path.join(root, '.swarm', 'runs', runId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', runId, 'state.json'), '{}');
  const workspace = path.join(root, '.swarm', 'workspaces', runId, 'job');
  await fs.mkdir(workspace, { recursive: true });
  assert.equal(isVerifiedSwarmWorkerCwd(root, workspace), false);
  const prev = process.env[SWARM_WORKER_RUN_ID_ENV];
  process.env[SWARM_WORKER_RUN_ID_ENV] = runId;
  try {
    assert.equal(isVerifiedSwarmWorkerCwd(root, workspace), true);
  } finally {
    if (prev === undefined) delete process.env[SWARM_WORKER_RUN_ID_ENV];
    else process.env[SWARM_WORKER_RUN_ID_ENV] = prev;
  }
});

test('orchestratorResolvedRoot falls back when CLAUDE_PROJECT_DIR missing', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    assert.equal(orchestratorResolvedRoot(root), root);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('signed test marker gates scratch exemption', async t => {
  const root = await swarmRoot(t);
  const prev = process.env.SWARM_OMODE_SCRATCH_EXEMPT;
  process.env.SWARM_OMODE_SCRATCH_EXEMPT = '1';
  assert.equal(orchestratorTestHarnessSigned(root), false);
  await writeMarker(root);
  assert.equal(orchestratorTestHarnessSigned(root), true);
  if (prev === undefined) delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
  else process.env.SWARM_OMODE_SCRATCH_EXEMPT = prev;
});
