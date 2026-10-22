import { API_AGENTS } from '../api-adapters.mjs';
import { claudeShellArgs } from '../claude-shell.mjs';
import { claudeQuotaSignal, EXTRA_CLI_AGENTS, extraCliArgs, extraCliEnvironment, summarizeModels } from '../cli-adapters.mjs';
import { resolveCliHosts, sshEnv, sshInvocation } from '../cli-host.mjs';
import { codexArgs, codexUsage, createAdapterLogSink, git, parseCodexReply, resolveCodexEnvelope } from '../codex-adapter.mjs';
import { cursorLaunchArgs, parseCursorOutput, resolveCursorEnvelope } from '../cursor-adapter.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { estimateCostFromTranscript } from '../rates.mjs';
import { routeJob } from '../router.mjs';
import { passRateFailuresFor } from '../lane-pass-routing.mjs';
import { findPrivateNameHitsInText, githubRepo, loadPrivateNames, repoVisibility } from '../ship.mjs';
import { expandRootArgv } from './checks.mjs';
import { claudeArgs, declaresDependencies, digest, execFileAsync, extraCliResult, fail, lastFailureLines, namedTestPaths, pathContains, redactSecrets, setupFailedResult, stopChild, transcriptLastActivity } from './core-1.mjs';
import { readMutantsSource, relative, runCheck } from './core-11.mjs';
import { withoutApiOnlyFields } from './core-2.mjs';
import { safePath } from './core-21.mjs';
import { bytesAt, expandContextGlobs, parseFinalJson, validateManifest, write } from './core-31.mjs';
import { mutantCheckSpec } from './mutants.mjs';
import { ASK_ROUTE_INVALID, ID, MAX_FILE, SANDBOX_CANNOT_START_RE, TIERS, UV_LOCK_PATH_SOURCE_RE } from './patterns.mjs';
import { isWorktreeWriter } from './workspace.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function recordIntegratedHashes(root, state, paths) {
  const merged = { ...(state.integratedHashes && typeof state.integratedHashes === 'object' && !Array.isArray(state.integratedHashes) ? state.integratedHashes : {}) };
  for (const rel of paths) {
    if (typeof rel !== 'string' || !rel) continue;
    try {
      const bytes = await bytesAt(root, rel);
      if (bytes === null) continue;
      merged[rel.replace(/\\/g, '/')] = digest(bytes);
    } catch { /* hashing must never fail integration */ }
  }
  state.integratedHashes = merged;
}

export async function missingDepsWarnings(root, { fsImpl = fs } = {}) {
  const isDir = async relPath => { try { return (await fsImpl.stat(path.join(root, relPath))).isDirectory(); } catch { return false; } };
  const warnings = [];
  const packageJsonBytes = await bytesAt(root, 'package.json');
  if (packageJsonBytes !== null && declaresDependencies(packageJsonBytes) && !(await isDir('node_modules'))) {
    warnings.push({ code: 'missing-deps', path: 'node_modules', message: 'package.json exists but node_modules is missing; checks may fail to spawn (try npm ci --offline)' });
  }
  if ((await bytesAt(root, 'pyproject.toml')) !== null && !(await isDir('.venv'))) {
    warnings.push({ code: 'missing-deps', path: '.venv', message: 'pyproject.toml exists but .venv is missing; checks may fail to spawn (try uv sync --offline)' });
  }
  return warnings;
}

export async function missingLockPathSourceWarnings(root, { fsImpl = fs } = {}) {
  const bytes = await bytesAt(root, 'uv.lock');
  if (bytes === null) return [];
  const warnings = [];
  for (const block of bytes.toString('utf8').split(/^\[\[package\]\]/m).slice(1)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const source = UV_LOCK_PATH_SOURCE_RE.exec(block)?.[1];
    if (!name || !source || path.isAbsolute(source)) continue;
    try { await fsImpl.stat(path.join(root, source)); }
    catch { warnings.push({ code: 'uv-lock-missing-path-source', path: source, message: `uv.lock package ${name} names a path source (${source}) missing from the tree; an offline install will fail to find it` }); }
  }
  return warnings;
}

async function expandJobContext(root, job) {
  const { extra } = await expandContextGlobs(root, job);
  return [...new Set([...job.context, ...extra])];
}

// #271: a dropped write is saved for salvage. Only swarm-internal copies (`.swarm/...`, e.g. a
// seeded skill) may bypass the reserved-path guard; any other reserved or secret path is never
// read, so a real secret file is never copied into the run folder (returns null = not saved).
async function droppedBytesAt(root, value) {
  const internal = value === '.swarm' || value.startsWith('.swarm/');
  try { return await bytesAt(root, value, internal); }
  catch (error) { if (!internal && /Reserved|secret/i.test(String(error?.message))) return null; throw error; }
}

