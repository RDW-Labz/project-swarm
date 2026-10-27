// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { accessSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execute } from '../tools/swarm/core-41.mjs';
import { maskCommand } from '../tools/orchestrator-events.mjs';
import { maskWorkerEnvForRecord, SWARM_WORKER_RUN_ID_ENV, WORKER_TOKEN_ENV } from '../tools/worker-token.mjs';

const testTmpBase = process.env.SWARM_TEST_TMP || os.tmpdir();
const TEST_TIMEOUT_MS = 60_000;

function tokenRecordPath(root, runId, jobId) {
  return path.join(root, '.swarm', 'runs', runId, 'worker-tokens', `${jobId}.json`);
}

async function makeDispatchFixture(t, { runId = 'run-dispatch', jobId = 'job-one' } = {}) {
  const root = await fs.mkdtemp(path.join(testTmpBase, 'worker-dispatch-root-'));
  const workspace = path.join(root, '.swarm', 'workspaces', runId, jobId);
  const logDirectory = path.join(root, '.swarm', 'runs', runId, jobId);
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(logDirectory, { recursive: true });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, runId, jobId, workspace, logDirectory };
}

async function writeSandboxProfile(root, name = 'lane.sb') {
  const profile = path.join(root, name);
  await fs.writeFile(profile, '(version 1)\n(allow default)\n');
  return profile;
}

function makeChildStream() {
  return new Readable({ read() {} });
}

function createFakeSpawn(t, onSpawn) {
  const captures = [];
  const children = [];
  const spawnImpl = (command, args, options) => {
    const capture = { command, args, options };
    captures.push(capture);
    const child = new EventEmitter();
    child.pid = 40_000 + captures.length;
    child.stdin = { on() {}, end() {}, destroy() {} };
    child.stdout = makeChildStream();
    child.stderr = makeChildStream();
    child.kill = (signal = 'SIGTERM') => {
      queueMicrotask(() => child.emit('close', signal === 'SIGKILL' ? null : 0));
    };
    children.push(child);
    setImmediate(() => onSpawn(child, capture));
    return child;
  };
  const killImpl = (target, signal) => {
    const pid = target < 0 ? -target : target;
    const child = children.find(item => item.pid === pid);
    if (child) queueMicrotask(() => child.emit('close', signal === 'SIGKILL' ? null : 0));
  };
  t.after(() => {
    for (const child of children) {
      if (!child.stdout.destroyed) child.stdout.destroy();
      if (!child.stderr.destroyed) child.stderr.destroy();
      child.emit('close', null);
    }
  });
  return { spawnImpl, captures, killImpl, children };
}

function assertTokenEnvOnly(capture) {
  const envProof = capture.options.env[WORKER_TOKEN_ENV];
  assert.match(envProof, /^[0-9a-f]{64}$/);
  const joined = capture.args.join(' ');
  assert.ok(!joined.includes(envProof));
  assert.ok(!joined.includes(WORKER_TOKEN_ENV));
  return envProof;
}

