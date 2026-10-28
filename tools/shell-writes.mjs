// SPDX-License-Identifier: Apache-2.0
// What a shell command writes in the project checkout, read from its text (no execution): redirects, tee, sed -i, mv and cp into the project, rm, touch, mkdir, curl -o, tar -x, git commands
// that change the tree or history, and inline scripts that write files. Used by the hand-build guard (to block) and by the Orchestrator lane (so the hand-built share counts shell writes too).
// It is a reader of command text, not a sandbox, and it fails closed on what it cannot read: a write whose target is a variable or a substitution, a `cd` it cannot follow, an interpreter
// run on a script the orchestrator could have written (inside .swarm/ or docs/), `find -exec` / `xargs` of a writer. It reads inside `bash -c "..."`, `eval "..."`, `$(...)`, backticks,
// subshells, here-documents (their text is data, not commands) and `cd DIR && ...`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ORCHESTRATOR_OWN, insideProject, realOf, projectRootOf } from './orchestrator-events.mjs';
import {
  swarmSubcommandAlwaysAllowed,
  swarmArgvSubcommand,
  readOnlyCommandAllowed,
  helpOnly,
  localTestRunAllowed,
  localTestRunIsBare,
  orchestratorOwnRel,
  orchestratorOwnForbiddenWriteRel,
  orchestratorBareTestScanRelPrefixes,
  orchestratorSwarmSessionCwdOk,
  orchestratorWriteAllowedRel,
} from './orchestrator-allow.mjs';
import { omRunManifestVetted, omSwarmRunGoPositionals, omSwarmTicketPositionals } from './om-manifest-guard.mjs';

export { localTestRunAllowed };
export const ORCHESTRATOR_MODE_OFF_FILE = '.swarm/orchestrator-mode/off';
export const ORCHESTRATOR_TEST_MARKER_REL = '.swarm/orchestrator-mode/test-harness-signed';
export const ORCHESTRATOR_TEST_MARKER_BODY = 'project-swarm-orchestrator-mode-test-harness-v1';
export const ORCHESTRATOR_MODE_RULE_ID = 'orchestrator-mode';
export const ORCHESTRATOR_MODE_DENY_REASON = 'Orchestrator mode: writes are only allowed under .swarm/ (except workspaces, worktrees, runs, backups, orchestrator-mode), docs/plans/, coordination/manifests/ (.json), coordination/HANDOFF*.md, docs/state/ (.md), and TASK.md at the project root — text formats md/json/jsonl/ndjson/yaml/yml only (never package.json). Swarm CLI commands are allowed. For anything else, make a ticket: swarm ticket ... or swarm tickets ... or swarm backlog add "goal" (see swarm tickets --help).';
export const ORCHESTRATOR_SWARM_CWD_DENY_REASON = 'Orchestrator mode: swarm commands are only allowed with the session working directory at the project root; run cd followed by the project root path first.';
/** Deny message for a swarm command run from a folder below the project root; prints the real root path. */
export const orchestratorSwarmCwdDenyReason = root => {
  let real = String(root ?? '');
  try { real = fs.realpathSync.native(real); } catch { /* keep the given path */ }
  return real ? `Orchestrator mode: swarm commands are only allowed from the project root: run cd ${real} first.` : ORCHESTRATOR_SWARM_CWD_DENY_REASON;
};
export const ORCHESTRATOR_COMMAND_MAX_BYTES = 100 * 1024;
export const ORCHESTRATOR_COMMAND_MAX_SEGMENTS = 2000;
export const ORCHESTRATOR_COMMAND_TOO_LONG_REASON = 'command too long for the guard: split it or make a ticket';
const GIT_COMMIT_MSG_OPTS = new Set(['-m', '-F', '-C', '-c', '--message', '--author', '--date']);

const SWARM_PROJECT_SUBDIRS = ['runs', 'workspaces', 'worktrees', 'orchestrator-mode'];
const SWARM_GUARD_BOOTSTRAP = new Set(['handbuild', 'project', 'orchestrator']);

export const swarmProjectMarkers = projectRoot => {
  try {
    const r = fs.realpathSync.native(projectRoot);
    const base = path.join(r, '.swarm');
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return false;
    if (SWARM_PROJECT_SUBDIRS.some(s => fs.existsSync(path.join(base, s)))) return true;
    const entries = fs.readdirSync(base);
    if (entries.length === 0) return true;
    return entries.some(name => !SWARM_GUARD_BOOTSTRAP.has(name));
  } catch { return false; }
};

/** Signed marker file: required for test-only orchestrator-mode scratch exemptions (not env flags alone). */
export function orchestratorTestHarnessSigned(root) {
  if (!root) return false;
  try {
    const p = path.join(fs.realpathSync.native(root), ORCHESTRATOR_TEST_MARKER_REL);
    return fs.readFileSync(p, 'utf8').trim() === ORCHESTRATOR_TEST_MARKER_BODY;
  } catch { return false; }
}

/** Project root for orchestrator mode: `CLAUDE_PROJECT_DIR` when set and valid, else walk up from cwd. */
export function orchestratorResolvedRoot(cwd = process.cwd()) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && String(fromEnv).trim()) {
    try {
      if (fs.existsSync(fromEnv)) return fs.realpathSync.native(fromEnv);
    } catch { /* fall through */ }
  }
  return projectRootOf(cwd);
}

/** Orchestrator mode is on by default at a swarm project root (`.swarm/` present) unless `.swarm/orchestrator-mode/off` exists. */
export function orchestratorModeEnabled(root, cwd = root) {
  const projectRoot = root || orchestratorResolvedRoot(cwd);
  if (!projectRoot || !swarmProjectMarkers(projectRoot)) return false;
  try {
    const rootReal = fs.realpathSync.native(projectRoot);
    return !fs.existsSync(path.join(rootReal, ORCHESTRATOR_MODE_OFF_FILE));
  } catch { return false; }
}

/** Shell allowlist enforcement when orchestrator mode is enabled for the resolved project root. */
export function orchestratorModeApplies(root, cwd = root) {
  const projectRoot = root || orchestratorResolvedRoot(cwd);
  if (!projectRoot) return false;
  return orchestratorModeEnabled(projectRoot, cwd);
}

// Build output and installed packages are written by tools, not by hand.
export const TOOL_DIRS = Object.freeze(['node_modules/', '.next/', 'dist/', 'build/', 'coverage/', '.turbo/', '.cache/']);
const GIT_TREE_OR_HISTORY = new Set(['commit', 'push', 'apply', 'am', 'merge', 'rebase', 'cherry-pick', 'reset', 'restore', 'revert', 'clean', 'rm', 'mv', 'pull', 'stash', 'worktree', 'submodule', 'config', 'filter-branch']);
const WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'env', 'nice', 'builtin', 'xargs', 'doas', 'stdbuf', 'timeout']);
// Options of a wrapper that take a value (and, for timeout, the duration operand): they are skipped so the real command is found.
const WRAPPER_VALUE_OPTS = { sudo: ['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U'], doas: ['-u', '-C'], env: ['-u', '-C'], nice: ['-n'], stdbuf: ['-i', '-o', '-e'], timeout: ['-s', '-k', '--signal', '--kill-after'], xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E'] };
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell']);
// Interpreters whose name is matched by a pattern (python3.12, ruby3.2...) or that are less common: inline code given with a code flag is judged like the others.
const OTHER_INTERPRETER = /^(?:python[\d.]*|ruby[\d.]*|php[\d.]*|lua[\d.]*|luajit|osascript|Rscript|R|julia|tclsh|expect|swift|awk)$/;
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun', 'tsx', 'ts-node', 'php', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell']);
const isInterpreter = cmd => INTERPRETERS.has(cmd) || OTHER_INTERPRETER.test(cmd);
// The flag that carries inline code, per interpreter (as a cluster too: -lc, -ne, -pe).
const codeFlagFor = cmd => SHELLS.has(cmd) ? (a => /^-[A-Za-z]*c$/.test(a) || a === '--command') : /^python/.test(cmd) ? (a => /^-[A-Za-z]*c$/.test(a)) : cmd === 'node' || cmd === 'tsx' || cmd === 'ts-node' || cmd === 'bun' ? (a => ['-e', '--eval', '-p', '--print'].includes(a) || /^--eval=|^--print=/.test(a)) : /^(?:perl|ruby)/.test(cmd) ? (a => /^-[A-Za-z]*[eE]$/.test(a)) : cmd === 'deno' ? (a => a === 'eval') : /^php/.test(cmd) ? (a => a === '-r') : (a => /^-[A-Za-z]*[ecEr]$/.test(a) || a === '--eval' || a === '--command');
const WRITERS = new Set(['rm', 'rmdir', 'unlink', 'touch', 'mkdir', 'truncate', 'chmod', 'chown', 'mv', 'cp', 'install', 'ln', 'tee', 'dd', 'sed', 'perl', 'patch', 'rsync', 'curl', 'wget', 'tar', 'unzip', 'git', 'ed', 'ex']);

/** Splits a command line into simple commands (lists of words, quotes removed, redirection operators kept as words). Here-document bodies are skipped. `(`, `)` and a leading `{` separate commands. */
export function tokenize(command, { countSteps } = {}) {
  const commands = [];
  let words = [], expands = [], word = '', quote = null, hasWord = false, wordExpands = false;
  const step = () => { if (countSteps) countSteps.n += 1; };
  const markExpand = () => { if (quote !== "'" && quote !== 'ansi-c') wordExpands = true; };
  const endWord = () => {
    if (hasWord) {
      words.push(word);
      expands.push(wordExpands);
      if (words[0] === 'find' && ['-exec', '-execdir', '-ok', '-okdir'].includes(word)) findExec = true;
    }
    word = ''; hasWord = false; wordExpands = false;
  };
  let piped = false;
  let sepAfter = null;
  let findExec = false;
  const endCommand = (pipe = false, sep = ';') => { endWord(); if (words.length) { words.piped = piped; words.sepAfter = sep; words.expands = expands; commands.push(words); } words = []; expands = []; piped = pipe; findExec = false; };
  const text = String(command ?? '');
  const heredocs = [];
  let heredocHead = 0;
  for (let i = 0; i < text.length; i += 1) {
    step();
    const c = text[i], next = text[i + 1];
    if (quote) {
      if (quote === 'ansi-c') {
        if (c === "'") quote = null;
        else if (c === '\\' && next !== undefined) { word += next; i += 1; }
        else word += c;
        continue;
      }
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && next !== undefined) { word += next; i += 1; }
      else { if (c === '$' || c === '`') markExpand(); word += c; }
      continue;
    }
    if (c === '$' && next === "'") { quote = 'ansi-c'; hasWord = true; i += 1; continue; }
    if (c === '"' || c === "'") { quote = c; hasWord = true; continue; }
    if (c === '\\' && next !== undefined) { word += next; hasWord = true; i += 1; continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n') {
      endCommand();
      // a here-document body (up to its delimiter line) is data
      while (heredocHead < heredocs.length) {
        const d = heredocs[heredocHead];
        heredocHead += 1;
        let j = i + 1;
        while (j < text.length) {
          step();
          const end = text.indexOf('\n', j);
          const lineEnd = end === -1 ? text.length : end;
          const line = text.slice(j, lineEnd);
          if ((d.strip ? line.replace(/^\t+/, '') : line) === d.word) { i = end === -1 ? text.length : end; break; }
          if (end === -1) { i = text.length; break; }
          j = end + 1;
        }
      }
      continue;
    }
    if (c === ';') {
      if (findExec) { word = ';'; hasWord = true; endWord(); findExec = false; continue; }
      endCommand();
      continue;
    }
    if (c === '+' && findExec && !hasWord && (next === ' ' || next === '\t' || next === undefined || next === '\n')) {
      word = '+'; hasWord = true; endWord(); findExec = false; continue;
    }
    if (c === '(' || c === ')') { endCommand(false, c); continue; }
    if (c === '{' && !hasWord && (next === ' ' || next === '\n')) { endCommand(); continue; }
    if (c === '}' && !hasWord && (next === undefined || next === ' ' || next === ';' || next === '\n')) { endCommand(); continue; }
    if (c === '&' && next === '&') { endCommand(false, '&&'); i += 1; continue; }
    if (c === '|') { const logicalOr = next === '|'; endCommand(!logicalOr, logicalOr ? '||' : '|'); if (next === '|' || next === '&') i += 1; continue; }
    if (c === '&' && next !== '>' && text[i - 1] !== '>') { endCommand(); continue; }
    if (c === '>' || c === '<') {
      if (c === '<' && next === '<' && text[i + 2] !== '<') {
        // here-document: remember its delimiter
        endWord();
        let j = i + 2, strip = false;
        if (text[j] === '-') { strip = true; j += 1; }
        while (text[j] === ' ') j += 1;
        let dword = '', q = null;
        for (; j < text.length; j += 1) { const ch = text[j]; if (q) { if (ch === q) q = null; else dword += ch; } else if (ch === '"' || ch === "'") q = ch; else if (/[\s;&|()<>]/.test(ch)) break; else dword += ch; }
        heredocs.push({ word: dword, strip });
        words.push('<<');
        expands.push(false);
        i = j - 1;
        continue;
      }
      if (/^\d+$/.test(word) || word === '&') { const fd = word; word = ''; hasWord = false; words.push(fd); expands.push(false); } else endWord();
      let op = c;
      if (c === '>' && (next === '>' || next === '|' || next === '&')) { op += next; i += 1; }
      else if (c === '<' && next === '<') { op = '<<<'; i += 2; }
      words.push(op);
      expands.push(false);
      continue;
    }
    if (c === '$' || c === '`') markExpand();
    word += c; hasWord = true;
  }
  endCommand();
  if (quote) commands.unclosedQuote = true;
  return commands;
}

const normBranch = b => {
  if (b == null) return null;
  const s = String(b);
  return s.startsWith('refs/heads/') ? s.slice('refs/heads/'.length) : s;
};

const CONFIG_ANYWHERE = new Set(['-c', '--config', '--config-env', '--output', '--exec', '-x', '--exec-path', '--upload-pack', '--receive-pack', '--ext-diff']);
const hasConfigInArgs = args => args.some(a => CONFIG_ANYWHERE.has(a) || a.startsWith('--config=') || a.startsWith('--output=') || a.startsWith('--exec-path=') || a.startsWith('--exec-path ')
  || a.startsWith('--upload-pack=') || a.startsWith('--receive-pack=')
  || /=upload-pack/.test(a) || /=receive-pack/.test(a) || /=exec/.test(a) || /=config/.test(a));

