// SPDX-License-Identifier: Apache-2.0
// Frozen in-code policy for hand-build auto-approve (not writable by agents).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isScratchRoot } from './scratch-roots.mjs';
import { tokenize } from './shell-writes.mjs';

export const POLICY_ID = 'swarm-admin-handbuild';
export const POLICY_VERSION = 2;
export const AUTO_OFF_FILE = '.swarm/handbuild/auto-off';
export const STATS_FILE = '.swarm/handbuild/stats.json';
export const STATS_INITIALIZED_FILE = '.swarm/handbuild/stats.initialized';
export const LOG_FILE = '.swarm/handbuild/log.ndjson';
export const DEFAULT_MAX_AUTO_APPROVE_WINDOWS_PER_DAY = 20;
export const POLICY_LIMIT_CEILING_WINDOWS_PER_DAY = 100;
export const MAX_POLICY_MINUTES = 60;
export const MAX_POLICY_FILES = 20;
export const DEFAULT_MAX_ACTIONS_PER_WINDOW = 20;
export const DEFAULT_MAX_ACTIONS_PER_DAY = 100;
export const DEFAULT_MAX_FILES_PER_DAY = 100;
export const POLICY_LIMIT_CEILING_ACTIONS_PER_WINDOW = 100;
export const POLICY_LIMIT_CEILING_ACTIONS_PER_DAY = 500;
export const POLICY_LIMIT_CEILING_FILES_PER_DAY = 500;
export const POLICY_STATS_UNREADABLE = '__policyStatsUnreadable';

