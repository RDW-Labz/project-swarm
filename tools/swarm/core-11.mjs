import { findWriterConflicts, listLiveRuns, repoKey, repoPaths } from '../board.mjs';
import { assertScratchOutsideRepo, scratchRootDir } from '../claude-shell.mjs';
import { isExampleFile } from '../init-profile.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { classifyCheckEnvironment, resolveToolchainBin } from '../ship.mjs';
import { validateIdleItems } from '../spend.mjs';
import { manifestChecksHaveRepeatConstruct } from './checks.mjs';
import { parsePromptDeclaredResultKeys } from './context.mjs';
import { asObject, cappedNotes, dataclassFieldNames, digest, evidenceBlock, execFileAsync, fail, invokedProgramsFor, isDocOnlyJob, levenshteinDistance, loadLocalConfigInline, makeRunId, parseContractEventRows, parseToolchainInventory, pathContains, programOnPath, quotesRuntimeFailure, redactSecrets, reviewSourcePath, stopChild, toolchainsDir, toolchainsDirFor205 } from './core-1.mjs';
import { compareSemver, latestRunEnd, parseSemver } from './core-2.mjs';
import { nextQueuedTicketHint } from './integrate.mjs';
import { AGENT_ERROR_KEYWORDS, AGENT_LOG_BYTES, CHECK_PATH_PROGRAMS, CHECK_TAIL, FLAKY_PROMPT_RE, ID, NEXT_TASK_FILE, TMP_PREFIX_RE, UNRUNNABLE_RE } from './patterns.mjs';
import { isWorktreeWriter } from './workspace.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Field lesson #344: a contract worker's hand-written `editOutputs` surfaced a bare
// "Unknown job field" with no pointer to the real field; suggest a close known name.
function unknownJobFieldMessage(name, knownFields) {
  const lower = name.toLowerCase();
  const substringMatch = knownFields.find(field => lower.includes(field.toLowerCase()));
  const suggestion = substringMatch ?? knownFields.reduce((best, field) => {
    const distance = levenshteinDistance(lower, field.toLowerCase());
    return distance <= 3 && (!best || distance < best.distance) ? { field, distance } : best;
  }, null)?.field;
  if (!suggestion) return `Unknown job field: ${name}`;
  const note = suggestion === 'outputs' ? ` Outputs that already exist are edited in place; there is no ${name} field)` : ')';
  return `Unknown job field: ${name} (did you mean ${suggestion}?${note}`;
}

// A claim collision (the astronomically rare case the suffix above doesn't rule out) is retried
// once with a fresh id; the first id may be forced by a caller (id retry tests, or a resumed run)
// but the retry always mints a brand new one. Any other error propagates unchanged.
async function runWithIdRetry(prefix, runOptions, attempt) {
  let id = runOptions.id ?? makeRunId(prefix);
  try { return { id, ...(await attempt(id)) }; }
  catch (error) {
    if (error?.code !== 'EEXIST' || !String(error.path ?? '').endsWith(`${path.sep}claim`)) throw error;
    id = makeRunId(prefix);
    return { id, ...(await attempt(id)) };
  }
}

export function tmpToolPathWarnings(manifest, { dir = toolchainsDir() } = {}) {
  const warnings = [];
  for (const job of manifest.jobs ?? []) {
    for (const readPath of job.readPaths ?? []) {
      if (TMP_PREFIX_RE.test(readPath)) warnings.push({ code: 'tmp-tool-path', jobId: job.id, path: readPath, message: `${readPath} resolves under /tmp: macOS removes files here after 3 days unread; move it under ${dir}` });
    }
  }
  for (const check of [...(manifest.checks ?? []), ...(manifest.mutantCheck ? [manifest.mutantCheck] : [])]) {
    const program = check.argv?.[0];
    if (typeof program === 'string' && TMP_PREFIX_RE.test(program)) warnings.push({ code: 'tmp-tool-path', check: check.name ?? 'mutantCheck', path: program, message: `${program} resolves under /tmp: macOS removes files here after 3 days unread; move it under ${dir}` });
  }
  return warnings;
}

