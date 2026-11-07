// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listLiveRuns, unregisterLiveRun } from './board.mjs';
import { withSpendStore, spendDir } from './spend.mjs';

const execFileAsync = promisify(execFile);

const ACTIVE_RUN = new Set(['running', 'queued']);
const ACTIVE_JOB = new Set(['running', 'queued']);
const JOB_LEDGER_KEY_FIELDS = ['spendKey', 'ledgerKey', 'reservationKey', 'accrueKey'];

function clock(now) {
  return typeof now === 'function' ? now() : now;
}

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function jobActivityMs(job) {
  let latest = null;
  for (const field of ['startedAt', 'finishedAt', 'lastActivity']) {
    const ms = parseTime(job?.[field]);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

function lastActivityMs(state, stateMtimeMs) {
  let latest = stateMtimeMs ?? null;
  for (const job of state.jobs ?? []) {
    const ms = jobActivityMs(job);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

function collectSpendLedgerKeys(state) {
  const keys = new Set();
  for (const key of state.ledgerKeys ?? []) {
    if (typeof key === 'string' && key) keys.add(key);
  }
  for (const job of state.jobs ?? []) {
    if (!job || typeof job !== 'object') continue;
    for (const field of JOB_LEDGER_KEY_FIELDS) {
      const value = job[field];
      if (typeof value === 'string' && value) keys.add(value);
    }
  }
  return [...keys];
}

function worktreeUnderRun(candidate, runId) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const marker = '/worktrees/';
  const idx = candidate.indexOf(marker);
  if (idx < 0) return false;
  // Swarm worktrees live at .../worktrees/<project>-<hash>/<runId>[/.attempts/...]: the run id must be a whole
  // path segment below /worktrees/, never a prefix match and never '..'.
  const segments = candidate.slice(idx + marker.length).split('/');
  if (segments.includes('..')) return false;
  return segments.includes(runId);
}

async function pathExists(fsImpl, target) {
  try {
    await fsImpl.stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeStateAtomic(fsImpl, file, state) {
  const dir = path.dirname(file);
  await fsImpl.mkdir(dir, { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await fsImpl.rename(temporary, file);
}

async function defaultGit(root, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
    };
  }
}

function liveRunIdSet(liveRuns) {
  if (!liveRuns) return null;
  if (liveRuns instanceof Set) return liveRuns;
  const ids = new Set();
  for (const entry of liveRuns) {
    if (typeof entry === 'string') ids.add(entry);
    else if (entry && typeof entry === 'object' && typeof entry.runId === 'string') ids.add(entry.runId);
  }
  return ids;
}

async function releaseReservations(keys, { storeDir, now, fsImpl }) {
  if (!keys.length) return [];
  return withSpendStore(store => {
    const released = [];
    for (const key of keys) {
      const entry = store.entries[key];
      if (entry?.kind === 'reservation') {
        delete store.entries[key];
        released.push(key);
      }
    }
    return released;
  }, { dir: storeDir, now: () => clock(now), fs: fsImpl });
}

export async function reapStuckRuns({
  roots,
  olderThanMinutes = 120,
  apply = false,
  now = Date.now,
  liveRuns,
  spendDir: spendDirectory = spendDir(),
  deps = {},
} = {}) {
  const fsImpl = deps.fs ?? fs;
  const gitImpl = deps.git ?? defaultGit;
  const listLive = deps.listLiveRuns ?? listLiveRuns;
  const unregister = deps.unregisterLiveRun ?? unregisterLiveRun;
  const storeDir = deps.spendDir ?? spendDirectory;
  const thresholdMs = olderThanMinutes * 60 * 1000;
  const at = clock(now);

  let liveIds = liveRunIdSet(liveRuns);
  if (!liveIds) {
    const runs = await listLive(deps.liveDir ? { dir: deps.liveDir } : {});
    liveIds = new Set(runs.map(run => run.runId));
  }

  const stuck = [];
  const errors = [];
  const released = [];
  const removedWorktrees = [];
  let reapedAny = false;

  for (const root of roots ?? []) {
    const runsDir = path.join(root, '.swarm', 'runs');
    let entries;
    try {
      entries = await fsImpl.readdir(runsDir);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      errors.push({ root, runId: null, error: error.message ?? String(error) });
      continue;
    }

    for (const runId of entries) {
      const stateFile = path.join(runsDir, runId, 'state.json');
      let state;
      let stateMtimeMs;
      try {
        const stat = await fsImpl.stat(stateFile);
        stateMtimeMs = stat.mtimeMs;
        state = JSON.parse(await fsImpl.readFile(stateFile, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        errors.push({ root, runId, error: error.message ?? String(error) });
        continue;
      }

      if (!ACTIVE_RUN.has(state.status)) continue;
      if (liveIds.has(runId)) continue;

      const activityMs = lastActivityMs(state, stateMtimeMs);
      if (activityMs === null || at - activityMs < thresholdMs) continue;

      const minutes = Math.floor((at - activityMs) / 60_000);
      const jobs = (state.jobs ?? [])
        .filter(job => ACTIVE_JOB.has(job?.status))
        .map(job => job.id)
        .filter(id => typeof id === 'string');

      stuck.push({
        root,
        runId,
        lastActivity: new Date(activityMs).toISOString(),
        minutes,
        jobs,
      });

      if (!apply) continue;

      try {
        const iso = new Date(at).toISOString();
        state.status = 'failed';
        state.error = `reaped: no progress for ${minutes} minutes`;
        state.reapedAt = iso;
        for (const job of state.jobs ?? []) {
          if (!ACTIVE_JOB.has(job?.status)) continue;
          job.status = 'failed';
          job.error = 'reaped: run stopped making progress';
        }
        await writeStateAtomic(fsImpl, stateFile, state);

        const keys = collectSpendLedgerKeys(state);
        const releasedHere = await releaseReservations(keys, { storeDir, now, fsImpl });
        released.push(...releasedHere);

        const seen = new Set();
        for (const job of state.jobs ?? []) {
          for (const field of ['worktreePath', 'keptWorkspace']) {
            const candidate = job?.[field];
            if (!candidate || seen.has(candidate)) continue;
            if (!worktreeUnderRun(candidate, runId)) continue;
            if (!(await pathExists(fsImpl, candidate))) continue;
            seen.add(candidate);
            await gitImpl(root, ['worktree', 'remove', '--force', candidate]);
            removedWorktrees.push(candidate);
          }
        }
        await gitImpl(root, ['worktree', 'prune']);
        await unregister(runId, deps.liveDir ? { dir: deps.liveDir } : {});
        reapedAny = true;
      } catch (error) {
        errors.push({ root, runId, error: error.message ?? String(error) });
      }
    }
  }

  return {
    stuck,
    applied: apply && reapedAny,
    released,
    removedWorktrees,
    errors,
  };
}

export const REAP_USAGE = `Usage: swarm reap [--older-than MINUTES] [--apply] [--all-projects] [--json]
Find runs stuck in "running" with no live process and no progress for MINUTES (default 120).
Dry run by default: lists them and changes nothing. --apply marks them and their running jobs failed,
releases only their in-flight spend reservations, and removes their worktrees.
`;

// CLI for `swarm reap`. Returns { stdout, exitCode }.
export async function runReapCommand(args, { root, env = process.env, deps = {} } = {}) {
  let olderThanMinutes = 120, apply = false, allProjects = false, json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--all-projects') allProjects = true;
    else if (arg === '--json') json = true;
    else if (arg === '--older-than') {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value < 10 || value > 10080) return { stdout: 'swarm reap: --older-than must be whole minutes, 10 to 10080\n', exitCode: 2 };
      olderThanMinutes = value; i += 1;
    } else return { stdout: `swarm reap: unknown option ${arg}\n${REAP_USAGE}`, exitCode: 2 };
  }
  let roots = [root];
  if (allProjects) {
    const { listProjects } = await import('./projects.mjs');
    const projects = await (deps.listProjects ?? listProjects)({ env });
    roots = [...new Set((projects ?? []).map(project => project.root ?? project.path).filter(Boolean))];
  }
  const result = await (deps.reapStuckRuns ?? reapStuckRuns)({ roots, olderThanMinutes, apply });
  if (json) return { stdout: `${JSON.stringify(result)}\n`, exitCode: result.errors.length ? 1 : 0 };
  const lines = [];
  if (!result.stuck.length) lines.push(`No runs stuck for more than ${olderThanMinutes} minutes.`);
  for (const run of result.stuck) lines.push(`${apply ? 'reaped' : 'stuck'} ${run.runId} in ${run.root}: no progress for ${run.minutes} min (jobs: ${run.jobs.join(', ') || 'none running'})`);
  if (apply && result.released.length) lines.push(`released ${result.released.length} spend reservation(s)`);
  if (apply && result.removedWorktrees.length) lines.push(`removed ${result.removedWorktrees.length} worktree(s)`);
  for (const error of result.errors) lines.push(`error ${error.runId ?? ''} in ${error.root}: ${error.error}`);
  if (!apply && result.stuck.length) lines.push('Dry run. Add --apply to mark them failed and clean them up.');
  return { stdout: `${lines.join('\n')}\n`, exitCode: result.errors.length ? 1 : 0 };
}
