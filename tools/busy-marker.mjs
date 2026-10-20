// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { liveDir } from './board.mjs';

export const BUSY_MARKER_VERBS = new Set(['go', 'run', 'integrate', 'autopilot', 'ship', 'scale', 'with-concurrency', 'ticket', 'sweep', 'resume']);

export function busyDir(env = process.env, home = os.homedir()) {
  if (env.SWARM_BUSY_DIR) return env.SWARM_BUSY_DIR;
  const live = liveDir(env, home);
  return path.join(path.dirname(live), 'busy');
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function isPositiveIntegerPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

function defaultProcStart(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const trimmed = out.trim();
    if (!trimmed) return null;
    return trimmed.replace(/\s+/g, ' ');
  } catch {
    return null;
  }
}

export function reduceBusyCommand(command) {
  const words = String(command).trim().split(/\s+/).filter(Boolean);
  let skipNext = false;
  for (const word of words) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (word === '--root') {
      skipNext = true;
      continue;
    }
    if (word.startsWith('-')) continue;
    if (BUSY_MARKER_VERBS.has(word)) return `swarm ${word}`;
  }
  return 'swarm';
}

export async function writeBusyMarker({
  command,
  root,
  pid = process.pid,
  dir = busyDir(),
  procStart = defaultProcStart,
}) {
  const realRoot = await fs.realpath(root);
  const storedCommand = reduceBusyCommand(command);
  const record = {
    pid,
    command: storedCommand,
    root: realRoot,
    startedAt: new Date().toISOString(),
    procStart: procStart(pid),
  };
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const target = path.join(dir, `${pid}.json`);
  const temporary = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx' });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return async function remove() {
    await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  };
}

export async function liveBusyMarkers({
  dir = busyDir(),
  isAlive = pidAlive,
  procStart = defaultProcStart,
} = {}) {
  let entries;
  try { entries = await fs.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const markers = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const target = path.join(dir, entry);
    let record;
    try { record = JSON.parse(await fs.readFile(target, 'utf8')); } catch { await fs.unlink(target).catch(() => {}); continue; }
    if (!isPositiveIntegerPid(record.pid) || !isAlive(record.pid)) { await fs.unlink(target).catch(() => {}); continue; }
    const storedStart = record.procStart ?? null;
    if (typeof storedStart === 'string') {
      const currentStart = procStart(record.pid);
      if (currentStart != null && currentStart !== storedStart) {
        await fs.unlink(target).catch(() => {});
        continue;
      }
    }
    markers.push({ pid: record.pid, command: record.command, root: record.root });
  }
  return markers;
}
