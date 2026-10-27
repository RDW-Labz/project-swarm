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
  issueWorkerToken,
  revokeWorkerToken,
  WORKER_TOKEN_ENV,
  SWARM_WORKER_RUN_ID_ENV,
} from '../tools/worker-token.mjs';
import { ORCHESTRATOR_MODE_DENY_REASON } from '../tools/shell-writes.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const HOOK_SHELL = (script) =>
  `test -f ${JSON.stringify(script)} && node ${JSON.stringify(script)} || true`;
const SPAWN_TIMEOUT_MS = 60_000;

/** @type {number[]} */
const hookChildPids = [];

function killHookChildren() {
  if (process.platform === 'win32') return;
  for (const pid of hookChildPids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  }
  hookChildPids.length = 0;
}

function runWriteHook({ root, cwd, absTarget, envPatch = {}, omitWorkerProof = false }) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: root,
    NODE_ENV: 'production',
    ...envPatch,
  };
  if (omitWorkerProof) delete env[WORKER_TOKEN_ENV];
  const opts = {
    input: JSON.stringify({
      session_id: 'worker-guard-e2e',
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: absTarget, content: 'probe' },
    }),
    encoding: 'utf8',
    env,
    timeout: SPAWN_TIMEOUT_MS,
  };
  if (process.platform !== 'win32') opts.detached = true;
  const viaShell = spawnSync('sh', ['-c', HOOK_SHELL(GUARD)], opts);
  if (process.platform !== 'win32' && viaShell.pid) hookChildPids.push(viaShell.pid);
  return viaShell;
}

function denyReason(stdout) {
  const line = String(stdout ?? '').trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    if (parsed?.hookSpecificOutput?.permissionDecision === 'deny') {
      return parsed.hookSpecificOutput.permissionDecisionReason ?? true;
    }
  } catch {
    return null;
  }
  return null;
}

async function swarmProject(t) {
  const base = process.env.SWARM_TEST_TMP || os.tmpdir();
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'swarm-wg-e2e-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  t.after(killHookChildren);
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  const runId = 'run-e2e';
  const jobOne = 'job-one';
  const jobTwo = 'job-two';
  await fs.mkdir(path.join(root, '.swarm', 'runs', runId), { recursive: true });
  await fs.writeFile(
    path.join(root, '.swarm', 'runs', runId, 'state.json'),
    `${JSON.stringify({ id: runId })}\n`,
  );
  const wsOne = path.join(root, '.swarm', 'workspaces', runId, jobOne);
  const wsTwo = path.join(root, '.swarm', 'workspaces', runId, jobTwo);
  await fs.mkdir(wsOne, { recursive: true });
  await fs.mkdir(wsTwo, { recursive: true });
  const relInWs = `.swarm/workspaces/${runId}/${jobOne}/allowed.txt`;
  const absInWs = path.join(root, relInWs);
  const proofOne = await issueWorkerToken({ root, runId, jobId: jobOne, workspace: wsOne });
  await issueWorkerToken({ root, runId, jobId: jobTwo, workspace: wsTwo });
  return {
    root,
    runId,
    jobOne,
    jobTwo,
    wsOne,
    wsTwo,
    relInWs,
    absInWs,
    proofOne,
  };
}

test(
  'handbuild guard hook process enforces worker scope with real env and tokens',
  { timeout: SPAWN_TIMEOUT_MS },
  async (t) => {
    const fx = await swarmProject(t);

    const allowed = runWriteHook({
      root: fx.root,
      cwd: fx.wsOne,
      absTarget: fx.absInWs,
      envPatch: {
        [SWARM_WORKER_RUN_ID_ENV]: fx.runId,
        [WORKER_TOKEN_ENV]: fx.proofOne,
      },
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(String(allowed.stdout).trim(), '', 'in-workspace worker write allowed');

    const orchSamePath = runWriteHook({
      root: fx.root,
      cwd: fx.root,
      absTarget: fx.absInWs,
      omitWorkerProof: true,
      envPatch: {},
    });
    assert.equal(orchSamePath.status, 0);
    assert.ok(denyReason(orchSamePath.stdout), 'orchestrator cannot write worker tree path');

    const crossJob = runWriteHook({
      root: fx.root,
      cwd: fx.wsOne,
      absTarget: path.join(fx.wsTwo, 'cross.txt'),
      envPatch: {
        [SWARM_WORKER_RUN_ID_ENV]: fx.runId,
        [WORKER_TOKEN_ENV]: fx.proofOne,
      },
    });
    assert.equal(crossJob.status, 0);
    assert.ok(denyReason(crossJob.stdout), 'job-one cannot write job-two workspace');

    const rootCheckout = runWriteHook({
      root: fx.root,
      cwd: fx.wsOne,
      absTarget: path.join(fx.root, 'TASK.md'),
      envPatch: {
        [SWARM_WORKER_RUN_ID_ENV]: fx.runId,
        [WORKER_TOKEN_ENV]: fx.proofOne,
      },
    });
    assert.equal(rootCheckout.status, 0);
    assert.ok(denyReason(rootCheckout.stdout), 'worker cannot write project root checkout');

    const runIdSpoof = runWriteHook({
      root: fx.root,
      cwd: fx.wsOne,
      absTarget: path.join(fx.wsOne, 'spoof.txt'),
      omitWorkerProof: true,
      envPatch: { [SWARM_WORKER_RUN_ID_ENV]: fx.runId },
    });
    assert.equal(runIdSpoof.status, 0);
    const spoofDeny = denyReason(runIdSpoof.stdout);
    assert.ok(spoofDeny, 'run id env without worker proof is not exempt');
    assert.equal(spoofDeny, ORCHESTRATOR_MODE_DENY_REASON);

    await revokeWorkerToken({ root: fx.root, runId: fx.runId, jobId: fx.jobOne });
    const afterRevoke = runWriteHook({
      root: fx.root,
      cwd: fx.wsOne,
      absTarget: path.join(fx.wsOne, 'after-revoke.txt'),
      envPatch: {
        [SWARM_WORKER_RUN_ID_ENV]: fx.runId,
        [WORKER_TOKEN_ENV]: fx.proofOne,
      },
    });
    assert.equal(afterRevoke.status, 0);
    assert.ok(denyReason(afterRevoke.stdout), 'revoked worker proof is denied');
  },
);
