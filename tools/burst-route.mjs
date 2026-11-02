// SPDX-License-Identifier: Apache-2.0
// T-0412: route lane:burst tickets to registered cloud runners when burst is enabled per project.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { burstEnabled, visibleQueueJobs, isCloudJob } from './burst-config.mjs';
import { claimForRunner, registerRunner, recordHeartbeat } from './burst-lease.mjs';
import { release, validateNow } from './ledger-lease.mjs';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

export const BURST_LANE_TAG = 'lane:burst';

export const completionsPath = root => path.join(root, '.swarm', 'project', 'burst-completions.json');

export function ticketHasBurstLane(ticket) {
  if (Array.isArray(ticket?.tags)) return ticket.tags.includes(BURST_LANE_TAG);
  return ticket?.lane === 'burst';
}

/** Queue listing for a project: burst-off projects never see cloud (lane:burst) jobs. */
export function listQueueJobsForProject(jobs, projectConfig) {
  return visibleQueueJobs(jobs, projectConfig);
}

export function cloudJobCount(jobs, projectConfig) {
  return listQueueJobsForProject(jobs, projectConfig).filter(isCloudJob).length;
}

async function readCompletions(root) {
  try {
    const raw = await fs.readFile(completionsPath(root), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendCompletion(root, entry) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'burst-completions.json');
  await assertRegularOrMissing(file);
  const existing = await readCompletions(root);
  existing.push(entry);
  const tmp = path.join(dir, `.burst-completions.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(existing, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, file);
  } catch (error) {
    await handle.close().catch((closeError) => {
      console.error('[tools/burst-route.mjs] appendBurstCompletion handle.close:', closeError?.message ?? closeError);
    });
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * When burst is on and the ticket is lane:burst, claim the ticket for the given cloud runner.
 * Otherwise the ticket stays on the local path (no cloud claim).
 */
export async function routeBurstTicket(
  root,
  ticket,
  projectConfig,
  { runnerId, now = Date.now(), leaseTtlMs } = {},
) {
  validateNow(now);
  if (!burstEnabled(projectConfig)) {
    return { routed: false, destination: 'local' };
  }
  if (!ticketHasBurstLane(ticket)) {
    return { routed: false, destination: 'local' };
  }
  if (typeof runnerId !== 'string' || runnerId.length === 0) {
    throw new Error('runnerId is required to route burst work to a cloud runner');
  }
  await registerRunner(root, runnerId, { now });
  const claimOpts = leaseTtlMs !== undefined ? { now, leaseTtlMs } : { now };
  const lease = await claimForRunner(root, ticket.id, runnerId, claimOpts);
  return { routed: true, destination: 'cloud', runnerId, lease };
}

export async function recordBurstCompletion(
  root,
  { ticketId, runnerId, fencingToken, outcome, now = Date.now() },
) {
  validateNow(now);
  await release(root, ticketId, fencingToken, { now });
  const recordedAt = new Date(now).toISOString();
  const entry = {
    type: 'burst.completed',
    ticketId,
    runnerId,
    outcome,
    recordedAt,
  };
  await appendCompletion(root, entry);
  return entry;
}

export async function readBurstCompletions(root) {
  return readCompletions(root);
}

export { recordHeartbeat };
