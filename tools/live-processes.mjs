// SPDX-License-Identifier: Apache-2.0
// Swarm commands that are running on this machine right now, found from the process list. A `swarm go --scope` loop between two waves has no run registered yet, so the board's live-run
// list says "idle" while the machine is not: `swarm update` also looks here before it moves the install.
import { execFileSync } from 'node:child_process';

// The long-running commands: a loop, a run, an integration, a scale test, a guarded command, autopilot, a ship, a ticket pipeline, a sweep.
const BUSY_VERBS = new Set(['go', 'run', 'integrate', 'autopilot', 'ship', 'scale', 'with-concurrency', 'ticket', 'sweep']);
// The verb is the first word after swarm.mjs (or `swarm`) that is not an option or the value of --root.
function verbOf(command) {
  const words = command.trim().split(/\s+/);
  const at = words.findIndex(w => /(?:^|\/)swarm(?:\.mjs)?$/.test(w));
  if (at === -1) return null;
  for (let i = at + 1; i < words.length; i += 1) {
    if (words[i] === '--root') { i += 1; continue; }
    if (words[i].startsWith('-')) continue;
    return words[i];
  }
  return null;
}

export function runningSwarmCommands({ ps, selfPid = process.pid, installDirs = null } = {}) {
  let text = '';
  try { text = ps ? ps() : execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === selfPid || pid === process.ppid) continue;
    const command = m[2];
    // only a node process running swarm itself; not an editor, a grep or this ps
    if (!/\bnode\b|\.mjs\b/.test(command) || /\bps\b|grep/.test(command.split(/\s+/)[0] ?? '')) continue;
    // With installDirs: only commands running code from one of those installs (a run from a development checkout is not affected by updating an install).
    if (installDirs && !installDirs.some(d => command.includes(`${d}/`) || command.includes(`${d}\\`))) continue;
    const verb = verbOf(command);
    if (verb && BUSY_VERBS.has(verb)) out.push({ pid, command: command.replace(/\s+/g, ' ').slice(0, 160), verb });
  }
  return out;
}
