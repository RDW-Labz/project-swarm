// SPDX-License-Identifier: Apache-2.0
// Paths the swarm uses for routing and coordination: never hand-built edits and never blocked by the guard.

import fs from 'node:fs';
import path from 'node:path';

export const ROUTING_RULE = 'Routing files (manifests, handoffs, plans, and swarm state under coordination/ and docs/state/) are updated by the swarm, not by hand.';

const norm = p => String(p).replace(/\\/g, '/');

/** True when `rel` is a project-relative routing path (forward slashes, compared case-insensitively). */
export function isRoutingPath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const r = norm(rel);
  if (r.includes('..')) return false;
  const lower = r.toLowerCase();
  if (lower.startsWith('coordination/manifests/') && lower.endsWith('.json')) return true;
  const slash = lower.lastIndexOf('/');
  const dir = slash === -1 ? '' : lower.slice(0, slash);
  const base = slash === -1 ? lower : lower.slice(slash + 1);
  const coordRootNames = new Set(['handoff.md', 'task.md', 'build-plan.md']);
  if (dir === '' && coordRootNames.has(base)) return true;
  if (dir === 'coordination' && coordRootNames.has(base)) return true;
  if (dir === 'coordination' && (base === 'handoff.previous.md' || base === 'handoff.previous-2.md')) return true;
  if (lower === 'docs/state/usage-ledger.md') return true;
  if (lower === 'docs/state/eval-scores.ndjson') return true;
  if (lower === 'coordination/swarm-lessons.jsonl') return true;
  return false;
}

const realOf = p => {
  let cur = p;
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      tail.push(path.basename(cur));
      cur = up;
    }
  }
  return p;
};

const insideProject = (root, file) => {
  if (typeof file !== 'string' || !file) return null;
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const rel = norm(path.relative(realOf(root), realOf(abs)));
  return !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel) ? rel : null;
};

/** After resolving symlinks, `rel` must stay in the project and still match a routing path. */
export function isRoutingPathResolved(root, rel) {
  if (!isRoutingPath(rel)) return false;
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.join(root, rel);
  const resolved = realOf(abs);
  const inner = insideProject(root, resolved);
  return inner !== null && isRoutingPath(inner);
}
