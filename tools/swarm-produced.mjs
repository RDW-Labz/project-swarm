// SPDX-License-Identifier: Apache-2.0
// Project-relative paths integrated from swarm runs (file lists only, no content hashes).

import fs from 'node:fs';
import path from 'node:path';

/** Union of integratedFiles and integratedNewFiles from every integrated run state.json under .swarm/runs. */
export function swarmProducedFiles(root) {
  const out = new Set();
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
        for (const list of [state.integratedFiles, state.integratedNewFiles]) {
          if (!Array.isArray(list)) continue;
          for (const rel of list) {
            if (typeof rel === 'string' && rel) out.add(rel.replace(/\\/g, '/'));
          }
        }
      } catch { /* unreadable run state */ }
    }
  } catch { /* no runs dir */ }
  return out;
}
