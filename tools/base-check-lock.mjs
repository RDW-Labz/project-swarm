// SPDX-License-Identifier: Apache-2.0
// One base-check run at a time per git checkout (worktree root). Parallel `run` base gates in the
// same tree queue here instead of racing spawns and `.swarm/base-checks/` cache writes.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { git } from './codex-adapter.mjs';
import { TEST_FILE_RE } from './ship.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';
import { recordBaseCheckFailure, failureLocationsForFailures } from './base-check-failure-report.mjs';

const LOCK_FILE = 'base-check.lock';
const STALE_MS = 60000;

/** Lock file path relative to the checkout root (under `.swarm/project/`). */
export const BASE_CHECK_LOCK_REL = '.swarm/project/base-check.lock';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const INTEGRATE_ONLY_PLACEHOLDER_RE = /^\{(?:integrated|new)(?::[^}]+)?\}$/;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function expandRootArgv(argv, root) {
  return argv.map(item => item.split('{root}').join(root));
}

function baseCheckSkipReason(check) {
  if (check.base === false) return 'base: false';
  const placeholder = check.argv.find(arg => INTEGRATE_ONLY_PLACEHOLDER_RE.test(arg));
  return placeholder ? `integrate-only placeholder ${placeholder}` : null;
}

function namedTestPaths(argv) {
  return [...new Set((argv ?? []).filter(token => typeof token === 'string' && !token.startsWith('-')).map(token => token.replace(/^\{root\}\//, '').replace(/^\.\//, '')).filter(token => TEST_FILE_RE.test(token)))];
}

async function fileMissing(root, rel) {
  try {
    await fs.access(path.join(root, rel));
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function pendingBaseCheck(root, check, outputFiles) {
  const paths = namedTestPaths(check.argv);
  if (!paths.length) return null;
  const missingOutputs = [];
  for (const file of paths) {
    if (outputFiles.has(file) && await fileMissing(root, file)) missingOutputs.push(file);
  }
  return missingOutputs.length === paths.length ? { name: check.name, paths } : null;
}

async function readCacheRecord(root, cacheRel) {
  try {
    const bytes = await fs.readFile(path.join(root, cacheRel), 'utf8');
    try { return JSON.parse(bytes); } catch { return null; }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeCacheRecord(root, cacheRel, record) {
  const target = path.join(root, cacheRel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readOwner(file) {
  try {
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    if (owner && typeof owner === 'object' && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.host === 'string') return owner;
  } catch { /* unreadable or missing */ }
  return null;
}

async function tryTakeLock(file, { pid, startedAt }) {
  await assertRegularOrMissing(file);
  try {
    const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ pid, host: os.hostname(), startedAt })}\n`);
    } finally {
      await handle.close();
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        const owner = await readOwner(file);
        if (owner?.pid === pid && owner.host === os.hostname()) await fs.rm(file, { force: true });
      } catch { /* already gone */ }
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return null;
  }
}

function lockBusyError(owner) {
  const pid = owner?.pid ?? 'unknown';
  const started = owner?.startedAt ?? 'unknown';
  return Object.assign(new Error(`base-check-locked: another base check is running in this checkout (pid ${pid}, started ${started})`), { code: 'base-check-locked' });
}

export async function acquireBaseCheckLock(root, { pid = process.pid, isAlive = pidAlive, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), waitMs = null } = {}) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, LOCK_FILE);
  const started = now();
  for (;;) {
    const release = await tryTakeLock(file, { pid, startedAt: new Date(now()).toISOString() });
    if (release) return release;
    const owner = await readOwner(file);
    const stat = await fs.stat(file).catch(() => null);
    const stale = !owner
      || (owner.host === os.hostname() && !isAlive(owner.pid))
      || (stat && now() - stat.mtimeMs > STALE_MS);
    if (stale) {
      await fs.rm(file, { force: true });
      continue;
    }
    if (waitMs !== null && now() - started > waitMs) throw lockBusyError(owner);
    await sleep(Math.min(250, 40 + Math.floor((now() - started) / 80)));
  }
}

export async function withBaseCheckLock(root, fn, options) {
  const release = await acquireBaseCheckLock(root, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function runBaseChecks(root, manifest, { spawnImpl = spawn, gitImpl, baseSha: baseShaOverride, env = process.env } = {}) {
  const checks = manifest.checks ?? [];
  if (!checks.length) return { baseSha: null, status: 'green', failures: [] };
  const baseSha = baseShaOverride ?? (await (gitImpl ?? git)(root, ['rev-parse', 'HEAD'])).trim();
  const cacheRel = `.swarm/base-checks/${baseSha}.json`;
  const checksKey = digest(JSON.stringify(checks.map(check => [check.name, check.argv, check.base ?? true])));
  const cached = await readCacheRecord(root, cacheRel);
  if (cached?.checksKey === checksKey) return cached;

  const { runCheck } = await import('./swarm.mjs');
  return withBaseCheckLock(root, async () => {
    const cachedInside = await readCacheRecord(root, cacheRel);
    if (cachedInside?.checksKey === checksKey) return cachedInside;

    let failures = [];
    const skipped = [];
    const outputFiles = new Set(manifest.jobs.flatMap(job => job.outputs ?? []));
    const pending = [];
    for (const check of checks) {
      const skipReason = baseCheckSkipReason(check);
      if (skipReason) { skipped.push({ name: check.name, reason: skipReason }); continue; }
      const pendingCheck = await pendingBaseCheck(root, check, outputFiles);
      if (pendingCheck) { pending.push(pendingCheck); continue; }
      const outcome = await runCheck(check.name, expandRootArgv(check.argv, root), root, check.timeoutMs ?? 300000, spawnImpl, false, () => {}, env);
      if (outcome.status !== 'passed') failures = recordBaseCheckFailure(failures, outcome);
    }
    const failureLocations = failureLocationsForFailures(failures);
    const record = {
      baseSha,
      checksKey,
      status: failures.length ? 'red' : pending.length ? 'pending' : 'green',
      failures,
      failureLocations,
      skipped,
      ...(pending.length ? { pending: pending.map(check => check.name), pendingChecks: pending } : {}),
    };
    await writeCacheRecord(root, cacheRel, record);
    return record;
  });
}
