// SPDX-License-Identifier: Apache-2.0
// Frozen in-code policy for hand-build auto-approve (not writable by agents). Evaluated from normalized requests and live git state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isScratchRoot } from './scratch-roots.mjs';

export const POLICY_ID = 'swarm-admin-handbuild';
export const POLICY_VERSION = 1;
export const AUTO_OFF_FILE = '.swarm/handbuild/auto-off';
export const STATS_FILE = '.swarm/handbuild/stats.json';
export const MAX_POLICY_MINUTES = 60;
export const MAX_POLICY_FILES = 20;

const norm = p => String(p).replace(/\\/g, '/');
const normBranch = b => String(b ?? '').replace(/^refs\/heads\//, '');
const isProtectedBranch = b => {
  const n = normBranch(b);
  return n === 'main' || n === 'master' || n === 'HEAD';
};

const BRANCH_SWARM = /^swarm\/[A-Za-z0-9._/-]+$/;
const BRANCH_PREFIX = /^(?:feat|fix|docs|chore)\//;

export function policyBranchAllowed(branch) {
  const b = normBranch(branch);
  if (!b || isProtectedBranch(b)) return false;
  return BRANCH_SWARM.test(b) || BRANCH_PREFIX.test(b);
}

const CODE_EXT = new Set(['.mjs', '.js', '.ts', '.tsx', '.jsx', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php', '.sh', '.bash', '.zsh']);

function pathHasDotDot(p) {
  return norm(p).split('/').includes('..');
}

function realpathUnderRoot(root, rel) {
  const p = norm(rel);
  if (!p || path.isAbsolute(p) || pathHasDotDot(p)) return null;
  try {
    const abs = path.join(root, p);
    const real = fs.realpathSync.native(abs);
    const rootReal = fs.realpathSync.native(root);
    const relToRoot = path.relative(rootReal, real);
    if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;
    return norm(relToRoot);
  } catch {
    return null;
  }
}

const SWARM_PROJECT_LEDGER = new Set([
  '.swarm/project/tickets.json',
  '.swarm/project/tickets.log',
  '.swarm/project/backlog.json',
  '.swarm/project/scope.snapshot.md',
]);

function matchesSwarmAdminPattern(lower) {
  if (lower === '.project-swarm.json') return true;
  if (SWARM_PROJECT_LEDGER.has(lower)) return true;
  if (lower.startsWith('coordination/manifests/')) return true;
  if (lower.startsWith('coordination/review/')) return true;
  if (/^coordination\/handoff[^/]*\.md$/i.test(lower)) return true;
  if (lower.startsWith('docs/scope/')) return true;
  if (lower.startsWith('docs/plans/')) return true;
  if (lower.startsWith('docs/state/')) return true;
  if (lower.startsWith('docs/design/')) {
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    if (dot === -1) return true;
    return !CODE_EXT.has(base.slice(dot));
  }
  if (lower.startsWith('jobs/') && /manifest/i.test(path.basename(lower))) return true;
  return false;
}

/** Every declared file must stay under root and match swarm-admin patterns (request text is not trusted). */
export function isSwarmAdminHandbuildPath(rel, { root } = {}) {
  if (typeof rel !== 'string' || !rel) return false;
  const raw = norm(rel);
  if (path.isAbsolute(raw) || pathHasDotDot(raw) || /[*?[{]/.test(raw)) return false;
  if (/^(?:docs|coordination)\//i.test(raw)) {
    const top = raw.split('/')[0];
    if (top !== 'docs' && top !== 'coordination') return false;
  }
  let canonical = raw;
  if (root) {
    const resolved = realpathUnderRoot(root, raw);
    if (resolved !== null) {
      if (/^(?:docs|coordination)\//i.test(resolved) && resolved !== raw) return false;
      canonical = resolved;
    } else {
      try {
        const abs = path.join(root, raw);
        if (fs.existsSync(abs)) return false;
      } catch {
        return false;
      }
    }
  }
  const lower = canonical.toLowerCase();
  if (!matchesSwarmAdminPattern(lower)) return false;
  return true;
}

const ALLOWED_GIT_OPS = new Set(['commit', 'push']);

export function evaluateHandbuildAutoApprove(root, { files, minutes, git }) {
  if (root && fs.existsSync(path.join(root, AUTO_OFF_FILE))) {
    return { ok: false, reason: 'kill-switch' };
  }
  const list = Array.isArray(files) ? files : [];
  if (!list.length || list.length > MAX_POLICY_FILES) return { ok: false, reason: 'files' };
  const mins = Number(minutes);
  if (!Number.isInteger(mins) || mins < 1 || mins > MAX_POLICY_MINUTES) return { ok: false, reason: 'minutes' };
  const ops = (Array.isArray(git) ? git : String(git ?? '').split(',')).map(g => g.trim()).filter(Boolean);
  if (ops.some(g => !ALLOWED_GIT_OPS.has(g))) return { ok: false, reason: 'git' };
  if (!list.every(f => isSwarmAdminHandbuildPath(f, { root }))) return { ok: false, reason: 'path' };
  const branch = branchOf(root);
  if (!policyBranchAllowed(branch)) return { ok: false, reason: 'branch' };
  if (!gitWorktreePolicyContext(root).ok) return { ok: false, reason: 'worktree' };
  return {
    ok: true,
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    minutes: mins,
    files: list,
    branch,
    git: ops,
  };
}

export function autoApproveKillSwitchOn(root) {
  try {
    return fs.existsSync(path.join(root, AUTO_OFF_FILE));
  } catch {
    return true;
  }
}

export function branchOf(root) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return 'HEAD';
  }
}

export function gitRemotesOf(root) {
  try {
    return execFileSync('git', ['remote'], { cwd: root, encoding: 'utf8', timeout: 3000 }).split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

const isConfiguredRemote = (name, root) => {
  const remotes = gitRemotesOf(root);
  if (remotes === null) return false;
  return remotes.includes(name);
};

function scratchBase(home = os.homedir()) {
  return path.join(home, '.project-swarm-scratch');
}

/** Git write policy: cwd/root must be main checkout or a worktree under the scratch base. */
export function gitWorktreePolicyContext(root, { home = os.homedir(), cwd = root, env = process.env } = {}) {
  try {
    const rootReal = fs.realpathSync.native(root);
    const cwdReal = fs.realpathSync.native(cwd ?? root);
    if (cwdReal === rootReal || cwdReal.startsWith(`${rootReal}${path.sep}`)) return { ok: true };
    const scratchOpts = { home, env, strict: false };
    if (isScratchRoot(rootReal, scratchOpts) || isScratchRoot(cwdReal, scratchOpts)) return { ok: true };
    const sb = scratchBase(home);
    const scratch = fs.existsSync(sb) ? fs.realpathSync.native(sb) : null;
    if (scratch && (cwdReal.startsWith(`${scratch}${path.sep}`) || cwdReal === scratch)) return { ok: true };
    const gitCommon = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: cwdReal, encoding: 'utf8', timeout: 3000 }).trim();
    const commonAbs = path.isAbsolute(gitCommon) ? gitCommon : path.join(cwdReal, gitCommon);
    const commonReal = fs.realpathSync.native(commonAbs);
    const mainRoot = path.dirname(commonReal);
    if (cwdReal === mainRoot || cwdReal.startsWith(`${mainRoot}${path.sep}`)) return { ok: true };
    if (mainRoot.startsWith(`${scratch}${path.sep}`) || mainRoot === scratch) return { ok: true };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

const CONFIG_FLAGS = new Set(['-c', '--config', '--config-env', '--output', '--exec', '-x', '--exec-path', '--upload-pack', '--receive-pack', '--ext-diff']);
const COMMIT_MSG_OPTS = new Set(['-m', '-F', '-C', '-c', '--author', '--date', '--message']);
const COMMIT_DENY_FLAGS = new Set(['--no-verify', '-n', '--no-gpg-sign', '--no-edit']);
const PLAIN_REF = /^[A-Za-z0-9._/-]+$/;

const shortFlagHas = (flag, ch) => flag.startsWith('-') && !flag.startsWith('--') && flag.slice(1).includes(ch);

function hasConfigInWords(words) {
  return words.some(w => CONFIG_FLAGS.has(w) || w === '--config-env' || w.startsWith('--config=') || w.startsWith('--output=')
    || /=upload-pack$|=receive-pack$|=exec$|=config$/.test(w) || /^--exec=/.test(w));
}

function parsePushRefspecWord(raw) {
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
}

export function parseGitInvocation(args) {
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
  const restForConfig = (sub === 'switch' || sub === 'checkout')
    ? rest.filter(a => a !== '-c' && a !== '-b' && a !== '--create')
    : rest;
  const gitHasConfig = hasConfigInWords([...globalWords, ...restForConfig]);
  return { sub, rest, globalOpts, benignGlobalOnly: globalOpts && benignGlobalOnly, hasConfig: gitHasConfig, globalWords };
}

export function policyGitCommitAllowed(args, { root, currentBranch }) {
  const inv = parseGitInvocation(args);
  if (inv.sub !== 'commit') return false;
  if (isProtectedBranch(currentBranch)) return false;
  if (!policyBranchAllowed(currentBranch)) return false;
  if (!gitWorktreePolicyContext(root).ok) return false;
  if (inv.globalOpts || inv.hasConfig) return false;
  const rest = inv.rest;
  const ALLOW = new Set(['--amend', '-a', '--all', '-o', '--only', '-i', '--include', '--no-edit']);
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (!a.startsWith('-')) { i += 1; continue; }
    const base = a.split('=')[0];
    if (COMMIT_DENY_FLAGS.has(base) || a.startsWith('--no-verify=')) return false;
    if (COMMIT_MSG_OPTS.has(base) || a.startsWith('--message=')) {
      i += a.includes('=') ? 1 : 2;
      continue;
    }
    if (ALLOW.has(base)) { i += 1; continue; }
    if (!a.startsWith('--') && a.length > 1) {
      let ok = true;
      for (const ch of a.slice(1)) {
        if (ch === 'n') return false;
        if (!['a', 'm', 'o', 'i'].includes(ch)) ok = false;
      }
      if (!ok) return false;
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

export function policyGitPushAllowed(args, { root, currentBranch }) {
  const inv = parseGitInvocation(args);
  if (inv.sub !== 'push') return false;
  if (isProtectedBranch(currentBranch)) return false;
  if (!policyBranchAllowed(currentBranch)) return false;
  if (!gitWorktreePolicyContext(root).ok) return false;
  if (inv.globalOpts || inv.hasConfig) return false;
  const rest = inv.rest;
  const flags = rest.filter(a => a.startsWith('-'));
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  const force = flags.some(a => a === '--force' || a === '-f' || a === '--force-with-lease' || shortFlagHas(a, 'f'))
    || pos.some(a => a.startsWith('+'));
  if (force) return false;
  if (flags.some(a => ['--mirror', '--prune', '--delete', '-d', '--all'].includes(a))) return false;
  if (pos.some(a => a.startsWith('+') || a.includes(':'))) return false;
  if (flags.some(f => !['-u', '--set-upstream'].includes(f))) return false;
  if (pos.length > 2) return false;
  if (pos.length === 0) return true;
  if (pos.length === 1) {
    if (!PLAIN_REF.test(pos[0]) || !isConfiguredRemote(pos[0], root)) return false;
    return true;
  }
  if (!PLAIN_REF.test(pos[0]) || !isConfiguredRemote(pos[0], root)) return false;
  const branchWord = pos[1];
    if (!PLAIN_REF.test(branchWord) || branchWord.includes(':') || branchWord.startsWith('+')) return false;
    if (branchWord !== 'HEAD' && isProtectedBranch(normBranch(branchWord))) return false;
    if (branchWord !== 'HEAD' && branchWord !== currentBranch && normBranch(branchWord) !== normBranch(currentBranch)) return false;
  return true;
}

const SWITCH_BLOCK = new Set(['-f', '--force', '-B', '-C', '--discard-changes', '--orphan', '--merge', '-m', '-B']);
const SWITCH_CREATE = new Set(['-b', '-c', '--create']);

export function policyGitSwitchCheckoutAllowed(args, { root, currentBranch }) {
  const inv = parseGitInvocation(args);
  if (inv.sub !== 'switch' && inv.sub !== 'checkout') return false;
  if (inv.globalOpts || inv.hasConfig) return false;
  const rest = inv.rest;
  if (rest.includes('--')) return false;
  const flags = rest.filter(a => a.startsWith('-') && a !== '--');
  for (const f of flags) {
    if (SWITCH_BLOCK.has(f) || SWITCH_BLOCK.has(f.split('=')[0])) return false;
    if (!f.startsWith('--') && f.startsWith('-')) {
      for (const ch of f.slice(1)) {
        if (['f', 'B', 'C', 'm'].includes(ch)) return false;
      }
    }
  }
  const create = flags.some(f => SWITCH_CREATE.has(f) || (!f.startsWith('--') && f.slice(1).split('').some(ch => ch === 'b' || ch === 'c')));
  const plain = rest.filter(a => a && !a.startsWith('-'));
  if (create) {
    if (plain.length !== 1) return false;
    const name = plain[0];
    if (!PLAIN_REF.test(name) || isProtectedBranch(name)) return false;
    return gitWorktreePolicyContext(root).ok;
  }
  if (plain.length !== 1) return false;
  const ref = plain[0];
  if (!PLAIN_REF.test(ref) || ref.includes('..') || ref === '.' || ref === '-') return false;
  if (isProtectedBranch(ref)) return false;
  return gitWorktreePolicyContext(root).ok;
}

export function policyGitWorktreeAllowed(args, { root, home = os.homedir() }) {
  const inv = parseGitInvocation(args);
  if (inv.sub !== 'worktree') return false;
  if (inv.globalOpts || inv.hasConfig) return false;
  const rest = inv.rest;
  const verb = rest.find(a => a && !a.startsWith('-'));
  if (verb === 'list') return true;
  if (verb === 'remove') {
    const pos = rest.filter(a => a && !a.startsWith('-') && a !== 'remove');
    if (pos.length !== 1) return false;
    return worktreePathUnderScratch(pos[0], { root, home });
  }
  if (verb !== 'add') return false;
  const pos = rest.filter(a => a && !a.startsWith('-') && a !== 'add');
  if (pos.length < 2) return false;
  const wtPath = pos[0];
  if (!worktreePathUnderScratch(wtPath, { root, home })) return false;
  const afterPath = rest.slice(rest.indexOf(wtPath) + 1);
  if (!afterPath.includes('-b') && !afterPath.some(a => a === '-b' || (a.startsWith('-') && a.slice(1).includes('b')))) return false;
  return true;
}

function worktreePathUnderScratch(rawPath, { root, home }) {
  try {
    let p = String(rawPath ?? '');
    if (!path.isAbsolute(p)) p = path.resolve(root, p);
    const real = fs.realpathSync.native(p);
    const scratch = fs.realpathSync.native(scratchBase(home));
    return real === scratch || real.startsWith(`${scratch}${path.sep}`);
  } catch {
    return false;
  }
}

export function policyGitRestoreDenied(args) {
  const inv = parseGitInvocation(args);
  if (inv.sub === 'restore' || inv.sub === 'clean' || inv.sub === 'reset') return true;
  if (inv.sub === 'checkout' && inv.rest.includes('--')) return true;
  return false;
}
