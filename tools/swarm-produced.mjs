// SPDX-License-Identifier: Apache-2.0
// Project-relative paths integrated from swarm runs (file lists and content hashes).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function eachIntegratedState(root, fn) {
  const runsDir = path.join(root, '.swarm', 'runs');
  try {
    for (const name of fs.readdirSync(runsDir)) {
      const runDir = path.join(runsDir, name);
      let dirSt;
      try { dirSt = fs.lstatSync(runDir); } catch { continue; }
      if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) continue;
      const file = path.join(runDir, 'state.json');
      try {
        const fileSt = fs.lstatSync(file);
        if (fileSt.isSymbolicLink() || !fileSt.isFile()) continue;
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (String(state?.id ?? '') !== name) continue;
        if (!state?.integratedAt) continue;
        fn(state);
      } catch { /* unreadable run state */ }
    }
  } catch { /* no runs dir */ }
}

/** Union of integratedFiles and integratedNewFiles from every integrated run state.json under .swarm/runs. */
export function swarmProducedFiles(root) {
  const out = new Set();
  eachIntegratedState(root, state => {
    for (const list of [state.integratedFiles, state.integratedNewFiles]) {
      if (!Array.isArray(list)) continue;
      for (const rel of list) {
        if (typeof rel === 'string' && rel) out.add(rel.replace(/\\/g, '/'));
      }
    }
  });
  return out;
}

/** Paths to the set of integrated sha256 hex digests recorded for that path across integrated runs. */
export function swarmProducedHashes(root) {
  const out = new Map();
  eachIntegratedState(root, state => {
    const hashes = state.integratedHashes;
    if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) return;
    for (const [rel, hex] of Object.entries(hashes)) {
      if (typeof rel !== 'string' || !rel || typeof hex !== 'string' || !hex) continue;
      const key = rel.replace(/\\/g, '/');
      if (!out.has(key)) out.set(key, new Set());
      out.get(key).add(hex);
    }
  });
  return out;
}

/** True only when bytes digest to a hash recorded for this path (no hash on file → not swarm-produced). */
export function isSwarmProducedContent(root, rel, bytes) {
  const key = String(rel ?? '').replace(/\\/g, '/');
  if (!key) return false;
  const set = swarmProducedHashes(root).get(key);
  if (!set?.size) return false;
  return set.has(digest(bytes));
}
