// SPDX-License-Identifier: Apache-2.0
// Detect shell commands that try to record chat merge approvals or approve hand-build / guard state from an orchestrator session.

import path from 'node:path';
import { analyzeShell, tokenize } from './shell-writes.mjs';

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

const HAND_BUILD_SELF_ACTIONS = new Set(['approve', 'deny', 'on', 'off', 'install', 'uninstall']);
const DATA_VALUE_FLAGS = new Set([
  '-m', '-F', '-C', '-c', '--message', '--reason', '--prompt', '--guard-text',
  '--body', '--title', '--description', '--subject', '--file',
]);
const SWARM_INLINE = /\b(?:node|python3?)\b[\s\S]*\bswarm\b[\s\S]*\b(?:decide|handbuild)\b/;
const HAND_BUILD_GUARD_SCRIPT = /^tools\/handbuild[^/]*\.mjs$/i;

const SAFE_SWARM = [
  /\bhandbuild\s+request\b/,
  /\bhandbuild\s+status\b/,
  /\bhandbuild\s+show\b/,
  /\bhandbuild\s+list\b/,
  /\bswarm\s+go\b/,
  /\bswarm\s+run\b/,
  /\bswarm\s+tickets\b/,
];

const CLAUDE_KNOWN_SUBCOMMANDS = new Set([
  'mcp', 'config', 'doctor', 'update', 'install', 'plugin', 'plugins', 'remote-control', 'login',
  'logout', 'setup-token', 'agents', 'migrate-installer', 'auth',
]);
const CLAUDE_INFO_FLAGS = new Set(['--version', '-v', '--help', '-h']);
const CLAUDE_VALUE_OPTIONS = new Set([
  '--model', '--resume', '-r', '--session-id', '--add-dir', '--permission-mode', '--allowedTools',
  '--disallowedTools', '--mcp-config', '--settings', '--output-format', '--input-format', '--max-turns',
  '--append-system-prompt',
]);

const PROGRAM_WRAPPERS = new Set([
  'env', 'command', 'exec', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'caffeinate', 'sudo', 'xargs',
  'builtin', 'setsid', 'chrt',
]);

const WRAPPER_VALUE_OPTS = {
  sudo: ['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U'],
  env: ['-u', '-C'],
  nice: ['-n'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E'],
};

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell']);
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', 'fi', 'done', 'case', 'esac', 'for', 'in',
  'select', 'function', 'coproc',
]);

const CODE_INTERPRETERS = /^(?:node|python3?|perl|ruby|php[\d.]*)$/;

function claudeProgramBasename(token) {
  return path.basename(token) === 'claude';
}

function isClaudePackageToken(token) {
  if (!token || token.startsWith('-')) return false;
  const versionAt = token.startsWith('@') ? token.indexOf('@', 1) : token.indexOf('@');
  const pkg = versionAt === -1 ? token : token.slice(0, versionAt);
  if (pkg === '@anthropic-ai/claude-code') return true;
  return path.basename(pkg) === 'claude';
}

const TMUX_EMBED_SUBS = new Set(['new-session', 'new-window', 'split-window', 'respawn-pane', 'send-keys', 'run-shell']);
const TMUX_SUB_ALIASES = {
  new: 'new-session',
  neww: 'new-window',
  splitw: 'split-window',
  send: 'send-keys',
  respawnp: 'respawn-pane',
  run: 'run-shell',
};
const TMUX_GLOBAL_VALUE_OPTS = new Set(['-L', '-S', '-f', '-c']);
const TMUX_VALUE_OPTS = new Set(['-s', '-n', '-t', '-c', '-F', '-f', '-e', '-x', '-y', '-l']);

const HEREDOC_STDIN_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'node', 'python', 'python3', 'perl', 'ruby', 'php']);

function skipTmuxGlobalOptions(args, i) {
  while (i < args.length) {
    const a = args[i];
    if (TMUX_GLOBAL_VALUE_OPTS.has(a)) { i += 2; continue; }
    if (a === '-u' || a === '-2' || a === '-v') { i += 1; continue; }
    break;
  }
  return i;
}

