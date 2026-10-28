import { API_AGENTS, decodeContext } from '../api-adapters.mjs';
import { listLiveRuns } from '../board.mjs';
import { CLAUDE_SHELL_PAUSED, claudeShellPausedProblem, resolveRootGitInfo } from '../claude-shell.mjs';
import { codexDirtyFiles, git, prepareWorkspaceEnvironment, resolveReadPaths } from '../codex-adapter.mjs';
import { contextDirectoryWarnings, findUncoveredTests, isTestFile, listProjectFiles, registryPinningWarnings, suggestIgnoreTests } from '../context-check.mjs';
import { windowsCiGotchasWarnings } from '../gotchas.mjs';
import { resolveLanes } from '../lanes.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { anthropicLanePausedProblem, ANTHROPIC_LANE_PAUSED } from '../anthropic.mjs';
import { defaultMaxOutputTokens, openrouterLanePausedProblem, OPENROUTER_LANE_PAUSED } from '../openrouter.mjs';
import { packagingWithoutBuildCheckWarning } from '../packaging-check.mjs';
import { resolvePortBlock } from '../ports.mjs';
import { loadRentedConfig, rentedSensitiveOk } from '../rented.mjs';
import { validateReport } from '../reports.mjs';
import { rentedContractProblem } from '../router.mjs';
import { commandHandlers, commandHandlerWarnings } from '../scaffold.mjs';
import { assertNoSkillSymlinks, listSkills, refuseOversizeSkills, resolveSkillsDir, skillSizeWarnings } from '../skills.mjs';
import { ledgerRows, mergeLedger, runIdleMenu } from '../spend.mjs';
import { checkNeedsEnvWarnings, loadSwarmEnv, npmScriptsResolveToPlainNode } from '../swarm-env.mjs';
import { baseCheckSkipReason, expandRootArgv } from './checks.mjs';
import { applyManifestJobTypes, attachJobSkills, cappedNotes, codexRequiredReadMissingWarnings, contractFilesLinePaths, coreModuleNoShellWarning, digest, execFileAsync, extractFailureLocations, fail, sumCreditPreflight, summarizeRun, validateOutputCap } from './core-1.mjs';
import { cheapTierNotConfiguredModelWarnings, checkPathMissingWarnings, cursorClaimConflicts, dispatchResultKeysRefusal, eventReaderNoProducerWarnings, liveOutputConflicts, runCheck, runtimeCheckNoShellWarning, tmpToolPathWarnings, worktreesBaseFor } from './core-11.mjs';
import { enforceProtectedPaths } from './core-12.mjs';
import { readProjectsRegistry, readyAutoJobs, withoutApiOnlyFields } from './core-2.mjs';
import { loadMutantsFile, safePath, shellSandboxDeniedCheckWarnings, validateMutantsArray } from './core-21.mjs';
import { bytesAt, expandContextGlobs, jsonWrite, promptPathsNotInWorkspaceWarnings, runChecks, validateManifest, write } from './core-31.mjs';
import { editInPlaceOnlyJobs } from './core-32.mjs';
import { expandOpenScopes, jobFinalJson, ledgerSettings, loadJobMutantsFile, missingDepsWarnings, missingLockPathSourceWarnings, pendingBaseCheck, pickJobRoute, privateNamesDispatchGuard, readState, recoverIntegrationJournal, reportObject, runJobSetup } from './core-41.mjs';
import { CONTEXT_TOTAL_CAP, INACTIVE_RUN, LARGE_OUTPUT_WHOLE_BYTES, MAX_CONTEXT, MISSING_EXPORT_RE, OUTPUT_CAP_BYTES, UNFINISHED_JOB } from './patterns.mjs';
import { costNotReported, jobTokens, tokensTotal } from './run-state.mjs';
import { contextSiblingUntrackedWarnings, linkedWorktreeCommitWarning, liveServiceCheckoutWarning, modelRouteChangeNoSmokeTestWarning, narrowOutputScopeWarning, privateDataRequiredWarning, runWarnings, sharedOutputAcrossOpenJobsWarnings, sharedRootFullSuiteWarnings, shellPythonNoSetupWarning, staleEnvRiskWarning, testsWithoutShellWarning, tightTestTimeoutWarnings, undeclaredMutantsFileWarnings, utcOnlyWindowTestWarning, workFolderContextWarnings } from './warnings.mjs';
import { isTrackedByGit, isWorktreeWriter } from './workspace.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Sync precedes explicit setup; root links are added only after setup finishes.
async function prepareJobEnvironment(root, directory, job, worktree, options) {
  const home = options.env?.HOME ?? os.homedir();
  const config = loadLocalConfig({ env: options.env, home });
  const setup = async argv => {
    let result;
    const error = await runJobSetup(root, directory, { ...job, setup: [argv] }, worktree, options.spawnImpl, options.portBase, options.cancelled, options.swarmEnv, check => { result = check; });
    return { ...result, ...(error ? { error } : {}) };
  };
  let prepared;
  if (options.sync) {
    prepared = await prepareWorkspaceEnvironment(root, worktree, { sync: true, runSetup: setup, home, config });
    if (prepared.setupResult && prepared.setupResult.status !== 'passed') return prepared;
  }
  const error = await runJobSetup(root, directory, job, worktree, options.spawnImpl, options.portBase, options.cancelled, options.swarmEnv);
  if (error) return { environmentReadPaths: [], setupResult: { status: 'failed', error } };
  return prepared ?? prepareWorkspaceEnvironment(root, worktree, { home, config });
}

const checkWorkerReport = (job, result) => {
  const value = reportObject(job, result);
  return value == null ? { report: null, errors: ['no final report'] } : validateReport(value, { outputs: job.outputs });
};

