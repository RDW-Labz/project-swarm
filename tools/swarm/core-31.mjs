import { expandAffectedArgv } from '../affected.mjs';
import { assertOpusTier as assertAnthropicModel } from '../anthropic.mjs';
import { API_AGENTS } from '../api-adapters.mjs';
import { expandShellPreset, validateLoopbackAllow, validateNetworkAllow, validateShellTestEnvKey } from '../claude-shell.mjs';
import { CODEX_MODEL, git, validateReadPaths } from '../codex-adapter.mjs';
import { CURSOR_MODEL } from '../cursor-adapter.mjs';
import { validDependencySpec } from '../dep-install.mjs';
import { resolveHosts } from '../executors.mjs';
import { isHumanJob, validateHumanJob } from '../human-jobs.mjs';
import { JOB_TYPES, jobTypeOutputViolations } from '../job-types.mjs';
import { resolveLanes } from '../lanes.mjs';
import { validateLeadArea, validateParentLeads } from '../leads.mjs';
import { nonBookkeepingOutputs } from '../openrouter.mjs';
import { looseKillCommands } from '../process-guard.mjs';
import { resolveToolchainBin } from '../ship.mjs';
import { resolveBudget } from '../spend.mjs';
import { readMachine } from '../autotune.mjs';
import {
  applyNodeTestConcurrency,
  isNodeTestCommand,
  MEMORY_HARD_WAIT_MS,
  MEMORY_POLL_MS,
  memoryPressureLevel,
  testConcurrencyFor,
} from '../machine-limit.mjs';
import { zeroTestGuard } from '../zero-tests.mjs';
import { expandCheckArgv, expandRootArgv } from './checks.mjs';
import { promptPathCovered } from './context.mjs';
import { detectAfterCycle, fail, lastFailureLines, reviewSourcePath, syntheticDiff, validateOutputCap } from './core-1.mjs';
import { normalizeManifestMetadata, relative, runCheck, unknownJobFieldMessage, validateRunIdle } from './core-11.mjs';
import { lastTopLevelObject, originForCheck, parseContextGlob, safePath, validateMutantsArray } from './core-21.mjs';
import { CHECK_ERRORED_STATUSES, CHECK_NAME, CLEANABLE_DIRS, CLI_AGENTS, ID, MAX_CONTEXT, MAX_FILE, NON_SENSITIVE_ONLY_AGENTS, PROMPT_PATH_RE, SANDBOX_ONLY_RE, TIERS } from './patterns.mjs';
import { gitDiffNoIndexBytes, isWorktreeWriter, resolveWorktree } from './workspace.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

let memoryProbeWarningLogged = false;

function logMemoryProbeWarningOnce(warning) {
  if (!warning || memoryProbeWarningLogged) return;
  memoryProbeWarningLogged = true;
  process.stderr.write(`${warning}\n`);
}