const PIPE_STDIN_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'node', 'python', 'python3', 'perl', 'ruby', 'php']);
const isPipeStdinInterpreter = cmd => PIPE_STDIN_INTERPRETERS.has(cmd) || /^python[\d.]*$/.test(cmd) || /^ruby[\d.]*$/.test(cmd) || /^php[\d.]*$/.test(cmd);
const inlineProgramFlag = (cmd, a) => ['-c', '-e', '-E', '--eval'].includes(a) || a.startsWith('--eval=') || (/^php/.test(cmd) && a === '-r') || codeFlagFor(cmd)(a);
/** True when a pipe into an interpreter should mark the command dynamic (program read from the pipe, not from -c/-e or a script path). */
const pipeMakesInterpreterDynamic = (cmd, args) => {
  if (!isPipeStdinInterpreter(cmd)) return false;
  for (let i = 0; i < args.length; i += 1) {
    if (inlineProgramFlag(cmd, args[i])) return false;
  }
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (inlineProgramFlag(cmd, a)) { i += 1; continue; }
    if (a.startsWith('-')) {
      const bundledShellC = SHELLS.has(cmd) && /^-[A-Za-z]+$/.test(a) && a.slice(1).includes('c');
      if (bundledShellC) { i += 1; continue; }
      const next = args[i + 1];
      const takesValue = bundledShellC || ['-m', '-r', '-i', '-l', '-U', '--require', '--import', '--module', '--command'].includes(a)
        || (/^-[A-Za-z]*[rR]$/.test(a) && (cmd === 'node' || cmd === 'ruby'))
        || (a.startsWith('--') && !a.includes('='));
      if (takesValue && next !== undefined && !next.startsWith('-')) { i += 2; continue; }
      i += 1;
      continue;
    }
    if (a === '-') return true;
    return false;
  }
  return true;
};
const base64Decodes = args => args.some(a => a === '-d' || a === '-D' || a === '--decode' || /^--decode=/.test(a) || (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('d')));
const shellCodeDynamic = code => /\$[\({]/.test(String(code ?? '')) || /`/.test(String(code ?? '')) || /\bbase64\b.*\b-d\b|\bbase64\b.*--decode/.test(String(code ?? ''));
const parseRefspec = a => {
  let force = false, deleteRef = false, raw = a;
  if (raw.startsWith('+')) { force = true; raw = raw.slice(1); }
  if (raw.startsWith(':')) { deleteRef = true; raw = raw.slice(1); }
  if (raw.includes(':')) {
    const [src, dst] = raw.split(':');
    return { src: src || null, dst: normBranch(dst || null), force, delete: deleteRef || dst === '' };
  }
  return { src: null, dst: normBranch(raw), force, delete: deleteRef && raw !== '' };
};

const opFields = (op, { args: opArgs, globalOpts, allArgs }) => ({
  ...op,
  args: opArgs,
  globalOpts: !!globalOpts,
  hasConfig: hasConfigInArgs(allArgs ?? []),
});

const shortFlagHas = (flag, ch) => flag.startsWith('-') && !flag.startsWith('--') && flag.slice(1).includes(ch);

const gitPushOp = (rest, meta = {}) => {
  const flags = rest.filter(a => a.startsWith('-'));
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  const mirrorOrPrune = flags.some(a => a === '--mirror' || a === '--prune');
  let force = flags.some(a => a === '--force' || a === '-f' || a === '--force-with-lease' || a === '--force-if-includes' || a.startsWith('--force-with-lease=') || shortFlagHas(a, 'f'))
    || pos.some(a => a.startsWith('+'));
  let deleteMode = mirrorOrPrune ? true : null;
  if (!deleteMode && rest.some(a => a === '--delete' || a === '-d')) deleteMode = 'remote';
  let branch = null;
  const remote = pos[0] ?? null;
  const afterRemote = remote !== null ? pos.slice(1) : pos;
  const refspecs = afterRemote.map(parseRefspec);
  for (const a of pos) {
    if (a.startsWith('+')) { const spec = a.slice(1); branch = normBranch(spec.includes(':') ? spec.split(':').pop() : spec); }
    else if (a.startsWith(':') && a.length > 1) { if (!deleteMode) deleteMode = 'remote'; branch = normBranch(a.slice(1)); }
    else if (a.includes(':')) {
      const rhs = a.split(':').pop();
      if (rhs === '') { if (!deleteMode) deleteMode = 'remote'; }
      else branch = normBranch(rhs);
    }
    else if (a !== 'origin' && a !== 'HEAD' && a !== remote) branch = normBranch(a);
  }
  return opFields({
    tool: 'git', sub: 'push', flags, branch, force, delete: deleteMode, refspecs, positionals: pos.length,
  }, { ...meta, args: pos });
};

const gitBranchOp = (rest, meta = {}) => {
  const flags = rest.filter(a => a.startsWith('-'));
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  let deleteMode = null;
  if (rest.some(a => a === '-D')) deleteMode = 'force';
  else if (rest.some(a => a === '--delete' && (rest.includes('--force') || rest.includes('-f')))) deleteMode = 'force';
  else if (rest.some(a => a === '-d' && (rest.includes('-f') || rest.includes('--force')))) deleteMode = 'force';
  else if (rest.some(a => a === '-d' || a === '--delete')) deleteMode = 'safe';
  const branch = pos[0] ?? null;
  return opFields({ tool: 'git', sub: 'branch', flags, branch, force: false, delete: deleteMode }, { ...meta, args: pos.slice(1) });
};

const gitOpFromArgs = args => {
  let sub = null, at = -1;
  const preFlags = [];
  let globalOpts = false;
  for (let j = 0; j < args.length; j += 1) {
    if (args[j] === '-C') { globalOpts = true; j += 1; continue; }
    if (args[j] === '-c' || args[j] === '--config-env') { globalOpts = true; j += 1; continue; }
    if (['--git-dir', '--work-tree', '--namespace'].includes(args[j])) { globalOpts = true; j += 1; continue; }
    if (!args[j].startsWith('-')) { sub = args[j]; at = j; break; }
    preFlags.push(args[j]);
    if (preFlags.length) globalOpts = true;
  }
  const rest = at === -1 ? [] : args.slice(at + 1);
  const flags = [...preFlags, ...rest.filter(a => a.startsWith('-'))];
  const meta = { args: rest.filter(a => a !== '' && !a.startsWith('-')), globalOpts, allArgs: args };
  if (sub === 'push') return gitPushOp(rest, meta);
  if (sub === 'branch') return gitBranchOp(rest, meta);
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  let branch = null;
  if (sub === 'rebase' && pos[0]) branch = pos[0];
  return opFields({ tool: 'git', sub, flags, branch, force: false, delete: null }, { ...meta, args: pos });
};

const ghSkipGlobal = args => {
  let globalOpts = false;
  let i = 0;
  for (; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) break;
    globalOpts = true;
    if (a === '-R' || a === '--repo') { i += 1; continue; }
  }
  return { globalOpts, rest: args.slice(i) };
};

const ghOpFromArgs = args => {
  const { globalOpts, rest } = ghSkipGlobal(args);
  const flags = args.filter(a => a.startsWith('-'));
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  const sub = pos[0] === 'api' ? 'api' : (pos[0] === 'search' ? 'search' : (pos.length >= 2 ? `${pos[0]} ${pos[1]}` : pos[0] ?? null));
  const target = sub === 'pr merge' && pos[2] !== undefined ? String(pos[2]) : null;
  const opArgs = sub === 'pr merge' ? pos.slice(3) : pos.length >= 2 ? pos.slice(2) : pos.slice(1);
  return opFields({ tool: 'gh', sub, flags, branch: null, force: false, delete: null, target }, { args: opArgs, globalOpts, allArgs: args });
};

const vercelOpFromArgs = args => {
  let globalOpts = false;
  let i = 0;
  for (; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) break;
    globalOpts = true;
    if (a === '--token' || a === '--scope') { i += 1; continue; }
    if (a === '-t' && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) { i += 1; continue; }
  }
  const rest = args.slice(i);
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  let sub = pos[0] ?? 'deploy';
  if (args.length === 0 || args.every(a => a.startsWith('-')) || args.some(a => a === '--prod')) sub = 'deploy';
  const opArgs = sub === pos[0] ? pos.slice(1) : pos;
  const flags = args.filter(a => a.startsWith('-'));
  return opFields({ tool: 'vercel', sub, flags, branch: null, force: false, delete: null }, { args: opArgs, globalOpts, allArgs: args });
};

const swarmOpFromArgs = args => {
  const pos = args.filter(a => a !== '' && !a.startsWith('-'));
  const sub = pos[0] ?? null;
  const flags = args.filter(a => a.startsWith('-'));
  const target = sub === 'merge' && pos[1] !== undefined ? String(pos[1]) : null;
  const opArgs = sub === 'merge' ? pos.slice(2) : pos.slice(1);
  return opFields({ tool: 'swarm', sub, flags, branch: null, force: false, delete: null, target }, { args: opArgs, globalOpts: false, allArgs: args });
};

/** The text inside $(...) and `...` (one level, not inside single quotes), so a command run by substitution is read too. */
function substitutions(text) {
  const out = [];
  const s = String(text ?? '');
  let single = false, double = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && !single) { i += 1; continue; }
    if (c === "'" && !double) { single = !single; continue; }
    if (c === '"' && !single) { double = !double; continue; }
    if (single) continue;
    if (c === '$' && s[i + 1] === '(') {
      let depth = 1, j = i + 2;
      for (; j < s.length && depth > 0; j += 1) { if (s[j] === '(') depth += 1; else if (s[j] === ')') depth -= 1; }
      out.push(s.slice(i + 2, j - 1));
      i = j - 1;
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j === -1) break;
      out.push(s.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

const fsExists = p => { try { return fs.existsSync(p); } catch { return false; } };
const SHELL_KEYWORDS = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', 'fi', 'done', 'case', 'esac', 'for', 'in', 'select', 'function', 'coproc']);
// Inline code is read-only only when it names nothing that can write, run a program or load a module. Everything else fails closed.
const INLINE_CHARS = /^[A-Za-z0-9_\s.,()+\-*/%'":<>=!;\[\]{}]*$/;
const INLINE_RISKY = /\b(?:require|import|importlib|open|file|fs|os|sys|subprocess|exec|eval|spawn|system|popen|write|unlink|remove|rename|rmdir|mkdir|process|child_process|deno|bun|globalthis|builtins|compile|__\w+__|shutil|pathlib|io|socket|net|http|fetch|chmod|chown|symlink|truncate|append|dump|save|put|copy|move|sh|bash|backtick|kernel|popen3|ruby|perl|fileutils|qx|shell_exec|passthru|file_put_contents|fopen|readfile|dir|file|io|pty|expect|osascript|lua)\b|[`|]|>>?\s*['"A-Za-z./~$]/i;
export const inlineLooksReadOnly = code => String(code ?? '').length <= 300 && INLINE_CHARS.test(String(code ?? '')) && !INLINE_RISKY.test(String(code ?? ''));
const CODE_FLAGS = { node: ['-e', '--eval', '-p', '--print'], python: ['-c'], python3: ['-c'], ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'], deno: ['eval'], bun: ['-e', '--eval'], tsx: ['-e', '--eval'], 'ts-node': ['-e', '--eval'] };
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'blame', 'grep', 'shortlog', 'cat-file', 'rev-list', 'fetch', 'add', 'version', 'help', 'for-each-ref', 'merge-base', 'name-rev', 'show-ref', 'count-objects', 'whatchanged', 'diff-tree', 'diff-index', 'check-ignore', 'ls-remote', 'var']);

const GIT_BRANCH_WRITE_FLAGS = new Set(['-d', '-D', '-m', '-M', '-c', '-C', '-u', '-f', '--force', '--delete', '--move', '--copy', '--set-upstream-to', '--unset-upstream']);
const GIT_BRANCH_LIST_FLAGS = new Set(['-l', '--list', '-a', '-r', '-v', '-vv', '--contains', '--merged', '--no-merged', '--format', '--sort', '--show-current']);
const GIT_CONFIG_WRITE_FLAGS = new Set(['--unset', '--unset-all', '--add', '--replace-all', '-e', '--edit', '--fixed-value']);
const GIT_CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope', '--default']);
const GIT_STASH_WRITE = new Set(['push', 'save', 'pop', 'apply', 'drop', 'clear', 'branch', 'create', 'store']);
const GIT_WORKTREE_WRITE = new Set(['add', 'remove', 'prune', 'move', 'lock', 'unlock']);
const GIT_REMOTE_WRITE = new Set(['add', 'remove', 'rename', 'set-url', 'prune', 'update', 'set-head', 'set-branches', 'set-url', 'delete']);
const GIT_TAG_WRITE_FLAGS = new Set(['-d', '-a', '-m', '-s', '-u', '-f', '--delete', '--annotate', '--sign', '--localize']);

export function isReadOnlyGitSub(sub, rest = []) {
  if (!sub) return true;
  const args = Array.isArray(rest) ? rest : [];
  if (sub === 'add' || sub === 'fetch') return false;
  if (READ_ONLY_GIT.has(sub)) return true;
  if (sub === 'branch') {
    if (args.some(a => GIT_BRANCH_WRITE_FLAGS.has(a) || a.startsWith('--set-upstream-to='))) return false;
    const pos = args.filter(a => a !== '' && !a.startsWith('-'));
    if (pos.length === 0) return true;
    if (args.some(a => GIT_BRANCH_LIST_FLAGS.has(a))) return true;
    return false;
  }
  if (sub === 'config') {
    if (args.some(a => GIT_CONFIG_WRITE_FLAGS.has(a) || a.startsWith('--unset'))) return false;
    if (args.some(a => GIT_CONFIG_READ_FLAGS.has(a))) return true;
    const pos = args.filter(a => a !== '' && !a.startsWith('-'));
    if (pos.length === 1 && !pos[0].includes('=')) return true;
    if (pos.length === 0 && args.some(a => a === '--global' || a === '-g' || a === '--system' || a === '--local')) return false;
    return false;
  }
  if (sub === 'remote') {
    const verb = args.find(a => a !== '' && !a.startsWith('-'));
    if (!verb) return args.every(a => a === '-v' || a === '-vv' || a.startsWith('-'));
    if (verb === 'show' || verb === 'get-url') return true;
    if (GIT_REMOTE_WRITE.has(verb)) return false;
    return args.every(a => a === '-v' || a === '-vv' || a.startsWith('-'));
  }
  if (sub === 'stash') {
    const verb = args.find(a => a !== '' && !a.startsWith('-'));
    if (!verb) return false;
    if (verb === 'list' || verb === 'show') return true;
    if (GIT_STASH_WRITE.has(verb)) return false;
    return false;
  }
  if (sub === 'worktree') {
    const verb = args.find(a => a !== '' && !a.startsWith('-'));
    if (verb === 'list' || !verb) return true;
    if (GIT_WORKTREE_WRITE.has(verb)) return false;
    return false;
  }
  if (sub === 'tag') {
    if (args.some(a => GIT_TAG_WRITE_FLAGS.has(a))) return false;
    const pos = args.filter(a => a !== '' && !a.startsWith('-'));
    if (pos.length === 0) return true;
    if (args.some(a => a === '-l' || a === '--list')) return true;
    return false;
  }
  if (sub === 'symbolic-ref') {
    if (args.includes('-d') || args.includes('--delete')) return false;
    const pos = args.filter(a => a !== '' && !a.startsWith('-'));
    return pos.length === 1;
  }
  return false;
}

const READ_ONLY_PIPE_FILTERS = new Set(['jq', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'cut', 'sort', 'uniq', 'tr']);
const SWARM_HANDBUILD_FILE_OPS = new Set(['request', 'status', 'show', 'list', 'log', 'check', 'help']);
const SWARM_CLI_READ_VERBS = new Set(['status', 'tickets', 'run', 'go', 'scope', 'change']);
export const HANDBUILD_OWNER_VERBS = new Set(['approve', 'deny', 'on', 'off', 'install', 'uninstall']);
export const HANDBUILD_VALUE_FLAGS = new Set([
  '-m', '-F', '-C', '-c', '--message', '--reason', '--prompt', '--guard-text',
  '--body', '--body-file', '--title', '--description', '--subject', '--file', '--kind', '--files', '--minutes', '--git',
  '--note', '--evidence', '--rule', '--fix', '--to',
]);

const HANDBUILD_VALUE_FLAG_PREFIXES = ['--message=', '--reason=', '--guard-text=', '--prompt=', '--kind=', '--files=', '--minutes=', '--git=', '--note=', '--evidence=', '--rule=', '--fix=', '--body=', '--body-file=', '--title=', '--description=', '--subject=', '--to='];

const skipFlagValue = (plain, i) => {
  const low = plain[i].toLowerCase();
  if (HANDBUILD_VALUE_FLAGS.has(low)) return i + (low.includes('=') ? 1 : 2);
  if (HANDBUILD_VALUE_FLAG_PREFIXES.some(p => low.startsWith(p))) return i + 1;
  return i + 1;
};

const skipSwarmGlobalOpts = (plain, i) => {
  let k = i;
  while (k < plain.length) {
    const a = plain[k].toLowerCase();
    if (a === '--root') { k += 2; continue; }
    if (a.startsWith('--root=')) { k += 1; continue; }
    if (a.startsWith('-')) { k += 1; continue; }
    break;
  }
  return k;
};

/** After `swarm SUB`, drop free-text operands (note body, ticket --note, lesson fields, …). */
const skipSwarmSubcommandTail = (plain, subLow, i) => {
  if (['note', 'decision', 'change', 'handoff'].includes(subLow)) return plain.length;
  if (subLow === 'ask') return plain.length;
  if (subLow === 'msg') {
    let k = i;
    if (k < plain.length && plain[k].toLowerCase() === 'send') k += 1;
    while (k < plain.length) {
      const low = plain[k].toLowerCase();
      if (!low.startsWith('-')) { k += 1; continue; }
      k = skipFlagValue(plain, k);
    }
    return k;
  }
  if (subLow === 'tickets') {
    let k = i;
    while (k < plain.length) {
      const a = plain[k];
      const low = a.toLowerCase();
      if (low.startsWith('-')) { k = skipFlagValue(plain, k); continue; }
      if (/^t-\d+/i.test(a) || /^\d+$/.test(a)) { k += 1; continue; }
      break;
    }
    while (k < plain.length) {
      const low = plain[k].toLowerCase();
      if (!low.startsWith('-')) { k += 1; continue; }
      k = skipFlagValue(plain, k);
    }
    return k;
  }
  if (subLow === 'lesson') {
    let k = i;
    if (k < plain.length && plain[k].toLowerCase() === 'add') k += 1;
    while (k < plain.length) {
      const low = plain[k].toLowerCase();
      if (!low.startsWith('-')) { k += 1; continue; }
      k = skipFlagValue(plain, k);
    }
    return k;
  }
  if (subLow === 'backlog') {
    let k = i;
    if (k < plain.length && plain[k].toLowerCase() === 'add') {
      k += 1;
      while (k < plain.length && plain[k].startsWith('-')) k = skipFlagValue(plain, k);
      if (k < plain.length) k += 1;
    }
    return k;
  }
  if (subLow === 'time') {
    let k = i;
    if (k < plain.length && plain[k].toLowerCase() === 'log') {
      k += 1;
      while (k < plain.length && plain[k].startsWith('-')) k = skipFlagValue(plain, k);
      if (k < plain.length) k += 1;
    }
    return k;
  }
  if (subLow === 'handbuild') {
    let k = i;
    while (k < plain.length) {
      const low = plain[k].toLowerCase();
      if (!low.startsWith('-')) { k += 1; continue; }
      k = skipFlagValue(plain, k);
    }
    return k;
  }
  if (subLow === 'decide') return i;
  return i;
};

/** Words that carry data, not shell verbs (commit messages, handbuild --reason, swarm note bodies, and the like). */
export function executablePlainWordsForHandbuild(plain) {
  const out = [];
  let i = 0;
  while (i < plain.length) {
    const w = plain[i];
    const low = w.toLowerCase();
    if (low === 'swarm') {
      out.push(w);
      i += 1;
      i = skipSwarmGlobalOpts(plain, i);
      if (i >= plain.length) continue;
      const sub = plain[i];
      const subLow = sub.toLowerCase();
      out.push(sub);
      i += 1;
      if (subLow === 'handbuild' && i < plain.length) {
        const verb = plain[i].toLowerCase();
        if (HANDBUILD_OWNER_VERBS.has(verb) || SWARM_HANDBUILD_FILE_OPS.has(verb)) {
          out.push(plain[i]);
          i += 1;
        }
      }
      const tailStart = i;
      i = skipSwarmSubcommandTail(plain, subLow, i);
      if (subLow === 'change') {
        for (let k = tailStart; k < plain.length; k += 1) {
          const low = plain[k].toLowerCase();
          if (low === '--yes' || low.startsWith('--yes=')) {
            out.push(plain[k]);
            break;
          }
        }
      }
      continue;
    }
    if (HANDBUILD_VALUE_FLAGS.has(low)) {
      i = skipFlagValue(plain, i);
      continue;
    }
    if (HANDBUILD_VALUE_FLAG_PREFIXES.some(p => low.startsWith(p))) {
      i += 1;
      continue;
    }
    if (low === 'git') {
      out.push(w);
      i += 1;
      if (i < plain.length && plain[i].toLowerCase() === 'commit') {
        out.push(plain[i]);
        i += 1;
        while (i < plain.length) {
          const a = plain[i];
          const al = a.toLowerCase();
          if (GIT_COMMIT_MSG_OPTS.has(al) || al.startsWith('--message=')) {
            i = skipFlagValue(plain, i);
            continue;
          }
          if (al.startsWith('-')) { i += 1; continue; }
          break;
        }
      }
      continue;
    }
    out.push(w);
    i += 1;
  }
  return out;
}

/** Orchestrator-mode input cap (orchestrator sessions only; callers skip for workers). */
export function orchestratorCommandTooLong(command) {
  const text = String(command ?? '');
  if (text.length > ORCHESTRATOR_COMMAND_MAX_BYTES) return true;
  const segments = tokenize(text);
  return segments.length > ORCHESTRATOR_COMMAND_MAX_SEGMENTS;
}

/** Character steps in `tokenize` (for linearity tests). */
export function tokenizeStepCount(command) {
  const countSteps = { n: 0 };
  tokenize(command, { countSteps });
  return countSteps.n;
}

/** Structural owner-only handbuild match in executable words, or null when absent. */
export function handbuildOwnerMatchInPlain(plain) {
  const exec = executablePlainWordsForHandbuild(plain);
  const lower = exec.map(x => x.toLowerCase());
  for (let i = 0; i < lower.length; i += 1) {
    if (lower[i] === 'decide' && lower[i + 1]?.startsWith('handbuild-') && (lower[i + 2] === 'approve' || lower[i + 2] === 'deny')) {
      return { verb: lower[i + 2], token: lower[i + 2], position: i + 2 };
    }
    if (lower[i] === 'swarm' && lower[i + 1] === 'decide' && lower[i + 2]?.startsWith('handbuild-') && (lower[i + 3] === 'approve' || lower[i + 3] === 'deny')) {
      return { verb: lower[i + 3], token: lower[i + 3], position: i + 3 };
    }
    if (lower[i] === 'handbuild' && HANDBUILD_OWNER_VERBS.has(lower[i + 1])) {
      return { verb: lower[i + 1], token: lower[i + 1], position: i + 1 };
    }
  }
  const hbVerb = swarmHandbuildVerbFromPlain(plain);
  if (hbVerb !== null && HANDBUILD_OWNER_VERBS.has(hbVerb)) {
    for (let i = 0; i < lower.length; i += 1) {
      if (lower[i] === 'handbuild' && lower[i + 1] === hbVerb) {
        return { verb: hbVerb, token: lower[i + 1], position: i + 1 };
      }
    }
  }
  return null;
}

const HANDBUILD_PROGRAM_WRAPPERS = new Set(['env', 'command', 'exec', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'caffeinate', 'sudo', 'xargs', 'builtin', 'setsid', 'chrt']);
const HANDBUILD_WRAPPER_VALUE_OPTS = { sudo: ['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U'], env: ['-u', '-C'], nice: ['-n'], stdbuf: ['-i', '-o', '-e'], timeout: ['-s', '-k', '--signal', '--kill-after'], xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E'] };

function skipToHandbuildProgram(plain) {
  let k = 0;
  let wrapperName = null;
  while (k < plain.length) {
    if (SHELL_KEYWORDS.has(plain[k])) { k += 1; continue; }
    if (!wrapperName && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) { k += 1; continue; }
    if (HANDBUILD_PROGRAM_WRAPPERS.has(plain[k])) { wrapperName = plain[k]; k += 1; continue; }
    if (wrapperName === 'env') {
      if (plain[k] === '-S' || plain[k] === '--split-string') return { index: k + 2, envSplit: plain[k + 1] };
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) { k += 1; continue; }
    }
    if (wrapperName === 'nice' && /^-\d+$/.test(plain[k])) { k += 1; wrapperName = null; continue; }
    if (wrapperName && plain[k].startsWith('-')) {
      const takes = (HANDBUILD_WRAPPER_VALUE_OPTS[wrapperName] ?? []).includes(plain[k]);
      k += takes ? 2 : 1;
      continue;
    }
    if (wrapperName === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(plain[k])) { k += 1; wrapperName = null; continue; }
    if (wrapperName) wrapperName = null;
    break;
  }
  return { index: k };
}

function skipSwarmGlobalArgs(lower, start = 0) {
  let i = start;
  while (i < lower.length) {
    const a = lower[i];
    if (a === '--root' || a.startsWith('--root=')) {
      i += a === '--root' ? 2 : 1;
      continue;
    }
    if (a.startsWith('-')) { i += 1; continue; }
    break;
  }
  return i;
}

function handbuildVerbAfterSwarmArgs(args) {
  const lower = args.map(w => w.toLowerCase());
  const i = skipSwarmGlobalArgs(lower, 0);
  if (lower[i] === 'handbuild') return lower[i + 1] ?? '';
  return null;
}

function swarmArgsRecordChange(args) {
  const lower = args.map(w => w.toLowerCase());
  const i = skipSwarmGlobalArgs(lower, 0);
  if (lower[i] !== 'change') return null;
  const records = lower.slice(i + 1).some(a => a === '--yes' || a.startsWith('--yes='));
  return { records };
}

/** `swarm change` preview (no --yes) or recording form; null when not a change-order command. */
export function swarmChangeFromPlain(plain) {
  const words = executablePlainWordsForHandbuild(plain);
  const { index, envSplit } = skipToHandbuildProgram(words);
  if (envSplit !== undefined) return swarmChangeFromPlain(envSplit.split(/\s+/).filter(Boolean));
  if (index >= words.length) return null;
  const cmd = path.basename(words[index]).toLowerCase();
  const args = words.slice(index + 1);
  if (cmd === 'change') return swarmArgsRecordChange(['change', ...args]);
  if (cmd === 'swarm') {
    const inv = swarmArgsRecordChange(args);
    if (inv) return inv;
  }
  if (cmd === 'node') {
    const scriptAt = args.findIndex(a => a !== '' && !a.startsWith('-'));
    if (scriptAt === -1) return null;
    const base = path.basename(args[scriptAt]).toLowerCase();
    if (base !== 'swarm.mjs' && !args[scriptAt].toLowerCase().endsWith('/swarm.mjs') && !args[scriptAt].toLowerCase().endsWith('\\swarm.mjs')) return null;
    return swarmArgsRecordChange(args.slice(scriptAt + 1));
  }
  return null;
}

/** handbuild subcommand on a `swarm` or `node … swarm.mjs` invocation only, or null when not a handbuild command. */
export function swarmHandbuildVerbFromPlain(plain) {
  const words = executablePlainWordsForHandbuild(plain);
  const { index, envSplit } = skipToHandbuildProgram(words);
  if (envSplit !== undefined) return swarmHandbuildVerbFromPlain(envSplit.split(/\s+/).filter(Boolean));
  if (index >= words.length) return null;
  const cmd = path.basename(words[index]).toLowerCase();
  const args = words.slice(index + 1);
  if (cmd === 'handbuild') return handbuildVerbAfterSwarmArgs(words.slice(index).map(w => w.toLowerCase()));
  if (cmd === 'swarm') return handbuildVerbAfterSwarmArgs(args);
  if (cmd === 'node') {
    const scriptAt = args.findIndex(a => a !== '' && !a.startsWith('-'));
    if (scriptAt === -1) return null;
    const base = path.basename(args[scriptAt]).toLowerCase();
    if (base !== 'swarm.mjs' && !args[scriptAt].toLowerCase().endsWith('/swarm.mjs') && !args[scriptAt].toLowerCase().endsWith('\\swarm.mjs')) return null;
    return handbuildVerbAfterSwarmArgs(args.slice(scriptAt + 1));
  }
  return null;
}

export function plainSetsHandbuildSelfApproval(plain) {
  const verb = swarmHandbuildVerbFromPlain(plain);
  if (verb !== null && HANDBUILD_OWNER_VERBS.has(verb)) return true;
  const lower = executablePlainWordsForHandbuild(plain).map(w => w.toLowerCase());
  for (let i = 0; i < lower.length; i += 1) {
    if (lower[i] === 'decide' && lower[i + 1]?.startsWith('handbuild-') && (lower[i + 2] === 'approve' || lower[i + 2] === 'deny')) return true;
    if (lower[i] === 'swarm' && lower[i + 1] === 'decide' && lower[i + 2]?.startsWith('handbuild-') && (lower[i + 3] === 'approve' || lower[i + 3] === 'deny')) return true;
  }
  return false;
}

function swarmCliArgsReadOnly(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--root' || a.startsWith('--root=')) {
      if (a === '--root') i += 2;
      else i += 1;
      continue;
    }
    if (a.startsWith('-')) { i += 1; continue; }
    break;
  }
  if (args[i] === 'handbuild' && SWARM_HANDBUILD_FILE_OPS.has(args[i + 1])) return true;
  if (args[i] === 'change') {
    const lower = args.map(w => String(w).toLowerCase());
    return !lower.slice(i + 1).some(a => a === '--yes' || a.startsWith('--yes='));
  }
  if (SWARM_CLI_READ_VERBS.has(args[i])) return true;
  return false;
}

