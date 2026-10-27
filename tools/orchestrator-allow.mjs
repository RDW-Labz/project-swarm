// SPDX-License-Identifier: Apache-2.0
// Pure orchestrator-mode allow rules (no I/O). Called from tools/shell-writes.mjs.

import path from 'node:path';

export const OM_SWARM_DENIED_TOP = new Set(['init', 'mutants', 'mutant', 'scaffold', 'eval', 'shell', 'exec']);

export const OM_SWARM_ALLOWED_TOP = new Set([
  'status', 'brief', 'board', 'watch', 'jobs', 'tickets', 'run', 'integrate', 'merge', 'update', 'note',
  'version', 'doctor', 'rollup', 'scope', 'msg', 'diagnose', 'go', 'change', 'handbuild', 'ticket', 'ask',
  'decision', 'handoff', 'lesson', 'backlog', 'time', 'decide',
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
  if (s === 'scope') return omSwarmScopeReadOnly(rest);
  if (s === 'decide') return omSwarmDecideReadOnly(rest);
  if (s === 'budget' || s === 'budgets') {
    const verb = String(rest.find(a => a !== '' && !String(a).startsWith('-')) ?? '').toLowerCase();
    if (verb === 'set') return false;
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
    const m = words.indexOf('-m');
    if (m === -1 || String(words[m + 1] ?? '') !== 'pytest') return null;
    return words.slice(m + 2);
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
