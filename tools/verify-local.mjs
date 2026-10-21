// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { sanitizeText } from './journal.mjs';
import { redactText } from './lesson-schema.mjs';

const TAIL_BYTES = 4000;
const DEFAULT_TIMEOUT_MS = 600_000;

function tailOf(combined) {
  const slice = combined.slice(-TAIL_BYTES);
  return redactText(sanitizeText(slice));
}

function normalizeScratch(integrated) {
  if (typeof integrated === 'string') {
    return { worktree: integrated, cleanup: undefined, command: undefined, timeoutMs: undefined };
  }
  if (integrated && typeof integrated === 'object') {
    const worktree = integrated.worktree ?? integrated.path;
    return {
      worktree,
      cleanup: integrated.cleanup,
      command: integrated.command,
      timeoutMs: integrated.timeoutMs,
    };
  }
  return { worktree: undefined, cleanup: undefined, command: undefined, timeoutMs: undefined };
}

export async function runLocalVerify({
  worktree,
  command,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  now = Date.now,
  env = process.env,
} = {}) {
  const startedAt = now();
  let combined = '';
  let exitCode = null;
  let child;

  const done = (status, extra = {}) => ({
    status,
    exitCode,
    durationMs: now() - startedAt,
    tail: tailOf(combined),
    ...extra,
  });

  try {
    child = spawnImpl(command[0], command.slice(1), {
      cwd: worktree,
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return done('error', { exitCode: null, reason: String(err?.message ?? err) });
  }

  if (!child || typeof child.on !== 'function') {
    return done('error', { exitCode: null, reason: 'spawn did not return a child process' });
  }

  const append = (chunk) => {
    combined += chunk.toString();
    if (combined.length > TAIL_BYTES * 4) combined = combined.slice(-TAIL_BYTES * 4);
  };

  child.stdout?.on?.('data', append);
  child.stderr?.on?.('data', append);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill?.('SIGKILL');
  }, timeoutMs);

  const exitPromise = new Promise((resolve) => {
    child.on('error', (err) => {
      append(String(err?.message ?? err));
      resolve({ kind: 'error' });
    });
    child.on('exit', (code) => resolve({ kind: 'exit', code }));
  });

  const outcome = await exitPromise;
  clearTimeout(timer);

  if (outcome.kind === 'error' || (child.exitCode == null && outcome.kind !== 'exit')) {
    return done('error', { exitCode: null });
  }

  exitCode = outcome.code ?? child.exitCode ?? null;

  if (timedOut) {
    return done('error', { exitCode });
  }

  if (exitCode === 0) {
    return done('pass', { exitCode: 0 });
  }

  return done('fail', { exitCode });
}

export async function prepareScratchVerify({
  root: _root,
  outputs,
  integrateIntoScratch,
  runLocal = runLocalVerify,
} = {}) {
  const integrated = await integrateIntoScratch(outputs);
  const { worktree, cleanup, command, timeoutMs } = normalizeScratch(integrated);

  try {
    const result = await runLocal({
      worktree,
      command,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return {
      verify: {
        status: result.status,
        mode: 'local',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        tail: result.tail,
      },
    };
  } finally {
    if (typeof cleanup === 'function') {
      await cleanup();
    }
  }
}
