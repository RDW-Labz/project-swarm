// SPDX-License-Identifier: Apache-2.0
// `swarm go "<goal>"` reads the repo's top-level folders, splits the goal across leads,
// runs on a new branch, then integrates, commits, and rolls up.
// A manifest path or a run id still uses the older go() path.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const FOLDER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

export const GOAL_BUDGET = Object.freeze({ maxUsd: 5, maxTokens: 2_000_000 });
export const GOAL_DEFAULTS = Object.freeze({ leads: 'auto', maxJobs: 25, concurrency: 8, maxLeads: 10 });

export function isGoalArgument(argument) {
  return typeof argument === 'string' && argument.trim() === argument && argument.length > 0 && argument.length <= 2000
    && !RUN_ID.test(argument) && !argument.includes('/') && !argument.includes('\\') && !argument.endsWith('.json');
}

// First `swarm go` in a project: run init once, before anything else. A dirty tree is left alone so
// goGoal refuses it as usual; the files init wrote are committed on the go branch, never on the
// branch the operator started from.
export async function autoInit(root, deps) {
  if (await deps.exists(root)) return { ran: false, files: [] };
  if (await deps.dirty(root)) return { ran: false, files: [], skipped: 'goal-dirty' };
  const result = await deps.init(root);
  return { ran: true, result, files: await deps.changed(root) };
}

export function goalRunId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function goalError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

// In a git repo only folders that hold tracked files count: a lead scoped to an empty or untracked folder cannot
// see it in its workspace and fails on its own prompt.
export async function topLevelFolders(root, run = exec) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  let tracked = null;
  try {
    const { stdout } = await run('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    tracked = new Set(stdout.split('\0').filter(file => file.includes('/')).map(file => file.slice(0, file.indexOf('/'))));
  } catch { tracked = null; }
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && FOLDER.test(entry.name) && entry.name !== 'node_modules' && (tracked === null || tracked.has(entry.name)))
    .map(entry => entry.name)
    .sort();
}

// swarm regenerates these after every command, so they never count as the operator's uncommitted work.
const GENERATED = new Set(['coordination/HANDOFF.md', 'coordination/HANDOFF.previous.md']);
export async function worktreeDirty(root, run = exec) {
  const { stdout } = await run('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  // .swarm/ is the runner's own scratch space (plans, journal, runs); it is never the operator's work.
  return stdout.split('\n').filter(line => line.trim() && !GENERATED.has(line.slice(3).trim()) && !/^\?\? "?\.swarm\//.test(line)).length > 0;
}

// New branch only. The branch you were on keeps its current commit.
export async function createGoBranch(root, branch, run = exec) {
  if (!/^swarm\/go-[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(branch)) throw goalError('goal-branch', branch);
  const current = (await run('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' })).stdout.trim();
  const tip = current ? (await run('git', ['-C', root, 'rev-parse', current], { encoding: 'utf8' })).stdout.trim() : null;
  await run('git', ['-C', root, 'checkout', '-b', branch], { encoding: 'utf8' });
  if (current && tip) {
    const after = (await run('git', ['-C', root, 'rev-parse', current], { encoding: 'utf8' })).stdout.trim();
    if (after !== tip) throw goalError('goal-branch', `${current} moved`);
  }
  return { branch, from: current || null };
}

function splitFolders(names, count) {
  const buckets = Array.from({ length: count }, () => []);
  names.forEach((name, index) => buckets[index % count].push(`${name}/`));
  return buckets;
}

// The tracked files of a repo (paths only), for the lead prompts; a lead reads nothing else, so without this it cannot
// know which files its scope holds.
export async function trackedFiles(root, run = exec) {
  try {
    const { stdout } = await run('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return stdout.split('\0').filter(Boolean).slice(0, 50000);
  } catch { return []; }
}

const MAX_LISTED = 200;
const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 200);
function scopeListing(scope, files) {
  const inside = files.filter(file => scope.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry)));
  if (!inside.length) return '';
  const shown = inside.slice(0, MAX_LISTED).map(file => `- ${clean(file)}`).join('\n');
  return `\n\nFILES IN YOUR SCOPE (${Math.min(inside.length, MAX_LISTED)} of ${inside.length}, exact paths; you cannot read them yourself, so plan from these names):\n${shown}`;
}