function claudeStdoutLine(text = 'done') {
  return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`;
}

function completeEnvelopeLine() {
  return claudeStdoutLine('{"status":"complete","summary":"ok","files":[],"risks":[],"followups":[]}');
}

const baseJob = {
  agent: 'claude',
  model: 'sonnet',
  context: [],
  outputs: [],
  timeoutMs: 500,
};

test('worker token is passed only in child env, not argv', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl, captures } = createFakeSpawn(t, child => {
    child.stdout.push(completeEnvelopeLine());
    child.emit('close', 0);
  });
  const result = await execute(
    { ...baseJob, id: 'job-one' },
    workspace,
    'go',
    { spawnImpl, logDirectory },
  );
  assert.equal(result.status, 'complete');
  assertTokenEnvOnly(captures[0]);
  assert.ok(!result.stdout.includes(captures[0].options.env[WORKER_TOKEN_ENV]));
});

test('token record exists while child runs and is revoked after normal exit', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  let recordWhileRunning = false;
  const { spawnImpl } = createFakeSpawn(t, (child, capture) => {
    recordWhileRunning = true;
    assert.match(capture.options.env[WORKER_TOKEN_ENV], /^[0-9a-f]{64}$/);
    accessSync(tokenRecordPath(root, runId, jobId));
    child.stdout.push(completeEnvelopeLine());
    child.emit('close', 0);
  });
  await execute({ ...baseJob, id: jobId }, workspace, 'go', { spawnImpl, logDirectory });
  assert.equal(recordWhileRunning, true);
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});

test('token revoked after failure exit', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl } = createFakeSpawn(t, child => {
    child.emit('close', 1);
  });
  const result = await execute({ ...baseJob, id: jobId }, workspace, 'go', { spawnImpl, logDirectory });
  assert.equal(result.status, 'failed');
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});

test('token revoked after timeout kill without injectable killImpl', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  const owned = [];
  const spawnImpl = (_command, _args, options) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
    owned.push(child);
    return child;
  };
  t.after(() => {
    for (const child of owned) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }
  });
  const result = await execute(
    { ...baseJob, id: jobId, timeoutMs: 40 },
    workspace,
    'go',
    { spawnImpl, logDirectory },
  );
  assert.equal(result.status, 'timeout');
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});

test('token revoked after cancelled poll', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  let cancelled = false;
  const { spawnImpl, killImpl } = createFakeSpawn(t, () => {});
  setTimeout(() => { cancelled = true; }, 20);
  const result = await execute(
    { ...baseJob, id: jobId, timeoutMs: 5000 },
    workspace,
    'go',
    { spawnImpl, killImpl, logDirectory, cancelled: async () => cancelled },
  );
  assert.equal(result.status, 'cancelled');
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});

test('worker output and stored run state never contain the raw token', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl, captures } = createFakeSpawn(t, (child, capture) => {
    const leak = capture.options.env[WORKER_TOKEN_ENV];
    child.stdout.push(claudeStdoutLine(leak));
    child.stderr.push(`${leak}\n`);
    child.emit('close', 0);
  });
  const result = await execute({ ...baseJob, id: jobId }, workspace, 'go', { spawnImpl, logDirectory });
  const proof = captures[0].options.env[WORKER_TOKEN_ENV];
  assert.ok(!result.stdout.includes(proof));
  assert.ok(!result.stderr.includes(proof));
  assert.ok(!result.response.includes(proof));
  const state = {
    id: runId,
    jobs: [{ id: jobId, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error }],
  };
  const stateText = JSON.stringify(state);
  assert.ok(!stateText.includes(proof));
  if (result.stdout.includes('redacted') || result.stderr.includes('redacted')) {
    assert.ok(stateText.includes('redacted'));
  }
  const maskedCmd = maskCommand(`${WORKER_TOKEN_ENV}=${proof} npm test`);
  assert.ok(!maskedCmd.includes(proof));
  const maskedEnv = maskWorkerEnvForRecord({ [WORKER_TOKEN_ENV]: proof, PATH: '/bin' });
  assert.equal(maskedEnv[WORKER_TOKEN_ENV], '[value]');
  await fs.writeFile(path.join(logDirectory, 'dispatch.log'), `${result.stdout}\n${result.stderr}\n`, 'utf8');
  const logText = await fs.readFile(path.join(logDirectory, 'dispatch.log'), 'utf8');
  assert.ok(!logText.includes(proof));
  assert.ok(logText.includes('redacted'));
});

test('two jobs receive different tokens bound to their workspaces', { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = await fs.mkdtemp(path.join(testTmpBase, 'worker-dispatch-two-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const runId = 'run-two';
  const jobA = 'job-a';
  const jobB = 'job-b';
  const workspaceA = path.join(root, '.swarm', 'workspaces', runId, jobA);
  const workspaceB = path.join(root, '.swarm', 'workspaces', runId, jobB);
  const logA = path.join(root, '.swarm', 'runs', runId, jobA);
  const logB = path.join(root, '.swarm', 'runs', runId, jobB);
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });
  await fs.mkdir(logA, { recursive: true });
  await fs.mkdir(logB, { recursive: true });

  const proofs = [];
  const { spawnImpl, killImpl } = createFakeSpawn(t, child => {
    child.stdout.push(completeEnvelopeLine());
    child.emit('close', 0);
  });
  const wrappedSpawn = (command, args, options) => {
    const child = spawnImpl(command, args, options);
    proofs.push(options.env[WORKER_TOKEN_ENV]);
    return child;
  };

  await execute({ ...baseJob, id: jobA }, workspaceA, 'a', { spawnImpl: wrappedSpawn, killImpl, logDirectory: logA });
  await execute({ ...baseJob, id: jobB }, workspaceB, 'b', { spawnImpl: wrappedSpawn, killImpl, logDirectory: logB });

  assert.equal(proofs.length, 2);
  assert.notEqual(proofs[0], proofs[1]);
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobA)));
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobB)));
});

test('claude sandbox shell lane receives token in env only', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { root, workspace, logDirectory } = await makeDispatchFixture(t);
  const profile = await writeSandboxProfile(root);
  const { spawnImpl, captures } = createFakeSpawn(t, child => {
    child.stdout.push(completeEnvelopeLine());
    child.emit('close', 0);
  });
  const result = await execute(
    { ...baseJob, id: 'job-one' },
    workspace,
    'go',
    {
      spawnImpl,
      logDirectory,
      claudeShell: { profile, bin: 'claude', env: { PATH: '/usr/bin' } },
    },
  );
  assert.equal(result.status, 'complete');
  assert.equal(captures[0].command, 'sandbox-exec');
  assertTokenEnvOnly(captures[0]);
  assert.match(captures[0].options.env[SWARM_WORKER_RUN_ID_ENV], /^run-dispatch$/);
});

test('codex lane receives token in env only', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { workspace, logDirectory, root } = await makeDispatchFixture(t);
  const profile = await writeSandboxProfile(root);
  const lastMessage = path.join(workspace, '.swarm', 'codex-out.json');
  await fs.mkdir(path.dirname(lastMessage), { recursive: true });
  const { spawnImpl, captures } = createFakeSpawn(t, child => {
    child.emit('close', 1);
  });
  await execute(
    { id: 'job-one', agent: 'codex', model: 'o3', context: [], outputs: [], timeoutMs: 500 },
    workspace,
    'go',
    {
      spawnImpl,
      logDirectory,
      codex: { profile, worktree: workspace, lastMessage, env: { PATH: '/usr/bin' } },
    },
  );
  assert.equal(captures[0].command, 'sandbox-exec');
  assertTokenEnvOnly(captures[0]);
});

test('cursor lane receives token in env only', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { workspace, logDirectory, root } = await makeDispatchFixture(t);
  const profile = await writeSandboxProfile(root);
  const bin = path.join(root, 'cursor-agent-stub');
  await fs.writeFile(bin, '#!/bin/sh\n');
  const { spawnImpl, captures } = createFakeSpawn(t, child => {
    child.emit('close', 1);
  });
  await execute(
    { id: 'job-one', agent: 'cursor', model: 'gpt-5', context: [], outputs: ['docs/x.md'], timeoutMs: 500 },
    workspace,
    'go',
    {
      spawnImpl,
      logDirectory,
      cursor: { profile, bin, worktree: workspace, env: { PATH: '/usr/bin', HOME: process.env.HOME } },
    },
  );
  assert.equal(captures[0].command, 'sandbox-exec');
  assertTokenEnvOnly(captures[0]);
});

test('extra cli agent lane receives token in env only', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl, captures } = createFakeSpawn(t, child => {
    child.emit('close', 1);
  });
  await execute(
    { id: 'job-one', agent: 'hermes', model: 'sonnet', context: [], outputs: [], timeoutMs: 500 },
    workspace,
    'go',
    { spawnImpl, logDirectory },
  );
  assert.equal(captures[0].command, 'hermes');
  assertTokenEnvOnly(captures[0]);
});

test('ssh cli host spawn omits worker token from argv and env', { timeout: TEST_TIMEOUT_MS }, async t => {
  const configPath = process.env.SWARM_CONFIG;
  const priorConfig = await fs.readFile(configPath, 'utf8');
  const decoyParts = ['dec', 'oy', '-', 'ssh', '-', 'token'];
  const decoy = decoyParts.join('').repeat(4).slice(0, 64);
  t.after(async () => {
    await fs.writeFile(configPath, priorConfig, 'utf8');
    delete process.env[WORKER_TOKEN_ENV];
    delete process.env[SWARM_WORKER_RUN_ID_ENV];
  });

  const config = JSON.parse(priorConfig);
  config.cliHosts = {
    hermes: { target: 'worker@example.test', command: '/usr/local/bin/hermes' },
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  process.env[WORKER_TOKEN_ENV] = decoy;
  process.env[SWARM_WORKER_RUN_ID_ENV] = 'run-evil';

  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl, captures } = createFakeSpawn(t, child => {
    child.emit('close', 1);
  });
  await execute(
    { id: jobId, agent: 'hermes', model: 'sonnet', context: [], outputs: [], timeoutMs: 500 },
    workspace,
    'go',
    { spawnImpl, logDirectory },
  );
  assert.equal(captures[0].command, 'ssh');
  const joined = captures[0].args.join(' ');
  assert.ok(!joined.includes(decoy));
  assert.ok(!joined.includes(WORKER_TOKEN_ENV));
  assert.equal(captures[0].options.env[WORKER_TOKEN_ENV], undefined);
  assert.equal(captures[0].options.env[SWARM_WORKER_RUN_ID_ENV], undefined);
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});

/** Real CLI children set exitCode on `exit`; stopChild then reaps before `close` drains stdout. */
function killImplProcessAlreadyExited() {
  return (_target, _signal) => {
    const error = new Error('ESRCH');
    error.code = 'ESRCH';
    throw error;
  };
}

function finishChildAfterExit(child, { stdout = '', exitCode = 0 } = {}) {
  if (stdout) child.stdout.push(stdout);
  child.exitCode = exitCode;
  child.emit('exit', exitCode);
  // Delay close so a buggy early finishAndRevoke(null) settles before the real exit code arrives.
  setTimeout(() => child.emit('close', exitCode), 25);
}

const cliEnvelopeValue = {
  summary: 'Generated from supplied text only.',
  files: [{ path: 'report.md', content: 'Reviewed.' }],
};

function extraCliStdoutLine(agent) {
  const payload = JSON.stringify(cliEnvelopeValue);
  const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'observed-model' });
  const result =
    agent === 'hermes'
      ? JSON.stringify({ type: 'result', exit_code: 0, text: payload, tokens: { input: 1, output: 1 } })
      : JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: payload,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
  return `${init}\n${result}\n`;
}

for (const agent of ['claude', 'hermes', 'qwen']) {
  test(`${agent} exit-before-close success keeps exit code 0 and revokes token`, { timeout: TEST_TIMEOUT_MS }, async t => {
    const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
    const job = {
      ...baseJob,
      id: jobId,
      agent,
      model: 'sonnet',
      outputs: agent === 'claude' ? [] : ['report.md'],
      timeoutMs: 30_000,
    };
    const stdout = agent === 'claude' ? completeEnvelopeLine() : extraCliStdoutLine(agent);
    const { spawnImpl, killImpl } = createFakeSpawn(t, child => {
      finishChildAfterExit(child, { stdout, exitCode: 0 });
    });
    const result = await execute(job, workspace, 'go', {
      spawnImpl,
      killImpl: killImplProcessAlreadyExited(),
      logDirectory,
    });
    assert.equal(result.status, 'complete');
    assert.equal(result.exitCode, 0);
    await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
  });
}

test('failing child exit code 3 is preserved when exit precedes close', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl, killImpl } = createFakeSpawn(t, child => {
    finishChildAfterExit(child, { exitCode: 3 });
  });
  const result = await execute(
    { ...baseJob, id: jobId },
    workspace,
    'go',
    { spawnImpl, killImpl: killImplProcessAlreadyExited(), logDirectory },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});

test('timeout still ends as timeout when exit-before-close would otherwise race', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl, killImpl } = createFakeSpawn(t, () => {});
  const result = await execute(
    { ...baseJob, id: jobId, timeoutMs: 40 },
    workspace,
    'go',
    { spawnImpl, killImpl, logDirectory },
  );
  assert.equal(result.status, 'timeout');
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});
