// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execute } from '../tools/swarm/core-41.mjs';
import { maskCommand } from '../tools/orchestrator-events.mjs';
import { maskWorkerEnvForRecord, WORKER_TOKEN_ENV } from '../tools/worker-token.mjs';

const testTmpBase = process.env.SWARM_TEST_TMP || os.tmpdir();

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

function makeChildStream() {
  const stream = new Readable({ read() {} });
  return stream;
}

function createFakeSpawn(onSpawn) {
  const captures = [];
  const children = [];
  const spawnImpl = (command, args, options) => {
    const capture = { command, args, options };
    captures.push(capture);
    const child = new EventEmitter();
    child.pid = 40000 + captures.length;
    child.stdin = { on() {}, end() {}, destroy() {} };
    child.stdout = makeChildStream();
    child.stderr = makeChildStream();
    child.kill = () => {};
    children.push(child);
    setImmediate(() => onSpawn(child, capture));
    return child;
  };
  const killImpl = (target, signal) => {
    const pid = target < 0 ? -target : target;
    const child = children.find(item => item.pid === pid);
    if (child) queueMicrotask(() => child.emit('close', signal === 'SIGKILL' ? null : 0));
  };
  return { spawnImpl, captures, killImpl };
}

function claudeStdoutLine(text = 'done') {
  return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`;
}

const baseJob = {
  agent: 'claude',
  model: 'sonnet',
  context: [],
  outputs: [],
  timeoutMs: 500,
};

test('worker token is passed only in child env, not argv', async t => {
  const { workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl, captures } = createFakeSpawn(child => {
    child.stdout.push(claudeStdoutLine('{"status":"complete","summary":"ok","files":[],"risks":[],"followups":[]}'));
    child.emit('close', 0);
  });
  const result = await execute(
    { ...baseJob, id: 'job-one' },
    workspace,
    'go',
    { spawnImpl, logDirectory },
  );
  assert.equal(result.status, 'complete');
  const envProof = captures[0].options.env[WORKER_TOKEN_ENV];
  assert.match(envProof, /^[0-9a-f]{64}$/);
  assert.ok(!captures[0].args.join(' ').includes(envProof));
  assert.ok(!result.stdout.includes(envProof));
});

test('token record exists while child runs and is revoked after normal exit', async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  let recordWhileRunning = false;
  const { spawnImpl } = createFakeSpawn(async (child, capture) => {
    recordWhileRunning = true;
    assert.match(capture.options.env[WORKER_TOKEN_ENV], /^[0-9a-f]{64}$/);
    await fs.access(tokenRecordPath(root, runId, jobId));
    child.stdout.push(claudeStdoutLine('{"status":"complete","summary":"ok","files":[],"risks":[],"followups":[]}'));
    child.emit('close', 0);
  });
  await execute({ ...baseJob, id: jobId }, workspace, 'go', { spawnImpl, logDirectory });
  assert.equal(recordWhileRunning, true);
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});

test('token revoked after failure exit', async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl } = createFakeSpawn(child => {
    child.emit('close', 1);
  });
  const result = await execute({ ...baseJob, id: jobId }, workspace, 'go', { spawnImpl, logDirectory });
  assert.equal(result.status, 'failed');
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});

test('token revoked after timeout kill', async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl, killImpl } = createFakeSpawn(() => {});
  const result = await execute({ ...baseJob, id: jobId, timeoutMs: 40 }, workspace, 'go', { spawnImpl, killImpl, logDirectory });
  assert.equal(result.status, 'timeout');
  await assert.rejects(() => fs.access(tokenRecordPath(root, runId, jobId)));
});

test('token revoked after cancelled poll', async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  let cancelled = false;
  const { spawnImpl, killImpl } = createFakeSpawn(() => {});
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

test('worker output and stored run state never contain the raw token', async t => {
  const { root, runId, jobId, workspace, logDirectory } = await makeDispatchFixture(t);
  const { spawnImpl, captures } = createFakeSpawn((child, capture) => {
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

test('two jobs receive different tokens bound to their workspaces', async t => {
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
  const { spawnImpl, killImpl } = createFakeSpawn(child => {
    child.stdout.push(claudeStdoutLine('{"status":"complete","summary":"ok","files":[],"risks":[],"followups":[]}'));
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
