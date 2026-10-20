// SPDX-License-Identifier: Apache-2.0
// Detect shell commands that try to record chat merge approvals or approve hand-build / guard state from an orchestrator session.

export const SELF_APPROVAL_REASON = 'Hand-build guard: approving or denying a hand-build, or switching the guard off, is the owner\'s alone (swarm handbuild approve, or the phone). An orchestrator session cannot approve its own request.';

const MARKERS = [
  /orchestrator-hook(?:\.mjs)?/i,
  /\brecordChatMerge\b/,
  /\bswarm\s+handbuild\s+(?:approve|deny|on|off|uninstall)\b/i,
  /\bhandbuild\s+approve\b/i,
  /\binbox-commands(?:\.mjs)?\b/i,
  /\.swarm\/handbuild\b/,
  /\bnode\b[^\n|;&]*\bswarm\.mjs\b[^\n|;&]*\bdecide\b[^\n|;&]*\bhandbuild-/i,
  /\bswarm\s+decide\b/i,
  /\bclaude\b(?:\s+(?:-p|--print)\b|\s+["'])/i,
  /\btmux\s+(?:send-keys|new-session|split-window)\b[^\n|;&]*(?:\bswarm\b|\bnode\b)/i,
  /\bscript\b/i,
  /\bosascript\b/i,
  /\bexpect\b/i,
  /base64\b[^\n|;&]*\|\s*(?:sh|bash|zsh|node)\b/i,
  /\b(?:approve|deny|off|on)\b[^\n|;&]*\bhandbuild-/i,
  /\bhandbuild-[^\s|;&"']+[\s|;&]+(?:approve|deny)\b/i,
];

const SHELL_CODE_RE = /\b(?:bash|sh|zsh)\s+(?:[^\s|;&]+\s+)*-(?:[A-Za-z]*c|--command)(?:=|\s+)(['"])([\s\S]*?)\1/gi;
const EVAL_RE = /\beval\s+(['"])([\s\S]*?)\1/gi;

function nestedCommandStrings(text) {
  const out = [];
  const s = String(text ?? '');
  for (const re of [SHELL_CODE_RE, EVAL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) out.push(m[2]);
  }
  const hd = /<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n([\s\S]*?)\n\1/g;
  let h;
  while ((h = hd.exec(s)) !== null) out.push(h[2]);
  return out;
}

/** Conservative check on raw command text (including nested bash -c / eval / pipes). */
export function isSelfApprovalCommand(commandText) {
  const text = String(commandText ?? '');
  if (!text) return false;
  if (MARKERS.some(re => re.test(text))) return true;
  for (const inner of nestedCommandStrings(text)) {
    if (isSelfApprovalCommand(inner)) return true;
  }
  return false;
}