// Expansion is a dispatch-time snapshot. Saved manifests are never passed here by inspect,
// integrate or redcheck; their output/base-hash lists remain authoritative across HEAD changes.
export async function expandOpenScopes(root, manifest) {
  const expanded = structuredClone(manifest);
  validateManifest(expanded);
  if (!expanded.jobs.some(job => job.scope === 'open')) return expanded;
  const entries = (await git(root, ['ls-tree', '-r', '-z', 'HEAD'])).split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    return { mode: entry.slice(0, 6), file: entry.slice(tab + 1) };
  });
  for (const job of expanded.jobs) {
    if (job.scope !== 'open') continue;
    for (const dir of job.outputDirs) {
      try {
        const target = await safePath(root, dir);
        if (!(await fs.lstat(target)).isDirectory() || !entries.some(entry => entry.file !== dir && pathContains(dir, entry.file))) throw Error('not tracked');
      } catch { fail(`scope-open-path: Job ${job.id}: ${dir} is not a safe tracked directory`, 'scope-open-path'); }
    }
    const trackedScopeFiles = [];
    for (const { mode, file } of entries) {
      if (!['100644', '100755'].includes(mode) || !job.outputDirs.some(dir => file !== dir && pathContains(dir, file))) continue;
      // Deleted files and symlink replacements are not grants. Reserved paths also fail closed.
      try { if ((await fs.lstat(await safePath(root, file))).isFile()) trackedScopeFiles.push(file); }
      catch (error) { if (error.code !== 'ENOENT' && !/Symlink refused|Reserved or secret/.test(error.message)) throw error; }
    }
    const effectiveOutputs = [...new Set([...job.outputs, ...trackedScopeFiles])].sort();
    if (effectiveOutputs.length > 100) fail(`scope-open-too-large: Job ${job.id}: expanded outputs exceed 100 files; narrow outputDirs`, 'scope-open-too-large');
    job.outputs = effectiveOutputs;
  }
  validateManifest(expanded);
  return expanded;
}

