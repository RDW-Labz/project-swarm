// SPDX-License-Identifier: Apache-2.0
// Autopilot pause marker: autopilot must not start new work while the orchestrator integrates or runs e2e.
// The marker lives under .swarm/autopilot/pause.json and records the owner's PID. A marker left by a process
// that is gone is treated as not paused.
import fs from 'node:fs/promises';
import path from 'node:path';

const PAUSE_FILE = path.join('.swarm', 'autopilot', 'pause.json');

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

function markerPath(root) {
  return path.join(root, PAUSE_FILE);
}

async function readMarker(root) {
  try {
    const text = await fs.readFile(markerPath(root), 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Mark autopilot paused while `reason` (integrate or e2e) runs. Returns an end() function. */
export async function beginAutopilotPause(root, reason, { pid = process.pid, now = Date.now } = {}) {
  const dir = path.join(root, '.swarm', 'autopilot');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const payload = { pid, reason: String(reason ?? 'unspecified').slice(0, 64), startedAt: new Date(now()).toISOString() };
  const file = markerPath(root);
  const tmp = `${file}.${pid}.${now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
  let ended = false;
  return async () => {
    if (ended) return;
    ended = true;
    try {
      const owner = await readMarker(root);
      if (owner?.pid === pid) await fs.rm(file, { force: true });
    } catch (error) {
      if (error?.code === 'ENOENT') { /* already gone */ }
      else if (error instanceof SyntaxError) console.error('[tools/autopilot-pause.mjs] release pause marker:', 'corrupt pause marker (SyntaxError)');
      else console.error('[tools/autopilot-pause.mjs] release pause marker:', file, error?.message ?? error);
    }
  };
}

/** True while a live process holds the pause marker. A stale marker (dead PID) does not pause. */
export async function autopilotIsPaused(root, { isAlive = alive } = {}) {
  const owner = await readMarker(root);
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  return isAlive(owner.pid);
}
