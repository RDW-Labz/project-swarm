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
  GUARD_ERROR_DENY_REASON,
  ORCHESTRATOR_COMMAND_TOO_LONG_REASON,
  OFF_FILE,
} from '../tools/handbuild.mjs';
import { guardDecision } from '../tools/handbuild.mjs';
import { tokenizeStepCount } from '../tools/shell-writes.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const ORCH_HOOK = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-om-timeout-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function project(t) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
  return root;
}

function runGuard(root, extraEnv = {}, input) {
  const payload = input ?? {
    session_id: 'om-timeout',
    cwd: root,
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
  };
  const started = Date.now();
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CLAUDE_PROJECT_DIR: root,
      ...extraEnv,
    },
  });
  return { ...r, elapsedMs: Date.now() - started };
}

function parseDeny(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line)?.hookSpecificOutput ?? null;
  } catch {
    return null;
  }
}

function manySegments(n) {
  return Array.from({ length: n }, () => 'ls').join(';');
}

test('handbuild-guard: spin fault denies within guard timeout + slack', async t => {
  const root = await project(t);
  const timeoutMs = 200;
  const r = runGuard(root, {
    SWARM_GUARD_TEST_FAULT: 'spin',
    SWARM_GUARD_TIMEOUT_MS: String(timeoutMs),
  });
  assert.equal(r.status, 0);
  assert.ok(r.elapsedMs < timeoutMs + 3000, `took ${r.elapsedMs}ms`);
  const out = parseDeny(r.stdout);
  assert.equal(out?.permissionDecisionReason, GUARD_ERROR_DENY_REASON);
});

test('handbuild-guard: crash fault fails closed', async t => {
  const root = await project(t);
  const r = runGuard(root, { SWARM_GUARD_TEST_FAULT: 'crash' });
  assert.equal(r.status, 0);
  const out = parseDeny(r.stdout);
  assert.equal(out?.permissionDecisionReason, GUARD_ERROR_DENY_REASON);
});

test('handbuild-guard: hang fault times out (child)', async t => {
  const root = await project(t);
  const timeoutMs = 80;
  const r = runGuard(root, {
    SWARM_GUARD_TEST_FAULT: 'hang',
    SWARM_GUARD_TIMEOUT_MS: String(timeoutMs),
  });
  assert.equal(r.status, 0);
  assert.ok(r.elapsedMs < timeoutMs + 3000);
  const out = parseDeny(r.stdout);
  assert.equal(out?.permissionDecisionReason, GUARD_ERROR_DENY_REASON);
});

test('orchestrator mode: oversized bash command denied', async t => {
  const root = await project(t);
  const prev = {
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    NODE_ENV: process.env.NODE_ENV,
    SWARM_TEST_TMP: process.env.SWARM_TEST_TMP,
    SWARM_OMODE_SCRATCH_EXEMPT: process.env.SWARM_OMODE_SCRATCH_EXEMPT,
  };
  process.env.CLAUDE_PROJECT_DIR = root;
  delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
  delete process.env.SWARM_TEST_TMP;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (prev.CLAUDE_PROJECT_DIR === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev.CLAUDE_PROJECT_DIR;
    if (prev.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.NODE_ENV;
    if (prev.SWARM_TEST_TMP === undefined) delete process.env.SWARM_TEST_TMP;
    else process.env.SWARM_TEST_TMP = prev.SWARM_TEST_TMP;
    if (prev.SWARM_OMODE_SCRATCH_EXEMPT === undefined) delete process.env.SWARM_OMODE_SCRATCH_EXEMPT;
    else process.env.SWARM_OMODE_SCRATCH_EXEMPT = prev.SWARM_OMODE_SCRATCH_EXEMPT;
  });
  const cmd = manySegments(2001);
  const decision = guardDecision({
    tool: 'Bash',
    toolInput: { command: cmd },
    root,
    cwd: root,
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, ORCHESTRATOR_COMMAND_TOO_LONG_REASON);
});

test('tokenizer work scales roughly linearly', () => {
  const small = tokenizeStepCount(manySegments(2000));
  const large = tokenizeStepCount(manySegments(8000));
  assert.ok(large < small * 6, `ratio ${large / small}`);
  const t0 = Date.now();
  tokenizeStepCount(manySegments(8000));
  assert.ok(Date.now() - t0 < 1500);
});

test('orchestrator-hook: spin child exits 0 within 3s', async t => {
  const root = await project(t);
  const started = Date.now();
  const r = spawnSync(process.execPath, [ORCH_HOOK, 'pre'], {
    input: JSON.stringify({
      session_id: 'orch-spin',
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SWARM_ORCH_HOOK_TEST_FAULT: 'spin',
    },
  });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - started < 3000);
});

test('handbuild-guard: off file bypasses guard instantly under spin fault', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, OFF_FILE), '');
  const started = Date.now();
  const r = runGuard(root, { SWARM_GUARD_TEST_FAULT: 'spin' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.ok(Date.now() - started < 500);
});