export async function execute(job, cwd, message, { spawnImpl, signal, cancelled = () => false, killImpl, onOutput = () => {}, codex, cursor, claudeShell, resumeSessionId, logDirectory, workerKey }) {
  // Hermes/Qwen may run on another machine over ssh (machine config `cliHosts`). A bad config fails
  // this job only.
  let cliHost = null;
  if (EXTRA_CLI_AGENTS.includes(job.agent)) {
    try { cliHost = resolveCliHosts(loadLocalConfig({ env: process.env }).cliHosts)[job.agent] ?? null; }
    catch (error) { return { ...setupFailedResult(error.message), setupFailed: false, code: error.code }; }
  }
  let sink;
  try { if (logDirectory) sink = await createAdapterLogSink(logDirectory, { privateData: job.privateData === true, workerKey }); }
  catch (error) { return { ...setupFailedResult(error.message), setupFailed: false, code: error.code, stream: error.stream }; }
  return new Promise(resolve => {
    let child, stdout = '', stderr = '', reason, settled = false, size = 0;
    let timeout, poll, termination, logFailure;
    const stop = why => { if (reason || settled) return; reason = why; termination=stopChild(child,{killImpl}); termination.then(cleanup=>{if(cleanup.error)finish(null);}); };
    const onAbort = () => stop('cancelled');
    const finish = async (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearInterval(poll); signal?.removeEventListener('abort', onAbort);
      const cleanup=await(termination??stopChild(child,{killImpl}));
      try { await sink?.close(); } catch (problem) { logFailure ??= problem; }
      const cleanupError=cleanup.error;
      if (logFailure) {
        resolve({ ...setupFailedResult(logFailure.message), setupFailed: false, refusedBeforeStart: false, code: 'adapter-log-failed', stream: logFailure.stream, stdout, stderr, exitCode: code, cleanupError, terminationReason: reason ?? null });
        return;
      }
      if(cleanupError){child?.unref();child?.stdin?.destroy();child?.stdout?.destroy();child?.stderr?.destroy();}
      if (job.agent === 'cursor') {
        // stdout is cursor's `--output-format json` result; the envelope is read from its final
        // text exactly as codex's, then from the outputs-only worktree diff.
        const parsed = parseCursorOutput(stdout);
        let response = parsed?.response ?? '', envelopeInvalid = false, envelopeFallback = null, finalObject = null;
        let failed = cleanupError || reason || error?.message || (code !== 0 ? `Cursor exited ${code}` : null) || (parsed?.isError ? `Cursor result: ${parsed.subtype || 'error'}` : null);
        if (!failed) {
          const resolved = await resolveCursorEnvelope(stdout, cwd, job);
          if (resolved) { envelopeFallback = resolved.fallback; response = resolved.response; finalObject = resolved.result; }
          else { failed = 'Invalid Cursor result envelope'; envelopeInvalid = true; }
        }
        const usage = parsed?.usage && Number.isSafeInteger(parsed.usage.total_tokens ?? parsed.usage.totalTokens) ? { total_tokens: parsed.usage.total_tokens ?? parsed.usage.totalTokens } : null;
        resolve({ finalObject, cleanupError, terminationReason: reason ?? null, status: cleanupError ? 'failed' : reason === 'timeout' ? 'timeout' : reason === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'complete', error: failed, envelopeInvalid, envelopeFallback, stdout, stderr, response, blipText: parsed?.isError ? parsed.response : '', exitCode: code, actualModel: null, modelsSeen: [], modelMismatch: false, usage, modelUsage: null, costUsd: null });
        return;
      }
      if(job.agent === 'codex') {
        let response = '', envelopeInvalid = false, envelopeFallback = null, finalObject = null, failed = cleanupError || reason || error?.message || (code !== 0 ? `Codex exited ${code}` : null);
        if (!failed) {
          response = (await bytesAt(cwd, codex.resultRelative, true))?.toString('utf8') ?? '';
          const resolved = await resolveCodexEnvelope(response, cwd, codex.resultRelative, job);
          if (resolved) { envelopeFallback = resolved.fallback; finalObject = resolved.result; }
          else { failed = 'Invalid Codex result envelope'; envelopeInvalid = true; }
        }
        resolve({ finalObject, cleanupError, terminationReason: reason ?? null, status: cleanupError ? 'failed' : reason === 'timeout' ? 'timeout' : reason === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'complete', error: failed, envelopeInvalid, envelopeFallback, stdout, stderr, response, exitCode: code, actualModel: null, modelsSeen: [], modelMismatch: false, usage: codexUsage(stdout + '\n' + stderr), modelUsage: null, costUsd: null });
        return;
      }
      if(EXTRA_CLI_AGENTS.includes(job.agent)){
        resolve(extraCliResult(job,{stdout,code,reason,error,cleanupError,cliHost}));
        return;
      }
      let result, parseError; const events=[];
      for (const line of stdout.split('\n').filter(Boolean)) {
        try { const event = JSON.parse(line); events.push(event); if (event.type === 'result') result = event; }
        catch { parseError = 'Malformed provider JSONL'; }
      }
      // Lesson 347: classify only provider error events or standalone failed-exit diagnostics.
      if (job.agent === 'claude' && !cleanupError && !reason && !error) {
        const quota = claudeQuotaSignal(stdout, stderr, code, events);
        if (quota) {
          resolve({ cleanupError, terminationReason: null, status: 'provider-limit', error: `provider-limit: resets ${quota.resetsAt}`, resetsAt: quota.resetsAt, stdout, stderr, response: '', exitCode: code, actualModel: null, modelsSeen: [], modelMismatch: false, usage: null, modelUsage: null, costUsd: null });
          return;
        }
      }
      // Lesson #46: init only reports the requested model, not what actually ran.
      const { actualModel, modelsSeen, modelMismatch } = summarizeModels(events, job.model);
      const failed = cleanupError || reason || error?.message || (code !== 0 ? `Worker exited ${code}` : null) || parseError || (!result ? 'Worker returned no result event' : null) || (result?.is_error || (result?.subtype && result.subtype !== 'success') ? `Worker result: ${result.subtype || 'error'}` : null);
      // Field lesson #248: a transient provider error (5xx or 429) reported on the result event
      // itself is not a worker failure; the job loop above decides the retry, this only surfaces
      // the status for it to act on.
      const apiErrorStatus = typeof result?.api_error_status === 'number' ? result.api_error_status : null;
      // Field lesson #193: a cancelled job is killed before its final `result` event ever lands;
      // the last already-streamed event that reported a running cost is still real spend, so a
      // cancelled scout/ask/run reports that instead of a costUsd that only ever meant "no result".
      const lastCostEvent = result ? result : events.findLast(event => typeof event?.total_cost_usd === 'number');
      let costUsd = lastCostEvent?.total_cost_usd ?? null, costSource = costUsd !== null ? 'reported' : null, costWarning = null;
      // Field lesson #252: no reported cost (the job died before or without a CLI result event
      // that carried one) but a real transcript exists — estimate spend from it instead of leaving
      // costNotReported for a job that plainly spent something.
      if (costUsd === null) {
        const estimate = estimateCostFromTranscript(stdout, job.model);
        if (estimate.costUsd !== null) { costUsd = estimate.costUsd; costSource = 'estimated-from-transcript'; }
        else if (estimate.usage) costWarning = `cost-rate-unknown: ${job.model}`;
      }
      resolve({ cleanupError, terminationReason:reason??null, status: cleanupError ? 'failed' : reason === 'timeout' ? 'timeout' : reason === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'complete', error: failed || null, permissionDenials: Array.isArray(result?.permission_denials) ? result.permission_denials : [], stdout, stderr, response: typeof result?.result === 'string' ? result.result : '', exitCode: code, actualModel: actualModel ?? null, modelsSeen, modelMismatch, usage: result?.usage ?? null, modelUsage: result?.modelUsage ?? null, costUsd, costSource, ...(costWarning ? { costWarning } : {}), apiErrorStatus, ...(reason === 'timeout' ? { lastActivity: transcriptLastActivity(stdout) } : {}) });
    };
    if (signal?.aborted) { reason = 'cancelled'; return finish(null); }
    try {
      child = job.agent === 'codex'
        ? spawnImpl('sandbox-exec', codexArgs(job, { ...codex, message }), { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: codex.env })
        // The whole cursor-agent process runs inside the profile; the key travels only in env.
        : job.agent === 'cursor' ? spawnImpl('sandbox-exec', cursorLaunchArgs(job, { ...cursor, message }), { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: cursor.env })
        // Decision #154: the whole claude process, not each command, runs inside the profile.
        : claudeShell ? spawnImpl('sandbox-exec', ['-f', claudeShell.profile, claudeShell.bin, ...claudeShellArgs(job)], { cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: claudeShell.env })
        // Over ssh the local environment never travels: ssh gets only what it needs to find its own key.
        : cliHost ? (() => { const ssh = sshInvocation(cliHost, extraCliArgs(job)); return spawnImpl(ssh.command, ssh.args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv(process.env) }); })()
        : spawnImpl(job.agent, job.agent==='claude'?claudeArgs(job,{resume:resumeSessionId}):extraCliArgs(job), { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: job.agent==='claude'?process.env:extraCliEnvironment(job.agent) });
      child.on('error', error => finish(null, error));
      child.once('exit',()=>{
        // Descendants may keep inherited stdio open after the leader exits.
        // Start cleanup now; parse output only after close drains the streams.
        termination??=stopChild(child,{killImpl});
        termination.then(cleanup=>{if(cleanup.error)finish(null);});
      });
      child.on('close', code => finish(code));
      for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.setEncoding('utf8').on('data', data => {
        try { sink?.write(key, data); } catch (error) { logFailure ??= error; stop('adapter-log-failed'); return; }
        const bytes = Buffer.byteLength(data);
        size += bytes;
        if (size > MAX_FILE) { stop('Worker log exceeded 16 MiB'); return; }
        if (key === 'stdout') stdout += data.toString(); else stderr += data.toString();
        // Counted after the 16 MiB check so telemetry matches the retained log exactly.
        onOutput(key, bytes);
      });
      if (!isWorktreeWriter(job)) { child.stdin.on('error', () => {}); child.stdin.end(message); }
      timeout = setTimeout(() => stop('timeout'), job.timeoutMs ?? 300000);
      poll = setInterval(async () => { try { if (await cancelled()) stop('cancelled'); } catch (error) { stop(error.message); } }, 100);
      signal?.addEventListener('abort', onAbort, { once: true });
    } catch (error) { finish(null, error); }
  });
}

