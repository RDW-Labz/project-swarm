// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stressScript = path.join(repoRoot, 'tools/stress-tests.mjs');

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

function hangCommand(pidFile) {
  return JSON.stringify([
    process.execPath,
    '-e',
    `import fs from 'node:fs'; console.log(process.pid); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`,
  ]);
}

async function runInterruptCase(signal, expectedExitCode) {
  const pidFile = path.join(os.tmpdir(), `stress-interrupt-${process.pid}-${Date.now()}.pid`);
  const runner = spawn(process.execPath, [stressScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STRESS_ROUNDS: '1',
      STRESS_TEST_COMMAND: hangCommand(pidFile),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let combined = '';
  runner.stdout.setEncoding('utf8');
  runner.stderr.setEncoding('utf8');
  runner.stdout.on('data', chunk => { combined += chunk; });
  runner.stderr.on('data', chunk => { combined += chunk; });

  const deadline = Date.now() + 10_000;
  let roundPid;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      roundPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(roundPid)) break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(roundPid, 'expected fake round pid file before interrupt');

  runner.kill(signal);

  const [exitCode] = await once(runner, 'exit');
  assert.equal(exitCode, expectedExitCode, `runner exit for ${signal}`);
  assert.match(
    combined,
    new RegExp(`stress round 1/1: interrupted by ${signal}; killed the round process group`),
  );

  await new Promise(r => setTimeout(r, 200));
  assert.equal(processAlive(roundPid), false, 'fake round pid should be dead');
  assert.equal(processGroupAlive(roundPid), false, 'fake round process group should be dead');

  try { fs.unlinkSync(pidFile); } catch { /* ok */ }
}

test('stress-tests.mjs stops the round on SIGINT with exit 130', { timeout: 30_000 }, async () => {
  await runInterruptCase('SIGINT', 130);
});

test('stress-tests.mjs stops the round on SIGTERM with exit 143', { timeout: 30_000 }, async () => {
  await runInterruptCase('SIGTERM', 143);
});

test('STRESS_ROUNDS=1 STRESS_CONCURRENCY=4 test:stress still passes', { timeout: 600_000 }, async () => {
  const env = { ...process.env, STRESS_ROUNDS: '1', STRESS_CONCURRENCY: '4' };
  delete env.STRESS_TEST_COMMAND;
  const child = spawn(process.execPath, [stressScript], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { out += c; });

  const [code] = await once(child, 'exit');
  assert.equal(code, 0, out);
  assert.match(out, /test:stress: 1 rounds passed/);
});
