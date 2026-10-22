// SPDX-License-Identifier: Apache-2.0
// The hand-build guard: an orchestrator session may not build by hand. All build work goes through the swarm (a ticket); the only exceptions are a hand-build the owner approved, for
// a valid reason, for named files, for a short time. Orchestrator mode (shell allowlist) is on by default at the project root; the owner disables it with `.swarm/orchestrator-mode/off`.
// This module is the state and the decision; tools/handbuild-guard.mjs is the Claude Code hook that asks it before every edit or shell
// command, and tools/handbuild-commands.mjs is `swarm handbuild request | approve | deny | status | log`.
//   Allowed without approval: reading, running tests and builds, writing under .swarm/ and docs/plans/ (tickets and plans), build output, anything outside the checkout, and swarm worker
//   workspaces. Everything else in the checkout (an edit, a write, sed -i, a redirect, tee, mv or cp into it, rm, git commit/push...) needs an approval that names the file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { insideProject, ORCHESTRATOR_OWN, WRITE_TOOLS } from './orchestrator-events.mjs';
import { execFileSync } from 'node:child_process';
import {
  analyzeShell,
  writesAnything,
  TOOL_DIRS,
  tokenize,
  isReadOnlyGitSub,
  orchestratorModeCommandAllowed,
  orchestratorModeEnabled,
  ORCHESTRATOR_MODE_OFF_FILE,
  ORCHESTRATOR_MODE_RULE_ID,
  ORCHESTRATOR_MODE_DENY_REASON,
} from './shell-writes.mjs';
import { isRoutingPath, isRoutingPathResolved } from './routing-paths.mjs';
import { swarmProducedFiles, isSwarmProducedContent } from './swarm-produced.mjs';
import {
  isSelfApprovalCommand,
  SELF_APPROVAL_REASON,
  handbuildShellPolicy,
  HANDBUILD_SELF_APPROVAL_RULE_ID,
  swarmChangeShellPolicy,
} from './self-approval.mjs';
export const SCRATCH_DENY_REASON = 'scratch project';

export const GIT_REQUEST_OPS = Object.freeze(['commit', 'push', 'merge', 'deploy', 'force-push', 'branch-D', 'gh']);
export const ELEVATED_GIT_OPS = Object.freeze(['merge', 'deploy', 'force-push', 'branch-D']);
const CHAT_MERGE_MS = 60 * 60000;
const ALLOWED_GH = new Set([
  'pr create', 'pr view', 'pr list', 'pr checks', 'pr diff', 'pr status',
  'issue view', 'issue list', 'issue status',
  'run list', 'run watch', 'run view', 'run status',
  'release list', 'release view',
  'workflow list', 'workflow view',
  'repo view',
  'search', 'auth status',
]);
const GH_BLOCKED_READ_MODIFIERS = /(?:^|\s)--web(?:\s|$)/;
const VERCEL_TOP_FREE = new Set(['ls', 'list', 'inspect', 'logs', 'whoami', '--version', 'help']);
const VERCEL_LIST_PARENTS = new Set(['env', 'domains', 'projects', 'project', 'teams', 'team', 'dns', 'certs', 'certificates', 'alias', 'secrets', 'integration', 'redirects', 'rolling-release']);
const VERCEL_INFO_FLAGS = new Set(['--help', '-h', '--version', '-v']);
export const GH_PR_MERGE_BLOCKED = 'Hand-build guard: gh pr merge is blocked; use swarm merge N, which checks CI first.';
export const MERGE_BLOCKED_REASON = 'Hand-build guard: merging a pull request needs the owner. The owner can type merge and the PR number in chat, or their machine policy can enable standing approval for swarm merge; use swarm merge N, which checks CI first.';
const READ_GIT_SUBS = new Set(['status', 'log', 'diff', 'show']);
const WRITE_HTTP = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CONFIG_FLAGS = new Set(['-c', '--config', '--output', '--exec', '-x', '--exec-path', '--upload-pack', '--receive-pack', '--ext-diff']);
const PLAIN_REF = /^[A-Za-z0-9._/-]+$/;
const COMMIT_MSG_OPTS = new Set(['-m', '-F', '-C', '-c', '--author', '--date', '--message']);
const GH_REPO_OPTS = new Set(['-R', '--repo', '--repository']);

/** Current branch name; detached HEAD returns `HEAD`. */
export function branchOf(root) {
  try { return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 }).trim(); }
  catch { return 'HEAD'; }
}

/** True when `ref` resolves to a commit in the repo at `root`. */
export function revParseCommit(root, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
    return true;
  } catch { return false; }
}

export const isProtectedBranch = b => b === 'main' || b === 'master' || b === 'HEAD';

