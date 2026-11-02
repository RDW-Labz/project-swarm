// SPDX-License-Identifier: Apache-2.0
// `swarm queue list|claim|release`: queue listing, lease claim, and expired-lease sweep (cluster queue CLI).
import path from 'node:path';
import { claim, release, sweepExpiredLeases } from './ledger-lease.mjs';
import { getNodeId } from './node-identity.mjs';
import {
  createJobGrant as defaultCreateJobGrant,
  SWARM_JOB_GRANT_FILE,
  SWARM_JOB_ID,
} from './job-grants.mjs';
import { isProjectIsolationEnabled } from './job-sandbox.mjs';
import { readLedger } from './tickets.mjs';
import { burstEnabled, isCloudJob } from './burst-config.mjs';
import {
  BURST_LANE_TAG,
  listQueueJobsForProject,
  routeBurstTicket,
  ticketHasBurstLane,
} from './burst-route.mjs';

const USAGE =
  'Usage: swarm queue list | swarm queue claim TICKET [--runner RUNNER_ID] | swarm queue release --expired\n';

export const JOB_GRANTS_DIR = '.swarm/job-grants';

export function jobGrantsRootForProject(root, project) {
  const custom = project?.sandbox?.grantsRoot;
  if (typeof custom === 'string' && custom.length > 0) {
    return path.isAbsolute(custom) ? custom : path.join(root, custom);
  }
  return path.join(root, JOB_GRANTS_DIR);
}

export function isolatedGrantSpec(project, env) {
  const needs = project?.sandbox?.needs;
  if (!Array.isArray(needs) || needs.length === 0) {
    throw new Error('isolated project requires sandbox.needs for job grants');
  }
  const values = {};
  for (const name of needs) {
    const value = env[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`missing ${name} for isolated job grant`);
    }
    values[name] = value;
  }
  return { needs, values };
}

export function formatIsolatedGrantStdout(grant) {
  return `grant-env ${SWARM_JOB_ID}=${grant.jobId} ${SWARM_JOB_GRANT_FILE}=${grant.envFile}\n`;
}

export async function readQueueProject(root, { project, readProject } = {}) {
  if (project !== undefined) return project;
  try {
    if (typeof readProject === 'function') return await readProject(root);
    const { readRunnerPointer } = await import('./runner-pointer.mjs');
    return await readRunnerPointer(root, { allowMissing: true });
  } catch {
    return {};
  }
}

/** Map a ledger ticket to a minimal queue row (tags align with ticketHasBurstLane / isCloudJob). */
export function ticketToQueueJob(ticket) {
  if (!ticket || typeof ticket.id !== 'string') return null;
  const tags = Array.isArray(ticket.tags) ? [...ticket.tags] : [];
  if (ticket.lane === 'burst' && !tags.includes(BURST_LANE_TAG)) {
    tags.push(BURST_LANE_TAG);
  }
  return {
    id: ticket.id,
    status: ticket.status,
    ...(tags.length ? { tags } : {}),
    ...(ticket.lane === 'burst' ? { lane: 'burst' } : {}),
  };
}

export function formatQueueListStdout(jobs) {
  const rows = (Array.isArray(jobs) ? jobs : [])
    .filter(Boolean)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(job => {
      const burst = isCloudJob(job) ? '\tlane:burst' : '';
      return `${job.id}\t${job.status}${burst}`;
    });
  return rows.length ? `${rows.join('\n')}\n` : '(empty)\n';
}

function parseClaimArgs(args) {
  if (args[0] !== 'claim') return { error: true };
  let ticketId = null;
  let runnerId = null;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runner') {
      const next = args[i + 1];
      if (typeof next !== 'string' || next.startsWith('-') || next.length === 0) return { error: true };
      runnerId = next;
      i++;
    } else if (arg.startsWith('-')) {
      return { error: true };
    } else if (ticketId === null) {
      ticketId = arg;
    } else {
      return { error: true };
    }
  }
  if (!ticketId) return { error: true };
  return { ticketId, runnerId };
}

export async function runQueueCommand(root, args, {
  env = process.env,
  home,
  now = Date.now,
  project,
  readProject,
  createJobGrant = defaultCreateJobGrant,
} = {}) {
  const at = () => (typeof now === 'function' ? now() : now);
  try {
    if (args[0] === 'list') {
      if (args.length !== 1) return { stdout: USAGE, exitCode: 1 };
      const ledger = await readLedger(root);
      const tickets = ledger?.tickets ?? [];
      const projectConfig = await readQueueProject(root, { project, readProject });
      const jobs = tickets.map(ticketToQueueJob).filter(Boolean);
      const visible = listQueueJobsForProject(jobs, projectConfig);
      return { stdout: formatQueueListStdout(visible), exitCode: 0 };
    }
    if (args[0] === 'claim') {
      const parsed = parseClaimArgs(args);
      if (parsed.error) return { stdout: USAGE, exitCode: 1 };
      const { ticketId, runnerId } = parsed;
      const holderId = await getNodeId({ env, home: home ?? env.HOME });
      const projectConfig = await readQueueProject(root, { project, readProject });
      if (burstEnabled(projectConfig)) {
        const ledger = await readLedger(root);
        const ticket = ledger?.tickets?.find(t => t.id === ticketId);
        if (ticket && ticketHasBurstLane(ticket)) {
          const routed = await routeBurstTicket(root, ticket, projectConfig, {
            runnerId,
            now: at(),
          });
          const holder = routed.lease.holderId;
          return { stdout: `claimed ${routed.lease.ticketId} for ${holder}\n`, exitCode: 0 };
        }
      }
      let isolatedSpec;
      if (isProjectIsolationEnabled(projectConfig)) {
        isolatedSpec = isolatedGrantSpec(projectConfig, env);
      }
      const result = await claim(root, ticketId, holderId, { now: at() });
      let stdout = `claimed ${result.ticketId} for ${result.holderId}\n`;
      if (isolatedSpec) {
        try {
          const grant = await createJobGrant({
            grantsRoot: jobGrantsRootForProject(root, projectConfig),
            jobId: result.ticketId,
            needs: isolatedSpec.needs,
            values: isolatedSpec.values,
          });
          stdout += formatIsolatedGrantStdout(grant);
        } catch (grantError) {
          await release(root, result.ticketId, result.fencingToken, { now: at() });
          throw grantError;
        }
      }
      return { stdout, exitCode: 0 };
    }
    if (args[0] === 'release') {
      if (args.length !== 2 || args[1] !== '--expired') return { stdout: USAGE, exitCode: 1 };
      const { swept } = await sweepExpiredLeases(root, { now: at() });
      if (!swept.length) return { stdout: 'no expired leases to release\n', exitCode: 0 };
      return { stdout: `released expired: ${swept.join(', ')}\n`, exitCode: 0 };
    }
    return { stdout: USAGE, exitCode: 1 };
  } catch (error) {
    if (error.code === 'lease-held') {
      return { stdout: `claim rejected: ${error.message}\n`, exitCode: 1 };
    }
    return { stdout: `${String(error.message ?? error).split('\n')[0]}\n`, exitCode: 1 };
  }
}
