// SPDX-License-Identifier: Apache-2.0
// Lesson 26: stopping a process by a loose pattern (pkill -f cat, killall node) can kill things that are not ours (it took down Docker Desktop mid-run).
// A command the swarm will run for you must stop only a process it started, by id.
const LOOSE_KILL = /(?:^|[\s;&|(`"'])(?:pkill|killall)(?=\s|$)|\bxargs\s+(?:-\S+\s+)*kill\b|\bkill\s+(?:-\S+\s+)*(?:\$\(|`)\s*pgrep\b/;

export const looseKill = text => LOOSE_KILL.test(String(text ?? ''));

export const LOOSE_KILL_RULE = 'Never stop a process by a loose pattern (pkill -f, killall, kill $(pgrep ...)): it can kill programs that are not yours, such as Docker. Stop only a process you started, by its process id.';

// The commands in a manifest that the runner executes: checks, preChecks and job setup.
export function looseKillCommands(manifest) {
  const found = [];
  const add = (where, argv) => { if (Array.isArray(argv) && looseKill(argv.join(' '))) found.push(`${where}: ${argv.join(' ').slice(0, 80)}`); };
  for (const check of manifest?.checks ?? []) add(`check ${check?.name ?? ''}`.trim(), check?.argv);
  for (const check of Array.isArray(manifest?.preChecks) ? manifest.preChecks : []) add(`preCheck ${check?.name ?? ''}`.trim(), check?.argv);
  for (const job of manifest?.jobs ?? []) for (const argv of Array.isArray(job?.setup) ? job.setup : []) add(`job ${job?.id ?? ''} setup`.trim(), argv);
  return found;
}