// Field lesson #223: literal presence on disk, never "differs from base" (outputsChanged also
// counts a pre-existing, untouched output as changed only when its bytes moved; a job whose
// context and output are the same pre-existing file, left untouched, must never read as no-output).
async function anyOutputExists(root, outputs) {
  for (const file of outputs) if (await bytesAt(root, file) !== null) return true;
  return false;
}

async function outputsChanged(root, job, { existingOnly = false } = {}) {
  for (const file of job.outputs) {
    try {
      const bytes = await bytesAt(root, file);
      if (existingOnly && bytes === null) continue;
      if ((bytes === null ? null : digest(bytes)) !== job.baseHashes[file]) return true;
      if (bytes !== null && job.baseModes?.[file] !== undefined && ((await fs.stat(await safePath(root, file))).mode & 0o777) !== job.baseModes[file]) return true;
    } catch { if (!existingOnly) return true; } // Copied workspaces also retain unsafe proposals for inspection.
  }
  return false;
}

// Field lesson #142: `setup` runs once, outside the sandbox, in the job's own worktree, right
// after it exists and before the worker starts — a toolchain sync (`uv sync`, `npm ci`) needs
// network the worker itself never gets. Same env as the manifest's own `checks` (incl.
// SWARM_PORT_BASE), never the worker key. Returns the `setup-failed: ...` message, or null.
async function runJobSetup(root, directory, job, worktree, spawnImpl, portBase, cancelled, extraEnv = {}, onResult = () => {}) {
  if (!job.setup?.length) return null;
  const env = { ...process.env, ...extraEnv, ...(portBase != null ? { SWARM_PORT_BASE: String(portBase) } : {}) };
  delete env.ANTHROPIC_API_KEY; delete env.SWARM_CLAUDE_WORKER_API_KEY;
  let log = (await bytesAt(root, `${directory}/${job.id}/setup.log`, true))?.toString('utf8') ?? '';
  for (const argv of job.setup) {
    const result = await runCheck(argv[0], argv, worktree, 600000, spawnImpl, false, () => {}, env, { cancelled });
    onResult(result);
    log += `$ ${argv.join(' ')}\n${result.tail}\n`;
    if (result.status !== 'passed') {
      await write(root, `${directory}/${job.id}/setup.log`, redactSecrets(log), true);
      return `setup-failed: ${argv[0]} exit ${result.exitCode}`;
    }
  }
  await write(root, `${directory}/${job.id}/setup.log`, redactSecrets(log), true);
  return null;
}