async function toolchainInventory(root, { env, home, platform, fsImpl, access }) {
  const relativeFile = 'coordination/toolchain-versions.md';
  const invalid = () => ({ rows: [], warnings: [{ code: 'toolchain-inventory-invalid', message: `toolchain-inventory-invalid: ${relativeFile}: expected binary | version | reinstall table` }] });
  const paths = platform === 'win32' ? path.win32 : path;
  const file = paths.resolve(root, 'coordination', 'toolchain-versions.md');
  let text;
  try {
    let current = paths.parse(file).root;
    const parts = paths.relative(current, file).split(paths.sep);
    for (const [index, part] of parts.entries()) {
      current = paths.join(current, part);
      const info = await fsImpl.lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.size > 1024 * 1024)) return invalid();
    }
    text = await fsImpl.readFile(file, 'utf8');
  } catch (error) { return error.code === 'ENOENT' ? null : invalid(); }
  const rows = parseToolchainInventory(text);
  if (!rows) return invalid();
  const executable = access ?? (async file => {
    if (!(await fsImpl.stat(file)).isFile()) throw Error('not a file');
    await fsImpl.access(file, fs.constants.X_OK);
  });
  const inventoryWarnings = [];
  for (const row of rows) {
    let resolvedTool;
    if (platform === 'win32') {
      const dir = env.SWARM_TOOLCHAINS || paths.join(home, '.project-swarm', 'toolchains');
      const dirs = [dir, paths.join(dir, 'bin'), ...String(env.PATH ?? '').split(';').filter(Boolean)];
      const suffixes = /\.(exe|cmd)$/i.test(row.binary) ? [''] : ['', '.exe', '.cmd'];
      resolvedTool = { path: null };
      for (const candidate of dirs.flatMap(dir => suffixes.map(suffix => paths.join(dir, row.binary + suffix)))) {
        try {
          await executable(candidate);
          resolvedTool.path = candidate;
          break;
        } catch (error) {
          const code = error?.code;
          if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') { /* next candidate */ }
          else console.error('[tools/swarm/core-11.mjs] resolve toolchain candidate:', error?.message ?? error);
        }
      }
    } else resolvedTool = await resolveToolchainBin(row.binary, { env, home, access: executable });
    row.path = resolvedTool.path;
    if (!resolvedTool.path) inventoryWarnings.push({ code: 'toolchain-missing', message: `toolchain-missing: ${row.binary} (${row.version}); reinstall: ${row.reinstall}` });
  }
  return { rows, warnings: inventoryWarnings };
}

export function runtimeCheckNoShellWarning(job, manifest = null) {
  if (isWorktreeWriter(job) || job.shell === true || isDocOnlyJob(job)) return null;
  const flagged = quotesRuntimeFailure(job.prompt) || FLAKY_PROMPT_RE.test(job.prompt) || manifestChecksHaveRepeatConstruct(manifest);
  if (!flagged) return null;
  return { code: 'runtime-check-no-shell', jobId: job.id, message: 'worker cannot reproduce; consider a shell agent or --evidence' };
}

export async function checkPathMissingWarnings(manifest, { env = process.env } = {}) {
  const warnings = [];
  const orchestratorDirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const check of manifest.checks ?? []) {
    const argv = check.argv ?? [];
    if (argv[0] !== 'env') continue;
    const pathAssignment = argv.slice(1).find(item => typeof item === 'string' && item.startsWith('PATH='));
    if (!pathAssignment) continue;
    const checkDirs = pathAssignment.slice('PATH='.length).split(path.delimiter).filter(Boolean);
    const invoked = new Set(invokedProgramsFor(argv).filter(program => CHECK_PATH_PROGRAMS.includes(program)));
    for (const program of CHECK_PATH_PROGRAMS) {
      if (!invoked.has(program)) continue;
      if (await programOnPath(program, checkDirs)) continue;
      if (await programOnPath(program, orchestratorDirs)) warnings.push({ code: 'check-path-missing', check: check.name, prog: program, message: `check-path-missing: ${check.name}: ${program}` });
    }
  }
  return warnings;
}