export async function runBaseChecks(root, manifest, { spawnImpl = spawn, gitImpl, baseSha: baseShaOverride, env = process.env } = {}) {
  const checks = manifest.checks ?? [];
  if (!checks.length) return { baseSha: null, status: 'green', failures: [] };
  const baseSha = baseShaOverride ?? (await (gitImpl ?? git)(root, ['rev-parse', 'HEAD'])).trim();
  const cacheRel = `.swarm/base-checks/${baseSha}.json`;
  // The cached verdict belongs to one set of checks: a record from different checks (or from an
  // older runner that ran placeholders literally, with no checksKey at all) is recomputed.
  const checksKey = digest(JSON.stringify(checks.map(check => [check.name, check.argv, check.base ?? true])));
  const cached = await bytesAt(root, cacheRel, true);
  if (cached) {
    try { const record = JSON.parse(cached.toString('utf8')); if (record.checksKey === checksKey) return record; } catch { /* recompute below */ }
  }
  const failures = [];
  const failureLocations = {};
  const skipped = [];
  const outputFiles = new Set(manifest.jobs.flatMap(job => job.outputs ?? []));
  const pending = [];
  for (const check of checks) {
    const skipReason = baseCheckSkipReason(check);
    if (skipReason) { skipped.push({ name: check.name, reason: skipReason }); continue; }
    const pendingCheck = await pendingBaseCheck(root, check, outputFiles);
    if (pendingCheck) { pending.push(pendingCheck); continue; }
    const outcome = await runCheck(check.name, expandRootArgv(check.argv, root), root, check.timeoutMs ?? 300000, spawnImpl, false, () => {}, env);
    if (outcome.status !== 'passed') {
      failures.push(check.name);
      failureLocations[check.name] = extractFailureLocations(`${outcome.tail ?? ''}\n${outcome.hint ?? ''}`);
    }
  }
  const record = { baseSha, checksKey, status: failures.length ? 'red' : pending.length ? 'pending' : 'green', failures, failureLocations, skipped, ...(pending.length ? { pending: pending.map(check => check.name), pendingChecks: pending } : {}) };
  await jsonWrite(root, cacheRel, record);
  return record;
}

async function appendRunLedger(root, state, manifest, { persist = true } = {}) {
  state.ledger ??= await ledgerSettings(root, manifest, {});
  let added = 0;
  try {
    const written = new Set(state.ledgerKeys ?? []);
    const prompts = new Map(manifest.jobs.map(job => [job.id, job.prompt]));
    const rows = ledgerRows({ ...state, jobs: state.jobs.map(record => ({ ...record, prompt: prompts.get(record.id) })) }, state.ledger).filter(row => !written.has(row.key));
    if (rows.length) {
      const prior = (await bytesAt(root, state.ledger.path, true))?.toString('utf8') ?? '';
      await write(root, state.ledger.path, mergeLedger(prior, rows), true);
      state.ledgerKeys = [...written, ...rows.map(row => row.key)];
      added = rows.length;
    }
  } catch (error) {
    (state.spendWarnings ??= []).push(`ledger-write-failed: ${error.message}`);
    state.warnings = runWarnings(state);
  }
  if (persist) await jsonWrite(root, `.swarm/runs/${state.id}/state.json`, state);
  return { path: state.ledger.path, added };
}

export async function idleRun(root, id, { now = Date.now } = {}) {
  const state = await readState(root, id);
  const manifest = JSON.parse(await bytesAt(root, `.swarm/runs/${id}/manifest.json`, true));
  const items = state.idle ?? manifest.idle ?? loadLocalConfig({}).idle ?? [];
  return runIdleMenu(root, { runId: id, items, baseCommit: state.baseCommit, now });
}

export async function cancelRun(root, id) {
  const state = await readState(root, id);
  if (state.status !== 'running') fail(`Run is already ${state.status}`);
  await write(root, `.swarm/runs/${id}/cancel`, 'cancel\n', true);
  return { id, status: 'cancellation-requested' };
}

export async function cancelInactiveRun(root, id) {
  const state = await readState(root, id);
  if (!INACTIVE_RUN.includes(state.status)) fail(`Run is ${state.status}, not paused or queued`);
  const now = new Date().toISOString();
  const cancelled = [];
  for (const job of state.jobs ?? []) {
    if (!UNFINISHED_JOB.includes(job.status)) continue;
    job.status = 'cancelled'; job.finishedAt = job.finishedAt ?? now;
    for (const key of ['heldReason', 'heldUntil']) delete job[key];
    cancelled.push(job.id);
  }
  delete state.pause;
  state.status = 'cancelled';
  state.cancelledAt = now;
  await jsonWrite(root, `.swarm/runs/${id}/state.json`, state);
  return { id, status: 'cancelled', cancelledJobs: cancelled };
}

// T86: list-only report of scratch worktree dirs no run's state.json records; never deletes.
export async function listOrphanWorktrees(root, { env = process.env } = {}) {
  const realRoot = await fs.realpath(root);
  const base = await worktreesBaseFor(realRoot, loadLocalConfig({ env }), { env });
  const referenced = new Set();
  const runIds = await fs.readdir(path.join(realRoot, '.swarm', 'runs')).catch(() => []);
  for (const runId of runIds) {
    let state;
    try { state = await readState(realRoot, runId); } catch { continue; }
    for (const job of state.jobs ?? []) if (typeof job.worktreePath === 'string' && job.worktreePath) referenced.add(job.worktreePath);
  }
  const orphans = [];
  for (const runDir of await fs.readdir(base, { withFileTypes: true })) {
    if (!runDir.isDirectory()) continue;
    for (const jobDir of await fs.readdir(path.join(base, runDir.name), { withFileTypes: true })) {
      const candidate = path.join(base, runDir.name, jobDir.name);
      if (!referenced.has(candidate)) orphans.push(candidate);
    }
  }
  return { base, orphans: orphans.sort(), deleted: 0 };
}

