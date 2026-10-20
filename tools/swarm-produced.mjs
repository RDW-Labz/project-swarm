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
      const file = path.join(runsDir, name, 'state.json');
      try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
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
