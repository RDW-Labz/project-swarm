// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { open, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pidAlive } from './server-restart.mjs';

export const PENDING_BASENAME = '.update-pending.json';
export const DEFAULT_WHEN_IDLE_TIMEOUT_MINUTES = 60;
export const WHEN_IDLE_TRY_AGAIN_EXIT = 75;
const WAIT_LINE = 'waiting for swarm update\n';
const HELD_LOCK_BASENAME = '.update-pending-held.lock';
const HELD_LOG_BASENAME = '.update-pending-held.log';
const HELD_LOG_MAX_LINES = 500;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

const heldRegistrationLock = { tail: Promise.resolve() };

function withHeldLock(fn) {
  const run = heldRegistrationLock.tail.then(fn, fn);
  heldRegistrationLock.tail = run.catch(() => {});
  return run;
}

export function pendingPath(installRoot) {
  return path.join(installRoot, PENDING_BASENAME);
}

function heldLockPath(installRoot) {
  return path.join(installRoot, HELD_LOCK_BASENAME);
}

function heldLogPath(installRoot) {
  return path.join(installRoot, HELD_LOG_BASENAME);
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
  const warn = opts.warn ?? (() => {});
  let record;
  try {
    record = await readPendingRaw(installRoot);
  } catch {
    await removePendingRecord(installRoot).catch(() => {});
    warn('update-pending: removed corrupt pending record');
    return null;
  }
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

async function withCrossProcessLock(lockPath, fn, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 30_000 } = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  let handle = null;
  while (Date.now() < deadline) {
    try {
      handle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await sleep(25);
    }
  }
  if (!handle) throw Object.assign(new Error('pending-lock-timeout'), { code: 'EBUSY' });
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function withPendingFileLock(installRoot, fn, opts = {}) {
  return await withCrossProcessLock(heldLockPath(installRoot), fn, opts);
}

async function atomicWritePending(installRoot, record, { createOnly = false } = {}) {
  const target = pendingPath(installRoot);
  await fs.mkdir(installRoot, { recursive: true });
  if (createOnly) {
    const payload = `${JSON.stringify(record)}\n`;
    try {
      const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      try {
        await handle.writeFile(payload);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error('pending-exists'), { code: 'EEXIST' });
      throw error;
    }
  }
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
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
  await withPendingFileLock(installRoot, () => atomicWritePending(installRoot, record));
}

export async function acquirePendingSlot(installRoot, record) {
  return await withPendingFileLock(installRoot, async () => {
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
  });
}

async function rewritePending(installRoot, mutate) {
  await withPendingFileLock(installRoot, async () => {
    const record = await readPendingRaw(installRoot);
    if (!record || !isPendingRecordLive(record)) return;
    const next = mutate({ ...record, heldPids: Array.isArray(record.heldPids) ? [...record.heldPids] : [] });
    if (!next) return;
    await atomicWritePending(installRoot, next);
  });
}

async function trimHeldLog(installRoot) {
  const log = heldLogPath(installRoot);
  try {
    const text = await readFile(log, 'utf8');
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length <= HELD_LOG_MAX_LINES) return;
    const kept = lines.slice(-HELD_LOG_MAX_LINES);
    await writeFile(log, `${kept.join('\n')}\n`, { mode: 0o600 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function appendHeldPidAtomic(installRoot, launcherPid) {
  const log = heldLogPath(installRoot);
  await fs.mkdir(installRoot, { recursive: true });
  await withCrossProcessLock(`${log}.lock`, async () => {
    await fs.appendFile(log, `${launcherPid}\n`, { mode: 0o600, flag: 'a' });
    await trimHeldLog(installRoot);
  });
}

export async function registerHeldLauncher(installRoot, launcherPid) {
  if (!isPositiveInteger(launcherPid)) return;
  await withHeldLock(async () => {
    await appendHeldPidAtomic(installRoot, launcherPid);
    await rewritePending(installRoot, record => {
      if (!isPendingRecordLive(record)) return null;
      const held = new Set(record.heldPids ?? []);
      held.add(launcherPid);
      return { ...record, heldPids: [...held] };
    });
  });
}

export async function unregisterHeldLauncher(installRoot, launcherPid) {
  if (!isPositiveInteger(launcherPid)) return;
  await withHeldLock(async () => {
    await rewritePending(installRoot, record => {
      if (!record?.pid) return null;
      const held = new Set(record.heldPids ?? []);
      held.delete(launcherPid);
      return { ...record, heldPids: [...held] };
    });
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

export function parentOfPid(pid, { execFileSyncImpl = execFileSync } = {}) {
  if (!isPositiveInteger(pid)) return null;
  try {
    const out = execFileSyncImpl('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const ppid = Number(String(out).trim());
    if (!isPositiveInteger(ppid) || ppid === pid) return null;
    return ppid;
  } catch {
    return null;
  }
}

export function isPidHeldOrAncestor(pid, heldPids, { parentOf = parentOfPid, maxDepth = 64 } = {}) {
  if (!isPositiveInteger(pid) || !heldPids?.size) return false;
  const seen = new Set();
  let current = pid;
  while (isPositiveInteger(current) && !seen.has(current) && seen.size <= maxDepth) {
    seen.add(current);
    if (heldPids.has(current)) return true;
    current = parentOf(current);
  }
  return false;
}

function markerWaitsForUpdate(marker) {
  const command = String(marker?.command ?? '');
  return /waiting for swarm update/i.test(command);
}

function runIsHeldAutopilot(run, heldPids) {
  if (!run || !heldPids?.size) return false;
  const runPid = run.pid ?? run.orchestratorPid ?? null;
  if (isPositiveInteger(runPid) && heldPids.has(runPid)) return true;
  const command = String(run.command ?? run.kind ?? '');
  if (/autopilot|wave|go\b/i.test(command)) {
    for (const pid of heldPids) {
      if (command.includes(String(pid))) return true;
    }
  }
  return false;
}

export async function machineBusySnapshot({
  boardSummary,
  runningSwarmCommands,
  liveBusyMarkers,
  installDirs,
  excludePids = [],
  selfPid = process.pid,
  heldPids = [],
  parentOf = parentOfPid,
} = {}) {
  const exclude = new Set(excludePids);
  const held = new Set((heldPids ?? []).filter(isPositiveInteger));
  if (isPositiveInteger(selfPid)) exclude.add(selfPid);

  const { runs = [] } = await boardSummary();
  const liveRuns = (Array.isArray(runs) ? runs : []).filter(run => !runIsHeldAutopilot(run, held));

  const dirs = [...new Set((installDirs ?? []).filter(Boolean))];
  const processes = (runningSwarmCommands({ installDirs: dirs }) ?? []).filter(entry => {
    if (exclude.has(entry.pid)) return false;
    if (isPidHeldOrAncestor(entry.pid, held, { parentOf })) return false;
    return true;
  });

  const markers = (await liveBusyMarkers() ?? []).filter(marker => {
    if (marker.pid === selfPid || exclude.has(marker.pid)) return false;
    if (markerWaitsForUpdate(marker)) return false;
    if (isPidHeldOrAncestor(marker.pid, held, { parentOf })) return false;
    return true;
  });

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

export async function refreshPendingExpiry(installRoot, { extendMinutes = DEFAULT_WHEN_IDLE_TIMEOUT_MINUTES } = {}) {
  await rewritePending(installRoot, record => {
    if (!isPendingRecordLive(record)) return null;
    const expiresAt = new Date(Date.now() + extendMinutes * 60_000).toISOString();
    return { ...record, expiresAt };
  });
}

export async function waitForMachineIdleWhilePending(installRoot, {
  pendingRecord,
  describeBusy,
  env = process.env,
  write = text => { try { process.stderr.write(text); } catch { /* tests */ } },
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMinutes = DEFAULT_WHEN_IDLE_TIMEOUT_MINUTES,
  shouldAbort = () => false,
} = {}) {
  const pollMs = pollIntervalMs(env);
  const statusMs = statusIntervalMs(env);
  const startedAt = Date.parse(pendingRecord.startedAt);
  const idleDeadline = Number.isFinite(startedAt)
    ? startedAt + timeoutMinutes * 60_000
    : Date.parse(pendingRecord.expiresAt);
  let lastStatus = 0;

  for (;;) {
    if (shouldAbort()) return { timedOut: false, aborted: true, snapshot: { busy: false, liveRuns: [], processes: [], markers: [] } };
    const current = Date.now();
    await refreshPendingExpiry(installRoot);
    if (current >= idleDeadline) {
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
  let aborted = false;
  let abortExitCode = null;
  const cleanup = async () => {
    if (removed) return;
    removed = true;
    await removePendingRecord(installRoot).catch(() => {});
  };

  const detachAbortHandlers = () => {
    process.off('SIGINT', abortHandler);
    process.off('SIGTERM', abortHandler);
    process.off('SIGHUP', abortHandler);
  };

  const abortHandler = received => {
    aborted = true;
    const signal = typeof received === 'string' ? received : 'SIGTERM';
    abortExitCode = signal === 'SIGINT' ? 130 : 143;
    onAbort?.();
    void cleanup().then(() => {
      detachAbortHandlers();
      process.exit(abortExitCode);
    });
  };

  process.on('SIGINT', abortHandler);
  process.on('SIGTERM', abortHandler);
  process.on('SIGHUP', abortHandler);

  try {
    const wait = await waitForMachineIdleWhilePending(installRoot, {
      pendingRecord,
      describeBusy,
      env,
      write,
      sleep,
      timeoutMinutes,
      shouldAbort: () => aborted,
    });
    if (wait.aborted) {
      await cleanup();
      detachAbortHandlers();
      process.exit(abortExitCode ?? 130);
    }
    if (wait.timedOut) {
      await cleanup();
      const detail = formatBusyStatus(wait.snapshot);
      write(`update-when-idle: the update did not run because the machine never became idle within ${timeoutMinutes} minute(s)\n${detail}\n`);
      process.exitCode = WHEN_IDLE_TRY_AGAIN_EXIT;
      return { status: 'timeout', snapshot: wait.snapshot };
    }
    await refreshPendingExpiry(installRoot);
    const result = await performUpdate();
    await refreshPendingExpiry(installRoot);
    await cleanup();
    return { status: 'updated', result };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    detachAbortHandlers();
  }
}
