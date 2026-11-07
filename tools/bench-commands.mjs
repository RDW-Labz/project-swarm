// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { buildScorecard, formatScorecard } from './bench-scorecard.mjs';

export const EVAL_USAGE = `usage:
  swarm eval baseline [--project NAME] [--since DATE] [--out FILE]
  swarm eval replay --label NAME [--parallel N | --load] [--cases DIR] [--out FILE]
  swarm eval compare BEFORE.json AFTER.json --target METRIC [--tolerance 0.10] [--markdown]
  swarm eval scorecard [--out FILE]`;

const BASELINE_FLAGS = new Set(['project', 'since', 'out']);
const REPLAY_FLAGS = new Set(['label', 'parallel', 'load', 'cases', 'out']);
const COMPARE_FLAGS = new Set(['target', 'tolerance', 'markdown']);
const SCORECARD_FLAGS = new Set(['out']);

/** Maps missing baseline metrics to what instrumentation would measure them. */
export const MISSING_INSTRUMENTATION = Object.freeze({
  ready_to_merged_ms: 'ticket transition log and merged PR timestamps',
  billed_usd: 'run job costUsd on paid lanes (tools/spend.mjs PAID_LANES)',
  list_usd: 'run job costUsd on every job',
  first_try_pass_rate: 'run state jobs with retries field',
  retries: 'run state jobs with retries field',
  flaky_failures: 'test failure names and flake classifier',
  owner_interruptions_per_day: 'orchestrator events and journal blocked markers',
  idle_slot_pct: 'wave records when tickets were ready versus open slots',
  dirty_tree_incidents: 'hand-build guard log',
  branch_switch_incidents: 'hand-build guard log',
  guard_false_positives: 'hand-build guard log',
  orchestrator_tokens_per_merged_ticket: 'orchestrator usage store',
});

const out = (stdout, exitCode = 0) => ({ stdout: stdout ? `${stdout}\n` : '', stderr: '', exitCode });
const err = (message, exitCode = 1) => ({ stdout: '', stderr: `${message}\n`, exitCode });

function takeFlag(flags, name, args, i) {
  const key = name.slice(2);
  if (flags.has(key)) throw new Error(`duplicate flag: ${name}`);
  const value = args[++i];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  flags.set(key, value);
  return i;
}

/**
 * @param {string[]} args
 * @returns {{ subcommand: string, flags: Map<string, string | true>, rest: string[] }}
 */
export function parseEvalArgs(args) {
  const flags = new Map();
  const rest = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      i += 1;
      continue;
    }
    if (arg === '--markdown' || arg === '--load') {
      flags.set(arg.slice(2), true);
      i += 1;
      continue;
    }
    if (arg.includes('=')) {
      const [k, v] = arg.slice(2).split('=');
      flags.set(k, v);
      i += 1;
      continue;
    }
    i = takeFlag(flags, arg, args, i);
    i += 1;
  }
  const subcommand = rest.shift() ?? '';
  return { subcommand, flags, rest };
}

function unknownFlag(subcommand, flags, allowed) {
  for (const key of flags.keys()) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function appendMissingInstrumentation(baseline, formatBaseline) {
  let text = typeof formatBaseline === 'function' ? formatBaseline(baseline) : '';
  const missing = Object.entries(baseline?.metrics ?? {}).filter(([, m]) => m?.status === 'missing');
  if (missing.length) {
    text += '\n\nMissing metrics (instrumentation needed):\n';
    for (const [name] of missing) {
      const hint = MISSING_INSTRUMENTATION[name] ?? 'project data source';
      text += `  ${name}: ${hint}\n`;
    }
  }
  return text.trimEnd();
}

async function readJsonFile(fs, file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function writeJsonFile(fs, file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function listJsonBaselines(fs, root) {
  const dir = path.join(root, 'evals', 'baseline');
  const names = await fs.readdir(dir).catch(() => []);
  const baselines = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      baselines.push(await readJsonFile(fs, path.join(dir, name)));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        console.error('[tools/bench-commands.mjs] listJsonBaselines readJsonFile:', error?.message ?? error);
      }
    }
  }
  return baselines;
}

async function listJsonReplays(fs, root) {
  const dir = path.join(root, 'evals', 'replay');
  const names = await fs.readdir(dir).catch(() => []);
  const replays = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      replays.push(await readJsonFile(fs, path.join(dir, name)));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        console.error('[tools/bench-commands.mjs] listJsonReplays readJsonFile:', error?.message ?? error);
      }
    }
  }
  return replays;
}

async function loadPreviousScorecard(fs, root) {
  const file = path.join(root, 'evals', 'scorecard', 'previous.json');
  try {
    return await readJsonFile(fs, file);
  } catch {
    return null;
  }
}

/**
 * @param {string[]} args
 * @param {{ out?: (chunk: string) => void, root: string, fs: object, now?: number, deps?: object }} ctx
 */