function resolveTmuxSubcommand(args) {
  let i = skipTmuxGlobalOptions(args, 0);
  if (i >= args.length) return null;
  const raw = args[i];
  const sub = TMUX_SUB_ALIASES[raw] ?? raw;
  return { sub, subArgs: args.slice(i + 1) };
}

/** Sanctioned tmux seat launcher: node tools/orchestrator-up.mjs with allowed subcommands only. */
function orchestratorUpSeatAllowed(normalized) {
  if (!normalized || !/\bnode\b/.test(normalized) || !/\borchestrator-up\.mjs\b/.test(normalized)) return false;
  if (/\bswarm\.mjs\b/.test(normalized)) return false;
  if (/\b(?:decide|handbuild)\b/.test(normalized)) return false;
  if (/\borchestrator-hook/.test(normalized)) return false;
  return true;
}

function nodeScriptIsClaude(scriptToken) {
  if (!scriptToken || scriptToken.startsWith('-')) return false;
  const base = path.basename(scriptToken);
  if (base === 'claude') return true;
  if (base === 'cli.js' && /anthropic-ai\/claude-code/.test(scriptToken)) return true;
  return false;
}

function heredocConsumerReadsScript(cmd, argsBeforeHeredoc) {
  const base = path.basename(cmd);
  if (HEREDOC_STDIN_INTERPRETERS.has(base) || /^python[\d.]*$/.test(base) || /^ruby[\d.]*$/.test(base) || /^php[\d.]*$/.test(base)) {
    if (base === 'node' && argsBeforeHeredoc.some(a => ['-e', '--eval', '-p', '--print'].includes(a) || /^--eval=|^--print=/.test(a))) {
      return false;
    }
    return true;
  }
  return false;
}

/** Extract here-document bodies and the command word that owns each redirect. */
function extractHeredocs(commandText) {
  const text = String(commandText ?? '');
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      let j = i + 2;
      let strip = false;
      if (text[j] === '-') { strip = true; j += 1; }
      while (text[j] === ' ') j += 1;
      let quote = null;
      let delim = '';
      for (; j < text.length; j += 1) {
        const ch = text[j];
        if (quote) {
          if (ch === quote) quote = null;
          else delim += ch;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (/[\s;&|()<>]/.test(ch)) break;
        delim += ch;
      }
      const lineStart = text.lastIndexOf('\n', i) + 1;
      const prefix = text.slice(lineStart, i).trim();
      const bodyStart = text.indexOf('\n', j);
      if (bodyStart === -1 || !delim) { i = j; continue; }
      let k = bodyStart + 1;
      let body = '';
      for (;;) {
        const end = text.indexOf('\n', k);
        const line = text.slice(k, end === -1 ? text.length : end);
        const cmp = strip ? line.replace(/^\t+/, '') : line;
        if (cmp === delim) {
          i = end === -1 ? text.length : end;
          break;
        }
        body += `${line}\n`;
        if (end === -1) { i = text.length; break; }
        k = end + 1;
      }
      out.push({ prefix, body });
      continue;
    }
  }
  return out;
}

function heredocPrefixProgram(prefix) {
  for (const words of tokenize(prefix)) {
    const plain = plainWords(words);
    const { index } = skipToProgram(plain);
    if (index >= plain.length) continue;
    return { cmd: path.basename(plain[index]), args: plain.slice(index + 1) };
  }
  return null;
}

function heredocBodiesRisky(commandText, depth = 0) {
  if (depth > MAX_CLAUDE_DEPTH) return false;
  for (const { prefix, body } of extractHeredocs(commandText)) {
    const prog = heredocPrefixProgram(prefix);
    if (!prog || !heredocConsumerReadsScript(prog.cmd, prog.args)) continue;
    const b = body.trimEnd();
    if (!b) continue;
    if (rawHasRiskyClaudeInvocation(b, depth + 1)) return true;
    for (const words of tokenize(b)) {
      if (commandWordsSelfApprovalRisky(words, b)) return true;
    }
    for (const inner of nestedCommandStrings(b)) {
      if (isSelfApprovalCommand(inner)) return true;
    }
  }
  return false;
}

