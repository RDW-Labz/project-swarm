// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRequests } from './handbuild.mjs';

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
      const cwd = path.resolve(root);
      try {
        const child = spawnImpl(process.execPath, [swarmEntry, '--root', cwd, 'go', '--scope'], {
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