// Field lesson #277: a running daily spend total, checked before every dispatch — the same
// `state.jobs[].costUsd` field waitRun already sums for one run, summed here across every run
// under every root named in .swarm-projects.json, filtered to a run started at/after today's UTC
// midnight (never the process's own local time zone).
export async function todaySpendUsd(root, { now = () => new Date() } = {}) {
  const dayStart = new Date(now()); dayStart.setUTCHours(0, 0, 0, 0);
  const roots = [...new Set([root, ...(await readProjectsRegistry(root))])];
  let total = 0;
  for (const projectRoot of roots) {
    let ids; try { ids = await fs.readdir(path.join(projectRoot, '.swarm/runs')); } catch { continue; }
    for (const id of ids) {
      let state; try { state = await readState(projectRoot, id); } catch { continue; }
      if (!state.startedAt || new Date(state.startedAt) < dayStart) continue;
      for (const job of state.jobs ?? []) if (typeof job.costUsd === 'number') total += job.costUsd;
      if (typeof state.orphanCostUsd === 'number') total += state.orphanCostUsd;
    }
  }
  return Math.round(total * 100) / 100;
}

// Polls saved run state only; it never touches provider processes itself, so a wait can be
// interrupted and re-run without side effects on the run it is watching.
export async function waitRun(root, id, { timeoutMs, pollMs = 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  root = await fs.realpath(root);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0)) fail('timeoutMs must be a non-negative integer');
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) fail('pollMs must be 1–1000');
  const deadline = timeoutMs !== undefined ? now() + timeoutMs : null;
  let state = await readState(root, id);
  while (state.status === 'running') {
    if (deadline !== null && now() >= deadline) break;
    await sleep(deadline !== null ? Math.max(1, Math.min(pollMs, deadline - now())) : pollMs);
    state = await readState(root, id);
  }
  const jobs = [];
  let total = 0, any = false;
  for (const record of state.jobs) {
    const parsed = await jobFinalJson(root, id, record.id);
    const costUsd = typeof record.costUsd === 'number' ? record.costUsd : null;
    if (costUsd !== null) { total += costUsd; any = true; }
    jobs.push({ id: record.id, status: record.status, costUsd, tokens: jobTokens(record), notes: cappedNotes(parsed) });
  }
  if (typeof state.orphanCostUsd === 'number' && Number.isFinite(state.orphanCostUsd)) { total += state.orphanCostUsd; any = true; }
  return { runId: id, status: state.status, durationMs: summarizeRun(state, now()).elapsedMs, costUsd: any ? total : null, tokens: tokensTotal(jobs.map(job => job.tokens)), costNotReported: costNotReported(jobs), warnings: runWarnings(state), jobs };
}

export async function runChecksForRun(root, id, { additionalChecks = [], spawnImpl = spawn, env = process.env, gitImpl = git } = {}) {
  root = await fs.realpath(root);
  const state = await readState(root, id);
  if (state.root !== root || state.id !== id) fail('Run belongs to another repository');
  const manifest = validateManifest(JSON.parse(await bytesAt(root, `.swarm/runs/${id}/manifest.json`, true)));
  const checks = [...(manifest.checks ?? []), ...additionalChecks];
  validateManifest({ ...manifest, checks: additionalChecks });
  if (additionalChecks.some(check => (manifest.checks ?? []).some(existing => existing.name === check.name))) fail('additional check name collides with manifest');
  const { base: portBase } = await resolvePortBlock(root);
  const result = await runChecks(root, checks, state.integratedFiles ?? [], state.integratedNewFiles ?? [], spawnImpl, { baseCommit: state.baseCommit, preChecks: manifest.preChecks ?? [], portBase, extraEnv: (await loadSwarmEnv(root)).env, env, gitImpl });
  Object.assign(state, result);
  await jsonWrite(root, `.swarm/runs/${id}/state.json`, state);
  return result;
}

// Field lesson 18: a mutant whose `find` string only exists in code a build job
// generates cannot be declared in the manifest before that job runs. Post-build sources close
// that gap: `--mutants-file` (any JSON file) and a job's own declared `mutantsFile` output
// (collected automatically), on top of any manifest-declared `mutants` — all validated together
// under the same cap and shape as manifest.mutants.
async function collectMutants(root, manifest, mutantsFile, warnings) {
  const mutants = [...(manifest.mutants ?? [])];
  for (const job of manifest.jobs) if (job.mutantsFile) mutants.push(...await loadJobMutantsFile(root, job.mutantsFile));
  if (mutantsFile) mutants.push(...await loadMutantsFile(path.resolve(root, mutantsFile)));
  return validateMutantsArray(mutants, warnings);
}

async function startIntegrationJournal(root, runId, kind, jobs, changes, release) {
  const target = await safePath(root, '.swarm/integration-journal.json', { internal: true });
  const entries = [];
  for (const { file } of changes) {
    const previous = await bytesAt(root, file);
    const mode = previous === null ? 0o644 : (await fs.stat(await safePath(root, file))).mode & 0o777;
    entries.push({ file, previous: previous === null ? null : previous.toString('base64'), mode });
  }
  const journal = { version: 1, runId, pid: process.pid, startedAt: new Date().toISOString(), kind, jobs, entries };
  const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let stopping = false;
  let pending = Promise.resolve();
  const stopped = () => new Promise(() => {}); // The signal handler will exit after restoration.
  const interrupt = signal => {
    if (stopping) return;
    stopping = true;
    const code = signal === 'SIGINT' ? 130 : 143;
    void (async () => {
      try {
        try { await pending.catch(() => {}); await recoverIntegrationJournal(root); }
        finally { await release(); }
      }
      finally { process.exit(code); }
    })();
  };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const detach = () => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); };
  try {
    pending = (async () => {
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, target);
    })();
    await pending;
  } catch (error) { detach(); await fs.rm(temporary, { force: true }); throw error; }
  return {
    async perform(action) {
      if (stopping) return stopped();
      pending = action();
      return await pending;
    },
    async finish() {
      if (stopping) return stopped();
      try { pending = fs.unlink(target); await pending; } finally { detach(); }
    },
    async rollback() {
      if (stopping) return stopped();
      try { pending = recoverIntegrationJournal(root); await pending; } finally { detach(); }
    },
  };
}