async function smokeCheckInSandbox(root, directory, job, worktree, profile, env, checks, spawnImpl, timeoutMs) {
  // Field lesson #238: a check marked integrateOnly is known to need network/resources the shell
  // sandbox never grants, so it is never picked as the one check smoke-started before the worker.
  const check = checks.find(item => !item.integrateOnly && !item.argv.some(arg => /^\{(?:integrated|new)(?::[^}]+)?\}$/.test(arg)));
  if (!check) return null;
  const argv = expandRootArgv(check.argv, worktree);
  const { ANTHROPIC_API_KEY: _key, ...checkEnv } = env;
  const result = await runCheck(`smoke:${check.name}`, ['sandbox-exec', '-f', profile, ...argv], worktree, timeoutMs, spawnImpl, false, () => {}, checkEnv);
  await write(root, `${directory}/${job.id}/smoke.log`, redactSecrets(`$ ${argv.join(' ')}\n${result.status} exit ${result.exitCode}\n${result.tail}`), true);
  const cannotStart = ['spawn-error', 'unrunnable', 'check-env-missing'].includes(result.status) || (result.status === 'failed' && SANDBOX_CANNOT_START_RE.test(result.tail));
  return cannotStart ? { check: check.name, argv0: argv[0], status: result.status, exitCode: result.exitCode, lines: lastFailureLines(result.tail) } : null;
}

// Also runs cursor jobs: the same detached worktree, seatbelt, scratch dir, retry and output
// collection, with cursor's own profile additions, argv, allowlisted env and key redaction.
const reportObject = (job, result) => result.finalObject ?? (isWorktreeWriter(job) ? parseCodexReply(result.response) : parseFinalJson(result.response));

async function pendingBaseCheck(root, check, outputFiles) {
  const paths = namedTestPaths(check.argv);
  if (!paths.length) return null;
  const missingOutputs = [];
  for (const file of paths) {
    if (outputFiles.has(file) && await bytesAt(root, file) === null) missingOutputs.push(file);
  }
  return missingOutputs.length === paths.length ? { name: check.name, paths } : null;
}

async function ledgerSettings(root, manifest, config) {
  const ledger = { path: manifest.ledger?.path ?? config.ledger?.path ?? (await bytesAt(root, 'docs/state/usage-ledger.md') !== null ? 'docs/state/usage-ledger.md' : '.swarm/usage-ledger.md'), phase: manifest.ledger?.phase ?? '-' };
  relative(ledger.path, true);
  if (manifest.jobs.some(job => job.outputs.includes(ledger.path))) fail('ledger-is-output: ledger path is a job output', 'ledger-is-output');
  return ledger;
}