export function undeclaredPersistedFieldWarnings(job, parsedResult, file, beforeText, afterText) {
  if (!/\.py$/.test(file)) return [];
  const added = [...dataclassFieldNames(afterText)].filter(name => !dataclassFieldNames(beforeText).has(name));
  if (!added.length) return [];
  const declared = Array.isArray(parsedResult?.newPersistedFields) ? parsedResult.newPersistedFields : [];
  if (declared.length) return [];
  return [{ code: 'new-persisted-field-undeclared', jobId: job.id, path: file, fields: added, message: `${job.id}'s ${file} adds field(s) ${added.join(', ')} to a serialized dataclass; its result reports no newPersistedFields (name, legacyDefault, why), so a legacy record on disk with no from-disk test may silently change meaning.` }];
}

export function eventReaderNoProducerWarnings(text) {
  return parseContractEventRows(text).filter(row => !row.producer).map(row => ({
    code: 'event-reader-no-producer', event: row.event, reader: row.reader,
    message: `event-reader-no-producer: ${row.event}: contract lists reader ${row.reader} with no producer`,
  }));
}

// Field lesson #283's own refusal named the skill and the key but neither where the skill came
// from nor how to turn it off — a coordinator on a fresh project had to source-dive to learn
// either. `skillsSourceDir` defaults to '(unknown)' so an existing caller that never threads it
// through still gets a (less useful, never wrong) message instead of `undefined`.
export function dispatchResultKeysRefusal(attachedSkills, job, { skillsSourceDir = '(unknown)' } = {}) {
  const declaredKeys = parsePromptDeclaredResultKeys(job.prompt);
  for (const skill of attachedSkills) {
    if (skill.attached === 'index-only' || !skill.checks?.resultKeys?.length) continue;
    for (const key of skill.checks.resultKeys) {
      if (!declaredKeys || !declaredKeys.includes(key)) {
        const reason = skill.attachedBy ?? (skill.attached === 'named' ? 'manifest skills list' : 'paths match');
        fail(`${skill.name}: resultKeys missing ${key} (skill from ${skillsSourceDir}, attached by ${reason}; to run without these skills set "skillsDir" in the manifest to an empty directory, or declare the key in the job's "Return JSON only" shape)`);
      }
    }
  }
}

// Field lesson #208: a routing decision (a cheaper cheap-tier model) only ever landed in DECISIONS,
// never in the rulebook a model reads at boot; a claude job at tier:"cheap" while config names a
// different cheap-tier model is now flagged unless the job states why claude is used instead.
export async function cheapTierNotConfiguredModelWarnings(manifest, { env = process.env, home = os.homedir() } = {}) {
  let config;
  try { config = await loadLocalConfigInline({ home, env }); } catch { return []; }
  const cheap = config?.tiers?.cheap;
  if (!cheap || typeof cheap.model !== 'string' || !cheap.model) return [];
  const warnings = [];
  for (const job of manifest.jobs) {
    if (job.tier !== 'cheap' || job.agent !== 'claude' || job.tierReason?.trim()) continue;
    if (cheap.agent === job.agent && cheap.model === job.model) continue;
    warnings.push({ code: 'cheap-tier-not-configured-model', jobId: job.id, configuredModel: cheap.model, message: `${job.id} is tier:"cheap" on claude, but the swarm config names ${cheap.model} as the cheap tier; add tierReason to say why claude is used instead.` });
  }
  return warnings;
}

// Field lesson #225: a shell worker's sandbox does grant read access to some paths under $HOME —
// its own toolchains dir (always, when it exists) and any job.readPaths (already absolute,
// validated at manifest time) — and a check/prompt naming one of those is never actually denied.
export function shellGrantedPathPrefixes(manifest, { env = process.env, home = os.homedir() } = {}) {
  const prefixes = new Set([toolchainsDirFor205(env, home)]);
  for (const job of manifest.jobs ?? []) for (const readPath of job.readPaths ?? []) prefixes.add(readPath);
  return [...prefixes];
}

