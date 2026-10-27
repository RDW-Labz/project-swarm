// SPDX-License-Identifier: Apache-2.0
// Orchestrator-mode allow rules. Called from tools/shell-writes.mjs and tools/handbuild.mjs.

import fs from 'node:fs';
import path from 'node:path';

const ORCHESTRATOR_OWN_PREFIXES = Object.freeze(['.swarm/', 'docs/plans/']);

const ORCHESTRATOR_OWN_CODE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'py', 'pyi', 'sh', 'bash', 'zsh', 'rb', 'pl', 'php',
]);

const ORCHESTRATOR_OWN_TEST_DIR_NAMES = new Set(['test', 'tests', 'spec', 'specs', '__tests__']);

const ORCHESTRATOR_OWN_WRITE_GUARD_SKIP_PREFIXES = [
  '.swarm/workspaces/',
  '.swarm/worktrees/',
  '.swarm/runs/',
  '.swarm/backups/',
  '.swarm/orchestrator-mode/',
];

const ORCHESTRATOR_TEXT_EXTENSIONS = Object.freeze(['md', 'json', 'jsonl', 'ndjson', 'yaml', 'yml']);

/** Default-deny write allow-list for orchestrator mode (folder prefix, extensions, denied subtrees). */
export const ORCHESTRATOR_WRITE_RULES = Object.freeze([
  {
    comment: 'Swarm ledger and metadata under .swarm (never workspaces, worktrees, runs, backups, or orchestrator-mode).',
    folderPrefix: '.swarm/',
    extensions: ORCHESTRATOR_TEXT_EXTENSIONS,
    denySubfolders: ORCHESTRATOR_OWN_WRITE_GUARD_SKIP_PREFIXES,
  },
  {
    comment: 'Plans and ideas at any depth under docs/plans/.',
    folderPrefix: 'docs/plans/',
    extensions: ORCHESTRATOR_TEXT_EXTENSIONS,
    denySubfolders: [],
  },
  {
    comment: 'Job manifests (JSON) for swarm run, integrate, and go.',
    folderPrefix: 'coordination/manifests/',
    extensions: ['json'],
    denySubfolders: [],
  },
  {
    comment: 'Handoff notes: coordination/HANDOFF*.md only (not TASK.md or other coordination files).',
    folderPrefix: 'coordination/',
    extensions: ['md'],
    denySubfolders: [],
    basenamePrefix: 'handoff',
  },
  {
    comment: 'Usage ledger and orchestrator state markdown under docs/state/.',
    folderPrefix: 'docs/state/',
    extensions: ['md'],
    denySubfolders: [],
  },
  {
    comment: 'Active goal TASK.md at the repository root (not coordination/TASK.md).',
    folderPrefix: '',
    extensions: ['md'],
    denySubfolders: [],
    exactBasename: 'task.md',
  },
]);

const normPosixRel = normRel => String(normRel ?? '').replace(/\\/g, '/').toLowerCase();

const extSet = exts => new Set(exts.map(e => String(e).toLowerCase()));

const ruleMatchesRel = (rule, norm) => {
  const prefix = String(rule.folderPrefix ?? '').toLowerCase();
  if (prefix) {
    if (!(norm === prefix.slice(0, -1) || norm.startsWith(prefix))) return false;
  } else if (norm.includes('/')) return false;
  const deny = rule.denySubfolders ?? [];
  if (deny.some(p => {
    const d = String(p).toLowerCase();
    return norm === d.slice(0, -1) || norm.startsWith(d);
  })) return false;
  const base = norm.split('/').filter(Boolean).pop() ?? '';
  if (rule.exactBasename && base !== String(rule.exactBasename).toLowerCase()) return false;
  if (rule.basenamePrefix) {
    const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
    if (!stem.startsWith(String(rule.basenamePrefix).toLowerCase())) return false;
  }
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  if (/^package\.json$/i.test(base)) return false;
  const allowed = extSet(rule.extensions ?? []);
  return ext && allowed.has(ext);
};

/** Nested project markers and secret paths orchestrator sessions must never create (root `.swarm/` stays under allow-list rules). */
export function orchestratorWriteMarkerDeniedRel(normRel) {
  const norm = normPosixRel(normRel);
  if (!norm) return false;
  const parts = norm.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === '.swarm' && i > 0) return true;
    if (parts[i] === '.project-swarm.json' && (parts.length > 1 || i > 0)) return true;
  }
  if (parts[0] === '.swarm' && parts.slice(1).includes('.swarm')) return true;
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] !== '.claude') continue;
    for (let j = i + 1; j < parts.length; j += 1) {
      const base = parts[j];
      if (base === '.env' || base === '.envrc' || base === 'settings.json') return true;
    }
  }
  return false;
}

/** True when the hook session cwd is the project root (required for swarm CLI in orchestrator mode). */
export function orchestratorSwarmSessionCwdOk(projectRoot, cwd) {
  if (!projectRoot || !cwd) return false;
  try {
    return fs.realpathSync.native(projectRoot) === fs.realpathSync.native(cwd);
  } catch {
    return false;
  }
}

