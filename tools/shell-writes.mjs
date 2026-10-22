// SPDX-License-Identifier: Apache-2.0
// What a shell command writes in the project checkout, read from its text (no execution): redirects, tee, sed -i, mv and cp into the project, rm, touch, mkdir, curl -o, tar -x, git commands
// that change the tree or history, and inline scripts that write files. Used by the hand-build guard (to block) and by the Orchestrator lane (so the hand-built share counts shell writes too).
// It is a reader of command text, not a sandbox, and it fails closed on what it cannot read: a write whose target is a variable or a substitution, a `cd` it cannot follow, an interpreter
// run on a script the orchestrator could have written (inside .swarm/ or docs/), `find -exec` / `xargs` of a writer. It reads inside `bash -c "..."`, `eval "..."`, `$(...)`, backticks,
// subshells, here-documents (their text is data, not commands) and `cd DIR && ...`.
import fs from 'node:fs';
import path from 'node:path';
import { ORCHESTRATOR_OWN, insideProject, realOf, isWorkerCwd } from './orchestrator-events.mjs';

export const ORCHESTRATOR_MODE_OFF_FILE = '.swarm/orchestrator-mode/off';
export const ORCHESTRATOR_MODE_RULE_ID = 'orchestrator-mode';
export const ORCHESTRATOR_MODE_DENY_REASON = 'Orchestrator mode: make a ticket instead: swarm diagnose "<question>" or swarm ticket ... (see swarm diagnose --help). Hand shell work (scripts, test runs, debugging, edits) belongs to workers.';