export function manifestForGoal(goal, { folders = [], files = [], leads = 'auto', maxJobs = GOAL_DEFAULTS.maxJobs, concurrency = GOAL_DEFAULTS.concurrency, checks = [], maxUsd = GOAL_BUDGET.maxUsd, maxTokens = GOAL_BUDGET.maxTokens } = {}) {
  const text = typeof goal === 'string' ? goal.trim() : '';
  if (!text || text.length > 2000) throw goalError('goal-invalid', 'goal must be 1–2000 characters');
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 500) throw goalError('goal-max-jobs', '--max-jobs must be an integer 1–500');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw goalError('goal-concurrency', '--concurrency must be an integer 1–64');
  const names = [...new Set(folders)].filter(name => !name.startsWith('.') && FOLDER.test(name) && name !== 'node_modules').sort();
  if (!names.length) throw goalError('goal-no-folders', 'the repo has no top-level folders to split');
  let count;
  if (leads === 'auto') count = Math.min(names.length, GOAL_DEFAULTS.maxLeads);
  else if (Number.isInteger(leads) && leads >= 1 && leads <= GOAL_DEFAULTS.maxLeads) {
    if (leads > names.length) throw goalError('goal-leads', `${leads} leads need ${leads} top-level folders; found ${names.length}`);
    count = leads;
  } else throw goalError('goal-leads', '--leads must be auto or an integer 1–10');
  const buckets = splitFolders(names, count);
  return {
    version: 1,
    concurrency,
    report: 'short',
    budget: { maxUsd, maxTokens },
    ...(checks.length ? { checks } : {}),
    jobs: buckets.map((scope, index) => ({
      id: `lead-${index + 1}`,
      type: 'lead',
      agent: 'auto',
      prompt: `You own only these folders: ${scope.join(', ')}. Turn this goal into child jobs inside that scope. Every child job uses a short report.\n\nGOAL:\n${text}${scopeListing(scope, files)}`,
      context: [],
      outputs: [`goal-lead-${index + 1}.json`],
      area: { goal: text, scope, maxJobs, concurrency },
    })),
  };
}

export function resumeCommand(id, pause) {
  const message = pause?.message ?? '';
  const part = message.split(';').map(item => item.trim()).find(item => item.startsWith('resume with '));
  const flags = part ? part.slice('resume with '.length) : '--raise maxUsd=<N> --reason TEXT';
  return `swarm resume ${id} ${flags}`;
}

function failed(stage, base, reason) {
  return { status: 'failed', stage, ...base, reason };
}

// Dirty check, plan from real folders, branch, run, merge queue, commit, rollup.
// A cap pause stops before integrate and says how to resume. The starting branch is not moved.
export async function goGoal(root, goal, flags = {}, deps) {
  const base = { runId: null, branch: null, cost: null, warnings: [], integrate: null, rollup: null, reason: null, resume: null };
  if (flags.payloadPath) return failed('plan', base, 'a goal does not take --pr');
  if (await deps.dirty(root)) return failed('plan', base, 'goal-dirty: commit or stash changes before swarm go');
  const maxUsd = flags.maxUsd ?? GOAL_BUDGET.maxUsd;
  const maxTokens = flags.maxTokens ?? GOAL_BUDGET.maxTokens;
  const planOptions = {
    folders: await deps.folders(root),
    leads: flags.leads ?? 'auto',
    maxJobs: flags.maxJobs ?? GOAL_DEFAULTS.maxJobs,
    concurrency: flags.concurrency ?? GOAL_DEFAULTS.concurrency,
    checks: flags.checks ?? [],
    maxUsd,
    maxTokens,
  };
  let manifest;
  try { manifest = await deps.plan(goal, planOptions); }
  catch (error) { return failed('plan', base, error.message); }
  if (!manifest || manifest.report !== 'short') manifest = { ...(manifest ?? {}), report: 'short' };
  const id = deps.runId();
  const branch = `swarm/go-${id}`;
  try { await deps.branch(root, branch); }
  catch (error) { return failed('branch', { ...base, runId: id, branch }, error.message); }
  base.runId = id;
  base.branch = branch;
  let started, waited;
  try {
    started = await deps.run(root, manifest, { id, maxUsd, maxTokens });
    waited = await deps.wait(root, started.id);
  } catch (error) { return failed('run', base, error.message); }
  base.cost = waited.costUsd ?? null;
  base.warnings = waited.warnings ?? [];
  if (waited.status === 'paused') {
    return { status: 'paused', stage: 'run', ...base, reason: waited.pause?.message ?? 'run paused on a cap', resume: resumeCommand(started.id, waited.pause) };
  }
  if (waited.status !== 'complete') return failed('run', base, `run ${waited.status}`);
  let integrated;
  try { integrated = await deps.integrate(root, started.id, { queue: true }); }
  catch (error) { return failed('integrate', base, error.message); }
  base.integrate = integrated;
  if (integrated?.checksPassed === false || integrated?.checkFailed?.length || integrated?.status === 'failed' || integrated?.status === 'partial') {
    return failed('integrate', base, 'merge queue did not integrate');
  }
  const files = integrated?.files ?? [];
  try {
    const committed = await deps.commit(root, files, flags.commitMessage ?? `swarm go: ${goal}`);
    if (committed?.status && committed.status !== 'committed') return failed('commit', base, committed.reason ?? 'commit failed');
  } catch (error) { return failed('commit', base, error.message); }
  let rollup;
  try { rollup = await deps.rollup(root, started.id); }
  catch (error) { return failed('rollup', base, error.message); }
  return { status: 'complete', stage: 'rollup', ...base, rollup };
}
