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
  GUARD_ERRORS_FILE,
  OFF_FILE,
  guardErrorsToday,
} from '../tools/handbuild.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-guard-fc-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function project(t) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
  return root;
}

function runGuard(root, extraEnv = {}, input = {
  session_id: 'guard-fc',
  cwd: root,
  tool_name: 'Bash',
  tool_input: { command: 'git status' },
}) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CLAUDE_PROJECT_DIR: root,
      ...extraEnv,
    },
  });
}

function parseDeny(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed?.hookSpecificOutput ?? null;
  } catch {
    return null;
  }
}

test('handbuild-guard: throw fault fails closed with exact reason and log', async t => {
  const root = await project(t);
  const r = runGuard(root, { SWARM_GUARD_TEST_FAULT: 'throw' });
  assert.equal(r.status, 0);
  const out = parseDeny(r.stdout);
  assert.equal(out?.permissionDecision, 'deny');
  assert.equal(out?.permissionDecisionReason, GUARD_ERROR_DENY_REASON);
  assert.equal(guardErrorsToday(root), 1);
  const log = (await fs.readFile(path.join(root, GUARD_ERRORS_FILE), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].kind, 'crash');
  assert.equal(log[0].name, 'Error');
  assert.match(log[0].message, /SWARM_GUARD_TEST_THROW/);
  const eventsText = await fs.readFile(path.join(root, '.swarm/orchestrator/events.ndjson'), 'utf8');
  assert.ok(eventsText.split('\n').some(line => line.includes('"e":"guard-error"')));
});

test('handbuild-guard: hang fault times out with exact reason and log', async t => {
  const root = await project(t);
  const r = runGuard(root, {
    SWARM_GUARD_TEST_FAULT: 'hang',
    SWARM_GUARD_TIMEOUT_MS: '80',
  });
  assert.equal(r.status, 0);
  const out = parseDeny(r.stdout);
  assert.equal(out?.permissionDecision, 'deny');
  assert.equal(out?.permissionDecisionReason, GUARD_ERROR_DENY_REASON);
  const log = (await fs.readFile(path.join(root, GUARD_ERRORS_FILE), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(log[0].kind, 'timeout');
});

test('handbuild-guard: off file bypasses guard even under throw fault', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, OFF_FILE), '');
  const r = runGuard(root, { SWARM_GUARD_TEST_FAULT: 'throw' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal(guardErrorsToday(root), 0);
});

test('handbuild-guard: fault env ignored outside test mode', async t => {
  const root = await project(t);
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      session_id: 'guard-fc',
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CLAUDE_PROJECT_DIR: root,
      SWARM_GUARD_TEST_FAULT: 'throw',
    },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('handbuild-guard: invalid JSON fails closed', async t => {
  const root = await project(t);
  const r = spawnSync(process.execPath, [GUARD], {
    input: '{not-json',
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 0);
  const out = parseDeny(r.stdout);
  assert.equal(out?.permissionDecisionReason, GUARD_ERROR_DENY_REASON);
});