export async function readState(root, id) {
  if (typeof id !== 'string' || !ID.test(id)) fail('Invalid run id');
  const bytes = await bytesAt(root, `.swarm/runs/${id}/state.json`, true);
  if (!bytes) fail(`Unknown run: ${id}`);
  const state = JSON.parse(bytes);
  // Read defaults must not become persisted retry evidence when this state is saved again.
  for (const job of state.jobs ?? []) {
    if (job.retries == null) Object.defineProperty(job, 'retries', { value: 0, writable: true, configurable: true });
    if (job.retryReason == null) Object.defineProperty(job, 'retryReason', { value: null, writable: true, configurable: true });
  }
  return state;
}

// Field lesson #200: a worker sometimes writes a `"key":value` pair as an array item (e.g.
// `["basis":"context-only", "other note"]`), which is not valid JSON. This is a best-effort,
// regex-based repair (never a real parser): inside each non-nested `[...]` span, a stray
// `"key":value` becomes just `value`, and the result is re-parsed the normal way.
function repairArrayKeyValueJson(text) {
  if (typeof text !== 'string' || !text) return null;
  let changed = false;
  const repairedText = text.replace(/\[[^[\]]*\]/g, arrayText => {
    const rewritten = arrayText.replace(/"[A-Za-z0-9_.-]+"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g, '$1');
    if (rewritten !== arrayText) changed = true;
    return rewritten;
  });
  return changed ? parseFinalJson(repairedText) : null;
}

async function jobFinalJson(root, id, jobId) {
  const bytes = await bytesAt(root, `.swarm/runs/${id}/${jobId}/response.txt`, true);
  return parseFinalJson(bytes ? bytes.toString('utf8') : '');
}

// Field lesson #286: a claude worker CLI's own weekly/usage/rate-limit message, once seen, is
// recorded at the root (jsonWrite, above) so the *next* dispatch refuses instead of spending
// against the same outage; one global marker per root (a later quota overwrites the earlier one's
// reset time). An unparseable resetsAt never expires on its own (only --ignore-provider-limit
// clears it) — read with `internal: true` since `.swarm/...` is otherwise a reserved path.
export async function claudeProviderLimitGuard(root) {
  let marker;
  try { marker = JSON.parse((await bytesAt(root, '.swarm/claude-provider-limit.json', true))?.toString('utf8') ?? 'null'); }
  catch { return null; }
  if (!marker) return null;
  return Date.now() < Date.parse(marker.resetsAt) || Number.isNaN(Date.parse(marker.resetsAt)) ? marker : null;
}

async function runMutant(root, mutant, sharedCheckSpec, spawnImpl, env = process.env) {
  const start = Date.now();
  const checkSpec = mutantCheckSpec(mutant, sharedCheckSpec);
  const checkFields = { check: checkSpec.source, checkArgv: checkSpec.argv };
  const original = await bytesAt(root, mutant.file);
  if (original === null) return { name: mutant.name, file: mutant.file, status: 'error', exitCode: null, durationMs: Date.now() - start, tail: 'file not found', ...checkFields };
  const mode = (await fs.stat(await safePath(root, mutant.file))).mode & 0o777;
  const text = original.toString('utf8');
  const count = text.split(mutant.find).length - 1;
  // Field lesson #274: an invalid mutant (its find didn't match exactly once) is a distinct cause
  // from a build failure below; both used to collapse into the same 'error'/'invalid' status.
  if (count !== 1) return { name: mutant.name, file: mutant.file, status: 'invalid-find', exitCode: null, durationMs: Date.now() - start, tail: `find matched ${count} times`, ...checkFields };
  const mutated = Buffer.from(text.replace(mutant.find, mutant.replace), 'utf8');
  const originalHash = digest(original);
  try {
    await write(root, mutant.file, mutated, false, mode);
    const result = await runCheck(mutant.name, expandRootArgv(checkSpec.argv, root), root, checkSpec.timeoutMs ?? 300000, spawnImpl, false, () => {}, env);
    // Field lesson 136 (refined by #274): pytest/vitest/jest/mocha/node --test all exit 1
    // unambiguously on a real test failure (their own usage/collection errors use a different exit,
    // per lesson 136's own comment above), so exit 1 alone is still always a kill, exactly as
    // before. `cargo test`'s exit 101 is the ambiguous one — a `cargo build` failure exits 101 too
    // — so only that exit additionally requires a real failure line in the tail before it counts as
    // a kill; without one it's a build failure, not a kill.
    const AMBIGUOUS_TEST_FAILURE_EXIT = new Set([101]);
    const TEST_FAILURE_TAIL_RE = /FAILED|test result: FAILED|failures:|not ok \d|[✗✖]/;
    const status = result.status === 'passed' ? 'survived'
      : result.status === 'failed'
        ? (result.exitCode === 1 || (AMBIGUOUS_TEST_FAILURE_EXIT.has(result.exitCode) && TEST_FAILURE_TAIL_RE.test(result.tail ?? '')) ? 'killed' : 'invalid-build')
        : 'error';
    return { name: mutant.name, file: mutant.file, status, exitCode: result.exitCode, durationMs: result.durationMs, tail: result.tail, ...checkFields };
  } finally {
    await write(root, mutant.file, original, false, mode);
    const restored = await bytesAt(root, mutant.file);
    if (restored === null || digest(restored) !== originalHash) fail(`Failed to restore ${mutant.file} after mutant ${mutant.name}`);
  }
}

