// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

export const STALE_MS = 30 * 60 * 1000;
const UNFINISHED_JOB = new Set(['queued', 'pending', 'held', 'running']);

function stateFile(root, id) {
  return path.join(root, '.swarm', 'runs', id, 'state.json');
}

export async function listRunSpendKeys(dir, runId) {
  let store;
  try {
    store = JSON.parse(await fs.readFile(path.join(dir, 'daily.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!store || store.version !== 1 || typeof store.entries !== 'object' || store.entries === null) return [];
  return Object.entries(store.entries)
    .filter(([, entry]) => entry?.runId === runId && entry.kind === 'reservation')
    .map(([key]) => key)
    .sort();
}

export async function findDeadRun(root, id, { readState, listLiveRuns, isAlive, now = Date.now, staleMs = STALE_MS } = {}) {
  const state = await readState(root, id);
  if (state.status !== 'running') return { dead: false };

  const record = (await listLiveRuns()).find(run => run.runId === id);
  if (record) {
    if (!isAlive(record.pid)) return { dead: true, reason: 'pid-gone' };
    return { dead: false };
  }

  let mtimeMs;
  try {
    mtimeMs = (await fs.stat(stateFile(root, id))).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return { dead: false };
    throw error;
  }
  if (now() - mtimeMs >= staleMs) return { dead: true, reason: 'pid-gone' };
  return { dead: false };
}

export async function finalizeDeadRun(root, id, { readState, writeState, unregisterLiveRun, releaseSpend, spendKeys, now = Date.now } = {}) {
  const state = await readState(root, id);
  if (state.status === 'cancelled') {
    return { id, status: 'cancelled', cancelledJobs: [], releasedKeys: [] };
  }
  if (state.status !== 'running') {
    throw Object.assign(new Error(`dead-run-refuse: run is ${state.status}, not running`), { code: 'dead-run-refuse' });
  }

  const cancelledAt = new Date(now()).toISOString();
  const cancelledJobs = [];
  for (const job of state.jobs ?? []) {
    if (!UNFINISHED_JOB.has(job.status)) continue;
    job.status = 'cancelled';
    job.finishedAt = job.finishedAt ?? cancelledAt;
    for (const key of ['heldReason', 'heldUntil']) delete job[key];
    cancelledJobs.push(job.id);
  }
  delete state.pause;
  state.status = 'cancelled';
  state.cancelledAt = cancelledAt;
  state.cancelReason = 'runner-gone';

  await writeState(root, id, state);
  await unregisterLiveRun(id);

  const releasedKeys = [];
  for (const key of await spendKeys(id)) {
    await releaseSpend({ key });
    releasedKeys.push(key);
  }
  return { id, status: 'cancelled', cancelledJobs, releasedKeys };
}
