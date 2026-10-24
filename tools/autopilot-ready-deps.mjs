// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMachine } from './autotune.mjs';
import { listRequests } from './handbuild.mjs';
import { loadLocalConfig, resolveAutopilotStartReady } from './local-config.mjs';
import {
  effectiveMachineLimit,
  memoryPressureHoldLine,
  memoryPressureLevel,
} from './machine-limit.mjs';

const swarmEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'swarm.mjs');
const realpathCache = new Map();

function canonicalRoot(root) {
  if (typeof root !== 'string' || !root) return null;
  const resolved = path.resolve(root);
  if (realpathCache.has(resolved)) return realpathCache.get(resolved);
  let canonical;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  realpathCache.set(resolved, canonical);
  return canonical;
}

export function sameRoot(a, b) {
  const ca = canonicalRoot(a);
  const cb = canonicalRoot(b);
  if (ca === null || cb === null) return false;
  return ca === cb;
}

function ticketFiles(ticket) {
  if (!ticket || typeof ticket !== 'object') return [];
  if (Array.isArray(ticket.files)) return ticket.files.map(String);
  if (typeof ticket.file === 'string' && ticket.file) return [ticket.file];
  return [];
}

/** Dependency bundle for autopilot start-ready (live runs, busy markers, cap, go --scope). */
export function readyAutopilotDeps(projectRoot, {
  env = process.env,
  memoryAware = true,
  spawnImpl,
  selfPid = process.pid,
  liveBusyMarkers,
  listLiveRuns,
  checkProjectCap,
  readTickets,
  readPending,
  readMachine: readMachineImpl = readMachine,
  log = line => process.stderr.write(`${line}\n`),
} = {}) {
  const rootForMarkers = projectRoot;

  async function allTickets(root) {
    return readTickets(root);
  }

  return {
    readTickets: allTickets,

    async readyTickets(root) {
      const tickets = await readTickets(root);
      const list = Array.isArray(tickets) ? tickets : [];
      return list.filter(t => t && t.status === 'ready').map(t => ({ ...t, files: ticketFiles(t) }));
    },

    async pendingApprovals(root) {
      const hand = listRequests(root)
        .filter(r => r && r.status === 'pending')
        .map(r => ({ status: 'pending', files: Array.isArray(r.files) ? r.files.map(String) : [] }));
      const pending = await readPending(root);
      const ticketApprovals = (Array.isArray(pending) ? pending : [])
        .filter(a => a && a.status === 'pending')
        .map(a => ({ status: 'pending', files: Array.isArray(a.files) ? a.files.map(String) : [] }));
      return [...hand, ...ticketApprovals];
    },

    async liveRuns(root) {
      const runs = await listLiveRuns();
      const list = Array.isArray(runs) ? runs : [];
      return list.filter(run => run && sameRoot(run.root, root));
    },

    async busyMarkers() {
      const markers = await liveBusyMarkers();
      const list = Array.isArray(markers) ? markers : [];
      return list.filter(m => m && m.pid !== selfPid && rootForMarkers && sameRoot(m.root, rootForMarkers));
    },

    async capRoom(root) {
      const capped = await checkProjectCap(root, { env });
      return capped == null;
    },

    async autopilotStartReadySettings(root, { freeSlots } = {}) {
      let autopilotCfg = null;
      try { autopilotCfg = loadLocalConfig({ env })?.autopilot ?? null; } catch { autopilotCfg = null; }
      let project = null;
      try {
        const pointer = JSON.parse(await fsPromises.readFile(path.join(path.resolve(root), '.project-swarm.json'), 'utf8'));
        project = pointer?.autopilot ?? null;
      } catch { project = null; }
      const tickets = await allTickets(root);
      const doneTicketCount = (Array.isArray(tickets) ? tickets : []).filter(t => t?.status === 'done').length;
      const settings = resolveAutopilotStartReady({ machine: autopilotCfg, project, freeSlots, doneTicketCount });
      if (!memoryAware) return settings;
      let config = {};
      try { config = loadLocalConfig({ env }) ?? {}; } catch { config = {}; }
      let hw;
      try { hw = await readMachineImpl(); } catch { return settings; }
      const ceiling = Number.isInteger(settings?.maxJobs) && settings.maxJobs > 0 ? settings.maxJobs : 1;
      const { effective } = effectiveMachineLimit({ limit: ceiling, machine: hw, config });
      return { ...settings, maxJobs: Math.min(ceiling, effective) };
    },

    async startScope({ root, maxJobs, skipSkeleton = false }) {
      const cwd = path.resolve(root);
      let jobs = Number.isInteger(maxJobs) && maxJobs > 0 ? maxJobs : 1;
      if (memoryAware) {
        let config = {};
        try { config = loadLocalConfig({ env }) ?? {}; } catch { config = {}; }
        let hw;
        try { hw = await readMachineImpl(); } catch { hw = null; }
        if (hw && memoryPressureLevel(hw) === 'hard') {
          log(memoryPressureHoldLine(hw));
          return { ok: true, result: 'held-memory' };
        }
        if (hw) {
          const { effective } = effectiveMachineLimit({ limit: jobs, machine: hw, config });
          jobs = Math.min(jobs, effective);
        }
      }
      const args = [swarmEntry, '--root', cwd, 'go', '--scope', '--max-jobs', String(jobs)];
      if (skipSkeleton) args.push('--skip-skeleton');
      try {
        const child = spawnImpl(process.execPath, args, {
          detached: true,
          stdio: 'ignore',
          env,
          cwd,
        });
        return await new Promise((resolve) => {
          let settled = false;
          const finish = (out) => {
            if (settled) return;
            settled = true;
            resolve(out);
          };
          child.once('error', (error) => finish({ ok: false, result: String(error?.message ?? error) }));
          // Deliberately detached: the child may outlive autopilot and is guarded by its own busy marker.
          queueMicrotask(() => {
            if (settled) return;
            child.unref();
            finish({ ok: true, result: `started go --scope (pid ${child.pid})` });
          });
        });
      } catch (error) {
        return { ok: false, result: String(error?.message ?? error) };
      }
    },
  };
}