const normBranch = b => String(b ?? '').replace(/^refs\/heads\//, '');
const hasConfigInWords = words => words.some(w => CONFIG_FLAGS.has(w) || w === '--config-env' || w.startsWith('--config=') || w.startsWith('--output=')
  || /=upload-pack$|=receive-pack$|=exec$|=config$/.test(w) || /^--exec=/.test(w) || /^--upload-pack=/.test(w) || /^--receive-pack=/.test(w)
  || w === '--exec-path' || w.startsWith('--exec-path='));

/** Configured remotes; null when git remote cannot be read in time. */
export const gitRemotesOf = root => {
  try {
    return execFileSync('git', ['remote'], { cwd: root, encoding: 'utf8', timeout: 3000 }).split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return null; }
};

const isConfiguredRemote = (name, root) => {
  const remotes = gitRemotesOf(root);
  if (remotes === null) return false;
  return remotes.includes(name);
};

const commandHasGitEnv = command => {
  for (const words of tokenize(command)) {
    for (const w of words) {
      if (/^GIT_[A-Z0-9_]+=/.test(w)) return true;
    }
  }
  return false;
};

const parsePushRefspecWord = raw => {
  let spec = String(raw ?? '');
  let force = false;
  if (spec.startsWith('+')) { force = true; spec = spec.slice(1); }
  let del = false;
  let src = null;
  let dst = null;
  if (spec.startsWith(':') && spec.length > 1) {
    del = true;
    dst = normBranch(spec.slice(1));
    src = '';
  } else if (spec.includes(':')) {
    const colon = spec.indexOf(':');
    src = spec.slice(0, colon);
    const rhs = spec.slice(colon + 1);
    if (rhs === '') { del = true; dst = normBranch(src); src = ''; }
    else { dst = normBranch(rhs); if (!src) src = dst; }
  } else {
    dst = normBranch(spec);
    src = dst;
  }
  return { src, dst, force, delete: del };
};

const isClaudeProjectTranscriptAbs = (abs, home) => {
  const base = path.join(home, '.claude', 'projects');
  const rel = path.relative(base, path.resolve(abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || parts[1] === 'memory') return false;
  return /\.jsonl$/i.test(parts[1]);
};

const isClaudeMemoryPathOutside = (abs, home) => {
  const base = path.join(home, '.claude', 'projects');
  const rel = path.relative(base, path.resolve(abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length >= 2 && parts[1] === 'memory';
};

const bashTranscriptWrites = (command, home) => {
  const hits = [];
  for (const words of tokenize(command)) {
    for (let i = 0; i < words.length; i += 1) {
      if (['>', '>>', '>|', '>&', '&>'].includes(words[i]) && words[i + 1] !== undefined && !/^&?\d+$/.test(words[i + 1])) {
        let p = words[i + 1];
        if (p.startsWith('~/')) p = path.join(home, p.slice(2));
        const abs = path.isAbsolute(p) ? path.resolve(p) : null;
        if (abs && isClaudeProjectTranscriptAbs(abs, home)) hits.push(p);
      }
    }
  }
  return hits;
};

const realOfAbs = abs => {
  let cur = abs;
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(abs);
      tail.push(path.basename(cur));
      cur = up;
    }
  }
  return path.resolve(abs);
};

const isSessionScratchpadRoot = (dir, home) => {
  const n = realOfAbs(dir);
  const base = path.basename(n);
  if (base !== 'scratchpad') return false;
  const parent = path.dirname(n);
  const pBase = path.basename(parent);
  if (pBase.startsWith('claude-') && realOfAbs(parent).startsWith(`${realOfAbs(os.tmpdir())}${path.sep}`)) return true;
  const swarmScratch = path.join(home, '.project-swarm-scratch');
  const rs = realOfAbs(swarmScratch);
  return n === rs || n.startsWith(`${rs}${path.sep}`);
};

const allowedOutsideDelete = (abs, home) => {
  const n = realOfAbs(path.resolve(abs));
  let cur = n;
  for (let i = 0; i < 64; i += 1) {
    if (isSessionScratchpadRoot(cur, home)) return true;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return false;
};

const isTracked = (root, rel) => {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
    return true;
  } catch { return false; }
};

const expandPath = (raw, { root, cwd, home }) => {
  if (!raw) return null;
  let p = raw;
  if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(2));
  if (!path.isAbsolute(p)) p = path.resolve(cwd || root, p);
  return p;
};

/** Destinations of mv into a session scratchpad (project-relative paths that are free writes). */
const mvScratchpadDests = (command, { root, cwd, home }) => {
  const free = new Set();
  for (const words of tokenize(command)) {
    const mi = words.findIndex(w => w === 'mv');
    if (mi === -1) continue;
    const dest = words.slice(mi + 1).filter(w => w && !w.startsWith('-')).pop();
    if (!dest) continue;
    const abs = expandPath(dest, { root, cwd, home });
    if (!abs) continue;
    const realDest = realOfAbs(abs);
    if (!isSessionScratchpadRoot(realDest, home) && !isSessionScratchpadRoot(path.dirname(realDest), home)) {
      const rel = insideProject(root, abs);
      if (rel === null || (!rel.startsWith('scratchpad/') && rel !== 'scratchpad')) continue;
    }
    const rel = insideProject(root, abs);
    if (rel !== null) free.add(rel === '' ? '.' : rel);
    else if (isSessionScratchpadRoot(path.dirname(realDest), home) || isSessionScratchpadRoot(realDest, home)) {
      const parent = path.dirname(realDest);
      const base = path.basename(realDest);
      const relIn = insideProject(root, path.join(parent, base));
      if (relIn) free.add(relIn);
    }
  }
  return free;
};

/** Untracked project sources moved into scratchpad (free removals). */
const mvUntrackedSourcesToScratchpad = (command, { root, cwd, home }) => {
  const free = new Set();
  for (const words of tokenize(command)) {
    const mi = words.findIndex(w => w === 'mv');
    if (mi === -1) continue;
    const operands = words.slice(mi + 1).filter(w => w && !w.startsWith('-'));
    if (operands.length < 2) continue;
    const dest = operands[operands.length - 1];
    const absDest = expandPath(dest, { root, cwd, home });
    if (!absDest) continue;
    const realDest = realOfAbs(absDest);
    const toScratch = isSessionScratchpadRoot(realDest, home) || isSessionScratchpadRoot(path.dirname(realDest), home)
      || (() => { const r = insideProject(root, absDest); return r !== null && (r === 'scratchpad' || r.startsWith('scratchpad/')); })();
    if (!toScratch) continue;
    for (const src of operands.slice(0, -1)) {
      const absSrc = expandPath(src, { root, cwd, home });
      if (!absSrc) continue;
      const rel = insideProject(root, absSrc);
      if (rel === null || isTracked(root, rel)) continue;
      free.add(rel);
    }
  }
  return free;
};

/** Tracked project sources moved into scratchpad that are not routing or swarm-produced. */
const mvTrackedSourcesNeedingApproval = (command, { root, cwd, home }, produced) => {
  const need = [];
  for (const words of tokenize(command)) {
    const mi = words.findIndex(w => w === 'mv');
    if (mi === -1) continue;
    const operands = words.slice(mi + 1).filter(w => w && !w.startsWith('-'));
    if (operands.length < 2) continue;
    const dest = operands[operands.length - 1];
    const absDest = expandPath(dest, { root, cwd, home });
    if (!absDest) continue;
    const realDest = realOfAbs(absDest);
    const toScratch = isSessionScratchpadRoot(realDest, home) || isSessionScratchpadRoot(path.dirname(realDest), home)
      || (() => { const r = insideProject(root, absDest); return r !== null && (r === 'scratchpad' || r.startsWith('scratchpad/')); })();
    if (!toScratch) continue;
    for (const src of operands.slice(0, -1)) {
      const absSrc = expandPath(src, { root, cwd, home });
      if (!absSrc) continue;
      const rel = insideProject(root, absSrc);
      if (rel === null || !isTracked(root, rel)) continue;
      const rlow = rel.toLowerCase();
      const allow = ORCHESTRATOR_OWN.some(prefix => rlow === prefix.slice(0, -1) || rlow.startsWith(prefix)) || TOOL_DIRS.some(prefix => rlow === prefix.slice(0, -1) || rlow.startsWith(prefix));
      if (carryBytesOk(root, rel, readWorkingTreeBytes(root, rel)) || allow) continue;
      need.push(rel);
    }
  }
  return need;
};

const plainWords = words => {
  const plain = [];
  for (let i = 0; i < words.length; i += 1) {
    if (['>', '>>', '>|', '>&', '&>', '<', '<<<'].includes(words[i])) { i += 1; continue; }
    if (words[i] === '<<') continue;
    if (/^\d+$/.test(words[i]) && ['>', '>>', '>&'].includes(words[i + 1])) continue;
    plain.push(words[i]);
  }
  return plain;
};

const commandHasGhRepoFlag = command => {
  for (const words of tokenize(command)) {
    const plain = plainWords(words);
    const gi = plain.findIndex(w => path.basename(w) === 'gh');
    if (gi === -1) continue;
    if (plain.slice(gi + 1).some(w => GH_REPO_OPTS.has(w) || w.startsWith('--repo=') || w.startsWith('--repository='))) return true;
  }
  return false;
};

const WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'env', 'nice', 'builtin', 'xargs', 'stdbuf', 'timeout']);
const WRAPPER_VALUE_OPTS = { sudo: ['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U'], env: ['-u', '-C'], nice: ['-n'], stdbuf: ['-i', '-o', '-e'], timeout: ['-s', '-k', '--signal', '--kill-after'], xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E'] };
const POLICY_SHELL_KEYWORDS = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', 'fi', 'done', 'case', 'esac', 'for', 'in', 'select', 'function', 'coproc']);
const POLICY_SHELLS = new Set(['bash', 'sh', 'zsh']);
const shortFlagHas = (flag, ch) => flag.startsWith('-') && !flag.startsWith('--') && flag.slice(1).includes(ch);
const shellCodeFlag = a => /^-[A-Za-z]*c$/.test(a) || a === '--command';

const policySubstitutions = text => {
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
};

const gitPushPolicy = (rest, meta) => {
  const flags = rest.filter(a => a.startsWith('-'));
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  const force = flags.some(a => a === '--force' || a === '-f' || a === '--force-with-lease' || a === '--force-if-includes' || a.startsWith('--force-with-lease=') || shortFlagHas(a, 'f'))
    || pos.some(a => a.startsWith('+'));
  let deleteMode = null;
  if (rest.some(a => a === '--delete' || a === '-d') || flags.includes('--mirror') || flags.includes('--prune')) deleteMode = 'remote';
  const refspecs = [];
  let branch = null;
  if (pos.length >= 2) {
    for (const a of pos.slice(1)) {
      const rs = parsePushRefspecWord(a);
      refspecs.push(rs);
      if (rs.dst) branch = rs.dst;
      if (rs.delete) deleteMode = 'remote';
      if (rs.force) { /* force stays on op */ }
    }
  } else if (pos.length === 1 && (pos[0].includes(':') || pos[0].startsWith('+') || (pos[0].startsWith(':') && pos[0].length > 1))) {
    const rs = parsePushRefspecWord(pos[0]);
    refspecs.push(rs);
    if (rs.dst) branch = rs.dst;
    if (rs.delete) deleteMode = 'remote';
  }
  for (const a of pos) {
    if (a.startsWith('+')) { const spec = a.slice(1); branch = normBranch(spec.includes(':') ? spec.split(':').pop() : spec); }
    else if (a.startsWith(':') && a.length > 1) { deleteMode = 'remote'; branch = normBranch(a.slice(1)); }
    else if (a.includes(':')) {
      const rhs = a.split(':').pop();
      if (rhs === '') deleteMode = 'remote';
      else branch = normBranch(rhs);
    } else if (pos.length === 2 && a === pos[1]) branch = normBranch(a);
  }
  return { tool: 'git', sub: 'push', args: pos, flags, branch, force, delete: deleteMode, positionals: pos.length, refspecs, ...meta };
};

const gitFetchPolicy = (rest, meta) => {
  const flags = rest.filter(a => a.startsWith('-'));
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  return { tool: 'git', sub: 'fetch', args: pos, flags, branch: null, force: false, delete: null, positionals: pos.length, ...meta };
};

const gitBranchPolicy = (rest, meta) => {
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  const hasDelete = rest.some(a => a === '-d' || a === '--delete');
  const hasForce = rest.some(a => a === '-D' || a === '-f' || a === '--force');
  let deleteMode = null;
  if (rest.some(a => a === '-D') || (hasDelete && hasForce)) deleteMode = 'force';
  else if (hasDelete) deleteMode = 'safe';
  else if (rest.some(a => ['-f', '-m', '-M', '-c', '-C', '--force', '--move', '--copy'].includes(a))) deleteMode = 'force';
  return { tool: 'git', sub: 'branch', args: pos.slice(1), flags: rest.filter(a => a.startsWith('-')), branch: pos[0] ?? null, force: false, delete: deleteMode, ...meta };
};

const policyOpsFromPlain = (plain, plainExp, ops) => {
  let k = 0, wrapperName = null;
  for (;;) {
    if (k >= plain.length) return;
    if (POLICY_SHELL_KEYWORDS.has(plain[k])) { k += 1; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) { k += 1; continue; }
    if (wrapperName === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[k])) { k += 1; continue; }
    if (WRAPPERS.has(plain[k])) { wrapperName = plain[k]; k += 1; continue; }
    if (wrapperName === 'env' && (plain[k] === '-S' || plain[k] === '--split-string') && plain[k + 1] !== undefined) {
      buildPolicyOps(plain[k + 1]).forEach(o => ops.push(o));
      return;
    }
    if (wrapperName && plain[k]?.startsWith('-')) { const takes = (WRAPPER_VALUE_OPTS[wrapperName] ?? []).includes(plain[k]); k += takes ? 2 : 1; continue; }
    if (wrapperName === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(plain[k])) { k += 1; wrapperName = null; continue; }
    break;
  }
  if (k >= plain.length) return;
  if (plainExp[k]) { ops.push({ tool: '_opaque', sub: null, opaque: true }); return; }
  const cmd = path.basename(plain[k]);
  const args = plain.slice(k + 1);
  const hasConfig = hasConfigInWords(plain.slice(k));
  if (POLICY_SHELLS.has(cmd)) {
    const at = args.findIndex(shellCodeFlag);
    if (at !== -1 && args[at + 1] !== undefined) buildPolicyOps(args[at + 1]).forEach(o => ops.push(o));
    return;
  }
  if (cmd === 'eval') { buildPolicyOps(args.join(' ')).forEach(o => ops.push(o)); return; }
  if (cmd === 'git') {
    let globalOpts = false;
    let benignGlobalOnly = true;
    let i = 0;
    const globalWords = [];
    while (i < args.length && args[i].startsWith('-') && args[i] !== '--') {
      const g = args[i];
      if (g === '--no-pager') { globalOpts = true; i += 1; continue; }
      globalOpts = true;
      globalWords.push(g);
      if (g === '-C' || ['--git-dir', '--work-tree', '--namespace'].includes(g) || g.startsWith('--work-tree=') || g.startsWith('--git-dir=')) {
        if (g === '-C' && args[i + 1] !== undefined) globalWords.push(args[i + 1]);
        i += g.includes('=') ? 1 : 2;
        continue;
      }
      if (g === '-c' || g === '--config-env' || g.startsWith('--config=')) benignGlobalOnly = false;
      if (g === '-c' || g === '--config-env' || ['--git-dir', '--work-tree', '--namespace'].includes(g)) {
        if (args[i + 1] !== undefined) globalWords.push(args[i + 1]);
        i += 2;
      } else i += 1;
    }
    const sub = i < args.length && !args[i].startsWith('-') ? args[i] : null;
    const rest = sub ? args.slice(i + 1) : [];
    const gitEnv = plain.slice(0, k).some(w => /^GIT_[A-Z0-9_]+=/.test(w));
    const gitHasConfigGlobal = hasConfigInWords(globalWords);
    const gitHasConfig = (sub === 'switch' || sub === 'checkout')
      ? gitHasConfigGlobal
      : hasConfigInWords([...globalWords, ...rest]);
    const meta = { globalOpts, benignGlobalOnly: globalOpts && benignGlobalOnly, hasConfig: gitHasConfig, gitEnv, target: null };
    if (sub === 'push') ops.push({ ...gitPushPolicy(rest, meta), rest });
    else if (sub === 'fetch') ops.push({ ...gitFetchPolicy(rest, meta), rest });
    else if (sub === 'branch') ops.push({ ...gitBranchPolicy(rest, meta), rest });
    else {
      const pos = rest.filter(a => a && !a.startsWith('-'));
      let branch = null;
      if (sub === 'rebase' && pos[0]) branch = pos[0];
      else if (sub === 'merge') branch = pos[0] ?? null;
      ops.push({ tool: 'git', sub, args: pos, rest, globalOpts, benignGlobalOnly: meta.benignGlobalOnly, hasConfig: gitHasConfig, flags: rest.filter(a => a.startsWith('-')), branch, force: false, delete: null, target: null });
    }
  } else if (cmd === 'gh') {
      let globalOpts = false;
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) {
        globalOpts = true;
        i = skipGhGlobalOpt(args, i);
      }
      const pos = args.slice(i).filter(a => !a.startsWith('-'));
      const prMerge = ghArgsImplyPrMerge(args);
      const sub = prMerge ? 'pr merge' : (pos[0] === 'api' ? 'api' : (pos[0] === 'search' ? 'search' : (pos.length >= 2 ? `${pos[0]} ${pos[1]}` : pos[0] ?? null)));
      let ghTarget = null;
      if (prMerge) {
        const pi = args.findIndex((a, idx) => a === 'pr' && args[idx + 1] === 'merge');
        const after = args.slice(pi + 2).find(a => !a.startsWith('-'));
        ghTarget = after !== undefined ? String(after) : null;
      } else if (sub === 'pr merge' && pos[2] !== undefined) ghTarget = String(pos[2]);
      ops.push({ tool: 'gh', sub, ghPrMerge: prMerge, args: pos.slice(2), globalOpts, hasConfig, flags: args.filter(a => a.startsWith('-')), branch: null, force: false, delete: null, target: ghTarget });
    } else if (cmd === 'vercel') {
      const globalOpts = args.some(a => a.startsWith('-'));
      const prod = args.includes('--prod');
      const pos = args.filter(a => !a.startsWith('-'));
      const onlyVersion = (args.includes('--version') || args.includes('-v')) && pos.length === 0;
      const sub = onlyVersion ? '--version' : (prod || pos.length === 0 || args.every(a => a.startsWith('-')) ? 'deploy' : pos[0]);
      ops.push({ tool: 'vercel', sub, args: sub === 'deploy' ? pos : pos.slice(1), globalOpts, hasConfig, flags: args.filter(a => a.startsWith('-')), branch: null, force: false, delete: null, target: null });
    } else if (cmd === 'swarm') {
      const pos = args.filter(a => !a.startsWith('-'));
      const sub = pos[0] ?? null;
      const swarmTarget = sub === 'merge' && pos[1] !== undefined ? String(pos[1]) : null;
      ops.push({ tool: 'swarm', sub, args: pos.slice(1), globalOpts: args.some(a => a.startsWith('-')), hasConfig, flags: args.filter(a => a.startsWith('-')), branch: null, force: false, delete: null, target: swarmTarget });
    }
};

