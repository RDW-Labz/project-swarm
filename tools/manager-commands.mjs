// SPDX-License-Identifier: Apache-2.0
// `swarm managers ...` — replay harness and scorecard (Phase 19 / T-0190). Glue over tools/managers/*.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManagerActionModeSettings } from './managers/modes.mjs';
import { appendManagerJournalLine } from './managers/journal.mjs';
import {
  builtinManagerIds,
  registerBuiltinManagerRun,
  runBuiltinManager,
} from './managers/registry.mjs';
import { isBudgetLaneManagerId } from './managers/register/budget-lane.mjs';
import { ticketUnblockBuiltinManagerIds } from './managers/register/ticket-unblock.mjs';
import { MANAGER_REPLAY_CLI_IDS, normalizeReplayManagerId } from './managers/replay.mjs';
import { runManagerReplayWithScorecard } from './managers/scorecard.mjs';

/** @typedef {import('./managers/modes.mjs').ManagerId} ManagerId */

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

export const MANAGERS_USAGE = [
  'Usage: swarm managers list [--json]',
  '       swarm managers run MANAGER [--json] [--trigger scope|wave|replay|idle]',
  '       swarm managers replay LEDGER_DIR MANAGER [--json] [--skip-scorecard]',
  '       swarm managers scorecard LEDGER_DIR MANAGER [--json] [--skip-scorecard]',
  'MANAGER is one of: budget, lane-health, version, ticket, unblocker, merge-queue, lessons, visual-qa',
  'Replay fixtures live under evals/managers/ (see evals/managers/README.md).',
  '',
].join('\n');

const VALUE_FLAGS = new Set(['--trigger']);
const BOOL_FLAGS = new Set(['--json', '--skip-scorecard']);

/** @type {Readonly<Set<string>>} */
const MANAGER_TRIGGERS = new Set(['scope', 'wave', 'replay', 'idle']);