/** Orchestrator mode is on by default for orchestrator sessions in a swarm project unless the owner added the off file. */
export function orchestratorModeEnabled(root, cwd = root) {
  if (!root || isWorkerCwd(cwd)) return false;
  try {
    const modeDir = path.join(root, '.swarm', 'orchestrator-mode');
    if (!fs.existsSync(modeDir)) return false;
    return !fs.existsSync(path.join(root, ORCHESTRATOR_MODE_OFF_FILE));
  } catch { return false; }
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
export function tokenize(command) {
  const commands = [];
  let words = [], expands = [], word = '', quote = null, hasWord = false, wordExpands = false;
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
  for (let i = 0; i < text.length; i += 1) {
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
      while (heredocs.length) {
        const d = heredocs.shift();
        let j = i + 1;
        for (; j <= text.length; j += 1) {
          const end = text.indexOf('\n', j);
          const line = text.slice(j, end === -1 ? text.length : end);
          if ((d.strip ? line.replace(/^\t+/, '') : line) === d.word) { i = end === -1 ? text.length : end; break; }
          if (end === -1) { i = text.length; break; }
          j = end;
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
  if (subLow === 'ask') {
    let k = i;
    while (k < plain.length && plain[k].startsWith('-')) k = skipFlagValue(plain, k);
    if (k < plain.length) k += 1;
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
      if (!low.startsWith('-')) break;
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
    out.push(w);
    i += 1;
  }
  return out;
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
  const isProtectedAbs = r => [r.abs, r.real].filter(Boolean).some(abs => protectedAbs.some(prefix => {
    const a = abs.toLowerCase(), pre = prefix.toLowerCase();
    // the protected path, what lies under it, and the folders that contain it (removing or moving them removes it)
    return a === pre || a.startsWith(`${pre}/`) || (pre.startsWith(`${a}/`) && a !== '/');
  }));
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
const OM_READ_FILTERS = new Set(['head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'ls', 'cat', 'cut', 'sort', 'uniq', 'jq', 'find', 'sed']);
const OM_GH_ALLOWED = new Set([
  'pr create', 'pr view', 'pr list', 'pr checks', 'pr diff', 'pr status',
  'issue view', 'issue list', 'issue status',
  'run list', 'run watch', 'run view', 'run status',
  'release list', 'release view',
  'workflow list', 'workflow view',
  'repo view',
  'search', 'auth status',
]);
const OM_GIT_EXPLICIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'merge-base', 'fetch', 'describe', 'blame', 'grep', 'shortlog', 'cat-file', 'rev-list', 'for-each-ref', 'name-rev', 'show-ref', 'whatchanged', 'diff-tree', 'diff-index', 'check-ignore', 'ls-remote', 'var', 'version', 'help']);
const OM_WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'env', 'nice', 'builtin', 'xargs', 'stdbuf', 'timeout', 'doas']);
const OM_WRAPPER_VALUE_OPTS = { sudo: ['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U'], doas: ['-u', '-C'], env: ['-u', '-C'], nice: ['-n'], stdbuf: ['-i', '-o', '-e'], timeout: ['-s', '-k', '--signal', '--kill-after'], xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E'] };

const omHeadTailLinesOk = args => {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-n' || a === '--lines') {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > OM_MAX_HEAD_TAIL) return false;
      continue;
    }
    if (/^-n\d+$/.test(a)) {
      const n = Number(a.slice(2));
      if (Number.isFinite(n) && n > OM_MAX_HEAD_TAIL) return false;
      continue;
    }
    if (a.startsWith('--lines=')) {
      const n = Number(a.slice(8));
      if (Number.isFinite(n) && n > OM_MAX_HEAD_TAIL) return false;
    }
  }
  return true;
};

const omFindReadOnly = args => !args.some(a => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls'].includes(a));

const omSedReadOnly = args => {
  if (args.some(a => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='))) return false;
  return args.some(a => a === '-n' || (/^-[A-Za-z]*n/.test(a) && !/^-[A-Za-z]*i/.test(a)));
};

const omGhPrMerge = args => {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === 'pr' && args[i + 1] === 'merge') return true;
  }
  return false;
};

const omGhReadOnly = (args, commandText) => {
  if (omGhPrMerge(args)) return false;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-R' || args[i] === '--repo' || args[i] === '--repository') i += 2;
    else i += 1;
  }
  const pos = args.slice(i).filter(a => !a.startsWith('-'));
  if (pos[0] === 'api') return false;
  const sub = pos[0] === 'search' ? 'search' : (pos.length >= 2 ? `${pos[0]} ${pos[1]}` : pos[0] ?? null);
  if (sub === 'pr view' && /(?:^|\s)--web(?:\s|$)/.test(String(commandText ?? ''))) return false;
  if ((args.includes('--version') || args.includes('-v')) && pos.length === 0) return true;
  return sub !== null && OM_GH_ALLOWED.has(sub);
};

const omGitReadOnly = (sub, rest) => {
  if (!sub) return true;
  if (sub === 'worktree') {
    const verb = rest.find(a => a !== '' && !a.startsWith('-'));
    return verb === 'list' || !verb;
  }
  if (sub === 'tag') {
    const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
    if (pos.length === 0) return true;
    return rest.some(a => a === '-l' || a === '--list');
  }
  if (sub === 'remote') {
    return rest.every(a => a === '-v' || a === '-vv' || a.startsWith('-')) || rest.some(a => a === 'show' || a === 'get-url');
  }
  if (sub === 'branch') {
    return rest.some(a => a === '-l' || a === '--list' || a === '-a' || a === '-r') || rest.filter(a => a !== '' && !a.startsWith('-')).length === 0;
  }
  if (OM_GIT_EXPLICIT.has(sub)) return true;
  return isReadOnlyGitSub(sub, rest);
};

const omSwarmInvocation = (cmd, args) => {
  if (cmd === 'swarm') return true;
  if (cmd === 'node') {
    const scriptAt = args.findIndex(a => a !== '' && !a.startsWith('-'));
    if (scriptAt === -1) return false;
    const base = path.basename(args[scriptAt]).toLowerCase();
    return base === 'swarm.mjs' || args[scriptAt].toLowerCase().endsWith('/swarm.mjs') || args[scriptAt].toLowerCase().endsWith('\\swarm.mjs');
  }
  return false;
};

const omPlainWords = words => {
  const plain = [];
  const expands = [];
  for (let i = 0; i < words.length; i += 1) {
    if (['>', '>>', '>|', '>&', '&>', '<', '<<<', '<<'].includes(words[i])) {
      if (words[i] !== '<<') i += 1;
      continue;
    }
    if (/^\d+$/.test(words[i]) && ['>', '>>', '>&'].includes(words[i + 1])) continue;
    plain.push(words[i]);
    expands.push(words.expands?.[i] ?? false);
  }
  return { plain, expands };
};

const omGitInvocationAllowed = args => {
  if (args.some(a => /^GIT_[A-Z_]+=/.test(a))) return false;
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i] !== '--') {
    const g = args[i];
    if (g === '-c' || g === '--config-env' || g.startsWith('--config=') || g === '--output' || g.startsWith('--output=')) return false;
    if (['-C', '--git-dir', '--work-tree', '--namespace'].includes(g) || g.startsWith('--work-tree=') || g.startsWith('--git-dir=')) {
      i += g.includes('=') ? 1 : 2;
      continue;
    }
    i += 1;
  }
  const sub = i < args.length && !args[i].startsWith('-') ? args[i] : null;
  const rest = sub ? args.slice(i + 1) : [];
  if (rest.some(a => a === '--output' || a.startsWith('--output='))) return false;
  return omGitReadOnly(sub, rest);
};

