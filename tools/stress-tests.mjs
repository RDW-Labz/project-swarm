// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_FILES = [
  'tests/concurrency-guard.test.mjs',
  'tests/handbuild-hook-hardening.test.mjs',
  'tests/field-lessons-batch-m2.test.mjs',
  'tests/local-lane-review.test.mjs',
  'tests/lane-health-core.test.mjs',
  'tests/lane-health-persist.test.mjs',
  'tests/server-restart-round4.test.mjs',
  'tests/cpu-runner.test.mjs',
].map(f => path.join(repoRoot, f));

const rounds = Math.max(1, parseInt(process.env.STRESS_ROUNDS ?? '5', 10) || 5);
const concurrency = Math.max(1, parseInt(process.env.STRESS_CONCURRENCY ?? '8', 10) || 8);
const timeoutMs = Math.max(1, parseInt(process.env.STRESS_TIMEOUT_MS ?? String(15 * 60 * 1000), 10) || 15 * 60 * 1000);

const MAX_BUFFER = 64 * 1024 * 1024;

/** @type {import('node:child_process').ChildProcess | null} */
let activeRoundChild = null;
let activeRoundIndex = 0;
let runnerInterrupted = false;

function roundChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) delete env[key];
  }
  return env;
}

function roundSpawnSpec() {
  const override = process.env.STRESS_TEST_COMMAND;
  if (override !== undefined) {
    try {
      const argv = JSON.parse(override);
      if (!Array.isArray(argv) || argv.length === 0
        || !argv.every(arg => typeof arg === 'string') || argv[0].trim() === '') {
        throw new Error('invalid command');
      }
      return { command: argv[0], args: argv.slice(1) };
    } catch {
      console.error('test:stress: STRESS_TEST_COMMAND must be a non-empty JSON array of strings');
      process.exit(2);
    }
  }
  return {
    command: process.execPath,
    args: [
      '--import',
      path.join(repoRoot, 'tests/_isolate-config.mjs'),
      '--test',
      '--test-timeout=600000',
      `--test-concurrency=${concurrency}`,
      ...TEST_FILES,
    ],
  };
}

function killRoundProcessGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

function onRunnerSignal(signal) {
  if (runnerInterrupted) return;
  runnerInterrupted = true;
  const exitCode = signal === 'SIGINT' ? 130 : 143;
  if (!activeRoundChild) {
    process.exit(exitCode);
  }
  const child = activeRoundChild;
  console.log(`stress round ${activeRoundIndex}/${rounds}: interrupted by ${signal}; killed the round process group`);
  // Keep the fallback alive only until the child is reaped or two seconds pass.
  const timer = setTimeout(() => process.exit(exitCode), 2_000);
  child.once('exit', () => {
    clearTimeout(timer);
    process.exit(exitCode);
  });
  killRoundProcessGroup(child);
}

process.on('SIGINT', () => onRunnerSignal('SIGINT'));
process.on('SIGTERM', () => onRunnerSignal('SIGTERM'));

function tailLines(text, max = 200) {
  const lines = String(text ?? '').split('\n');
  if (lines.length <= max) return lines.join('\n');
  return lines.slice(-max).join('\n');
}

function runRound(roundIndex) {
  return new Promise(resolve => {
    const { command, args } = roundSpawnSpec();
    const child = spawn(
      command,
      args,
      { cwd: repoRoot, env: roundChildEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    activeRoundChild = child;
    activeRoundIndex = roundIndex;

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    const appendBounded = (prev, chunk) => {
      const next = Buffer.concat([prev, chunk]);
      if (next.length <= MAX_BUFFER) return next;
      return next.subarray(next.length - MAX_BUFFER);
    };
    child.stdout.on('data', chunk => { stdoutBuf = appendBounded(stdoutBuf, chunk); });
    child.stderr.on('data', chunk => { stderrBuf = appendBounded(stderrBuf, chunk); });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeRoundChild === child) activeRoundChild = null;
      // Signal shutdown owns the exit; do not report failure or start another round.
      if (!runnerInterrupted) resolve(result);
    };

    const timer = setTimeout(() => {
      killRoundProcessGroup(child);
      finish({ ok: false, timedOut: true, stdout: stdoutBuf.toString('utf8'), stderr: stderrBuf.toString('utf8'), ms: timeoutMs });
    }, timeoutMs);
    timer.unref?.();

    child.on('error', error => finish({ ok: false, timedOut: false, stdout: stdoutBuf.toString('utf8'), stderr: stderrBuf.toString('utf8'), error, ms: null }));
    child.on('exit', (code, signal) => {
      finish({ ok: code === 0, timedOut: false, stdout: stdoutBuf.toString('utf8'), stderr: stderrBuf.toString('utf8'), code, signal, ms: null });
    });
  });
}

for (let i = 1; i <= rounds; i++) {
  const start = Date.now();
  const result = await runRound(i);
  const ms = result.ms ?? Date.now() - start;
  if (result.timedOut) {
    console.log(`stress round ${i}/${rounds}: FAIL (timed out after ${ms}ms)`);
    if (result.stdout) {
      console.error('--- stdout (tail) ---');
      console.error(tailLines(result.stdout));
    }
    if (result.stderr) {
      console.error('--- stderr (tail) ---');
      console.error(tailLines(result.stderr));
    }
    process.exit(1);
  }
  const ok = result.ok;
  console.log(`stress round ${i}/${rounds} (concurrency ${concurrency}): ${ok ? 'pass' : 'fail'} (${ms} ms)`);
  if (!ok) {
    if (result.stdout) {
      console.error('--- stdout (tail) ---');
      console.error(tailLines(result.stdout));
    }
    if (result.stderr) {
      console.error('--- stderr (tail) ---');
      console.error(tailLines(result.stderr));
    }
    if (result.error) console.error(result.error);
    process.exit(1);
  }
}

console.log(`test:stress: ${rounds} rounds passed`);