/** True when a normalized project-relative path may be written in orchestrator mode. */
export function orchestratorWriteAllowedRel(normRel) {
  const norm = normPosixRel(normRel);
  if (!norm) return false;
  if (orchestratorWriteMarkerDeniedRel(norm)) return false;
  if (/^package\.json$/i.test(norm.split('/').pop() ?? '') || norm.endsWith('/package.json')) return false;
  return ORCHESTRATOR_WRITE_RULES.some(rule => ruleMatchesRel(rule, norm));
}

const projectRelOfAbs = (abs, projectRoot) => {
  let rootReal;
  try {
    rootReal = fs.realpathSync.native(projectRoot);
  } catch {
    return null;
  }
  const tail = [];
  let cur = abs;
  let resolved = abs;
  for (let i = 0; i < 64; i += 1) {
    try {
      resolved = path.join(fs.realpathSync.native(cur), ...tail);
      break;
    } catch {
      tail.unshift(path.basename(cur));
      const up = path.dirname(cur);
      if (up === cur) {
        resolved = path.resolve(abs);
        break;
      }
      cur = up;
    }
  }
  const rel = path.relative(rootReal, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/').toLowerCase();
};

/** Project-relative posix path to the swarm worker tree when `cwd` is inside `.swarm/workspaces/` or `.swarm/worktrees/`. */
export function swarmWorkerTreeRel(root, cwd) {
  if (!root || !cwd) return null;
  try {
    const rootReal = fs.realpathSync.native(root);
    const cwdReal = fs.realpathSync.native(cwd);
    const rel = path.relative(rootReal, cwdReal);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const norm = rel.split(path.sep).join('/').toLowerCase();
    const m = norm.match(/^(\.swarm\/(?:workspaces|worktrees)\/[^/]+(?:\/[^/]+)*)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * True when orchestrator-mode write allow-list should decide this project-relative path.
 * Skips verified worker sessions (scoped separately) and paths outside the project (no rel).
 */
export function orchestratorWriteAllowListAppliesRel(normRel, root, cwd, isVerifiedWorker = false) {
  if (isVerifiedWorker) return false;
  const norm = normPosixRel(normRel);
  if (!norm) return false;
  return true;
}

const WORKER_ALWAYS_DENIED_PREFIXES = [
  '.swarm/handbuild/',
  '.swarm/orchestrator-mode/',
  '.swarm/runs/',
  '.swarm/backups/',
];

/** Paths every session (including verified workers) must not write. */
export function workerSessionProtectedRel(normRel) {
  const norm = normPosixRel(normRel);
  if (!norm) return false;
  if (norm === '.swarm/handbuild' || norm.startsWith('.swarm/handbuild/')) return true;
  if (norm === '.swarm/orchestrator-mode' || norm.startsWith('.swarm/orchestrator-mode/')) return true;
  if (norm === '.swarm/orchestrator-mode/off') return true;
  if (norm === '.git' || norm.startsWith('.git/')) return true;
  if (WORKER_ALWAYS_DENIED_PREFIXES.some(p => norm === p.slice(0, -1) || norm.startsWith(p))) return true;
  return false;
}

const absInsideWorkspace = (absPath, root, workspaceReal) => {
  let targetReal;
  try {
    targetReal = fs.realpathSync.native(absPath);
  } catch {
    try {
      const parent = fs.realpathSync.native(path.dirname(absPath));
      targetReal = path.join(parent, path.basename(absPath));
    } catch {
      return false;
    }
  }
  let wsReal;
  try {
    wsReal = fs.realpathSync.native(workspaceReal);
  } catch {
    return false;
  }
  if (targetReal === wsReal) return true;
  return targetReal.startsWith(`${wsReal}${path.sep}`);
};

/** True when a verified worker must not write this project-relative path. */
export function workerWriteTargetDenied(normRel, root, workspaceReal) {
  const norm = normPosixRel(normRel);
  if (!norm) return true;
  if (workerSessionProtectedRel(norm)) return true;
  const candidate = path.isAbsolute(normRel) ? normRel : path.join(root, normRel);
  return !absInsideWorkspace(candidate, root, workspaceReal);
}

/** True when an absolute or project-relative path may be written (resolves symlinks; default deny). */
export function orchestratorWriteAllowed(realPath, projectRoot) {
  if (!realPath || !projectRoot) return false;
  const candidate = path.isAbsolute(realPath) ? realPath : path.join(projectRoot, realPath);
  try {
    const lst = fs.lstatSync(candidate);
    if (lst.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(candidate);
      const resolved = path.resolve(path.dirname(candidate), linkTarget);
      if (!orchestratorWriteAllowed(resolved, projectRoot)) return false;
    }
  } catch { /* missing path: resolve below */ }
  const rel = projectRelOfAbs(candidate, projectRoot);
  if (rel === null) return false;
  return orchestratorWriteAllowedRel(rel);
}

/** Project-relative folder prefixes scanned for stray code/tests before bare test runs. */
export function orchestratorBareTestScanRelPrefixes() {
  const prefixes = [];
  for (const rule of ORCHESTRATOR_WRITE_RULES) {
    const p = String(rule.folderPrefix ?? '').toLowerCase();
    if (p) prefixes.push(p);
  }
  return prefixes;
}

/** Orchestrator-mode bare-test scan applies under allow-list roots (except swarm-managed subtrees). */
export function orchestratorOwnWriteGuardRel(normRel) {
  const norm = normPosixRel(normRel);
  if (ORCHESTRATOR_OWN_WRITE_GUARD_SKIP_PREFIXES.some(p => norm === p.slice(0, -1) || norm.startsWith(p))) {
    return false;
  }
  return ORCHESTRATOR_WRITE_RULES.some(rule => {
    const prefix = String(rule.folderPrefix ?? '').toLowerCase();
    if (!prefix) return false;
    return norm === prefix.slice(0, -1) || norm.startsWith(prefix);
  });
}

const ORCHESTRATOR_OWN_JS_TEST = /\.(test|spec)\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/i;
const ORCHESTRATOR_OWN_PYTEST_INI = /^pytest\.(ini|cfg)$/i;
const ORCHESTRATOR_OWN_RUNNER_CONFIG = [
  /^vitest\.config\./i,
  /^vitest\.workspace\./i,
  /^playwright\.config\./i,
  /^jest\.config\./i,
  /^tox\.ini$/i,
  /^pyproject\.toml$/i,
  /^setup\.cfg$/i,
  /^\.mocharc(\.|$)/i,
  /^mocha\.opts$/i,
];

/** True when a project-relative path (posix, lower) is under orchestrator-owned folders. */
export function orchestratorOwnRel(normRel) {
  const norm = String(normRel ?? '').replace(/\\/g, '/').toLowerCase();
  return ORCHESTRATOR_OWN_PREFIXES.some(prefix => norm === prefix.slice(0, -1) || norm.startsWith(prefix));
}

const basenameStemExt = basename => {
  const name = path.basename(String(basename ?? ''));
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return { name, lower, stem: lower, ext: '' };
  return { name, lower, stem: lower.slice(0, dot), ext: lower.slice(dot + 1) };
};

/** True when a basename is executable/code or test-runner config under orchestrator-owned folders. */
export function orchestratorOwnForbiddenWriteBasename(basename) {
  const { name, lower, stem, ext } = basenameStemExt(basename);
  if (!name) return false;
  if (ORCHESTRATOR_OWN_JS_TEST.test(name)) return true;
  if (/^package\.json$/i.test(name)) return true;
  if (ORCHESTRATOR_OWN_PYTEST_INI.test(name) || ORCHESTRATOR_OWN_RUNNER_CONFIG.some(re => re.test(name))) {
    return true;
  }
  if (ext && ORCHESTRATOR_OWN_CODE_EXTS.has(ext)) return true;
  if (stem === 'conftest' || stem === 'makefile' || stem === 'dockerfile' || lower === 'makefile' || lower === 'dockerfile') {
    return true;
  }
  if (/^test/i.test(stem) || /test$/i.test(stem)) return true;
  if (/\.py$/i.test(name)) {
    if (/^test_/i.test(stem) || /_test$/i.test(stem) || stem === 'conftest') return true;
  }
  return false;
}

/** Test or test-runner artifacts the orchestrator must not create under orchestrator-owned folders. */
export function orchestratorOwnForbiddenTestOrRunnerBasename(basename) {
  return orchestratorOwnForbiddenWriteBasename(basename);
}

/** True when a path under bare-test scan roots is not an allow-listed write (code/tests backstop). */
export function orchestratorOwnForbiddenWriteRel(normRel) {
  const norm = normPosixRel(normRel);
  if (!orchestratorOwnWriteGuardRel(norm)) return false;
  const parts = norm.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (ORCHESTRATOR_OWN_TEST_DIR_NAMES.has(parts[i])) return true;
  }
  const base = parts[parts.length - 1] ?? '';
  if (orchestratorOwnForbiddenWriteBasename(base)) return true;
  if (orchestratorWriteAllowedRel(norm)) return false;
  const { ext } = basenameStemExt(base);
  if (!ext) return false;
  return true;
}

export const OM_SWARM_DENIED_TOP = new Set(['init', 'mutants', 'mutant', 'scaffold', 'eval', 'shell', 'exec']);

// Swarm CLI subcommands are allowed by default except owner-only self-approval (decide, handbuild approve/on/off,
// scope approve, tickets approve, resolve, done, restore, with-concurrency) and bypass flags (--yes/--force/--accept*
// outside vetted ticket edit forms).
export const OM_SWARM_ALLOWED_TOP = new Set([
  'status', 'brief', 'board', 'watch', 'jobs', 'tickets', 'run', 'integrate', 'merge', 'update', 'note',
  'version', 'doctor', 'rollup', 'scope', 'msg', 'diagnose', 'go', 'change', 'handbuild', 'ticket', 'ask',
  'decision', 'handoff', 'lesson', 'backlog', 'time',
  'resume', 'cancel', 'inbox', 'queue', 'think', 'digest', 'validate', 'preflight', 'history', 'usage',
  'budget', 'budgets', 'lanes', 'projects', 'orphans',
]);

const HANDBUILD_OWNER_VERBS = new Set(['approve', 'deny', 'on', 'off', 'install', 'uninstall']);
const SWARM_HANDBUILD_FILE_OPS = new Set(['request', 'status', 'show', 'list', 'log', 'check', 'help']);

const HELP_FLAGS = new Set(['-h', '--help', '--version']);

const READONLY_GIT_SUBS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse']);

const GH_READONLY_SUBS = new Set([
  'pr view', 'pr list', 'pr checks', 'pr diff',
  'run view', 'run list',
  'issue view', 'issue list',
]);

const READONLY_BINARIES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail', 'wc', 'ls']);

const NPM_TEST_RUNS = new Set(['test', 'test:e2e', 'test:unit']);

const WRITER_BINARIES = new Set([
  'rm', 'touch', 'tee', 'cp', 'mv', 'mkdir', 'truncate', 'chmod', 'chown', 'install',
  'sed', 'curl', 'wget', 'tar', 'zip', 'unzip', 'dd', 'shred', 'nano', 'vim', 'vi', 'emacs',
]);

const TEST_RUNNER_DENIED_FLAGS = new Set([
  '-c', '--config', '--globalSetup', '--globalTeardown', '--setupFiles', '--outputFile', '--output',
  '-u', '--update', '--update-snapshots', '--ui', '--root', '--rootdir', '--dir', '--require', '-r', '--import',
  '--eval', '-e', '-p', '--loader', '--headed', '--package',
]);

const TEST_RUNNER_DENIED_PREFIXES = ['--config=', '--globalSetup=', '--globalTeardown=', '--setupFiles=', '--outputFile=', '--output=', '--root=', '--rootdir=', '--dir=', '--require=', '--import=', '--package='];

const TEST_REPORTER_NAMES = new Set(['line', 'list', 'dot', 'json', 'html']);

const TEST_FLAG_VALUE = new Set([
  '-t', '--grep', '-g', '--project', '--workers', '--retries', '--timeout', '--maxfail', '--reporter',
]);

const TEST_FLAG_ALONE = new Set([
  '-x', '--bail', '-k', '-m', '-q', '-v',
]);

const SCOPE_READONLY_VERBS = new Set(['show', 'list', 'status', 'read', 'check', 'help']);
const DECIDE_READONLY_VERBS = new Set(['show', 'list', 'status', 'read', 'check', 'help']);

export const OM_SWARM_RUN_FLAGS = new Set([
  '--lane', '--ticket', '--job', '--run', '--worktree', '--no', '--dry-run', '--json', '--quiet', '-q', '-j',
  '--queue', '--no-checks', '--no-commit', '--jobs', '--skip-skeleton', '--scope', '--max-jobs', '--wave',
  '--max-waves',
]);

const OM_SWARM_RUN_FLAGS_WITH_VALUE = new Set([
  '--lane', '--ticket', '--job', '--run', '--worktree', '--jobs', '--max-jobs', '--max-waves',
]);

const TICKET_YES_PAIR_FLAGS = new Set([
  '--set', '--release', '--add-acceptance', '--acceptance', '--context', '--files',
]);

const SWARM_TICKET_DENIED_FLAGS = new Set([
  '--delivered', '--take-from', '--deletes', '--mark-deps', '--accept',
]);

const SWARM_TICKET_ALLOWED_FLAGS = new Set([
  '--retry-note', '--note', '--files', '--context', '--acceptance', '--add-acceptance', '--status',
  '--kind', '--stage', '--type', '--risk', '--json', '--release', '--question', '--reopen', '--reason',
  '--set', '--help', '-h',
]);

const swarmArgTokens = rest => rest.map(w => String(w).toLowerCase());

const swarmArgsHaveYes = rest => {
  const lower = swarmArgTokens(rest);
  return lower.some(a => a === '--yes' || a.startsWith('--yes=') || a === '-y');
};

const swarmArgsHaveApprove = rest => {
  const lower = swarmArgTokens(rest);
  return lower.some(a => a === 'approve' || a === '--approve' || a.startsWith('--approve='));
};

const swarmArgsHaveForceBypass = rest => {
  for (const a of rest) {
    const low = String(a).toLowerCase();
    if (low === '--force' || low.startsWith('--force=')) return true;
    if (low === '--force-unsafe' || low.startsWith('--force-unsafe=')) return true;
    if (low === '-f') return true;
  }
  return false;
};

const swarmArgsHaveOwnerOverrideFlags = rest => {
  for (const a of rest) {
    const low = String(a).toLowerCase();
    if (low === '--no-guard' || low.startsWith('--no-guard=')) return true;
    if (low.startsWith('--accept-')) return true;
    if (low.startsWith('--allow-')) return true;
  }
  return false;
};

const swarmTicketsYesVetted = rest => {
  const lower = swarmArgTokens(rest);
  return lower.some(a => TICKET_YES_PAIR_FLAGS.has(a) || TICKET_YES_PAIR_FLAGS.has(a.split('=')[0]));
};

const swarmTicketsSetDone = rest => {
  const lower = swarmArgTokens(rest);
  for (let i = 0; i < lower.length; i += 1) {
    const a = lower[i];
    if (a === '--set' && lower[i + 1] === 'done') return true;
    if (a.startsWith('--set=') && a.slice('--set='.length) === 'done') return true;
  }
  return false;
};

const swarmTicketFlagName = a => {
  const low = String(a).toLowerCase();
  const eq = low.indexOf('=');
  return eq === -1 ? low : low.slice(0, eq);
};

const swarmTicketsFlagsOk = rest => {
  const lower = swarmArgTokens(rest);
  if (lower.includes('--reopen') && !lower.includes('--reason')) return false;
  let i = 0;
  while (i < rest.length) {
    const a = String(rest[i]);
    if (!a.startsWith('-')) {
      i += 1;
      continue;
    }
    const name = swarmTicketFlagName(a);
    if (name === '--yes' || name === '-y' || name.startsWith('--yes=')) {
      i += 1;
      continue;
    }
    if (SWARM_TICKET_DENIED_FLAGS.has(name)) return false;
    if (!SWARM_TICKET_ALLOWED_FLAGS.has(name)) return false;
    if (name === '--set') {
      const val = a.includes('=')
        ? a.slice(a.indexOf('=') + 1)
        : String(rest[i + 1] ?? '');
      const v = String(val).toLowerCase();
      if (v === 'done' || v === 'delivered') return false;
      if (!a.includes('=')) i += 2;
      else i += 1;
      continue;
    }
    const needsValue = new Set([
      '--retry-note', '--note', '--files', '--context', '--acceptance', '--add-acceptance', '--status',
      '--kind', '--stage', '--type', '--risk', '--release', '--question', '--reason',
    ]);
    if (needsValue.has(name) && !a.includes('=')) {
      if (i + 1 >= rest.length) return false;
      i += 2;
      continue;
    }
    i += 1;
  }
  return true;
};

const omSwarmInboxAllowed = rest => {
  const lower = swarmArgTokens(rest);
  const pos = lower.filter(a => a !== '' && !a.startsWith('-'));
  if (pos.length === 0) return true;
  return pos.length === 1 && pos[0] === 'list';
};

const omSwarmOrphansAllowed = rest => {
  const lower = swarmArgTokens(rest);
  const pos = lower.filter(a => a !== '' && !a.startsWith('-'));
  if (pos.length === 0) return true;
  return pos.length === 1 && pos[0] === 'list';
};

const omSwarmRunIntegrateFlagsOk = rest => {
  let i = 0;
  while (i < rest.length) {
    const a = String(rest[i]);
    const low = a.toLowerCase();
    const eq = low.indexOf('=');
    const name = eq === -1 ? low : low.slice(0, eq);
    if (OM_SWARM_RUN_FLAGS.has(name) || OM_SWARM_RUN_FLAGS.has(a)) {
      if (eq === -1 && OM_SWARM_RUN_FLAGS_WITH_VALUE.has(a)) {
        if (i + 1 >= rest.length) return false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (a.startsWith('-')) return false;
    i += 1;
  }
  return true;
};

const omSwarmScopeReadOnly = rest => {
  if (swarmArgsHaveYes(rest)) return false;
  const lower = rest.map(w => String(w).toLowerCase());
  const verb = lower.find(a => a !== '' && !a.startsWith('-'));
  if (!verb || SCOPE_READONLY_VERBS.has(verb)) return true;
  return false;
};

const omSwarmDecideReadOnly = rest => {
  if (swarmArgsHaveYes(rest)) return false;
  const lower = rest.map(w => String(w).toLowerCase());
  if (lower.some(a => a === 'approve' || a === 'deny')) return false;
  const verb = lower.find(a => a !== '' && !a.startsWith('-'));
  if (!verb) return true;
  return DECIDE_READONLY_VERBS.has(verb);
};

const omSwarmRunLikeAllowed = (sub, rest) => {
  if (!['run', 'integrate', 'merge', 'update', 'go'].includes(sub)) return true;
  const lower = rest.map(w => String(w).toLowerCase());
  if (sub === 'merge') return lower.length === 1 && /^\d+$/.test(lower[0]);
  if (sub === 'update') return lower.length === 0;
  if (sub === 'go') {
    const pos = rest.filter(a => a !== '' && !String(a).startsWith('-'));
    if (!pos.every(a => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(a)))) return false;
    return omSwarmRunIntegrateFlagsOk(rest);
  }
  if (sub === 'run' || sub === 'integrate') {
    const pos = rest.filter(a => a !== '' && !String(a).startsWith('-'));
    if (!pos.every(a => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(a)))) return false;
    return omSwarmRunIntegrateFlagsOk(rest);
  }
  return false;
};

const omSwarmTicketsAllowed = rest => {
  if (swarmArgsHaveApprove(rest) || swarmArgsHaveForceBypass(rest)) return false;
  if (swarmArgsHaveOwnerOverrideFlags(rest)) return false;
  if (!swarmTicketsFlagsOk(rest)) return false;
  if (swarmTicketsSetDone(rest)) return false;
  if (swarmArgsHaveYes(rest) && !swarmTicketsYesVetted(rest)) return false;
  return true;
};

/** Swarm subcommand allow rules after global flags (--root) are validated in shell-writes.mjs. */
export function swarmSubcommandAlwaysAllowed(sub, rest) {
  const s = String(sub ?? '').toLowerCase();
  if (!s || OM_SWARM_DENIED_TOP.has(s)) return false;
  if (!OM_SWARM_ALLOWED_TOP.has(s)) return false;
  if (s === 'restore') return false;
  if (swarmArgsHaveApprove(rest)) return false;
  if (swarmArgsHaveForceBypass(rest)) return false;
  if (swarmArgsHaveOwnerOverrideFlags(rest)) return false;
  if (s === 'backup') {
    const verb = String(rest[0] ?? '').toLowerCase();
    if (verb === 'restore') return false;
  }
  if (s === 'handbuild') {
    const verb = String(rest[0] ?? '').toLowerCase();
    if (!verb || verb === '--help' || verb.startsWith('-')) return true;
    if (HANDBUILD_OWNER_VERBS.has(verb)) return false;
    return SWARM_HANDBUILD_FILE_OPS.has(verb);
  }
  if (s === 'change') {
    return !swarmArgsHaveYes(rest);
  }
  if (s === 'decide') return false;
  if (s === 'scope') return omSwarmScopeReadOnly(rest);
  if (s === 'budget' || s === 'budgets') {
    const verb = rest.find(a => a !== '' && !String(a).startsWith('-'));
    if (verb !== undefined && String(verb).toLowerCase() !== 'show') return false;
  }
  if (s === 'tickets') return omSwarmTicketsAllowed(rest);
  if (s === 'inbox') return omSwarmInboxAllowed(rest);
  if (s === 'orphans') return omSwarmOrphansAllowed(rest);
  if (swarmArgsHaveYes(rest)) return false;
  if (!omSwarmRunLikeAllowed(s, rest)) return false;
  return true;
}

const trailingHelpToken = words => {
  if (!words?.length) return null;
  const last = String(words[words.length - 1]);
  return HELP_FLAGS.has(last) ? last : null;
};

const swarmArgsWithoutHelp = args => {
  const last = args[args.length - 1];
  if (last !== undefined && HELP_FLAGS.has(String(last))) return args.slice(0, -1);
  return args;
};

const swarmHelpSubcommandOk = args => {
  let i = 0;
  while (i < args.length) {
    const a = String(args[i]);
    const low = a.toLowerCase();
    if (low === '--root') {
      if (i + 1 >= args.length) return false;
      i += 2;
      continue;
    }
    if (low.startsWith('--root=')) {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) return false;
    break;
  }
  const sub = String(args[i] ?? '').toLowerCase();
  const rest = args.slice(i + 1);
  return swarmSubcommandAlwaysAllowed(sub, rest);
};

/** True when --help, -h, or --version is the last token and the command shape is safe (macOS stops flags at the first filename). */
export function helpOnly(words) {
  if (!trailingHelpToken(words)) return false;
  const base = words.slice(0, -1);
  if (base.length < 1) return false;
  const rawCmd = String(base[0]);
  const cmd = path.basename(rawCmd);
  const args = base.slice(1);
  if (WRITER_BINARIES.has(cmd)) {
    const pos = args.filter(a => a !== '' && !String(a).startsWith('-'));
    if (pos.length > 0) return false;
  }
  if (cmd === 'node') {
    const scriptAt = args.findIndex(a => a !== '' && !String(a).startsWith('-'));
    if (scriptAt === -1) return false;
    const script = String(args[scriptAt]);
    if (!script.endsWith('swarm.mjs')) return false;
    return swarmHelpSubcommandOk(args.slice(scriptAt + 1));
  }
  if (cmd === 'swarm') return swarmHelpSubcommandOk(args);
  return readOnlyCommandAllowed(base);
}

const ghReadonlySub = pos => {
  if (pos.length >= 2) {
    const sub = `${pos[0]} ${pos[1]}`;
    if (GH_READONLY_SUBS.has(sub)) return true;
  }
  return false;
};

/** Read-only command shapes (operand safety and pipe caps enforced in shell-writes.mjs). */
export function readOnlyCommandAllowed(words) {
  if (!words?.length) return false;
  const rawCmd = String(words[0]);
  const cmd = path.basename(rawCmd);
  const args = words.slice(1);
  if (cmd === 'git') {
    if (!args.length || args[0].startsWith('-')) return false;
    const sub = args[0];
    if (!READONLY_GIT_SUBS.has(sub)) return false;
    if (sub === 'branch') {
      return args.some(a => a === '--list' || a === '-l');
    }
    return true;
  }
  if (cmd === 'gh') {
    const GH_READ_FLAGS = new Set(['--json', '--jq', '--template', '--limit', '--app', '--hostname', '-q', '-t']);
    const pos = [];
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (!a.startsWith('-')) { pos.push(a); i += 1; continue; }
      if (a === '-R' || a === '--repo' || a === '--repository') { i += 2; continue; }
      if (a.startsWith('--repo=') || a.startsWith('--repository=')) { i += 1; continue; }
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (GH_READ_FLAGS.has(name) || name.startsWith('--jq=') || name.startsWith('--template=')) {
        i += eq === -1 ? 2 : 1;
        continue;
      }
      return false;
    }
    return ghReadonlySub(pos);
  }
  if (READONLY_BINARIES.has(cmd)) return true;
  return false;
}

const testRunnerFlagDenied = a => {
  const s = String(a);
  if (TEST_RUNNER_DENIED_FLAGS.has(s)) return true;
  return TEST_RUNNER_DENIED_PREFIXES.some(p => s.startsWith(p));
};

const testRunnerFlagsOk = args => {
  let i = 0;
  while (i < args.length) {
    const a = String(args[i]);
    if (testRunnerFlagDenied(a)) return false;
    if (a.startsWith('--reporter=')) {
      const v = a.slice('--reporter='.length);
      if (!TEST_REPORTER_NAMES.has(v)) return false;
      i += 1;
      continue;
    }
    if (TEST_FLAG_VALUE.has(a)) {
      if (i + 1 >= args.length) return false;
      if (a === '--reporter' && !TEST_REPORTER_NAMES.has(String(args[i + 1]))) return false;
      i += 2;
      continue;
    }
    if (TEST_FLAG_ALONE.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      if (a.length === 2 && TEST_FLAG_ALONE.has(a)) {
        i += 1;
        continue;
      }
      if (/^-[kmqxv]+$/.test(a)) {
        i += 1;
        continue;
      }
      return false;
    }
    i += 1;
  }
  return true;
};

const positionalOperandsOk = (args, ctx) => {
  const operandOk = ctx?.testOperandOk ?? ctx?.inProject;
  if (!operandOk) return true;
  for (const a of args) {
    if (!a || String(a).startsWith('-')) continue;
    if (!operandOk(a)) return false;
  }
  return true;
};

const packageRunnerTool = (cmd, args) => {
  if (cmd !== 'npx' && cmd !== 'pnpm' && cmd !== 'yarn') return null;
  let i = 0;
  if (cmd === 'npx') {
    for (let j = 0; j < args.length; j += 1) {
      if (String(args[j]).startsWith('-')) return null;
      i = j;
      break;
    }
  } else {
    while (i < args.length && String(args[i]).startsWith('-')) i += 1;
    if (args[i] === 'exec') i += 1;
  }
  const tool = String(args[i] ?? '');
  if (!tool || tool.startsWith('-')) return null;
  return { tool, rest: args.slice(i + 1) };
};

const npmScriptAllowed = (scriptName, ctx) => {
  if (!NPM_TEST_RUNS.has(scriptName)) return false;
  const scripts = ctx?.packageScripts;
  if (!scripts || typeof scripts !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(scripts, scriptName);
};

const npmTestShapeOk = (cmd, args, ctx) => {
  if (cmd !== 'npm' && cmd !== 'pnpm' && cmd !== 'yarn') return false;
  const i = args.findIndex(a => a !== '' && !String(a).startsWith('-'));
  if (i === -1) return false;
  const verb = String(args[i]);
  if (verb === 'test') {
    if (!npmScriptAllowed('test', ctx)) return false;
    return testRunnerFlagsOk(args.slice(i + 1)) && positionalOperandsOk(args.slice(i + 1), ctx);
  }
  if (verb === 'run') {
    const script = String(args[i + 1] ?? '');
    if (!npmScriptAllowed(script, ctx)) return false;
    return testRunnerFlagsOk(args.slice(i + 2)) && positionalOperandsOk(args.slice(i + 2), ctx);
  }
  return false;
};

const pytestArgs = words => {
  const cmd = path.basename(String(words[0]));
  if (cmd === 'pytest') return words.slice(1);
  if (cmd === 'python' || cmd === 'python3') {
    const tail = words.slice(1);
    let i = 0;
    while (i < tail.length && tail[i] === '-I') i += 1;
    if (i >= tail.length || tail[i] !== '-m') return null;
    if (String(tail[i + 1] ?? '') !== 'pytest') return null;
    return tail.slice(i + 2);
  }
  return null;
};

const runnerArgsWithoutVerb = (rest, { implicitRun = false } = {}) => {
  const i = rest.findIndex(a => a !== '' && !String(a).startsWith('-'));
  if (i === -1) return implicitRun ? rest : null;
  const verb = String(rest[i]);
  if (verb !== 'test' && verb !== 'run') return null;
  return [...rest.slice(0, i), ...rest.slice(i + 1)];
};

const playwrightRunnerOk = (cmd, args, ctx) => {
  let rest;
  if (cmd === 'playwright') rest = args;
  else {
    const pkg = packageRunnerTool(cmd, args);
    if (!pkg || pkg.tool !== 'playwright') return false;
    rest = pkg.rest;
  }
  const body = runnerArgsWithoutVerb(rest, { implicitRun: false });
  if (body === null) return false;
  return testRunnerFlagsOk(body) && positionalOperandsOk(body, ctx);
};

const vitestRunnerOk = (cmd, args, ctx) => {
  let rest;
  if (cmd === 'vitest') rest = args;
  else {
    const pkg = packageRunnerTool(cmd, args);
    if (!pkg || pkg.tool !== 'vitest') return false;
    rest = pkg.rest;
  }
  const body = runnerArgsWithoutVerb(rest, { implicitRun: true });
  if (body === null) return false;
  return testRunnerFlagsOk(body) && positionalOperandsOk(body, ctx);
};

const nodeTestRunnerOk = (args, ctx) => {
  if (!args.includes('--test')) return false;
  const testIdx = args.indexOf('--test');
  const before = args.slice(0, testIdx);
  const after = args.slice(testIdx + 1);
  if (before.some(a => String(a).startsWith('-'))) return false;
  return testRunnerFlagsOk(after) && positionalOperandsOk(after, ctx);
};

/** Vitest and Playwright only (orchestrator-mode narrow test-runner allowlist). */
export function orchestratorTestRunAllowed(words, ctx = undefined) {
  if (!words?.length) return false;
  const rawCmd = String(words[0]);
  const cmd = path.basename(rawCmd);
  const args = words.slice(1);
  if (playwrightRunnerOk(cmd, args, ctx)) return true;
  if (vitestRunnerOk(cmd, args, ctx)) return true;
  return false;
}

/** Local test runners (no redirects/tee/sed -i in the same segment; checked in shell-writes). */
export function localTestRunAllowed(words, ctx = undefined) {
  if (!words?.length) return false;
  const rawCmd = String(words[0]);
  const cmd = path.basename(rawCmd);
  const args = words.slice(1);
  if (orchestratorTestRunAllowed(words, ctx)) return true;
  const pyArgs = pytestArgs(words);
  if (pyArgs) return testRunnerFlagsOk(pyArgs) && positionalOperandsOk(pyArgs, ctx);
  if (cmd === 'node') return nodeTestRunnerOk(args, ctx);
  if (npmTestShapeOk(cmd, args, ctx)) return true;
  return false;
}

const looksLikeExplicitTestOperand = raw => {
  const s = String(raw ?? '');
  if (!s || s.startsWith('-')) return false;
  if (s.includes('/') || s.includes('\\')) return true;
  const { ext, lower, stem } = basenameStemExt(s);
  if (ext && ORCHESTRATOR_OWN_CODE_EXTS.has(ext)) return true;
  if (ORCHESTRATOR_OWN_TEST_DIR_NAMES.has(lower)) return true;
  if (/^test/i.test(stem) || /test$/i.test(stem)) return true;
  if (/\.(test|spec)\./i.test(s)) return true;
  return false;
};

const testRunBodyArgs = words => {
  if (!words?.length) return null;
  const rawCmd = String(words[0]);
  const cmd = path.basename(rawCmd);
  const args = words.slice(1);
  const pyArgs = pytestArgs(words);
  if (pyArgs) return pyArgs;
  if (cmd === 'node' && args.includes('--test')) {
    const testIdx = args.indexOf('--test');
    return args.slice(testIdx + 1);
  }
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') {
    const i = args.findIndex(a => a !== '' && !String(a).startsWith('-'));
    if (i === -1) return null;
    const verb = String(args[i]);
    if (verb === 'test') return args.slice(i + 1);
    if (verb === 'run') return args.slice(i + 2);
    return null;
  }
  if (cmd === 'pytest') return args;
  if (cmd === 'playwright') return runnerArgsWithoutVerb(args, { implicitRun: false }) ?? [];
  if (cmd === 'vitest') return runnerArgsWithoutVerb(args, { implicitRun: true }) ?? [];
  const pkg = packageRunnerTool(cmd, args);
  if (pkg) {
    if (pkg.tool === 'playwright') return runnerArgsWithoutVerb(pkg.rest, { implicitRun: false }) ?? [];
    if (pkg.tool === 'vitest') return runnerArgsWithoutVerb(pkg.rest, { implicitRun: true }) ?? [];
  }
  return null;
};

/** True when an allowed local test run has no explicit test file or directory operand (name filters only). */
export function localTestRunIsBare(words, ctx = undefined) {
  if (!localTestRunAllowed(words, ctx)) return false;
  const body = testRunBodyArgs(words);
  if (body === null) return false;
  const pos = body.filter(a => a !== '' && !String(a).startsWith('-'));
  if (!pos.length) return true;
  return !pos.some(looksLikeExplicitTestOperand);
}
