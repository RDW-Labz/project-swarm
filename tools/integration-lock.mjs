// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoKey, liveDir as defaultLiveDir } from './board.mjs';

const execFileAsync = promisify(execFile);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function lockKey(repo, suffix) {
  return crypto.createHash('sha256').update(`${repo}\0${suffix}`).digest('hex').slice(0, 16);
}

export async function resolveIntegrationLockBranch(root, { branch } = {}) {
  const realRoot = await fs.realpath(root);
  if (branch !== undefined) {
    if (typeof branch !== 'string' || !branch || branch.includes('\0')) throw Object.assign(new Error('integrate-lock-branch-invalid'), { code: 'integrate-lock-branch-invalid' });
    return { branchKey: branch, branchLabel: branch };
  }
  try {
    const ref = (await execFileAsync('git', ['-C', realRoot, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
    if (ref) return { branchKey: ref, branchLabel: ref };
  } catch { /* detached HEAD */ }
  const detached = `detached:${realRoot}`;
  return { branchKey: detached, branchLabel: detached };
}

function ownerFields(owner) {
  const field = name => owner?.[name] ?? 'unknown';
  return field;
}

function lockRaceExhausted() {
  return Object.assign(new Error('lock-race-exhausted'), { code: 'lock-race-exhausted' });
}

function retryLockRace(raceRetries) {
  if (raceRetries < 50) return raceRetries + 1;
  throw lockRaceExhausted();
}

export async function tryAcquireLock(lock, { owner, isAlive, now, staleMs, staleOwnerlessMs, integrateStale, warnings, staleWarning, fsImpl = fs } = {}) {
  await fsImpl.mkdir(path.dirname(lock), { recursive: true });
  let raceRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try { await fsImpl.mkdir(lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stat;
      try { stat = await fsImpl.lstat(lock); }
      catch (lstatError) {
        if (lstatError.code === 'ENOENT') raceRetries = retryLockRace(raceRetries);
        else throw lstatError;
        continue;
      }
      let existing;
      if (stat.isDirectory()) {
        try { existing = JSON.parse(await fsImpl.readFile(path.join(lock, 'owner.json'), 'utf8')); }
        catch {
          /* ownerless creation window */
        }
      }
      const valid = existing && typeof existing === 'object' && Number.isInteger(existing.pid) && existing.pid > 0 && typeof existing.host === 'string';
      const stale = stat.isDirectory() && (integrateStale
        ? (valid ? existing.host === os.hostname() && !isAlive(existing.pid) : now() - stat.mtimeMs > staleOwnerlessMs)
        : (valid ? !isAlive(existing.pid) || now() - stat.mtimeMs > staleMs : now() - stat.mtimeMs > staleMs));
      const field = ownerFields(existing);
      if (stale && attempt === 0) {
        try { await fsImpl.rm(lock, { recursive: true, force: true }); }
        catch (rmError) {
          if (rmError.code === 'ENOENT') {
            raceRetries = retryLockRace(raceRetries);
            continue;
          }
          throw rmError;
        }
        if (staleWarning) warnings.push(staleWarning(lock, field));
        continue;
      }
      return { ok: false, owner: existing, field };
    }
    await fsImpl.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
    return { ok: true };
  }
}

export async function acquireIntegrationLock(root, { runId, branch, liveDir = defaultLiveDir(), isAlive = pidAlive, pid = process.pid, now = Date.now } = {}) {
  const realRoot = await fs.realpath(root);
  const repo = await repoKey(realRoot);
  const { branchKey, branchLabel } = await resolveIntegrationLockBranch(realRoot, { branch });
  const key = lockKey(repo, `integrate:${branchKey}`);
  const locks = [path.join(liveDir, 'locks', `integrate-${key}`), path.join(realRoot, '.swarm/integration.lock')];
  const held = [], warnings = [];
  const release = async () => {
    while (held.length) {
      const lock = held[held.length - 1];
      await fs.unlink(path.join(lock, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
      held.pop();
    }
  };
  const owner = { pid, host: os.hostname(), runId, root: realRoot, startedAt: new Date(now()).toISOString(), branch: branchLabel };
  try {
    for (const lock of locks) {
      const result = await tryAcquireLock(lock, {
        owner,
        isAlive,
        now,
        staleMs: 60000,
        staleOwnerlessMs: 60000,
        integrateStale: true,
        warnings,
        staleWarning: (lockPath, field) => `integrate-lock-stale-cleared: ${lockPath} (pid ${field('pid')}, run ${field('runId')}, started ${field('startedAt')})`,
      });
      if (!result.ok) {
        const field = ownerFields(result.owner);
        throw Object.assign(new Error(`integrate-locked: another integrate holds branch ${branchLabel} of this repository (pid ${field('pid')}, run ${field('runId')}, root ${field('root')}, started ${field('startedAt')})`), { code: 'integrate-locked' });
      }
      held.push(lock);
    }
    return { release, warnings, branch: branchLabel };
  } catch (error) { await release(); throw error; }
}

const SHARED_POLL_MS = 25;
const SHARED_WAIT_MS = 10000;

export async function withSharedWriteLock(root, name, fn, { liveDir = defaultLiveDir(), maxHoldMs = 5000, staleMs = 30000, isAlive = pidAlive, pid = process.pid, now = Date.now, waitMs = SHARED_WAIT_MS } = {}) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw Object.assign(new Error('shared-write-name-invalid'), { code: 'shared-write-name-invalid' });
  const realRoot = await fs.realpath(root);
  const repo = await repoKey(realRoot);
  const key = lockKey(repo, `shared:${name}`);
  const lock = path.join(liveDir, 'locks', `shared-${key}`);
  const owner = { pid, host: os.hostname(), name, root: realRoot, startedAt: new Date(now()).toISOString() };
  const warnings = [];
  const startedWait = now();
  for (;;) {
    const result = await tryAcquireLock(lock, {
      owner,
      isAlive,
      now,
      staleMs,
      staleOwnerlessMs: staleMs,
      integrateStale: false,
      warnings,
      staleWarning: lockPath => `shared-write-lock-stale-cleared: ${lockPath} (${name})`,
    });
    if (result.ok) break;
    if (now() - startedWait >= waitMs) {
      throw Object.assign(new Error(`shared-write-locked: another writer holds ${name} for this repository`), { code: 'shared-write-locked' });
    }
    await new Promise(resolve => setTimeout(resolve, SHARED_POLL_MS));
  }
  const heldAt = now();
  try {
    return await fn();
  } finally {
    const heldMs = now() - heldAt;
    if (heldMs > maxHoldMs) warnings.push(`shared-write-lock-slow: ${name} held ${heldMs}ms (max ${maxHoldMs}ms)`);
    for (const line of warnings) console.warn(line);
    await fs.unlink(path.join(lock, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