function skipTmuxFlags(args, i) {
  while (i < args.length) {
    const a = args[i];
    if (TMUX_VALUE_OPTS.has(a)) { i += 2; continue; }
    if (a === '-t' || a === '-b') { i += 2; continue; }
    if (a === '-X') { i += 1; continue; }
    if (a.startsWith('-')) { i += 1; continue; }
    break;
  }
  return i;
}

function tmuxEmbeddedCommandStrings(sub, args) {
  const out = [];
  if (!TMUX_EMBED_SUBS.has(sub)) return out;
  if (sub === 'send-keys') {
    let i = skipTmuxFlags(args, 0);
    for (; i < args.length; i += 1) {
      const r = args[i];
      if (r === 'Enter' || r === 'C-m' || r === 'C-M') continue;
      out.push(r);
    }
    return out;
  }
  if (sub === 'run-shell') {
    const i = skipTmuxFlags(args, 0);
    const rest = args.slice(i);
    if (rest.length) out.push(rest.join(' '));
    return out;
  }
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (TMUX_VALUE_OPTS.has(a)) { i += 2; continue; }
    if (a.startsWith('-')) { i += 1; continue; }
    break;
  }
  const rest = args.slice(i);
  if (rest.length) out.push(rest.join(' '));
  return out;
}

function screenEmbeddedCommandString(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!a.startsWith('-')) break;
    if (a === '-S' || a === '-t' || a === '-c' || a === '-s' || a === '-r' || a === '-T' || a === '-X') {
      i += 2;
      continue;
    }
    if (a.length > 2 && /^-[dmDRxX]+/.test(a)) {
      const tail = a.slice(1);
      if (tail.includes('S') || tail.includes('t') || tail.includes('c') || tail.includes('s') || tail.includes('r') || tail.includes('T')) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  const rest = args.slice(i);
  return rest.length ? rest.join(' ') : '';
}

function skipPackageRunnerFlags(args, i) {
  while (i < args.length) {
    const a = args[i];
    if (a === '--') { i += 1; break; }
    if (!a.startsWith('-')) break;
    const takesValue = a === '-p' || a === '--package' || a === '--prefix' || a === '--node-options'
      || a === '--workspace' || a === '-w' || a === '--cwd' || a === '-C';
    i += takesValue ? 2 : 1;
  }
  return i;
}

/** When a package runner invokes claude or @anthropic-ai/claude-code, return args after the package token. */
function packageRunnerClaudeArgs(plain, programIndex) {
  const cmd = plain[programIndex];
  let i = programIndex + 1;

  if (cmd === 'npx' || cmd === 'bunx') {
    i = skipPackageRunnerFlags(plain, i);
    const pkg = plain[i];
    if (!isClaudePackageToken(pkg)) return null;
    return plain.slice(i + 1);
  }

  if (cmd === 'pnpm') {
    const sub = plain[i];
    if (sub !== 'dlx' && sub !== 'exec') return null;
    i += 1;
    i = skipPackageRunnerFlags(plain, i);
    const pkg = plain[i];
    if (!isClaudePackageToken(pkg)) return null;
    return plain.slice(i + 1);
  }

  if (cmd === 'yarn') {
    if (plain[i] !== 'dlx') return null;
    i += 1;
    i = skipPackageRunnerFlags(plain, i);
    const pkg = plain[i];
    if (!isClaudePackageToken(pkg)) return null;
    return plain.slice(i + 1);
  }

  if (cmd === 'npm') {
    if (plain[i] !== 'exec') return null;
    i += 1;
    i = skipPackageRunnerFlags(plain, i);
    const pkg = plain[i];
    if (!isClaudePackageToken(pkg)) return null;
    return plain.slice(i + 1);
  }

  return null;
}

