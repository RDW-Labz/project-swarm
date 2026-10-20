// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRequests } from './handbuild.mjs';

const swarmEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'swarm.mjs');

function sameRoot(a, b) {
  return path.resolve(a) === path.resolve(b);
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
  spawnImpl,
  selfPid = process.pid,
  liveBusyMarkers,
  listLiveRuns,
  checkProjectCap,
  readTickets,
  readPending,
} = {}) {
  const rootForMarkers = projectRoot;

  return {
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

    async startScope({ root }) {
      try {
        const child = spawnImpl(process.execPath, [swarmEntry, '--root', path.resolve(root), 'go', '--scope'], {
          detached: true,
          stdio: 'ignore',
          env,
        });
        child.unref();
        return { ok: true, result: `started go --scope (pid ${child.pid})` };
      } catch (error) {
        return { ok: false, result: String(error?.message ?? error) };
      }
    },
  };
}