export function applyEvidence(manifest, failures) {
  const block = evidenceBlock(failures);
  if (!block) return manifest;
  return { ...manifest, jobs: manifest.jobs.map(job => ({ ...job, prompt: `${job.prompt}\n\n${block}` })) };
}

async function loadEvidenceFile(path_) {
  let raw;
  try { raw = await fs.readFile(path_, 'utf8'); } catch { fail(`Could not read evidence file: ${path_}`); }
  let data;
  try { data = JSON.parse(raw); } catch { fail(`Invalid JSON in evidence file: ${path_}`); }
  if (!Array.isArray(data?.failures)) fail(`Evidence file must contain a "failures" array: ${path_}`);
  return data.failures;
}

function relative(value, internal = false, { readOnly = false } = {}) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || /[\x00-\x1f\x7f:]/.test(value)) fail(`Invalid relative path: ${value}`);
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) fail(`Unsafe path: ${value}`);
  // A names-only template (.env.example) may be read as context, never written.
  if (!internal && !(readOnly && isExampleFile(value)) && parts.some(p => ['.git', '.swarm', '.env', '.ssh', '.aws', '.gnupg'].includes(p.toLowerCase()) || p.toLowerCase().startsWith('.env.'))) fail(`Reserved or secret path: ${value}`);
  return parts;
}