async function redcheckCommitRun(root, id, argv, { spawnImpl, timeoutMs, commit }) {
  const result = { status: 'error', exitCode: null, restored: [], tail: '', base: `commit:${commit}` };
  let temporary, worktree, added = false;
  try {
    if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string' || item.includes('\0')) || !argv[0]) fail('redcheck requires --test <argv...>');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail('Invalid redcheck timeout');
    if (typeof commit !== 'string' || !commit || commit.startsWith('-')) fail('Invalid commit');
    root = await fs.realpath(root);
    await readState(root, id); // confirms the run belongs to this repository
    const sha = (await git(root, ['rev-parse', '--verify', `${commit}^{commit}`])).trim();
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-redcheck-commit-'));
    worktree = path.join(temporary, 'wt');
    await git(root, ['worktree', 'add', '--detach', worktree, 'HEAD']);
    added = true;
    try {
      await git(worktree, ['-c', 'user.name=swarm-redcheck', '-c', 'user.email=swarm-redcheck@localhost', 'revert', '--no-commit', '--no-edit', sha]);
    } catch (error) {
      fail(`commit revert failed: ${error.message}`);
    }
    const check = await runCheck('redcheck', argv, worktree, timeoutMs, spawnImpl, true, () => {}, { ...process.env, ...(await loadSwarmEnv(worktree)).env });
    result.status = check.status === 'passed' ? 'green' : check.status === 'failed' && Number.isInteger(check.exitCode) ? 'red' : 'error';
    result.exitCode = check.exitCode;
    result.tail = check.tail.slice(-2000);
    if (check.hint) result.hint = check.hint;
    // Row #214: coarse proof only — every failure line is a missing-export SyntaxError (a later
    // commit's own code importing something this one added), never a real assertion failure.
    if (result.status !== 'green' && MISSING_EXPORT_RE.test(result.tail) && !/AssertionError/.test(result.tail)) result.importOnly = true;
  } catch (error) {
    result.status = 'error';
    result.tail = `${result.tail}\n${error.message}`.trim().slice(-2000);
  } finally {
    if (added) { try { await git(root, ['worktree', 'remove', '--force', worktree]); } catch { /* best-effort cleanup */ } }
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}

// Automatic jobs no lane can take right now (every lane paused or unconfigured, tier expensive with no claude model): reported one by one, so the caller can leave them out and
// keep the rest of the wave instead of aborting it.
export async function unroutableJobs(root, manifest, { env = process.env, home = os.homedir() } = {}) {
  const resolved = resolveLanes({ config: loadLocalConfig({ env, home }), manifest, env });
  const oversize = await editInPlaceOnlyJobs(root, manifest, { env, home });
  const bad = [];
  for (const job of manifest.jobs ?? []) {
    if (job.agent !== 'auto') continue;
    try { pickJobRoute(job, resolved, { contract: manifest.contract, ready: readyAutoJobs(manifest), editInPlaceOnly: oversize.has(job.id) }); }
    catch (error) { if (error.code !== 'route-exhausted') throw error; bad.push({ id: job.id, reason: error.message }); }
  }
  return bad;
}

export async function validateProject(root, manifest, { exec = execFileAsync, liveDir, isAlive, env = process.env, home = os.homedir(), scopesExpanded = false, scopeWarnings } = {}) {
  root=await fs.realpath(root);validateManifest(manifest);
  const appliedTypes = await applyManifestJobTypes(root, manifest, { env, home });
  manifest = appliedTypes.manifest;
  // Paths the owner declared protected at init are never written by any job. Checked on the final manifest (after job types),
  // and child manifests of leads come through here too. A profile that cannot be read fails closed.
  await enforceProtectedPaths(root, manifest.jobs, { resources: manifest.resources ?? [] });
  const resolvedLanes = resolveLanes({ config: loadLocalConfig({ env, home }), manifest, env });
  const oversize = await editInPlaceOnlyJobs(root, manifest, { env, home });
  const routes = manifest.jobs.filter(job => job.agent === 'auto').map(job => ({ jobId: job.id, ...pickJobRoute(job, resolvedLanes, { contract: manifest.contract, ready: readyAutoJobs(manifest), editInPlaceOnly: oversize.has(job.id) }) }));
  if (routes.length) {
    const byId = new Map(routes.map(route => [route.jobId, route]));
    manifest = { ...manifest, jobs: manifest.jobs.map(job => byId.has(job.id) ? withoutApiOnlyFields({ ...job, agent: byId.get(job.id).agent, model: byId.get(job.id).model }) : job) };
    validateManifest(manifest);
  }
  const machineConfig = loadLocalConfig({ env, home });
  if (manifest.jobs.some(job => job.shell === true)) {
    const shellPauseProblem = claudeShellPausedProblem(machineConfig);
    if (shellPauseProblem) fail(shellPauseProblem, CLAUDE_SHELL_PAUSED);
  }
  if (manifest.jobs.some(job => job.agent === 'anthropic')) {
    const problem = anthropicLanePausedProblem(machineConfig);
    if (problem) fail(problem, ANTHROPIC_LANE_PAUSED);
  }
  if (manifest.jobs.some(job => job.agent === 'openrouter')) {
    const problem = openrouterLanePausedProblem(machineConfig);
    if (problem) fail(problem, OPENROUTER_LANE_PAUSED);
  }
  scopeWarnings ??= manifest.jobs.map(narrowOutputScopeWarning).filter(Boolean);
  if (!scopesExpanded) manifest = await expandOpenScopes(root, manifest);
  // Lesson 325: existing outputs must fit a single-request API worker before dispatch.
  const capConfig = loadLocalConfig({ env, home });
  for (const job of manifest.jobs) {
    if (!API_AGENTS.includes(job.agent) || job.shell === true) continue;
    const configuredCap = capConfig.outputCap === undefined ? OUTPUT_CAP_BYTES : validateOutputCap(capConfig.outputCap, 'outputCap');
    const cap = job.outputCapBytes ?? configuredCap;
    const sizes = [];
    for (const file of job.outputs) {
      const target = await safePath(root, file);
      let info;
      try { info = await fs.stat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (info.isFile()) sizes.push({ file, bytes: info.size });
    }
    const total = sizes.reduce((sum, entry) => sum + entry.bytes, 0);
    const offending = sizes.filter(entry => entry.bytes > cap.perFile || (total > cap.total && entry.bytes > 0));
    if (offending.length) throw Object.assign(new Error(`output-cap-exceeded: Job ${job.id}: total ${total} bytes (cap ${cap.total}); perFile cap ${cap.perFile}; ${offending.map(entry => `${entry.file}: ${entry.bytes} bytes`).join(', ')}; route this job to agent codex (edits in place) or split the outputs`), { code: 'output-cap-exceeded' });
  }
  await privateNamesDispatchGuard(root, manifest, { exec, env, home });
  const liveWarning = await liveServiceCheckoutWarning(root, { env, home });
  const jobs=[], warnings=[...(liveWarning ? [liveWarning.message] : []), ...tmpToolPathWarnings(manifest), ...await sharedOutputAcrossOpenJobsWarnings(root, manifest, { liveDir, isAlive }), ...shellSandboxDeniedCheckWarnings(manifest, { env, home }), ...sharedRootFullSuiteWarnings(manifest), ...await cheapTierNotConfiguredModelWarnings(manifest, { env, home }), ...await checkPathMissingWarnings(manifest, { env })];
  const projectFiles = listProjectFiles(root);
  warnings.push(...appliedTypes.warnings);
  warnings.push(...scopeWarnings);
  const trackedFiles = new Set(projectFiles);
  const outputOwners = new Map(manifest.jobs.flatMap(job => (job.outputs ?? []).map(file => [file, job.id])));
  const uncovered = [];
  // Field lesson 126s: a skills source dir (manifest `skillsDir`, else local config `skills.dir`)
  // is read once here — absent, `skills` stays `[]` and every check below is a no-op.
  const skillsSourceDir = appliedTypes.skillsSourceDir ?? resolveSkillsDir(manifest, loadLocalConfig({ env, home }), root);
  if (skillsSourceDir) await assertNoSkillSymlinks(skillsSourceDir);
  const skills = appliedTypes.skills ?? (skillsSourceDir ? await listSkills(skillsSourceDir) : []);
  warnings.push(...skillSizeWarnings(skills));
  refuseOversizeSkills(skills);
  // Field lesson #229: a shared contract's own Event names table is read once, here, so a reader
  // with no producer anywhere in this batch is visible at validate time, not only once mutation
  // testing shows most of the reader's own lines could never be measured live.
  if (manifest.contract) {
    const contractText = (await bytesAt(root, manifest.contract))?.toString('utf8') ?? '';
    warnings.push(...eventReaderNoProducerWarnings(contractText));
    // Field lesson #240: a contract job gets a file map; a path its own 'Files:' line names but
    // that is missing from the repository root is worth a warning before that job ever runs.
    for (const filePath of contractFilesLinePaths(contractText)) {
      if ((await bytesAt(root, filePath)) === null) warnings.push({ code: 'contract-file-not-found', path: filePath, message: `contract-file-not-found: ${manifest.contract} names ${filePath}, which is missing from the repository root` });
    }
  }
  // Field lesson #281: each declared resource is checked to exist (and is refused outright if it
  // names a directory — file-only, per the orchestrator's own answer) once, not per job; the same
  // bytes are copied into every job's own workspace/worktree at run time.
  for (const file of manifest.resources ?? []) {
    const target = await safePath(root, file);
    let info = null;
    try { info = await fs.lstat(target); } catch { /* missing: caught by bytesAt below */ }
    if (info?.isDirectory()) fail(`resource-is-directory: ${file}`);
    if ((await bytesAt(root, file)) === null) fail(`resource-missing: ${file}`);
  }
  // Field lesson #282: a project's own private-data path globs, read once per validate/run.
  const localConfig = loadLocalConfig({ env, home });
  // Field lesson #287: the project root's own git info (a plain checkout, or a linked worktree's
  // gitdir/commondir), resolved once so a shell job's commit-intent warning can name it.
  const rootGitInfo = await resolveRootGitInfo(root);
  // Field lesson #288: the repo's own root AGENTS.md, read once so a codex job's missing required
  // read can be named without re-reading it per job.
  const agentsMdText = (await bytesAt(root, 'AGENTS.md'))?.toString('utf8') ?? null;
  const handlers = await commandHandlers();
  for(const job of manifest.jobs){
    warnings.push(...commandHandlerWarnings(job, handlers));
    if (API_AGENTS.includes(job.agent) && job.shell !== true && job.maxOutputTokens !== undefined) {
      const modelDefault = job.agent === 'openrouter' ? defaultMaxOutputTokens(job.model) : 8192;
      if (job.maxOutputTokens < modelDefault) warnings.push({ code: 'max-output-below-model-default', jobId: job.id, maxOutputTokens: job.maxOutputTokens, modelDefault, message: 'max-output-below-model-default: Job ' + job.id + ': maxOutputTokens ' + job.maxOutputTokens + ' is below model default ' + modelDefault });
    }
    // Field lesson #231: computed and refused here, before this job (or any job after it) ever
    // runs — a job cap is enforced by code, never by prompt text asking a worker to stop itself.
    if (job.maxCredits !== undefined) {
      const preflightBytes = job.creditPreflight ? await bytesAt(root, job.creditPreflight) : null;
      if (preflightBytes === null) fail(`credit-preflight-missing: Job ${job.id}: creditPreflight ${job.creditPreflight ?? '(not set)'} could not be read`);
      let preflightEntries;
      try { preflightEntries = JSON.parse(preflightBytes.toString('utf8')); } catch { fail(`credit-preflight-missing: Job ${job.id}: creditPreflight ${job.creditPreflight} is not valid JSON`); }
      if (!Array.isArray(preflightEntries)) fail(`credit-preflight-missing: Job ${job.id}: creditPreflight ${job.creditPreflight} must be a JSON array of {call, cost}`);
      const sum = sumCreditPreflight(preflightEntries);
      if (sum > job.maxCredits) fail(`credit-cap-exceeded: Job ${job.id}: preflight totals ${sum} credits over cap ${job.maxCredits} (${preflightEntries.length} calls)`);
    }
    if (isWorktreeWriter(job)) {
      await resolveReadPaths(job.readPaths);
      const files = await codexDirtyFiles(root, job);
      if (files.length) warnings.push({ code: 'codex-uncommitted-files', jobId: job.id, files, message: `${job.agent === 'cursor' ? 'Cursor' : 'Codex'} starts from HEAD; uncommitted changes to these declared files are not included.` });
    }
    // Field lesson #288: a codex job whose own repo AGENTS.md names a tracked doc not in its
    // declared context is worth a warning before it ever runs.
    warnings.push(...codexRequiredReadMissingWarnings(agentsMdText, trackedFiles, job));
    // Field lesson #287: informational only — the grant this job's sandbox already gets (see
    // claude-shell.mjs) is named here so a human sees why, never a refusal.
    const commitWarning = linkedWorktreeCommitWarning(rootGitInfo, job);
    if (commitWarning) warnings.push(commitWarning.message);
    // Field lesson 107: only codex has shell access; a job assigned to edit this runner's own
    // core module on any other agent can never itself run the tests that pin its behavior.
    const coreWarning = coreModuleNoShellWarning(job);
    if (coreWarning) warnings.push(coreWarning);
    // Field lesson 113/153: same reasoning — a prompt quoting a runtime-check failure, a check
    // whose own argv loops, or a prompt naming a flake/race needs a shell agent to reproduce it.
    const runtimeWarning = runtimeCheckNoShellWarning(job, manifest);
    if (runtimeWarning) warnings.push(runtimeWarning);
    // Field lesson 119: a job's own mutants-shaped output only gets its shape checked once
    // integrate reads it; warn as soon as the manifest is validated, not after the build runs.
    warnings.push(...undeclaredMutantsFileWarnings(job));
    const testsWarning = testsWithoutShellWarning(job);
    if (testsWarning) warnings.push(testsWarning);
    // Field lesson #255: a shell job running Python checks with no setup step may fall back to
    // searching the disk for a toolchain instead of using its own synced workspace.
    const pythonSetupWarning = shellPythonNoSetupWarning(job, manifest);
    if (pythonSetupWarning) warnings.push(pythonSetupWarning);
    // Field lesson 127/148: a job that outputs a dependency/version file with no preChecks
    // declared to resync the environment leaves the next checks run pointed at a stale install.
    const staleEnvWarning = staleEnvRiskWarning(manifest, job);
    if (staleEnvWarning) warnings.push(staleEnvWarning);
    // Field lesson #159: packaging config that no check ever builds can pass every test and still
    // ship a package that does not build.
    const packagingWarning = packagingWithoutBuildCheckWarning(manifest, job);
    if (packagingWarning) warnings.push(packagingWarning);
    // Field lesson #266: a model/provider route change needs a real streaming smoke test before
    // it lands; warn when a job changes a file that looks like one and no declared check looks
    // like the real-client smoke test this needs.
    const modelRouteWarning = modelRouteChangeNoSmokeTestWarning(manifest, job);
    if (modelRouteWarning) warnings.push(modelRouteWarning);
    // contextGlob is expanded here (validate/run time), never at manifest-write time, so a job
    // can pick up files a build step later adds to a shared directory without editing the manifest.
    // Field lesson 115: also echoes, per pattern, how many files it matched.
    const { extra: contextGlobExtra, counts: contextGlobCounts } = await expandContextGlobs(root, job);
    const context = [...new Set([...job.context, ...contextGlobExtra])];
    warnings.push(...workFolderContextWarnings(job, context));
    // Field lesson #282: refused before this job (or any after it) ever dispatches — the same
    // spot maxCredits/resources are enforced, before any worker spends anything.
    const privateDataWarning = privateDataRequiredWarning(job, context, localConfig);
    if (privateDataWarning) fail(privateDataWarning.message);
    // Throws unknown-skill before anything else runs; paths auto-attach sees the fully expanded
    // context (contextGlob matches included), the same list a job's own prompt block reflects.
    // Field lesson #224: a broken skill (invalid frontmatter field, still parseable YAML) this job
    // actually attaches (named, or path-matched) refuses by name; one no job here attaches is left
    // to the skill-invalid-unused warning below instead.
    const attachedSkills = attachJobSkills(skills, { ...job, context });
    for (const skill of attachedSkills) {
      if (skill.broken && skill.attached !== 'index-only') fail(`invalid-skill-frontmatter: ${skill.file}: ${skill.error} (attached by job ${job.id})`);
    }
    // Field lesson #281: a prompt naming a repo-relative path that exists on disk but is covered
    // by neither tracked files, this job's own context, nor manifest.resources is refused before
    // dispatch — the 281 incident spent real shell-job dollars discovering this after the fact.
    const promptPathHits = await promptPathsNotInWorkspaceWarnings(root, job, context, { trackedFiles, resources: manifest.resources ?? [] });
    if (promptPathHits.length) fail(promptPathHits[0]);
    // Field lesson #283: an attached skill's own resultKeys is checked against the job's own
    // prompt-declared JSON shape before dispatch, not only once integrate reads the real result.
    dispatchResultKeysRefusal(attachedSkills, job, { skillsSourceDir });
    let bytes=0, apiContextBytes=0;
    const files=[];
    const testOutputTexts = new Map();
    const jobFileTexts = new Map();
    for(const file of new Set([...context,...job.outputs])){
      const data=await bytesAt(root,file);
      if(data===null && context.includes(file)) {
        const siblingOwner = outputOwners.get(file);
        // Row #217: a tool-free worker has no filesystem of its own — a context file it cannot
        // read is never deliverable, named the same way as the over-cap case below.
        if (siblingOwner && siblingOwner !== job.id) warnings.push({ code: 'pending-sibling-output', jobId: job.id, path: file, createdBy: siblingOwner, message: `${job.id}: context ${file} is pending (created by job ${siblingOwner})` });
        else if (API_AGENTS.includes(job.agent)) fail(`context-not-deliverable: missing context ${file}`);
        else fail(`Missing context: ${file}`);
      }
      // Field lesson #221: an empty context file (0 bytes, or whitespace only) is never real input;
      // ask/validate/run all refuse it here (validateProject runs at the top of runManifest, which
      // askRun and the generic `run` both go through), unless the manifest names it deliberately.
      if (data !== null && context.includes(file) && data.toString('utf8').trim() === '' && !(manifest.allowEmptyContext ?? []).includes(file)) fail(`empty-context-file: ${file}`);
      // The shared contract's text now travels inside the prompt, so codex never needs it from HEAD.
      if (isWorktreeWriter(job) && context.includes(file) && data !== null && file !== manifest.contract && !(await isTrackedByGit(root, file, exec))) fail(`Job ${job.id}: ${job.agent} context file ${file} is not tracked by git (${job.agent} sees HEAD only)`);
      // Field lesson #232: the actual incident was a typo'd *test file* path that never existed in
      // base (`tests/skills.test.mjs`); scoped to test-shaped outputs so this stays a signal, not
      // noise on every ordinary new-file output (never a refusal either way).
      if (data === null && job.outputs.includes(file) && isTestFile(file)) warnings.push({ code: 'output-not-in-base', jobId: job.id, path: file, message: `${job.id}: declared output ${file} is absent from base; check for a typo` });
      bytes+=data?.length??0;
      if (API_AGENTS.includes(job.agent) && context.includes(file)) apiContextBytes += data?.length ?? 0;
      files.push({path:file,bytes:data===null?0:data.length,exists:data!==null,context:context.includes(file),output:job.outputs.includes(file)});
      if(data !== null && !['claude', 'codex', 'cursor'].includes(job.agent)) decodeContext(data);
      if(bytes>MAX_CONTEXT) fail(`Context exceeds 32 MiB for ${job.id}`);
      if (data !== null && job.outputs.includes(file) && isTestFile(file)) testOutputTexts.set(file, data.toString('utf8'));
      if (data !== null) jobFileTexts.set(file, data.toString('utf8'));
    }
    // Field lesson #235: a job output touching a date-window comparison with no test anywhere in
    // its own context/outputs naming a non-UTC zone is worth a warning before that window is ever
    // exercised only by the clock the test happened to run on.
    const utcWindowWarning = utcOnlyWindowTestWarning(job, jobFileTexts);
    if (utcWindowWarning) warnings.push(utcWindowWarning);
    // Row #217: the total a tool-free worker's context can carry, inlined text (never a patch);
    // over this, at least one file cannot be delivered whole and validate refuses up front.
    if (API_AGENTS.includes(job.agent) && apiContextBytes > CONTEXT_TOTAL_CAP) fail(`context-not-deliverable: context exceeds ${CONTEXT_TOTAL_CAP} bytes for ${job.id} (${apiContextBytes} bytes)`);
    // Row #185: a declared output already this large on disk, asked of a tool-free worker whole,
    // risks the same output-length truncation that cost row #185's own incident; the `edits` form
    // (find/replace) is the way out, but validate cannot know a worker will choose it, so this is
    // always a warning, never a refusal.
    if (API_AGENTS.includes(job.agent)) {
      for (const file of job.outputs) {
        const info = files.find(entry => entry.path === file);
        if (info?.exists && info.bytes > LARGE_OUTPUT_WHOLE_BYTES) warnings.push({ code: 'large-output-whole', jobId: job.id, path: file, bytes: info.bytes, message: `${job.id}: declared output ${file} is ${info.bytes} bytes on disk; an API worker asked to return it whole may hit its output-token limit — consider the edits form (find/replace)` });
      }
    }
    for (const file of job.ignoreTests ?? []) {
      if ((await bytesAt(root, file)) === null) fail(`Job ${job.id}: missing ignoreTests entry: ${file}`);
    }
    // Field lesson 149: a test timeout under 5s is a hang guard, not a timing assertion.
    warnings.push(...tightTestTimeoutWarnings(job, testOutputTexts));
    // Catches a review round's context copied from an earlier round, silently omitting files
    // added since to the same directory (e.g. new screenshot captures); also covers a contextGlob
    // that names one capture kind but not another sharing the same directory (lesson 34).
    warnings.push(...contextDirectoryWarnings(root, { id: job.id, context, outputs: job.outputs, contextGlob: job.contextGlob }));
    // Field lesson #196: an untracked file sitting next to a declared context file is invisible to
    // this job's own worktree unless it is also declared.
    warnings.push(...await contextSiblingUntrackedWarnings(root, { id: job.id, context }, trackedFiles));
    // Field lesson 155/#(registry-pinning half): a job adding a file to a directory an existing
    // test enumerates (glob/listdir) also needs that test in its own context/outputs/ignoreTests.
    warnings.push(...registryPinningWarnings(root, { id: job.id, outputs: job.outputs, context, ignoreTests: job.ignoreTests ?? [] }, projectFiles));
    // Catches a worker changing an output's behavior without ever seeing the test that
    // asserts it: advisory static text matching, resolved via context or ignoreTests.
    for (const pair of findUncoveredTests(root, { ...job, context }, projectFiles)) uncovered.push({ job: job.id, ...pair });
    jobs.push({id:job.id,agent:job.agent,model:job.model??null,...(job.report==='short'?{report:'short',prompt:job.prompt}:{}),...(job.type!==undefined?{type:job.type,prompt:job.prompt,timeoutMs:job.timeoutMs,typeRoute:job.typeRoute,...(job.skills!==undefined?{skills:job.skills}:{})}:{}),...(job.shell===true?{shell:true}:{}),tier:job.tier??null,tierReason:job.tierReason??null,contextBytes:bytes,outputs:job.outputs,...(job.ignoreTests!==undefined?{ignoreTests:job.ignoreTests}:{}),...(job.ignoreTestsReason!==undefined?{ignoreTestsReason:job.ignoreTestsReason.trim()}:{}),files,contextGlobCounts});
  }
  // Field lesson #224: reaching here means the per-job loop above never found a broken skill
  // actually attached (that would already have refused); every broken skill left is unused.
  for (const skill of skills) if (skill.broken) warnings.push({ code: 'skill-invalid-unused', file: skill.file, message: `skill-invalid-unused: ${skill.file}: ${skill.error}` });
  warnings.push(...await missingDepsWarnings(root));
  // Field lesson #201: a uv.lock path source only fails once `uv sync --offline` cannot find it.
  warnings.push(...await missingLockPathSourceWarnings(root));
  // Field lesson #160: an invalid env file refuses here; a toolchain check with none only warns.
  {
    // Field lesson #219: an `npm test`/`npm run <script>` check whose script resolves to a plain
    // `node ...` command never needs a toolchain env of its own.
    let packageScripts;
    try { packageScripts = JSON.parse((await bytesAt(root, 'package.json'))?.toString('utf8') ?? '{}').scripts; } catch { packageScripts = undefined; }
    warnings.push(...checkNeedsEnvWarnings(manifest, Boolean((await loadSwarmEnv(root)).source), { resolvesToPlainNode: npmScriptsResolveToPlainNode(packageScripts) }));
  }
  // Field lesson #167: a repo whose CI already runs on Windows and has no .swarm/gotchas.md is
  // about to have its next Windows-specific worker rediscover the same platform quirk by hand.
  warnings.push(...await windowsCiGotchasWarnings(root));
  if (uncovered.length) throw Object.assign(new Error(`Uncovered test references (add the test to context, or list it in ignoreTests with a reason in the prompt): ${uncovered.map(u => `${u.job}: ${u.output} <- ${u.test}`).join('; ')}`), { details: { suggestedIgnoreTests: suggestIgnoreTests(uncovered) } });
  const jobConflicts = new Map();
  // The live-run list is read once for the whole manifest, not once per job.
  const liveRuns = await listLiveRuns({ dir: liveDir, isAlive });
  for (const job of manifest.jobs) {
    const conflicts = await liveOutputConflicts(root, [job], { liveDir, isAlive, runs: liveRuns });
    for (const conflict of conflicts) {
      const key = `${conflict.runId}\u0000${conflict.root}`;
      const existing = jobConflicts.get(key) ?? { ...conflict, jobIds: [] };
      existing.files = [...new Set([...(existing.files ?? []), ...(conflict.files ?? [])])].sort();
      existing.jobIds.push(job.id);
      jobConflicts.set(key, existing);
    }
  }
  const conflicts = [...jobConflicts.values()].map(conflict => ({ ...conflict, jobIds: [...new Set(conflict.jobIds)] }));
  if (conflicts.length) {
    warnings.push(...conflicts.map(conflict => ({ code: 'live-output-conflict', runId: conflict.runId, files: conflict.files, jobIds: conflict.jobIds, message: `live-output-conflict: ${conflict.files.join(', ')} is owned by live run ${conflict.runId}; startable jobs: ${manifest.jobs.filter(job => !conflict.jobIds.includes(job.id)).map(job => job.id).join(', ') || '(none)'}` })));
  }
  try {
    const cursorClaims = await cursorClaimConflicts(root, manifest.jobs);
    warnings.push(...cursorClaims.map(conflict => ({ code: 'cursor-claim-conflict', ...conflict, message: `cursor-claim-conflict: ${conflict.files.join(', ')} is claimed by Cursor lane job ${conflict.claim}; startable jobs: ${manifest.jobs.filter(job => !conflict.jobIds.includes(job.id)).map(job => job.id).join(', ') || '(none)'}` })));
  } catch (error) {
    warnings.push({ code: 'cursor-claims-invalid', message: error.message });
  }
  const blockedJobIds = new Set(warnings.filter(warning => ['live-output-conflict', 'cursor-claim-conflict'].includes(warning.code)).flatMap(warning => warning.jobIds));
  const startableJobs = manifest.jobs.filter(job => !blockedJobIds.has(job.id)).map(job => job.id);
  // The rented lane needs its machine config (or a running GPU session) and takes only jobs marked sensitive: false, each with its full contract.
  const rentedJobs = manifest.jobs.filter(job => job.agent === 'rented');
  if (rentedJobs.length) {
    const { config: rented, errors } = loadRentedConfig(env);
    if (!rented) fail(`rented-not-configured: ${errors[0] ?? 'add a rentedGpu block to the machine config (see docs/rented-gpu.md)'}`, 'rented-not-configured');
    for (const job of rentedJobs) {
      if (!rentedSensitiveOk(rented, job)) fail(`Job ${job.id}: the rented lane only gets jobs that set sensitive: false (a rented server is never trusted with sensitive work)`, 'sensitive-provider');
      const problem = rentedContractProblem({ ...job, contract: job.contract ?? manifest.contract });
      if (problem) fail(`Job ${job.id}: a rented-lane job must ${problem}; failures go to Haiku, then Codex`, 'rented-contract');
      if (job.model !== rented.model) fail(`Job ${job.id}: model must be ${rented.model}, the model the rented server serves`, 'rented-model');
    }
  }
  return {status:'valid',root,jobs,warnings,conflicts,startableJobs,startableSubset:startableJobs,routes};
}

export { appendRunLedger, checkWorkerReport, collectMutants, prepareJobEnvironment, redcheckCommitRun, startIntegrationJournal };