/** Policy ops with args, globalOpts, and hasConfig (shared contract with shell-writes). */
const buildPolicyOps = command => {
  const ops = [];
  for (const sub of policySubstitutions(command)) buildPolicyOps(sub).forEach(o => ops.push(o));
  for (const words of tokenize(command)) {
    const wordExp = words.expands ?? [];
    const plain = [];
    const plainExp = [];
    for (let i = 0; i < words.length; i += 1) {
      if (['>', '>>', '>|', '>&', '&>', '<', '<<<'].includes(words[i])) { i += 1; continue; }
      if (words[i] === '<<') continue;
      if (/^\d+$/.test(words[i]) && ['>', '>>', '>&'].includes(words[i + 1])) continue;
      plain.push(words[i]);
      plainExp.push(wordExp[i] ?? false);
    }
    policyOpsFromPlain(plain, plainExp, ops);
  }
  return ops;
};

const protectedBranchName = b => {
  const n = normBranch(b);
  return n === 'main' || n === 'master' || n === 'refs/heads/main' || n === 'refs/heads/master';
};

const pushBlockedOnProtected = (pos, forceOrDelete) => {
  for (const a of pos) {
    const spec = a.startsWith('+') ? a.slice(1) : a;
    if (spec.includes(':')) {
      const dst = normBranch(spec.split(':').pop());
      const src = spec.split(':')[0];
      if (protectedBranchName(dst)) return true;
      if ((src === '' || src === ':') && protectedBranchName(dst)) return true;
    } else if (forceOrDelete && protectedBranchName(spec)) return true;
    if (a === ':main' || a === ':master' || a.endsWith(':main') || a.endsWith(':master')) return true;
  }
  return false;
};

const isFreeGitPush = (op, current, root) => {
  if (op.globalOpts || op.hasConfig || op.gitEnv) return false;
  const flags = op.flags ?? [];
  if (flags.some(f => ['--mirror', '--prune', '--delete', '-d', '--all'].includes(f))) return false;
  if (op.delete === 'remote') return false;
  const refspecs = op.refspecs ?? [];
  if (refspecs.some(r => r.delete)) return false;
  if (op.force || refspecs.some(r => r.force)) return false;
  if (flags.some(f => !['-u', '--set-upstream'].includes(f))) return false;
  if (flags.some(f => ['-f', '--force'].includes(f) || shortFlagHas(f, 'f'))) return false;
  const pos = op.args ?? [];
  const positionals = op.positionals ?? pos.length;
  if (positionals > 2) return false;
  if (refspecs.some(r => r.src !== r.dst)) return false;
  if (pos.some(a => a.startsWith('+') || a.includes(':'))) return false;
  if (positionals === 0) {
    if (isProtectedBranch(current)) return false;
    return true;
  }
  if (positionals === 1) {
    if (!PLAIN_REF.test(pos[0]) || !isConfiguredRemote(pos[0], root)) return false;
    if (isProtectedBranch(current)) return false;
    return true;
  }
  if (positionals === 2) {
    if (!PLAIN_REF.test(pos[0]) || !isConfiguredRemote(pos[0], root)) return false;
    const branchWord = pos[1];
    if (!PLAIN_REF.test(branchWord) || branchWord.includes(':') || branchWord.startsWith('+')) return false;
    const branch = normBranch(branchWord);
    if (isProtectedBranch(branch)) return false;
    return true;
  }
  return false;
};

const FREE_FETCH_FLAGS = new Set(['--all', '--prune', '--tags', '--quiet']);
const isFreeGitFetch = (op, root) => {
  if (op.globalOpts || op.hasConfig || op.gitEnv) return false;
  const flags = op.flags ?? [];
  for (const f of flags) {
    if (FREE_FETCH_FLAGS.has(f)) continue;
    if (f === '-p' || f === '-q') continue;
    if (f.startsWith('-') && !f.startsWith('--') && (shortFlagHas(f, 'p') || shortFlagHas(f, 'q'))) continue;
    return false;
  }
  if (flags.some(f => f.includes('=')) || (op.args ?? []).some(a => a.includes('='))) return false;
  const pos = op.args ?? [];
  const positionals = op.positionals ?? pos.length;
  if (positionals > 1) return false;
  if (pos.some(a => a.includes(':') || a === '.')) return false;
  if (positionals === 1 && !isConfiguredRemote(pos[0], root)) return false;
  return true;
};

const isFreeGitRebase = (op, protBranch) => {
  if (protBranch || op.globalOpts || op.hasConfig) return false;
  const flags = op.flags ?? [];
  if (flags.some(f => ['-x', '--exec', '-i', '--interactive', '--onto', '--autosquash'].includes(f))) return false;
  const pos = op.args ?? [];
  if (pos.length !== 1 || !PLAIN_REF.test(pos[0])) return false;
  return true;
};

const isFreeReadGit = op => !op.hasConfig && !op.gitEnv && !(op.flags ?? []).some(f => f === '--output' || f.startsWith('--output='))
  && (!op.globalOpts || op.benignGlobalOnly === true);

const vercelFlagIsInfoOnly = f => VERCEL_INFO_FLAGS.has(f);

const ghArgsImplyPrMerge = args => {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === 'pr' && args[i + 1] === 'merge') return true;
  }
  return false;
};

const skipGhGlobalOpt = (args, i) => {
  const a = args[i];
  if (a === '-R' || a === '--repo' || a === '--repository') return i + 2;
  if (a.startsWith('--repo=') || a.startsWith('--repository=')) return i + 1;
  return i + 1;
};

const vercelFlagsBlockRead = flags => flags.some(f => f === '--token' || f.startsWith('--token=') || (f === '-t' && flags.includes('--token')));

const isFreeVercel = op => {
  if (op.hasConfig) return false;
  const flags = op.flags ?? [];
  const args = op.args ?? [];
  const sub = op.sub;
  if (vercelFlagsBlockRead(flags)) return false;
  if (flags.includes('--prod')) return false;
  if (sub === 'git') {
    if (args[0] === 'ls') return true;
    if (['connect', 'disconnect'].includes(args[0])) return false;
    return false;
  }
  if (sub === 'deploy') {
    if (args.length > 0) return false;
    if (flags.length === 0) return false;
    return flags.every(vercelFlagIsInfoOnly);
  }
  if (VERCEL_TOP_FREE.has(sub)) return true;
  if (sub === 'inspect') return true;
  if (VERCEL_LIST_PARENTS.has(sub) && args.length >= 1 && ['ls', 'list', 'inspect'].includes(args[0])) return true;
  return false;
};

