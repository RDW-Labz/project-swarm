// SPDX-License-Identifier: Apache-2.0
// `swarm queue claim|release`: single-machine lease claim and expired-lease sweep (cluster queue CLI).
import path from 'node:path';
import { claim, sweepExpiredLeases } from './ledger-lease.mjs';
import { getNodeId } from './node-identity.mjs';
import {
  createJobGrant as defaultCreateJobGrant,
  SWARM_JOB_GRANT_FILE,
  SWARM_JOB_ID,
} from './job-grants.mjs';
import { isProjectIsolationEnabled } from './job-sandbox.mjs';

const USAGE = 'Usage: swarm queue claim TICKET | swarm queue release --expired\n';

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
  if (typeof readProject === 'function') return await readProject(root);
  const { readRunnerPointer } = await import('./runner-pointer.mjs');
  try {
    return await readRunnerPointer(root, { allowMissing: true });
  } catch {
    return {};
  }
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
    if (args[0] === 'claim') {
      if (args.length !== 2 || args[1].startsWith('-')) return { stdout: USAGE, exitCode: 1 };
      const ticketId = args[1];
      const holderId = await getNodeId({ env, home: home ?? env.HOME });
      const projectConfig = await readQueueProject(root, { project, readProject });
      const result = await claim(root, ticketId, holderId, { now: at() });
      let stdout = `claimed ${result.ticketId} for ${result.holderId}\n`;
      if (isProjectIsolationEnabled(projectConfig)) {
        const spec = isolatedGrantSpec(projectConfig, env);
        const grant = await createJobGrant({
          grantsRoot: jobGrantsRootForProject(root, projectConfig),
          jobId: result.ticketId,
          needs: spec.needs,
          values: spec.values,
        });
        stdout += formatIsolatedGrantStdout(grant);
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