// A job's own `mutantsFile` output only exists once the run's outputs are integrated, so it is
// read from the project root (post-integration bytes), the same files a post-build mutant's
// `find` is checked against.
async function loadJobMutantsFile(root, relFile) {
  const bytes = await bytesAt(root, relFile);
  if (bytes === null) fail(`mutantsFile output missing: ${relFile}`);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { fail(`Invalid JSON in mutantsFile: ${relFile}`); }
  return readMutantsSource(relFile, data);
}

// Field lesson #256: the same "resultFile, else the worker's own final message" lookup the skills
// check below already used, pulled out so the deviations gate can use it too, before any file is
// written.
async function loadJobResultData(root, id, declared, readRoot) {
  if (declared.resultFile) {
    const bytes = await bytesAt(readRoot, declared.resultFile);
    try { return bytes ? JSON.parse(bytes.toString('utf8')) : null; } catch { return null; }
  }
  const responseBytes = await bytesAt(root, `.swarm/runs/${id}/${declared.id}/response.txt`, true);
  return responseBytes ? parseFinalJson(responseBytes.toString('utf8')) : null;
}

async function recoverIntegrationJournal(root) {
  const target = await safePath(root, '.swarm/integration-journal.json', { internal: true });
  let journal;
  try { journal = JSON.parse(await fs.readFile(target, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (journal.version !== 1 || !Array.isArray(journal.entries)) fail('Invalid integration journal');
  for (const entry of journal.entries) {
    if (entry.previous === null) await fs.unlink(await safePath(root, entry.file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    else await write(root, entry.file, Buffer.from(entry.previous, 'base64'), false, entry.mode);
  }
  await fs.unlink(target);
  return { runId: journal.runId, kind: journal.kind, jobs: journal.jobs, files: journal.entries.length };
}

// Field lesson #262: reuses, never duplicates, the existing #197/#211 private-names machinery —
// a contract or job prompt for a PUBLIC repo is scanned before dispatch, the same list `ship`
// already checks the diff against. With no list configured, this never spends a git/gh call.
export async function privateNamesDispatchGuard(root, manifest, { exec = execFileAsync, env = process.env, home = os.homedir() } = {}) {
  const list = await loadPrivateNames(root, null, { env, home });
  if (!list.terms.length) return;
  let originStdout;
  try { originStdout = (await exec('git', ['remote', 'get-url', 'origin'], { cwd: root })).stdout.trim(); } catch { return; }
  const repo = githubRepo(originStdout);
  if (!repo) return;
  const shipExecShape = async (cmd, args, opts) => {
    try { const r = await exec(cmd, args, opts); return { code: 0, stdout: r.stdout, stderr: r.stderr ?? '' }; }
    catch (e) { return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message ?? e) }; }
  };
  if ((await repoVisibility(shipExecShape, repo, { cwd: root })) !== 'PUBLIC') return;
  if (manifest.contract) {
    const contractText = (await bytesAt(root, manifest.contract))?.toString('utf8') ?? '';
    const hits = findPrivateNameHitsInText(manifest.contract, contractText, list.terms);
    if (hits.length) fail(`private-term-in-contract: ${hits[0].file}:${hits[0].line}`);
  }
  for (const job of manifest.jobs) {
    if (typeof job.prompt !== 'string') continue;
    const hits = findPrivateNameHitsInText(`job:${job.id}`, job.prompt, list.terms);
    if (hits.length) fail(`private-term-in-prompt: ${hits[0].file}:${hits[0].line}`);
  }
}

function pickJobRoute(job, lanes, options = {}) {
  const passFailures = options.passRateFailures ?? passRateFailuresFor(options.root ?? process.cwd());
  const failures = { ...(options.failures ?? {}) };
  for (const agent of new Set([...Object.keys(lanes ?? {}), ...Object.keys(options.failures ?? {}), ...Object.keys(passFailures ?? {})])) {
    failures[agent] = Math.max(options.failures?.[agent] ?? 0, passFailures?.[agent] ?? 0);
  }
  const { editInPlaceOnly = false, ...routeOptions } = options;
  return routeJob(job, { lanes, ...routeOptions, failures, accepts: candidate => {
    if (editInPlaceOnly && API_AGENTS.includes(candidate.agent)) return false;
    if (candidate.after && isWorktreeWriter(candidate)) return false;
    try { validateManifest({ version: 1, jobs: [withoutApiOnlyFields({ ...candidate, after: undefined })] }); return true; }
    catch { return false; }
  } });
}

export function resolveAskRoute(options = {}, config = {}) {
  let { agent, model, tier } = options;
  const invalid = () => fail(ASK_ROUTE_INVALID, 'ask-route-invalid');
  const validPair = pair => {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair) || typeof pair.agent !== 'string' || typeof pair.model !== 'string' || !pair.model.trim()) return false;
    try { validateManifest({ version: 1, jobs: [{ id: 'ask-route', agent: pair.agent, model: pair.model, ...(options.sensitive !== undefined ? { sensitive: options.sensitive } : {}), prompt: 'Answer the question.', context: [], outputs: [] }] }); return true; }
    catch (error) {
      if (['sensitive-openrouter', 'sensitive-provider'].includes(error.code)) fail(`ask-sensitive-provider: ${pair.agent} needs --not-sensitive; the question and context would leave for a third-party API`, 'ask-sensitive-provider');
      return false;
    }
  };
  if (tier !== undefined) {
    if (!TIERS.includes(tier) || agent !== undefined || model !== undefined) invalid();
    const selected = config?.tiers?.[tier];
    if (!validPair(selected)) invalid();
    ({ agent, model } = selected);
  } else {
    if (typeof model !== 'string' || !model.trim()) fail('ask requires --model or --tier');
    agent ??= 'claude';
    if (!validPair({ agent, model })) invalid();
  }
  // `ask` never goes to the rented lane: it has no run, no run cap and no meter there.
  if (agent === 'claude' || (API_AGENTS.includes(agent) && agent !== 'rented')) return { agent, model };
  const unconfigured = () => fail(`ask-agent-fallback-unconfigured: no unique supported fallback for ${agent}/${model}; select --tier and configure tiers.<tier>.fallback with agent and model`, 'ask-agent-fallback-unconfigured');
  // Field lesson #417: a read-only ask starts when the named model is available, fallback or
  // not. With no read-only fallback configured (no matching tier, or a tier without `fallback`),
  // the named agent itself runs the one read-only job (no outputs, nothing integrated) and the
  // result says so. A fallback that is present but malformed still refuses: that is a config bug.
  const direct = matchedTier => {
    const route = { tier: matchedTier ?? null, requestedAgent: agent, requestedModel: model, agent, model, direct: true };
    const warning = `ask-agent-direct: no read-only fallback configured for ${agent}/${model}${matchedTier ? ` (tier ${matchedTier})` : ''}; running it directly as a read-only job with no outputs`;
    return { agent, model, route, warning };
  };
  if (tier === undefined) {
    const matches = TIERS.filter(name => config?.tiers?.[name]?.agent === agent && config.tiers[name].model === model);
    if (matches.length !== 1) return direct(null);
    tier = matches[0];
  }
  const configured = config.tiers[tier];
  const fallback = configured.fallback;
  if (fallback === undefined) return direct(tier);
  if (!validPair(fallback) || Object.keys(fallback).some(key => !['agent', 'model'].includes(key)) || (fallback.agent !== 'claude' && (!API_AGENTS.includes(fallback.agent) || fallback.agent === 'rented'))) unconfigured();
  const route = { tier, requestedAgent: agent, requestedModel: model, agent: fallback.agent, model: fallback.model };
  const warning = `ask-agent-fallback: ${agent}/${model} -> ${fallback.agent}/${fallback.model} (tier ${tier}); using configured read-only fallback`;
  return { agent: fallback.agent, model: fallback.model, route, warning };
}

export { anyOutputExists, droppedBytesAt, expandJobContext, jobFinalJson, ledgerSettings, loadJobMutantsFile, loadJobResultData, outputsChanged, pendingBaseCheck, pickJobRoute, recordIntegratedHashes, recoverIntegrationJournal, repairArrayKeyValueJson, reportObject, runJobSetup, runMutant, smokeCheckInSandbox };