export async function promptPathsNotInWorkspaceWarnings(root, job, context, { trackedFiles = [], resources = [], access = file => fs.access(file) } = {}) {
  const covered = new Set([...trackedFiles, ...context, ...resources]);
  // Only what the manifest declares is checked. A retry note, a reviewer's evidence or an owner comment is quoted into the prompt between <<< and >>> as untrusted prose ("pr-part-*" in a
  // sentence is not a file glob): those blocks are left out before looking for paths.
  const promptText = String(job.prompt ?? '').replace(/<<<[\s\S]*?>>>/g, ' ');
  const candidates = new Set([...promptText.matchAll(PROMPT_PATH_RE)]
    .map(m => m[1]).filter(value => (value.includes('/') || value.includes('*')) && !value.includes('***'))
    .map(value => value.replace(/^\.\//, '').replace(/\/$/, '')));
  const hits = [];
  for (const candidate of candidates) {
    // Validate spelling before coverage: normalization must never erase traversal.
    try { relative(candidate); } catch { continue; }
    if (promptPathCovered(candidate, covered)) continue;
    const glob = candidate.includes('*');
    const prefix = glob ? candidate.slice(0, candidate.indexOf('*')).replace(/[^/]*$/, '').replace(/\/$/, '') : candidate;
    let abs; try { abs = prefix ? await safePath(root, prefix) : root; } catch { continue; }
    try { await access(abs); if (glob && !(await fs.lstat(abs)).isDirectory()) continue; } catch { continue; }
    hits.push(`prompt-path-not-in-workspace: Job ${job.id}'s prompt names ${candidate}, which ${glob ? 'matches no tracked, context, or resource file' : 'exists on disk but is neither tracked, in context, nor in manifest resources'}; it will be absent from the copied workspace`);
  }
  return hits;
}

// Expanded at validate/run time (not at manifest-write time) so a job can pick up files a build
// step adds to a shared directory (e.g. new screenshot captures) without editing the manifest.
// Also reports, per pattern, how many files it matched — surfaced by `validate` (lesson 115).
async function expandContextGlobs(root, job) {
  const extra = [];
  const counts = [];
  for (const pattern of job.contextGlob ?? []) {
    const { dir, prefix, ext } = parseContextGlob(pattern);
    const dirPath = await safePath(root, dir, {});
    let entries = [];
    try { entries = await fs.readdir(dirPath, { withFileTypes: true }); } catch { /* treated as zero matches below */ }
    const matches = entries.filter(entry => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(ext)).map(entry => `${dir}/${entry.name}`).sort();
    if (!matches.length) fail(`contextGlob matched no files: ${pattern}`);
    counts.push({ pattern, count: matches.length });
    extra.push(...matches);
  }
  return { extra, counts };
}

async function bytesAt(root, value, internal = false) {
  // Reading a names-only template (.env.example) is allowed; writing one never is (write() does not pass readOnly).
  const target = await safePath(root, value, { internal, readOnly: true });
  try {
    const info = await fs.lstat(target);
    if (!info.isFile() || info.size > MAX_FILE) fail(`Expected regular file of at most 16 MiB: ${value}`);
    return await fs.readFile(target);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// `template`: the copy of a context file into a worker's own workspace may be a names-only template (.env.example); an output never is (outputs are validated before any copy).
async function write(root, value, bytes, internal = false, mode = 0o644, { template = false } = {}) {
  const target = await safePath(root, value, { internal, parents: true, readOnly: template });
  const temporary = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
    await fs.chmod(temporary, mode);
    await safePath(root, value, { internal, readOnly: template });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function jsonWrite(root, value, data) {
  const target = await safePath(root, value, { internal: true, parents: true });
  const temporary = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    // A run of thousands of jobs is megabytes of state; pretty-printing it costs more than writing it.
    await fs.writeFile(temporary, `${JSON.stringify(data, null, value.endsWith('/state.json') && (data?.jobs?.length ?? 0) > 200 ? 0 : 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function mutantReviewTexts(root, overlay = new Map()) {
  let entries = [];
  try { entries = (await git(root, ['ls-tree', '-r', '-z', 'HEAD'])).split('\0').filter(entry => /^100(?:644|755) blob /.test(entry)).map(entry => entry.slice(entry.indexOf('\t') + 1)); }
  catch { /* Non-git copied fixtures still validate mutants; no tracked-source evidence. */ }
  const texts = new Map();
  let total = 0;
  for (const file of [...new Set([...entries, ...overlay.keys()])].sort()) {
    if (!reviewSourcePath(file)) continue;
    let bytes;
    try {
      const target = await safePath(root, file);
      if (overlay.has(file)) bytes = overlay.get(file);
      else {
        const info = await fs.lstat(target);
        if (!info.isFile() || info.size > 1024 * 1024) continue;
        bytes = await fs.readFile(target);
      }
    } catch { continue; }
    if (!bytes || bytes.length > 1024 * 1024 || bytes.includes(0)) continue;
    if (total + bytes.length > MAX_CONTEXT) break;
    total += bytes.length;
    texts.set(file, bytes.toString('utf8'));
  }
  return texts;
}

export function validateManifest(manifest, { outputJobIds = null } = {}) {
  normalizeManifestMetadata(manifest);
  if (!manifest || typeof manifest !== 'object') fail('Manifest is missing');
  if (manifest.version !== 1) fail('Manifest requires version: 1');
  if (!Array.isArray(manifest.jobs)) fail('Manifest jobs must be an array');
  if (!manifest.jobs.length) fail('Manifest has zero jobs');
  if (manifest.jobs.length > 5000) fail('Manifest requires version: 1 and 1–5000 jobs');
  for (const key of Object.keys(manifest)) if (!['version', 'concurrency', 'jobs', 'checks', 'mutants', 'mutantCheck', 'contract', 'preChecks', 'skillsDir', 'allowEmptyContext', 'resources', 'lanes', 'batch', 'report', 'budget', 'idle', 'ledger', 'hosts', 'integrate'].includes(key)) fail(`Unknown manifest field: ${key}`);
  if (manifest.integrate !== undefined && typeof manifest.integrate !== 'boolean') fail('integrate must be true or false', 'integrate-invalid');
  resolveBudget({ manifest });
  if (manifest.hosts !== undefined) resolveHosts(manifest.hosts);
  if (manifest.batch !== undefined && manifest.batch !== true && manifest.batch !== false) {
    const own = manifest.batch;
    const shape = own && typeof own === 'object' && !Array.isArray(own) && Object.keys(own).every(key => key === 'types') && Array.isArray(own.types) && own.types.length <= 20 && own.types.every(type => typeof type === 'string' && Object.hasOwn(JOB_TYPES, type));
    if (!shape) fail('batch must be true, false or { types: [job types] }', 'batch-invalid');
  }
  if (manifest.idle !== undefined) validateRunIdle(manifest.idle);
  if (manifest.ledger !== undefined) {
    if (!manifest.ledger || typeof manifest.ledger !== 'object' || Array.isArray(manifest.ledger)) fail('ledger must be an object');
    for (const key of Object.keys(manifest.ledger)) if (!['path', 'phase'].includes(key)) fail(`Unknown ledger field: ${key}`);
    if (manifest.ledger.path !== undefined) relative(manifest.ledger.path, true);
    if (manifest.ledger.phase !== undefined && typeof manifest.ledger.phase !== 'string') fail('ledger.phase must be a string');
    if (manifest.jobs.some(job => job.outputs?.includes(manifest.ledger.path))) fail('ledger-is-output: ledger path is a job output', 'ledger-is-output');
  }
  for (const value of [manifest, ...manifest.jobs]) if (value?.report !== undefined && value.report !== 'short') fail('report must be "short"', 'report-invalid-mode');
  // Lesson 26: a command that stops processes by a loose pattern is refused.
  { const loose = looseKillCommands(manifest); if (loose.length) fail(`loose-kill: ${loose[0]}; stop only a process you started, by its id (pkill -f and killall can kill programs that are not yours)`, 'loose-kill'); }
  // Field lesson #221: an empty context file (0 bytes, or whitespace only) is always a mistake —
  // ask/validate/run refuse it by path — unless the manifest names it here as a deliberate
  // exception (e.g. a placeholder a job is meant to fill in).
  if (manifest.allowEmptyContext !== undefined) {
    if (!Array.isArray(manifest.allowEmptyContext) || manifest.allowEmptyContext.length > 100 || manifest.allowEmptyContext.some(file => typeof file !== 'string' || !file)) fail('allowEmptyContext must be an array of file paths');
  }
  // Field lesson #281: an untracked, uncontexted repo-relative path a prompt names is silently
  // absent from the copied workspace unless it is declared here — copied into every job below.
  if (manifest.resources !== undefined) {
    if (!Array.isArray(manifest.resources) || manifest.resources.length > 50) fail('resources must be an array of at most 50 file paths');
    if (new Set(manifest.resources).size !== manifest.resources.length) fail('Duplicate path in resources');
    for (const file of manifest.resources) relative(file);
  }
  // A skills source dir named here (or by local config `skills.dir`, absent here) is resolved
  // against the project root later (validate/run time), never here: this check is shape-only.
  if (manifest.skillsDir !== undefined && (typeof manifest.skillsDir !== 'string' || !manifest.skillsDir.trim())) fail('skillsDir must be a non-empty string');
  // A shared contract file is coordinator-owned: every job reads it, no job may overwrite it.
  if (manifest.contract !== undefined) {
    if (typeof manifest.contract !== 'string') fail('contract must be a relative file path');
    relative(manifest.contract);
  }
  if (manifest.concurrency !== undefined && (!Number.isInteger(manifest.concurrency) || manifest.concurrency < 1 || manifest.concurrency > 2048)) fail('Concurrency must be 1–2048');
  if (manifest.checks !== undefined) {
    if (!Array.isArray(manifest.checks) || manifest.checks.length > 10) fail('checks must be an array of at most 10 checks');
    for (const check of manifest.checks) {
      if (!check || typeof check !== 'object') fail('Invalid check');
      for (const key of Object.keys(check)) if (!['name', 'argv', 'timeoutMs', 'repeat', 'flakeRuns', 'integrateOnly', 'affectedArgv', 'fullEvery', 'cleanDirs', 'base'].includes(key)) fail(`Unknown check field: ${key}`);
      if (typeof check.name !== 'string' || !CHECK_NAME.test(check.name)) fail(`Invalid check name: ${check?.name}`);
      if (!Array.isArray(check.argv) || !check.argv.length) fail(`Check argv must be a non-empty array: ${check.name}`);
      if (check.argv.some(item => typeof item !== 'string')) fail(`Check argv items must be strings: ${check.name}`);
      if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1000 || check.timeoutMs > 1800000)) fail(`Check timeoutMs must be 1000–1800000: ${check.name}`);
      if (check.flakeRuns !== undefined && (!Number.isSafeInteger(check.flakeRuns) || check.flakeRuns < 1)) fail(`Check flakeRuns must be a positive integer: ${check.name}`);
      if (check.repeat !== undefined && (!Number.isInteger(check.repeat) || check.repeat < 1 || check.repeat > 20)) fail(`Check repeat must be 1–20: ${check.name}`);
      // Phase 15: a check may run only the tests a batch affects (queue mode); the normal argv still runs every fullEvery-th batch and on the last one.
      if (check.affectedArgv !== undefined && (!Array.isArray(check.affectedArgv) || check.affectedArgv.some(item => typeof item !== 'string') || check.affectedArgv.filter(item => item === '{affected}').length !== 1 || check.affectedArgv[0] === '{affected}')) fail(`Check affectedArgv must be an array of strings with exactly one {affected} item: ${check.name}`);
      if (check.fullEvery !== undefined && (check.affectedArgv === undefined || !Number.isInteger(check.fullEvery) || check.fullEvery < 1 || check.fullEvery > 100)) fail(`Check fullEvery must be 1–100 and needs affectedArgv: ${check.name}`);
      // Field lesson #238: a check that only ever runs outside the sandbox (needs network the
      // shell worker never gets) is skipped there and reported skipped-integrate-only, never a fail.
      if (check.integrateOnly !== undefined && typeof check.integrateOnly !== 'boolean') fail(`Check integrateOnly must be true or false: ${check.name}`);
      // `base: false` keeps a check out of `run`'s own base-check gate (it still runs at integrate).
      if (check.base !== undefined && typeof check.base !== 'boolean') fail(`Check base must be true or false: ${check.name}`);
      if (check.cleanDirs !== undefined && (!Array.isArray(check.cleanDirs) || check.cleanDirs.some(dir => !CLEANABLE_DIRS.includes(dir)))) fail(`Check cleanDirs may only name ${CLEANABLE_DIRS.join(', ')}: ${check.name}`);
    }
  }
  // Field lesson 109: env-sync commands to run before `checks` whenever integration touches a
  // lockfile — plain argv arrays, not named checks, since they exist to resync the env, not to pass/fail.
  if (manifest.preChecks !== undefined) {
    if (!Array.isArray(manifest.preChecks) || manifest.preChecks.length > 10) fail('preChecks must be an array of at most 10 argv arrays');
    for (const argv of manifest.preChecks) {
      if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string')) fail('Each preChecks entry must be a non-empty array of strings');
    }
  }
  if (manifest.mutants !== undefined) validateMutantsArray(manifest.mutants);
  if (manifest.mutantCheck !== undefined) {
    const check = manifest.mutantCheck;
    if (!check || typeof check !== 'object') fail('Invalid mutantCheck');
    for (const key of Object.keys(check)) if (!['argv', 'timeoutMs'].includes(key)) fail(`Unknown mutantCheck field: ${key}`);
    if (!Array.isArray(check.argv) || !check.argv.length) fail('mutantCheck argv must be a non-empty array');
    if (check.argv.some(item => typeof item !== 'string')) fail('mutantCheck argv items must be strings');
    if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1000 || check.timeoutMs > 1800000)) fail('mutantCheck timeoutMs must be 1000–1800000');
  }
  resolveLanes({ manifest });
  const ids = new Set();
  const writers = new Set();
  const outputJobs = outputJobIds === null ? null : new Set(outputJobIds);
  for (const job of manifest.jobs) {
    if (!job || typeof job.id !== 'string' || !ID.test(job.id) || ids.has(job.id.toLowerCase())) fail(`Invalid or duplicate job id: ${job?.id}`);
    ids.add(job.id.toLowerCase());
    // A human job is a task for the owner: shape-checked here, lifted out of the run before anything starts.
    if (isHumanJob(job)) {
      try { validateHumanJob(job); } catch (error) { fail(error.message, error.code ?? 'human-job-invalid'); }
      job.context = []; job.outputs = [];
      continue;
    }
    if (job.type !== undefined && (typeof job.type !== 'string' || !Object.hasOwn(JOB_TYPES, job.type))) fail(`Job ${job.id}: unknown type ${job.type}`, 'job-type-invalid');
    if (job.typeRoute !== undefined && (!job.type || !isDeepStrictEqual(job.typeRoute, JOB_TYPES[job.type].route))) fail(`Job ${job.id}: typeRoute must equal the preset route for its type`, 'job-type-invalid');
    if (![...CLI_AGENTS, ...API_AGENTS, 'auto'].includes(job.agent)) fail(`Unsupported agent: ${job.agent}`);
    // Decision #154: `sonnet-shell`/`opus-shell` expand to {model, shell: true, tier} here, so
    // every later check (and the saved manifest, state and inspect) sees the real model.
    expandShellPreset(job);
    if (job.shell !== undefined) {
      if (typeof job.shell !== 'boolean') fail(`Job ${job.id}: shell must be true or false`);
      if (job.agent !== 'claude') fail(`Job ${job.id} shell is only supported for agent claude`);
    }
    if (job.preset !== undefined && (job.shell !== true || !['sonnet-shell', 'opus-shell'].includes(job.preset))) fail(`Job ${job.id}: invalid preset`);
    if (job.networkAllow !== undefined) {
      if (job.shell !== true) fail(`Job ${job.id}: networkAllow is only supported for claude shell jobs`);
      validateNetworkAllow(job.networkAllow, job.id);
    }
    // Field lesson #262: a single-port loopback allowlist for the shell sandbox.
    if (job.loopbackAllow !== undefined) {
      if (job.shell !== true) fail(`Job ${job.id}: loopbackAllow is only supported for claude shell jobs`);
      validateLoopbackAllow(job.loopbackAllow, job.id);
    }
    // Every job, CLI or API, must name its model: the runner never falls back to a CLI default
    // (for Claude, that default is the user's own, often the most expensive, model).
    if (job.sensitive !== undefined && typeof job.sensitive !== 'boolean') fail(`Job ${job.id}: sensitive must be true or false`);
    if (job.agent === 'anthropic') { try { assertAnthropicModel(job); } catch (error) { fail(`Job ${job.id}: ${error.message}`, 'anthropic-model'); } }
    if (job.agent === 'openrouter' && job.sensitive !== false) fail(`Job ${job.id}: OpenRouter only gets jobs that set sensitive: false`, 'sensitive-openrouter');
    if (NON_SENSITIVE_ONLY_AGENTS.includes(job.agent) && job.sensitive !== false) fail(`Job ${job.id}: ${job.agent} only gets jobs that set sensitive: false`, 'sensitive-provider');
    if (job.agent === 'auto') {
      if (Object.hasOwn(job, 'model')) fail(`Job ${job.id}: agent auto picks its own model; omit model`, 'auto-model-forbidden');
    } else {
      if (typeof job.model !== 'string' || !job.model.trim()) fail(`Job ${job.id} requires an explicit model; the runner never uses a CLI default`);
      if (!(job.agent === 'codex' ? CODEX_MODEL : job.agent === 'cursor' ? CURSOR_MODEL : /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/).test(job.model)) fail('Invalid explicit model name');
    }
    if (job.testEnv !== undefined) {
      if (job.agent !== 'auto' && !isWorktreeWriter(job) && job.shell !== true) fail(`Job ${job.id}: testEnv is only supported for codex jobs, cursor jobs and claude shell jobs`);
      if (!job.testEnv || typeof job.testEnv !== 'object' || Array.isArray(job.testEnv)) fail(`Job ${job.id}: testEnv must be an object`);
      for (const [key, value] of Object.entries(job.testEnv)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`Job ${job.id}: invalid testEnv key ${key}`);
        // Field lesson #141: SWARM_PORT_BASE is always set by the runner itself, for every job
        // that runs in a worktree; a manifest testEnv can never override it.
        if (key === 'SWARM_PORT_BASE') fail(`Job ${job.id}: testEnv key SWARM_PORT_BASE is reserved`);
        if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)) fail(`Job ${job.id}: testEnv key ${key} looks like a secret`);
        if (typeof value !== 'string' || value.length > 200 || /[\r\n\0]/.test(value)) fail(`Job ${job.id}: invalid testEnv value for ${key}`);
        if (job.shell === true && !validateShellTestEnvKey(key)) fail(`Job ${job.id}: testEnv key ${key} is reserved for the shell sandbox`);
      }
    }
    if (job.readPaths !== undefined) {
      if (job.agent !== 'auto' && !isWorktreeWriter(job) && job.shell !== true) fail('readPaths is codex-only (also cursor, or claude with shell: true)');
      validateReadPaths(job.readPaths);
    }
    // Field lesson #142: run once, outside the sandbox, in the job's own worktree, before the
    // worker starts — a toolchain sync (`uv sync`, `npm ci`) needs network the worker never gets.
    if (job.setup !== undefined) {
      if (job.agent !== 'auto' && !isWorktreeWriter(job) && job.shell !== true) fail(`Job ${job.id}: setup is only supported for codex and claude shell jobs (and cursor jobs)`);
      if (!Array.isArray(job.setup) || job.setup.length > 5) fail(`Job ${job.id}: setup must be an array of at most 5 argv arrays`);
      for (const argv of job.setup) {
        if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string')) fail(`Job ${job.id}: each setup entry must be a non-empty array of strings`);
      }
    }
    // Field lesson #145: kept only on request, since the scratch dir sits outside every repo and
    // is otherwise removed once the job ends (success, failure or cancel alike).
    if (job.keepScratch !== undefined) {
      if (job.shell !== true) fail(`Job ${job.id}: keepScratch is only supported for claude shell jobs`);
      if (typeof job.keepScratch !== 'boolean') fail(`Job ${job.id}: keepScratch must be true or false`);
    }
    // Field lesson #282: a job may opt out of its own transcript landing on disk when it touches a
    // configured private path; the requirement itself is computed in validateProject (it needs the
    // local config's privateData.paths), this is only the field's own shape.
    if (job.privateData !== undefined && typeof job.privateData !== 'boolean') fail(`Job ${job.id}: privateData must be true or false`);
    if (job.maxOutputTokens !== undefined && ((!API_AGENTS.includes(job.agent) && job.agent !== 'auto') || !Number.isInteger(job.maxOutputTokens) || job.maxOutputTokens < 256 || job.maxOutputTokens > 32768)) fail('maxOutputTokens is API-only and must be 256–32768');
    if ((API_AGENTS.includes(job.agent) || job.agent === 'auto') && job.outputCapBytes !== undefined) validateOutputCap(job.outputCapBytes, `Job ${job.id}: outputCapBytes`);
    // Field lesson #231: a job cap enforced in code, never by prompt text alone; a job that
    // declares maxCredits with no readable creditPreflight refuses at validate/run time, before
    // any spend, rather than trusting a worker's own step to stop itself.
    if (job.maxCredits !== undefined && (typeof job.maxCredits !== 'number' || !Number.isFinite(job.maxCredits) || job.maxCredits <= 0)) fail(`Job ${job.id}: maxCredits must be a positive number`);
    if (job.creditPreflight !== undefined) {
      if (typeof job.creditPreflight !== 'string') fail(`Job ${job.id}: creditPreflight must be a relative file path`);
      relative(job.creditPreflight);
    }
    // tier is advisory routing metadata for the coordinator, not a model selector: an explicit
    // job.model always wins. expensive must name why, so the choice is inspectable, not gut feel.
    if (job.tier !== undefined && !TIERS.includes(job.tier)) fail(`Unknown tier: ${job.tier}`);
    if (job.tierReason !== undefined && (typeof job.tierReason !== 'string' || job.tierReason.length > 2000)) fail('Invalid tierReason');
    if (job.tier === 'expensive' && !job.tierReason?.trim()) fail(`expensive tier requires a non-empty tierReason: ${job.id}`);
    if (typeof job.prompt !== 'string' || !job.prompt.trim() || job.prompt.length > 100000) fail(`Invalid prompt: ${job.id}`);
    if (!Array.isArray(job.context) || !Array.isArray(job.outputs) || job.context.length > 100 || job.outputs.length > 100) fail('context and outputs must be explicit arrays of at most 100 files');
    if (job.scope !== undefined || job.outputDirs !== undefined) {
      if (job.scope !== 'open' || job.agent !== 'codex' || !Array.isArray(job.outputDirs) || !job.outputDirs.length || job.outputDirs.length > 20) fail(`scope-open-invalid: Job ${job.id}: scope open requires codex and non-empty outputDirs`, 'scope-open-invalid');
      const seen = new Set();
      for (const dir of job.outputDirs) {
        try {
          relative(dir);
          if (/[*?\[\]{}]/.test(dir) || seen.has(dir.toLowerCase())) throw Error('unsafe directory');
          seen.add(dir.toLowerCase());
        } catch { fail(`scope-open-path: Job ${job.id}: ${dir} is not a safe tracked directory`, 'scope-open-path'); }
      }
    }
    if (new Set(job.context).size !== job.context.length || new Set(job.outputs).size !== job.outputs.length) fail('Duplicate file path');
    for (const file of job.context) relative(file, false, { readOnly: true });
    for (const file of job.outputs) relative(file);
    const typeViolations = jobTypeOutputViolations(job);
    if (typeViolations.length) fail(`Job ${job.id} (type ${job.type}) may not write: ${typeViolations.join(', ')}`, 'job-type-output');
    // Decision #227: a deepseek/* model on OpenRouter writes bookkeeping files only.
    if (job.agent === 'openrouter') { const bad = nonBookkeepingOutputs(job.model, job.outputs); if (bad.length) fail(`Job ${job.id}: ${job.model} is for bookkeeping jobs only (PR payloads, changelogs, mutants files, metrics, .swarm-manifests/*.md); a contract or other .md with design content goes to a cheap Claude tier instead; refused outputs: ${bad.join(', ')}`); }
    if (job.resultFile !== undefined) {
      if (!job.outputs.includes(job.resultFile)) fail(`Job ${job.id}: resultFile must be one of its outputs`);
      relative(job.resultFile);
    }
    if (job.resultSchema !== undefined && (!Array.isArray(job.resultSchema) || job.resultSchema.some(key => typeof key !== 'string' || !key))) fail(`Job ${job.id}: resultSchema must be a list of keys`);
    // Names one of this job's own outputs as a post-build mutants source (same shape as
    // manifest.mutants), used automatically by `integrate --mutants` once that output exists.
    if (job.mutantsFile !== undefined) {
      if (typeof job.mutantsFile !== 'string' || !job.outputs.includes(job.mutantsFile)) fail(`Job ${job.id}: mutantsFile must be one of its outputs`);
    }
    if (job.contextGlob !== undefined) {
      if (!Array.isArray(job.contextGlob) || !job.contextGlob.length || job.contextGlob.length > 20) fail(`Job ${job.id}: contextGlob must be a non-empty array of at most 20 globs`);
      if (new Set(job.contextGlob).size !== job.contextGlob.length) fail(`Job ${job.id}: duplicate contextGlob entry`);
      for (const pattern of job.contextGlob) parseContextGlob(pattern);
    }
    for (const file of outputJobs && !outputJobs.has(job.id) ? [] : job.outputs) {
      // Compared in one normal form (no ./, no trailing slash, lower case), so spelling cannot hide an overlap.
      const normalOutput = path.posix.normalize(file).replace(/\/+$/, '').toLowerCase();
      if (writers.has(normalOutput)) fail(`Output collision (case-insensitive): ${file}`);
      writers.add(normalOutput);
    }
    // Tests a job knowingly leaves uncovered by context; same path rules as context/outputs.
    if (job.ignoreTestsReason !== undefined) {
      if (typeof job.ignoreTestsReason !== 'string') fail('ignoreTestsReason must be a string');
      const trimmedReason = job.ignoreTestsReason.trim();
      if (!trimmedReason || trimmedReason.length > 200 || /[\x00-\x1f\x7f]/.test(job.ignoreTestsReason) || /[\r\n]/.test(job.ignoreTestsReason)) fail('ignoreTestsReason must be a string of 1 to 200 characters (trimmed, no control characters, no newlines)');
      if (job.ignoreTests === undefined) fail('ignoreTestsReason requires an ignoreTests array');
    }
    if (job.ignoreTests !== undefined) {
      const ignoreTestsCap = job.ignoreTestsReason !== undefined && typeof job.ignoreTestsReason === 'string' && job.ignoreTestsReason.trim() ? 1000 : 100;
      const ignoreTestsCapMessage = ignoreTestsCap === 100 ? 'ignoreTests must be an array of at most 100 files' : 'ignoreTests must be an array of at most 1000 files';
      if (!Array.isArray(job.ignoreTests) || job.ignoreTests.length > ignoreTestsCap) fail(ignoreTestsCapMessage);
      if (new Set(job.ignoreTests).size !== job.ignoreTests.length) fail('Duplicate file path');
      for (const file of job.ignoreTests) relative(file);
    }
    // Field lesson #196: paths a job may remove (a stale vendored file its own outputs replace);
    // the worker's own boilerplate lists them instead of forbidding deletion outright, and
    // integrate only ever propagates a missing output for a path named here.
    if (job.deletes !== undefined) {
      if (!Array.isArray(job.deletes) || job.deletes.length > 100) fail(`Job ${job.id}: deletes must be an array of at most 100 files`);
      if (new Set(job.deletes).size !== job.deletes.length) fail(`Job ${job.id}: duplicate path in deletes`);
      for (const file of job.deletes) {
        relative(file);
        if (file.includes('*')) fail(`Job ${job.id}: deletes must not contain globs: ${file}`);
      }
    }
    if (job.dependencies !== undefined) {
      if (!Array.isArray(job.dependencies) || job.dependencies.length > 10 || job.dependencies.some(spec => !validDependencySpec(spec))) fail(`Job ${job.id}: dependencies must be at most 10 registry package names with an optional version`);
    }
    // A named `skills` list (even `[]`) overrides frontmatter `paths:` auto-attach for this job;
    // the names themselves are only checked against the skills source dir at validate/run time.
    if (job.skills !== undefined) {
      if (!Array.isArray(job.skills) || job.skills.length > 20 || job.skills.some(name => typeof name !== 'string' || !name)) fail(`Job ${job.id}: skills must be an array of at most 20 skill names`);
      if (new Set(job.skills).size !== job.skills.length) fail(`Job ${job.id}: duplicate name in skills`);
    }
    if (manifest.contract !== undefined) {
      if (!job.context.includes(manifest.contract)) fail(`Job ${job.id}: context must include the shared contract file: ${manifest.contract}`);
      if (job.outputs.includes(manifest.contract)) fail(`Job ${job.id}: outputs must not include the shared contract file (only the coordinator writes it): ${manifest.contract}`);
    }
    // A job runs only after every job it names in `after` has completed; see the second pass below.
    if (job.after !== undefined) {
      if (!Array.isArray(job.after) || !job.after.length || job.after.length > 100 || job.after.some(item => typeof item !== 'string')) fail(`Job ${job.id}: after must be a non-empty array of job ids`);
      if (job.after.includes(job.id)) fail(`Job ${job.id} after names itself`);
      if (new Set(job.after).size !== job.after.length) fail(`Job ${job.id} has duplicate entries in after`);
      if (isWorktreeWriter(job)) fail(`after is not supported for ${job.agent} jobs yet`);
    }
    if (job.timeoutMs !== undefined && (!Number.isInteger(job.timeoutMs) || job.timeoutMs < 50 || job.timeoutMs > 3600000)) fail('timeoutMs must be 50–3600000');
    // web adds browsing tools to a restricted claude worker; it must stay read-only.
    if (job.web !== undefined) {
      if (job.web !== true) fail(`Invalid web field: ${job.id}`);
      if (job.agent !== 'claude' && job.agent !== 'auto') fail('web is only supported for the claude agent');
      if (job.shell === true) fail(`Job ${job.id}: shell cannot be combined with web`);
      if (job.outputs.length) fail('a web job must be read-only (no outputs)');
    }
    // Unknown command/provider fields cannot create an execution path.
    if (job.type === 'lead') validateLeadArea(job);
    else if (job.area !== undefined) fail(`lead-area-invalid: Job ${job.id}: area requires type lead`, 'lead-area-invalid');
    const knownJobFields = ['area', 'type', 'typeRoute', 'sensitive', 'id', 'agent', 'model', 'tier', 'tierReason', 'prompt', 'context', 'outputs', 'timeoutMs', 'maxOutputTokens', 'readPaths', 'ignoreTests', 'ignoreTestsReason', 'after', 'web', 'testEnv', 'resultFile', 'resultSchema', 'mutantsFile', 'contextGlob', 'shell', 'preset', 'networkAllow', 'loopbackAllow', 'setup', 'keepScratch', 'deletes', 'dependencies', 'skills', 'maxCredits', 'creditPreflight', 'privateData', 'outputCapBytes', 'scope', 'outputDirs', 'report', 'allowProtectedContext', 'cacheContext', 'batch', 'contract', 'acceptance', 'bestOf', 'hard'];
    for (const key of Object.keys(job)) if (!knownJobFields.includes(key)) fail(unknownJobFieldMessage(key, knownJobFields));
    if (job.batch !== undefined && typeof job.batch !== 'boolean') fail(`Job ${job.id}: batch must be true or false`, 'batch-invalid');
    if (job.hard !== undefined && typeof job.hard !== 'boolean') fail(`Job ${job.id}: hard must be true or false`, 'hard-invalid');
    if (job.bestOf !== undefined && (!Number.isInteger(job.bestOf) || job.bestOf < 1 || job.bestOf > 8 || !['rented', 'auto'].includes(job.agent))) fail(`Job ${job.id}: bestOf must be a whole number from 1 to 8, and only for the rented lane`, 'bestof-invalid');
    if (job.contract !== undefined && (typeof job.contract !== 'string' || !job.contract.trim() || job.contract.length > 200 || !Array.isArray(job.context) || !job.context.includes(job.contract))) fail(`Job ${job.id}: contract must name a file that is also in context`, 'contract-invalid');
    if (job.acceptance !== undefined && (!Array.isArray(job.acceptance) || job.acceptance.length > 20 || job.acceptance.some(item => typeof item !== 'string' || !item.trim() || item.length > 300))) fail(`Job ${job.id}: acceptance must be a list of at most 20 non-empty strings of at most 300 characters`, 'acceptance-invalid');
    if (job.cacheContext !== undefined) {
      if (!Array.isArray(job.cacheContext) || !job.cacheContext.length || job.cacheContext.length > 10 || job.cacheContext.some(file => typeof file !== 'string' || !(job.context ?? []).includes(file)) || new Set(job.cacheContext).size !== job.cacheContext.length) fail(`Job ${job.id}: cacheContext must be 1-10 unique paths that are also in context`, 'cache-context-invalid');
      if (!['anthropic', 'auto', 'local'].includes(job.agent)) fail(`Job ${job.id}: cacheContext is for API lanes that honor prompt caching (agent anthropic, local, or auto)`, 'cache-context-invalid');
    }
    if (job.allowProtectedContext !== undefined && (typeof job.allowProtectedContext !== 'string' || !job.allowProtectedContext.trim() || job.allowProtectedContext.length > 200)) fail(`Job ${job.id}: allowProtectedContext must be a reason of 1-200 characters`, 'allow-protected-context-invalid');
  }
  validateParentLeads(manifest);
  // A second pass: every `after` id must exist and the whole graph must be acyclic.
  for (const job of manifest.jobs) for (const afterId of job.after ?? []) if (!ids.has(afterId.toLowerCase())) fail(`Job ${job.id} after names unknown job ${afterId}`);
  const cycle = detectAfterCycle(manifest.jobs);
  if (cycle) fail(`after cycle: ${cycle.join(' -> ')}`);
  // A path overlaps another when one of its parent folders is itself an output: one set lookup per parent, not one comparison per pair.
  for (const b of writers) {
    const parts = b.split('/');
    for (let length = 1; length < parts.length; length++) {
      const parent = parts.slice(0, length).join('/');
      if (writers.has(parent)) fail(`Overlapping output paths: ${parent}, ${b}`);
    }
  }
  // Field lesson #294: check output capacity for API agents with maxOutputTokens
  for (const job of manifest.jobs) {
    if (job.maxOutputTokens && API_AGENTS.includes(job.agent)) {
      // Estimate output size: ~500 tokens per output file
      const estimatedTokens = (job.outputs ?? []).length * 500;
      if (estimatedTokens > job.maxOutputTokens) fail(`output-cap-too-small: Job ${job.id}: ${job.outputs.length} outputs estimated at ~${estimatedTokens} tokens exceed maxOutputTokens ${job.maxOutputTokens}`);
    }
  }
  return manifest;
}

const UNCOVERED_TEST_REFERENCES_HEADER = 'Uncovered test references (add the test to context, or list it in ignoreTests with a reason in the prompt): ';

export function ignoreTestsPromptLineCoversTest(prompt, testPath) {
  const normalized = String(testPath).replace(/\\/g, '/');
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`ignoreTests:\\s*${escaped}(?:\\s|$)`, 'm').test(String(prompt ?? ''));
}

export function ignoreTestsReasonCoversJob(job) {
  return typeof job?.ignoreTestsReason === 'string' && job.ignoreTestsReason.trim().length > 0;
}

export function effectiveIgnoreTestsForCoverage(job) {
  const list = job.ignoreTests ?? [];
  if (!list.length) return list;
  if (list.length <= 100 && job.ignoreTestsReason === undefined) return list;
  if (ignoreTestsReasonCoversJob(job)) return list;
  return list.filter(test => ignoreTestsPromptLineCoversTest(job.prompt, test));
}

export function formatUncoveredTestReferencesError(uncovered, manifestJobs = []) {
  const byId = new Map((manifestJobs ?? []).map(job => [job.id, job]));
  const parts = uncovered.map(item => {
    const job = byId.get(item.job);
    const reason = ignoreTestsReasonCoversJob(job) ? job.ignoreTestsReason.trim() : '';
    const base = `${item.job}: ${item.output} <- ${item.test}`;
    return reason ? `${base} (ignoreTestsReason: ${reason})` : base;
  });
  return UNCOVERED_TEST_REFERENCES_HEADER + parts.join('; ');
}

// The retained proposal workspace contains only declared outputs. The runnable checkout is
// disposable unless a fallback requires it or a failed worker changed declared outputs.
// Lessons 41/64: kept worktrees stay where state.json records them (`worktreePath`) for inspection;
// T86 config `worktreesOutsideRoot` places them outside the root, else under .swarm/runs/<id>/worktrees/.
async function jobWorktreePath(root, directory, jobId) {
  return safePath(root, path.relative(root, resolveWorktree({ root, id: path.basename(directory) }, { id: jobId })), { internal: true, parents: true });
}

// Field lesson #271: a dropped write (an edit outside job.outputs) is saved to
// `.swarm/runs/<id>/dropped/<path>` at the moment it is detected, so a run that would otherwise
// refuse over one can still be salvaged instead of the edit only ever surviving inside a workspace
// integrate never looks at again. A base copy still on disk gets a unified diff alongside it
// (`<path>.diff`); a `git diff --no-index` for a shell/worktree job (a real git checkout is on
// hand), a synthetic `--- a/<path>` / `+++ b/<path>` stub for a copied workspace job, which has none.
async function saveDroppedWrite(root, id, file, afterBytes, baseBytes, { useGit = false } = {}) {
  const dest = await safePath(root, `.swarm/runs/${id}/dropped/${file}`, { internal: true, parents: true });
  if (afterBytes === null) { await fs.rm(dest, { force: true }); return; }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, afterBytes);
  if (baseBytes === null) return;
  const diff = useGit ? await gitDiffNoIndexBytes(file, baseBytes, afterBytes) : syntheticDiff(file, baseBytes, afterBytes);
  if (diff) await fs.writeFile(`${dest}.diff`, diff);
}

// A worker's final structured result may follow ordinary trailing log lines, be wrapped in
// backticks (lesson #54), or sit inside a pretty-printed ```json fence (lesson #58). Field lesson
// #146: naive per-line parsing can match a nested inner object (e.g. one element of a
// "checksRun" array) before it ever reaches the real top-level object, so extraction instead finds
// the last *balanced top-level* object — preferring the last fenced block when one exists.
export function parseFinalJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const fences = [...text.matchAll(/```[a-zA-Z]*[ \t]*\n([\s\S]*?)\n[ \t]*```/g)];
  if (fences.length) {
    const value = lastTopLevelObject(fences[fences.length - 1][1]);
    if (value) return value;
  }
  return lastTopLevelObject(text);
}

export async function runChecks(root, checks, integratedFiles, newFiles, spawnImpl, { baseCommit, noFlakeCheck = false, portBase, preChecks = [], extraEnv = {}, env: parentEnv = process.env, gitImpl = git, affected = null, readMachine: readMachineFn = readMachine, memoryPressureSleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Field lesson #160: the root's .swarm/env.json (extraEnv) reaches every check, never PATH/HOME.
  const env = portBase != null || Object.keys(extraEnv).length ? { ...parentEnv, ...extraEnv, ...(portBase != null ? { SWARM_PORT_BASE: String(portBase) } : {}) } : parentEnv;
  const results = [];
  // Field lesson 134/138/152: a check that never started gets one automatic resync (the
  // manifest's own preChecks, run at most once for the whole batch) plus a single retry before
  // it is ever reported red; a check that already ran and genuinely failed never gets this.
  let preChecksRetryPromise = null;
  const runPreChecksOnce = () => {
    preChecksRetryPromise ??= (async () => {
      const log = [];
      for (const [index, argv] of preChecks.entries()) log.push(await runCheck(argv.join(' ').slice(0, 60) || `preCheck-${index + 1}`, expandRootArgv(argv, root), root, 300000, spawnImpl, false, () => {}, env));
      return log;
    })();
    return preChecksRetryPromise;
  };
  for (const check of checks) {
    // Affected-only: this check's own affectedArgv runs when the batch's selection is `affected` and the check is not due for a full run.
    let affectedMode = null;
    let sourceArgv = check.argv;
    if (check.affectedArgv && affected && affected.selection.mode === 'affected' && !affected.useFull(check)) {
      const expanded = expandAffectedArgv(check.affectedArgv, affected.selection);
      if (expanded.empty) { results.push({ name: check.name, status: 'skipped', exitCode: null, durationMs: 0, tail: '', runs: 0, mode: 'affected', affectedTests: 0 }); continue; }
      sourceArgv = expanded.argv;
      affectedMode = { tests: affected.selection.tests.length };
    }
    const { argv, empty } = expandCheckArgv(sourceArgv, integratedFiles, newFiles, root);
    if (empty) { results.push({ name: check.name, status: 'skipped', exitCode: null, durationMs: 0, tail: '', runs: 0 }); continue; }
    // Stale generated files (a deleted page still named in .next/types) must not fail this check.
    // next-env.d.ts names .next/types/routes.d.ts when typed routes are on: that file would not come back, so the folder stays.
    const nextEnv = (check.cleanDirs ?? []).length ? await fs.readFile(path.join(root, 'next-env.d.ts'), 'utf8').catch(() => '') : '';
    for (const dir of (check.cleanDirs ?? []).filter(d => CLEANABLE_DIRS.includes(d) && !/\.next\/types\/routes/.test(nextEnv))) await fs.rm(path.join(root, dir), { recursive: true, force: true }).catch(() => {});
    // Field lesson #175: a bare check argv[0] (e.g. "uv") is not reliably on PATH when it lives
    // only in the swarm's own toolchains dir; resolved here the same way the uv lock check already
    // is (toolchains dir, then PATH) before ever spawning, so an unresolvable one refuses just this
    // check at once, naming every path tried, instead of a spawn-error with no program or PATH shown.
    let resolvedProgram = null;
    if (!path.isAbsolute(argv[0]) && !argv[0].startsWith('.')) {
      const resolved = await resolveToolchainBin(argv[0], { env });
      if (!resolved.path) {
        results.push({ name: check.name, status: 'cannot-run', exitCode: null, durationMs: 0, tail: '', runs: 0, hint: `cannot-run: ${argv[0]} not found (tried ${resolved.tried.join(', ')})` });
        continue;
      }
      resolvedProgram = resolved.path;
    }
    let runArgv = resolvedProgram ? [resolvedProgram, ...argv.slice(1)] : argv;
    let memoryPressureWarning = null;
    let memoryProbeWarning = null;
    if (check.name === 'tests' && isNodeTestCommand(runArgv)) {
      try {
        let machine = await readMachineFn();
        if (machine?.warning) {
          logMemoryProbeWarningOnce(machine.warning);
          memoryProbeWarning = machine.warning;
        }
        let pressure = memoryPressureLevel(machine);
        if (pressure === 'hard') {
          const deadline = Date.now() + MEMORY_HARD_WAIT_MS;
          const maxPolls = Math.ceil(MEMORY_HARD_WAIT_MS / MEMORY_POLL_MS);
          let polls = 0;
          while (pressure === 'hard' && polls < maxPolls && Date.now() < deadline) {
            await memoryPressureSleep(MEMORY_POLL_MS);
            polls += 1;
            machine = await readMachineFn();
            pressure = memoryPressureLevel(machine);
          }
          if (pressure === 'hard') memoryPressureWarning = 'ran under memory pressure';
        }
        runArgv = applyNodeTestConcurrency(runArgv, testConcurrencyFor(machine));
      } catch { /* memory gate skipped when probe fails */ }
    }
    // repeat runs the same check up to `repeat` times and stops at the first non-passing run.
    const repeat = check.repeat ?? 1;
    let result, runs = 0, failedFile, outputWindow = '', swarmLineCount = 0;
    const identifyTest = data => {
      if (failedFile) return;
      outputWindow += data.toString('utf8');
      failedFile = outputWindow.match(/(?:[A-Za-z0-9_.-]+\/)*(?:tests?|__tests__)\/[^\s:'"()]+?\.(?:test|spec)\.[cm]?[jt]sx?\b|(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.test\.[cm]?[jt]sx?\b/)?.[0];
      outputWindow = outputWindow.slice(-4096);
    };
    for (let attempt = 1; attempt <= repeat; attempt++) {
      runs = attempt; failedFile = undefined; outputWindow = '';
      result = await runCheck(check.name, runArgv, root, check.timeoutMs ?? 300000, spawnImpl, false, identifyTest, env, { ignoreSwarmPaths: true });
      swarmLineCount += result.swarmLineCount ?? 0;
      if (result.status !== 'passed') break;
    }
    if (CHECK_ERRORED_STATUSES.has(result.status)) {
      if (preChecks.length) await runPreChecksOnce();
      result = { ...await runCheck(check.name, runArgv, root, check.timeoutMs ?? 300000, spawnImpl, false, () => {}, env, { ignoreSwarmPaths: true }), retriedAfterError: true };
      swarmLineCount += result.swarmLineCount ?? 0;
    }
    if (swarmLineCount) result.swarmLineCount = swarmLineCount;
    // A test check that passed but ran no test is a failure (the wrong runner for these files looks green).
    result = zeroTestGuard(check, result);
    const checkWarning = [memoryProbeWarning, memoryPressureWarning].filter(Boolean).join('; ')
      || null;
    if (checkWarning) result = { ...result, warning: checkWarning };
    if (affectedMode) { result.mode = 'affected'; result.affectedTests = affectedMode.tests; }
    // Field lesson #239: the orchestrator's own run outside the sandbox is the truth — a check
    // whose output shows it never really ran (macOS denying a nested sandbox_apply call) is tagged
    // sandbox-only rather than folded into a real failure count.
    if (result.status === 'failed' && SANDBOX_ONLY_RE.test(result.tail)) result = { ...result, status: 'sandbox-only', sandboxOnly: true };
    if (check.repeat !== undefined && result.status === 'failed' && !noFlakeCheck && baseCommit) {
      const file = failedFile;
      if (file) {
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-flake-'));
        const checkout = path.join(temporary, 'base');
        let added = false;
        try {
          await gitImpl(root, ['worktree', 'add', '--detach', checkout, baseCommit]);
          added = true;
          const baseArgvRaw = expandCheckArgv(check.argv, integratedFiles, newFiles, checkout).argv;
          const baseArgv = resolvedProgram ? [resolvedProgram, ...baseArgvRaw.slice(1)] : baseArgvRaw;
          const count = Math.min(check.flakeRuns ?? repeat, 20);
          let failed = 0;
          for (let attempt = 0; attempt < count; attempt++) {
            const probe = await runCheck(check.name, [...baseArgv, file], checkout, check.timeoutMs ?? 300000, spawnImpl, false, () => {}, env);
            if (!['passed', 'failed'].includes(probe.status)) throw Error(probe.hint ?? `base check ${probe.status}`);
            if (probe.status === 'failed') failed++;
          }
          result.flakeOnBase = { file, failed, runs: count };
          process.stderr.write(`flake on base: ${failed}/${count} (${file})\n`);
        } catch (error) {
          process.stderr.write(`flake on base: could not complete (${file}): ${error.message}\n`);
        } finally {
          try { if (added) await gitImpl(root, ['worktree', 'remove', '--force', checkout]); }
          catch (error) { process.stderr.write(`flake on base: cleanup failed: ${error.message}\n`); }
          finally { await fs.rm(temporary, { recursive: true, force: true }); }
        }
      }
    }
    // Field lesson #253: only a genuine `failed` (never skipped/errored/sandbox-only) is worth
    // the cost of a base re-run; those other statuses were never a real red-vs-green verdict.
    // The flake-on-base run just above already answers this exact question when it ran (same
    // failing check, same base commit) — reused instead of spawning a second, redundant base run.
    const origin = result.status !== 'failed' || !baseCommit ? null
      : result.flakeOnBase ? (result.flakeOnBase.failed > 0 ? 'pre-existing' : 'new')
      : await originForCheck(root, baseCommit, check, integratedFiles, newFiles, resolvedProgram, spawnImpl, env, gitImpl);
    results.push({ ...result, runs, ...(origin ? { origin } : {}), ...(result.status !== 'passed' ? { failedRun: runs } : {}) });
  }
  // Field lesson 110: a compact per-check failure summary (name + last few failing lines,
  // capped) so a coordinator does not have to open the full tail to see what broke.
  const NOT_PASSED = ['failed', 'timeout', 'spawn-error', 'unrunnable', 'cannot-run', 'check-env-missing', 'cleanup-failed', 'cancelled'];
  const failures = results.filter(check => NOT_PASSED.includes(check.status)).map(check => ({ name: check.name, lines: lastFailureLines(check.tail), ...(check.origin ? { origin: check.origin } : {}) }));
  // Field lesson 138 (tool half): a check that never started is invalid evidence, not a red
  // check; surfaced distinctly so a caller (integrate/selfCheck) can refuse to score it as either.
  const checksErrored = results.some(check => CHECK_ERRORED_STATUSES.has(check.status));
  return {
    checks: results,
    checksPassed: results.every(check => !NOT_PASSED.includes(check.status)),
    checksErrored,
    failures,
    ...(preChecksRetryPromise ? { retryPreChecks: await preChecksRetryPromise } : {}),
  };
}

export { bytesAt, expandContextGlobs, jobWorktreePath, jsonWrite, mutantReviewTexts, saveDroppedWrite, write };