const ghApiEndpointReadOnly = endpoint => {
  const e = String(endpoint ?? '').replace(/^['"]|['"]$/g, '').replace(/^\/+/, '');
  if (!e || /^graphql/i.test(e)) return false;
  if (e === 'user' || e.startsWith('user/')) return false;
  return /^repos\//.test(e) || /^orgs\//.test(e) || e === 'rate_limit';
};

const GH_API_VALUE_FLAGS = new Set(['-H', '--header', '-q', '--jq', '--template', '-t', '--paginate', '--slurp', '-i', '--include', '--silent', '--hostname', '--cache']);

const ghApiArgsReadOnly = rest => {
  let endpoint = null;
  let i = 0;
  while (i < rest.length) {
    const w = rest[i];
    if (w === '-X' || w === '--method') {
      const m = String(rest[i + 1] ?? 'GET').toUpperCase();
      if (m !== 'GET') return false;
      i += 2;
      continue;
    }
    if (w.startsWith('--method=')) {
      if (w.slice(9).toUpperCase() !== 'GET') return false;
      i += 1;
      continue;
    }
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(w)) return false;
    if (w === 'graphql' || /\/graphql\b/i.test(w)) return false;
    if (GH_API_VALUE_FLAGS.has(w) || (w.startsWith('--') && ['--jq=', '--template=', '--header='].some(p => w.startsWith(p)))) {
      i += w.includes('=') ? 1 : 2;
      continue;
    }
    if (!w.startsWith('-') && endpoint === null) endpoint = w;
    i += 1;
  }
  return ghApiEndpointReadOnly(endpoint);
};

const isGhApiReadOnlyCommand = command => {
  for (const words of tokenize(command)) {
    const plain = plainWords(words);
    const gi = plain.findIndex(w => path.basename(w) === 'gh');
    if (gi === -1) continue;
    const rest = plain.slice(gi + 1);
    if (rest[0] !== 'api') continue;
    return ghApiArgsReadOnly(rest.slice(1));
  }
  return false;
};

const isFreeReadOnlyGh = (op, command) => {
  const flags = op.flags ?? [];
  if ((flags.includes('--version') || flags.includes('-v')) && !op.sub) return true;
  if (op.sub === '--version') return true;
  if (op.sub === 'run download') return false;
  if (op.sub === 'pr view' && GH_BLOCKED_READ_MODIFIERS.test(String(command ?? ''))) return false;
  if (op.sub === 'api') return isGhApiReadOnlyCommand(command);
  return ALLOWED_GH.has(op.sub);
};

const swarmConfigDir = home => (process.env.SWARM_CONFIG ? path.dirname(process.env.SWARM_CONFIG) : path.join(home, '.config', 'project-swarm'));

const policyFilePath = home => {
  const envPath = process.env.SWARM_POLICY_FILE;
  if (envPath) {
    if (!path.isAbsolute(envPath)) return null;
    return envPath;
  }
  return path.join(swarmConfigDir(home), 'policy.json');
};

/** True when policy.json enables standing approval for `swarm merge N`. */
export const mergeSwarmPrStandingEnabled = (home = os.homedir()) => {
  try {
    const file = policyFilePath(home);
    if (!file) return false;
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!policy || !Array.isArray(policy.rules)) return false;
    const rules = policy.rules.filter(r => r?.id === 'merge-swarm-pr');
    if (!rules.length) return false;
    return rules.every(r => r.enabled === true && r.disabled !== true);
  } catch { return false; }
};

const isStandingSwarmMerge = (op, home) => {
  if (!mergeSwarmPrStandingEnabled(home)) return false;
  if (op.tool !== 'swarm' || op.sub !== 'merge') return false;
  if (op.globalOpts || op.hasConfig) return false;
  const flags = op.flags ?? [];
  if (flags.length > 0) return false;
  const args = op.args ?? [];
  if (args.length !== 1 || !/^\d+$/.test(String(args[0]))) return false;
  return true;
};

const SWITCH_BLOCK_FLAGS = new Set(['-f', '--force', '-B', '-C', '--discard-changes', '--orphan', '--merge', '-m']);
const normRel = p => String(p).replace(/\\/g, '/');

const isRestoreFreePath = (root, raw) => {
  const n = normRel(raw);
  if (!n || n.includes('..') || n === '.' || n.endsWith('/') || /[*?[{]/.test(n)) return false;
  const lower = n.toLowerCase();
  if (lower === 'docs/state' || lower.startsWith('docs/state/')) return true;
  return isRoutingPath(n) || isRoutingPathResolved(root, n);
};

const switchCheckoutFlagBlocked = flags => {
  for (const f of flags) {
    if (f === '--') continue;
    if (SWITCH_BLOCK_FLAGS.has(f) || SWITCH_BLOCK_FLAGS.has(f.split('=')[0])) return true;
    if (!f.startsWith('--') && f.startsWith('-') && f.length > 1) {
      for (const ch of f.slice(1)) {
        if (ch === 'f' || ch === 'B' || ch === 'C' || ch === 'm') return true;
      }
    }
  }
  return false;
};

const switchCheckoutCreateFlag = flags => {
  for (const f of flags) {
    if (f === '-b' || f === '-c' || f === '--create') return true;
    if (!f.startsWith('--') && f.startsWith('-')) {
      for (const ch of f.slice(1)) {
        if (ch === 'b' || ch === 'c') return true;
      }
    }
  }
  return false;
};

const refUnsafeForFreeSwitch = ref => ref === '.' || ref === '-' || ref.startsWith('.') || ref.includes('..');

const refExistsAsProjectPath = (root, ref) => {
  const n = normRel(ref);
  if (!n || n.includes('..')) return true;
  try {
    fs.accessSync(path.join(root, n));
    return true;
  } catch { return false; }
};

const isFreeGitSwitchCheckout = (op, root, revParseCommitFn) => {
  if (op.sub !== 'switch' && op.sub !== 'checkout') return false;
  if (op.globalOpts || op.hasConfig || op.gitEnv) return false;
  const rest = op.rest ?? [];
  if (rest.includes('--')) return false;
  const flags = rest.filter(a => a.startsWith('-') && a !== '--');
  if (switchCheckoutFlagBlocked(flags)) return false;
  if (switchCheckoutCreateFlag(flags)) return true;
  const plainRefs = rest.filter(a => a && !a.startsWith('-'));
  if (plainRefs.length !== 1) return false;
  const ref = plainRefs[0];
  if (!PLAIN_REF.test(ref) || ref.includes(':')) return false;
  if (refUnsafeForFreeSwitch(ref)) return false;
  if (refExistsAsProjectPath(root, ref)) return false;
  if (!revParseCommitFn(root, ref)) return false;
  return true;
};

const RESTORE_BLOCK_FLAGS = new Set(['-f', '--force', '--staged', '-S', '--worktree', '-W', ...SWITCH_BLOCK_FLAGS]);

const restoreFlagAllowed = (a, rest, i) => {
  if (a === '--source' || a === '-s') return rest[i + 1] !== undefined;
  if (a.startsWith('--source=')) return true;
  return false;
};

const isFreeGitRestorePaths = (op, root) => {
  if (op.globalOpts || op.hasConfig || op.gitEnv) return false;
  const rest = op.rest ?? [];
  let paths = [];
  if (op.sub === 'restore') {
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--' || !a.startsWith('-')) continue;
      if (RESTORE_BLOCK_FLAGS.has(a) || RESTORE_BLOCK_FLAGS.has(a.split('=')[0])) return false;
      if (restoreFlagAllowed(a, rest, i)) {
        if (a === '--source' || a === '-s') i += 1;
        continue;
      }
      return false;
    }
    const dd = rest.indexOf('--');
    if (dd !== -1) paths = rest.slice(dd + 1).filter(a => a && !a.startsWith('-'));
    else {
      for (let i = 0; i < rest.length; i += 1) {
        const a = rest[i];
        if (a === '--source' || a === '-s') { i += 1; continue; }
        if (a.startsWith('--source=')) continue;
        if (!a.startsWith('-')) paths.push(a);
      }
    }
  } else if (op.sub === 'checkout') {
    const dd = rest.indexOf('--');
    if (dd === -1) return false;
    paths = rest.slice(dd + 1).filter(a => a && !a.startsWith('-'));
    const before = rest.slice(0, dd);
    const beforeFlags = before.filter(a => a.startsWith('-'));
    if (switchCheckoutFlagBlocked(beforeFlags)) return false;
    const beforePlain = before.filter(a => a && !a.startsWith('-'));
    if (beforePlain.length > 1) return false;
    for (const a of beforePlain) {
      if (!PLAIN_REF.test(a) || a.includes(':')) return false;
    }
  } else return false;
  if (!paths.length) return false;
  return paths.every(p => isRestoreFreePath(root, p));
};

const GIT_SHOW_MAX = 16 * 1024 * 1024;
const readGitShowBytes = (root, object) => {
  try { return execFileSync('git', ['show', object], { cwd: root, encoding: 'buffer', timeout: 3000, maxBuffer: GIT_SHOW_MAX }); }
  catch { return null; }
};
const readWorkingTreeBytes = (root, rel) => {
  try {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    const inside = insideProject(root, abs);
    if (inside === null) return null;
    return fs.readFileSync(abs);
  } catch { return null; }
};
const carryBytesOk = (root, rel, bytes) => isRoutingPathResolved(root, rel) || AllowRel(rel) || (bytes !== null && isSwarmProducedContent(root, rel, bytes));

const gitAddPaths = (command, root, cwd) => {
  const paths = [];
  for (const words of tokenize(command)) {
    const plain = plainWords(words);
    const gi = plain.findIndex(w => path.basename(w) === 'git');
    if (gi === -1) continue;
    const rest = plain.slice(gi + 1);
    const ai = rest.indexOf('add');
    if (ai === -1) continue;
    const after = rest.slice(ai + 1);
    const ci = after.indexOf('commit');
    const slice = ci === -1 ? after : after.slice(0, ci);
    for (const w of slice) {
      if (w.startsWith('-') || w === '--') continue;
      const rel = insideProject(root, path.isAbsolute(w) ? w : path.resolve(cwd || root, w));
      if (rel) paths.push(rel);
    }
  }
  return paths;
};

const commitCarriedPaths = (command, root, cwd) => {
  const paths = [];
  for (const words of tokenize(command)) {
    const plain = plainWords(words);
    const gi = plain.findIndex(w => path.basename(w) === 'git');
    if (gi === -1) continue;
    const rest = plain.slice(gi + 1);
    const ci = rest.indexOf('commit');
    if (ci === -1) continue;
    const after = rest.slice(ci + 1);
    let skipNext = false;
    for (let i = 0; i < after.length; i += 1) {
      const w = after[i];
      if (skipNext) { skipNext = false; continue; }
      if (w.startsWith('-') && !COMMIT_MSG_OPTS.has(w) && !['-o', '--only', '-i', '--include', '-a', '--all'].includes(w)) {
        if (['-m', '-F', '-C', '-c', '--author', '--date', '--message'].includes(w) || w.includes('=')) skipNext = !w.includes('=');
        continue;
      }
      if (COMMIT_MSG_OPTS.has(w)) { skipNext = true; continue; }
      if (w.startsWith('-')) continue;
      const rel = insideProject(root, path.isAbsolute(w) ? w : path.resolve(cwd || root, w));
      if (rel) paths.push(rel);
    }
  }
  return paths;
};

const pushDiffFiles = root => {
  try {
    return execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 }).split('\n').filter(Boolean);
  } catch { return null; }
};