const out = (stdout, exitCode = 0) => ({
  stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`,
  exitCode,
});
const bad = (message) => out(`${message}\n${MANAGERS_USAGE}`, 1);

/**
 * @param {string[]} args
 */
export function parseManagersArgs(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    if (!BOOL_FLAGS.has(a) && !VALUE_FLAGS.has(a)) {
      throw Object.assign(new Error(`unknown flag: ${a}`), { code: 'managers-args' });
    }
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw Object.assign(new Error(`${a} needs a value`), { code: 'managers-args' });
      }
      flags[a.slice(2)] = args[i + 1];
      i += 1;
      continue;
    }
    flags[a.slice(2)] = true;
  }
  return { flags, rest };
}

/** @type {Readonly<Record<ManagerId, string>>} */
const MANAGER_CREATE_MODULE_HREF = Object.freeze({
  budget: new URL('./managers/budget/index.mjs', import.meta.url).href,
  'lane-health': new URL('./managers/lane-health/index.mjs', import.meta.url).href,
  version: new URL('./managers/version/index.mjs', import.meta.url).href,
  'ticket-manager': new URL('./managers/ticket-manager/index.mjs', import.meta.url).href,
  unblocker: new URL('./managers/unblocker/index.mjs', import.meta.url).href,
  'merge-queue': new URL('./managers/merge-queue/index.mjs', import.meta.url).href,
  'lessons-keeper': new URL('./managers/lessons/index.mjs', import.meta.url).href,
  'visual-qa': new URL('./managers/visual-qa/index.mjs', import.meta.url).href,
});

/** @type {Map<ManagerId, Promise<(opts: object) => import('./managers/base.mjs').BaseManager>>} */
const createManagerLoaders = new Map();

/** @type {Map<ManagerId, (opts: object) => import('./managers/base.mjs').BaseManager>} */
const createManagerFns = new Map();

/** @type {Set<ManagerId>} */
const cliManagerRunRegistered = new Set();

/** @type {Map<ManagerId, Promise<import('./managers/registry.mjs').BuiltinManagerRun>>} */
const runBuiltinManagerLoaders = new Map();

/**
 * @param {ManagerId} managerId
 * @returns {boolean}
 */
function isCliRunnableManagerId(managerId) {
  if (isBudgetLaneManagerId(managerId)) return true;
  return ticketUnblockBuiltinManagerIds.includes(managerId);
}

/**
 * Default orchestrator trigger when `swarm managers run` omits `--trigger`.
 *
 * @param {ManagerId} managerId
 * @returns {import('./contracts/managers.json').components.schemas.ManagerTrigger}
 */
function defaultManagerRunTrigger(managerId) {
  if (managerId === 'unblocker') return 'wave';
  return 'scope';
}

/**
 * @param {ManagerId} managerId
 */
async function ensureCreateManagerFn(managerId) {
  let pending = createManagerLoaders.get(managerId);
  if (!pending) {
    const href = MANAGER_CREATE_MODULE_HREF[managerId];
    if (!href) throw new Error(`manager-create-module-missing: ${managerId}`);
    pending = import(href).then((mod) => {
      const fn = mod.createManager;
      if (typeof fn !== 'function') throw new Error(`manager-create-fn-missing: ${managerId}`);
      createManagerFns.set(managerId, fn);
      return fn;
    });
    createManagerLoaders.set(managerId, pending);
  }
  await pending;
}

/**
 * Synchronous factory passed to {@link runManagerReplayWithScorecard} (loads modules first).
 *
 * @param {{
 *   managerId: ManagerId,
 *   root: string,
 *   modeSettings: import('./managers/modes.mjs').ManagerActionModeSettings,
 *   trigger: import('./contracts/managers.json').components.schemas.ManagerTrigger,
 * }} options
 */
export function createBuiltinManagerForReplay(options) {
  const create = createManagerFns.get(options.managerId);
  if (!create) throw new Error(`manager-create-not-loaded: ${options.managerId}`);
  return create(options);
}

/**
 * Wire built-in orchestrator run entry points for `swarm managers run` (T-0198, T-0208).
 *
 * @param {ManagerId} managerId
 */
async function ensureCliManagerRunRegistered(managerId) {
  if (!isCliRunnableManagerId(managerId)) {
    throw new Error(`manager-run-unsupported: ${managerId}`);
  }
  if (cliManagerRunRegistered.has(managerId)) return;

  let pending = runBuiltinManagerLoaders.get(managerId);
  if (!pending) {
    const href = MANAGER_CREATE_MODULE_HREF[managerId];
    if (!href) throw new Error(`manager-run-module-missing: ${managerId}`);
    pending = import(href).then((mod) => {
      const runFn = mod.runBuiltinManager ?? mod.run;
      if (typeof runFn !== 'function') throw new Error(`manager-run-missing: ${managerId}`);
      registerBuiltinManagerRun(managerId, (options) => runFn(options));
      cliManagerRunRegistered.add(managerId);
      return runFn;
    });
    runBuiltinManagerLoaders.set(managerId, pending);
  }
  await pending;
}

/**
 * Scope-time hook: ticket-manager gates scope approve (R-036).
 *
 * @param {string} root
 * @param {{ journal?: import('./managers/journal.mjs').ManagerJournalLine, now?: () => number }} [options]
 */
export async function runManagersScopeGate(root, options = {}) {
  await ensureCliManagerRunRegistered('ticket-manager');
  const modeSettings = createManagerActionModeSettings();
  return runBuiltinManager('ticket-manager', {
    root,
    modeSettings,
    trigger: 'scope',
    journal: options.journal ?? appendManagerJournalLine,
    now: options.now,
  });
}

/**
 * Post-wave hook: unblocker runs after each orchestrator wave (R-013 / T-0208).
 *
 * @param {string} root
 * @param {{ journal?: import('./managers/journal.mjs').ManagerJournalLine, now?: () => number }} [options]
 */
export async function runManagersAfterWave(root, options = {}) {
  await ensureCliManagerRunRegistered('unblocker');
  const modeSettings = createManagerActionModeSettings();
  return runBuiltinManager('unblocker', {
    root,
    modeSettings,
    trigger: 'wave',
    journal: options.journal ?? appendManagerJournalLine,
    now: options.now,
  });
}

/**
 * @param {import('./contracts/managers.json').components.schemas.ManagerRun} run
 * @param {import('./contracts/managers.json').components.schemas.JournalReport|null} report
 */
function formatRunSummary(run, report) {
  const lines = [
    `manager: ${run.managerId}`,
    `status: ${run.status}`,
    `findings: ${run.findingCount}`,
    `journal lines: ${run.journalLineCount}`,
  ];
  if (run.error) lines.push(`error: ${run.error}`);
  if (report?.lines?.length) {
    lines.push(`reported journal lines: ${report.lines.length}`);
  }
  return lines.join('\n');
}

/**
 * @param {string} root
 * @param {string} ledgerArg
 */
export function resolveManagerLedgerDir(root, ledgerArg) {
  const raw = String(ledgerArg ?? '').trim();
  if (!raw) throw Object.assign(new Error('replay needs LEDGER_DIR'), { code: 'managers-args' });
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(root, raw));
}

/**
 * Registered replay CLI names (one per built-in manager), stable sort.
 *
 * @returns {string[]}
 */
export function managerReplayCliNames() {
  /** @type {Set<string>} */
  const names = new Set();
  for (const id of builtinManagerIds) {
    for (const [cli, contract] of Object.entries(MANAGER_REPLAY_CLI_IDS)) {
      if (contract === id) names.add(cli);
    }
    names.add(id);
  }
  return [...names].sort();
}

/**
 * @param {import('./managers/scorecard.mjs').ManagerReplayScorecard} scorecard
 */
function formatScorecardSummary(scorecard) {
  const caught = scorecard.caught;
  return [
    `manager: ${scorecard.managerId}`,
    `replay: ${scorecard.replayKey}`,
    `caught: ${caught.found}/${caught.total}`,
    `missed: ${scorecard.missed}`,
    `wrong actions: ${scorecard.wrongActions}`,
    `cost: $${scorecard.costUsd.toFixed(2)}`,
  ].join('\n');
}

/**
 * @param {Awaited<ReturnType<typeof runManagerReplayWithScorecard>>} result
 * @param {string} ledgerDir
 * @param {{ path: string }|null} scorecardWritten
 */
function formatReplaySummary(result, ledgerDir, scorecardWritten) {
  const lines = [
    `manager: ${result.managerId}`,
    `ledger: ${ledgerDir}`,
    `steps: ${result.steps.length}`,
    `reproduced journal lines: ${result.reproducedJournalLines.length}`,
    `recorded journal lines: ${result.recordedJournalLines.length}`,
  ];
  if (scorecardWritten?.path) lines.push(`scorecard: ${scorecardWritten.path}`);
  if (result.scorecard?.scorecard) {
    lines.push(formatScorecardSummary(result.scorecard.scorecard));
  }
  return lines.join('\n');
}

/**
 * @param {string} root
 * @param {string[]} replayArgs
 * @param {{ json?: boolean, skipScorecard?: boolean, swarmRoot?: string, now?: () => number }} opts
 */
/**
 * @param {string} root
 * @param {string[]} runArgs
 * @param {{ json?: boolean, trigger?: string, now?: () => number }} opts
 */
async function managersRun(root, runArgs, opts = {}) {
  const managerArg = runArgs[0];
  if (!managerArg) return bad('run needs MANAGER');
  if (runArgs.length > 1) return bad(`unexpected arguments: ${runArgs.slice(1).join(' ')}`);

  let managerId;
  try {
    managerId = normalizeReplayManagerId(managerArg);
  } catch (error) {
    return bad(String(error.message ?? error));
  }

  const triggerRaw = String(opts.trigger ?? defaultManagerRunTrigger(managerId)).trim();
  if (!MANAGER_TRIGGERS.has(triggerRaw)) {
    return bad(`unknown trigger: ${triggerRaw}`);
  }
  const trigger = /** @type {import('./contracts/managers.json').components.schemas.ManagerTrigger} */ (
    triggerRaw
  );

  try {
    await ensureCliManagerRunRegistered(managerId);
    const modeSettings = createManagerActionModeSettings();
    const { run, report } = await runBuiltinManager(managerId, {
      root,
      modeSettings,
      trigger,
      journal: appendManagerJournalLine,
      now: opts.now,
    });

    if (opts.json) {
      return out(JSON.stringify({
        managerId: run.managerId,
        root,
        trigger: run.trigger,
        run,
        journalLines: report?.lines ?? [],
      }, null, 2));
    }

    if (run.status === 'error') {
      return out(formatRunSummary(run, report), 1);
    }
    return out(formatRunSummary(run, report));
  } catch (error) {
    return bad(String(error.message ?? error));
  }
}

async function managersReplay(root, replayArgs, opts = {}) {
  const ledgerArg = replayArgs[0];
  const managerArg = replayArgs[1];
  if (!ledgerArg || !managerArg) {
    return bad('replay needs LEDGER_DIR and MANAGER');
  }
  if (replayArgs.length > 2) return bad(`unexpected arguments: ${replayArgs.slice(2).join(' ')}`);

  let managerId;
  try {
    managerId = normalizeReplayManagerId(managerArg);
  } catch (error) {
    return bad(String(error.message ?? error));
  }

  const ledgerDir = resolveManagerLedgerDir(root, ledgerArg);

  try {
    await ensureCreateManagerFn(managerId);
    const result = await runManagerReplayWithScorecard({
      ledgerDir,
      manager: managerArg,
      swarmRoot: opts.swarmRoot ?? toolsDir,
      skipScorecard: opts.skipScorecard === true,
      createManager: createBuiltinManagerForReplay,
      now: opts.now,
    });

    if (opts.json) {
      return out(JSON.stringify({
        managerId: result.managerId,
        ledgerDir,
        steps: result.steps.length,
        reproducedJournalLines: result.reproducedJournalLines,
        recordedJournalLines: result.recordedJournalLines,
        scorecard: result.scorecard?.scorecard ?? null,
        scorecardPath: result.scorecard?.path ?? null,
      }, null, 2));
    }

    return out(formatReplaySummary(result, ledgerDir, result.scorecard));
  } catch (error) {
    return bad(String(error.message ?? error));
  }
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {{ now?: () => number, swarmRoot?: string }} [options]
 */
export async function runManagersCommand(root, args, options = {}) {
  let flags = {};
  let rest = args;
  try {
    const parsed = parseManagersArgs(args);
    flags = parsed.flags;
    rest = parsed.rest;
  } catch (error) {
    return bad(String(error.message ?? error));
  }

  const [verb, ...verbArgs] = rest;
  const json = flags.json === true;
  const skipScorecard = flags['skip-scorecard'] === true;
  const trigger = flags.trigger;
  const swarmRoot = options.swarmRoot ?? toolsDir;

  if (verb === 'run') {
    return managersRun(root, verbArgs, { json, trigger, now: options.now });
  }

  if (verb === 'list') {
    if (verbArgs.length) return bad('list takes no positional arguments');
    const ids = [...builtinManagerIds].sort();
    if (json) return out(JSON.stringify({ managers: ids, replayCliNames: managerReplayCliNames() }));
    return out(ids.join('\n'));
  }

  if (verb === 'replay') {
    return managersReplay(root, verbArgs, { json, skipScorecard, swarmRoot, now: options.now });
  }

  if (verb === 'scorecard') {
    const replay = await managersReplay(root, verbArgs, { json: true, skipScorecard, swarmRoot, now: options.now });
    if (replay.exitCode !== 0) return replay;
    if (json) return replay;
    try {
      const payload = JSON.parse(replay.stdout);
      if (!payload.scorecard) return out('no scorecard written (--skip-scorecard?)', 1);
      return out(formatScorecardSummary(payload.scorecard));
    } catch {
      return out('scorecard output could not be parsed', 1);
    }
  }

  return out(`${verb ? `Unknown managers command: ${verb}\n` : ''}${MANAGERS_USAGE}`, 2);
}
