// SPDX-License-Identifier: Apache-2.0
// `swarm "status --json"` is a mistyped command, not a goal: a goal starts a paid run, so a sentence that LOOKS like a command is refused before anything is planned.
// Only the goal line (first line after trim) is checked: fleet bots pass an issue title plus a markdown spec body that often mentions CLI flags that are not typos.
import { COMMANDS } from './completion.mjs';

const KNOWN = new Set([...COMMANDS.map(c => c.name), 'status', 'decide', 'done', 'inbox', 'help', 'version', 'doctor', 'watch', 'update', 'board', 'ledger', 'idle']);
const FLAG = /(^|\s)--[A-Za-z][\w-]*/;

// A command-looking goal is: a `--flag` on the goal line, or a known subcommand as the first word of a SHORT goal line (up to three words: "status", "doctor all",
// "decide logo blue"). A real sentence that merely starts with a verb that is also a subcommand ("plan the dealer portal", "run the migration checks") is a goal;
// it still shows its cost and asks before anything runs.
export function commandLikeGoal(goal) {
  const text = String(goal ?? '').trim();
  if (!text) return null;
  const line = text.split(/\r?\n/)[0].trim();
  if (!line) return null;
  const words = line.split(/\s+/);
  const first = words[0];
  const startsLikeCommand = /^[a-z][a-z-]*$/.test(first) && KNOWN.has(first) && words.length <= 3;
  const flagAt = line.search(FLAG);
  if (!startsLikeCommand && flagAt === -1) return null;
  if (startsLikeCommand) return { command: first, suggestion: `swarm ${line}` };
  // Flags typed inside the quotes: they belong outside them.
  const sentence = line.slice(0, flagAt).trim();
  const flags = line.slice(flagAt).trim();
  return { command: null, suggestion: sentence ? `swarm go "${sentence}" ${flags}` : `swarm ${line}` };
}

export const commandLikeMessage = goal => {
  const hit = commandLikeGoal(goal);
  return hit ? `refusing to start a run: "${String(goal).slice(0, 80)}" looks like a command, not a goal. Did you mean: ${hit.suggestion}? (A goal is a sentence about what to build; it shows its capped cost and asks first.)` : null;
};
