// SPDX-License-Identifier: Apache-2.0
// Lesson 26: stopping a process by a loose pattern (pkill -f cat, killall node) can kill things that are not ours (it took down Docker Desktop mid-run).
// A command the swarm will run for you must stop only a process it started, by id.
// Allowed: kill PID, pkill -P PARENT_PID, pkill -F PIDFILE, and a command that only searches for or prints the word (grep, rg, echo).
const SEGMENT_END = /[;&|\n]/;
const KILLERS = /(?:^|[\s;&|(`"'\/])(?:pkill|killall)(?=\s|$)/g;
// A kill fed by a name or port search (not by a pid file or a parent id).
const FED_KILL = /\b(?:pgrep|pidof|lsof)\b(?![^|;&)`]*\s-[A-Za-z]*P\b)[^;&]*\|\s*xargs\s+(?:-\S+\s+)*kill\b|\bkill\s+(?:-\S+\s+)*(?:\$\(|`)\s*(?:pgrep|pidof|lsof)\b(?![^)`]*\s-[A-Za-z]*P\b)/;
const OTHER = /\bfuser\s+(?:-\S+\s+)*-k\b|\bkill-port\b/;

function looseKillIn(text) {
  const source = String(text ?? '');
  KILLERS.lastIndex = 0;
  for (let m = KILLERS.exec(source); m; m = KILLERS.exec(source)) {
    const start = Math.max(source.lastIndexOf(';', m.index), source.lastIndexOf('&', m.index), source.lastIndexOf('|', m.index), source.lastIndexOf('\n', m.index)) + 1;
    const rest = source.slice(m.index + m[0].length);
    const end = rest.search(SEGMENT_END);
    const args = end === -1 ? rest : rest.slice(0, end);
    if (/\s-[A-Za-z]*[PF]\b/.test(args)) continue;
    if (/\b(?:grep|egrep|rg|echo|printf)\b/.test(source.slice(start, m.index))) continue;
    return true;
  }
  return FED_KILL.test(source) || OTHER.test(source);
}

export const looseKill = looseKillIn;

export const LOOSE_KILL_RULE = 'Never stop a process by a loose pattern (pkill -f, killall, kill $(pgrep ...)): it can kill programs that are not yours, such as Docker. Stop only a process you started, by its process id.';

// The commands in a manifest that the runner executes: checks, preChecks and job setup.
export function looseKillCommands(manifest) {
  const found = [];
  const list = value => (Array.isArray(value) ? value : []);
  const add = (where, argv) => { if (Array.isArray(argv) && looseKillIn(argv.join(' '))) found.push(`${where}: ${argv.join(' ').slice(0, 80)}`); };
  for (const check of list(manifest?.checks)) add(`check ${check?.name ?? ''}`.trim(), check?.argv);
  for (const check of list(manifest?.preChecks)) add(`preCheck ${check?.name ?? ''}`.trim(), check?.argv);
  for (const job of list(manifest?.jobs)) for (const argv of list(job?.setup)) add(`job ${job?.id ?? ''} setup`.trim(), argv);
  return found;
}
