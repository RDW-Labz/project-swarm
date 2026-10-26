// SPDX-License-Identifier: Apache-2.0
// Pure orchestrator-mode allow rules (no I/O). Called from tools/shell-writes.mjs.

import path from 'node:path';

export const OM_SWARM_DENIED_TOP = new Set(['init', 'mutants', 'mutant', 'scaffold', 'eval', 'shell', 'exec']);

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

const NPM_TEST_RUNS = new Set(['test', 'test:e2e']);

const SCOPE_READONLY_VERBS = new Set(['show', 'list', 'status', 'read', 'check', 'help']);
const DECIDE_READONLY_VERBS = new Set(['show', 'list', 'status', 'read', 'check', 'help']);

export const OM_SWARM_RUN_FLAGS = new Set([
  '--lane', '--ticket', '--job', '--run', '--worktree', '--no', '--dry-run', '--json', '--quiet', '-q', '-j',
  '--queue', '--no-checks', '--no-commit', '--jobs', '--skip-skeleton', '--scope', '--max-jobs',
  '--wave', '--max-waves', '--allow-main-branch', '--leads', '--concurrency', '--max-usd', '--max-tokens',
  '--commit-message', '--repo', '--pr', '--require-section', '--mutants', '--merge-method', '--timeout',
  '--tag-timeout', '--no-flake-check', '--no-watch', '--exempt', '--plan', '--accept-stale', '--batch',
  '--adaptive', '--batch-size', '--max-requeues', '--require-checks', '--accept-failed-checks',
  '--mutants-file', '--mutant-check', '--accept-blocked', '--salvage', '--accept-deviation', '--accept-result-shape',
  '--sync', '--evidence', '--accept-red-base', '--reason',
]);

const OM_SWARM_RUN_FLAGS_WITH_VALUE = new Set([
  '--lane', '--ticket', '--job', '--run', '--worktree', '--jobs', '--max-jobs', '--batch-size', '--max-requeues',
  '--commit-message', '--repo', '--pr', '--require-section', '--merge-method', '--timeout', '--tag-timeout',
  '--exempt', '--leads', '--concurrency', '--max-usd', '--max-tokens', '--mutant-check', '--evidence', '--reason',
  '--accept-red-base', '--accept-failed-check',
]);

const swarmArgsHaveYes = rest => {
  const lower = rest.map(w => String(w).toLowerCase());
  return lower.some(a => a === '--yes' || a.startsWith('--yes='));
};

const swarmArgsHaveApprove = rest => {
  const lower = rest.map(w => String(w).toLowerCase());
  return lower.some(a => a === '--approve' || a.startsWith('--approve='));
};

const swarmArgsHaveForceBypass = rest => {
  for (const a of rest) {
    const low = String(a).toLowerCase();
    if (low === '--force' || low.startsWith('--force=')) return true;
    if (low === '-f') return true;
  }
  return false;
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
  if (swarmArgsHaveApprove(rest) || swarmArgsHaveYes(rest)) return false;
  return true;
};

/** Swarm subcommand allow rules after global flags (--root) are validated in shell-writes.mjs. */
export function swarmSubcommandAlwaysAllowed(sub, rest) {
  const s = String(sub ?? '').toLowerCase();
  if (!s || OM_SWARM_DENIED_TOP.has(s)) return false;
  if (swarmArgsHaveForceBypass(rest)) return false;
  if (s === 'restore') return false;
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
  if (s === 'scope') return omSwarmScopeReadOnly(rest);
  if (s === 'decide') return omSwarmDecideReadOnly(rest);
  if (s === 'tickets') return omSwarmTicketsAllowed(rest);
  if (!omSwarmRunLikeAllowed(s, rest)) return false;
  return true;
}

/** True when the only flags are --help, -h, or --version (subcommand tokens allowed). */
export function helpOnly(words) {
  if (!words?.length) return false;
  let sawHelp = false;
  for (let i = 1; i < words.length; i += 1) {
    const a = String(words[i]);
    if (a.startsWith('-')) {
      if (!HELP_FLAGS.has(a)) return false;
      sawHelp = true;
      continue;
    }
  }
  return sawHelp;
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
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-R' || args[i] === '--repo' || args[i] === '--repository') i += 2;
      else if (args[i].startsWith('--repo=') || args[i].startsWith('--repository=')) i += 1;
      else return false;
    }
    return ghReadonlySub(args.slice(i));
  }
  if (READONLY_BINARIES.has(cmd)) return true;
  return false;
}

const isPytest = words => {
  if (!words.length) return false;
  const cmd = path.basename(String(words[0]));
  if (cmd === 'pytest') return true;
  if (cmd === 'python' || cmd === 'python3') {
    const m = words.indexOf('-m');
    return m !== -1 && String(words[m + 1] ?? '') === 'pytest';
  }
  return false;
};

const isPlaywright = (cmd, args) => {
  if (cmd === 'playwright') return args[0] === 'test';
  if (cmd === 'npx' || cmd === 'pnpm' || cmd === 'yarn') {
    const i = args.findIndex(a => a !== '' && !a.startsWith('-'));
    return i !== -1 && args[i] === 'playwright' && args[i + 1] === 'test';
  }
  return false;
};

const isVitest = (cmd, args) => {
  if (cmd === 'vitest') return true;
  if (cmd === 'npx' || cmd === 'pnpm' || cmd === 'yarn') {
    const i = args.findIndex(a => a !== '' && !a.startsWith('-'));
    return i !== -1 && args[i] === 'vitest';
  }
  return false;
};

const isNpmTest = (cmd, args) => {
  if (cmd === 'npm') {
    const i = args.findIndex(a => a !== '' && !a.startsWith('-'));
    if (i === -1) return false;
    if (args[i] === 'test') return true;
    if (args[i] === 'run' && NPM_TEST_RUNS.has(String(args[i + 1] ?? ''))) return true;
    return false;
  }
  if (cmd === 'pnpm' || cmd === 'yarn') {
    const i = args.findIndex(a => a !== '' && !a.startsWith('-'));
    if (i === -1) return false;
    if (args[i] === 'test') return true;
    if (args[i] === 'run' && NPM_TEST_RUNS.has(String(args[i + 1] ?? ''))) return true;
    return false;
  }
  return false;
};

/** Local test runners (no redirects/tee/sed -i in the same segment; checked in shell-writes). */
export function localTestRunAllowed(words) {
  if (!words?.length) return false;
  const rawCmd = String(words[0]);
  const cmd = path.basename(rawCmd);
  const args = words.slice(1);
  if (isPytest(words)) return true;
  if (cmd === 'node' && args.includes('--test')) return true;
  if (isPlaywright(cmd, args)) return true;
  if (isVitest(cmd, args)) return true;
  if (isNpmTest(cmd, args)) return true;
  return false;
}