// Field lesson #161: every mutant's `find` is counted in its target before anything runs — a
// missing or duplicated find (a block copied with the wrong indentation) or a find equal to its
// replace can only ever report a meaningless result. `readText(file)` returns the target's text
// (the post-integration bytes for integrate) or null when it does not exist.
export function redundantWriterWarnings(mutants, fileTexts) {
  const texts = fileTexts instanceof Map ? fileTexts : new Map(Object.entries(fileTexts));
  const redundantWarnings = [];
  for (const mutant of mutants) {
    // Deliberately narrow: a single, qualified call with simple arguments. Aliases, dynamic
    // calls and multiline/complex syntax are unverified, never inferred as equivalent effects.
    const removed = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\([^()\n]*\)\s*;?\s*$/.exec(mutant.find);
    if (!removed) continue;
    const callee = removed[1];
    const escaped = callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const call = new RegExp(`(?<![\\w$.])${escaped}\\s*\\(`, 'g');
    if (new RegExp(`(?<![\\w$.])${escaped}\\s*\\(`).test(mutant.replace)) continue;
    const otherCalls = [];
    for (const [file, text] of texts) {
      if (!reviewSourcePath(file)) continue;
      const mutationStart = file === mutant.file ? text.indexOf(mutant.find) : -1;
      let offset = 0;
      for (const [index, line] of text.split('\n').entries()) {
        if (!/^\s*(?:\/\/|#|\/\*|\*|\*\/)/.test(line) && !/^\s*(?:export\s+)?(?:async\s+)?(?:function|def)\b/.test(line)) {
          for (const match of line.matchAll(call)) {
            const position = offset + match.index;
            if (mutationStart >= 0 && position >= mutationStart && position < mutationStart + mutant.find.length) continue;
            const location = `${file}:${index + 1}`;
            if (!otherCalls.includes(location)) otherCalls.push(location);
          }
        }
        offset += line.length + 1;
      }
    }
    if (otherCalls.length > 0) redundantWarnings.push(...otherCalls.sort().map(location => `redundant-writer: ${mutant.name} removes ${callee}; another call at ${location} may preserve the effect; target the shared store or reader`));
  }
  return redundantWarnings;
}

// Contract-producing jobs sometimes serialize the shared contract and tier metadata at the
// job level. Normalize those known shapes before the ordinary manifest checks so the persisted
// manifest still has one coordinator-owned contract and null remains the legacy "absent" value.
function normalizeManifestMetadata(manifest) {
  if (!manifest || !Array.isArray(manifest.jobs)) return manifest;
  let contract = manifest.contract;
  for (const job of manifest.jobs) {
    if (job?.contract === undefined) continue;
    if (typeof job.contract !== 'string' || !job.contract.trim()) fail(`Job ${job.id}: contract must be a relative file path`);
    if (contract !== undefined && contract !== job.contract) fail(`Job ${job.id}: contract conflicts with manifest contract`);
    contract = job.contract;
    delete job.contract;
  }
  if (contract !== undefined) manifest.contract = contract;
  for (const job of manifest.jobs) if (job?.tierReason === null) delete job.tierReason;
  return manifest;
}

function summarizeAgentFailure({ exitCode, stdout, stderr }) {
  const stderrTail = redactSecrets((stderr ?? '').slice(-AGENT_LOG_BYTES));
  const stdoutTail = redactSecrets((stdout ?? '').slice(-AGENT_LOG_BYTES));
  const lines = stderrTail.split('\n').map(line => line.trim()).filter(Boolean);
  const reason = lines.find(line => AGENT_ERROR_KEYWORDS.test(line)) ?? lines.at(-1) ?? 'no stderr output';
  const agentError = `exit ${exitCode ?? 'null'}: ${reason}`.slice(0, 300);
  const tail = `--- stderr (last ${AGENT_LOG_BYTES} bytes) ---\n${stderrTail}\n--- stdout (last ${AGENT_LOG_BYTES} bytes) ---\n${stdoutTail}\n`;
  return { agentError, tail };
}

// T86: the one place a job worktree path is derived from a run id; every reader goes through it.
function expectedWorkspaceFor(id, jobId, record) {
  const attempt = record.workspaceAttempt ?? (record.attempts?.length || 1);
  if (!Number.isSafeInteger(attempt) || attempt < 1) fail('Worker metadata does not match manifest');
  return attempt === 1 ? `.swarm/workspaces/${id}/${jobId}` : `.swarm/workspaces/${id}/.attempts/${jobId}/${attempt}`;
}

export async function worktreesBaseFor(root, config = {}, { env = process.env } = {}) {
  const configured = config.worktreesDir;
  if (configured !== undefined && (typeof configured !== 'string' || !path.isAbsolute(configured))) fail('config worktreesDir must be an absolute path');
  const base = configured ?? path.join(scratchRootDir({ env }), 'worktrees');
  await fs.mkdir(base, { recursive: true });
  const realBase = await fs.realpath(base);
  await assertScratchOutsideRepo(realBase, file => fs.access(file));
  const realRoot = await fs.realpath(root);
  return path.join(realBase, `${path.basename(realRoot).replace(/[^A-Za-z0-9._-]/g, '_')}-${digest(realRoot).slice(0, 12)}`);
}

// One live-output scan is shared by validate and run. The legacy board compares exact repository
// paths; open-scope jobs additionally reserve parent/child path collisions, just as run has always
// done. Keeping that policy here prevents validate from approving a launch that run will refuse.
async function liveOutputConflicts(root, jobs, { runId, liveDir, isAlive, runs } = {}) {
  const outputs = jobs.flatMap(job => job.outputs ?? []);
  let conflicts = await findWriterConflicts({ runId, root, outputs, dir: liveDir, isAlive, runs });
  if (!jobs.some(job => job.scope === 'open')) return conflicts;
  const repo = await repoKey(root);
  const files = (await repoPaths(root, outputs)).map(file => file.toLowerCase());
  for (const run of runs ?? await listLiveRuns({ dir: liveDir, isAlive })) {
    if (run.runId === runId || run.repo !== repo || conflicts.some(conflict => conflict.runId === run.runId)) continue;
    const shared = run.files.filter(file => files.some(own => pathContains(own, file.toLowerCase()) || pathContains(file.toLowerCase(), own)));
    if (shared.length) conflicts.push({ runId: run.runId, root: run.root, files: shared });
  }
  return conflicts;
}

export async function cursorClaimConflicts(root, jobs) {
  const file = 'coordination/cursor-claims.json';
  const invalid = reason => fail(`cursor-claims-invalid: ${file} ${reason}`, 'cursor-claims-invalid');
  let text;
  try { text = await fs.readFile(path.join(root, file), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    invalid(`cannot read (${error.code ?? 'unknown error'})`);
  }
  let claims;
  try { claims = JSON.parse(text); } catch { invalid('contains malformed JSON'); }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(claims)) invalid('must be an object');
  const conflicts = [];
  for (const claim of Object.keys(claims).sort()) {
    const entry = claims[claim];
    if (!object(entry) || !Array.isArray(entry.files) || entry.files.some(file => typeof file !== 'string') || typeof entry.base !== 'string') invalid(`has an invalid entry for ${claim}`);
    const files = new Set(), jobIds = new Set();
    for (const job of jobs) {
      for (const file of entry.files) {
        if (!(job.outputs ?? []).some(output => output === file || (job.scope === 'open' && (pathContains(output, file) || pathContains(file, output))))) continue;
        files.add(file);
        jobIds.add(job.id);
      }
    }
    if (files.size) conflicts.push({ claim, files: [...files].sort(), jobIds: [...jobIds].sort() });
  }
  return conflicts;
}

function selectRunManifest(manifest, jobs) {
  if (jobs === null || jobs === undefined) return manifest;
  if (!Array.isArray(jobs) || !jobs.length || jobs.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(jobs).size !== jobs.length) fail('--jobs requires a non-empty list of unique job ids');
  const wanted = new Set(jobs.map(id => id.toLowerCase()));
  const selected = manifest.jobs.filter(job => wanted.has(job.id.toLowerCase()));
  if (selected.length !== jobs.length) {
    const missing = jobs.filter(id => !manifest.jobs.some(job => job.id.toLowerCase() === id.toLowerCase()));
    fail(`--jobs names unknown job id: ${missing.join(', ')}`);
  }
  return { ...manifest, jobs: selected };
}

function validateRunIdle(items) {
  validateIdleItems(items);
  for (const item of items) for (const key of Object.keys(item)) {
    if (!['name', 'argv', 'timeoutMs'].includes(key)) fail(`idle-invalid: unknown field ${key}`, 'idle-invalid');
  }
}

const tryObject = text => { try { return asObject(JSON.parse(text)); } catch { return null; } };

const displayResult = value => !value ? null : !Array.isArray(value.notes) ? value : { ...value, notes: cappedNotes(value) };

export function runCheck(name, argv, cwd, timeoutMs, spawnImpl, characterTail = false, onOutput = () => {}, env = process.env, { cancelled, killImpl, ignoreSwarmPaths = false } = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    let chunks = [], size = 0, settled = false, child, timer, poll, reason, termination;
    let headBytes = Buffer.alloc(0), headDone = false;
    let swarmLineCount = 0, hasOtherOutput = false;
    let pendingLine = Buffer.alloc(0);
    // Redcheck promises characters; existing integration checks promise bytes.
    const retainedBytes = characterTail ? CHECK_TAIL * 4 : CHECK_TAIL;
    // Bound retained memory while keeping enough data for the requested tail.
    const push = data => {
      if (!headDone) {
        headBytes = Buffer.concat([headBytes, data]);
        let offset = -1;
        for (let line = 0; line < 3; line++) { offset = headBytes.indexOf(10, offset + 1); if (offset === -1) break; }
        if (offset !== -1) { headBytes = headBytes.subarray(0, offset); headDone = true; }
      }
      onOutput(data);
      chunks.push(data); size += data.length;
      while (chunks.length > 1 && size - chunks[0].length >= retainedBytes) size -= chunks.shift().length;
    };
    // Count every line before tail truncation, preserving the existing combined stream order.
    const filteredLine = line => {
      const text = line.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').trimStart();
      if (ignoreSwarmPaths && (text.startsWith('.swarm/') || text.startsWith(path.join(cwd, '.swarm') + path.sep))) {
        swarmLineCount++;
        return;
      }
      if (text.trim()) hasOtherOutput = true;
      push(line);
    };
    const receive = data => {
      if (!ignoreSwarmPaths) { push(data); return; }
      let pending = Buffer.concat([pendingLine, data]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) { filteredLine(pending.subarray(0, end + 1)); pending = pending.subarray(end + 1); }
      pendingLine = pending;
    };
    // Field lesson 139: a check's own child may itself spawn descendants (a test harness, a
    // bundler); stopChild kills the whole group it leads, the same guarantee execute() already
    // gives the worker's own process. finish() below always awaits it before resolving, so this
    // promise only settles once that group is confirmed gone — never merely "signal sent".
    const stop = why => { if (reason || settled) return; reason = why; termination = stopChild(child, { killImpl }); termination.then(cleanup => { if (cleanup.error) finish('failed', null); }); };
    // Field lesson 134/138/152: a check that never started at all (Node could not spawn its own
    // argv[0]) is a distinct, more basic failure than one whose own binary/module could not be
    // found after something did start (exit 127, or "command not found"/ERR_MODULE_NOT_FOUND in
    // its own output) — which is itself distinct from a real pass/fail.
    const finish = async (status, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(poll);
      const cleanup = await (termination ?? Promise.resolve({ error: null }));
      if (pendingLine.length) filteredLine(pendingLine);
      const combined = Buffer.concat(chunks);
      const tail = characterTail ? combined.toString('utf8').slice(-CHECK_TAIL) : combined.length > CHECK_TAIL ? combined.subarray(combined.length - CHECK_TAIL).toString('utf8') : combined.toString('utf8');
      // reason is recorded synchronously in stop(), before any signal is ever sent, so it always
      // reflects whether a cancel/timeout was requested prior to this exit; it must outrank a
      // cleanup-probe error (which only means "couldn't confirm the group is gone", not that the
      // requested cancel/timeout didn't happen) or a same-tick close/exit event would misreport a
      // real cancellation as a plain failure.
      const head = headBytes.toString('utf8').replaceAll('\r\n', '\n').replace(/\r$/, '').split('\n').slice(0, 3).join('\n');
      if (ignoreSwarmPaths && swarmLineCount > 0 && !hasOtherOutput && status === 'failed' && exitCode > 0 && exitCode !== 127) status = 'passed';
      const environment = !reason && !cleanup.error ? classifyCheckEnvironment({ exitCode, head }) : null;
      const finalStatus = reason === 'timeout' ? 'timeout' : reason === 'cancelled' ? 'cancelled' : cleanup.error ? 'cleanup-failed'
        : environment ? 'check-env-missing' : status === 'failed' && UNRUNNABLE_RE.test(tail) ? 'unrunnable' : status;
      const hint = finalStatus === 'spawn-error' ? `could not start ${argv[0]}: pass the test command as separate argv tokens`
        : finalStatus === 'unrunnable' ? `${argv[0]} could not run (missing tool/module): try npm ci --offline or uv sync --offline`
        : undefined;
      resolve({ name, status: finalStatus, exitCode, durationMs: Date.now() - start, tail, head, ...(swarmLineCount ? { swarmLineCount } : {}), ...(hint ? { hint } : {}), ...(environment ?? {}) });
    };
    try {
      const [program, ...rest] = argv;
      child = spawnImpl(program, rest, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env });
      child.on('error', () => finish('spawn-error', null));
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => receive(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      child.on('close', code => finish(code === 0 ? 'passed' : 'failed', code));
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      if (cancelled) poll = setInterval(async () => { try { if (!settled && await cancelled()) stop('cancelled'); } catch { stop('cancelled'); } }, 100);
    } catch { finish('spawn-error', null); }
  });
}

