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

/** Any non-denied swarm subcommand with any flags (handbuild owner verbs and change --yes stay blocked). */
export function swarmSubcommandAlwaysAllowed(sub, rest) {
  const s = String(sub ?? '').toLowerCase();
  if (!s || OM_SWARM_DENIED_TOP.has(s)) return false;
  if (s === 'handbuild') {
    const verb = String(rest[0] ?? '').toLowerCase();
    if (!verb || verb === '--help' || verb.startsWith('-')) return true;
    if (HANDBUILD_OWNER_VERBS.has(verb)) return false;
    return SWARM_HANDBUILD_FILE_OPS.has(verb);
  }
  if (s === 'change') {
    const lower = rest.map(w => String(w).toLowerCase());
    return !lower.some(a => a === '--yes' || a.startsWith('--yes='));
  }
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
