// SPDX-License-Identifier: Apache-2.0
// `swarm selfmanage lanes`: lane health snapshot for operators.
import { readLaneHealth as defaultReadLaneHealth } from './lane-health.mjs';

export const USAGE = 'Usage: swarm selfmanage lanes\n';

export function formatLanesStdout(snapshot) {
  const lanes = snapshot?.lanes ?? {};
  const rows = Object.keys(lanes)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(name => {
      const entry = lanes[name];
      const state = entry?.state ?? 'unknown';
      const reason = entry?.reason ?? '';
      let line = `${name}\t${state}\t${reason}`;
      if (entry?.probation?.active === true) {
        const checksOk = entry.probation.checksOk ?? 0;
        const jobsOk = entry.probation.jobsOk ?? 0;
        line += `\tprobation\t${checksOk}\t${jobsOk}`;
      }
      return line;
    });
  return rows.length ? `${rows.join('\n')}\n` : '(empty)\n';
}

export async function runSelfManageCommand(root, args, {
  env = process.env,
  home,
  now = Date.now,
  readLaneHealth = defaultReadLaneHealth,
} = {}) {
  try {
    if (args[0] === 'lanes') {
      if (args.length !== 1) return { stdout: USAGE, exitCode: 1 };
      const snapshot = await readLaneHealth({
        home: home ?? env.HOME,
        env,
      });
      return { stdout: formatLanesStdout(snapshot), exitCode: 0 };
    }
    return { stdout: USAGE, exitCode: 1 };
  } catch (error) {
    return { stdout: `${String(error.message ?? error).split('\n')[0]}\n`, exitCode: 1 };
  }
}