function nodeInvokesSwarmHandbuildReadOnly(args) {
  const scriptAt = args.findIndex(a => a !== '' && !a.startsWith('-'));
  if (scriptAt === -1) return false;
  if (path.basename(args[scriptAt]) !== 'swarm.mjs') return false;
  const rest = args.slice(scriptAt + 1);
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === '--root' || a.startsWith('--root=')) {
      if (a === '--root') i += 2;
      else i += 1;
      continue;
    }
    if (a.startsWith('-')) { i += 1; continue; }
    break;
  }
  if (rest[i] !== 'handbuild') return swarmCliArgsReadOnly(rest);
  const verb = String(rest[i + 1] ?? '').toLowerCase();
  if (!verb || verb === '--help' || verb.startsWith('-')) return true;
  if (HANDBUILD_OWNER_VERBS.has(verb)) return false;
  if (SWARM_HANDBUILD_FILE_OPS.has(verb)) return true;
  return true;
}

function nodeInvokesSwarmChangeReadOnly(args) {
  const scriptAt = args.findIndex(a => a !== '' && !a.startsWith('-'));
  if (scriptAt === -1) return false;
  if (path.basename(args[scriptAt]) !== 'swarm.mjs') return false;
  const rest = args.slice(scriptAt + 1);
  const lower = rest.map(w => String(w).toLowerCase());
  const i = skipSwarmGlobalArgs(lower, 0);
  if (lower[i] !== 'change') return false;
  return !lower.slice(i + 1).some(a => a === '--yes' || a.startsWith('--yes='));
}

