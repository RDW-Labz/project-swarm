// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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

export async function writeBusyMarker({ command, root, pid = process.pid, dir = busyDir() }) {
  const realRoot = await fs.realpath(root);
  const record = { pid, command, root: realRoot, startedAt: new Date().toISOString() };
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

export async function liveBusyMarkers({ dir = busyDir(), isAlive = pidAlive } = {}) {
  let entries;
  try { entries = await fs.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const markers = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const target = path.join(dir, entry);
    let record;
    try { record = JSON.parse(await fs.readFile(target, 'utf8')); } catch { await fs.unlink(target).catch(() => {}); continue; }
    if (!isAlive(record.pid)) { await fs.unlink(target).catch(() => {}); continue; }
    markers.push({ pid: record.pid, command: record.command, root: record.root });
  }
  return markers;
}