function plainWords(words) {
  const plain = [];
  for (let i = 0; i < words.length; i += 1) {
    if (['>', '>>', '>|', '>&', '&>', '<', '<<<', '<<'].includes(words[i])) {
      if (words[i] !== '<<') i += 1;
      continue;
    }
    if (/^\d+$/.test(words[i]) && ['>', '>>', '>&'].includes(words[i + 1])) continue;
    plain.push(words[i]);
  }
  return plain;
}

function skipToProgram(plain) {
  let k = 0;
  let wrapperName = null;
  while (k < plain.length) {
    if (SHELL_KEYWORDS.has(plain[k])) { k += 1; continue; }
    if (!wrapperName && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) { k += 1; continue; }
    if (PROGRAM_WRAPPERS.has(plain[k])) {
      wrapperName = plain[k];
      k += 1;
      continue;
    }
    if (wrapperName === 'env') {
      if (plain[k] === '-S' || plain[k] === '--split-string') {
        return { index: k + 2, envSplit: plain[k + 1] };
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) { k += 1; continue; }
    }
    if (wrapperName === 'nice' && /^-\d+$/.test(plain[k])) { k += 1; continue; }
    if (wrapperName === 'command' && (plain[k] === '-v' || plain[k] === '-V')) {
      return { index: plain.length };
    }
    if (wrapperName && plain[k].startsWith('-')) {
      const takes = (WRAPPER_VALUE_OPTS[wrapperName] ?? []).includes(plain[k]);
      k += takes ? 2 : 1;
      continue;
    }
    if (wrapperName === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(plain[k])) {
      k += 1;
      wrapperName = null;
      continue;
    }
    if (wrapperName) wrapperName = null;
    break;
  }
  return { index: k };
}

function claudeInvocationIsRisky(args) {
  if (args.length === 0) return true;
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (t === '-p' || t === '--print' || t.startsWith('--print=')) return true;
    if (t.startsWith('-')) {
      const opt = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
      if (CLAUDE_INFO_FLAGS.has(opt)) return false;
      if (CLAUDE_VALUE_OPTIONS.has(opt) || opt === '-r') {
        if (t.includes('=')) { i += 1; continue; }
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (CLAUDE_KNOWN_SUBCOMMANDS.has(t)) return false;
    return true;
  }
  return false;
}

function shellCodeFlagIndex(cmd, args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--command' || a.startsWith('--command=')) return i;
    if (/^-[A-Za-z]*c$/.test(a)) return i;
    if (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('c')) return i;
  }
  return -1;
}

function interpreterCodeFlagIndex(cmd, args) {
  if (SHELLS.has(cmd)) return shellCodeFlagIndex(cmd, args);
  if (/^python/.test(cmd)) {
    const i = args.findIndex(a => /^-[A-Za-z]*c$/.test(a));
    return i;
  }
  if (cmd === 'node') {
    return args.findIndex(a => ['-e', '--eval', '-p', '--print'].includes(a) || /^--eval=|^--print=/.test(a));
  }
  if (/^(?:perl|ruby)/.test(cmd)) {
    return args.findIndex(a => /^-[A-Za-z]*[eE]$/.test(a));
  }
  if (/^php/.test(cmd)) return args.findIndex(a => a === '-r');
  return -1;
}

function codeArgValue(args, at) {
  const a = args[at];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  return args[at + 1] ?? '';
}

