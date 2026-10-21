import { createBatchController } from '../adaptive-batch.mjs';
import { selectAffectedTests } from '../affected.mjs';
import { API_AGENTS, executeApi } from '../api-adapters.mjs';
import { brainStats } from '../brain-commands.mjs';
import { fixTicketFromFailure, runHook, shouldRun } from '../ci-hooks.mjs';
import { containsKey, createShellScratchDir, redactKey, resolveClaudeBinary, resolveRigServicePort, resolveRootGitInfo, resolveSharedUvCacheDir, resolveVenvInterpreterDirs, scanListeningPorts, shellEnvironment, shellProfile, startConnectProxy } from '../claude-shell.mjs';
import { extraCliMessage } from '../cli-adapters.mjs';
import { git, resolveReadPaths, validateReadPaths } from '../codex-adapter.mjs';
import { installDependencies } from '../dep-install.mjs';
import { isBuildArtifact } from '../ignored-artifacts.mjs';
import { hookFiles, hookScriptNames } from '../init-profile.mjs';
import { appendEvent, readJournal } from '../journal.mjs';
import { redactText } from '../lesson-schema.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { migrationQueueCheck } from '../migration-queue.mjs';
import { portBlockFor, resolvePortBlock } from '../ports.mjs';
import { mapIsFresh, readRepoMap } from '../repo-map.mjs';
import { REPORT_PROMPT_LINE } from '../reports.mjs';
import { addCiFixTicket } from '../scope-commands.mjs';
import { recordGate, runSecurityGate } from '../security-gate.mjs';
import { swarmCheckWarnings } from '../ship.mjs';
import { copySkillsInto, SKILLS_DIR_NAME } from '../skills.mjs';
import { findRealGit, gitGuardScript, loadSwarmEnv } from '../swarm-env.mjs';
import { expandRootArgv } from './checks.mjs';
import { digest, extractSessionId, fail, firstFailureLine, loopbackScanFailedResult, setupFailedResult, toolchainsDir, venvUnresolvableResult } from './core-1.mjs';
import { parseMutantCheckFlag, redundantWriterWarnings, runCheck, securityExec } from './core-11.mjs';
import { failureTail, projectProfile, securityFingerprintKey, ticketForBudgetFailure, withApprovedManifests } from './core-2.mjs';
import { safePath } from './core-21.mjs';
import { bytesAt, jobWorktreePath, jsonWrite, mutantReviewTexts, runChecks, saveDroppedWrite, write } from './core-31.mjs';
import { droppedBytesAt, execute, outputsChanged, readState, recordIntegratedHashes, reportObject, runMutant, smokeCheckInSandbox } from './core-41.mjs';
import { appendRunLedger, checkWorkerReport, collectMutants, prepareJobEnvironment, startIntegrationJournal, todaySpendUsd } from './core-51.mjs';
import { refuseInvalidMutants } from './mutants.mjs';
import { CHECK_ERRORED_STATUSES, ENV_RESYNC_TRIGGER_NAMES } from './patterns.mjs';
import { sandboxCannotRunCheckResult } from './shell-sandbox.mjs';
import { killedByMismatchWarnings } from './warnings.mjs';
import { isWorktreeWriter, prepareWorktreeLocation, scratchInsideRepoResult, worktreeDiskLowResult, worktreeStatusMap } from './workspace.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function reaskWorkerReport(job, result, workspace, options, launch) {
  if (job.report !== 'short' || job.shell === true || result.status !== 'complete' || result.error || result.envelopeInvalid || result.cleanupError || result.terminationReason || result.reportReasked) return result;
  const checked = checkWorkerReport(job, result);
  if (checked.report) return result;
  if (options.signal?.aborted || await options.cancelled?.()) return result;
  const message = `Your files are saved. Reply with only your final report JSON line and nothing else.\nProblems with your last report: ${checked.errors.join('; ')}\nDeclared outputs you may list in files: ${JSON.stringify(job.outputs)}\n${REPORT_PROMPT_LINE}`;
  const sessionId = job.agent === 'claude' ? extractSessionId(result.stdout) : null;
  const writers = isWorktreeWriter(job) || (job.agent === 'claude' && !sessionId);
  const saved = new Map();
  if (writers) for (const file of job.outputs) {
    const bytes = await bytesAt(workspace, file);
    saved.set(file, { bytes, mode: bytes === null ? null : (await fs.stat(await safePath(workspace, file))).mode & 0o777 });
  }
  result.reportReasked = true;
  let reask;
  try {
    if (launch) reask = await launch(message);
    else if (job.agent === 'claude') reask = await execute(job, workspace, message, { ...options, onOutput: () => {}, resumeSessionId: sessionId ?? undefined });
    else {
      const request = { ...job, outputs: [], context: [], prompt: `${job.prompt.slice(0, 4000)}\n\n${message}` };
      reask = API_AGENTS.includes(job.agent)
        ? await executeApi(request, [], options)
        : await execute(request, workspace, extraCliMessage(request, []), { ...options, onOutput: () => {} });
    }
    if (typeof result.usage?.total_tokens === 'number' && typeof reask.usage?.total_tokens === 'number') result.usage = { ...result.usage, total_tokens: result.usage.total_tokens + reask.usage.total_tokens };
    if (reask.status !== 'complete' || reask.error || reask.envelopeInvalid) result.reportReaskErrors = [`re-ask failed: ${reask.error ?? reask.status}`];
    else {
      result.finalObject = reportObject(job, reask);
      result.response = reask.response;
      result.reportReaskErrors = checkWorkerReport(job, reask).errors;
    }
  } catch (error) { result.reportReaskErrors = [`re-ask failed: ${error.message}`]; }
  finally {
    const restored = [];
    for (const [file, { bytes: before, mode }] of saved) {
      const after = await bytesAt(workspace, file);
      if (before === null ? after === null : after !== null && before.equals(after)) continue;
      if (before === null) await fs.rm(await safePath(workspace, file, { readOnly: true }), { force: true });
      else await write(workspace, file, before, false, mode, { template: true });
      restored.push(file);
    }
    if (restored.length) result.reportReaskRestored = restored;
  }
  return result;
}