export async function evalCommand(args, { out: print = () => {}, root, fs, now = Date.now(), deps = {} } = {}) {
  if (!root || !fs) return err('evalCommand requires root and fs');
  let parsed;
  try {
    parsed = parseEvalArgs(args);
  } catch (e) {
    print(EVAL_USAGE);
    return err(String(e.message ?? e));
  }

  const { subcommand, flags, rest } = parsed;

  if (!subcommand) {
    print(EVAL_USAGE);
    return err('missing subcommand');
  }

  if (subcommand === 'baseline') {
    const bad = unknownFlag('baseline', flags, BASELINE_FLAGS);
    if (bad) {
      print(EVAL_USAGE);
      return err(`unknown option: --${bad}`);
    }
    const project = flags.get('project') ?? path.basename(root);
    const since = flags.get('since');
    const outFile = flags.get('out') ?? path.join(root, 'evals', 'baseline', `${project}.json`);
    if (!deps.collectBaseline) return err('collectBaseline dependency is not configured');
    const baseline = await deps.collectBaseline({ root, project, since, until: now, now });
    const table = appendMissingInstrumentation(baseline, deps.formatBaseline);
    print(table);
    if (deps.writeBaseline) await deps.writeBaseline({ baseline, file: outFile, fs });
    else await writeJsonFile(fs, outFile, baseline);
    return out(table);
  }

  if (subcommand === 'replay') {
    const bad = unknownFlag('replay', flags, REPLAY_FLAGS);
    if (bad) {
      print(EVAL_USAGE);
      return err(`unknown option: --${bad}`);
    }
    const label = flags.get('label');
    if (!label || typeof label !== 'string') {
      print(EVAL_USAGE);
      return err('--label NAME is required');
    }
    const load = flags.get('load') === true;
    const parallelRaw = flags.get('parallel');
    if (load && parallelRaw) {
      print(EVAL_USAGE);
      return err('use either --parallel or --load, not both');
    }
    const casesDir = flags.get('cases') ?? path.join(root, 'evals', 'cases');
    const outFile = flags.get('out') ?? path.join(root, 'evals', 'replay', `${label}.json`);
    const cases = deps.loadCases ? await deps.loadCases(casesDir, fs) : [];
    const codeRoot = root;
    let result;
    if (load) {
      if (!deps.runLoadSeries) return err('runLoadSeries dependency is not configured');
      result = await deps.runLoadSeries({ cases, codeRoot, label, runner: deps.runner, now });
    } else {
      if (!deps.runReplay) return err('runReplay dependency is not configured');
      const parallel = parallelRaw ? Number(parallelRaw) : 1;
      result = await deps.runReplay({ cases, codeRoot, label, parallel, runner: deps.runner, now });
    }
    await writeJsonFile(fs, outFile, result);
    const summary = deps.formatReplaySummary ? deps.formatReplaySummary(result) : JSON.stringify(result.metrics ?? {}, null, 2);
    print(summary);
    return out(summary);
  }

  if (subcommand === 'compare') {
    const bad = unknownFlag('compare', flags, COMPARE_FLAGS);
    if (bad) {
      print(EVAL_USAGE);
      return err(`unknown option: --${bad}`);
    }
    const [beforePath, afterPath] = rest;
    if (!beforePath || !afterPath) {
      print(EVAL_USAGE);
      return err('compare requires BEFORE.json and AFTER.json');
    }
    const target = flags.get('target');
    if (!target) {
      print(EVAL_USAGE);
      return err('--target METRIC is required');
    }
    const tolerance = flags.get('tolerance') != null ? Number(flags.get('tolerance')) : 0.1;
    if (!deps.compareReplays) return err('compareReplays dependency is not configured');
    const before = await readJsonFile(fs, beforePath);
    const after = await readJsonFile(fs, afterPath);
    const result = deps.compareReplays(before, after, { target, tolerance });
    const markdown = flags.get('markdown') === true;
    const text = markdown
      ? (deps.formatCompareMarkdown ?? (() => ''))(result)
      : (deps.formatCompareTable ?? (() => JSON.stringify(result)))(result);
    print(text);
    const exitCode = result.verdict === 'fail' ? 1 : 0;
    return { stdout: `${text}\n`, stderr: '', exitCode };
  }

  if (subcommand === 'scorecard') {
    const bad = unknownFlag('scorecard', flags, SCORECARD_FLAGS);
    if (bad) {
      print(EVAL_USAGE);
      return err(`unknown option: --${bad}`);
    }
    const outFile = flags.get('out') ?? path.join(root, 'evals', 'scorecard', 'latest.json');
    const baselines = deps.loadBaselines ? await deps.loadBaselines(root, fs) : await listJsonBaselines(fs, root);
    const replays = deps.loadReplays ? await deps.loadReplays(root, fs) : await listJsonReplays(fs, root);
    const previous = deps.loadPreviousScorecard
      ? await deps.loadPreviousScorecard(root, fs)
      : await loadPreviousScorecard(fs, root);
    const build = deps.buildScorecard ?? buildScorecard;
    const card = build({ baselines, replays, previous, now, thresholds: deps.thresholds });
    await writeJsonFile(fs, outFile, card);
    const text = formatScorecard(card);
    print(text);
    return out(text);
  }

  print(EVAL_USAGE);
  return err(`unknown subcommand: ${subcommand}`);
}