const SPAWN_EXEC_NAMES = /(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|Popen|subprocess\.run|system|popen)\s*\(/;

/** claude as quoted token (or list item), then within 60 chars quoted -p or --print; execSync('claude -p hi'). */
function interpreterCodeHasRiskyClaude(code) {
  const s = String(code ?? '');
  const quotedClaudeThenPrint = /['"]claude['"][\s\S]{0,60}['"](?:-p|--print)['"]/;
  if (quotedClaudeThenPrint.test(s)) return true;
  const listRe = /\[\s*['"]claude['"][\s\S]{0,60}['"](?:-p|--print)['"]/;
  if (listRe.test(s)) return true;
  if (SPAWN_EXEC_NAMES.test(s) && quotedClaudeThenPrint.test(s)) return true;
  for (const q of ["'", '"']) {
    let from = 0;
    while (from < s.length) {
      const start = s.indexOf(q, from);
      if (start === -1) break;
      let j = start + 1;
      while (j < s.length && s[j] !== q) {
        if (s[j] === '\\') j += 2;
        else j += 1;
      }
      const inner = s.slice(start + 1, j);
      const claudeAt = inner.indexOf('claude');
      if (claudeAt !== -1) {
        const window = inner.slice(claudeAt, claudeAt + 60);
        if (/\bclaude\b/.test(window) && /(?:\s|^)(?:-p|--print)\b/.test(window)) return true;
      }
      from = j + 1;
    }
  }
  let from = 0;
  while (from < s.length) {
    const start = s.indexOf('`', from);
    if (start === -1) break;
    let j = start + 1;
    while (j < s.length) {
      if (s[j] === '\\') j += 2;
      else if (s[j] === '`') break;
      else j += 1;
    }
    const inner = s.slice(start + 1, j);
    if (/\bclaude\b/.test(inner) && /(?:\s|^)(?:-p|--print)\b/.test(inner)) return true;
    from = j + 1;
  }
  return false;
}

function substitutions(text) {
  const out = [];
  const str = String(text ?? '');
  let single = false;
  let double = false;
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (c === '\\' && !single) { i += 1; continue; }
    if (c === "'" && !double) { single = !single; continue; }
    if (c === '"' && !single) { double = !double; continue; }
    if (single) continue;
    if (c === '$' && str[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < str.length && depth > 0; j += 1) {
        if (str[j] === '(') depth += 1;
        else if (str[j] === ')') depth -= 1;
      }
      out.push(str.slice(i + 2, j - 1));
      i = j - 1;
    } else if (c === '`') {
      const j = str.indexOf('`', i + 1);
      if (j === -1) break;
      out.push(str.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

function commandWordsRiskyClaude(words, depth) {
  const plain = plainWords(words);
  const { index, envSplit } = skipToProgram(plain);
  if (envSplit !== undefined) return rawHasRiskyClaudeInvocation(envSplit, depth + 1);
  if (index >= plain.length) return false;
  const cmd = path.basename(plain[index]);
  const args = plain.slice(index + 1);

  if (claudeProgramBasename(plain[index]) && claudeInvocationIsRisky(args)) return true;

  const pkgClaudeArgs = packageRunnerClaudeArgs(plain, index);
  if (pkgClaudeArgs && claudeInvocationIsRisky(pkgClaudeArgs)) return true;

  if (cmd === 'node') {
    const scriptAt = args.findIndex(a => a !== '' && !a.startsWith('-'));
    if (scriptAt !== -1 && nodeScriptIsClaude(args[scriptAt])) {
      if (claudeInvocationIsRisky(args.slice(scriptAt + 1))) return true;
    }
  }

  if (cmd === 'tmux' && args.length > 0) {
    const inv = resolveTmuxSubcommand(args);
    if (inv && TMUX_EMBED_SUBS.has(inv.sub)) {
      for (const embedded of tmuxEmbeddedCommandStrings(inv.sub, inv.subArgs)) {
        if (rawHasRiskyClaudeInvocation(embedded, depth + 1)) return true;
      }
    }
  }

  if (cmd === 'screen') {
    const embedded = screenEmbeddedCommandString(args);
    if (embedded && rawHasRiskyClaudeInvocation(embedded, depth + 1)) return true;
  }

  if (cmd === 'eval') {
    return rawHasRiskyClaudeInvocation(args.join(' '), depth + 1);
  }

  const codeAt = interpreterCodeFlagIndex(cmd, args);
  if (codeAt !== -1) {
    const code = codeArgValue(args, codeAt);
    if (SHELLS.has(cmd)) {
      if (rawHasRiskyClaudeInvocation(code, depth + 1)) return true;
    } else if (CODE_INTERPRETERS.test(cmd)) {
      if (interpreterCodeHasRiskyClaude(code)) return true;
    }
  }

  return false;
}

const MAX_CLAUDE_DEPTH = 4;

/** Headless Claude Code via quote-aware tokenization (not normalized regex splitting). */
function rawHasRiskyClaudeInvocation(commandText, depth = 0) {
  if (depth > MAX_CLAUDE_DEPTH) return false;
  const text = String(commandText ?? '');
  if (!text) return false;

  for (const sub of substitutions(text)) {
    if (rawHasRiskyClaudeInvocation(sub, depth + 1)) return true;
  }

  for (const words of tokenize(text)) {
    if (commandWordsRiskyClaude(words, depth)) return true;
  }

  return false;
}

const STATIC_MARKERS = [
  /\borchestrator-hook(?:\.mjs)?\b/,
  /\brecordchatmerge\b/,
  /\binbox-commands(?:\.mjs)?\b/,
  /\.swarm\/handbuild\b/,
  /\bscript\b/,
  /\bosascript\b/,
  /\bexpect\b/,
  /base64\b[\s\S]*\|\s*(?:sh|bash|zsh|node)\b/,
];

function tmuxEmbeddedSwarmNodeRisky(sub, embedded) {
  const n = normalizeSelfApprovalCommandText(embedded);
  if (!n) return false;
  if (orchestratorUpSeatAllowed(n)) return false;
  const embedSubs = new Set(['new-session', 'new-window', 'split-window', 'respawn-pane', 'send-keys', 'run-shell']);
  if (!embedSubs.has(sub)) return false;
  if (sub === 'send-keys' && (/\bswarm\b/.test(n) || /\bnode\b/.test(n))) return true;
  if (['new-session', 'split-window', 'new-window', 'respawn-pane', 'run-shell'].includes(sub)) {
    if (/\bswarm\b/.test(n)) return true;
    if (/\bnode\b/.test(n) && (/\bswarm\.mjs\b/.test(n) || /\b(?:decide|handbuild)\b/.test(n) || /\borchestrator-hook/.test(n))) {
      return true;
    }
  }
  return false;
}

function tmuxSequentialClaudeSendKeysRisky(commandText) {
  let prevTmuxStartedClaude = false;
  for (const words of tokenize(commandText)) {
    const plain = plainWords(words);
    const { index } = skipToProgram(plain);
    if (index >= plain.length) {
      prevTmuxStartedClaude = false;
      continue;
    }
    const cmd = path.basename(plain[index]);
    if (cmd !== 'tmux') {
      prevTmuxStartedClaude = false;
      continue;
    }
    const inv = resolveTmuxSubcommand(plain.slice(index + 1));
    if (!inv) {
      prevTmuxStartedClaude = false;
      continue;
    }
    const { sub, subArgs } = inv;
    if (sub === 'send-keys' && prevTmuxStartedClaude) return true;
    prevTmuxStartedClaude = false;
    if (['new-session', 'new-window', 'split-window', 'respawn-pane', 'run-shell'].includes(sub)) {
      for (const embedded of tmuxEmbeddedCommandStrings(sub, subArgs)) {
        if (rawHasRiskyClaudeInvocation(embedded, 1)) prevTmuxStartedClaude = true;
      }
    }
  }
  return false;
}

function tmuxOrchestratorMarker(commandText) {
  if (tmuxSequentialClaudeSendKeysRisky(commandText)) return true;
  for (const words of tokenize(commandText)) {
    const plain = plainWords(words);
    const { index } = skipToProgram(plain);
    if (index >= plain.length) continue;
    if (path.basename(plain[index]) !== 'tmux') continue;
    const inv = resolveTmuxSubcommand(plain.slice(index + 1));
    if (!inv) continue;
    const { sub, subArgs } = inv;
    for (const embedded of tmuxEmbeddedCommandStrings(sub, subArgs)) {
      if (tmuxEmbeddedSwarmNodeRisky(sub, embedded)) return true;
    }
  }
  return false;
}

function nestedCommandStrings(text) {
  const out = [];
  const s = String(text ?? '');
  for (const re of [SHELL_CODE_RE, EVAL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) out.push(m[2]);
  }
  return out;
}

/** Skip commit messages, manifest prompts, and other literal text (guard/safeguard words there are not commands). */
function executablePlainWords(plain) {
  const out = [];
  let i = 0;
  while (i < plain.length) {
    const w = plain[i];
    const low = w.toLowerCase();
    if (low === 'ask' && i > 0 && plain[i - 1].toLowerCase() === 'swarm') {
      i += 1;
      while (i < plain.length && plain[i].startsWith('-')) {
        const f = plain[i].toLowerCase();
        if (DATA_VALUE_FLAGS.has(f) || f.startsWith('--reason=') || f.startsWith('--prompt=') || f.startsWith('--guard-text=')) {
          i += f.includes('=') ? 1 : 2;
        } else i += 1;
      }
      if (i < plain.length) { i += 1; continue; }
      continue;
    }
    if (DATA_VALUE_FLAGS.has(low)) {
      i += low.includes('=') ? 1 : 2;
      continue;
    }
    if (low.startsWith('--message=') || low.startsWith('--reason=') || low.startsWith('--guard-text=') || low.startsWith('--prompt=')) {
      i += 1;
      continue;
    }
    out.push(w);
    i += 1;
  }
  return out;
}

function plainHasHandbuildSelfAction(plain) {
  const lower = executablePlainWords(plain).map(w => w.toLowerCase());
  for (let i = 0; i < lower.length; i += 1) {
    if (lower[i] === 'handbuild' && HAND_BUILD_SELF_ACTIONS.has(lower[i + 1] ?? '')) return true;
    if (lower[i] === 'swarm' && lower[i + 1] === 'handbuild' && HAND_BUILD_SELF_ACTIONS.has(lower[i + 2] ?? '')) return true;
  }
  const swarmMi = lower.findIndex(w => w === 'swarm.mjs' || w.endsWith('/swarm.mjs') || w.endsWith('\\swarm.mjs'));
  if (swarmMi !== -1) {
    const rest = lower.slice(swarmMi + 1);
    let ri = 0;
    while (ri < rest.length && (rest[ri] === '--root' || rest[ri]?.startsWith('--root='))) {
      if (rest[ri] === '--root') ri += 2;
      else ri += 1;
    }
    const tail = rest.slice(ri);
    const hi = tail.indexOf('handbuild');
    if (hi !== -1 && HAND_BUILD_SELF_ACTIONS.has(tail[hi + 1] ?? '')) return true;
    const di = tail.indexOf('decide');
    if (di !== -1 && (tail[di + 2] === 'approve' || tail[di + 2] === 'deny')) return true;
    if (tail[0] === 'swarm' && tail[1] === 'handbuild' && HAND_BUILD_SELF_ACTIONS.has(tail[2] ?? '')) return true;
  }
  return false;
}

function plainHasDecideHandbuildApprove(plain) {
  const lower = executablePlainWords(plain).map(w => w.toLowerCase());
  for (let i = 0; i < lower.length; i += 1) {
    if (lower[i] === 'decide' && lower[i + 1]?.startsWith('handbuild-') && lower[i + 2] === 'approve') return true;
    if (lower[i] === 'decide' && lower[i + 1]?.startsWith('handbuild-') && lower[i + 2] === 'deny') return true;
    if (lower[i] === 'swarm' && lower[i + 1] === 'decide' && lower[i + 2]?.startsWith('handbuild-') && lower[i + 3] === 'approve') return true;
  }
  return false;
}

function interpreterRunsInlineCode(cmd, args) {
  return interpreterCodeFlagIndex(cmd, args) !== -1;
}

/** SWARM_INLINE applies only to inline interpreter code (-e, -c, …), not direct script invocations. */
function plainHasSwarmInlineRisk(plain) {
  const { index } = skipToProgram(plain);
  if (index >= plain.length) return false;
  const cmd = path.basename(plain[index]);
  if (!/^(?:node|python3?)$/.test(cmd)) return false;
  const args = plain.slice(index + 1);
  if (!interpreterRunsInlineCode(cmd, args)) return false;
  const surface = executablePlainWords(plain).join(' ').toLowerCase();
  return SWARM_INLINE.test(surface);
}

function plainHasStaticMarker(plain) {
  const surface = executablePlainWords(plain).join(' ').toLowerCase();
  return surfaceHasStaticMarker(surface);
}

/** Pipeline segments are tokenized separately; markers like base64 -d | sh need the joined surface. */
function fullCommandHasStaticMarker(commandText) {
  const parts = [];
  for (const words of tokenize(commandText)) {
    parts.push(executablePlainWords(plainWords(words)).join(' '));
  }
  const surface = parts.join(' | ').toLowerCase();
  return surfaceHasStaticMarker(surface);
}

function surfaceHasStaticMarker(surface) {
  if (!surface) return false;
  if (SAFE_SWARM.some(re => re.test(surface))) return false;
  return STATIC_MARKERS.some(re => re.test(surface));
}

function commandWordsSelfApprovalRisky(words, rawText = '') {
  const plain = plainWords(words);
  if (plainHasHandbuildSelfAction(plain)) return true;
  if (plainHasDecideHandbuildApprove(plain)) return true;
  if (plainHasSwarmInlineRisk(plain)) return true;
  if (plainHasStaticMarker(plain)) return true;
  if (rawText && tmuxOrchestratorMarker(rawText)) return true;
  return false;
}

function commandTouchesGuardInstallScripts(commandText, root = '.') {
  const a = analyzeShell(commandText, { root, cwd: root });
  return a.writes.some(rel => HAND_BUILD_GUARD_SCRIPT.test(String(rel).replace(/\\/g, '/')));
}

function inlineCodeSelfApprovalRisky(code) {
  const n = normalizeSelfApprovalCommandText(code);
  if (!n) return false;
  if (SWARM_INLINE.test(n)) return true;
  if (/\bswarm\b/.test(n) && /\bdecide\b/.test(n) && /\bapprove\b/.test(n)) return true;
  if (/\bhandbuild\s+(?:approve|deny|on|off|install|uninstall)\b/.test(n)) return true;
  for (const words of tokenize(code)) {
    if (commandWordsSelfApprovalRisky(words, code)) return true;
  }
  return false;
}

function commandWordsInlineInterpreterRisky(words) {
  const plain = plainWords(words);
  const { index } = skipToProgram(plain);
  if (index >= plain.length) return false;
  const cmd = path.basename(plain[index]);
  const args = plain.slice(index + 1);
  const codeAt = interpreterCodeFlagIndex(cmd, args);
  if (codeAt === -1) return false;
  return inlineCodeSelfApprovalRisky(codeArgValue(args, codeAt));
}

function matchesNormalized(normalized, rawText = '', { skipSafeSwarm = false } = {}) {
  if (!normalized) return false;
  if (!skipSafeSwarm && SAFE_SWARM.some(re => re.test(normalized))) return false;
  if (rawText && tmuxOrchestratorMarker(rawText)) return true;
  return false;
}

/** Conservative check on raw command text (including nested bash -c / eval / pipes). */
export function isSelfApprovalCommand(commandText) {
  const text = String(commandText ?? '');
  if (!text) return false;
  if (rawHasRiskyClaudeInvocation(text, 0)) return true;
  if (heredocBodiesRisky(text, 0)) return true;
  if (commandTouchesGuardInstallScripts(text)) return true;
  for (const words of tokenize(text)) {
    if (commandWordsSelfApprovalRisky(words, text)) return true;
    if (commandWordsInlineInterpreterRisky(words)) return true;
  }
  for (const inner of nestedCommandStrings(text)) {
    if (isSelfApprovalCommand(inner)) return true;
  }
  if (fullCommandHasStaticMarker(text)) return true;
  return false;
}
