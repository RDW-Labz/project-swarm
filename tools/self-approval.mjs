// SPDX-License-Identifier: Apache-2.0
// Detect shell commands that try to record chat merge approvals or approve hand-build / guard state from an orchestrator session.

export const SELF_APPROVAL_REASON = 'Hand-build guard: approving or denying a hand-build, or switching the guard off, is the owner\'s alone (swarm handbuild approve, or the phone). An orchestrator session cannot approve its own request.';

const SHELL_CODE_RE = /\b(?:bash|sh|zsh)\s+(?:[^\s|;&]+\s+)*-(?:[A-Za-z]*c|--command)(?:=|\s+)(['"])([\s\S]*?)\1/gi;
const EVAL_RE = /\beval\s+(['"])([\s\S]*?)\1/gi;

/** Strip escapes, quotes, dollar-quote openers; collapse space; lower-case. */
export function normalizeSelfApprovalCommandText(commandText) {
  let s = String(commandText ?? '');
  s = s.replace(/\\(.)/g, '$1');
  s = s.replace(/\$'|\$"/g, '');
  s = s.replace(/['"]/g, '');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

const HAND_BUILD_ACTION = /\b(?:swarm\s+)?handbuild\s+(?:approve|deny|on|off|install|uninstall)\b/;
const HAND_BUILD_ACTION_NODE = /\bnode\b(?:\s+\S+)*\bswarm\.mjs\b(?:\s+\S+)*\bhandbuild\s+(?:approve|deny|on|off|install|uninstall)\b/;
const DECIDE_APPROVE = /\b(?:swarm\s+)?decide\b\S*\s+approve\b|\bdecide\b[\s\S]*\bapprove\b/;
const SWARM_INLINE = /\b(?:node|python3?)\b[\s\S]*\bswarm\b[\s\S]*\b(?:decide|handbuild)\b/;

const SAFE_SWARM = [
  /\bhandbuild\s+request\b/,
  /\bhandbuild\s+status\b/,
  /\bswarm\s+go\b/,
  /\bswarm\s+run\b/,
  /\bswarm\s+tickets\b/,
];

const CLAUDE_KNOWN_SUBCOMMANDS = new Set([
  'mcp', 'config', 'doctor', 'update', 'install', 'plugin', 'remote-control', 'login',
]);
const PROGRAM_WRAPPERS = new Set(['env', 'command', 'exec', 'nice', 'nohup', 'time', 'sudo', 'xargs']);

function claudeProgramBasename(token) {
  const base = token.split('/').pop();
  return base === 'claude';
}

function skipProgramWrappers(tokens, start) {
  let i = start;
  while (i < tokens.length && PROGRAM_WRAPPERS.has(tokens[i])) {
    const wrapper = tokens[i];
    i += 1;
    if (wrapper === 'env') {
      while (i < tokens.length && /^[a-z_][a-z0-9_]*=/i.test(tokens[i])) i += 1;
    } else if (wrapper === 'sudo' || wrapper === 'xargs') {
      while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
    }
  }
  return i;
}

function claudeHasHeadlessOrPromptArgs(tokens, claudeIndex) {
  const rest = tokens.slice(claudeIndex + 1);
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (t === '-p' || t === '--print') return true;
    if (t.startsWith('-')) continue;
    if (CLAUDE_KNOWN_SUBCOMMANDS.has(t)) return false;
    return true;
  }
  return false;
}

/** Headless Claude Code: claude as the invoked program with -p, --print, or a positional prompt. */
function normalizedHasHeadlessClaudeInvocation(normalized) {
  const segments = normalized.split(/\s*(?:[|;&]|\&\&|\|\|)\s*/);
  for (const seg of segments) {
    let trimmed = seg.trim();
    if (!trimmed) continue;
    trimmed = trimmed.replace(/\s*&\s*$/, '').trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const prog = skipProgramWrappers(tokens, 0);
    if (prog >= tokens.length) continue;
    if (tokens[prog] !== 'claude' && !claudeProgramBasename(tokens[prog])) continue;
    if (claudeHasHeadlessOrPromptArgs(tokens, prog)) return true;
  }
  return false;
}

const STATIC_MARKERS = [
  /\borchestrator-hook(?:\.mjs)?\b/,
  /\brecordchatmerge\b/,
  /\binbox-commands(?:\.mjs)?\b/,
  /\.swarm\/handbuild\b/,
  /\btmux\s+(?:send-keys|new-session|split-window)\b[\s\S]*(?:\bswarm\b|\bnode\b)/,
  /\bscript\b/,
  /\bosascript\b/,
  /\bexpect\b/,
  /base64\b[\s\S]*\|\s*(?:sh|bash|zsh|node)\b/,
];

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

function matchesNormalized(normalized) {
  if (!normalized) return false;
  if (SAFE_SWARM.some(re => re.test(normalized))) return false;
  if (STATIC_MARKERS.some(re => re.test(normalized))) return true;
  if (normalizedHasHeadlessClaudeInvocation(normalized)) return true;
  if (HAND_BUILD_ACTION.test(normalized)) return true;
  if (HAND_BUILD_ACTION_NODE.test(normalized)) return true;
  if (DECIDE_APPROVE.test(normalized)) return true;
  if (SWARM_INLINE.test(normalized)) return true;
  if (/\bhandbuild-[^\s|;&]+[\s|;&]+(?:approve|deny)\b/.test(normalized)) return true;
  if (/\b(?:approve|deny|off|on)\b[\s\S]*\bhandbuild-/.test(normalized)) return true;
  return false;
}

/** Conservative check on raw command text (including nested bash -c / eval / pipes). */
export function isSelfApprovalCommand(commandText) {
  const text = String(commandText ?? '');
  if (!text) return false;
  const normalized = normalizeSelfApprovalCommandText(text);
  if (matchesNormalized(normalized)) return true;
  for (const inner of nestedCommandStrings(text)) {
    if (isSelfApprovalCommand(inner)) return true;
  }
  return false;
}
