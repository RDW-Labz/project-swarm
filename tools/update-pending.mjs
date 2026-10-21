// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pidAlive } from './server-restart.mjs';

export const PENDING_BASENAME = '.update-pending.json';
export const DEFAULT_WHEN_IDLE_TIMEOUT_MINUTES = 60;
export const WHEN_IDLE_TRY_AGAIN_EXIT = 75;
const WAIT_LINE = 'waiting for swarm update\n';

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function pendingPath(installRoot) {
  return path.join(installRoot, PENDING_BASENAME);
}

export function pollIntervalMs(env = process.env) {
  const parsed = Number(env.SWARM_UPDATE_PENDING_POLL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
}

export function statusIntervalMs(env = process.env) {
  const parsed = Number(env.SWARM_UPDATE_PENDING_STATUS_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

export function isPendingRecordLive(record, { now = Date.now(), isAlive = pidAlive } = {}) {
  if (!record || typeof record !== 'object') return false;
  if (!isPositiveInteger(record.pid) || !isAlive(record.pid)) return false;
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(expires) || now >= expires) return false;
  return true;
}

async function readPendingRaw(installRoot) {
  try {
    const text = await fs.readFile(pendingPath(installRoot), 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readLivePending(installRoot, opts = {}) {
  const record = await readPendingRaw(installRoot);
  if (!record) return null;
  if (!isPendingRecordLive(record, opts)) {
    await removePendingRecord(installRoot).catch(() => {});
    return null;
  }
  return record;
}

export async function removePendingRecord(installRoot) {
  await fs.rm(pendingPath(installRoot), { force: true });
}

async function atomicWritePending(installRoot, record, { createOnly = false } = {}) {
  const target = pendingPath(installRoot);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.mkdir(installRoot, { recursive: true });
  if (createOnly) {
    try {
      await fs.stat(target);
      throw Object.assign(new Error('pending-exists'), { code: 'EEXIST' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function writePendingRecord(installRoot, record) {
  await atomicWritePending(installRoot, record);
}

export async function acquirePendingSlot(installRoot, record) {
  const existing = await readLivePending(installRoot);
  if (existing && existing.pid !== record.pid) {
    return { ok: false, existing };
  }
  if (existing && existing.pid === record.pid) return { ok: true };
  try {
    await atomicWritePending(installRoot, record, { createOnly: true });
    return { ok: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const again = await readLivePending(installRoot);
    if (again && again.pid !== record.pid) return { ok: false, existing: again };
    if (again && again.pid === record.pid) return { ok: true };
    throw error;
  }
}

async function rewritePending(installRoot, mutate) {
  const record = await readPendingRaw(installRoot);
  if (!record || !isPendingRecordLive(record)) return;
  const next = mutate({ ...record, heldPids: Array.isArray(record.heldPids) ? [...record.heldPids] : [] });
  if (!next) return;
  await atomicWritePending(installRoot, next);
}

export async function registerHeldLauncher(installRoot, launcherPid) {
  if (!isPositiveInteger(launcherPid)) return;
  await rewritePending(installRoot, record => {
    if (!isPendingRecordLive(record)) return null;
    const held = new Set(record.heldPids ?? []);
    held.add(launcherPid);
    return { ...record, heldPids: [...held] };
  });
}

export async function unregisterHeldLauncher(installRoot, launcherPid) {
  if (!isPositiveInteger(launcherPid)) return;
  await rewritePending(installRoot, record => {
    if (!record?.pid) return null;
    const held = new Set(record.heldPids ?? []);
    held.delete(launcherPid);
    return { ...record, heldPids: [...held] };
  });
}

export async function waitBeforeLaunchingWork(installRoot, {
  env = process.env,
  write = text => { try { process.stderr.write(text); } catch { /* tests */ } },
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  launcherPid = process.pid,
} = {}) {
  if (!installRoot) return;
  const pollMs = pollIntervalMs(env);
  for (;;) {
    const pending = await readLivePending(installRoot, { now: Date.now() });
    if (!pending) return;
    await registerHeldLauncher(installRoot, launcherPid);
    try {
      for (;;) {
        const still = await readLivePending(installRoot, { now: Date.now() });
        if (!still) break;
        write(WAIT_LINE);
        await sleep(pollMs);
      }
    } finally {
      await unregisterHeldLauncher(installRoot, launcherPid);
    }
  }
}

export async function resolveInstallRootForPending({ env = process.env, ownRoot, home = env.HOME ?? os.homedir(), readLauncher } = {}) {
  if (typeof env.SWARM_INSTALL_ROOT === 'string' && env.SWARM_INSTALL_ROOT) {
    return await fs.realpath(env.SWARM_INSTALL_ROOT).catch(() => path.resolve(env.SWARM_INSTALL_ROOT));
  }
  if (typeof readLauncher === 'function') {
    const launcher = await readLauncher(home);
    if (launcher?.installRoot) {
      return await fs.realpath(launcher.installRoot).catch(() => path.resolve(launcher.installRoot));
    }
  }
  return await fs.realpath(ownRoot).catch(() => ownRoot);
}

export async function machineBusySnapshot({
  boardSummary,
  runningSwarmCommands,
  liveBusyMarkers,
  installDirs,
  excludePids = [],
  selfPid = process.pid,
} = {}) {
  const exclude = new Set(excludePids);
  if (isPositiveInteger(selfPid)) exclude.add(selfPid);

  const { runs = [] } = await boardSummary();
  const liveRuns = Array.isArray(runs) ? runs : [];

  const dirs = [...new Set((installDirs ?? []).filter(Boolean))];
  const processes = (runningSwarmCommands({ installDirs: dirs }) ?? []).filter(entry => !exclude.has(entry.pid));

  const markers = (await liveBusyMarkers() ?? []).filter(marker => marker.pid !== selfPid && !exclude.has(marker.pid));

  const busy = liveRuns.length > 0 || processes.length > 0 || markers.length > 0;
  return { busy, liveRuns, processes, markers };
}

function formatBusyStatus({ liveRuns, processes, markers }) {
  const lines = [];
  for (const run of liveRuns) {
    const jobs = Array.isArray(run.jobs) ? run.jobs : [];
    const done = jobs.filter(job => job.status === 'complete').length;
    lines.push(`  run ${run.runId}  ${done}/${jobs.length} jobs  ${run.root}`);
  }
  for (const proc of processes) lines.push(`  process ${proc.pid}  ${proc.command}`);
  for (const marker of markers) lines.push(`  process ${marker.pid}  ${marker.command}  (${marker.root})`);
  return lines.join('\n');
}

export async function waitForMachineIdleWhilePending(installRoot, {
  pendingRecord,
  describeBusy,
  env = process.env,
  write = text => { try { process.stderr.write(text); } catch { /* tests */ } },
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const pollMs = pollIntervalMs(env);
  const statusMs = statusIntervalMs(env);
  const expiresAt = Date.parse(pendingRecord.expiresAt);
  let lastStatus = 0;

  for (;;) {
    const current = Date.now();
    if (current >= expiresAt) {
      const fresh = await readLivePending(installRoot, { now: current });
      const held = new Set(fresh?.heldPids ?? pendingRecord.heldPids ?? []);
      if (fresh?.pid) held.add(fresh.pid);
      return { timedOut: true, snapshot: await describeBusy({ excludePids: [...held] }) };
    }
    const fresh = await readLivePending(installRoot, { now: current });
    if (!fresh) return { timedOut: false, snapshot: { busy: false, liveRuns: [], processes: [], markers: [] } };
    const held = new Set(fresh.heldPids ?? []);
    held.add(fresh.pid);
    const snapshot = await describeBusy({ excludePids: [...held] });
    if (!snapshot.busy) return { timedOut: false, snapshot };

    if (!lastStatus || current - lastStatus >= statusMs) {
      write(`update-when-idle: waiting for idle\n${formatBusyStatus(snapshot)}\n`);
      lastStatus = current;
    }
    await sleep(pollMs);
  }
}

export async function runWhenIdleUpdate({
  installRoot,
  timeoutMinutes = DEFAULT_WHEN_IDLE_TIMEOUT_MINUTES,
  targetTag = null,
  performUpdate,
  describeBusy,
  env = process.env,
  write = text => { try { process.stderr.write(text); } catch { /* tests */ } },
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onAbort,
} = {}) {
  const startedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + timeoutMinutes * 60_000).toISOString();
  const pendingRecord = {
    pid: process.pid,
    startedAt,
    expiresAt,
    ...(targetTag ? { targetTag } : {}),
    heldPids: [],
  };

  const acquired = await acquirePendingSlot(installRoot, pendingRecord);
  if (!acquired.ok) {
    const error = new Error(`update-when-idle-refused: another update is already waiting (pid ${acquired.existing.pid})`);
    error.code = 'update-when-idle-refused';
    throw error;
  }

  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    removed = true;
    await removePendingRecord(installRoot).catch(() => {});
  };

  const abortHandler = () => { onAbort?.(); cleanup(); };
  process.on('SIGINT', abortHandler);

  try {
    const wait = await waitForMachineIdleWhilePending(installRoot, {
      pendingRecord,
      describeBusy,
      env,
      write,
      sleep,
    });
    if (wait.timedOut) {
      await cleanup();
      const detail = formatBusyStatus(wait.snapshot);
      write(`update-when-idle: the update did not run because the machine never became idle within ${timeoutMinutes} minute(s)\n${detail}\n`);
      process.exitCode = WHEN_IDLE_TRY_AGAIN_EXIT;
      return { status: 'timeout', snapshot: wait.snapshot };
    }
    const result = await performUpdate();
    await cleanup();
    return { status: 'updated', result };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    process.off('SIGINT', abortHandler);
  }
}