const omSimpleCommandAllowed = (words, commandText) => {
  if (words.some(w => ['>', '>>', '>|', '>&', '&>'].includes(w))) return false;
  const { plain, expands } = omPlainWords(words);
  let k = 0;
  let wrapperName = null;
  for (;;) {
    if (k >= plain.length) return true;
    if (SHELL_KEYWORDS.has(plain[k])) { k += 1; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) { k += 1; continue; }
    if (OM_WRAPPERS.has(plain[k])) { wrapperName = plain[k]; k += 1; continue; }
    if (wrapperName === 'env' && (plain[k] === '-S' || plain[k] === '--split-string') && plain[k + 1] !== undefined) {
      return orchestratorModeCommandAllowed(plain[k + 1], {});
    }
    if (wrapperName && plain[k]?.startsWith('-')) {
      const takes = (OM_WRAPPER_VALUE_OPTS[wrapperName] ?? []).includes(plain[k]);
      k += takes ? 2 : 1;
      continue;
    }
    if (wrapperName === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(plain[k])) { k += 1; wrapperName = null; continue; }
    break;
  }
  if (k >= plain.length) return true;
  if (expands[k] || /^\$/.test(plain[k])) return false;
  const cmd = path.basename(plain[k]);
  const args = plain.slice(k + 1);
  if (words.piped) {
    if (cmd === 'head' || cmd === 'tail') return omHeadTailLinesOk(args);
    if (['grep', 'egrep', 'fgrep', 'rg', 'cut', 'sort', 'uniq', 'wc', 'jq'].includes(cmd)) return true;
    if (cmd === 'sed') return omSedReadOnly(args);
    return false;
  }
  if (cmd === 'git') return omGitInvocationAllowed(args);
  if (cmd === 'gh') return omGhReadOnly(args, commandText);
  if (omSwarmInvocation(cmd, args)) return true;
  if (OM_READ_FILTERS.has(cmd)) {
    if (cmd === 'find') return omFindReadOnly(args);
    if (cmd === 'sed') return omSedReadOnly(args);
    if (cmd === 'head' || cmd === 'tail') return omHeadTailLinesOk(args);
    return true;
  }
  if (cmd === 'true' || cmd === 'false' || cmd === ':') return true;
  return false;
};

/** Orchestrator sessions may only run swarm, read-only git/gh, and capped read filters (fail closed). */
export function orchestratorModeCommandAllowed(command, _ctx = {}) {
  const text = String(command ?? '');
  if (!text.trim()) return true;
  if (/<\(|>\(/.test(text)) return false;
  try {
    for (const sub of substitutions(text)) {
      if (!orchestratorModeCommandAllowed(sub, _ctx)) return false;
    }
    const tokenized = tokenize(text);
    if (tokenized.unclosedQuote) return false;
    for (const words of tokenized) {
      if (!omSimpleCommandAllowed(words, text)) return false;
    }
    return true;
  } catch {
    return true;
  }
}