// A mutants source read as plain JSON, either shape: a bare array or `{mutants:[...]}`.
function readMutantsSource(label, data) {
  const mutants = Array.isArray(data) ? data : Array.isArray(data?.mutants) ? data.mutants : null;
  if (!mutants) fail(`Mutants file must be a JSON array or {mutants:[...]}: ${label}`);
  return mutants;
}

function parseMutantCheckFlag(value) {
  let argv;
  try { argv = JSON.parse(value); } catch { fail('--mutant-check requires a JSON array of argv strings'); }
  if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string')) fail('--mutant-check requires a JSON array of argv strings');
  return { argv };
}

function validateQueueOptions({ batchSize = 10, maxRequeues = 2, jobs, salvage, mutants, mutantsFile, mutantCheck }) {
  mutants ||= mutantsFile !== undefined || mutantCheck !== undefined;
  for (const [flag, enabled] of [['--jobs', jobs !== undefined && jobs !== null], ['--salvage', salvage], ['--mutants', mutants]]) {
    if (enabled) fail(`queue-flag-unsupported: ${flag} cannot be combined with --queue`, 'queue-flag-unsupported');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) fail('queue-batch-invalid: batchSize must be an integer 1-100', 'queue-batch-invalid');
  if (!Number.isInteger(maxRequeues) || maxRequeues < 0 || maxRequeues > 5) fail('queue-requeues-invalid: maxRequeues must be an integer 0-5', 'queue-requeues-invalid');
}