const ghApiWrite = (command, ops) => {
  if (!ops.some(o => o.tool === 'gh' && String(o.sub ?? '').startsWith('api'))) return false;
  for (const words of tokenize(command)) {
    const gi = words.findIndex(w => path.basename(w) === 'gh');
    if (gi === -1) continue;
    const rest = words.slice(gi + 1);
    if (rest[0] !== 'api') continue;
    for (let i = 1; i < rest.length; i += 1) {
      const w = rest[i];
      if (w === '-X' || w === '--method') {
        const m = String(rest[i + 1] ?? 'GET').toUpperCase();
        if (WRITE_HTTP.has(m)) return true;
      } else if (w.startsWith('--method=')) {
        if (WRITE_HTTP.has(w.slice(9).toUpperCase())) return true;
      } else if (WRITE_HTTP.has(String(w).toUpperCase()) && (rest[i - 1] === '-X' || rest[i - 1] === '--method')) {
        return true;
      }
    }
    return false;
  }
  return false;
};

export const STATE_FILE = '.swarm/handbuild/state.json';
export const LOG_FILE = '.swarm/handbuild/log.ndjson';
export const OFF_FILE = '.swarm/handbuild/off';
export { ORCHESTRATOR_MODE_OFF_FILE, ORCHESTRATOR_MODE_RULE_ID, ORCHESTRATOR_MODE_DENY_REASON, orchestratorModeEnabled } from './shell-writes.mjs';
export const MAX_MINUTES = 120;
export const DEFAULT_MINUTES = 30;
export const MAX_FILES = 20;
export const PENDING_MS = 24 * 60 * 60 * 1000;

/** The only valid reasons. Anything else: write a ticket instead. */
export const REASON_KINDS = Object.freeze({
  'swarm-cannot': 'the swarm cannot run it (no lane can do the work, or the swarm itself is what is broken)',
  emergency: 'an emergency fix to something live, where waiting for a ticket costs more than the hand-build',
  secret: 'it handles a secret or credential, which no worker may see',
  tiny: 'a change of under 5 lines that the swarm is blocked from making',
});
export const KIND_LIST = Object.keys(REASON_KINDS);
export const DENY_ADVICE = 'Hand-building is not allowed here: write a ticket instead (swarm tickets, swarm scope). If a valid reason applies, ask the owner: swarm handbuild request --kind <swarm-cannot|emergency|secret|tiny> --reason "why the swarm cannot do it" --files "src/a.ts,src/b.ts" --minutes 30';

const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const safeDir = root => { const d = path.join(root, '.swarm', 'handbuild'); if (isLink(path.join(root, '.swarm')) || isLink(d)) throw Error('handbuild-path-unsafe'); fs.mkdirSync(d, { recursive: true }); return d; };
const cleanText = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function pruneMerges(state, now) {
  if (!state.merges || typeof state.merges !== 'object' || Array.isArray(state.merges)) { state.merges = {}; return; }
  for (const [k, exp] of Object.entries(state.merges)) if (!Number.isFinite(exp) || exp <= now) delete state.merges[k];
}

export function readState(root) {
  try {
    const file = path.join(root, STATE_FILE);
    if (isLink(file)) return { version: 1, requests: {}, merges: {} };
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = state && typeof state === 'object' && state.requests && typeof state.requests === 'object' && !Array.isArray(state.requests) ? state : { version: 1, requests: {} };
    if (!base.merges || typeof base.merges !== 'object' || Array.isArray(base.merges)) base.merges = {};
    return base;
  } catch { return { version: 1, requests: {}, merges: {} }; }
}