/** { writes, git, inline, unknown, protectedOutside, selfApproval } for one command line. `protectedAbs`: absolute path prefixes (the install, the user's own Claude settings) no write may touch. */
export function analyzeShell(command, { root, cwd = root, home = process.env.HOME || '/', protectedAbs = [], depth = 0 } = {}) {
  const writes = new Set(), git = new Set(), protectedOutside = new Set(), outsideDeletes = new Set(), ops = [];
  let inline = false, unknown = false, dynamic = false, selfApproval = false;
  const markDynamic = () => { dynamic = true; unknown = true; };
  let here = cwd;           // the directory relative paths mean: `cd DIR` moves it, an unreadable cd makes it unknown
  const heres = [...new Set([cwd, root].map(d => path.resolve(d)))];      // relative paths may mean cwd or the project root
  let hereKnown = true;
  const merge = r => { r.writes.forEach(w => writes.add(w)); r.git.forEach(g => git.add(g)); r.protectedOutside.forEach(p => protectedOutside.add(p)); (r.outsideDeletes ?? []).forEach(p => outsideDeletes.add(p)); (r.ops ?? []).forEach(o => ops.push(o)); inline ||= r.inline; unknown ||= r.unknown; dynamic ||= r.dynamic; selfApproval ||= r.selfApproval; };
  // The orchestrator's own folders and build output are free to write, except the guard's own state, and never the folders that contain it (.swarm itself).
  const lowerRel = rel => rel.toLowerCase();
  const allowedRel = rel => {
    const r = lowerRel(rel);
    if (r === '.swarm' || r === '.claude' || r === '.git' || r.startsWith('.git/') || r.startsWith('.swarm/handbuild')) return false;
    return ORCHESTRATOR_OWN.some(prefix => r === prefix.slice(0, -1) || r.startsWith(prefix)) || TOOL_DIRS.some(prefix => r === prefix.slice(0, -1) || r.startsWith(prefix));
  };
  const resolve = (raw, base = here, expands = false) => {
    let p = String(raw);
    if (!p) return { skip: true };
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/)/.test(p) || p === '-') return { skip: true };
    if (expands) return { unknown: true };
    if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(2));
    if (!path.isAbsolute(p) && !hereKnown) return { unknown: true };
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base || root, p);
    const rel = insideProject(root, abs);
    return rel === null ? { outside: true, abs, real: realOf(abs) } : { rel };
  };
  // a relative path may mean any of the places the session may be in (a cd may not have happened)
  const resolveAll = (raw, expands = false) => {
    const p = String(raw);
    if (path.isAbsolute(p) || p === '~' || p.startsWith('~/') || heres.length < 2) return [resolve(raw, here, expands)];
    return [...new Set(heres)].map(base => resolve(raw, base, expands));
  };
  const resolveProtectedReal = absPath => {
    let cur = path.resolve(absPath);
    const tail = [];
    for (let i = 0; i < 64; i += 1) {
      try {
        const real = fs.realpathSync.native(cur);
        return tail.length ? path.resolve(real, ...tail) : real;
      } catch {
        const base = path.basename(cur);
        if (base) tail.unshift(base);
        const up = path.dirname(cur);
        if (up === cur) break;
        cur = up;
      }
    }
    try { return fs.realpathSync.native(cur); } catch { return path.resolve(absPath); }
  };
  const protectedPathForms = abs => {
    const resolved = path.resolve(abs);
    const text = resolved.toLowerCase();
    let real = text;
    try { real = resolveProtectedReal(resolved).toLowerCase(); } catch { /* text only */ }
    return text === real ? [text] : [text, real];
  };
  const protectedPrefixMatches = (abs, prefix) => {
    for (const a of protectedPathForms(abs)) {
      for (const pre of protectedPathForms(prefix)) {
        if (a === pre || a.startsWith(`${pre}/`) || (pre.startsWith(`${a}/`) && a !== '/')) return true;
      }
    }
    return false;
  };
  const isProtectedAbs = r => [r.abs, r.real].filter(Boolean).some(abs => protectedAbs.some(prefix => protectedPrefixMatches(abs, prefix)));
  const globPatternUnknown = (raw, expands = false) => {
    if (!/[*?\[{]/.test(String(raw))) return false;
    const fixed = String(raw).replace(/[*?\[{].*$/, '');
    const rs = resolveAll(fixed || '.', expands);
    const free = rs.every(r => r.skip || (r.rel !== undefined && r.rel !== '' && allowedRel(r.rel) && !String(raw).split('/').includes('..') && !lowerRel(r.rel).startsWith('.swarm/handbuild') && lowerRel(r.rel) !== '.swarm')) && /\/$/.test(fixed);
    if (!free) { unknown = true; return true; }
    return false;
  };
  const target = (raw, expands = false) => {
    if (expands) { unknown = true; return; }
    // a pattern as a write target can reach files the guard cannot name: only a pattern inside a free folder (build output, .swarm/ minus the guard's state) is allowed
    if (/[*?\[{]/.test(String(raw))) {
      const fixed = String(raw).replace(/[*?\[{].*$/, '');
      const rs = resolveAll(fixed || '.', expands);
      const free = rs.every(r => r.skip || (r.rel !== undefined && r.rel !== '' && allowedRel(r.rel) && !String(raw).split('/').includes('..') && !lowerRel(r.rel).startsWith('.swarm/handbuild') && lowerRel(r.rel) !== '.swarm')) && /\/$/.test(fixed) ;
      if (!free) { unknown = true; return; }
    }
    for (const r of resolveAll(raw, expands)) {
      if (r.unknown) { unknown = true; continue; }
      if (r.outside) { if (isProtectedAbs(r)) protectedOutside.add(r.abs); continue; }
      if (r.rel !== undefined && !allowedRel(r.rel)) writes.add(r.rel === '' ? '.' : r.rel);
    }
  };
  // a command that writes files of its own choosing into a directory (a download, an extraction): the directory itself counts as written
  const targetDir = (dir, expands = false) => {
    for (const r of resolveAll(dir, expands)) {
      if (r.unknown) { unknown = true; continue; }
      if (r.outside) { if (isProtectedAbs(r)) protectedOutside.add(r.abs); continue; }
      if (r.rel !== undefined && (r.rel === '' || !allowedRel(r.rel) || lowerRel(r.rel) === '.swarm')) writes.add(r.rel === '' ? '.' : r.rel);
    }
  };
  const recurse = text => { if (depth < 4) merge(analyzeShell(text, { root, cwd: here, home, protectedAbs, depth: depth + 1 })); else unknown = true; };
  for (const sub of substitutions(command)) recurse(sub);
  const tokenized = tokenize(command);
  if (tokenized.unclosedQuote) unknown = true;
  for (const words of tokenized) {
    const wordExp = words.expands ?? [];
    const redirectedInput = words.some(w => w === '<' || w === '<<' || w === '<<<');
    for (let i = 0; i < words.length; i += 1) {
      if (['>', '>>', '>|', '>&', '&>'].includes(words[i]) && words[i + 1] !== undefined && !/^&?\d+$/.test(words[i + 1])) target(words[i + 1], wordExp[i + 1]);
    }
    const plain = [], plainExp = [];
    for (let i = 0; i < words.length; i += 1) {
      if (['>', '>>', '>|', '>&', '&>', '<', '<<<'].includes(words[i])) { i += 1; continue; }
      if (words[i] === '<<') continue;      // the here-document delimiter was already taken by the tokenizer
      if (/^\d+$/.test(words[i]) && ['>', '>>', '>&'].includes(words[i + 1])) continue;
      plain.push(words[i]);
      plainExp.push(wordExp[i] ?? false);
    }
    if (plainSetsHandbuildSelfApproval(plain)) selfApproval = true;
    // find the real command: skip shell keywords, assignments and wrappers (with the options of a wrapper that take a value)
    let k = 0, wrapperName = null;
    const wrappers = [];
    const gitEnv = plain.some(w => /^GIT_[A-Z_]+=/.test(w));
    for (;;) {
      if (k >= plain.length) break;
      if (SHELL_KEYWORDS.has(plain[k])) { k += 1; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) { k += 1; continue; }
      if (WRAPPERS.has(plain[k])) { wrapperName = plain[k]; wrappers.push(wrapperName); k += 1; continue; }
      if (wrapperName === 'env' && (plain[k] === '-S' || plain[k] === '--split-string') && plain[k + 1] !== undefined) { recurse(plain[k + 1]); k = plain.length; break; }
      if (wrapperName && plain[k].startsWith('-')) { const takes = (WRAPPER_VALUE_OPTS[wrapperName] ?? []).includes(plain[k]); k += takes ? 2 : 1; continue; }
      if (wrapperName === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(plain[k])) { k += 1; wrapperName = null; continue; }
      break;
    }
    if (k >= plain.length) continue;
    // a command word that is a variable or a substitution cannot be read
    if (plainExp[k] || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(plain[k]) || /^\$\{/.test(plain[k])) { markDynamic(); continue; }
    const cmd = path.basename(plain[k]);
    const args = plain.slice(k + 1);
    if (words.piped) {
      if (READ_ONLY_PIPE_FILTERS.has(cmd)) { /* read-only filter */ }
      else if (SHELLS.has(cmd) || cmd === 'eval' || cmd === 'xargs') markDynamic();
      else if (pipeMakesInterpreterDynamic(cmd, args)) markDynamic();
    }
    const argExp = plainExp.slice(k + 1);
    const operands = [], operandExp = [];
    for (let ai = 0; ai < args.length; ai += 1) {
      if (args[ai] !== '' && !args[ai].startsWith('-')) { operands.push(args[ai]); operandExp.push(argExp[ai] ?? false); }
    }
    const operandAt = op => { const i = operands.indexOf(op); return i === -1 ? false : operandExp[i]; };
    // a script run by its path, or sourced: judged like an interpreter's script
    const scriptRule = (script, expands = false) => {
      const r = resolve(script, here, expands);
      if (r.unknown) { unknown = true; return; }
      if (r.outside) { if (!protectedAbs.some(prefix => r.abs === prefix || r.abs.startsWith(`${prefix}/`))) inline = true; return; }
      if (r.rel === undefined) return;
      const low = r.rel.toLowerCase();
      if (ORCHESTRATOR_OWN.some(prefix => low.startsWith(prefix)) || ['dist/', 'build/', '.cache/', '.turbo/', '.next/', 'coverage/'].some(prefix => low.startsWith(prefix))) inline = true;
    };
    if (cmd === 'source' || plain[k] === '.') { if (operands[0] !== undefined) scriptRule(operands[0], operandExp[0]); continue; }
    if (cmd === 'cd' || cmd === 'pushd') {
      // the new folder is added to the places relative paths may mean: the cd may not happen (it can fail, or sit in a subshell), so the old ones stay
      const r = operands[0] === undefined ? { abs: home, outside: true } : resolve(operands[0], here, operandExp[0]);
      if (r.unknown || r.skip) hereKnown = false;
      else {
        const dir = r.outside ? r.abs : path.resolve(root, r.rel);
        if (!fsExists(dir)) hereKnown = false;
        // `cd DIR && ...` with DIR present: the next commands really run there; any other cd may not happen, so the old place stays a candidate
        const cdSure = fsExists(dir) || (words.sepAfter === '&&' && r.outside && path.isAbsolute(dir));
        if (words.sepAfter === '&&' && cdSure) { here = dir; heres.length = 0; heres.push(dir); }
        else { here = dir; heres.push(dir); }
      }
      continue;
    }
    if (SHELLS.has(cmd)) {
      const at = args.findIndex(codeFlagFor(cmd));
      if (at !== -1) {
        const code = args[at + 1] ?? '';
        if (shellCodeDynamic(code)) markDynamic();
        else recurse(code);
        continue;
      }
    }
    if (cmd === 'eval') { markDynamic(); recurse(args.join(' ')); continue; }
    if (cmd === 'base64' && base64Decodes(args)) markDynamic();
    if (cmd === 'find' && args.some(a => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(a))) {
      const searchPaths = [];
      for (let fj = 0; fj < args.length; fj += 1) {
        const fa = args[fj];
        if (fa.startsWith('-')) break;
        if (fa !== '') searchPaths.push({ p: fa, exp: argExp[fj] ?? false });
      }
      const execIsWriter = innerWords => innerWords.some(a => WRITERS.has(path.basename(a)) || isInterpreter(path.basename(a)));
      const sliceExec = start => {
        const out = [];
        for (let j = start; j < args.length; j += 1) {
          const a = args[j];
          if (a === ';' || a === '+' || a === '\\;') break;
          out.push(a);
        }
        return out;
      };
      let hasDelete = args.includes('-delete');
      let hasWriterExec = false;
      for (let fj = 0; fj < args.length; fj += 1) {
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(args[fj])) {
          const inner = sliceExec(fj + 1);
          recurse(inner.join(' '));
          if (execIsWriter(inner)) hasWriterExec = true;
        }
      }
      if ((hasDelete || hasWriterExec) && searchPaths.length === 0) unknown = true;
      if (hasDelete) {
        for (const { p, exp } of searchPaths) {
          if (exp) { unknown = true; continue; }
          if (globPatternUnknown(p, exp)) continue;
          for (const r of resolveAll(p, exp)) {
            if (r.unknown) { unknown = true; continue; }
            if (r.outside) { outsideDeletes.add(r.abs); if (isProtectedAbs(r)) protectedOutside.add(r.abs); }
            else if (r.rel !== undefined && !allowedRel(r.rel)) writes.add(r.rel === '' ? '.' : r.rel);
          }
        }
      }
      for (let fj = 0; fj < args.length; fj += 1) {
        if (args[fj] === '-fprint' || args[fj] === '-fprintf' || args[fj] === '-fls') {
          const fp = args[fj + 1];
          if (fp !== undefined) target(fp, argExp[fj + 1] ?? false);
        }
      }
      continue;
    }
    if (wrappers.includes('xargs') && (WRITERS.has(cmd) || isInterpreter(cmd))) unknown = true;
    if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk' || cmd === 'nawk') {
      const code = args.join(' ');
      if (/system\s*\(|print[^;}]*>|printf[^;}]*>|-i\s*inplace|\|\s*["']|getline\s*<|close\s*\(/.test(code)) inline = true;
      continue;
    }
    if (cmd === 'tee') operands.forEach((o, oi) => target(o, operandExp[oi]));
    else if (cmd === 'sed') {
      const inPlace = args.some(a => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='));
      // BSD sed takes the backup suffix as the next word (-i '' or -i .bak); GNU sed does not. A following word that is empty or starts with a dot is that suffix.
      const rest = args.slice();
      const at = rest.indexOf('-i');
      if (at !== -1 && (rest[at + 1] === '' || /^\./.test(rest[at + 1] ?? ''))) rest.splice(at + 1, 1);
      let usesE = false;
      const files = [], scripts = [];
      for (let j = 0; j < rest.length; j += 1) {
        if (rest[j] === '-e' || rest[j] === '-f' || /^-[A-Za-z]*[ef]$/.test(rest[j])) { usesE = true; if (rest[j + 1] !== undefined) scripts.push(rest[j + 1]); j += 1; continue; }
        if (rest[j] !== '' && !rest[j].startsWith('-')) files.push(rest[j]);
      }
      if (!usesE && files[0] !== undefined) scripts.push(files[0]);
      // the sed commands that write or run: w, W (write a file), e (run a command), and the w / e flags of s///
      if (scripts.some(sc => /(^|[;{}\s\d$/])[wW]\s*[\w./~-]|(^|[;{}\s])e(\s|$|;)|\/[gimp0-9]*[we][gimp0-9]*(;|$|\s)/.test(sc))) inline = true;
      if (inPlace) files.slice(usesE ? 0 : 1).forEach(f => target(f, operandAt(f)));
    } else if (cmd === 'perl' && args.some(a => /^-[A-Za-z]*i/.test(a))) operands.slice(args.some(a => a === '-e' || /^-[A-Za-z]*e$/.test(a)) ? 0 : 1).forEach((o, oi) => target(o, operandExp[oi]));
    else if (cmd === 'mv') operands.forEach((o, oi) => target(o, operandExp[oi]));
    else if (cmd === 'cp' || cmd === 'install' || cmd === 'ln' || cmd === 'rsync') {
      const t = args.findIndex(a => a === '-t' || a === '--target-directory');
      if (t !== -1 && args[t + 1]) targetDir(args[t + 1], argExp[t + 1]); else if (operands.length) target(operands[operands.length - 1], operandExp[operandExp.length - 1]);
      // a link made in a free folder can point into the checkout: the place it points at counts too
      if (cmd === 'ln' && operands.length >= 2) target(operands[0], operandExp[0]);
    } else if (['rm', 'rmdir', 'unlink'].includes(cmd)) {
      operands.forEach((o, oi) => {
        if (operandExp[oi]) { unknown = true; return; }
        if (/[*?\[{]/.test(String(o))) {
          const fixed = String(o).replace(/[*?\[{].*$/, '');
          const rs = resolveAll(fixed || '.', operandExp[oi]);
          const free = rs.every(r => r.skip || (r.rel !== undefined && r.rel !== '' && allowedRel(r.rel) && !String(o).split('/').includes('..') && !lowerRel(r.rel).startsWith('.swarm/handbuild') && lowerRel(r.rel) !== '.swarm')) && (fixed === '' ? false : /\/$/.test(fixed));
          if (!free) {
            if (rs.some(r => r.rel !== undefined) || fixed === '' || fixed === '.') { unknown = true; return; }
          }
          for (const r of rs) {
            if (r.outside) {
              outsideDeletes.add(r.abs);
              if (isProtectedAbs(r)) protectedOutside.add(r.abs);
            }
          }
          return;
        }
        for (const r of resolveAll(o, operandExp[oi])) {
          if (r.unknown) { unknown = true; continue; }
          if (r.outside) { outsideDeletes.add(r.abs); if (isProtectedAbs(r)) protectedOutside.add(r.abs); continue; }
          if (r.rel !== undefined && !allowedRel(r.rel)) writes.add(r.rel === '' ? '.' : r.rel);
        }
      });
    } else if (['touch', 'mkdir', 'truncate', 'chmod', 'chown', 'ed', 'ex'].includes(cmd)) operands.forEach((o, oi) => target(o, operandExp[oi]));
    else if (cmd === 'patch') { const explicit = operands.length >= 1; if (!explicit) unknown = true; else operands.forEach((o, oi) => target(o, operandExp[oi])); }
    else if (cmd === 'dd') {
      for (let dj = 0; dj < args.length; dj += 1) {
        const a = args[dj];
        if (a.startsWith('of=')) target(a.slice(3), argExp[dj] ?? false);
      }
    }
    else if (cmd === 'curl' || cmd === 'wget') {
      let named = false;
      for (let j = 0; j < args.length; j += 1) {
        const a = args[j];
        if ((a === '--output' || a === '--output-document' || /^-[A-Za-z]*o$/.test(a) || (cmd === 'wget' && /^-[A-Za-z]*O$/.test(a))) && args[j + 1] !== undefined) { target(args[j + 1], argExp[j + 1]); named = true; j += 1; }
        else if (['-P', '--directory-prefix', '--output-dir'].includes(a) && args[j + 1] !== undefined) { targetDir(args[j + 1], argExp[j + 1]); named = true; j += 1; }
        else if (/^-[A-Za-z]*O$/.test(a) || a === '--remote-name') { targetDir(here || root); named = true; }
        else if (/^--(?:output|output-document)=/.test(a)) { target(a.split('=').slice(1).join('=')); named = true; }
        else if (/^-o./.test(a)) { target(a.slice(2)); named = true; }
      }
      if (cmd === 'wget' && !named && operands.length) targetDir(here || root);
    } else if (cmd === 'tar') {
      const extracts = args.some(a => (/^-?[A-Za-z]*x[A-Za-z]*$/.test(a) && !a.startsWith('--') && (a.startsWith('-') || a === args[0])) || a === '--extract' || a === '--get');
      if (extracts) { const c = args.findIndex(a => a === '-C' || a === '--directory'); targetDir(c !== -1 && args[c + 1] ? args[c + 1] : (here || root), c !== -1 && args[c + 1] ? argExp[c + 1] : false); }
    } else if (cmd === 'unzip') { const d = args.indexOf('-d'); targetDir(d !== -1 && args[d + 1] ? args[d + 1] : (here || root), d !== -1 && args[d + 1] ? argExp[d + 1] : false); }
    else if (cmd === 'git') {
      ops.push(gitOpFromArgs(args));
      let sub = null, at = -1, gitDir = null, config = false;
      for (let j = 0; j < args.length; j += 1) {
        if (args[j] === '-C') { gitDir = args[j + 1]; j += 1; continue; }
        if (args[j] === '-c' || args[j] === '--config-env') { config = true; j += 1; continue; }
        if (['--git-dir', '--work-tree', '--namespace'].includes(args[j])) { j += 1; continue; }
        if (!args[j].startsWith('-')) { sub = args[j]; at = j; break; }
      }
      const rest = at === -1 ? [] : args.slice(at + 1);
      // git reads settings that can run programs (-c, GIT_* in the environment): only a repository outside the checkout is exempt from that
      const there = gitDir !== null ? resolve(gitDir) : { rel: undefined };
      const elsewhere = (gitDir !== null && (there.outside || (there.rel !== undefined && allowedRel(there.rel)))) || (gitDir === null && heres.every(h => !path.resolve(h).startsWith(root + path.sep) && path.resolve(h) !== root) && hereKnown);
      if (elsewhere) { /* another repository (or a worker workspace): not the checkout */ }
      else if (config || gitEnv) git.add('config');
      else if (sub === null) { /* git --version */ }
      else if (rest.some(a => a === '--output' || a.startsWith('--output=') || a === '-O')) git.add('output');
      else if (sub === 'remote') { if (!isReadOnlyGitSub('remote', rest)) git.add('remote'); }
      else if (sub === 'config') { if (!isReadOnlyGitSub('config', rest)) git.add('config'); }
      else if (sub === 'stash') { if (!isReadOnlyGitSub('stash', rest)) git.add('stash'); }
      else if (sub === 'worktree') { if (!isReadOnlyGitSub('worktree', rest)) git.add('worktree'); }
      else if (sub === 'tag') { if (!isReadOnlyGitSub('tag', rest)) git.add('tag'); }
      else if (sub === 'symbolic-ref') { if (!isReadOnlyGitSub('symbolic-ref', rest)) git.add('symbolic-ref'); }
      else if (READ_ONLY_GIT.has(sub)) { /* reads, or only the index/refs */ }
      else if (sub === 'checkout' || sub === 'switch') {
        const ops = rest.filter(a => !a.startsWith('-'));
        // `git checkout X`: a branch, unless X (or more than one word, or `--`) names files that exist in the project, which it would restore
        const pathy = rest.includes('--') || ops.length > 1 || ops.some(a => { const r = resolve(a); return r.rel !== undefined && fsExists(path.resolve(root, r.rel)); });
        if (rest.some(a => a === '-b' || a === '-B' || a === '-c' || a === '-C') && !rest.includes('--') && sub === 'checkout') { /* a new branch */ }
        else if (pathy || rest.includes('-f') || rest.includes('--force') || rest.includes('--discard-changes')) git.add(sub);
      }
      else if (sub === 'branch') { if (!isReadOnlyGitSub('branch', rest)) git.add('branch'); }
      else git.add(sub);
    } else if (cmd === 'gh') {
      ops.push(ghOpFromArgs(args));
    } else if (cmd === 'vercel') {
      ops.push(vercelOpFromArgs(args));
    } else if (cmd === 'swarm') {
      ops.push(swarmOpFromArgs(args));
    } else if (isInterpreter(cmd)) {
      if (cmd === 'node' && (nodeInvokesSwarmHandbuildReadOnly(args) || nodeInvokesSwarmChangeReadOnly(args))) continue;
      const isCode = codeFlagFor(cmd);
      const at = args.findIndex(isCode);
      if (at !== -1) {
        // inline code: read-only only when it names nothing that can write or load a program; else it fails closed
        if (!inlineLooksReadOnly(args[at + 1] ?? '')) inline = true;
      } else {
        // an interpreter run on a script: one the orchestrator could have written (.swarm/, docs/plans/, build folders) or one outside the checkout is unread, so it fails closed;
        // repo scripts and tools are tests and builds
        const script = operands.find(a => !/^[A-Za-z0-9_-]+$/.test(a) || /\.\w+$/.test(a)) ?? operands[0];
        if (script === undefined) { if (words.piped || redirectedInput) inline = true; }      // the program comes from standard input
        else scriptRule(script, operandAt(script));
      }
    } else if (/\//.test(plain[k])) {
      // a program run by its path (./tool.sh, /tmp/x): a script there is judged like an interpreter's
      scriptRule(plain[k], plainExp[k]);
    }
  }
  return { writes: [...writes].sort(), git: [...git].sort(), ops, inline, unknown, dynamic, protectedOutside: [...protectedOutside].sort(), outsideDeletes: [...outsideDeletes].sort(), selfApproval };
}

/** True when a command writes anything the guard cares about. */
export const writesAnything = a => a.writes.length > 0 || a.git.length > 0 || a.inline || a.unknown || a.protectedOutside.length > 0 || (a.outsideDeletes?.length > 0) || a.selfApproval;

const OM_MAX_HEAD_TAIL = 200;
const OM_PIPE_FILTERS = new Set(['head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'cut', 'sort', 'uniq', 'wc', 'jq', 'sed']);
const OM_READ_NEEDS_CAP = new Set(['cat', 'grep', 'egrep', 'fgrep', 'rg', 'cut', 'sort', 'uniq', 'jq', 'find', 'sed']);
const OM_GH_ALLOWED = new Set([
  'pr view', 'pr list', 'pr checks', 'pr diff', 'pr status',
  'issue view', 'issue list', 'issue status',
  'run list', 'run view', 'run status',
  'release list', 'release view',
  'workflow list', 'workflow view',
  'repo view',
  'search', 'auth status',
]);
const OM_BLOCKED_WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'eval', 'source', 'xargs', 'timeout', 'nice', 'nohup', 'time', 'stdbuf', 'setsid', 'chrt', 'caffeinate']);
const OM_GIT_GREP_OPTS = new Set(['-n', '-i', '-l', '-c', '-e', '-w', '-F', '-E', '-h', '-H', '-I', '--no-color', '--count', '--line-number']);
const OM_GIT_GLOBAL_FORBIDDEN = /^(-C|-c|--config|--config-env|--git-dir|--work-tree|--namespace|--output|--exec|--upload-pack|--receive-pack|--textconv|--ext-diff|-o|--open-files-in-pager)/;
const OM_FIND_FORBIDDEN = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fls', '-fprintf']);
const OM_GREP_FILE_FLAGS = new Set(['--pre', '--pre-glob', '-f', '--file', '--exclude-from']);
const OM_JQ_FILE_FLAGS = new Set(['--rawfile', '--slurpfile', '-f', '--from-file', '--args']);
const OM_SENSITIVE_HOME_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.config/gh', 'Library/Keychains'];

const OM_TRUSTED_PATH = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')].join(path.delimiter);

let omTrustedBins;
const omTrustedBinRealpath = name => {
  try {
    const hit = execFileSync('which', [name], { encoding: 'utf8', env: { ...process.env, PATH: OM_TRUSTED_PATH }, timeout: 1000 }).trim().split('\n')[0];
    if (!hit) return null;
    return fs.realpathSync.native(hit);
  } catch { return null; }
};

/** Resolve git/gh/vercel/node once from a fixed trusted PATH (not the session PATH). */
export function initOrchestratorModeTrustedBins() {
  if (omTrustedBins) return omTrustedBins;
  const nodePaths = new Set([process.execPath]);
  const fromPath = omTrustedBinRealpath('node');
  if (fromPath) nodePaths.add(fromPath);
  omTrustedBins = {
    git: omTrustedBinRealpath('git'),
    gh: omTrustedBinRealpath('gh'),
    vercel: omTrustedBinRealpath('vercel'),
    node: nodePaths,
  };
  return omTrustedBins;
};

const omTrustedCommandWordOk = (rawCmd, kind) => {
  if (path.basename(rawCmd) !== kind) return false;
  if (!rawCmd.includes('/')) return rawCmd === kind;
  initOrchestratorModeTrustedBins();
  if (kind === 'node') {
    try { return omTrustedBins.node.has(fs.realpathSync.native(path.resolve(rawCmd))); } catch { return false; }
  }
  const trusted = omTrustedBins[kind];
  if (!trusted) return false;
  try { return fs.realpathSync.native(path.resolve(rawCmd)) === trusted; } catch { return false; }
};

let omSwarmMjsInstallPath;
const omSwarmMjsRealpath = () => {
  if (omSwarmMjsInstallPath !== undefined) return omSwarmMjsInstallPath;
  try {
    omSwarmMjsInstallPath = fs.realpathSync.native(path.join(os.homedir(), '.project-swarm', 'current', 'tools', 'swarm.mjs'));
  } catch {
    omSwarmMjsInstallPath = null;
  }
  return omSwarmMjsInstallPath;
};

let omLauncherRunnerPath;
const omLauncherSwarmRunner = () => {
  if (omLauncherRunnerPath !== undefined) return omLauncherRunnerPath;
  try {
    const wrapper = path.join(os.homedir(), '.local', 'bin', 'swarm');
    const text = fs.readFileSync(wrapper, 'utf8');
    if (!text.includes('managed by project-swarm')) { omLauncherRunnerPath = null; return null; }
    const legacy = /^exec "\$NODE" '((?:[^']|'\\'')*)'/m.exec(text);
    if (legacy) {
      omLauncherRunnerPath = fs.realpathSync.native(legacy[1].replaceAll("'\\''", "'"));
      return omLauncherRunnerPath;
    }
    const quoted = /^exec\s+"[^"]*"\s+"([^"]+)"\s/m.exec(text);
    if (quoted) {
      omLauncherRunnerPath = fs.realpathSync.native(quoted[1]);
      return omLauncherRunnerPath;
    }
    omLauncherRunnerPath = null;
  } catch { omLauncherRunnerPath = null; }
  return omLauncherRunnerPath;
};

const omSwarmCommandWordOk = rawCmd => {
  if (path.basename(rawCmd) !== 'swarm') return false;
  if (rawCmd === 'swarm') {
    try {
      const which = execFileSync('which', ['swarm'], { encoding: 'utf8', timeout: 1000 }).trim().split('\n')[0];
      const wrap = fs.realpathSync.native(path.join(os.homedir(), '.local', 'bin', 'swarm'));
      return Boolean(which) && fs.realpathSync.native(which) === wrap;
    } catch { return false; }
  }
  if (rawCmd.endsWith('swarm.mjs')) {
    try {
      const runner = omLauncherSwarmRunner() ?? omSwarmMjsRealpath();
      return runner !== null && fs.realpathSync.native(path.resolve(rawCmd)) === runner;
    } catch { return false; }
  }
  return false;
};

const omArgPoisoned = a => {
  const s = String(a ?? '');
  return s.startsWith('ext::') || s.includes('!');
};

const omExactLongOpt = (allowed, arg) => {
  if (!arg.startsWith('--')) return false;
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg : arg.slice(0, eq);
  return allowed.has(name);
};

const omExactShortOpt = (allowed, arg) => {
  if (!arg.startsWith('-') || arg.startsWith('--')) return false;
  if (arg.length === 2) return allowed.has(arg);
  for (let i = 1; i < arg.length; i += 1) {
    if (!allowed.has(`-${arg[i]}`)) return false;
  }
  return true;
};

const omGitOptsExact = (rest, { shorts, longs, valueShort = new Set(), valueLong = new Set(), numericShort = false }) => {
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--') return true;
    if (!a.startsWith('-')) continue;
    if (numericShort && /^-[1-9]\d*$/.test(a)) continue;
    if (omArgPoisoned(a)) return false;
    if (OM_GIT_GLOBAL_FORBIDDEN.test(a) || a.startsWith('--open-files-in-pager') || /^-O/.test(a)) return false;
    const longOk = a.startsWith('--') ? omExactLongOpt(longs, a) : false;
    const shortOk = !a.startsWith('--') ? omExactShortOpt(shorts, a) : false;
    if (!longOk && !shortOk) return false;
    const longName = a.startsWith('--') ? (a.includes('=') ? a.slice(0, a.indexOf('=')) : a) : null;
    const takes = valueShort.has(a) || (longName && (valueLong.has(longName) || (longName && !a.includes('=') && valueLong.has(longName))));
    if (takes && !a.includes('=')) i += 1;
  }
  return true;
};

const omHeadTailLinesOk = args => {
  if (args.some(a => a === '-c' || a === '-f' || a === '-F' || a === '--follow' || a === '--bytes')) return false;
  if (args.some(a => a === '-f' || a === '-F' || a === '--follow')) return false;
  let sawN = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-c' || a === '-f' || a === '-F' || a === '--follow') return false;
    if (a.startsWith('-') && !a.startsWith('--') && a.length > 2 && /[cfF+]/.test(a.slice(1))) return false;
    if (/^\+/.test(a)) return false;
    if (a === '-n' || a === '--lines') {
      sawN = true;
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n) || n > OM_MAX_HEAD_TAIL) return false;
      continue;
    }
    if (/^-n\d+$/.test(a)) {
      sawN = true;
      const n = Number(a.slice(2));
      if (!Number.isFinite(n) || n > OM_MAX_HEAD_TAIL) return false;
      continue;
    }
    if (/^-\d+$/.test(a)) {
      sawN = true;
      const n = Number(a.slice(1));
      if (!Number.isFinite(n) || n > OM_MAX_HEAD_TAIL) return false;
      continue;
    }
    if (a.startsWith('--lines=')) {
      sawN = true;
      const n = Number(a.slice(8));
      if (!Number.isFinite(n) || n > OM_MAX_HEAD_TAIL) return false;
    }
  }
  return sawN;
};

const omFindReadOnly = args => !args.some(a => OM_FIND_FORBIDDEN.has(a) || a.startsWith('-fprint'));

const omSedLinePrintScript = raw => {
  const sc = String(raw ?? '').trim().replace(/^'|'$/g, '');
  return /^[\d,]+p$/.test(sc);
};

const omSedOptionForbidden = a => {
  const s = String(a);
  if (s === '-i' || s === '--in-place' || s.startsWith('--in-place=')) return true;
  if (s === '-e' || s === '-f' || s === '--expression' || s === '--file') return true;
  if (s.startsWith('--expression=') || s.startsWith('--file=')) return true;
  if (/^-[A-Za-z]*[efil]/.test(s)) return true;
  if (s.startsWith('-') && s !== '-n') return true;
  return false;
};

/** Only `sed -n 'N,Mp' FILE` (one line-print script, then file operands to read). */
const omSedReadOnly = (args, ctx) => {
  if (args.some(omSedOptionForbidden)) return false;
  if (!args.includes('-n')) return false;
  const pos = args.filter(a => a !== '' && !a.startsWith('-'));
  if (pos.length < 2) return false;
  if (!omSedLinePrintScript(pos[0])) return false;
  for (let i = 1; i < pos.length; i += 1) {
    const a = pos[i];
    if (/^s[^a-zA-Z]/.test(a) || a.includes('=')) return false;
    if (!omReadOperandOk(a, ctx)) return false;
  }
  return true;
};

const omGhPrMerge = args => {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === 'pr' && args[i + 1] === 'merge') return true;
  }
  return false;
};

const OM_VERCEL_TOP_FREE = new Set(['ls', 'list', 'inspect', 'logs', 'whoami', '--version', 'help']);
const OM_VERCEL_LIST_PARENTS = new Set(['env', 'domains', 'projects', 'project', 'teams', 'team', 'dns', 'certs', 'certificates', 'alias', 'secrets', 'integration', 'redirects', 'rolling-release']);
const OM_VERCEL_INFO_FLAGS = new Set(['--help', '-h', '--version', '-v']);

const omVercelReadOnly = args => {
  const flags = args.filter(a => a.startsWith('-'));
  const pos = args.filter(a => a !== '' && !a.startsWith('-'));
  if (flags.some(f => f === '--token' || f.startsWith('--token='))) return false;
  if (flags.includes('--prod')) return false;
  if (args.some(a => a === '--scope' || a === '--token' || a.startsWith('--scope=') || a.startsWith('--token='))) return false;
  const onlyVersion = (args.includes('--version') || args.includes('-v')) && pos.length === 0;
  const sub = onlyVersion ? '--version' : (args.includes('--prod') || pos.length === 0 || args.every(a => a.startsWith('-')) ? 'deploy' : pos[0]);
  if (sub === 'deploy') {
    if (pos.length > 0) return false;
    if (flags.length === 0) return false;
    return flags.every(f => OM_VERCEL_INFO_FLAGS.has(f));
  }
  if (OM_VERCEL_TOP_FREE.has(sub)) return true;
  if (sub === 'inspect') return true;
  if (OM_VERCEL_LIST_PARENTS.has(sub) && pos.length >= 2 && ['ls', 'list', 'inspect'].includes(pos[1])) return true;
  return false;
};

const omGhWebFlag = (args, commandText) => {
  for (const a of args) {
    if (a === '--web' || a === '-w') return true;
    if (a.startsWith('--we') && a !== '--web' && '--web'.startsWith(a)) return true;
    if (a === '--watch' || (a.startsWith('--watch') && a !== '--watch')) return true;
  }
  return /(?:^|\s)(?:--web|--we\b|-w\b|--watch)(?:\s|$)/.test(String(commandText ?? ''));
};

const OM_GH_API_GET_ENDPOINTS = /^repos\/[^/]+\/[^/]+\/(pulls|issues|contents|commits|tags|branches)$/;
const OM_GH_API_ALLOWED_FLAGS = new Set(['-R', '--repo', '--repository']);

const omGhApiArgsOk = rest => {
  let endpoint = null;
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i];
    if (w.startsWith('-')) {
      if (OM_GH_API_ALLOWED_FLAGS.has(w)) { i += 1; continue; }
      if (w.startsWith('--repo=') || w.startsWith('--repository=')) continue;
      return false;
    }
    if (endpoint === null) endpoint = w;
    else return false;
  }
  const e = String(endpoint ?? '').replace(/^\/+/, '');
  return Boolean(e) && OM_GH_API_GET_ENDPOINTS.test(e);
};

const omGhAuthStatusOk = args => args.length === 0;

const OM_GH_READ_ONLY_FLAGS = new Set([
  '--json', '--jq', '--template', '--limit', '--app', '--hostname', '-q', '-t',
]);

const omGhReadOnlyFlagOk = a => {
  const s = String(a);
  if (s === '-R' || s === '--repo' || s === '--repository') return 'skip2';
  if (s.startsWith('--repo=') || s.startsWith('--repository=')) return 'skip1';
  if (s === '-w' || s === '--web' || s.startsWith('--we')) return 'deny';
  const eq = s.indexOf('=');
  const name = eq === -1 ? s : s.slice(0, eq);
  if (OM_GH_READ_ONLY_FLAGS.has(name) || name.startsWith('--jq=') || name.startsWith('--template=')) {
    return eq === -1 ? 'skip2' : 'skip1';
  }
  if (s === '--version' || s === '-v') return 'skip1';
  if (s.startsWith('-')) return 'deny';
  return 'pos';
};

const omGhReadOnly = (args, commandText, piped) => {
  if (omGhPrMerge(args)) return false;
  if (omGhWebFlag(args, commandText)) return false;
  const pos = [];
  let i = 0;
  while (i < args.length) {
    const kind = omGhReadOnlyFlagOk(args[i]);
    if (kind === 'deny') return false;
    if (kind === 'skip2') { i += 2; continue; }
    if (kind === 'skip1') { i += 1; continue; }
    pos.push(args[i]);
    i += 1;
  }
  if (pos[0] === 'api') return false;
  if (pos[0] === 'pr' && pos[1] === 'create') return false;
  if (pos[0] === 'auth' && pos[1] === 'status') return omGhAuthStatusOk(pos.slice(2));
  const sub = pos[0] === 'search' ? 'search' : (pos.length >= 2 ? `${pos[0]} ${pos[1]}` : pos[0] ?? null);
  if (sub === 'run watch') return false;
  if ((args.includes('--version') || args.includes('-v')) && pos.length === 0) return true;
  return sub !== null && OM_GH_ALLOWED.has(sub);
};

const omGitGrepAllowed = rest => {
  for (const a of rest) {
    if (a === '--') break;
    if (omArgPoisoned(a)) return false;
    if (a.startsWith('--open-files-in-pager') || /^-O/.test(a) || a.startsWith('-O')) return false;
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const tok = eq === -1 ? a : a.slice(0, eq);
      if (!OM_GIT_GREP_OPTS.has(tok)) return false;
      if (tok === '-e' && eq === -1) { /* value follows */ }
    }
  }
  return omGitOptsExact(rest, { shorts: OM_GIT_GREP_OPTS, longs: new Set(['--no-color', '--count', '--line-number']), valueShort: new Set(['-e']), valueLong: new Set() });
};

const omGitSubAllowed = (sub, rest) => {
  if (!sub || omArgPoisoned(sub)) return false;
  const pos = rest.filter(a => a !== '' && !a.startsWith('-') && a !== '--');
  if (rest.some(omArgPoisoned)) return false;
  const statusShort = new Set(['-s', '-b', '-u', '-v', '-z', '-t']);
  const statusLong = new Set(['--short', '--branch', '--porcelain', '--verbose', '--untracked-files', '--no-renames']);
  const logShort = new Set(['-n', '-p', '--pretty', '-1', '-2', '-3', '-4', '-5', '-6', '-7', '-8', '-9', '-i', '-E', '-F']);
  const logLong = new Set([
    '--oneline', '--max-count', '--no-decorate', '--decorate', '--pretty', '--abbrev-commit', '--no-merges',
    '--grep', '--author', '--committer', '--since', '--until', '--after', '--before', '--all', '--walk-reflogs',
  ]);
  const diffShort = new Set(['-U', '-u', '-w', '-b', '--stat', '-1', '-2', '-3', '-4', '-5']);
  const diffLong = new Set(['--stat', '--name-only', '--numstat', '--no-color', '--color']);
  const fetchShort = new Set(['-p', '-q', '-v', '-n']);
  const fetchLong = new Set(['--prune', '--tags', '--all', '--quiet', '--verbose', '--dry-run']);
  switch (sub) {
    case 'status':
      return omGitOptsExact(rest, { shorts: statusShort, longs: statusLong });
    case 'log':
      return omGitOptsExact(rest, {
        shorts: logShort,
        longs: logLong,
        valueShort: new Set(['-n']),
        valueLong: new Set([
          '--max-count', '--pretty', '--grep', '--author', '--committer', '--since', '--until', '--after', '--before',
        ]),
        numericShort: true,
      });
    case 'diff':
    case 'show':
      return omGitOptsExact(rest, { shorts: diffShort, longs: diffLong, valueShort: new Set(['-U', '-u']), valueLong: new Set() });
    case 'rev-parse':
    case 'ls-files':
    case 'ls-tree':
    case 'merge-base':
      return omGitOptsExact(rest, { shorts: new Set(['-q', '-v', '-z', '-r', '-t', '-l', '-s', '-d']), longs: new Set(['--quiet', '--verbose', '--name-only', '--full-name', '--abbrev-ref']) });
    case 'fetch':
      if (pos.some(p => p.includes(':') || p.includes('!'))) return false;
      return omGitOptsExact(rest, { shorts: fetchShort, longs: fetchLong });
    case 'grep':
      return omGitGrepAllowed(rest);
    case 'branch':
      if (!rest.some(a => a === '-l' || a === '--list' || a === '-a' || a === '-r')) return false;
      return pos.length === 0 && omGitOptsExact(rest, { shorts: new Set(['-l', '-a', '-r', '-v', '-vv']), longs: new Set(['--list', '--verbose', '--contains', '--merged', '--no-merged']) });
    case 'worktree':
      return (pos[0] === 'list' || pos.length === 0) && omGitOptsExact(rest, { shorts: new Set(['-v', '-v', '--porcelain']), longs: new Set(['--porcelain', '--verbose']) });
    case 'tag':
      return rest.some(a => a === '-l' || a === '--list') && pos.length === 0;
    case 'remote':
      return rest.every(a => a === '-v' || a === '-vv' || a.startsWith('-')) && !pos.length;
    case 'config':
      return rest.some(a => a === '--get' || a === '--get-all') && pos.length >= 1 && omGitOptsExact(rest, { shorts: new Set(), longs: new Set(['--get', '--get-all', '--local', '--global', '--system']) });
    default:
      return false;
  }
};

const omGitInvocationAllowed = args => {
  if (args.some(a => /^GIT_[A-Z_]+=/.test(a))) return false;
  if (!args.length || args[0].startsWith('-')) return false;
  return omGitSubAllowed(args[0], args.slice(1));
};

const omNodeRunsInstallSwarm = args => {
  const runner = omLauncherSwarmRunner() ?? omSwarmMjsRealpath();
  if (!runner) return false;
  const scriptAt = args.findIndex(a => a !== '' && !a.startsWith('-'));
  if (scriptAt === -1) return false;
  if (scriptAt !== 0) return false;
  const script = args[scriptAt];
  try {
    const abs = path.isAbsolute(script) ? script : path.resolve(script);
    return fs.realpathSync.native(abs) === runner;
  } catch { return false; }
};

const omSwarmRootValueOk = (raw, ctx) => {
  if (!ctx?.root || raw === undefined) return false;
  let p = String(raw);
  try {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(ctx.cwd ?? ctx.root, p);
    const real = fs.realpathSync.native(abs);
    const want = fs.realpathSync.native(ctx.root);
    return real === want;
  } catch { return false; }
};

const omSwarmArgsAfterGlobals = (args, ctx) => {
  let i = 0;
  while (i < args.length) {
    const a = String(args[i]);
    const low = a.toLowerCase();
    if (low === '--root') {
      if (i + 1 >= args.length || String(args[i + 1]).startsWith('-')) return { ok: false };
      if (!omSwarmRootValueOk(args[i + 1], ctx)) return { ok: false };
      i += 2;
      continue;
    }
    if (low.startsWith('--root=')) {
      const val = a.slice(a.indexOf('=') + 1);
      if (!omSwarmRootValueOk(val, ctx)) return { ok: false };
      i += 1;
      continue;
    }
    break;
  }
  const parsed = swarmArgvSubcommand(args.slice(i));
  if (!parsed) return { ok: false };
  if (parsed.kind === 'top') return { ok: true, i, sub: '', rest: [] };
  return { ok: true, i, sub: parsed.sub, rest: parsed.rest };
};

const omSwarmSubcommandAllowed = (args, ctx) => {
  if (!orchestratorSwarmSessionCwdOk(ctx?.root, ctx?.cwd ?? ctx?.root)) return false;
  const parsed = omSwarmArgsAfterGlobals(args, ctx);
  if (!parsed.ok) return false;
  const { sub, rest } = parsed;
  if (!sub) return true;
  if (!swarmSubcommandAlwaysAllowed(sub, rest)) return false;
  const vetSwarmManifestPositionals = positionals => {
    if (positionals === null) return false;
    for (const word of positionals) {
      if (!ctx?.root && String(word).toLowerCase().endsWith('.json')) return false;
      const vetted = omRunManifestVetted(ctx?.root, word);
      if (!vetted.ok) return false;
    }
    return true;
  };
  if (sub === 'run' || sub === 'go') {
    if (!vetSwarmManifestPositionals(omSwarmRunGoPositionals(sub, rest))) return false;
  }
  if (sub === 'ticket') {
    if (!vetSwarmManifestPositionals(omSwarmTicketPositionals(rest))) return false;
  }
  return true;
};

const omSwarmInvocation = (cmd, args, ctx) => {
  if (!orchestratorSwarmSessionCwdOk(ctx?.root, ctx?.cwd ?? ctx?.root)) return false;
  if (cmd === 'swarm') return omSwarmSubcommandAllowed(args, ctx);
  if (cmd === 'node' && omNodeRunsInstallSwarm(args)) {
    const scriptAt = args.findIndex(a => a !== '' && !a.startsWith('-'));
    if (scriptAt === -1) return false;
    return omSwarmSubcommandAllowed(args.slice(scriptAt + 1), ctx);
  }
  return false;
};

const omSegmentIsSwarmInvocation = (plain, k) => {
  const rawCmd = plain[k];
  if (!rawCmd || /^\$/.test(rawCmd)) return false;
  const cmd = path.basename(rawCmd);
  const args = plain.slice(k + 1);
  if (cmd === 'swarm') return true;
  if (cmd === 'node' && omNodeRunsInstallSwarm(args)) return true;
  return false;
};

/** True when a command runs swarm with an effective cwd below the project root (for clearer deny reasons). */
export function orchestratorSwarmSubfolderBlocked(command, ctx = {}) {
  if (!ctx?.root) return false;
  const text = String(command ?? '');
  if (!text.trim()) return false;
  try {
    const tokenized = tokenize(text);
    if (tokenized.unclosedQuote) return false;
    const baseCwd = ctx.cwd ?? ctx.root;
    let cwd = baseCwd;
    const local = { ...ctx, cwd };
    let subshellDepth = 0;
    const cwdStack = [baseCwd];
    for (const words of tokenized) {
      if (words.sepAfter === ')') {
        subshellDepth = Math.max(0, subshellDepth - 1);
        if (cwdStack.length > 1) cwdStack.pop();
        cwd = cwdStack[cwdStack.length - 1];
        local.cwd = cwd;
      }
      const { plain } = omPlainWords(words);
      let k = 0;
      while (k < plain.length && (SHELL_KEYWORDS.has(plain[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k]))) {
        k += 1;
      }
      if (k < plain.length && path.basename(plain[k]) === 'cd') {
        if (subshellDepth > 0) continue;
        const target = plain.slice(k + 1).filter(a => a !== '' && !a.startsWith('-'))[0];
        if (omCdHasDash(plain.slice(k + 1)) || !omCdStepAllowed(words, target, local)) continue;
        cwd = omResolveCd(target, { ...local, cwd });
        local.cwd = cwd;
        cwdStack[cwdStack.length - 1] = cwd;
        continue;
      }
      if (k < plain.length && omSegmentIsSwarmInvocation(plain, k)) {
        if (!orchestratorSwarmSessionCwdOk(ctx.root, local.cwd ?? ctx.root)) return true;
      }
      if (words.sepAfter === '(') {
        subshellDepth += 1;
        cwdStack.push(cwd);
      }
    }
    return false;
  } catch {
    return false;
  }
}

const omPlainWords = words => {
  const plain = [];
  const expands = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === '2>&1') continue;
    if (w === '2>' && words[i + 1] === '/dev/null') { i += 1; continue; }
    if (/^\d+$/.test(w) && words[i + 1] === '>&' && words[i + 2] === '1') { i += 2; continue; }
    if (/^\d+$/.test(w) && words[i + 1] === '>' && words[i + 2] === '/dev/null') { i += 2; continue; }
    if (['>', '>>', '>|', '&>', '<', '<<<', '<<'].includes(w)) {
      if (w !== '<<') i += 1;
      continue;
    }
    if (/^\d+$/.test(words[i]) && ['>', '>>', '>&'].includes(words[i + 1])) continue;
    plain.push(words[i]);
    expands.push(words.expands?.[i] ?? false);
  }
  return { plain, expands };
};

const OM_SWARM_FREE_TEXT_SUBS = new Set(['note', 'ask', 'tickets', 'msg', 'lesson', 'handbuild', 'ticket', 'diagnose']);

const omSwarmFreeTextHeredoc = words => {
  const { plain } = omPlainWords(words);
  let k = 0;
  while (k < plain.length && (SHELL_KEYWORDS.has(plain[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k]))) k += 1;
  if (k >= plain.length || path.basename(plain[k]) !== 'swarm') return false;
  const sub = (plain[k + 1] ?? '').toLowerCase();
  if (sub === 'msg' && (plain[k + 2] ?? '').toLowerCase() === 'send') return true;
  return OM_SWARM_FREE_TEXT_SUBS.has(sub);
};

const omRelUnderOmManifestWriteArea = rel => {
  const norm = String(rel ?? '').replace(/\\/g, '/').toLowerCase();
  return norm.startsWith('coordination/manifests/') || norm.startsWith('.swarm/');
};

const omWriteTargetEscapesProject = rel => rel === '..' || rel.startsWith('../') || path.isAbsolute(rel);

const omResolvePath = (p, ctx, redirect = false) => {
  let cwdBase = ctx.cwd ?? ctx.root;
  try {
    cwdBase = fs.realpathSync.native(cwdBase);
  } catch {
    cwdBase = ctx.cwd ?? ctx.root;
  }
  const components = p.split(path.sep).filter(Boolean);
  let resolved = path.isAbsolute(p) ? path.parse(p).root : cwdBase;
  let sawSymlink = false;
  for (let i = 0; i < components.length; i += 1) {
    if (i >= 64) return null;
    const component = components[i];
    if (component === '..' && sawSymlink) return null;
    const next = path.join(resolved, component);
    try {
      const stat = fs.lstatSync(next);
      if (stat.isSymbolicLink()) {
        // Redirects follow even dangling leaf symlinks. Refuse all redirect leaf links.
        if (redirect && i === components.length - 1) return null;
        sawSymlink = true;
        try { resolved = fs.realpathSync.native(next); } catch { return null; }
      } else {
        if (redirect && i === components.length - 1 && stat.isFile() && stat.nlink > 1) return null;
        resolved = next;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      resolved = next;
    }
  }
  return resolved;
};

const omWriteTargetRel = (raw, ctx, expands) => {
  if (expands || /^\$/.test(String(raw ?? ''))) return null;
  if (!ctx?.root) return null;
  let rootReal;
  try {
    rootReal = fs.realpathSync.native(ctx.root);
  } catch {
    return null;
  }
  let p = String(raw ?? '');
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  const resolved = omResolvePath(p, ctx, true);
  if (resolved === null) return null;
  const rel = path.relative(rootReal, resolved);
  if (omWriteTargetEscapesProject(rel)) return null;
  return rel.split(path.sep).join('/');
};

const omRedirectWriteTargetRel = (words, ctx) => {
  const wordExp = words.expands ?? [];
  for (let i = 0; i < words.length; i += 1) {
    if (['>', '>>', '>|', '>&', '&>'].includes(words[i]) && words[i + 1] !== undefined && !/^&?\d+$/.test(words[i + 1])) {
      return omWriteTargetRel(words[i + 1], ctx, wordExp[i + 1]);
    }
  }
  return null;
};

const omRedirectTokenHarmless = (words, i) => {
  const w = words[i];
  if (w === '2>&1') return { skip: 0 };
  if (w === '2>' && words[i + 1] === '/dev/null') return { skip: 1 };
  if (/^\d+$/.test(w) && words[i + 1] === '>&' && words[i + 2] === '1') return { skip: 2 };
  if (/^\d+$/.test(w) && words[i + 1] === '>' && words[i + 2] === '/dev/null') return { skip: 2 };
  return null;
};

const omTestRunnerRedirectForbidden = words => {
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === '2>&1' || w === '2>' || /[<>]/.test(w) || w.includes('&')) return true;
    if (/^\d+$/.test(w) && (words[i + 1] === '>&' || words[i + 1] === '>')) return true;
  }
  return false;
};

