// SPDX-License-Identifier: Apache-2.0
// `swarm "status --json"` is a mistyped command, not a goal: a goal starts a paid run, so a sentence that LOOKS like a command is refused before anything is planned.
import { COMMANDS } from './completion.mjs';

const KNOWN = new Set([...COMMANDS.map(c => c.name), 'status', 'decide', 'done', 'inbox', 'help', 'version', 'doctor', 'watch', 'update', 'board', 'ledger', 'idle']);
const FLAG = /(^|\s)--[A-Za-z][\w-]*/;

// A command-looking goal is: a `--flag` anywhere in it, or a known subcommand as the first word of a SHORT sentence (up to three words: "status", "doctor all",
// "decide logo blue"). A real sentence that merely starts with a verb that is also a subcommand ("plan the dealer portal", "run the migration checks") is a goal;
// it still shows its cost and asks before anything runs.
export function commandLikeGoal(goal) {
  const text = String(goal ?? '').trim();
  if (!text) return null;
  const words = text.split(/\s+/);
  const first = words[0];
  const startsLikeCommand = /^[a-z][a-z-]*$/.test(first) && KNOWN.has(first) && words.length <= 3;
  const flagAt = text.search(FLAG);
  if (!startsLikeCommand && flagAt === -1) return null;
  if (startsLikeCommand) return { command: first, suggestion: `swarm ${text}` };
  // Flags typed inside the quotes: they belong outside them.
  const sentence = text.slice(0, flagAt).trim();
  const flags = text.slice(flagAt).trim();
  return { command: null, suggestion: sentence ? `swarm go "${sentence}" ${flags}` : `swarm ${text}` };
}

export const commandLikeMessage = goal => {
  const hit = commandLikeGoal(goal);
  return hit ? `refusing to start a run: "${String(goal).slice(0, 80)}" looks like a command, not a goal. Did you mean: ${hit.suggestion}? (A goal is a sentence about what to build; it shows its capped cost and asks first.)` : null;
};