/** Owner typed `merge #N` in chat: allows one `gh pr merge N` / `swarm merge N` without a hand-build approval naming merge. */
export function recordChatMerge(root, pr, { now = Date.now } = {}) {
  const n = Number(String(pr ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 1) return;
  withStateLock(root, () => {
    const state = readState(root);
    pruneMerges(state, now());
    state.merges[String(n)] = now() + CHAT_MERGE_MS;
    writeState(root, state);
  });
}

function peekChatMerge(root, pr, now) {
  const key = String(pr ?? '').replace(/^#/, '');
  if (!/^\d+$/.test(key)) return false;
  const state = readState(root);
  pruneMerges(state, now);
  const exp = state.merges?.[key];
  return Number.isFinite(exp) && exp > now;
}

function tryConsumeChatMerge(root, pr, now) {
  const key = String(pr ?? '').replace(/^#/, '');
  if (!/^\d+$/.test(key)) return false;
  return withStateLock(root, () => {
    const state = readState(root);
    pruneMerges(state, now);
    const exp = state.merges?.[key];
    if (!Number.isFinite(exp) || exp <= now) return false;
    delete state.merges[key];
    writeState(root, state);
    return true;
  });
}

const requestElevated = r => (r?.git ?? []).some(g => ELEVATED_GIT_OPS.includes(g));
// One writer at a time: the lock file is created exclusively (a stale one, from a process that died, is taken over after 10 seconds), and the state is read again under it.
function withStateLock(root, fn) {
  const dir = safeDir(root);
  const lock = path.join(dir, 'state.lock');
  const started = Date.now();
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx', 0o600); fs.closeSync(fd); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { force: true }); } catch { /* gone */ }
      if (Date.now() - started > 5000) throw Error('handbuild-busy: another hand-build command is writing the state; try again');
      const until = Date.now() + 20; while (Date.now() < until) { /* a short wait */ }
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}
function writeState(root, state) {
  const dir = safeDir(root);
  const temp = path.join(dir, `state.json.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, path.join(dir, 'state.json'));
}

/** One line to the guard's own log and one to the project journal (an `action` event), written synchronously: the guard runs inside a hook. Never throws. */
export function logAction(root, entry, { now = Date.now } = {}) {
  const at = new Date(now()).toISOString();
  try {
    const dir = safeDir(root);
    const fd = fs.openSync(path.join(dir, 'log.ndjson'), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, `${JSON.stringify({ at, ...entry })}\n`); } finally { fs.closeSync(fd); }
  } catch { /* the journal line below still tries */ }
  try {
    const dir = path.join(root, '.swarm', 'project');
    if (isLink(path.join(root, '.swarm')) || isLink(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    const line = { ts: at, kind: 'action', action: `handbuild-${entry.event}`, ...Object.fromEntries(Object.entries({ id: entry.id, by: entry.by, tool: entry.tool, files: entry.files, reason: entry.reason }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.map(x => cleanText(x, 120)).slice(0, 20) : cleanText(v, 300)])) };
    const fd = fs.openSync(path.join(dir, 'journal.ndjson'), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(line)}\n`); } finally { fs.closeSync(fd); }
  } catch { /* best effort */ }
}

// ---- file patterns ---------------------------------------------------------------------------------------------------------------------------

const toRegExp = pattern => {
  const p = pattern.replace(/^\.\//, '');
  if (p.endsWith('/')) return new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '*' && p[i + 1] === '*') { out += '.*'; i += 1; }
    else if (p[i] === '*') out += '[^/]*';
    else out += p[i].replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};
export const matchesFile = (patterns, rel) => (patterns ?? []).some(p => toRegExp(String(p)).test(rel));

// ---- the request -> approve flow ---------------------------------------------------------------------------------------------------------------

function newId(now) { return `hb-${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

/** Validates and stores a pending request. Throws an Error with a plain message for anything invalid (including a reason that is not on the list). */
export function createRequest(root, { kind, reason, files, minutes, git }, { now = Date.now, by = 'orchestrator' } = {}) {
  if (!KIND_LIST.includes(kind)) throw Error(`handbuild-kind: --kind must be one of ${KIND_LIST.join(', ')}. ${KIND_LIST.map(k => `${k}: ${REASON_KINDS[k]}`).join('; ')}. Anything else: write a ticket instead.`);
  const why = cleanText(reason, 400);
  if (why.length < 10) throw Error('handbuild-reason: --reason must say why the swarm cannot do it (at least 10 characters)');
  const list = (Array.isArray(files) ? files : String(files ?? '').split(',')).map(f => cleanText(f, 200)).filter(Boolean);
  if (!list.length) throw Error('handbuild-files: --files must name the files (comma separated)');
  if (list.length > MAX_FILES) throw Error(`handbuild-files: at most ${MAX_FILES} files per request`);
  for (const f of list) {
    const segments = f.replace(/\/$/, '').split('/');
    const last = segments[segments.length - 1];
    const wildcard = /[*?[{]/;
    if (path.isAbsolute(f) || segments.includes('..') || f.includes('**') || f === '.' || f === '.git' || segments.slice(0, -1).some(g => wildcard.test(g)) || (wildcard.test(last) && (!/\.\w+$/.test(last) || f.endsWith('/') || segments.length < 2)) || (f.endsWith('/') && segments.length < 2)) throw Error(`handbuild-files: ${f} is not specific enough (name files, or a folder at least two levels deep, or a *.ext pattern inside a folder; a catch-all or a whole top-level folder is not a request)`);
    if (isProtected(f.replace(/\/$/, '')) || f.replace(/\/$/, '').toLowerCase() === '.git') throw Error(`handbuild-files: ${f} belongs to the owner (the guard's own state and settings, and .git); it cannot be requested`);
  }
  const mins = minutes === undefined ? DEFAULT_MINUTES : Number(minutes);
  if (!Number.isInteger(mins) || mins < 1 || mins > MAX_MINUTES) throw Error(`handbuild-minutes: --minutes must be a whole number from 1 to ${MAX_MINUTES}`);
  const ops = (Array.isArray(git) ? git : String(git ?? '').split(',')).map(g => g.trim()).filter(Boolean);
  for (const g of ops) if (!GIT_REQUEST_OPS.includes(g)) throw Error(`handbuild-git: --git must name one of ${GIT_REQUEST_OPS.join(', ')}`);
  return withStateLock(root, () => {
  const state = readState(root);
  const id = newId(now());
  state.requests[id] = { id, kind, reason: why, files: list, git: ops, minutes: mins, status: 'pending', requestedAt: new Date(now()).toISOString(), requestedBy: cleanText(by, 40) };
  // Old finished requests are dropped so the file stays small.
  const done = Object.values(state.requests).filter(r => r.status !== 'pending' && r.status !== 'approved').sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  for (const r of done.slice(0, Math.max(0, done.length - 50))) delete state.requests[r.id];
  writeState(root, state);
  logAction(root, { event: 'request', id, by, files: list, reason: `${kind}: ${why}` }, { now });
  return state.requests[id];
  });
}

/** Owner-facing `swarm handbuild request` in a scratch project: stored denied, never queued for Needs you. */
export function createScratchDeniedHandbuildRequest(root, fields, { now = Date.now, by = 'orchestrator' } = {}) {
  if (!KIND_LIST.includes(fields.kind)) throw Error(`handbuild-kind: --kind must be one of ${KIND_LIST.join(', ')}.`);
  const why = cleanText(fields.reason, 400);
  if (why.length < 10) throw Error('handbuild-reason: --reason must say why the swarm cannot do it (at least 10 characters)');
  const list = (Array.isArray(fields.files) ? fields.files : String(fields.files ?? '').split(',')).map(f => cleanText(f, 200)).filter(Boolean);
  if (!list.length) throw Error('handbuild-files: --files must name the files (comma separated)');
  const mins = fields.minutes === undefined ? DEFAULT_MINUTES : Number(fields.minutes);
  const ops = (Array.isArray(fields.git) ? fields.git : String(fields.git ?? '').split(',')).map(g => g.trim()).filter(Boolean);
  return withStateLock(root, () => {
    const state = readState(root);
    const id = newId(now());
    const at = new Date(now()).toISOString();
    const row = {
      id,
      kind: fields.kind,
      reason: why,
      files: list,
      git: ops,
      minutes: mins,
      status: 'denied',
      denyReason: SCRATCH_DENY_REASON,
      requestedAt: at,
      requestedBy: cleanText(by, 40),
      decidedAt: at,
      decidedBy: 'scratch',
    };
    state.requests[id] = row;
    writeState(root, state);
    logAction(root, { event: 'request', id, by, files: list, reason: `${fields.kind}: ${why}` }, { now });
    return row;
  });
}

/** approve | deny a pending request. An approval runs for `minutes` from now and covers only the files (and git operations) it names. */
export function decideRequest(root, id, choice, { now = Date.now, by = 'owner', channel, policyRule, approvalMinutes } = {}) {
  return withStateLock(root, () => {
  const state = readState(root);
  const r = state.requests[id];
  if (!r) throw Error(`handbuild-unknown: no hand-build request ${id}`);
  if (r.status !== 'pending') throw Error(`handbuild-not-pending: ${id} is already ${r.status}`);
  if (now() - Date.parse(r.requestedAt) > PENDING_MS) { r.status = 'expired'; writeState(root, state); throw Error(`handbuild-expired: ${id} waited more than 24 hours and expired; ask again if it is still needed`); }
  if (!['approve', 'deny'].includes(choice)) throw Error('handbuild-choice: approve or deny');
  if (choice === 'approve' && requestElevated(r) && channel !== 'computer') {
    throw Error('handbuild-computer-only: merge, deploy, force-push and branch -D need the owner at the computer (swarm decide), not from the phone or board');
  }
  r.status = choice === 'approve' ? 'approved' : 'denied';
  r.decidedAt = new Date(now()).toISOString();
  r.decidedBy = cleanText(by, 40);
  if (choice === 'approve') {
    const mins = Number.isInteger(approvalMinutes) && approvalMinutes >= 1 && approvalMinutes <= MAX_MINUTES
      ? approvalMinutes
      : r.minutes;
    r.expiresAt = new Date(now() + mins * 60000).toISOString();
  }
  writeState(root, state);
  const ruleNote = typeof policyRule === 'string' && policyRule ? `policy ${policyRule}` : '';
  const approveReason = choice === 'approve'
    ? [ruleNote, `until ${r.expiresAt}`].filter(Boolean).join(' ')
    : '';
  logAction(root, { event: choice === 'approve' ? 'approve' : 'deny', id, by, files: r.files, reason: approveReason }, { now });
  return r;
  });
}

/** Policy pass apply helper: same approval record as owner approve, with optional capped minutes and rule id in the log. */
export function applyHandbuildPolicyApproval(root, item, { now = Date.now, policyRule, policyFacts, approvalMinutes } = {}) {
  const ref = String(item?.id ?? '');
  const hbId = ref.startsWith('handbuild-') ? ref.slice('handbuild-'.length) : ref;
  return decideRequest(root, hbId, 'approve', {
    now,
    by: 'policy',
    channel: 'policy',
    policyRule,
    approvalMinutes,
  });
}

export function listRequests(root) { return Object.values(readState(root).requests).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt))); }

/** The live approvals (approved and not expired). */
export function activeApprovals(root, now = Date.now()) { return listRequests(root).filter(r => r.status === 'approved' && Date.parse(r.expiresAt) > now); }

// ---- the decision ----------------------------------------------------------------------------------------------------------------------------

