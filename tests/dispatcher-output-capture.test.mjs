// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute } from '../tools/swarm/core-41.mjs';

const testTmpBase = process.env.SWARM_TEST_TMP || os.tmpdir();
const TEST_TIMEOUT_MS = 60_000;
const LARGE_BYTES = 300 * 1024;
const LAST_LINE = '__SWARM_DISPATCH_CAPTURE_LAST__';

function claudeResultLine(text) {
  return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`;
}

function extraCliStdout(agent, envelopeJson) {
  const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'observed-model' });
  const result =
    agent === 'hermes'
      ? JSON.stringify({ type: 'result', exit_code: 0, text: envelopeJson, tokens: { input: 1, output: 1 } })
      : JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: envelopeJson,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
  return `${init}\n${result}\n`;
}

const envelopeValue = {
  summary: 'Generated from supplied text only.',
  files: [{ path: 'report.md', content: 'Reviewed.' }],
};

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(testTmpBase, 'dispatch-capture-'));
  const runId = 'run-capture';
  const jobId = 'job-cap';
  const workspace = path.join(root, '.swarm', 'workspaces', runId, jobId);
  const logDirectory = path.join(root, '.swarm', 'runs', runId, jobId);
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(logDirectory, { recursive: true });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, runId, jobId, workspace, logDirectory };
}

function jobForAgent(agent, overrides = {}) {
  return {
    id: 'job-cap',
    agent,
    model: 'sonnet',
    context: [],
    outputs: agent === 'claude' ? [] : ['report.md'],
    timeoutMs: TEST_TIMEOUT_MS,
    ...overrides,
  };
}

function createRealSpawn(t, runChild) {
  const owned = [];
  const spawnImpl = (command, args, options) => {
    const childArgv = runChild({ command, args, options });
    const child = spawn(process.execPath, childArgv, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: options.detached,
      stdio: options.stdio,
    });
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
  return { spawnImpl };
}

function assertPlainAgentPath(agent, capture) {
  if (agent === 'claude') {
    assert.equal(capture.command, 'claude');
  } else {
    assert.equal(capture.command, agent);
  }
}

function jobStateSlice(result) {
  return {
    status: result.status,
    exitCode: result.exitCode,
    outputComplete: result.outputComplete,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

const largeStdoutChild = `
const target = ${LARGE_BYTES};
const last = ${JSON.stringify(LAST_LINE)};
const chunk = Buffer.alloc(4096, 97);
let written = 0;
function pump() {
  while (written < target) {
    const remain = target - written;
    const slice = remain >= chunk.length ? chunk : chunk.subarray(0, remain);
    if (!process.stdout.write(slice)) {
      written += slice.length;
      process.stdout.once('drain', pump);
      return;
    }
    written += slice.length;
  }
  process.stdout.write(last + '\\n', () => process.exit(0));
}
pump();
`;

const delayedStdoutAfterExitChild = `
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const payload = process.argv[1];
  require('child_process')
    .spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 35)', payload], {
      stdio: 'inherit',
      detached: true,
    })
    .unref();
  process.exit(0);
});
`;

const stderrExitChild = `
const marker = process.argv[1];
process.stderr.write(marker + '\\n');
process.exit(3);
`;

const timeoutPartialChild = `
require('node:fs').writeSync(1, 'partial-before-timeout\\n');
setInterval(() => {}, 500);
`;

for (const agent of ['claude', 'hermes', 'qwen']) {
  test(`${agent}: captures ~300 KiB chunked stdout and exit code 0`, { timeout: TEST_TIMEOUT_MS }, async t => {
    const { workspace, logDirectory } = await makeFixture(t);
    let capture;
    const { spawnImpl } = createRealSpawn(t, meta => {
      capture = meta;
      return ['-e', largeStdoutChild];
    });
    const result = await execute(jobForAgent(agent), workspace, 'go', { spawnImpl, logDirectory });
    assertPlainAgentPath(agent, capture);
    const expectedLen = LARGE_BYTES + LAST_LINE.length + 1;
    assert.equal(Buffer.byteLength(result.stdout, 'utf8'), expectedLen);
    assert.ok(result.stdout.endsWith(`${LAST_LINE}\n`));
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputComplete, true);
    const stored = jobStateSlice(result);
    assert.equal(stored.exitCode, 0);
    assert.equal(stored.outputComplete, true);
  });

  test(`${agent}: parses result when stdout finishes after exit`, { timeout: TEST_TIMEOUT_MS }, async t => {
    const { workspace, logDirectory } = await makeFixture(t);
    const envelopeJson = JSON.stringify(envelopeValue);
    const stdoutPayload =
      agent === 'claude' ? claudeResultLine(envelopeJson) : extraCliStdout(agent, envelopeJson);
    const { spawnImpl } = createRealSpawn(t, () => ['-e', delayedStdoutAfterExitChild, stdoutPayload]);
    const result = await execute(jobForAgent(agent), workspace, 'go', { spawnImpl, logDirectory });
    assert.equal(result.status, 'complete');
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputComplete, true);
    assert.ok(result.stdout.includes('"type":"result"') || result.stdout.includes('"type": "result"'));
    const stored = jobStateSlice(result);
    assert.equal(stored.exitCode, 0);
    assert.equal(stored.outputComplete, true);
  });

  test(`${agent}: records exit code 3 and stderr in error`, { timeout: TEST_TIMEOUT_MS }, async t => {
    const { workspace, logDirectory } = await makeFixture(t);
    const markerParts = ['stderr', '-', 'marker', '-', 'dispatch'];
    const marker = `${markerParts.join('')}-${Date.now()}`;
    const { spawnImpl } = createRealSpawn(t, () => ['-e', stderrExitChild, marker]);
    const result = await execute(jobForAgent(agent), workspace, 'go', { spawnImpl, logDirectory });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 3);
    assert.equal(result.outputComplete, true);
    assert.ok(String(result.error).includes(marker) || result.stderr.includes(marker));
    assert.equal(jobStateSlice(result).exitCode, 3);
  });

  test(`${agent}: timeout keeps partial stdout`, { timeout: TEST_TIMEOUT_MS }, async t => {
    const { workspace, logDirectory } = await makeFixture(t);
    const { spawnImpl } = createRealSpawn(t, () => ['-e', timeoutPartialChild]);
    const result = await execute(jobForAgent(agent, { timeoutMs: 200 }), workspace, 'go', { spawnImpl, logDirectory });
    assert.equal(result.status, 'timeout');
    assert.ok(result.stdout.includes('partial-before-timeout'));
    assert.equal(result.outputComplete, true);
    const stored = jobStateSlice(result);
    assert.ok(stored.stdout.includes('partial-before-timeout'));
  });
}
