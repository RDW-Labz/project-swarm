// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHIEF_FLAG = 'chief_orchestrator';

// The flag is on only when the local config sets it to exactly true. Anything else (missing, false, a string) is off.
export function chiefEnabled(config) {
  return config?.[CHIEF_FLAG] === true;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Takes the single chief lock for this machine. Returns { acquired: true, lockFile } or { acquired: false, owner }.
// A lock held by a live process on this host is never taken over. A lock whose owner is dead on this host is cleared.
export function acquireChiefLock({ dir, config, pid = process.pid, host = os.hostname(), isAlive = pidAlive } = {}) {
  if (!chiefEnabled(config)) return { acquired: false, reason: 'flag-off' };
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'chief.lock.json');
  const payload = JSON.stringify({ pid, host, at: new Date().toISOString() }) + '\n';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, payload, { flag: 'wx', mode: 0o600 });
      return { acquired: true, lockFile };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readOwner(lockFile);
      if (owner && owner.host === host && Number.isInteger(owner.pid) && owner.pid > 0 && !isAlive(owner.pid)) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      return { acquired: false, reason: 'held', owner };
    }
  }
  return { acquired: false, reason: 'held', owner: readOwner(lockFile) };
}

// Releases the lock only when this process still owns it, so a stale release never removes another chief's lock.
export function releaseChiefLock({ dir, pid = process.pid } = {}) {
  const lockFile = path.join(dir, 'chief.lock.json');
  const owner = readOwner(lockFile);
  if (owner && owner.pid === pid) fs.rmSync(lockFile, { force: true });
}

// Entry point for a second chief: exits non-zero and leaves the first chief's lock unchanged.
export function startChief({ dir, config, exit = process.exit, log = console.error } = {}) {
  const result = acquireChiefLock({ dir, config });
  if (result.reason === 'flag-off') return { started: false, reason: 'flag-off' };
  if (!result.acquired) {
    log(`chief already running (pid ${result.owner?.pid ?? 'unknown'} on ${result.owner?.host ?? 'unknown'})`);
    exit(1);
    return { started: false, reason: 'held' };
  }
  return { started: true, lockFile: result.lockFile };
}
