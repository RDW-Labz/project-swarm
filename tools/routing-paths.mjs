// SPDX-License-Identifier: Apache-2.0
// Paths the swarm uses for routing and coordination: never hand-built edits and never blocked by the guard.

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