// The approval state is the owner's: no approval covers a write to it, to the guard's log, or to the hooks' own settings, and an orchestrator session cannot run the approval commands.
export const PROTECTED = Object.freeze(['.swarm/handbuild', '.claude/settings.local.json', '.claude/settings.json', '.git/']);
// Compared in lower case (the usual macOS volume is case-insensitive), and the folders that contain the guard's state are protected too, not only the files in them.
const isSwarmRunRecord = rel => { const r = rel.toLowerCase(); return r === '.swarm/runs' || r.startsWith('.swarm/runs/'); };
const resolveCmdPath = (raw, root, cwd) => {
  if (!raw || raw.startsWith('-')) return null;
  const p = path.isAbsolute(raw) ? raw : path.resolve(cwd || root, raw);
  return insideProject(root, p);
};
const orchestratorSwarmRunWrites = (command, root, cwd) => {
  const out = new Set();
  for (const words of tokenize(command)) {
    for (let i = 0; i < words.length; i += 1) {
      if (['>', '>>', '>|', '>&', '&>'].includes(words[i]) && words[i + 1] !== undefined && !/^&?\d+$/.test(words[i + 1])) {
        const rel = resolveCmdPath(words[i + 1], root, cwd);
        if (rel) out.add(rel);
      }
    }
    const plain = plainWords(words);
    const cmd = plain.find(w => ['sed', 'tee', 'cp', 'mv', 'rm', 'touch', 'truncate', 'chmod', 'chown', 'install', 'ln'].includes(w));
    if (!cmd) continue;
    const ci = plain.indexOf(cmd);
    const args = plain.slice(ci + 1);
    if (cmd === 'sed') {
      const inPlace = args.some(a => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='));
      if (!inPlace) continue;
      for (const w of args) {
        if (w && !w.startsWith('-')) { const rel = resolveCmdPath(w, root, cwd); if (rel) out.add(rel); }
      }
    } else if (cmd === 'tee') {
      for (const w of args.filter(a => a && !a.startsWith('-'))) { const rel = resolveCmdPath(w, root, cwd); if (rel) out.add(rel); }
    } else if (['cp', 'mv', 'install', 'ln'].includes(cmd)) {
      const ops = args.filter(a => a && !a.startsWith('-'));
      if (ops.length) { const rel = resolveCmdPath(ops[ops.length - 1], root, cwd); if (rel) out.add(rel); }
    } else {
      for (const w of args.filter(a => a && !a.startsWith('-'))) { const rel = resolveCmdPath(w, root, cwd); if (rel) out.add(rel); }
    }
  }
  return [...out].filter(isSwarmRunRecord);
};
const isProtected = rel => { const r = rel.toLowerCase(); return r === '.swarm' || r === '.claude' || isSwarmRunRecord(r) || PROTECTED.some(p => r === p || r.startsWith(p.endsWith('/') ? p : `${p}/`)); };
const swarmRecordReason = rel => `Hand-build guard: ${rel} is swarm run state (only swarm commands may write it); no approval covers it.`;
// Outside the checkout too: the install (the guard's own scripts) and the user's own Claude settings could switch the hooks off.
export const protectedAbsolute = (home = os.homedir()) => [path.join(home, '.project-swarm'), path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json'), ...(process.env.SWARM_INSTALL_DIR ? [process.env.SWARM_INSTALL_DIR] : [])];
const underAbs = (abs, list) => list.some(prefix => abs === prefix || abs.startsWith(`${prefix}/`));
const AllowRel = rel => { const r = rel.toLowerCase(); return ORCHESTRATOR_OWN.some(prefix => r === prefix.slice(0, -1) || r.startsWith(prefix)) || TOOL_DIRS.some(prefix => r === prefix.slice(0, -1) || r.startsWith(prefix)); };

/** { allow, reason, files, approval } for one tool call. `input` is the hook input (tool_name, tool_input, cwd). */
const policyOpDenyLabel = (policyGitOps, command, policyOps) => {
  const op0 = policyGitOps[0];
  if (op0 === 'gh-api-write' || (op0 === 'gh' && ghApiWrite(command, policyOps))) return 'gh api write';
  if (op0 === 'gh') return 'gh';
  return `git ${op0}`;
};

const ORCHESTRATOR_MODE_PRESERVE_DENY = new Set([
  HANDBUILD_SELF_APPROVAL_RULE_ID,
  'handbuild-owner-verb',
  'handbuild-change-record',
]);

export function guardDecision({ tool, toolInput, root, cwd, now = Date.now, home, branchOf: branchOfFn = branchOf, revParseCommit: revParseCommitFn = revParseCommit } = {}) {
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const h = home ?? os.homedir();
  const omActive = orchestratorModeEnabled(root, cwd);
  const omDeny = (files = []) => ({ allow: false, files, reason: ORCHESTRATOR_MODE_DENY_REASON, ruleId: ORCHESTRATOR_MODE_RULE_ID });
  const applyOrchestratorMode = decision => {
    if (!omActive || tool !== 'Bash') return decision;
    if (decision.allow) {
      if (decision.approval) return decision;
      if (orchestratorModeCommandAllowed(ti.command, { root, cwd })) return decision;
      return omDeny(decision.files ?? []);
    }
    if (ORCHESTRATOR_MODE_PRESERVE_DENY.has(decision.ruleId)) return decision;
    if (decision.reason?.startsWith('Hand-build guard:') && /belongs to the owner|session transcripts|swarm run state|deletes outside|too large|force push to a protected branch/.test(decision.reason)) {
      return decision;
    }
    if (decision.reason === GH_PR_MERGE_BLOCKED || decision.reason === MERGE_BLOCKED_REASON) return decision;
    if (decision.reason?.includes(DENY_ADVICE)) return decision;
    if (!orchestratorModeCommandAllowed(ti.command, { root, cwd })) return omDeny(decision.files ?? []);
    return decision;
  };
  const approvals = activeApprovals(root, now());
  const produced = swarmProducedFiles(root);
  const stagedCarryOk = rel => carryBytesOk(root, rel, readGitShowBytes(root, `:${rel}`));
  const headCarryOk = rel => carryBytesOk(root, rel, readGitShowBytes(root, `HEAD:${rel}`));
  const workingCarryOk = rel => carryBytesOk(root, rel, readWorkingTreeBytes(root, rel));
  const writeFree = rel => AllowRel(rel) || isRoutingPathResolved(root, rel);
  const approvalGitOp = op => {
    if (op === 'swarm-merge') return 'merge';
    if (op === 'gh-api-write') return 'gh';
    return op;
  };
  const covers = (rels, gitOps = []) => {
    // every file and every git operation must be covered by one live approval
    for (const rel of rels) if (!approvals.some(a => matchesFile(a.files, rel))) return { ok: false, missing: rel };
    const gitCovered = op => approvals.some(a => a.git.includes(approvalGitOp(op)) || (op === 'add' && a.git.includes('commit')));
    for (const op of gitOps) if (!gitCovered(op)) return { ok: false, missing: `git ${approvalGitOp(op)}` };
    const used = approvals.find(a => rels.some(rel => matchesFile(a.files, rel)) || gitOps.some(op => gitCovered(op)));
    return { ok: true, approval: used?.id };
  };
  if (WRITE_TOOLS.includes(tool)) {
    const raw0 = ti.file_path ?? ti.notebook_path ?? ti.path;
    // a relative path means relative to the folder the session is in
    const raw = typeof raw0 === 'string' && raw0 && !path.isAbsolute(raw0) ? path.resolve(cwd || root, raw0) : raw0;
    const rel = insideProject(root, raw);
    const absRaw = typeof raw === 'string' && raw ? path.resolve(path.isAbsolute(raw) ? raw : path.join(cwd || root, raw)) : null;
    if (rel === null && absRaw && isClaudeProjectTranscriptAbs(absRaw, h)) return { allow: false, files: [], reason: `Hand-build guard: ${raw} belongs to the owner (session transcripts under .claude/projects); no approval covers it.` };
    if (rel === null && typeof raw === 'string' && raw && underAbs(absRaw, protectedAbsolute(h)) && !isClaudeMemoryPathOutside(absRaw, h)) return { allow: false, files: [], reason: `Hand-build guard: ${raw} belongs to the owner (the swarm install and the user's Claude settings hold the guard itself); no approval covers it.` };
    if (rel !== null && isSwarmRunRecord(rel)) return { allow: false, files: [rel], reason: swarmRecordReason(rel) };
    if (rel !== null && isProtected(rel)) return { allow: false, files: [rel], reason: `Hand-build guard: ${rel} belongs to the owner (approvals and the guard's own settings); no approval covers it.` };
    if (rel === null || AllowRel(rel)) return { allow: true };
    if (rel !== null && isRoutingPathResolved(root, rel)) return { allow: true, files: [rel] };
    if (rel !== null && produced.has(rel)) {
      const c = covers([rel]);
      return c.ok ? { allow: true, files: [rel], approval: c.approval } : { allow: false, files: [rel], reason: `${DENY_ADVICE} (blocked: ${tool} ${rel})` };
    }
    const c = covers([rel]);
    return c.ok ? { allow: true, files: [rel], approval: c.approval } : { allow: false, files: [rel], reason: `${DENY_ADVICE} (blocked: ${tool} ${rel})` };
  }
  if (tool === 'Bash') {
    const finishBash = decision => applyOrchestratorMode(decision);
    const a = analyzeShell(ti.command, { root, cwd, home: h, protectedAbs: protectedAbsolute(h) });
    const current = branchOfFn(root);
    const protBranch = isProtectedBranch(current);
    const handbuildPol = handbuildShellPolicy(ti.command);
    if (handbuildPol.applies && !handbuildPol.allow) {
      return finishBash({ allow: false, files: [], reason: handbuildPol.reason, ruleId: handbuildPol.ruleId });
    }
    const changePol = swarmChangeShellPolicy(ti.command);
    if (changePol.applies && !changePol.allow) {
      return finishBash({ allow: false, files: [], reason: changePol.reason, ruleId: changePol.ruleId });
    }
    if (changePol.applies && changePol.allow) {
      return finishBash({ allow: true });
    }
    if (handbuildPol.applies && handbuildPol.allow
      && !a.writes.length && !a.git.length && !a.inline && !a.protectedOutside.length && !(a.outsideDeletes?.length)) {
      return finishBash({ allow: true });
    }
    if (!handbuildPol.applies && isSelfApprovalCommand(ti.command)) {
      return finishBash({ allow: false, files: [], reason: SELF_APPROVAL_REASON, ruleId: HANDBUILD_SELF_APPROVAL_RULE_ID });
    }
    const transcriptHits = bashTranscriptWrites(ti.command, h);
    if (transcriptHits.length) return finishBash({ allow: false, files: [], reason: `Hand-build guard: ${transcriptHits[0]} belongs to the owner (session transcripts under .claude/projects); no approval covers it.` });
    if (a.protectedOutside.length) return finishBash({ allow: false, files: [], reason: `Hand-build guard: ${a.protectedOutside.join(', ')} belongs to the owner (the swarm install and the user's Claude settings hold the guard itself); no approval covers it.` });
    const swarmRunWrites = [...new Set([...a.writes.filter(isSwarmRunRecord), ...orchestratorSwarmRunWrites(ti.command, root, cwd)])];
    if (swarmRunWrites.length) return finishBash({ allow: false, files: [...a.writes, ...swarmRunWrites], reason: swarmRecordReason(swarmRunWrites[0]) });
    if (a.writes.some(isProtected)) return finishBash({ allow: false, files: a.writes, reason: `Hand-build guard: ${a.writes.filter(isProtected).join(', ')} belongs to the owner (approvals and the guard's own settings); no approval covers it.` });
    if (a.outsideDeletes?.length && !a.outsideDeletes.every(p => allowedOutsideDelete(p, h))) {
      return finishBash({ allow: false, files: [], reason: 'Hand-build guard: deletes outside the scratchpad are the owner\'s.' });
    }
    const policyOps = buildPolicyOps(ti.command);
    const gitEnvCmd = commandHasGitEnv(ti.command);
    if (gitEnvCmd) {
      for (const op of policyOps) {
        if (op.tool === 'git') op.gitEnv = true;
      }
    }
    const policyGitOps = [];
    let commitStagedCheck = null;
    let pushNeedsCarryCheck = false;
    const chatMergeCandidates = [];
    let standingMergeAllow = false;
    for (const op of policyOps) {
      if (op.opaque) { policyGitOps.push('commit'); continue; }
      if (op.tool === 'git') {
        if (op.sub === 'fetch') {
          if (!isFreeGitFetch(op, root)) policyGitOps.push('config');
          continue;
        }
        if (READ_GIT_SUBS.has(op.sub)) {
          if (!isFreeReadGit(op)) policyGitOps.push(op.sub === 'diff' && (op.flags ?? []).some(f => f.startsWith('--output')) ? 'output' : 'config');
          continue;
        }
        if (isReadOnlyGitSub(op.sub, op.rest ?? [])) continue;
        if (op.sub === 'branch') {
          if (op.delete === 'safe') continue;
          policyGitOps.push('branch-D');
          continue;
        }
        if (op.sub === 'rebase') {
          if (!isFreeGitRebase(op, protBranch)) policyGitOps.push('commit');
          continue;
        }
        if (op.sub === 'merge') { policyGitOps.push('merge'); continue; }
        if (op.sub === 'push') {
          const pos = op.args ?? [];
          const flags = op.flags ?? [];
          const refspecs = op.refspecs ?? [];
          const deletePush = op.delete === 'remote' || refspecs.some(r => r.delete) || flags.includes('--mirror') || flags.includes('--prune');
          const forceOnProtected = (op.force || refspecs.some(r => r.force)) && (isProtectedBranch(current) || refspecs.some(r => protectedBranchName(r.dst)) || (pos.length >= 2 && protectedBranchName(pos[1])));
          if (pushBlockedOnProtected(pos, op.force || deletePush) || (deletePush && pushBlockedOnProtected(pos, true)) || forceOnProtected) {
            return finishBash({ allow: false, files: [], reason: 'Hand-build guard: force push to a protected branch (main or master) is never approvable, even with a hand-build approval that names force-push.' });
          }
          if (op.force || refspecs.some(r => r.force)) { policyGitOps.push('force-push'); continue; }
          if (deletePush || flags.includes('--mirror') || flags.includes('--prune')) { policyGitOps.push('push'); continue; }
          if (isFreeGitPush(op, current, root)) {
            pushNeedsCarryCheck = true;
            continue;
          }
          policyGitOps.push('push');
          continue;
        }
        if (op.sub === 'commit') {
          if (protBranch || op.globalOpts || op.hasConfig || op.gitEnv) policyGitOps.push('commit');
          else commitStagedCheck = 'allowlist';
          continue;
        }
        if (op.sub === 'add') {
          if (op.globalOpts || op.gitEnv) policyGitOps.push('add');
          continue;
        }
        if (op.sub === 'switch' || op.sub === 'checkout') {
          if (isFreeGitSwitchCheckout(op, root, revParseCommitFn) || isFreeGitRestorePaths(op, root)) continue;
        }
        if (op.sub === 'restore') {
          if (isFreeGitRestorePaths(op, root)) continue;
        }
        if (op.sub) policyGitOps.push(op.sub);
      } else if (op.tool === 'gh') {
        if (op.sub === 'pr merge' || op.ghPrMerge) {
          policyGitOps.push('gh-pr-merge');
          continue;
        }
        if (isFreeReadOnlyGh(op, ti.command)) continue;
        policyGitOps.push('gh');
      } else if (op.tool === 'vercel') {
        if (isFreeVercel(op)) continue;
        policyGitOps.push('deploy');
      } else if (op.tool === 'swarm') {
        if (op.sub === 'merge') {
          if (isStandingSwarmMerge(op, h)) {
            standingMergeAllow = true;
            continue;
          }
          chatMergeCandidates.push(op.target);
          policyGitOps.push('swarm-merge');
        }
      }
    }
    if (ghApiWrite(ti.command, policyOps) && !policyGitOps.includes('gh')) policyGitOps.push('gh');
    if (policyGitOps.includes('gh-pr-merge')) {
      return finishBash({ allow: false, files: [], reason: GH_PR_MERGE_BLOCKED });
    }
    const mergeOps = policyOps.filter(o => o.tool === 'swarm' && o.sub === 'merge');
    const chatMergeOk = !commandHasGhRepoFlag(ti.command) && mergeOps.length === 1 && mergeOps[0].target && peekChatMerge(root, mergeOps[0].target, now());
    if (chatMergeOk) {
      for (let i = policyGitOps.length - 1; i >= 0; i -= 1) if (policyGitOps[i] === 'swarm-merge') policyGitOps.splice(i, 1);
    }
    if (policyGitOps.length && !covers([], policyGitOps).ok) {
      if (policyGitOps.includes('swarm-merge')) {
        return finishBash({ allow: false, files: [], reason: MERGE_BLOCKED_REASON });
      }
      const label = policyOpDenyLabel(policyGitOps, ti.command, policyOps);
      return finishBash({ allow: false, files: [], reason: `${DENY_ADVICE} (blocked: ${label})` });
    }
    const finishAllow = result => {
      if (chatMergeOk && mergeOps[0]?.target) tryConsumeChatMerge(root, mergeOps[0].target, now());
      const out = standingMergeAllow ? { ...result, standing: 'merge-swarm-pr' } : result;
      return finishBash(out);
    };
    if (!writesAnything(a)) {
      const gitCover = policyGitOps.length ? covers([], policyGitOps) : null;
      return finishAllow(gitCover?.ok && gitCover.approval ? { allow: true, approval: gitCover.approval } : { allow: true });
    }
    if (a.dynamic || a.inline || a.unknown) {
      const need = [a.dynamic ? 'a dynamic shell command' : null, a.inline ? 'an inline script that writes files' : null, a.unknown ? 'a write whose target is a variable or substitution' : null].filter(Boolean).join(' and ');
      return finishBash({ allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: ${need}; the guard cannot tell what it writes, so it needs an approval that names the files, or a ticket)` });
    }
    let staged = [];
    const commitPathspecs = commitCarriedPaths(ti.command, root, cwd);
    const hasCommit = policyOps.some(o => o.tool === 'git' && o.sub === 'commit') || a.git.includes('commit');
    if (hasCommit) {
      const added = [];
      let everything = false;
      for (const words of tokenize(ti.command)) {
        const gi = words.findIndex(w => path.basename(w) === 'git');
        if (gi === -1) continue;
        const rest = words.slice(gi + 1);
        const ai = rest.indexOf('add');
        const ci = rest.indexOf('commit');
        const list = ai !== -1 ? rest.slice(ai + 1, ci === -1 ? undefined : ci) : ci !== -1 && rest.includes('--') ? rest.slice(rest.indexOf('--') + 1) : [];
        for (const w of list) {
          if (['-A', '--all', '-u', '--update', '.', ':/', '-p', '--patch', '-i', '--interactive'].includes(w) || /[*?[{]/.test(w)) everything = true;
          else if (!w.startsWith('-') && w !== '--') { const rel = insideProject(root, path.isAbsolute(w) ? w : path.resolve(cwd || root, w)); if (rel) added.push(rel); }
        }
      }
      if (everything) return finishBash({ allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: a git add of everything, or of a pattern, cannot be checked against an approval; add the approved files by name)` });
      staged.push(...added);
      const all = /\bcommit\b[^;&|]*\s-[A-Za-z]*a|--all\b/.test(String(ti.command ?? ''));
      try { staged = [...staged, ...execFileSync('git', ['diff', all ? '--name-only' : '--cached', ...(all ? ['HEAD'] : ['--name-only'])], { cwd: root, encoding: 'utf8', timeout: 3000 }).split('\n').filter(Boolean)]; }
      catch { return finishBash({ allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: git commit, and the guard could not read which files it would carry)` }); }
      staged.push(...commitPathspecs);
      if (commitStagedCheck === 'allowlist' && staged.length && staged.every(stagedCarryOk)) {
        /* fall through: same-line writes and other git ops must still pass */
      }
      if (commitStagedCheck === 'allowlist' && staged.some(f => !stagedCarryOk(f))) {
        policyGitOps.push('commit');
      }
    }
    if (pushNeedsCarryCheck && !protBranch) {
      const carried = pushDiffFiles(root);
      if (carried === null || carried.some(f => !headCarryOk(f))) policyGitOps.push('push');
    }
    const explicitAdds = gitAddPaths(ti.command, root, cwd);
    const addNeedsApproval = explicitAdds.filter(f => !workingCarryOk(f));
    if (addNeedsApproval.length) policyGitOps.push('add');
    const scratchDests = mvScratchpadDests(ti.command, { root, cwd, home: h });
    const mvUntrackedFree = mvUntrackedSourcesToScratchpad(ti.command, { root, cwd, home: h });
    const mvApprovals = mvTrackedSourcesNeedingApproval(ti.command, { root, cwd, home: h }, produced);
    const needsFileApproval = a.writes.filter(w => !writeFree(w) && !scratchDests.has(w) && !mvUntrackedFree.has(w));
    const fileRels = [...new Set([...needsFileApproval, ...mvApprovals, ...staged.filter(f => !stagedCarryOk(f)), ...addNeedsApproval])];
    if (policyGitOps.length) {
      const c = covers(fileRels, policyGitOps);
      if (c.ok) return finishAllow({ allow: true, files: [...a.writes, ...staged], approval: c.approval });
      if (policyGitOps.includes('swarm-merge')) {
        return finishBash({ allow: false, files: a.writes, reason: MERGE_BLOCKED_REASON });
      }
      const label = policyOpDenyLabel(policyGitOps, ti.command, policyOps);
      return finishBash({ allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: ${label})` });
    }
    const residualGit = a.git.filter(g => {
      if (policyOps.some(o => o.tool === 'git' && o.sub === g && isReadOnlyGitSub(o.sub, o.rest ?? []))) return false;
      if (g === 'rebase' && policyOps.some(o => o.tool === 'git' && o.sub === 'rebase' && isFreeGitRebase(o, protBranch))) return false;
      if (g === 'push' && policyOps.some(o => o.tool === 'git' && o.sub === 'push' && isFreeGitPush(o, current, root))) return false;
      if (g === 'branch' && policyOps.some(o => o.tool === 'git' && o.sub === 'branch' && (o.delete === 'safe' || isReadOnlyGitSub('branch', o.rest ?? [])))) return false;
      if (g === 'commit' && commitStagedCheck === 'allowlist' && staged.length && staged.every(stagedCarryOk)) return false;
      if (['switch', 'checkout', 'restore'].includes(g) && policyOps.some(o => o.tool === 'git' && (isFreeGitSwitchCheckout(o, root, revParseCommitFn) || isFreeGitRestorePaths(o, root)))) return false;
      return true;
    });
    if (!fileRels.length && !residualGit.length) return finishAllow({ allow: true, files: [...a.writes, ...staged] });
    if (a.writes.length && a.writes.every(w => writeFree(w) || scratchDests.has(w) || mvUntrackedFree.has(w)) && !mvApprovals.length && !residualGit.length) return finishAllow({ allow: true, files: a.writes });
    const c = covers(fileRels, residualGit);
    if (c.ok) return finishAllow({ allow: true, files: [...a.writes, ...staged], approval: c.approval });
    return finishBash({ allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: ${[...fileRels.map(w => `writes ${w}`), ...residualGit.map(g => `git ${g}`)].join(', ')})` });
  }
  return { allow: true };
}