const omRedirectsForbidden = (words, ctx) => {
  let heredocOnly = false;
  const wordExp = words.expands ?? [];
  for (let i = 0; i < words.length; i += 1) {
    const harmless = omRedirectTokenHarmless(words, i);
    if (harmless) { i += harmless.skip; continue; }
    const w = words[i];
    if (w === '<<') { heredocOnly = true; continue; }
    if (['>', '>>', '>|', '>&', '&>'].includes(w) && words[i + 1] !== undefined && !/^&?\d+$/.test(words[i + 1])) {
      const rel = omWriteTargetRel(words[i + 1], ctx, wordExp[i + 1]);
      if (rel === null) return true;
      if (omRelUnderOmManifestWriteArea(rel)) return true;
      if (orchestratorWriteAllowedRel(rel)) continue;
      return true;
    }
    if (/[<>]/.test(w) || w.includes('&')) return true;
  }
  if (heredocOnly) return !omSwarmFreeTextHeredoc(words);
  return false;
};

const OM_AGENT_LAUNCH_WRAPPERS = new Set([
  'env', 'command', 'exec', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'caffeinate', 'sudo', 'xargs',
  'builtin', 'setsid', 'chrt', 'doas',
]);
const OM_AGENT_CLI = new Set(['claude', 'codex', 'cursor-agent']);
const OM_AGENT_LAUNCH_MAX_DEPTH = 4;

