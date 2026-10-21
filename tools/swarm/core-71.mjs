import { assertScratchOutsideRepo, resolveVenvInterpreterDirs } from '../claude-shell.mjs';
import { codexEnvironment, codexMessage, codexProfile, git, parseCodexReply, prepareViteCaches, resolveReadPaths, runCodexWithRetry, validateReadPaths } from '../codex-adapter.mjs';
import { CURSOR_BLIP_RE, cursorConfig, cursorEnvironment, cursorMessage, cursorProfile, redactCursorKey, requireCursorApiKey, resolveCursorBinary } from '../cursor-adapter.mjs';
import { isBuildArtifact } from '../ignored-artifacts.mjs';
import { acquireIntegrationLock } from '../integration-lock.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { validateReport } from '../reports.mjs';
import { copySkillsInto, SKILLS_DIR_NAME } from '../skills.mjs';
import { digest, setupFailedResult, venvUnresolvableResult } from './core-1.mjs';
import { safePath } from './core-21.mjs';
import { bytesAt, jobWorktreePath, saveDroppedWrite, write } from './core-31.mjs';
import { droppedBytesAt, execute, outputsChanged, recoverIntegrationJournal } from './core-41.mjs';
import { jsonWrite } from './core-31.mjs';
import { applyQueuePlans as applyQueuePlansBase } from './core-61.mjs';
import { prepareJobEnvironment } from './core-51.mjs';
import { reaskWorkerReport } from './core-61.mjs';
import { redcheckRunLocked } from './core-62.mjs';
import { journalWarning } from './warnings.mjs';
import { prepareWorktreeLocation, worktreeDiskLowResult, worktreeStatusMap } from './workspace.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function executeCodexJob(root, directory, job, proposalRoot, options) {
  const gitImpl = options.gitImpl ?? git;
  const isCursor = job.agent === 'cursor';
  const worktree = options.worktreePath ?? await jobWorktreePath(root, directory, job.id);
  const commonDir = await fs.realpath((await gitImpl(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  let added = false, keepWorktree = false, result, scratchDir;
  const baseline = { outputs: job.outputs, baseHashes: {}, baseModes: {} };
  try {
    await options.onWorktreePath?.(worktree);
    if (options.worktreePath) await prepareWorktreeLocation(worktree, options);
    await gitImpl(root, ['worktree', 'add', '--detach', worktree, options.baseCommit ?? 'HEAD']);
    added = true;
    for (const file of job.outputs) {
      const bytes = await bytesAt(worktree, file);
      baseline.baseHashes[file] = bytes === null ? null : digest(bytes);
      baseline.baseModes[file] = bytes === null ? 0o644 : (await fs.stat(await safePath(worktree, file))).mode & 0o777;
    }
    const prepared = await prepareJobEnvironment(root, directory, job, worktree, options);
    if (prepared.setupResult && prepared.setupResult.status !== 'passed') { result = setupFailedResult(prepared.setupResult.error); return result; }
    const environmentReadPaths = prepared.environmentReadPaths;
    // Copied once the worktree exists; the source dir was already read once per run, not per job.
    if (options.skillsSourceDir) await copySkillsInto(options.skillsSourceDir, path.join(worktree, SKILLS_DIR_NAME));
    // Field lesson #281: resources verified at dispatch travel in options.resources and are
    // copied here once this job's own worktree exists.
    for (const { file, bytes, mode } of options.resources ?? []) await write(worktree, file, bytes, false, mode);
    const metadataDir = await fs.realpath((await gitImpl(worktree, ['rev-parse', '--absolute-git-dir'])).trim());
    // Field lesson #197-followup: a project's own denied-home-dir additions (config
    // `deniedHomeDirs`) reach the real sandbox profile, not just the generic built-ins.
    const config = loadLocalConfig({ env: options.env });
    const { cacheWritePaths } = await prepareViteCaches(worktree, { environmentReadPaths, home: options.env?.HOME ?? os.homedir(), config });
    // Cursor: config.cursor (model/timeout/attempts/allowedPaths), the binary and the key, all
    // settled before the profile is written; allowedPaths are extra read-only grants.
    const cursorSettings = isCursor ? cursorConfig(config, options.env?.HOME ?? os.homedir()) : null;
    const cursorBinary = isCursor ? await resolveCursorBinary(options.env ?? process.env) : null;
    const cursorKey = isCursor ? requireCursorApiKey(options.env ?? process.env) : null;
    const readPaths = await resolveReadPaths([...(job.readPaths ?? []), ...(cursorSettings?.allowedPaths ?? [])], undefined, config);
    const venv = await resolveVenvInterpreterDirs(worktree);
    if (venv.unresolvable.length) { result = venvUnresolvableResult(venv.unresolvable); return result; }
    const venvInterpreterDenied = [];
    for (const dir of venv.dirs) {
      try { readPaths.push(...validateReadPaths([dir]), ...await resolveReadPaths([dir], undefined, config)); }
      catch { venvInterpreterDenied.push(`venv-interpreter-denied: ${dir}`); }
    }
    // Lesson #299: checks use one OS temp directory outside any repository, never the worktree.
    const scratchPath = path.join(os.tmpdir(), isCursor ? 'swarm-cursor' : 'swarm-codex', `${path.basename(directory)}-${job.id}`);
    await assertScratchOutsideRepo(scratchPath, file => fs.access(file));
    await fs.mkdir(scratchPath, { recursive: true });
    scratchDir = scratchPath;
    const realScratchDir = await fs.realpath(scratchDir);
    await assertScratchOutsideRepo(realScratchDir, file => fs.access(file));
    await options.onScratchDir?.(scratchDir);
    const profileOptions = { home: options.env?.HOME ?? os.homedir(), worktree, commonDir, metadataDir, scratchDir: realScratchDir, readPaths, environmentReadPaths, cacheWritePaths, config };
    const profileText = isCursor ? cursorProfile({ ...profileOptions, installDir: cursorBinary.installDir }) : codexProfile(profileOptions);
    const profileRelative = `${directory}/${job.id}/sandbox.sb`;
    await write(root, profileRelative, profileText, true);
    const profile = await safePath(root, profileRelative, { internal: true });
    const messageOptions = { contract: options.contract ?? null, gotchas: options.gotchas ?? '', skills: options.skills ?? '', agentsWorkspace: options.agentsWorkspace ?? null, checks: options.checks ?? [] };
    const message = isCursor ? cursorMessage(job, { ...messageOptions, apiKey: cursorKey }) : codexMessage(job, messageOptions);
    await write(root, `${directory}/${job.id}/message.txt`, message, true);
    const launchBaseline = { outputs: job.outputs, baseHashes: {}, baseModes: {} };
    for (const file of job.outputs) {
      const bytes = await bytesAt(worktree, file);
      launchBaseline.baseHashes[file] = bytes === null ? null : digest(bytes);
      launchBaseline.baseModes[file] = bytes === null ? 0o644 : (await fs.stat(await safePath(worktree, file))).mode & 0o777;
    }
    const beforeStatus = job.scope === 'open' ? await worktreeStatusMap(worktree) : null;
    const resultFiles = new Set();
    result = await runCodexWithRetry(async () => {
      // This is inside the run directory AND the allowed worktree, requiring no extra write grant.
      const resultRelative = `.swarm-codex-result-${crypto.randomBytes(12).toString('hex')}.json`;
      resultFiles.add(resultRelative);
      const lastMessage = path.join(worktree, resultRelative);
      // Field lesson #141: this worktree's own port block, next to testEnv; a manifest testEnv can
      // never set SWARM_PORT_BASE itself (refused at validate time).
      const workerEnv = { ...options.swarmEnv, SWARM_PORT_BASE: String(options.portBase), ...job.testEnv, TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir, SWARM_TEST_TMP: scratchDir };
      if (isCursor) {
        // The key is set last so neither swarmEnv nor testEnv can replace or drop it; the adapter
        // log sink and the saved stdout/stderr/response are redacted against it.
        const cursorJob = { ...job, timeoutMs: job.timeoutMs ?? cursorSettings.timeoutMs };
        result = await execute(cursorJob, worktree, message, { ...options, logDirectory: path.join(root, directory, job.id), workerKey: cursorKey, cursor: { profile, bin: cursorBinary.bin, worktree, apiKey: cursorKey, env: { ...await cursorEnvironment(options.env), ...workerEnv, CURSOR_API_KEY: cursorKey } } });
        for (const key of ['stdout', 'stderr', 'response', 'error', 'blipText']) {
          if (typeof result[key] === 'string' && result[key].includes(cursorKey)) { result.workerKeyExposed = true; result[key] = redactCursorKey(result[key], cursorKey); }
        }
      } else result = await execute(job, worktree, message, { ...options, logDirectory: path.join(root, directory, job.id), codex: { worktree, profile, lastMessage, resultRelative, env: { ...await codexEnvironment(options.env), ...workerEnv } } });
      if (result.status === 'complete') {
        const outputs = [], missing = [];
        for (const file of job.outputs) {
          const bytes = await bytesAt(worktree, file);
          if (bytes === null) { missing.push(file); continue; }
          outputs.push({ file, bytes, mode: (await fs.stat(await safePath(worktree, file))).mode & 0o777 });
        }
        const leaked = isCursor ? outputs.filter(output => output.bytes.includes(Buffer.from(cursorKey))).map(output => output.file) : [];
        if (leaked.length) {
          result = { ...result, status: 'failed', workerKeyExposed: true, error: `output contains CURSOR_API_KEY: ${leaked.join(', ')}` };
        } else if (missing.length) {
          // Field lesson 19: a worker's own "blocked" envelope is the real reason, reported as
          // job status blocked with its summary — never masked by a generic missing-output error.
          const reply = parseCodexReply(result.response);
          if (reply?.status === 'blocked' && (job.report !== 'short' || validateReport(reply, { outputs: job.outputs }).report)) {
            const summary = typeof reply.summary === 'string' && reply.summary.trim() ? reply.summary.trim()
              : typeof reply.file === 'string' && reply.file.trim() ? `needs ${reply.file.trim()}` : 'no summary given';
            result = { ...result, status: 'blocked', error: `blocked: ${summary}`.slice(0, 300) };
          } else result = { ...result, status: 'failed', error: `Missing output (deletions are never propagated): ${missing.join(', ')}` };
        } else {
          result = await reaskWorkerReport(job, result, worktree, options, async reaskMessage => {
            const reaskRelative = `.swarm-codex-result-${crypto.randomBytes(12).toString('hex')}.json`;
            resultFiles.add(reaskRelative);
            const launchOptions = { ...options, logDirectory: path.join(root, directory, job.id), onOutput: () => {} };
            if (isCursor) {
              const reask = await execute(job, worktree, reaskMessage, { ...launchOptions, workerKey: cursorKey, cursor: { profile, bin: cursorBinary.bin, worktree, apiKey: cursorKey, env: { ...await cursorEnvironment(options.env), ...workerEnv, CURSOR_API_KEY: cursorKey } } });
              for (const key of ['stdout', 'stderr', 'response', 'error']) if (typeof reask[key] === 'string') reask[key] = redactCursorKey(reask[key], cursorKey);
              return reask;
            }
            return execute(job, worktree, reaskMessage, { ...launchOptions, codex: { worktree, profile, lastMessage: path.join(worktree, reaskRelative), resultRelative: reaskRelative, env: { ...await codexEnvironment(options.env), ...workerEnv } } });
          });
          for (const output of outputs) await write(proposalRoot, output.file, output.bytes, false, output.mode);
        }
      }
      return result;
    }, { hasWrittenOutputs: () => outputsChanged(worktree, launchBaseline), onRetry: options.onRetry ?? (async () => {}), cancelled: options.cancelled, ...(isCursor ? { maxAttempts: cursorSettings.maxAttempts, blipRe: CURSOR_BLIP_RE, label: 'cursor-blip' } : {}) });
    if (job.scope === 'open') {
      result.filesChanged = [];
      for (const file of job.outputs) if (await outputsChanged(worktree, { ...baseline, outputs: [file] })) result.filesChanged.push(file);
      const dropped = [], droppedNew = [];
      for (const [file, code] of await worktreeStatusMap(worktree)) {
        if (job.outputs.includes(file) || resultFiles.has(file) || beforeStatus.get(file) === code || (code === '??' && isBuildArtifact(file))) continue;
        dropped.push(file);
        if (code === '??') droppedNew.push(file);
        await saveDroppedWrite(root, path.basename(directory), file, await droppedBytesAt(worktree, file), await droppedBytesAt(root, file), { useGit: true });
      }
      result.droppedWrites = dropped.sort();
      result.droppedWritesNew = droppedNew.sort();
    }
    if (venvInterpreterDenied.length) result.venvInterpreterDenied = venvInterpreterDenied;
    // Lesson #64: a completed job that only resolved through the result-file or worktree
    // fallback keeps its worktree too, since its envelope was reconstructed, not reported.
    if (result.envelopeFallback) {
      keepWorktree = true;
      result.keptWorkspace = worktree;
    }
    // Lesson #41: a clean exit with an invalid final envelope is the only evidence of what codex
    // actually did, so the worktree stays on disk instead of being discarded with everything else.
    if (result.envelopeInvalid) {
      keepWorktree = true;
      result.error = `envelope invalid; worktree kept at ${worktree}`;
      result.keptWorkspace = worktree;
    }
    return result;
  } catch (error) {
    if (['workspace-env-invalid', 'vite-temp-not-writable'].includes(error.code)) { result = { ...setupFailedResult(error.message), code: error.code, path: error.path }; return result; }
    if (error.code === 'worktree-disk-low') { result = worktreeDiskLowResult(error.message); return result; }
    // Output validation can fail after a successful provider result. Keep any real
    // edited files even when another declared output is missing or unsafe.
    if (added && await outputsChanged(worktree, baseline, { existingOnly: true })) {
      keepWorktree = true;
      if (result) return { ...result, status: 'failed', error: error.message, keptWorkspace: worktree };
      error.keptWorkspace = worktree;
    }
    throw error;
  } finally {
    if (scratchDir && (options.env ?? process.env).SWARM_KEEP_TMP !== '1') await fs.rm(scratchDir, { recursive: true, force: true });
    // Deletions veto retries, but only surviving edits justify retaining a failed worktree. A
    // worktree holding a leaked CURSOR_API_KEY is never kept (same rule as a shell job's).
    if (result?.workerKeyExposed) { keepWorktree = false; result.keptWorkspace = null; }
    else if (added && (!result || result.status !== 'complete') && await outputsChanged(worktree, baseline, { existingOnly: true })) {
      keepWorktree = true;
      if (result) result.keptWorkspace = worktree;
    }
    if (added && !keepWorktree) await gitImpl(root, ['worktree', 'remove', '--force', worktree]);
  }
}

export function queueManifestJobs(manifest) {
  return (manifest.jobs ?? []).filter(job => job.type !== 'lead');
}

export function jobIntegrationStatus(state, jobId) {
  return state.jobIntegration?.[jobId]?.status ?? null;
}

export function isJobIntegrated(state, jobId) {
  return jobIntegrationStatus(state, jobId) === 'integrated';
}

export function queueIntegrationComplete(state, manifest) {
  const jobs = queueManifestJobs(manifest);
  if (!jobs.length) return false;
  if (state.jobIntegration && typeof state.jobIntegration === 'object' && !Array.isArray(state.jobIntegration)) {
    return jobs.every(job => state.jobIntegration[job.id]?.status === 'integrated');
  }
  const integrated = new Set(state.mergeQueue?.integrated ?? []);
  return jobs.every(job => integrated.has(job.id));
}

/** True when some manifest jobs are not integrated yet but an earlier pass already wrote files. */
export function queueIntegrationIncomplete(state, manifest) {
  if (!state.integratedAt) return false;
  if (state.integrationStatus === 'complete') return false;
  if (state.integrationStatus === 'partial' || state.integrationStatus === 'queued') return !queueIntegrationComplete(state, manifest);
  return false;
}

export function captureQueueIntegrationPrior(state) {
  return {
    integratedFiles: [...(state.integratedFiles ?? [])],
    integratedNewFiles: [...(state.integratedNewFiles ?? [])],
    integratedHashes: state.integratedHashes && typeof state.integratedHashes === 'object' && !Array.isArray(state.integratedHashes)
      ? { ...state.integratedHashes } : {},
    jobIntegration: state.jobIntegration && typeof state.jobIntegration === 'object' && !Array.isArray(state.jobIntegration)
      ? { ...state.jobIntegration } : {},
    integrationPasses: Array.isArray(state.integrationPasses) ? [...state.integrationPasses] : [],
  };
}

export function recordQueuePass(state, manifest, mergeQueue, { prior, at }) {
  const jobs = queueManifestJobs(manifest);
  state.jobIntegration = { ...prior.jobIntegration };
  const pass = { at, integrated: [], blocked: [], skipped: [], conflicts: [] };
  for (const jobId of mergeQueue.integrated ?? []) {
    if (isJobIntegrated(state, jobId)) continue;
    state.jobIntegration[jobId] = { status: 'integrated', at, pass: prior.integrationPasses.length + 1 };
    pass.integrated.push(jobId);
  }
  for (const blocked of mergeQueue.securityBlocked ?? []) {
    state.jobIntegration[blocked.job] = { status: 'blocked', at, reason: 'security-gate', blocks: blocked.blocks };
    pass.blocked.push({ job: blocked.job, kind: 'security-gate' });
  }
  for (const conflict of mergeQueue.conflicts ?? []) {
    state.jobIntegration[conflict.job] = { status: 'blocked', at, reason: conflict.reason ?? 'conflict', files: conflict.files };
    pass.conflicts.push(conflict);
  }
  for (const entry of mergeQueue.skipped ?? []) {
    const job = entry.job ?? entry;
    const jobStatus = entry.status ?? 'skipped';
    if (!state.jobIntegration[job]) state.jobIntegration[job] = { status: 'skipped', at, jobStatus };
    pass.skipped.push(entry);
  }
  for (const failed of mergeQueue.checkFailed ?? []) {
    if (!failed.job || failed.job === '(final full check)') continue;
    state.jobIntegration[failed.job] = { status: 'blocked', at, reason: 'checks-failed', checks: failed.checks, ...(failed.tail ? { tail: failed.tail } : {}) };
    pass.blocked.push({ job: failed.job, kind: 'checks-failed' });
  }
  state.integrationPasses = [...prior.integrationPasses, pass];
  state.integratedFiles = [...new Set([...prior.integratedFiles, ...(state.integratedFiles ?? [])])];
  state.integratedNewFiles = [...new Set([...prior.integratedNewFiles, ...(state.integratedNewFiles ?? [])])];
  const allIntegrated = jobs.every(job => state.jobIntegration[job.id]?.status === 'integrated');
  if (allIntegrated) state.integrationStatus = 'complete';
  else if ((mergeQueue.securityBlocked ?? []).length) state.integrationStatus = 'partial';
  else state.integrationStatus = 'queued';
  return allIntegrated;
}

export async function applyQueuePlans(root, id, state, manifest, plans, options) {
  const prior = captureQueueIntegrationPrior(state);
  const result = await applyQueuePlansBase(root, id, state, manifest, plans, options);
  const mergeQueue = result.mergeQueue ?? state.mergeQueue;
  const complete = recordQueuePass(state, manifest, mergeQueue, { prior, at: new Date().toISOString() });
  await jsonWrite(root, `.swarm/runs/${id}/state.json`, state);
  const status = complete ? 'integrated' : 'partial';
  return { ...result, status, integrationStatus: state.integrationStatus, files: state.integratedFiles, filesChanged: state.integratedFiles };
}

export async function redcheckRun(root, id, argv, options = {}) {
  let lock;
  try {
    root = await fs.realpath(root);
    lock = await acquireIntegrationLock(root, { runId: id, branch: options.branch, liveDir: options.liveDir, isAlive: options.isAlive });
    const recoveredJournal = await recoverIntegrationJournal(root);
    const result = await redcheckRunLocked(root, id, argv, options);
    if (lock.warnings.length || recoveredJournal) result.warnings = [...lock.warnings, ...(recoveredJournal ? [journalWarning(recoveredJournal)] : []), ...(result.warnings ?? [])];
    if (recoveredJournal) result.recoveredJournal = recoveredJournal;
    return result;
  } catch (error) { return { status: 'error', exitCode: null, restored: [], tail: error.message, base: options.base ?? 'run-base' }; }
  finally { if (lock) await lock.release(); }
}
