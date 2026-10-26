// SPDX-License-Identifier: Apache-2.0
// `swarm orchestrator status`: live slot use per registered project (CLI wiring in tools/swarm.mjs is a follow-up).
import fs from 'node:fs/promises';
import { formatOrchestratorStatus } from './chief-status.mjs';
import { boardSummary, liveDir } from './board.mjs';
import { listProjects, projectsFile } from './projects.mjs';
import { loadLocalConfig } from './local-config.mjs';
import { machineConcurrency } from './lanes.mjs';

const USAGE = 'Usage: swarm orchestrator status\n';

async function runningSlotsByRoot(runs) {
  const slotsByRoot = new Map();
  for (const run of runs) {
    let runRoot;
    try {
      runRoot = await fs.realpath(run.root);
    } catch {
      continue;
    }
    const running = (run.jobs ?? []).filter((job) => job.status === 'running').length;
    if (!running) continue;
    slotsByRoot.set(runRoot, (slotsByRoot.get(runRoot) ?? 0) + running);
  }
  return slotsByRoot;
}

async function gatherOrchestratorState({ env = process.env }) {
  const config = loadLocalConfig({ env });
  const machineCap = machineConcurrency(config);
  const registered = await listProjects({ file: projectsFile(env) });
  const { runs } = await boardSummary({ dir: liveDir(env) });
  const slotsByRoot = await runningSlotsByRoot(runs);
  const projects = [];
  for (const entry of registered) {
    let root;
    try {
      root = await fs.realpath(entry.root);
    } catch {
      root = entry.root;
    }
    const slots = slotsByRoot.get(root) ?? 0;
    projects.push({
      project: entry.name,
      path: entry.root,
      slots,
    });
  }
  return { machineCap, projects };
}

export async function runOrchestratorCommand(root, args, { env = process.env } = {}) {
  try {
    if (args[0] === 'status') {
      if (args.length !== 1) return { stdout: USAGE, exitCode: 1 };
      const state = await gatherOrchestratorState({ env });
      return { stdout: `${formatOrchestratorStatus(state)}\n`, exitCode: 0 };
    }
    return { stdout: USAGE, exitCode: 1 };
  } catch (error) {
    return { stdout: `${String(error.message ?? error).split('\n')[0]}\n`, exitCode: 1 };
  }
}