const securityExec = async (argv, { cwd, timeoutMs = 120000, env } = {}) => {
  try { const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, ...(env ? { env } : {}) }); return { exitCode: 0, stdout, stderr }; }
  catch (error) { if (error.code === 'ENOENT') throw error; return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
};

export async function noJobRunningWarning({ root, env = process.env, home = os.homedir(), dir, isAlive, now = () => Date.now(), taskFile } = {}) {
  let config; try { config = loadLocalConfig({ env, home }); } catch { config = {}; }
  const configured = Array.isArray(config?.metrics?.roots) ? config.metrics.roots.filter(entry => typeof entry === 'string' && entry) : [];
  const roots = (configured.length ? configured : [root]).map(entry => path.resolve(entry));
  const activeRoots = new Set(roots);
  for (const run of await listLiveRuns({ dir, isAlive })) {
    let realRoot; try { realRoot = await fs.realpath(run.root); } catch { realRoot = run.root; }
    if (activeRoots.has(path.resolve(realRoot))) return null;
  }
  const latest = await latestRunEnd(roots);
  const idleMinutes = latest ? Math.round(((now() - Date.parse(latest)) / 60000) * 10) / 10 : null;
  // Field lesson #227: an idle gap with only next-seat work queued is worth a hint to start that
  // work's first (read-only) step, instead of running no job at all during the hand steps.
  let hint = null;
  try {
    const text = await fs.readFile(taskFile ?? path.join(root, NEXT_TASK_FILE), 'utf8');
    const ticket = nextQueuedTicketHint(text);
    if (ticket) hint = `swarm next --from ${NEXT_TASK_FILE}: ${ticket.id} — ${ticket.step}`;
  } catch (error) {
    if (error?.code === 'ENOENT') { /* no TASK.md, or nothing queued: no hint */ }
    else console.error('[tools/swarm/core-11.mjs] read TASK.md hint:', error?.message ?? error);
  }
  return { code: 'no-job-running', idleMinutes, ...(hint ? { hint } : {}), message: `no-job-running: no run under the configured root(s) is active${idleMinutes !== null ? ` (idle ${idleMinutes} min)` : ''}${hint ? `; ${hint}` : ''}` };
}

function highestSemver(tags){
  let best=null,bestParsed=null;
  for(const tag of tags){const parsed=parseSemver(tag);if(parsed&&(!bestParsed||compareSemver(parsed,bestParsed)>0)){best=tag;bestParsed=parsed;}}
  return best;
}

export { displayResult, expectedWorkspaceFor, highestSemver, liveOutputConflicts, loadEvidenceFile, normalizeManifestMetadata, parseMutantCheckFlag, readMutantsSource, relative, runWithIdRetry, securityExec, selectRunManifest, summarizeAgentFailure, toolchainInventory, tryObject, unknownJobFieldMessage, validateQueueOptions, validateRunIdle };