const omAgentPackageToken = token => {
  if (!token || token.startsWith('-')) return null;
  const at = token.startsWith('@') ? token.indexOf('@', 1) : token.indexOf('@');
  const pkg = at === -1 ? token : token.slice(0, at);
  if (pkg === '@anthropic-ai/claude-code') return 'claude';
  const base = path.basename(pkg);
  if (OM_AGENT_CLI.has(base) || base === 'claude-code') return base === 'claude-code' ? 'claude' : base;
  return null;
};

const omSkipPackageRunnerFlags = (plain, i) => {
  while (i < plain.length) {
    const a = plain[i];
    if (a === '--') { i += 1; break; }
    if (!a.startsWith('-')) break;
    const takes = a === '-p' || a === '--package' || a === '--prefix' || a === '--node-options'
      || a === '--workspace' || a === '-w' || a === '--cwd' || a === '-C';
    i += takes ? 2 : 1;
  }
  return i;
};

const omPackageRunnerAgentArgs = (plain, programIndex) => {
  const cmd = plain[programIndex];
  let i = programIndex + 1;
  if (cmd === 'npx' || cmd === 'bunx') {
    i = omSkipPackageRunnerFlags(plain, i);
    const pkg = plain[i];
    if (!omAgentPackageToken(pkg)) return null;
    return plain.slice(i + 1);
  }
  if (cmd === 'pnpm') {
    const sub = plain[i];
    if (sub !== 'dlx' && sub !== 'exec') return null;
    i += 1;
    i = omSkipPackageRunnerFlags(plain, i);
    const pkg = plain[i];
    if (!omAgentPackageToken(pkg)) return null;
    return plain.slice(i + 1);
  }
  if (cmd === 'yarn') {
    if (plain[i] !== 'dlx') return null;
    i += 1;
    i = omSkipPackageRunnerFlags(plain, i);
    const pkg = plain[i];
    if (!omAgentPackageToken(pkg)) return null;
    return plain.slice(i + 1);
  }
  if (cmd === 'npm') {
    if (plain[i] !== 'exec') return null;
    i += 1;
    i = omSkipPackageRunnerFlags(plain, i);
    const pkg = plain[i];
    if (!omAgentPackageToken(pkg)) return null;
    return plain.slice(i + 1);
  }
  return null;
};