const norm = p => String(p).replace(/\\/g, '/');
const normBranch = b => String(b ?? '').replace(/^refs\/heads\//, '');
const isProtectedBranch = b => {
  const n = normBranch(b);
  return n === 'main' || n === 'master' || n === 'HEAD';
};

const BRANCH_SWARM = /^swarm\/[A-Za-z0-9._/-]+$/;
const BRANCH_FEAT = /^feat\/[A-Za-z0-9._/-]+$/;

export function policyBranchAllowed(branch) {
  const b = normBranch(branch);
  if (!b || isProtectedBranch(b)) return false;
  return BRANCH_SWARM.test(b) || BRANCH_FEAT.test(b);
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

function swarmAdminDocFileAllowed(lower) {
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot === -1) return true;
  return !CODE_EXT.has(base.slice(dot));
}

function matchesSwarmAdminPattern(lower) {
  if (SWARM_PROJECT_LEDGER.has(lower)) return true;
  if (/^coordination\/handoff[^/]*\.md$/i.test(lower)) return true;
  if (lower.startsWith('docs/scope/')) return swarmAdminDocFileAllowed(lower);
  if (lower.startsWith('docs/plans/')) return swarmAdminDocFileAllowed(lower);
  if (lower.startsWith('docs/state/')) return swarmAdminDocFileAllowed(lower);
  if (lower.startsWith('docs/design/')) return swarmAdminDocFileAllowed(lower);
  return false;
}

function deepestExistingRel(root, raw) {
  const p = norm(raw);
  if (!p || path.isAbsolute(p) || pathHasDotDot(p)) return null;
  const parts = p.split('/');
  for (let n = parts.length; n >= 1; n -= 1) {
    const prefix = parts.slice(0, n).join('/');
    const resolved = realpathUnderRoot(root, prefix);
    if (resolved !== null && resolved === prefix) return resolved;
  }
  return null;
}

export function isSwarmAdminHandbuildPath(rel, { root } = {}) {
  if (typeof rel !== 'string' || !rel) return false;
  const raw = norm(rel);
  if (path.isAbsolute(raw) || pathHasDotDot(raw) || /[*?[{]/.test(raw)) return false;
  if (/^(?:docs|coordination)\//i.test(raw)) {
    const top = raw.split('/')[0];
    if (top !== 'docs' && top !== 'coordination') return false;
  }
  let canonical = raw;
  const lowerRaw = raw.toLowerCase();
  if (root) {
    const resolved = realpathUnderRoot(root, raw);
    if (resolved !== null) {
      if (/^(?:docs|coordination)\//i.test(resolved) && resolved !== raw) return false;
      canonical = resolved;
    } else {
      if (!matchesSwarmAdminPattern(lowerRaw)) return false;
      if (deepestExistingRel(root, raw) === null) return false;
      canonical = raw;
    }
  }
  const lower = canonical.toLowerCase();
  if (!matchesSwarmAdminPattern(lower)) return false;
  return true;
}

const ALLOWED_GIT_OPS = new Set(['commit', 'push', 'switch']);

function swarmConfigDir(home) {
  return process.env.SWARM_CONFIG ? path.dirname(process.env.SWARM_CONFIG) : path.join(home, '.config', 'project-swarm');
}

export function policyFilePath(home = os.homedir()) {
  return path.join(swarmConfigDir(home), 'policy.json');
}

export function policyGitConfigAbsPaths(home = os.homedir(), env = process.env) {
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(home, '.gitconfig'), path.join(xdg, 'git', 'config')];
}

/** Limits from machine policy.json handbuild-auto-approve rule, else defaults. */
export function policyRateLimits(home = os.homedir()) {
  const defaults = {
    maxActionsPerWindow: DEFAULT_MAX_ACTIONS_PER_WINDOW,
    maxActionsPerDay: DEFAULT_MAX_ACTIONS_PER_DAY,
    maxFilesPerDay: DEFAULT_MAX_FILES_PER_DAY,
    maxAutoApproveWindowsPerDay: DEFAULT_MAX_AUTO_APPROVE_WINDOWS_PER_DAY,
  };
  try {
    const file = policyFilePath(home);
    if (!file) return defaults;
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rules = Array.isArray(policy?.rules) ? policy.rules : [];
    const row = rules.find(r => r?.id === POLICY_ID && r.enabled !== false && r.disabled !== true);
    const lim = row?.limits && typeof row.limits === 'object' ? row.limits : {};
    const n = (k, d) => {
      const v = Number(lim[k]);
      return Number.isInteger(v) && v > 0 ? v : d;
    };
    const cap = (v, max) => Math.min(v, max);
    return {
      maxActionsPerWindow: cap(n('maxActionsPerWindow', defaults.maxActionsPerWindow), POLICY_LIMIT_CEILING_ACTIONS_PER_WINDOW),
      maxActionsPerDay: cap(n('maxActionsPerDay', defaults.maxActionsPerDay), POLICY_LIMIT_CEILING_ACTIONS_PER_DAY),
      maxFilesPerDay: cap(n('maxFilesPerDay', defaults.maxFilesPerDay), POLICY_LIMIT_CEILING_FILES_PER_DAY),
      maxAutoApproveWindowsPerDay: cap(n('maxAutoApproveWindowsPerDay', defaults.maxAutoApproveWindowsPerDay), POLICY_LIMIT_CEILING_WINDOWS_PER_DAY),
    };
  } catch {
    return defaults;
  }
}

/** Trusted clone URL from owner machine policy.json only (not project files). */
export function trustedRepositoryUrl(home = os.homedir()) {
  try {
    const file = policyFilePath(home);
    if (!file) return null;
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rules = Array.isArray(policy?.rules) ? policy.rules : [];
    const row = rules.find(r => r?.id === POLICY_ID && r.enabled !== false && r.disabled !== true);
    const raw = row?.repository ?? row?.repo ?? row?.git?.url ?? row?.remote?.url;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    return normalizeGitRemoteUrl(raw);
  } catch {
    return null;
  }
}

const POLICY_GIT_CONFIG_OVERRIDES = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/nonexistent',
  '-c', 'credential.helper=',
];

export function policyGitEnv(home = os.homedir()) {
  const env = {
    HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  return env;
}

const POLICY_GIT_ENV_HARNESS = new Set(['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS']);

/** True when the session exports GIT_* variables that can override this git invocation (not benign harness keys). */
export function policyGitSessionEnvBlocked(env = process.env, home = os.homedir()) {
  for (const k of Object.keys(env)) {
    if (!k.startsWith('GIT_')) continue;
    if (POLICY_GIT_ENV_HARNESS.has(k)) continue;
    if (k === 'GIT_CONFIG_GLOBAL') {
      const g = env.GIT_CONFIG_GLOBAL;
      if (!g) continue;
      const expected = path.join(home, '.gitconfig');
      if (path.resolve(g) === path.resolve(expected)) continue;
      try {
        if (fs.realpathSync.native(g) === fs.realpathSync.native(expected)) continue;
      } catch { /* non-default */ }
      return true;
    }
    return true;
  }
  return false;
}

/** First `git` executable on PATH whose basename is exactly `git` (not a symlink alias name). */
export function resolveTrustedPolicyGitExecutable({ home = os.homedir(), pathEnv = process.env.PATH } = {}) {
  const delim = path.delimiter;
  for (const dir of String(pathEnv ?? '').split(delim).filter(Boolean)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'git');
    try {
      if (!fs.existsSync(candidate)) continue;
      if (path.basename(candidate) !== 'git') continue;
      const real = fs.realpathSync.native(candidate);
      if (path.basename(real) !== 'git') continue;
      return real;
    } catch { /* try next */ }
  }
  return null;
}

function shellQuoteWord(w) {
  const s = String(w);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Exact argv for a single-segment policy git command (trusted git + hardened -c overrides + subcommand args). */
export function policyGitArgvFromCommand(command, { home = os.homedir() } = {}) {
  const text = String(command ?? '');
  if (!text.trim()) return null;
  const segments = tokenize(text);
  if (segments.length !== 1 || segments[0].piped) return null;
  const words = segments[0];
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  const trusted = resolveTrustedPolicyGitExecutable({ home });
  if (!trusted) return null;
  let gi = words.findIndex((w, idx) => idx >= i && w === 'git');
  if (gi === -1) gi = words.findIndex((w, idx) => idx >= i && w === trusted);
  if (gi === -1) return null;
  if (words.slice(0, gi).some(w => POLICY_SHELL_WRAPPERS.has(w) || w === 'cd')) return null;
  let gitArgs = words.slice(gi + 1);
  while (gitArgs.length && (gitArgs[0] === '-c' || gitArgs[0] === '--config')) {
    if (gitArgs[0] === '-c' && gitArgs.length < 2) return null;
    gitArgs.splice(0, gitArgs[0] === '-c' ? 2 : 1);
  }
  const configFlat = [];
  for (let c = 0; c < POLICY_GIT_CONFIG_OVERRIDES.length; c += 2) {
    configFlat.push(POLICY_GIT_CONFIG_OVERRIDES[c], POLICY_GIT_CONFIG_OVERRIDES[c + 1]);
  }
  const sub = gitArgs[0];
  if (!sub || sub.startsWith('-')) return null;
  return [trusted, ...configFlat, ...gitArgs];
}

/** Canonical shell line for policy git (same hardened argv the session must run). */
export function policyRewriteGitCommand(command, opts = {}) {
  const argv = policyGitArgvFromCommand(command, opts);
  if (!argv) return null;
  return argv.map(shellQuoteWord).join(' ');
}

export function policyGitExec(root, gitArgs, { cwd = root, home = os.homedir() } = {}) {
  const work = cwd ?? root;
  const args = [...POLICY_GIT_CONFIG_OVERRIDES, ...gitArgs];
  return execFileSync('git', args, { cwd: work, encoding: 'utf8', timeout: 3000, env: policyGitEnv(home) });
}

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
  const head = headOf(root);
  if (!policyBranchAllowed(branch)) return { ok: false, reason: 'branch' };
  if (!gitWorktreePolicyContext(root).ok) return { ok: false, reason: 'worktree' };
  if (!gitRepoLocalConfigSafe(root)) return { ok: false, reason: 'git-config' };
  return {
    ok: true,
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    minutes: mins,
    files: list,
    branch,
    head,
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

export function branchOf(root, { cwd = root, home = os.homedir() } = {}) {
  try {
    return policyGitExec(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, home }).trim();
  } catch {
    return 'HEAD';
  }
}

export function headOf(root, { cwd = root, home = os.homedir() } = {}) {
  try {
    return policyGitExec(root, ['rev-parse', 'HEAD'], { cwd, home }).trim();
  } catch {
    return '';
  }
}

/** Canonical `scheme://host/path` for trusted URL comparison (http ≠ https). */
export function normalizeGitRemoteUrl(url) {
  let u = String(url ?? '').trim();
  if (!u || u.includes('::')) return '';
  if (/^(?:file:|\/|~)/.test(u)) return '';
  u = u.replace(/\.git$/i, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
      if (scheme !== 'https' && scheme !== 'ssh') return '';
      if (parsed.username || parsed.password) return '';
      if (parsed.port && !((scheme === 'https' && parsed.port === '443') || (scheme === 'ssh' && parsed.port === '22'))) {
        return '';
      }
      const host = parsed.hostname.toLowerCase();
      const repoPath = parsed.pathname.replace(/^\//, '').replace(/\/$/, '').toLowerCase();
      if (!host || !repoPath || host.includes('::') || repoPath.includes('::')) return '';
      return `${scheme}://${host}/${repoPath}`;
    } catch {
      return '';
    }
  }
  const slashBeforeColon = u.indexOf('/');
  const colon = u.indexOf(':');
  if (colon === -1 || (slashBeforeColon !== -1 && slashBeforeColon < colon)) return '';
  const scp = /^([A-Za-z0-9._-]+)@([^:]+):(.+)$/.exec(u);
  if (!scp) return '';
  const host = scp[2].toLowerCase();
  const repoPath = scp[3].replace(/^\//, '').replace(/\/$/, '').toLowerCase();
  if (!host || !repoPath || host.includes('/') || repoPath.includes(':') || host.includes('::') || repoPath.includes('::')) return '';
  return `ssh://${host}/${repoPath}`;
}

function gitOriginUrlRewritesPresent(root, { cwd = root, home = os.homedir() } = {}) {
  try {
    const pushUrl = policyGitExec(root, ['config', '--get', 'remote.origin.pushurl'], { cwd, home }).trim();
    if (pushUrl) return true;
  } catch { /* absent */ }
  try {
    const raw = policyGitExec(root, ['config', '--local', '--list'], { cwd, home });
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const eq = line.indexOf('=');
      const key = (eq === -1 ? line : line.slice(0, eq)).toLowerCase();
      if (key.startsWith('url.') && (key.endsWith('.insteadof') || key.endsWith('.pushinsteadof'))) return true;
    }
  } catch {
    return true;
  }
  return false;
}

const REPO_LOCAL_CONFIG_ALLOW = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
  'remote.origin.url',
  'remote.origin.fetch',
  'user.name',
  'user.email',
]);

function repoLocalConfigKeyAllowed(key) {
  const k = String(key ?? '').toLowerCase();
  if (REPO_LOCAL_CONFIG_ALLOW.has(k)) return true;
  if (/^remote\.[^.]+\.(url|fetch)$/.test(k)) return true;
  if (k.startsWith('remote.')) return false;
  if (k.startsWith('branch.') && (k.endsWith('.remote') || k.endsWith('.merge'))) return true;
  return false;
}

export function gitRepoLocalConfigSafe(root, { cwd = root, home = os.homedir() } = {}) {
  try {
    const raw = policyGitExec(root, ['config', '--local', '--list'], { cwd, home });
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const eq = line.indexOf('=');
      const key = eq === -1 ? line : line.slice(0, eq);
      if (!repoLocalConfigKeyAllowed(key)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function policyGitConfigOriginTrusted(origin, root, home, cwd = root) {
  const raw = String(origin ?? '').replace(/^file:/, '');
  if (!raw) return false;
  try {
    const homeReal = fs.realpathSync.native(home);
    const workReal = fs.realpathSync.native(cwd ?? root);
    const resolved = path.isAbsolute(raw)
      ? fs.realpathSync.native(raw)
      : fs.realpathSync.native(path.join(workReal, raw));
    if (resolved === path.join(homeReal, '.gitconfig')) return true;
    const xdg = process.env.XDG_CONFIG_HOME || path.join(homeReal, '.config');
    if (resolved === path.join(fs.realpathSync.native(xdg), 'git', 'config')) return true;
    const local = path.join(workReal, '.git', 'config');
    if (resolved === local) return true;
    const common = policyGitExec(root, ['rev-parse', '--git-common-dir'], { cwd: workReal, home }).trim();
    const commonAbs = path.isAbsolute(common) ? common : path.join(workReal, common);
    const commonConfig = path.join(fs.realpathSync.native(commonAbs), 'config');
    return resolved === commonConfig;
  } catch {
    return false;
  }
}

export function gitEffectiveConfigSafe(root, { cwd = root, home = os.homedir(), env = process.env } = {}) {
  try {
    const work = cwd ?? root;
    const runEnv = { ...env, HOME: home };
    for (const k of Object.keys(runEnv)) {
      if (k === 'HOME') continue;
      if (k.startsWith('GIT_')) delete runEnv[k];
    }
    runEnv.HOME = home;
    runEnv.GIT_CONFIG_SYSTEM = os.devNull;
    runEnv.GIT_CONFIG_NOSYSTEM = '1';
    const raw = execFileSync('git', ['config', '--show-origin', '--list'], {
      cwd: work,
      encoding: 'utf8',
      timeout: 3000,
      env: runEnv,
    });
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) return false;
      const origin = line.slice(0, tab);
      if (!policyGitConfigOriginTrusted(origin, root, home, work)) continue;
      const rest = line.slice(tab + 1);
      const eq = rest.indexOf('=');
      const key = eq === -1 ? rest : rest.slice(0, eq);
      if (!repoLocalConfigKeyAllowed(key)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function originIsProjectRepository(root, { cwd = root, home = os.homedir() } = {}) {
  try {
    const trusted = trustedRepositoryUrl(home);
    if (!trusted) return false;
    const remotes = policyGitExec(root, ['remote'], { cwd, home }).split('\n').map(s => s.trim()).filter(Boolean);
    if (!remotes.includes('origin')) return false;
    if (gitOriginUrlRewritesPresent(root, { cwd, home })) return false;
    let urls = [];
    try {
      urls = policyGitExec(root, ['remote', 'get-url', '--push', '--all', 'origin'], { cwd, home })
        .split('\n').map(s => s.trim()).filter(Boolean);
    } catch { /* fall back */ }
    if (!urls.length) {
      try {
        urls = [policyGitExec(root, ['remote', 'get-url', 'origin'], { cwd, home }).trim()].filter(Boolean);
      } catch {
        return false;
      }
    }
    return urls.every(u => normalizeGitRemoteUrl(u) === trusted);
  } catch {
    return false;
  }
}

export function gitPushMappingConfigSafe(root, { cwd = root, home = os.homedir() } = {}) {
  try {
    const push = policyGitExec(root, ['config', '--get', 'remote.origin.push'], { cwd, home }).trim();
    if (push) return false;
  } catch { /* defaults ok */ }
  return true;
}

export function gitHooksPolicySafe(root, { cwd = root, home = os.homedir() } = {}) {
  try {
    try {
      const raw = policyGitExec(root, ['config', '--local', '--list'], { cwd, home });
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const key = line.slice(0, line.indexOf('=')).toLowerCase();
        if (key === 'core.hookspath') return false;
      }
    } catch { /* unset is fine */ }
    const gitCommon = policyGitExec(root, ['rev-parse', '--git-common-dir'], { cwd, home }).trim();
    const commonAbs = path.isAbsolute(gitCommon) ? gitCommon : path.join(cwd ?? root, gitCommon);
    const hooksDir = path.join(commonAbs, 'hooks');
    if (!fs.existsSync(hooksDir)) return true;
    const entries = fs.readdirSync(hooksDir);
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      if (!name.endsWith('.sample')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function headDescendsFromGranted(root, grantedHead, { cwd = root, home = os.homedir() } = {}) {
  if (!grantedHead) return false;
  try {
    const cur = policyGitExec(root, ['rev-parse', 'HEAD'], { cwd, home }).trim();
    if (cur === grantedHead) return true;
    policyGitExec(root, ['merge-base', '--is-ancestor', grantedHead, cur], { cwd, home });
    return true;
  } catch {
    return false;
  }
}

const POLICY_SHELL_WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'env', 'nice', 'builtin', 'xargs', 'stdbuf', 'timeout', 'sh', 'bash', 'zsh']);

/** Refuse env assignments, wrappers, chaining, cd, or git -C/--git-dir/--work-tree on the policy git path. */
export function policyCommandShellBlocked(command) {
  const text = String(command ?? '');
  if (!text.trim()) return false;
  const segments = tokenize(text);
  if (segments.length > 1) return true;
  for (const words of segments) {
    if (words.piped) return true;
    let i = 0;
    while (i < words.length) {
      const w = words[i];
      if (/^GIT_[A-Z0-9_]+=/.test(w)) return true;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) return true;
      if (POLICY_SHELL_WRAPPERS.has(w)) return true;
      if (w === 'cd') return true;
      i += 1;
    }
    const gi = words.findIndex(w => w === 'git');
    if (gi === -1) continue;
    const args = words.slice(gi + 1);
    let j = 0;
    while (j < args.length && args[j].startsWith('-') && args[j] !== '--') {
      const g = args[j];
      if (g === '-C' || g === '--git-dir' || g === '--work-tree' || g.startsWith('--git-dir=') || g.startsWith('--work-tree=')) return true;
      j += g.includes('=') ? 1 : (g === '-C' ? 2 : 1);
    }
  }
  return false;
}

export function policyGitInvocationsFromOps(policyOps) {
  return (policyOps ?? [])
    .filter(o => o?.tool === 'git' && o.sub)
    .map(o => ({ tool: 'git', sub: o.sub, rest: o.rest ?? [] }));
}

const CONFIG_FLAGS = new Set(['-c', '--config', '--config-env', '--output', '--exec', '-x', '--exec-path', '--upload-pack', '--receive-pack', '--ext-diff']);
const COMMIT_MSG_ALLOW = new Set(['-m', '--message']);
const COMMIT_MSG_DENY = new Set(['-C', '-c', '--reuse-message', '--allow-empty-message']);
const COMMIT_DENY_FLAGS = new Set(['--no-verify', '-n', '--no-gpg-sign', '--no-edit', '--amend']);
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
  const gitHasConfig = hasConfigInWords([...globalWords, ...rest]);
  return { sub, rest, globalOpts, benignGlobalOnly: globalOpts && benignGlobalOnly, hasConfig: gitHasConfig, globalWords };
}

function policyGitSafetyContext(root, { cwd = root, home = os.homedir() } = {}) {
  if (policyGitSessionEnvBlocked(process.env, home)) return false;
  if (!gitEffectiveConfigSafe(root, { cwd, home })) return false;
  if (!gitWorktreePolicyContext(root, { cwd, home }).ok) return false;
  if (!gitHooksPolicySafe(root, { cwd, home })) return false;
  if (!gitRepoLocalConfigSafe(root, { cwd, home })) return false;
  return true;
}

const POLICY_READ_GIT_SUBS = new Set(['status', 'diff', 'log', 'show']);

export function policyGitReadAllowed(args, { root, cwd = root, home = os.homedir() }) {
  const inv = parseGitInvocation(args);
  if (!inv.sub || !POLICY_READ_GIT_SUBS.has(inv.sub)) return false;
  if (!policyGitSafetyContext(root, { cwd, home })) return false;
  if (inv.hasConfig) return false;
  if (inv.globalOpts && !inv.benignGlobalOnly) return false;
  return true;
}

function policyFileCoversPath(policyFiles, relPath) {
  const p = norm(String(relPath ?? ''));
  if (!p || !Array.isArray(policyFiles) || !policyFiles.length) return false;
  return policyFiles.some(f => {
    const g = norm(String(f));
    if (!g) return false;
    if (p === g) return true;
    if (g.endsWith('/')) return p.startsWith(g);
    return p.startsWith(`${g}/`);
  });
}

export function policyGitAddAllowed(args, { root, cwd = root, home = os.homedir(), policyFiles } = {}) {
  const inv = parseGitInvocation(args);
  if (inv.sub !== 'add') return false;
  if (!policyGitSafetyContext(root, { cwd, home })) return false;
  if (inv.globalOpts || inv.hasConfig) return false;
  const rest = inv.rest ?? [];
  if (rest.some(a => ['-A', '--all', '-u', '--update', '.', ':/'].includes(a) || /[*?[{]/.test(a))) return false;
  const paths = rest.filter(a => a && !a.startsWith('-'));
  if (!paths.length) return false;
  for (const raw of paths) {
    if (raw.startsWith(':')) return false;
    if (!isSwarmAdminHandbuildPath(raw, { root })) return false;
    if (!policyFileCoversPath(policyFiles, raw)) return false;
  }
  return true;
}

export function policyGitCommitAllowed(args, { root, currentBranch, cwd = root, home = os.homedir() }) {
  const inv = parseGitInvocation(args);
  if (inv.sub !== 'commit') return false;
  if (isProtectedBranch(currentBranch)) return false;
  if (!policyBranchAllowed(currentBranch)) return false;
  if (!policyGitSafetyContext(root, { cwd, home })) return false;
  if (inv.globalOpts || inv.hasConfig) return false;
  const rest = inv.rest;
  let hasMessage = false;
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (!a.startsWith('-')) return false;
    const base = a.split('=')[0];
    if (COMMIT_DENY_FLAGS.has(base) || a.startsWith('--no-verify=') || base === '--amend') return false;
    if (COMMIT_MSG_DENY.has(base)) return false;
    if (COMMIT_MSG_ALLOW.has(base) || a.startsWith('--message=')) {
      hasMessage = true;
      i += a.includes('=') ? 1 : 2;
      continue;
    }
    if (!a.startsWith('--') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (ch === 'n' || ch === 'C' || ch === 'c') return false;
        if (ch !== 'm') return false;
        if (ch === 'm') hasMessage = true;
      }
      i += 1;
      continue;
    }
    return false;
  }
  return hasMessage;
}

function pushTargetAllowed(branchWord, currentBranch) {
  const cur = normBranch(currentBranch);
  const b = normBranch(branchWord);
  if (!b || isProtectedBranch(b)) return false;
  return b === cur || b === 'HEAD';
}

export function policyGitPushAllowed(args, { root, currentBranch, cwd = root, home = os.homedir() }) {
  const inv = parseGitInvocation(args);
  if (inv.sub !== 'push') return false;
  if (isProtectedBranch(currentBranch)) return false;
  if (!policyBranchAllowed(currentBranch)) return false;
  if (!policyGitSafetyContext(root, { cwd, home })) return false;
  if (inv.globalOpts || inv.hasConfig) return false;
  if (!originIsProjectRepository(root, { cwd, home })) return false;
  if (!gitPushMappingConfigSafe(root, { cwd, home })) return false;
  const rest = inv.rest;
  const flags = rest.filter(a => a.startsWith('-'));
  const pos = rest.filter(a => a !== '' && !a.startsWith('-'));
  const force = flags.some(a => a === '--force' || a === '-f' || a === '--force-with-lease' || shortFlagHas(a, 'f'))
    || pos.some(a => a.startsWith('+'));
  if (force) return false;
  if (flags.some(a => ['--mirror', '--prune', '--delete', '-d', '--all'].includes(a))) return false;
  if (pos.some(a => a.startsWith('+') || a.includes(':'))) return false;
  if (flags.some(f => !['-u', '--set-upstream'].includes(f))) return false;
  if (flags.some(f => f === '-u' || f === '--set-upstream')) return false;
  if (pos.length === 0) return false;
  if (pos.length === 1) return false;
  if (pos.length > 2) return false;
  if (pos[0] !== 'origin') return false;
  const branchWord = pos[1];
  if (!PLAIN_REF.test(branchWord) || branchWord.includes(':') || branchWord.startsWith('+')) return false;
  return pushTargetAllowed(branchWord, currentBranch);
}

const SWITCH_BLOCK = new Set(['-f', '--force', '-B', '-C', '--discard-changes', '--orphan', '--merge', '-m', '--detach', '-d']);
const SWITCH_CREATE = new Set(['-b', '-c', '--create']);

export function isCleanWorkingTree(root, { cwd = root, home = os.homedir() } = {}) {
  try {
    const out = policyGitExec(root, ['status', '--porcelain'], { cwd, home }).trim();
    return out === '';
  } catch {
    return false;
  }
}

export function policyGitSwitchAllowed(args, { root, currentBranch, cwd = root, home = os.homedir() }) {
  const inv = parseGitInvocation(args);
  if (inv.sub !== 'switch') return false;
  if (inv.globalOpts || inv.hasConfig) return false;
  if (!policyGitSafetyContext(root, { cwd, home })) return false;
  if (!isCleanWorkingTree(root, { cwd, home })) return false;
  const rest = inv.rest;
  if (rest.includes('--')) return false;
  const flags = rest.filter(a => a.startsWith('-') && a !== '--');
  const create = flags.some(f => SWITCH_CREATE.has(f) || (!f.startsWith('--') && f.slice(1).split('').some(ch => ch === 'b' || ch === 'c')));
  if (create) {
    if (flags.length !== 1) return false;
    const f0 = flags[0].split('=')[0];
    if (!SWITCH_CREATE.has(f0) && f0 !== '-b' && f0 !== '-c') return false;
  } else if (flags.length > 0) return false;
  const plain = rest.filter(a => a && !a.startsWith('-'));
  if (create) {
    if (plain.length !== 1) return false;
    const name = plain[0];
    if (!PLAIN_REF.test(name) || isProtectedBranch(name) || !policyBranchAllowed(name)) return false;
    return gitWorktreePolicyContext(root, { cwd, home }).ok;
  }
  if (plain.length !== 1) return false;
  const ref = plain[0];
  if (!PLAIN_REF.test(ref) || ref.includes('..') || ref === '.' || ref === '-') return false;
  if (isProtectedBranch(ref) || !policyBranchAllowed(ref)) return false;
  return gitWorktreePolicyContext(root, { cwd, home }).ok;
}

export function policyGitSwitchCheckoutAllowed(args, opts) {
  const inv = parseGitInvocation(args);
  if (inv.sub === 'checkout') return false;
  return policyGitSwitchAllowed(args, opts);
}

export function policyGitWorktreeAllowed() {
  return false;
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

function worktreeIsClean(rawPath, { root, home }) {
  try {
    let p = String(rawPath ?? '');
    if (!path.isAbsolute(p)) p = path.resolve(root, p);
    const real = fs.realpathSync.native(p);
    const out = policyGitExec(root, ['status', '--porcelain'], { cwd: real, home }).trim();
    return out === '';
  } catch {
    return false;
  }
}

export function policyGitRestoreDenied(args) {
  const inv = parseGitInvocation(args);
  if (inv.sub === 'restore' || inv.sub === 'clean' || inv.sub === 'reset') return true;
  if (inv.sub === 'checkout') return true;
  return false;
}

function scratchBase(home = os.homedir()) {
  return path.join(home, '.project-swarm-scratch');
}

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
    const gitCommon = policyGitExec(root, ['rev-parse', '--git-common-dir'], { cwd: cwdReal, home }).trim();
    const commonAbs = path.isAbsolute(gitCommon) ? gitCommon : path.join(cwdReal, gitCommon);
    const commonReal = fs.realpathSync.native(commonAbs);
    const mainRoot = path.dirname(commonReal);
    if (cwdReal === mainRoot || cwdReal.startsWith(`${mainRoot}${path.sep}`)) return { ok: true };
    if (scratch && (mainRoot.startsWith(`${scratch}${path.sep}`) || mainRoot === scratch)) return { ok: true };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export function policyGitSubBlockedDuringWindow(sub) {
  return sub === 'remote' || sub === 'config';
}

export function policyGitInvocationRule(args, opts) {
  const inv = parseGitInvocation(args);
  if (!inv.sub) return null;
  if (policyGitRestoreDenied(args)) return { rule: 'git-deny-restore', ok: false };
  const sub = inv.sub;
  if (policyGitSubBlockedDuringWindow(sub)) return { rule: `git-${sub}`, ok: false };
  if (POLICY_READ_GIT_SUBS.has(sub) && policyGitReadAllowed(args, opts)) return { rule: `git-${sub}`, ok: true };
  if (sub === 'add' && policyGitAddAllowed(args, opts)) return { rule: 'git-add', ok: true };
  if (sub === 'commit' && policyGitCommitAllowed(args, opts)) return { rule: 'git-commit', ok: true };
  if (sub === 'push' && policyGitPushAllowed(args, opts)) return { rule: 'git-push', ok: true };
  if (sub === 'switch' && policyGitSwitchAllowed(args, opts)) return { rule: 'git-switch', ok: true };
  if (['commit', 'push', 'switch', 'add', 'status', 'diff', 'log', 'worktree', 'checkout', 'remote', 'config'].includes(sub)) {
    return { rule: `git-${sub}`, ok: false };
  }
  return null;
}