async function executeClaudeShellJob(root, directory, job, proposalRoot, dependencyFiles, message, options) {
  const hooks = options.shellHooks ?? {};
  const workerKey = options.workerKey;
  const worktree = options.worktreePath ?? await jobWorktreePath(root, directory, job.id);
  const commonDir = await fs.realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  let added = false, keepWorktree = false, result, proxy = null, scratch = null;
  const baseline = { outputs: job.outputs, baseHashes: {}, baseModes: {} };
  try {
    await options.onWorktreePath?.(worktree);
    if (options.worktreePath) await prepareWorktreeLocation(worktree, options);
    await git(root, ['worktree', 'add', '--detach', worktree, options.baseCommit ?? 'HEAD']);
    added = true;
    // Unlike codex, the declared files start from the project's current bytes (uncommitted edits
    // included), as in every other claude job, so integrate's base hashes describe what it saw.
    for (const { file, bytes, mode } of options.snapshotFiles) {
      if (bytes === null) await fs.rm(await safePath(worktree, file, { readOnly: true }), { force: true });
      else await write(worktree, file, bytes, false, mode, { template: true });
    }
    // Copied once the worktree exists; the source dir was already read once per run, not per job.
    if (options.skillsSourceDir) await copySkillsInto(options.skillsSourceDir, path.join(worktree, SKILLS_DIR_NAME));
    for (const file of dependencyFiles) await write(worktree, file.file, file.bytes, false, file.mode);
    for (const file of job.outputs) {
      const bytes = await bytesAt(worktree, file);
      baseline.baseHashes[file] = bytes === null ? null : digest(bytes);
      baseline.baseModes[file] = bytes === null ? 0o644 : (await fs.stat(await safePath(worktree, file))).mode & 0o777;
    }
    const prepared = await prepareJobEnvironment(root, directory, job, worktree, options);
    if (prepared.setupResult && prepared.setupResult.status !== 'passed') { result = setupFailedResult(prepared.setupResult.error); return result; }
    const environmentReadPaths = prepared.environmentReadPaths;
    const shellDir = await safePath(root, `${directory}/${job.id}/shell/placeholder`, { internal: true, parents: true }).then(file => path.dirname(file));
    // Field lesson #145: TMPDIR/HOME live in a per-job scratch dir outside every repo (never under
    // `shellDir`, which sits inside this project's own worktree), so a tool that refuses to write
    // scratch data inside a git repo (pytest included) never trips over the job's own tmp dir.
    try { scratch = await (hooks.createScratchDir ?? createShellScratchDir)({ runId: path.basename(directory), jobId: job.id }); }
    catch { result = scratchInsideRepoResult(); return result; }
    const home = scratch.home, tmp = scratch.tmp, configDir = path.join(home, '.claude');
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    // Field lesson #142/#158: after `setup`, a synced venv's interpreter is granted read access
    // when it lives under the real $HOME — every install dir on the way from `.venv/bin/python`
    // (symlink by symlink, then its realpath) and pyvenv.cfg's `home`, same refusal list as any
    // other readPath (a denied one is only warned). A python link that resolves nowhere refuses.
    const venvInterpreterDenied = [];
    let extraReadPaths = [];
    const realHome = options.env?.HOME ?? os.homedir();
    // Field lesson #197-followup: a project's own denied-home-dir additions, keychain service name
    // and rig port file all arrive via this same config, read once for the whole job.
    const config = loadLocalConfig({ env: options.env, home: realHome });
    const insideHome = dir => dir === realHome || dir.startsWith(`${realHome}${path.sep}`);
    const venv = await (hooks.resolveVenvInterpreterDirs ?? resolveVenvInterpreterDirs)(worktree);
    if (venv.unresolvable.length) { result = venvUnresolvableResult(venv.unresolvable); return result; }
    const grantHomeDir = async (dir, deniedCode) => {
      let real = dir;
      try { real = await fs.realpath(dir); } catch { /* the link path itself is still granted */ }
      if (!insideHome(dir) && !insideHome(real)) return;
      try {
        const literal = validateReadPaths([dir]);
        const resolved = await resolveReadPaths([dir]).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const file of [...literal, ...resolved]) if (!extraReadPaths.includes(file)) extraReadPaths.push(file);
      } catch { venvInterpreterDenied.push(`${deniedCode}: ${dir}`); }
    };
    for (const dir of venv.dirs) await grantHomeDir(dir, 'venv-interpreter-denied');
    // Field lesson #158: the swarm's own toolchains dir (uv, managed Pythons, browsers) sits under
    // $HOME too; a check whose argv0 or interpreter lives there must be able to start at all.
    const toolchains = toolchainsDir({ env: options.env ?? process.env, home: realHome });
    if (await fs.access(toolchains).then(() => true, () => false)) await grantHomeDir(toolchains, 'toolchains-denied');
    const parentEnv = options.env ?? process.env;
    const uvPythonInstallDir = typeof parentEnv.UV_PYTHON_INSTALL_DIR === 'string' && path.isAbsolute(parentEnv.UV_PYTHON_INSTALL_DIR) ? parentEnv.UV_PYTHON_INSTALL_DIR
      : await fs.access(path.join(realHome, '.local/share/uv/python')).then(() => path.join(realHome, '.local/share/uv/python'), () => null);
    if (uvPythonInstallDir) await grantHomeDir(uvPythonInstallDir, 'uv-python-denied');
    const readPaths = [...await resolveReadPaths(job.readPaths, undefined, config), ...extraReadPaths];
    const bin = await (hooks.resolveClaude ?? resolveClaudeBinary)(options.env ?? process.env);
    const binDir = path.dirname(bin);
    const cliPaths = path.basename(binDir) === 'bin' ? [path.dirname(binDir)] : [binDir];
    proxy = await startConnectProxy({ handleHttp: hooks.handleHttp });
    // Field lesson #143: git discovery (a project's own tests running `git rev-parse
    // --show-toplevel` etc.) needs the project root's own `.git` readable, and, when the root is
    // itself a linked worktree, the gitdir it points at and that repo's real common dir.
    const rootGit = await (hooks.resolveRootGitInfo ?? resolveRootGitInfo)(root);
    // Field lesson #143: own loopback sockets only — never one a service on the host already had
    // listening when the job started. An lsof failure refuses the job before any worker starts.
    let loopbackDenied;
    try {
      const scanned = await (hooks.scanListeningPorts ?? scanListeningPorts)();
      // Field lesson #197-followup: no config `rig.portFile` means the rig port feature is off
      // (null), never the built-in default port; a null port is filtered out here, never denied.
      const rigPort = await (hooks.resolveRigServicePort ?? resolveRigServicePort)({ config });
      loopbackDenied = [...new Set([...scanned, ...(rigPort != null ? [rigPort] : [])])].filter(port => port !== proxy.port).sort((a, b) => a - b);
    } catch (error) {
      result = loopbackScanFailedResult(error?.hint ?? null);
      return result;
    }
    const profileText = shellProfile({ worktree, commonDir, shellDir, scratchDir: scratch.scratchDir, readPaths, environmentReadPaths, cliPaths, proxyPort: proxy.port, extraHomes: hooks.extraHomes ?? [], rootGit, loopbackDenied, loopbackAllow: job.loopbackAllow, config });
    const profileRelative = `${directory}/${job.id}/sandbox.sb`;
    await write(root, profileRelative, profileText, true);
    const profile = await safePath(root, profileRelative, { internal: true });
    // Field lesson #163: `git` inside the sandbox is a wrapper that refuses `git stash`.
    const guardDir = path.join(shellDir, 'bin');
    await fs.mkdir(guardDir, { recursive: true });
    await fs.writeFile(path.join(guardDir, 'git'), gitGuardScript(await findRealGit(parentEnv.PATH, { exclude: guardDir })), { mode: 0o755 });
    // Field lesson #278: uvCacheDir points at the real, shared, already-warm uv cache under the
    // real machine home (`realHome` above) — never `home` (the job's own per-run scratch home,
    // `scratch.home`), which is exactly the fresh, empty, per-run directory the bug was — so an
    // offline `uv lock`/`uv sync` inside the sandbox can actually find its registry metadata.
    const env = { ...shellEnvironment({ parentEnv, home, tmp, configDir, proxyPort: proxy.port, apiKey: workerKey, testEnv: job.testEnv, userId: `swarm-worker:${job.id}`, portBase: options.portBase, uvCacheDir: resolveSharedUvCacheDir({ env: parentEnv, home: realHome }), swarmEnv: options.swarmEnv, pathPrefix: guardDir, uvPythonInstallDir }), ...(hooks.baseUrlFromProxy ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}` } : {}) };
    // Field lesson #158: before any worker token is spent, the first manifest check is started
    // once inside this exact profile and env (minus the worker key). One that cannot even start
    // (missing tool, hidden interpreter, sandbox denial) refuses the job; a red or slow one is fine.
    const smoke = await smokeCheckInSandbox(root, directory, job, worktree, profile, env, options.checks ?? [], options.spawnImpl, hooks.smokeTimeoutMs ?? 30000);
    if (smoke) { result = sandboxCannotRunCheckResult(smoke); return result; }
    // Field lesson 157: snapshotted once setup (which may itself add a synced venv, node_modules,
    // or similar build artifacts) and the smoke check have run, so only the worker's turn counts.
    const beforeStatus = await worktreeStatusMap(worktree);
    result = await execute(job, worktree, message, { ...options, logDirectory: path.join(root, directory, job.id), claudeShell: { profile, bin, env } });
    result.loopbackDenied = loopbackDenied;
    result.scratchDir = scratch.scratchDir;
    if (venvInterpreterDenied.length) result.venvInterpreterDenied = venvInterpreterDenied;
    for (const key of ['stdout', 'stderr', 'response']) {
      if (containsKey(result[key], workerKey)) { result.workerKeyExposed = true; result[key] = redactKey(result[key], workerKey); }
    }
    if (result.status === 'complete') {
      // Field lesson 157: a new file that IS a declared output is never a dropped write, whether
      // or not it existed before the job ran — matched against job.outputs the same way integrate
      // matches a proposed file against declared.outputs, before the new-vs-modified split below.
      const afterStatus = await worktreeStatusMap(worktree);
      const dropped = [], droppedNew = [];
      for (const [file, code] of afterStatus) {
        if (job.outputs.includes(file) || beforeStatus.get(file) === code || (code === '??' && isBuildArtifact(file))) continue;
        dropped.push(file);
        if (!beforeStatus.has(file)) droppedNew.push(file);
      }
      if (dropped.length) {
        result.droppedWrites = dropped.sort(); if (droppedNew.length) result.droppedWritesNew = droppedNew.sort();
        const runId = path.basename(directory);
        for (const file of dropped) {
          const afterBytes = await droppedBytesAt(worktree, file);
          const baseBytes = await droppedBytesAt(root, file);
          await saveDroppedWrite(root, runId, file, afterBytes, baseBytes, { useGit: true });
        }
      }
      const outputs = [], leaked = [];
      for (const file of job.outputs) {
        const bytes = await bytesAt(worktree, file);
        if (bytes === null) continue;
        if (containsKey(bytes, workerKey)) { leaked.push(file); continue; }
        outputs.push({ file, bytes, mode: (await fs.stat(await safePath(worktree, file))).mode & 0o777 });
      }
      if (leaked.length) { result.workerKeyExposed = true; result = { ...result, status: 'failed', error: `output contains the worker API key: ${leaked.join(', ')}` }; }
      else {
        // A missing output is resolved like any claude job's: blocked envelope, then integrate.
        for (const output of outputs) await write(proposalRoot, output.file, output.bytes, false, output.mode);
      }
    }
    return result;
  } catch (error) {
    if (error.code === 'workspace-env-invalid') { result = { ...setupFailedResult(error.message), code: error.code, path: error.path }; return result; }
    if (error.code === 'worktree-disk-low') { result = worktreeDiskLowResult(error.message); return result; }
    if (added && await outputsChanged(worktree, baseline, { existingOnly: true })) {
      keepWorktree = true;
      if (result) return { ...result, status: 'failed', error: error.message, keptWorkspace: worktree };
      error.keptWorkspace = worktree;
    }
    throw error;
  } finally {
    if (proxy) { await proxy.close(); if (result) result.proxyRefused = [...proxy.refused]; }
    if (added && result && result.status !== 'complete' && !result.workerKeyExposed && await outputsChanged(worktree, baseline)) {
      keepWorktree = true;
      result.keptWorkspace = worktree;
    }
    if (added && !keepWorktree) await git(root, ['worktree', 'remove', '--force', worktree]);
    // Field lesson #145: removed after the job ends, success, failure or cancel alike, unless the
    // manifest job itself asked to keep it.
    if (scratch && job.keepScratch !== true) await fs.rm(scratch.scratchDir, { recursive: true, force: true });
  }
}

export async function writeRunLedger(root, id) {
  const state = await readState(root, id);
  const manifest = JSON.parse(await bytesAt(root, `.swarm/runs/${id}/manifest.json`, true));
  const written = await appendRunLedger(root, state, manifest);
  const brain = await brainStats(root).catch(() => null);
  return brain?.calls ? { ...written, localBrain: brain } : written;
}

// A config with neither `spend.warnUsd` nor `spend.dailyCapUsd` set (a pre-#277 config on disk,
// or one that never opted in) never even sums the day's spend — this never spends time computing
// a total nobody configured a threshold for.
export async function spendGuard(root, { env = process.env, home = os.homedir(), now } = {}) {
  const config = loadLocalConfig({ env, home });
  const warnUsd = config?.spend?.warnUsd, capUsd = config?.spend?.dailyCapUsd;
  if (warnUsd === undefined && capUsd === undefined) return { spendUsd: null, status: 'ok' };
  const spendUsd = await todaySpendUsd(root, { now });
  if (capUsd !== undefined && spendUsd >= capUsd) return { spendUsd, status: 'cap', message: `spend-cap: today's spend $${spendUsd} >= cap $${capUsd}; pass --over-cap --reason TEXT to proceed anyway` };
  if (warnUsd !== undefined && spendUsd >= warnUsd) return { spendUsd, status: 'warn', message: `spend-warn: today's spend $${spendUsd} >= warn $${warnUsd}` };
  return { spendUsd, status: 'ok' };
}

async function runMutants(root, manifest, spawnImpl, { mutantsFile, mutantCheck: mutantCheckFlag, preValidated, portBase, extraEnv = {} } = {}) {
  // Field lesson 120/122: integrateRun already parsed and validated every mutants source before
  // writing anything, and passes that exact list here; a caller with no run to integrate (none,
  // today) would still fall back to reading it fresh.
  const mutants = preValidated ?? await collectMutants(root, manifest, mutantsFile);
  if (!mutants.length) fail('No mutants declared in this manifest; add manifest.mutants, a job mutantsFile output, or --mutants-file to use --mutants');
  const checkSpec = manifest.mutantCheck ?? (mutantCheckFlag ? parseMutantCheckFlag(mutantCheckFlag) : null);
  if (!checkSpec && !mutants.every(mutant => mutant.check)) fail('No mutantCheck declared in this manifest; add manifest.mutantCheck, or pass --mutant-check "<argv json>", to use --mutants');
  const env = { ...process.env, ...extraEnv, ...(portBase != null ? { SWARM_PORT_BASE: String(portBase) } : {}) };
  // Field lesson #162/#233: every distinct check in use (a mutant's own, or the shared one) runs
  // once on the unmutated tree before any mutant is touched. A real incident had all 12 mutants
  // `error` exit 127 (the checked-out env had no `node` on PATH) while `integrated: true` still
  // read as a clean pass; a broken check now refuses `mutant-check-broken` outright, naming the
  // exit code and tail, instead of quietly turning every mutant that used it into an `error`.
  const distinctChecks = new Map();
  for (const mutant of mutants) {
    const argv = mutant.check ?? checkSpec.argv;
    const key = JSON.stringify(argv);
    if (!distinctChecks.has(key)) distinctChecks.set(key, argv);
  }
  for (const argv of distinctChecks.values()) {
    const baseline = await runCheck('mutant-check-baseline', expandRootArgv(argv, root), root, checkSpec?.timeoutMs ?? 300000, spawnImpl, false, () => {}, env);
    if (baseline.status !== 'passed') fail(`mutant-check-broken: ${JSON.stringify(argv)} does not pass on the unmutated tree (${baseline.status}${Number.isInteger(baseline.exitCode) ? `, exit ${baseline.exitCode}` : ''}): ${baseline.tail.split('\n').slice(-3).join(' ').trim()}`);
  }
  const results = [];
  for (const mutant of mutants) results.push(await runMutant(root, mutant, checkSpec, spawnImpl, env));
  const summary = { killed: 0, survived: 0, errors: 0 };
  for (const result of results) summary[result.status === 'killed' ? 'killed' : result.status === 'survived' ? 'survived' : 'errors']++;
  // Field lesson #233: a bare errors count is easy to misread as "not scored"; this line spells
  // out that an errored mutant is never a kill, right next to the counts themselves.
  const mutantsSummaryLine = `${summary.killed} killed, ${summary.survived} survived${summary.errors > 0 ? `, ${summary.errors} errored — not a kill` : ''}`;
  return { mutants: results, mutantsSummary: summary, mutantsSummaryLine, mutantsPassed: summary.survived === 0 && summary.errors === 0 };
}

// Field lesson 117: `mutants` works directly on the current tree — no run id, no manifest, no
// integration — for a coordinator that already has a build's mutants and check in hand and wants
// a fast kill/survive read before wiring either into a manifest. `isInterrupted` is polled between
// mutants (never mid-mutant) so a SIGINT still lets the in-flight mutant's own restore complete.
export async function runMutantsCurrentTree(root, { mutantsFile, mutantCheck, dryRun = false, extraEnv } = {}, spawnImpl = spawn, isInterrupted = () => false) {
  // Field lesson #171: `id` in a worker-written mutants file is accepted as an alias for `name`
  // (renamed by collectMutants/validateMutantsArray); each aliasing is surfaced here as a warning
  // instead of only ever being fixed by hand.
  const warnings = [];
  const mutants = await collectMutants(root, { mutants: [], jobs: [] }, mutantsFile, warnings);
  if (!mutants.length) fail('No mutants declared; pass --mutants-file with at least one mutant');
  // Field lesson #162: a shared --mutant-check is only required for a mutant with no own check.
  if (!mutantCheck && !mutants.every(mutant => mutant.check)) fail('mutants requires --mutant-check "<argv json>" (or a "check" argv on every mutant)');
  const checkSpec = mutantCheck ? parseMutantCheckFlag(mutantCheck) : null;
  // Field lesson #161: every find is counted in its target before the baseline or any mutant.
  await refuseInvalidMutants(mutants, async file => (await bytesAt(root, file))?.toString('utf8') ?? null);
  warnings.push(...redundantWriterWarnings(mutants, await mutantReviewTexts(root)));
  if (dryRun) return { ...(warnings.length ? { warnings } : {}), status: 'dry-run', mutants: mutants.map(mutant => ({ name: mutant.name, file: mutant.file, status: 'valid', check: mutant.check ? 'mutant' : 'default', checkArgv: mutant.check ?? checkSpec.argv })), mutantsValid: true };
  const env = { ...process.env, ...(extraEnv ?? (await loadSwarmEnv(root)).env) };
  // Field lesson 136: a mutation "kill" only means something once the check is known to pass on
  // the unmutated tree; a check whose own argv or harness is already broken (a missing test file,
  // a bad path) would otherwise fail identically for every mutant and read as a perfect score.
  // Field lesson #162: that holds for every distinct check in use, the shared one and each own one.
  const distinct = new Map();
  for (const mutant of mutants) { const argv = mutant.check ?? checkSpec.argv; distinct.set(JSON.stringify(argv), argv); }
  for (const argv of distinct.values()) {
    const baseline = await runCheck('mutants-baseline', expandRootArgv(argv, root), root, checkSpec?.timeoutMs ?? 300000, spawnImpl, false, () => {}, env);
    // Field lesson #233: names both the exit code and the check's own tail, so a broken toolchain
    // (exit 127, say) is never mistaken for the mutant target itself being broken.
    if (baseline.status !== 'passed') fail(`Refusing to run mutants: mutant-check-broken: the mutant check ${JSON.stringify(argv)} does not pass on the unmutated tree (${baseline.status}${Number.isInteger(baseline.exitCode) ? `, exit ${baseline.exitCode}` : ''}): ${baseline.tail.split('\n').slice(-3).join(' ').trim()}`);
  }
  const results = [];
  for (const mutant of mutants) {
    if (isInterrupted()) break;
    // Field lesson #274: `runMutant` now reports killed/survived/invalid-find/invalid-build/error
    // directly (an invalid-find mutant and a build failure used to collapse into one 'invalid').
    const raw = await runMutant(root, mutant, checkSpec, spawnImpl, env);
    results.push({ ...raw, firstFailingLine: raw.status === 'killed' ? firstFailureLine(raw.tail) : null, ...(mutant.killedBy !== undefined ? { killedBy: mutant.killedBy } : {}) });
  }
  const summary = { killed: 0, survived: 0, 'invalid-find': 0, 'invalid-build': 0, error: 0 };
  for (const result of results) summary[result.status] = (summary[result.status] ?? 0) + 1;
  // Field lesson #199: a worker's claimed killedBy is only ever documentation; compared here
  // against what actually failed (the mutant's own tail) so a wrong claim is at least visible.
  warnings.push(...killedByMismatchWarnings(results));
  return { ...(warnings.length ? { warnings } : {}), mutants: results, mutantsSummary: summary, mutantsPassed: summary.survived === 0 && summary['invalid-find'] === 0 && summary['invalid-build'] === 0 && summary.error === 0 };
}

async function applyQueuePlans(root, id, state, manifest, plans, { batchSize, adaptive = false, conflicts, skipped, noChecks, noFlakeCheck, spawnImpl, warnings, releaseIntegrationLock, securityGate = {} }) {
  const queue = state.mergeQueue = { state: 'running', batchSize, ...(adaptive ? { adaptive: { sizes: [], steps: { up: 0, down: 0 } } } : {}), batches: [], integrated: [], conflicts, checkFailed: [], skipped, securityBlocked: [], securityTickets: [], securityNotes: [] };
  const securityProfile = await projectProfile(root);
  const securityPolicy = withApprovedManifests(securityGate.policy ?? securityProfile?.security, securityGate.approveManifests);
  const securitySensitive = securityProfile?.sensitive !== false;
  const securityCache = new Map();
  const securityKey = await securityFingerprintKey(root);
  state.integratedFiles = [];
  state.integratedNewFiles = [];
  const persist = () => jsonWrite(root, `.swarm/runs/${id}/state.json`, state);
  await persist();
  const originalPortBase = portBlockFor(root);
  const { base: portBase, moved } = await resolvePortBlock(root);
  if (moved) warnings.push(portBase === originalPortBase ? `port-block-busy: ${portBase}` : `port-block-moved: ${originalPortBase} -> ${portBase}`);
  const { env: swarmEnv } = await loadSwarmEnv(root);
  const portEnv = { ...process.env, ...swarmEnv, SWARM_PORT_BASE: String(portBase) };
  state.preChecks = [];
  if (plans.length) {
    for (const [index, argv] of (manifest.preChecks ?? []).entries()) state.preChecks.push(await runCheck(argv.join(' ').slice(0, 60) || `preCheck-${index + 1}`, expandRootArgv(argv, root), root, 300000, spawnImpl, false, () => {}, portEnv));
    const broken = state.preChecks.find(check => CHECK_ERRORED_STATUSES.has(check.status));
    if (broken) { await persist(); fail(`checks-not-runnable: preCheck ${broken.name} ${broken.status}`); }
    if (!manifest.preChecks?.length && plans.some(plan => plan.writes.some(change => ENV_RESYNC_TRIGGER_NAMES.has(path.basename(change.file))))) warnings.push('lockfile changed, env not synced');
  }
  // Phase 15: affected-only tests. Needs the repo map and at least one check with affectedArgv; any doubt runs the normal check.
  // The map is used only when it was built at the current HEAD; otherwise every batch runs the normal checks.
  const wantsAffected = (manifest.checks ?? []).some(check => check.affectedArgv);
  const candidateMap = wantsAffected ? await readRepoMap(root) : null;
  const repoMap = candidateMap && mapIsFresh(candidateMap, await git(root, ['rev-parse', 'HEAD']).then(value => value.trim(), () => null)) ? candidateMap : null;
  if (wantsAffected && !repoMap) warnings.push('affected-map-missing-or-stale: every batch runs the full checks');
  const sinceFull = new Map();
  const touched = new Set();           // files integrated earlier in this pass: the map does not know their new imports
  let affectedSinceFull = false;       // true when the tree has only had affected-only checks since the last full run
  const affectedBatchModes = new WeakMap();
  // Phase 15: owner-configured smoke and preview hooks run after each green batch. A failure never rolls the batch back; it becomes a fix ticket.
  const ciConfig = securityProfile?.ci;
  let ciBatchNumber = 0;
  const runCiHooks = async (batch, changes) => {
    ciBatchNumber += 1;
    queue.ci ??= [];
    for (const kind of ['smoke', 'preview']) {
      const hook = ciConfig?.[kind];
      if (!hook || !shouldRun(hook.everyBatches ?? 1, ciBatchNumber)) continue;
      // A hook runs files from the project; if this batch changed one of them, it is not run on that code.
      const runs = hookFiles(hook.argv);
      if (changes.some(change => runs.includes(change.file))) { warnings.push(`ci-${kind}-skipped: batch ${ciBatchNumber} changed a file the hook runs`); queue.ci.push({ batch: ciBatchNumber, kind, status: 'skipped' }); continue; }
      const res = await runHook(kind, hook, { cwd: root, env: portEnv });
      const record = { batch: ciBatchNumber, kind, status: res.status, exitCode: res.exitCode, durationMs: res.durationMs, ...(res.url ? { url: res.url } : {}) };
      if (res.status !== 'passed') {
        // The local brain condenses the log when it answers within 15 seconds; otherwise the redacted tail is used.
        let summary = null;
        // Only a project that says sensitive: false may send the log to the brain; otherwise the redacted tail is used.
        if (securityProfile?.sensitive === false) try {
          const { createProjectBrain } = await import('../brain-commands.mjs');
          const { digest } = await import('../brain-tasks.mjs');
          const project = createProjectBrain({ root });
          let timer;
          try { summary = (await Promise.race([digest(project.ask, res.tail, { kind: 'tests' }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('brain-timeout')), 15000); })])).lines.join(' '); } finally { clearTimeout(timer); await project.close().catch(() => {}); }
        } catch { /* the tail is used */ }
        try { record.ticket = await addCiFixTicket(root, fixTicketFromFailure({ kind, batchNumber: ciBatchNumber, files: changes.map(change => change.file), tail: res.tail, summary })); } catch { /* no ledger or a full one: the warning below remains */ }
        warnings.push(`ci-${kind}-${res.status}: batch ${ciBatchNumber}${record.ticket ? ` (fix ticket ${record.ticket})` : ''}`);
        await appendEvent(root, { kind: 'ci-failure', hook: kind, batch: ciBatchNumber, status: res.status }, { best: true }).catch(() => {});
      }
      queue.ci.push(record);
      // A preview that came up is measured: Lighthouse and axe on the key screens, against the profile's budgets.
      if (kind === 'preview' && res.status === 'passed' && res.url && securityProfile?.budgets) {
        try {
          const { runBudgets, recordBudgetResults, hostAllowed } = await import('../budgets.mjs');
          // The address comes from a deploy log, which build code can write: it is measured only when its host is one the owner listed.
          if (!securityProfile.budgets.previewHosts) { warnings.push('budgets-skipped: set budgets.previewHosts (for example *.vercel.app) so a preview address from the deploy log can be trusted; swarm budgets check --url measures by hand'); continue; }
          if (!hostAllowed(res.url, securityProfile.budgets.previewHosts)) { warnings.push(`budgets-skipped: the preview address host is not in budgets.previewHosts`); continue; }
          const results = await runBudgets({ root, baseUrl: res.url, config: securityProfile.budgets, env: portEnv });
          await recordBudgetResults(root, results);
          for (const failed of results.filter(r => !r.pass)) {
            const ticket = await ticketForBudgetFailure(root, failed, changes.map(change => change.file));
            queue.ci.push({ batch: ciBatchNumber, kind: 'budgets', screen: failed.id, status: failed.status, ...(ticket ? { ticket } : {}) });
            warnings.push(`budgets-${failed.status}: screen ${failed.id}${ticket ? ` (fix ticket ${ticket})` : ''}`);
          }
          if (results.every(r => r.pass)) queue.ci.push({ batch: ciBatchNumber, kind: 'budgets', status: 'passed', screens: results.length });
        } catch (error) { warnings.push(`budgets-error: ${String(error.message).slice(0, 120)}`); }
      }
    }
  };
  const applyBatch = async (batch, { last = false, forceFull = false } = {}) => {
    const ready = [];
    for (const plan of batch) {
      const files = [];
      let reason = 'changed since worker snapshot';
      for (const snapshot of plan.snapshots) {
        const current = await bytesAt(root, snapshot.file);
        const mode = current === null ? 0o644 : (await fs.stat(await safePath(root, snapshot.file))).mode & 0o777;
        const changed = current === null ? snapshot.bytes !== null : snapshot.bytes === null || !current.equals(snapshot.bytes);
        if (changed || mode !== snapshot.mode) files.push(snapshot.file);
        if (mode !== snapshot.mode) reason = 'permissions changed since worker snapshot';
      }
      if (files.length) queue.conflicts.push({ job: plan.job, files, reason });
      else ready.push(plan);
    }
    batch = ready;
    if (!batch.length) { await persist(); return; }
    const alreadyApplied = batch.filter(plan => plan.alreadyApplied);
    queue.integrated.push(...alreadyApplied.map(plan => plan.job));
    batch = batch.filter(plan => !plan.alreadyApplied);
    if (!batch.length) { await persist(); return; }
    const changes = batch.flatMap(plan => plan.writes);
    const journal = await startIntegrationJournal(root, id, 'queue-batch', batch.map(plan => plan.job), changes, releaseIntegrationLock);
    let result;
    let gate = null;
    try {
      for (const change of changes) {
        // Recheck immediately before a write: preChecks or another writer may have moved it.
        const current = await bytesAt(root, change.file);
        const mode = current === null ? 0o644 : (await fs.stat(await safePath(root, change.file))).mode & 0o777;
        if (current === null ? change.previous !== null : change.previous === null || !current.equals(change.previous)) fail(`Integration conflict: ${change.file} changed since worker snapshot`);
        if (mode !== change.mode) fail(`Integration conflict: ${change.file} permissions changed since worker snapshot`);
        await journal.perform(async () => {
          if (change.bytes === null) await fs.unlink(await safePath(root, change.file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
          else await write(root, change.file, change.bytes, false, change.mode);
        });
      }
      // The owner approved the ticket that declares these packages: its manifest and lockfile change is approved by content (the audit still runs).
      gate = await runSecurityGate({ changes: changes.map(change => ({ file: change.file, bytes: change.bytes, previous: change.previous })), policy: withApprovedManifests(securityPolicy, changes.filter(change => change.fromDependencies && change.bytes).map(change => ({ file: change.file, sha256: digest(change.bytes) }))), hookScripts: hookScriptNames(securityProfile), exec: securityGate.exec ?? securityExec, fetchImpl: securityGate.fetchImpl ?? fetch, cwd: root, sensitive: securitySensitive, fingerprintKey: securityKey, cache: securityCache });
      // The gate runs BEFORE the project checks: a blocked batch never gets to execute its own code (tests, installs, postinstall scripts).
      if (gate.ok && changes.some(change => change.fromDependencies)) {
        // The gate passed (manifest approved, lockfile audited): now the packages go into node_modules, from that lockfile, with no install scripts.
        const installed = await installDependencies({ root, exec: securityGate.exec ?? securityExec });
        if (!installed.ok) gate = { ...gate, ok: false, blocks: [{ check: 'dependency-install', severity: 'high', message: `npm install failed after the gate passed: ${installed.tail}` }] };
      }
      if (gate.ok) {
        // Migrations: every changed migration needs a down step, a destructive one needs the owner's approval, and up, seed, down, up must run clean.
        const migration = await migrationQueueCheck({ root, changes: changes.map(change => ({ file: change.file, bytes: change.bytes })), profile: securityProfile, exec: securityGate.exec ?? securityExec });
        for (const note of migration.notes) if (!queue.securityNotes.includes(note)) queue.securityNotes.push(note);
        if (migration.blocks.length) {
          gate = { ...gate, ok: false, blocks: migration.blocks };
          // One inbox item per migration file and content hash (a requeue does not add it again).
          const seenHuman = await readJournal(root, { kinds: ['human'] }).catch(() => []);
          for (const item of migration.needsApproval) {
            const text = `migration ${item.file} (${item.sha256.slice(0, 12)}) drops or rewrites data (${item.statements[0].kind}, line ${item.statements[0].line}): run swarm migrations approve ${item.file}`;
            if (!seenHuman.some(event => event.text === text)) await appendEvent(root, { kind: 'human', text }, { best: true }).catch(() => {});
          }
        }
      }
      if (gate.ok) {
        const changedFiles = changes.map(change => change.file);
        let selection = repoMap && !last && !forceFull ? selectAffectedTests(repoMap, changedFiles, { deleted: changes.filter(change => change.bytes === null).map(change => change.file) }) : null;
        // A file an earlier batch of this pass changed has stale map data: run everything. Tests those batches added or changed always run again.
        if (selection?.mode === 'affected') {
          if (changedFiles.some(file => touched.has(file))) selection = { mode: 'full', tests: [], reasons: ['touched-earlier'] };
          else selection = { ...selection, tests: [...new Set([...selection.tests, ...[...touched].filter(file => /\.(?:test|spec)\.|_test\.|(?:^|\/)test_[^/]*\.py$/.test(file))])].sort() };
        }
        const usedAffected = { value: false };
        const affected = selection ? { selection, useFull: check => { const n = (sinceFull.get(check.name) ?? 0) + 1; if (n >= (check.fullEvery ?? 5)) { sinceFull.set(check.name, 0); return true; } sinceFull.set(check.name, n); return false; } } : null;
        result = noChecks ? { checks: [], checksPassed: true } : await runChecks(root, manifest.checks ?? [], changedFiles, changes.filter(change => change.previous === null).map(change => change.file), spawnImpl, { baseCommit: state.baseCommit, noFlakeCheck, portBase, extraEnv: swarmEnv, affected });
        affectedBatchModes.set(batch, result.checks.some(check => check.mode === 'affected'));
      } else {
        result = { checks: [{ name: 'security-gate', status: 'failed', blocks: gate.blocks }], checksPassed: false };
      }
      for (const note of [...(gate.skipped ?? []), ...(gate.warnings ?? [])]) if (!queue.securityNotes.includes(note)) queue.securityNotes.push(note);
    } catch (error) { await journal.rollback(); throw error; }
    const failed = result.checksPassed === false;
    const batchId = queue.batches.length + 1;
    queue.batches.push({ id: batchId, jobs: batch.map(plan => plan.job), checks: noChecks && gate?.ok !== false ? 'skipped' : failed ? 'failed' : 'passed', security: gate ? (gate.ok ? 'passed' : 'blocked') : 'skipped', bisected: failed && batch.length > 1, checkResults: (result.checks ?? []).map(check => ({ name: check.name, status: check.status, mode: check.mode ?? 'full', ...(check.affectedTests !== undefined ? { tests: check.affectedTests } : {}), ...(check.status === 'failed' && typeof check.tail === 'string' && check.tail.trim() ? { tail: redactText(check.tail).slice(-600) } : {}) })) });
    warnings.push(...swarmCheckWarnings(result.checks));
    // Queue mode deliberately rolls failed batches back before bisecting. Plain integrate
    // retains its existing behavior: check failures never roll back its writes.
    if (failed) {
      await journal.rollback();
      if (batch.length === 1 && gate && !gate.ok) {
        queue.securityBlocked.push({ job: batch[0].job, blocks: gate.blocks });
        await recordGate({ root, runId: id, jobs: [batch[0].job], gate, appendEvent: (rootDir, event) => appendEvent(rootDir, event, { best: true }) });
      }
      if (batch.length === 1) queue.checkFailed.push({ job: batch[0].job, checks: result.checks.filter(check => !['passed', 'skipped'].includes(check.status)).map(check => check.name), ...(failureTail(result.checks) ? { tail: failureTail(result.checks) } : {}) });
    } else {
      if (gate?.tickets?.length) queue.securityTickets.push(...gate.tickets.map(ticket => ({ ...ticket, jobs: batch.map(plan => plan.job) })));
      queue.integrated.push(...batch.map(plan => plan.job));
      queue.integratedIn ??= {};
      for (const plan of batch) queue.integratedIn[plan.job] = batchId;
      for (const change of changes) touched.add(change.file);
      if (affectedBatchModes.get(batch) === true) affectedSinceFull = true;
      else if (!noChecks && (manifest.checks ?? []).length) affectedSinceFull = false;
      state.integratedFiles.push(...changes.map(change => change.file));
      state.integratedNewFiles.push(...changes.filter(change => change.previous === null).map(change => change.file));
      await recordIntegratedHashes(root, state, changes.map(change => change.file));
    }
    if (!failed) await journal.finish();
    if (!failed && (ciConfig?.smoke || ciConfig?.preview)) { try { await runCiHooks(batch, changes); } catch (error) { warnings.push(`ci-hooks-error: ${String(error.message).slice(0, 120)}`); } }
    await persist();
    if (failed && batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      // Halves of a failed batch always run the normal checks: a failure only the full run caught must not be narrowed away.
      await applyBatch(batch.slice(0, middle), { last, forceFull: true });
      await applyBatch(batch.slice(middle), { last, forceFull: true });
    }
    return !failed;
  };
  // --adaptive: the batch size grows after passing batches and shrinks after a failed one; bisect stays the safety net.
  const controller = adaptive ? createBatchController({ start: batchSize }) : null;
  for (let index = 0; index < plans.length;) {
    const size = controller ? controller.size : batchSize;
    const slice = plans.slice(index, index + size);
    index += slice.length;
    const passed = await applyBatch(slice, { last: index >= plans.length });
    if (controller && passed !== undefined) {
      controller.record(passed);
      queue.adaptive.sizes = [...controller.history];
      queue.adaptive.steps = controller.state().steps;
    }
  }
  // Affected-only batches are covered by one full run of the checks when no passing full run came after them.
  if (affectedSinceFull && !noChecks && state.integratedFiles.length) {
    const finalResult = await runChecks(root, manifest.checks ?? [], state.integratedFiles, state.integratedNewFiles, spawnImpl, { baseCommit: state.baseCommit, noFlakeCheck, portBase, extraEnv: swarmEnv });
    queue.finalCheck = { passed: finalResult.checksPassed !== false, checks: finalResult.checks.map(check => ({ name: check.name, status: check.status })) };
    warnings.push(...swarmCheckWarnings(finalResult.checks));
    if (finalResult.checksPassed === false) {
      queue.checkFailed.push({ job: '(final full check)', checks: finalResult.checks.filter(check => !['passed', 'skipped'].includes(check.status)).map(check => check.name) });
      queue.state = 'final-check-failed';
    }
  }
  if (queue.state !== 'final-check-failed') queue.state = 'done';
  state.integratedAt = new Date().toISOString();
  state.integrationStatus = 'queued';
  await persist();
  return { id, status: 'integrated', integrationStatus: 'queued', mergeQueue: queue, files: state.integratedFiles, warnings };
}

export { applyQueuePlans, executeClaudeShellJob, reaskWorkerReport, runMutants };