const omSkipToAgentProgram = plain => {
  let k = 0;
  let wrapperName = null;
  while (k < plain.length) {
    if (SHELL_KEYWORDS.has(plain[k])) { k += 1; continue; }
    if (!wrapperName && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) { k += 1; continue; }
    if (OM_AGENT_LAUNCH_WRAPPERS.has(plain[k])) {
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
};

const omNodeScriptIsAgent = scriptToken => {
  if (!scriptToken || scriptToken.startsWith('-')) return false;
  const base = path.basename(scriptToken);
  if (base === 'claude' || OM_AGENT_CLI.has(base)) return true;
  return base === 'cli.js' && /anthropic-ai\/claude-code/.test(scriptToken);
};

const omPlainWordsFromSegment = words => {
  const plain = [];
  for (let i = 0; i < words.length; i += 1) {
    if (['>', '>>', '>|', '&>', '<', '<<<', '<<'].includes(words[i])) {
      if (words[i] !== '<<') i += 1;
      continue;
    }
    if (/^\d+$/.test(words[i]) && ['>', '>>', '>&'].includes(words[i + 1])) continue;
    plain.push(words[i]);
  }
  return plain;
};

const omAgentLaunchInText = (commandText, depth = 0) => {
  if (depth > OM_AGENT_LAUNCH_MAX_DEPTH) return false;
  const text = String(commandText ?? '');
  if (!text) return false;
  for (const sub of substitutions(text)) {
    if (omAgentLaunchInText(sub, depth + 1)) return true;
  }
  for (const words of tokenize(text)) {
    const plain = omPlainWordsFromSegment(words);
    const { index, envSplit } = omSkipToAgentProgram(plain);
    if (envSplit !== undefined && omAgentLaunchInText(envSplit, depth + 1)) return true;
    if (index >= plain.length) continue;
    const cmd = path.basename(plain[index]);
    const args = plain.slice(index + 1);
    if (OM_AGENT_CLI.has(cmd) || cmd === 'claude') return true;
    if (omPackageRunnerAgentArgs(plain, index) !== null) return true;
    if (cmd === 'node') {
      const scriptAt = args.findIndex(a => a !== '' && !a.startsWith('-'));
      if (scriptAt !== -1 && omNodeScriptIsAgent(args[scriptAt])) return true;
    }
    if (SHELLS.has(cmd)) {
      const at = args.findIndex(codeFlagFor(cmd));
      if (at !== -1 && args[at + 1] !== undefined && omAgentLaunchInText(args[at + 1], depth + 1)) return true;
    }
    if (cmd === 'eval' && args.length && omAgentLaunchInText(args.join(' '), depth + 1)) return true;
  }
  return false;
};

/** True when a command line launches a paid agent CLI (position-based; not mere mention of the word claude). */
export function orchestratorModeAgentLaunchBlocked(command) {
  try {
    return omAgentLaunchInText(command, 0);
  } catch {
    return true;
  }
};

const omOrchestratorClaudeHomeReadOk = (abs, home) => {
  let homeReal;
  try { homeReal = fs.realpathSync.native(home); } catch { return false; }
  let absReal;
  try { absReal = fs.realpathSync.native(abs); } catch { return false; }
  const rel = path.relative(homeReal, absReal);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const norm = rel.split(path.sep).join('/');
  if (norm === '.claude.json') return false;
  if (norm === '.claude/projects' || norm.startsWith('.claude/projects/')) return false;
  if (norm === '.claude' || norm.startsWith('.claude/')) return true;
  return false;
};

const omSensitiveAbs = (abs, home) => {
  const rel = path.relative(home, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    const norm = rel.split(path.sep).join('/');
    if (OM_SENSITIVE_HOME_SEGMENTS.some(s => norm === s || norm.startsWith(`${s}/`))) return true;
    const base = path.basename(abs);
    if (base === '.env' || base.startsWith('.env.') || /\.(pem|key)$/i.test(base)) return true;
  }
  return false;
};

const omOperandUnsafe = raw => {
  const s = String(raw ?? '');
  if (!s || s === '-') return false;
  if (s === '~' || s.startsWith('~/')) return false;
  return /[$`*?[\{~]/.test(s);
};

const omPackageScripts = root => {
  if (!root) return null;
  try {
    const p = path.join(fs.realpathSync.native(root), 'package.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const scripts = data?.scripts;
    return scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : {};
  } catch {
    return null;
  }
};

// Any file the orchestrator may write (docs/plans, .swarm, manifests, handoffs, TASK.md...) counts as code as a runner operand, whatever its extension.
const omTestOperandOrchestratorOwnedRel = norm => orchestratorOwnRel(norm) || orchestratorWriteAllowedRel(norm);

const OM_BARE_SCAN_MAX_DEPTH = 8;
const OM_BARE_SCAN_MAX_ENTRIES = 5000;
const OM_BARE_SCAN_SKIP_PREFIXES = [
  '.swarm/workspaces/',
  '.swarm/worktrees/',
  '.swarm/runs/',
  '.swarm/backups/',
  '.swarm/orchestrator-mode/',
];

const omBareScanSkipRel = normRel => {
  const norm = String(normRel ?? '').replace(/\\/g, '/').toLowerCase();
  if (!norm) return true;
  if (norm === 'node_modules' || norm.startsWith('node_modules/')) return true;
  return OM_BARE_SCAN_SKIP_PREFIXES.some(p => norm === p.slice(0, -1) || norm.startsWith(p));
};

/** Fail closed: true when orchestrator-owned folders contain runnable code/tests (blocks bare test runs). */
export function orchestratorOwnFoldersBlockBareTestRun(root) {
  if (!root) return true;
  let rootReal;
  try {
    rootReal = fs.realpathSync.native(root);
  } catch {
    return true;
  }
  let entriesSeen = 0;
  const scanDir = (absDir, relPosix, depth) => {
    if (depth > OM_BARE_SCAN_MAX_DEPTH) return 'limit';
    if (omBareScanSkipRel(relPosix)) return 'ok';
    let names;
    try {
      names = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return 'error';
    }
    for (const ent of names) {
      entriesSeen += 1;
      if (entriesSeen > OM_BARE_SCAN_MAX_ENTRIES) return 'limit';
      const name = ent.name;
      const childRel = relPosix ? `${relPosix}/${name}` : name;
      const normChild = childRel.replace(/\\/g, '/').toLowerCase();
      if (omBareScanSkipRel(normChild)) continue;
      const childAbs = path.join(absDir, name);
      let st;
      try {
        st = fs.lstatSync(childAbs);
      } catch {
        return 'error';
      }
      if (st.isSymbolicLink()) {
        if (orchestratorOwnForbiddenWriteRel(normChild)) return 'hit';
        continue;
      }
      if (st.isDirectory()) {
        const sub = scanDir(childAbs, normChild, depth + 1);
        if (sub !== 'ok') return sub;
        continue;
      }
      if (st.isFile() && orchestratorOwnForbiddenWriteRel(normChild)) return 'hit';
    }
    return 'ok';
  };
  const scanPrefixes = [
    ...orchestratorBareTestScanRelPrefixes(),
    ...TOOL_DIRS.map(d => String(d).toLowerCase()),
  ];
  for (const prefix of scanPrefixes) {
    const relTop = prefix.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    const abs = path.join(rootReal, ...relTop.split('/').filter(Boolean));
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      return true;
    }
    if (!st.isDirectory()) continue;
    const outcome = scanDir(abs, relTop, 0);
    if (outcome === 'hit' || outcome === 'limit' || outcome === 'error') return true;
  }
  return false;
}

const omTestOperandOk = (raw, ctx) => {
  if (!omReadOperandOk(raw, ctx)) return false;
  if (!ctx.root || raw === '-' || raw === undefined) return true;
  const home = ctx.home ?? os.homedir();
  let p = String(raw);
  if (p === '~' || p.startsWith('~/')) {
    if (p === '~') return false;
    p = path.join(home, p.slice(2));
  }
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(ctx.cwd ?? ctx.root, p);
  let real;
  try { real = fs.realpathSync.native(abs); } catch {
    try {
      real = fs.realpathSync.native(path.dirname(abs));
    } catch {
      const relGuess = insideProject(ctx.root, abs);
      if (relGuess === null) return false;
      return !omTestOperandOrchestratorOwnedRel(relGuess.replace(/\\/g, '/').toLowerCase());
    }
    if (omSensitiveAbs(real, home)) return false;
    const relParent = insideProject(ctx.root, real);
    if (relParent === null) return false;
    return !omTestOperandOrchestratorOwnedRel(relParent.replace(/\\/g, '/').toLowerCase());
  }
  const rel = insideProject(ctx.root, real);
  if (rel === null) return false;
  return !omTestOperandOrchestratorOwnedRel(rel.replace(/\\/g, '/').toLowerCase());
};

const omOrchestratorTestRunAllowed = (segment, ctx) => {
  if (!ctx?.root) return false;
  const packageScripts = omPackageScripts(ctx.root);
  const runCtx = {
    ...ctx,
    inProject: raw => omReadOperandOk(raw, ctx),
    testOperandOk: raw => omTestOperandOk(raw, ctx),
    packageScripts,
  };
  if (!localTestRunAllowed(segment, runCtx)) return false;
  if (localTestRunIsBare(segment, runCtx) && orchestratorOwnFoldersBlockBareTestRun(ctx.root)) return false;
  return true;
};

const omReadOperandOk = (raw, ctx) => {
  if (!ctx.root || raw === '-' || raw === undefined) return true;
  if (omOperandUnsafe(raw)) return false;
  const home = ctx.home ?? os.homedir();
  let p = String(raw);
  if (p === '~' || p.startsWith('~/')) {
    if (p === '~') return false;
    p = path.join(home, p.slice(2));
  }
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(ctx.cwd ?? ctx.root, p);
  let real;
  try { real = fs.realpathSync.native(abs); } catch {
    try {
      real = fs.realpathSync.native(path.dirname(abs));
    } catch {
      return insideProject(ctx.root, abs) !== null;
    }
    if (omSensitiveAbs(real, home)) return false;
    if (omOrchestratorClaudeHomeReadOk(real, home)) return true;
    return insideProject(ctx.root, real) !== null;
  }
  if (omSensitiveAbs(real, home)) return false;
  if (omOrchestratorClaudeHomeReadOk(real, home)) return true;
  return insideProject(ctx.root, real) !== null;
};

const omPathLikeOperand = a => /[./~]/.test(String(a)) || String(a).includes(path.sep);

const omFilterOperandsOk = (cmd, args, ctx) => {
  if (cmd === 'find') {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === '-name' || a === '-iname') { i += 1; continue; }
      if (a.startsWith('-name=') || a.startsWith('-iname=')) continue;
      if (a.startsWith('-')) continue;
      if (omOperandUnsafe(a) || !omReadOperandOk(a, ctx)) return false;
    }
    return true;
  }
  const pos = args.filter(a => a !== '' && !a.startsWith('-'));
  if (pos.some(omOperandUnsafe)) return false;
  if (['grep', 'egrep', 'fgrep', 'rg'].includes(cmd)) {
    const paths = pos.filter((a, i) => i > 0 || omPathLikeOperand(a));
    return paths.every(p => omReadOperandOk(p, ctx));
  }
  if (['head', 'tail', 'cut', 'sort', 'uniq', 'wc'].includes(cmd)) {
    return pos.every(p => omReadOperandOk(p, ctx));
  }
  if (cmd === 'sed') return false;
  return true;
};

const omLsOk = (args, ctx) => {
  if (args.some(a => a === '-R' || a === '-r' || a === '--recursive')) return false;
  const dirs = args.filter(a => a !== '' && !a.startsWith('-'));
  if (dirs.length > 1) return false;
  if (dirs.length === 1 && !omReadOperandOk(dirs[0], ctx)) return false;
  return true;
};

const omGrepRgOk = (cmd, args) => {
  for (const a of args) {
    if (OM_GREP_FILE_FLAGS.has(a) || a.startsWith('--pre') || a.startsWith('--exclude-from=')) return false;
    if (a.startsWith('--file=') || a.startsWith('-f')) {
      if (a === '-f' || a === '--file') return false;
    }
  }
  if (cmd === 'rg' && args.some(a => a === '--pre' || a === '--pre-glob')) return false;
  return true;
};

const omSortUniqOk = (cmd, args) => {
  if (cmd === 'sort' && args.some(a => a === '-o' || a === '--output' || a.startsWith('--output='))) return false;
  if (cmd === 'uniq') {
    const pos = args.filter(a => a !== '' && !a.startsWith('-'));
    if (pos.length > 1) return false;
  }
  return true;
};

const omJqFilterOk = filter => {
  const f = String(filter ?? '').trim();
  if (!f || f.includes('$')) return false;
  if (/[()@]|\/\/|#/.test(f)) return false;
  if (/\b(env|input_filename|getpath|length|keys|has|in|select|map|foreach|reduce|walk|recurse|..|test|match|capture|split|join|ascii_downcase|ascii_upcase|fromjson|tojson|@)\b/.test(f)) return false;
  return /^[.\w[\]|:"-]+$/.test(f);
};

const omJqOk = (args, ctx) => {
  if (args.some(a => OM_JQ_FILE_FLAGS.has(a) || a.startsWith('--from-file=') || a.startsWith('--rawfile='))) return false;
  const pos = args.filter(a => a !== '' && !a.startsWith('-'));
  if (pos.length < 1) return false;
  if (!omJqFilterOk(pos[0])) return false;
  for (const f of pos.slice(1)) if (!omReadOperandOk(f, ctx)) return false;
  return true;
};

const omCdTargetOk = (target, ctx) => {
  if (!ctx.root || !target || omOperandUnsafe(target)) return false;
  if (process.env.CDPATH && String(process.env.CDPATH).trim() && !path.isAbsolute(String(target)) && !String(target).startsWith('~/')) return false;
  if (target === '~') return false;
  const real = omResolveCd(target, ctx);
  if (real === null) return false;
  const rel = insideProject(ctx.root, real);
  if (rel === null) return false;
  const norm = rel.replace(/\\/g, '/').toLowerCase();
  if (norm === '.swarm' || norm.startsWith('.swarm/')) return false;
  return true;
};

const omRealOrNull = p => {
  try { return fs.realpathSync.native(p); } catch { return null; }
};

const OM_CD_ROOT_ENV_FORMS = new Set(['$CLAUDE_PROJECT_DIR', '${CLAUDE_PROJECT_DIR}']);

// Refuse all cd options, including `-`: the hook cannot model their semantics.
const omCdHasDash = cdArgs => cdArgs.some(a => a.startsWith('-'));

/** True when a `cd` target lands exactly on the project root (real path), by path, or "$CLAUDE_PROJECT_DIR". */
const omCdRootTarget = (target, ctx) => {
  if (!ctx?.root || target === undefined || target === '') return false;
  const rootReal = omRealOrNull(ctx.root);
  if (!rootReal) return false;
  const t = String(target);
  if (OM_CD_ROOT_ENV_FORMS.has(t)) {
    const envDir = process.env.CLAUDE_PROJECT_DIR;
    return !!envDir && omRealOrNull(envDir) === rootReal;
  }
  if (omOperandUnsafe(t) || t === '~' || t.startsWith('~')) return false;
  if (process.env.CDPATH && String(process.env.CDPATH).trim() && !path.isAbsolute(t)) return false;
  return omResolveCd(t, ctx) === rootReal;
};

const omCdAllowed = (target, ctx) => omCdRootTarget(target, ctx) || omCdTargetOk(target, ctx);

// A cd that is not the first half of `cd DIR && ...` only passes when it returns to the project root (a standalone `cd`, or before `;`).
const omCdStepAllowed = (words, target, ctx) => {
  if (words.sepAfter === '&&') return omCdAllowed(target, ctx);
  if (words.sepAfter !== ';' || words.piped) return false;
  return omCdRootTarget(target, ctx);
};

const omResolveCd = (target, ctx) => {
  const home = ctx.home ?? os.homedir();
  let p = String(target);
  if (OM_CD_ROOT_ENV_FORMS.has(p)) p = ctx.root;
  if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  const resolved = omResolvePath(p, ctx);
  return resolved === null ? null : omRealOrNull(resolved);
};

const omNaturallySmall = (cmd, args) => {
  if (cmd === 'git') {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === 'status') return true;
    if (sub === 'branch' && rest.some(a => a === '--list' || a === '-l')) return true;
    if (sub === 'worktree' && (rest[0] === 'list' || rest.length === 0)) return true;
    if (sub === 'rev-parse') return true;
  }
  return false;
};

const omSimpleCommandAllowed = (words, commandText, ctx) => {
  if (omRedirectsForbidden(words, ctx)) return false;
  const { plain, expands } = omPlainWords(words);
  let k = 0;
  for (;;) {
    if (k >= plain.length) return true;
    if (SHELL_KEYWORDS.has(plain[k])) { k += 1; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) return false;
    if (OM_BLOCKED_WRAPPERS.has(plain[k]) || plain[k] === '.') return false;
    break;
  }
  if (k >= plain.length) return true;
  if (expands[k] || /^\$/.test(plain[k])) return false;
  const rawCmd = plain[k];
  if (rawCmd.includes('/') && rawCmd !== '2>&1') {
    const trustedNode = path.basename(rawCmd) === 'node' && omTrustedCommandWordOk(rawCmd, 'node');
    const trustedSwarmMjs = rawCmd.endsWith('swarm.mjs') && omNodeRunsInstallSwarm(plain.slice(k + 1));
    if (!trustedNode && !trustedSwarmMjs) return false;
  }
  const cmd = path.basename(rawCmd);
  const args = plain.slice(k + 1);
  const segment = plain.slice(k);
  const trailingHelp = segment.length > 1 && ['-h', '--help', '--version'].includes(String(segment[segment.length - 1]));
  if (trailingHelp) {
    if (!helpOnly(segment)) return false;
    const argsNoHelp = args.slice(0, -1);
    if (cmd === 'git') return omGitInvocationAllowed(argsNoHelp);
    if (cmd === 'gh') return omGhReadOnly(argsNoHelp, commandText, words.piped || words.sepAfter === '|');
    if (omSwarmInvocation(cmd, argsNoHelp, ctx)) return true;
    const base = segment.slice(0, -1);
    if (ctx.root && readOnlyCommandAllowed(base)) {
      if (['grep', 'egrep', 'fgrep', 'rg'].includes(cmd)) {
        return omGrepRgOk(cmd, argsNoHelp) && omFilterOperandsOk(cmd, argsNoHelp, ctx);
      }
      if (cmd === 'head' || cmd === 'tail') return omHeadTailLinesOk(argsNoHelp) && omFilterOperandsOk(cmd, argsNoHelp, ctx);
      if (cmd === 'ls') return omLsOk(argsNoHelp, ctx);
      if (cmd === 'wc') return omFilterOperandsOk(cmd, argsNoHelp, ctx);
      if (cmd === 'cat') {
        const pos = argsNoHelp.filter(a => a !== '' && !a.startsWith('-'));
        return pos.length > 0 && pos.every(p => omReadOperandOk(p, ctx));
      }
      return true;
    }
    return false;
  }
  if (cmd === 'git' && !omTrustedCommandWordOk(rawCmd, 'git')) return false;
  if (cmd === 'gh' && !omTrustedCommandWordOk(rawCmd, 'gh')) return false;
  if (cmd === 'vercel' && !omTrustedCommandWordOk(rawCmd, 'vercel')) return false;
  if (cmd === 'node' && !omTrustedCommandWordOk(rawCmd, 'node')) return false;
  if (cmd === 'swarm' && !omSwarmCommandWordOk(rawCmd)) return false;
  if (cmd === 'cd') {
    if (omCdHasDash(args)) return false;
    const target = args.filter(a => a !== '' && !a.startsWith('-'))[0];
    return target !== undefined && omCdTargetOk(target, ctx);
  }
  if (words.piped) {
    if (cmd === 'head' || cmd === 'tail') return omHeadTailLinesOk(args) && omFilterOperandsOk(cmd, args, ctx);
    if (cmd === 'git') return omGitInvocationAllowed(args);
    if (cmd === 'gh') return omGhReadOnly(args, commandText, true);
    if (OM_PIPE_FILTERS.has(cmd)) {
      if (cmd === 'sed') return omSedReadOnly(args, ctx);
      if (!omSortUniqOk(cmd, args) || !omGrepRgOk(cmd, args)) return false;
      if (cmd === 'jq') return omJqOk(args, ctx);
      return omFilterOperandsOk(cmd, args, ctx);
    }
    if (cmd === 'cat') {
      const pos = args.filter(a => a !== '' && !a.startsWith('-'));
      return pos.length > 0 && pos.every(p => omReadOperandOk(p, ctx));
    }
    if (cmd === 'find') return omFindReadOnly(args) && omFilterOperandsOk(cmd, args, ctx);
    if (cmd === 'wc') return omFilterOperandsOk(cmd, args, ctx);
    if (cmd === 'swarm' || cmd === 'vercel') return false;
    return false;
  }
  if (cmd === 'git') return omGitInvocationAllowed(args);
  if (cmd === 'gh') return omGhReadOnly(args, commandText, words.piped || words.sepAfter === '|');
  if (cmd === 'vercel') return omVercelReadOnly(args);
  if (omSwarmInvocation(cmd, args, ctx)) return true;
  if (cmd === 'head' || cmd === 'tail') return omHeadTailLinesOk(args) && omFilterOperandsOk(cmd, args, ctx);
  if (cmd === 'find') return omFindReadOnly(args) && omFilterOperandsOk(cmd, args, ctx);
  if (cmd === 'sed') return omSedReadOnly(args, ctx);
  if (cmd === 'ls') return omLsOk(args, ctx);
  if (cmd === 'wc') return omFilterOperandsOk(cmd, args, ctx);
  const feedsPipe = words.sepAfter === '|';
  if (ctx.root && readOnlyCommandAllowed(segment)) {
    if (['grep', 'egrep', 'fgrep', 'rg'].includes(cmd)) {
      return omGrepRgOk(cmd, args) && omFilterOperandsOk(cmd, args, ctx);
    }
    if (cmd === 'head' || cmd === 'tail') return omHeadTailLinesOk(args) && omFilterOperandsOk(cmd, args, ctx);
    if (cmd === 'ls') return omLsOk(args, ctx);
    if (cmd === 'wc') return omFilterOperandsOk(cmd, args, ctx);
    if (cmd === 'cat') {
      const pos = args.filter(a => a !== '' && !a.startsWith('-'));
      return pos.length > 0 && pos.every(p => omReadOperandOk(p, ctx));
    }
  }
  if (!words.piped && !feedsPipe && ['grep', 'egrep', 'fgrep', 'rg'].includes(cmd)) return false;
  if (!words.piped && !feedsPipe && (cmd === 'cat' || cmd === 'cut' || cmd === 'sort' || cmd === 'uniq' || cmd === 'jq')) return false;
  if (feedsPipe && ['grep', 'egrep', 'fgrep', 'rg'].includes(cmd)) return omGrepRgOk(cmd, args) && omFilterOperandsOk(cmd, args, ctx);
  if (feedsPipe && cmd === 'sed') {
    if (!omSedReadOnly(args, ctx)) return false;
    return true;
  }
  if (feedsPipe && (cmd === 'cat' || cmd === 'cut' || cmd === 'sort' || cmd === 'uniq' || cmd === 'jq')) {
    if (cmd === 'cat') {
      const pos = args.filter(a => a !== '' && !a.startsWith('-'));
      return pos.every(p => omReadOperandOk(p, ctx));
    }
    if (cmd === 'jq') return omJqOk(args, ctx);
    return omSortUniqOk(cmd, args);
  }
  if (!words.piped && !feedsPipe && omOrchestratorTestRunAllowed(segment, ctx)) {
    if (omTestRunnerRedirectForbidden(words)) return false;
    return true;
  }
  if (omNaturallySmall(cmd, args)) return true;
  if (cmd === 'true' || cmd === 'false' || cmd === ':') return true;
  const redirectRel = omRedirectWriteTargetRel(words, ctx);
  if (
    redirectRel !== null
    && orchestratorWriteAllowedRel(redirectRel)
    && !omRelUnderOmManifestWriteArea(redirectRel)
    && !words.piped
    && !feedsPipe
    && (cmd === 'echo' || cmd === 'printf')
  ) {
    return true;
  }
  return false;
};

const OM_COMPOUND_SEPS = new Set(['&&', ';', '||', '|']);

const omCommandIsCompound = (tokenized, commandText) => {
  if (tokenized.length > 1) return true;
  if (tokenized.some(w => OM_COMPOUND_SEPS.has(w.sepAfter))) return true;
  if (/[^&]&[^&>]/.test(String(commandText ?? ''))) return true;
  return false;
};

const omWordsRedirectManifestArea = (words, ctx) => {
  const wordExp = words.expands ?? [];
  for (let i = 0; i < words.length; i += 1) {
    if (['>', '>>', '>|', '>&', '&>'].includes(words[i]) && words[i + 1] !== undefined && !/^&?\d+$/.test(words[i + 1])) {
      const rel = omWriteTargetRel(words[i + 1], ctx, wordExp[i + 1]);
      if (rel && omRelUnderOmManifestWriteArea(rel)) return true;
    }
  }
  return false;
};

const omSegmentInvokesSwarmRunGoTicket = (words, ctx) => {
  const { plain } = omPlainWords(words);
  let k = 0;
  while (k < plain.length && (SHELL_KEYWORDS.has(plain[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k]))) {
    k += 1;
  }
  if (k >= plain.length) return false;
  const cmd = path.basename(plain[k]);
  const args = plain.slice(k + 1);
  return omSwarmInvocation(cmd, args, ctx);
};

const omCompoundManifestWriteWithSwarmBlocked = (commandText, tokenized, ctx) => {
  if (!ctx?.root || !omCommandIsCompound(tokenized, commandText)) return false;
  let hasSwarm = false;
  for (const words of tokenized) {
    if (omSegmentInvokesSwarmRunGoTicket(words, ctx)) hasSwarm = true;
  }
  if (!hasSwarm) return false;
  const analysis = analyzeShell(String(commandText ?? ''), { root: ctx.root, cwd: ctx.cwd ?? ctx.root });
  if ([...analysis.writes].some(omRelUnderOmManifestWriteArea)) return true;
  for (const words of tokenized) {
    if (omWordsRedirectManifestArea(words, ctx)) return true;
  }
  return false;
};

const omValidateTokenized = (tokenized, ctx, commandText = '') => {
  if (omCompoundManifestWriteWithSwarmBlocked(commandText, tokenized, ctx)) return false;
  const baseCwd = ctx.cwd ?? ctx.root;
  const cwdStack = [baseCwd];
  let cwd = baseCwd;
  const local = { ...ctx, cwd };
  let subshellDepth = 0;
  for (let wi = 0; wi < tokenized.length; wi += 1) {
    const words = tokenized[wi];
    if (words.sepAfter === ')') {
      subshellDepth = Math.max(0, subshellDepth - 1);
      if (cwdStack.length > 1) cwdStack.pop();
      cwd = cwdStack[cwdStack.length - 1];
      local.cwd = cwd;
    }
    const { plain } = omPlainWords(words);
    let k = 0;
    while (k < plain.length && (SHELL_KEYWORDS.has(plain[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k]))) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) return false;
      k += 1;
    }
    if (k < plain.length && path.basename(plain[k]) === 'cd') {
      if (subshellDepth > 0) return false;
      const target = plain.slice(k + 1).filter(a => a !== '' && !a.startsWith('-'))[0];
      if (omCdHasDash(plain.slice(k + 1)) || !omCdStepAllowed(words, target, local)) return false;
      cwd = omResolveCd(target, { ...local, cwd });
      local.cwd = cwd;
      cwdStack[cwdStack.length - 1] = cwd;
      continue;
    }
    if (!omSimpleCommandAllowed(words, '', local)) return false;
    if (plain.length > k) {
      const cmd = path.basename(plain[k]);
      if (cmd === 'gh') {
        const gargs = plain.slice(k + 1);
        let gi = 0;
        while (gi < gargs.length && gargs[gi].startsWith('-')) {
          if (gargs[gi] === '-R' || gargs[gi] === '--repo') gi += 2;
          else gi += 1;
        }
      }
    }
    if (words.sepAfter === '(') subshellDepth += 1;
    if (words.sepAfter === '(') cwdStack.push(cwd);
    if (words.sepAfter === '|') {
      let j = wi + 1;
      while (j < tokenized.length && tokenized[j - 1].sepAfter === '|') j += 1;
      const endWords = tokenized[j - 1];
      const { plain: ep } = omPlainWords(endWords);
      let ek = 0;
      while (ek < ep.length && SHELL_KEYWORDS.has(ep[ek])) ek += 1;
      const endCmd = path.basename(ep[ek] ?? '');
      const endArgs = ep.slice(ek + 1);
      const startCmd = path.basename(plain[k] ?? '');
      const needsCap = OM_READ_NEEDS_CAP.has(startCmd) || startCmd === 'cat' || (startCmd === 'gh' && plain.slice(k + 1).includes('api'));
      if (needsCap) {
        if (endCmd === 'head' || endCmd === 'tail') {
          if (!omHeadTailLinesOk(endArgs)) return false;
        } else if (endCmd !== 'wc' && !['grep', 'egrep', 'fgrep', 'rg', 'cut', 'sort', 'uniq', 'jq', 'sed'].includes(endCmd)) {
          return false;
        }
      }
    }
  }
  return true;
};

/** Orchestrator sessions may only run swarm, read-only git/gh, and capped read filters (fail closed). */
export function orchestratorModeCommandAllowed(command, ctx = {}) {
  initOrchestratorModeTrustedBins();
  const text = String(command ?? '');
  if (!text.trim()) return true;
  if (orchestratorCommandTooLong(text)) return false;
  if (orchestratorModeAgentLaunchBlocked(text)) return false;
  if (/<\(|>\(/.test(text)) return false;
  try {
    for (const sub of substitutions(text)) {
      if (!orchestratorModeCommandAllowed(sub, ctx)) return false;
    }
    const tokenized = tokenize(text);
    if (tokenized.unclosedQuote) return false;
    if (omValidateTokenized(tokenized, ctx, text)) return true;
    if (tokenized.length !== 1) return false;
    const words = tokenized[0];
    const { plain } = omPlainWords(words);
    let k = 0;
    while (k < plain.length && (SHELL_KEYWORDS.has(plain[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k]))) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) return false;
      k += 1;
    }
    const segment = plain.slice(k);
    if (!omOrchestratorTestRunAllowed(segment, ctx)) return false;
    if (omTestRunnerRedirectForbidden(words)) return false;
    return true;
  } catch {
    return false;
  }
}
