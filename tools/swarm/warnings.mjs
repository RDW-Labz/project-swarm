import { listLiveRuns, repoKey, repoPaths } from '../board.mjs';
import { resolveRigServicePort } from '../claude-shell.mjs';
import { isDesignOnlyCodexJob } from '../codex-adapter.mjs';
import { isTestFile } from '../context-check.mjs';
import { loadLocalConfig } from '../local-config.mjs';
import { anyPathMatchesGlobs } from '../skills.mjs';
import { COMMIT_WORD_RE, COMPARISON_LINE_RE, DATE_WINDOW_RE, ENV_RESYNC_TRIGGER_NAMES, FULL_SUITE_RE, JS_SET_TIMEOUT_RE, JS_WAITFOR_TIMEOUT_RE, MODEL_ROUTE_FILE_RE, MODEL_ROUTE_SMOKE_CHECK_RE, MUTANT_COVERED_SOURCE_RE, MUTANTS_FILENAME_RE, NON_UTC_ZONE_RE, PY_TIMEOUT_KWARG_RE, PYTHON_TOOL_RE, SWARM_DIR_IGNORE_CONFIGS, TESTS_PATH_RE } from './patterns.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function shellPythonNoSetupWarning(job, manifest) {
  if (job.shell !== true || job.setup?.length) return null;
  const checksText = (manifest?.checks ?? []).map(check => (check.argv ?? []).join(' ')).join(' ');
  if (!PYTHON_TOOL_RE.test(checksText) && !PYTHON_TOOL_RE.test(job.prompt ?? '')) return null;
  return { code: 'shell-python-no-setup', jobId: job.id, message: `shell-python-no-setup: ${job.id}` };
}

export function tightTestTimeoutWarnings(job, files) {
  const warnings = [];
  for (const file of job.outputs ?? []) {
    if (!isTestFile(file)) continue;
    const text = files.get(file);
    if (typeof text !== 'string') continue;
    for (const [re, limit] of [[PY_TIMEOUT_KWARG_RE, 5], [JS_SET_TIMEOUT_RE, 5000], [JS_WAITFOR_TIMEOUT_RE, 5000]]) {
      for (const match of text.matchAll(re)) {
        if (Number(match[1]) < limit) warnings.push({ code: 'tight-test-timeout', jobId: job.id, path: file, message: `${file}: timeout literal ${match[1]} is under the ${limit >= 1000 ? `${limit / 1000}s` : `${limit}s`} hang-guard floor (lesson #149)` });
      }
    }
  }
  return warnings;
}

export function testsWithoutShellWarning(job) {
  if (job.agent !== 'claude' || job.shell === true || !(job.outputs ?? []).some(file => TESTS_PATH_RE.test(file))) return null;
  return { code: 'tests-without-shell', jobId: job.id, message: `Job ${job.id} adds tests without shell: the worker cannot run them (lesson #135)` };
}

export function undeclaredMutantsFileWarnings(job) {
  const warnings = [];
  for (const file of job.outputs ?? []) {
    if (MUTANTS_FILENAME_RE.test(path.basename(file)) && job.mutantsFile !== file) {
      warnings.push({ code: 'mutants-file-undeclared', jobId: job.id, path: file, message: `${file} looks like a mutants file but is not this job's declared mutantsFile; its shape ({name,file,find,replace}) is only checked once integrate reads it` });
    }
  }
  return warnings;
}

export function utcOnlyWindowTestWarning(job, fileTexts) {
  const touchesDateWindow = (job.outputs ?? []).some(file => !isTestFile(file) && DATE_WINDOW_RE.test(fileTexts.get(file) ?? ''));
  if (!touchesDateWindow) return null;
  const jobFiles = [...(job.context ?? []), ...(job.outputs ?? [])];
  const hasNonUtcTest = jobFiles.some(file => isTestFile(file) && NON_UTC_ZONE_RE.test(fileTexts.get(file) ?? ''));
  if (hasNonUtcTest) return null;
  return { code: 'utc-only-window-tests', jobId: job.id, message: `${job.id}: outputs touch a date-window comparison (date()/astimezone(UTC)/timezone.utc) but no test in its context/outputs mentions a non-UTC zone (lesson #235)` };
}

export function workFolderContextWarnings(job, context) {
  const documentation = file => /\.(?:md|rst|txt|adoc)$/i.test(file);
  const build = (job.outputs ?? []).some(file => !documentation(file) && !(/^docs\//.test(file) && /\.json$/i.test(file)));
  if (!build) return [];
  return [...new Set(context)].filter(file => file.startsWith('docs/_swarm/') && !documentation(file)).map(file => ({
    code: 'work-folder-context', jobId: job.id, path: file,
    message: `work-folder-context: Job ${job.id} includes ${file} as non-documentation scratch input; copy required runtime or test data into tracked tests/fixtures files`,
  }));
}

// Field lesson #282: a configured `privateData.paths` glob list (local config) names paths whose
// context/outputs are sensitive enough that a job touching them must opt out of its own transcript
// landing on disk (`privateData: true`) — otherwise refused before any worker ever starts.
export function privateDataRequiredWarning(job, context, config) {
  const paths = config?.privateData?.paths;
  if (!Array.isArray(paths) || !paths.length || job.privateData === true) return null;
  const files = [...context, ...job.outputs];
  if (!anyPathMatchesGlobs(paths, files)) return null;
  return { code: 'privateData-required', jobId: job.id, message: `privateData-required: Job ${job.id} touches a configured private path without privateData: true` };
}

export function linkedWorktreeCommitWarning(rootGitInfo, job) {
  if (job.agent !== 'claude' || job.shell !== true || !COMMIT_WORD_RE.test(job.prompt ?? '')) return null;
  if (!rootGitInfo || rootGitInfo.kind !== 'file') return null;
  return { code: 'linked-worktree-commit', jobId: job.id, message: `linked-worktree-commit: Job ${job.id}'s prompt asks it to commit; this root is a linked worktree, so its sandbox now grants write access to ${rootGitInfo.gitDir} for that to succeed` };
}

// Field lesson #165: parallel slices — separate open runs of this same repo, each in its own
// worktree/branch — that both list one output file each rebase against their own stale copy of
// it; a hand union-merge of the two independent results can break the file's own syntax. `run`
// already hard-refuses an *exact* live collision (see `findWriterConflicts`, above); this instead
// warns at `validate` time, earlier and non-fatally, for the manifest about to be validated
// against every other run this repo already has open (a manifest whose own two jobs share one
// output file is refused outright by `validateManifest`'s own writer-collision check, so that
// case can never reach here).
export async function sharedOutputAcrossOpenJobsWarnings(root, manifest, { liveDir, isAlive } = {}) {
  const outputs = manifest.jobs.flatMap(job => job.outputs ?? []);
  if (!outputs.length) return [];
  let liveRuns;
  try { liveRuns = await listLiveRuns({ dir: liveDir, isAlive }); } catch { return []; }
  if (!liveRuns.length) return [];
  const repo = await repoKey(root);
  const openElsewhere = liveRuns.filter(run => run.repo === repo);
  if (!openElsewhere.length) return [];
  const files = await repoPaths(root, outputs);
  const runsByFile = new Map();
  for (const run of openElsewhere) {
    const runFiles = new Set(run.files);
    for (const file of files) {
      if (!runFiles.has(file)) continue;
      if (!runsByFile.has(file)) runsByFile.set(file, new Set());
      runsByFile.get(file).add(run.runId);
    }
  }
  const warnings = [];
  for (const [file, runIds] of runsByFile) {
    const others = [...runIds];
    warnings.push({ code: 'shared-output-across-open-jobs', path: file, runIds: others, message: `${file} is also an output of already-open run(s) ${others.join(', ')} in this repository; two open jobs each working from their own copy of one shared file collide on the next rebase or integrate (a hand union-merge of the two can break its syntax) — give each its own per-job fragment file and combine them in a later step instead.` });
  }
  return warnings;
}

// Field lesson 127/148: surfaced at validate time (before any job even runs) whenever a job's own
// outputs include one of these files and the manifest declares no preChecks to resync with.
export function staleEnvRiskWarning(manifest, job) {
  if (manifest.preChecks?.length) return null;
  const hit = (job.outputs ?? []).find(file => ENV_RESYNC_TRIGGER_NAMES.has(path.basename(file)));
  if (!hit) return null;
  return { code: 'stale-env-risk', jobId: job.id, path: hit, message: `${job.id} outputs ${hit}; the manifest declares no preChecks to resync the environment before checks run` };
}

export function sharedRootFullSuiteWarnings(manifest) {
  const matches = manifest.jobs.filter(job => job.shell === true && FULL_SUITE_RE.test(job.prompt ?? ''));
  if (matches.length < 2) return [];
  return [{ code: 'shared-root-full-suite', jobIds: matches.map(job => job.id), message: `${matches.length} shell jobs in this manifest each ask for "the full suite" in one prompt while sharing one root; two full suites (plus sandboxing) competing on one machine is how a job spends its own timeout sleep-polling its own background run — ask each job to run only its own new/changed test files and run the full suite once, at integrate.` }];
}

export function mutantMissingForChangedFileWarnings(changedFiles, mutants) {
  const covered = new Set((mutants ?? []).map(mutant => mutant.file));
  return [...new Set(changedFiles ?? [])]
    .filter(file => MUTANT_COVERED_SOURCE_RE.test(file) && !isTestFile(file) && !covered.has(file))
    .sort()
    .map(file => `mutant-missing-for-changed-file: ${file}`);
}

export function mutantMissingForComparisonLineWarnings(writes, mutants) {
  const warnings = [];
  for (const change of writes) {
    if (!MUTANT_COVERED_SOURCE_RE.test(change.file) || isTestFile(change.file) || change.bytes === null) continue;
    const fileMutants = (mutants ?? []).filter(mutant => mutant.file === change.file);
    const previousLines = new Set((change.previous?.toString('utf8') ?? '').split('\n'));
    const lines = change.bytes.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!COMPARISON_LINE_RE.test(line) || previousLines.has(line)) continue;
      if (!fileMutants.some(mutant => line.includes(mutant.find))) warnings.push(`mutant-missing-for-comparison: ${change.file}:${i + 1}`);
    }
  }
  return warnings;
}

export function narrowOutputScopeWarning(job) {
  return job.outputs.length < 3 && /touch only/i.test(job.prompt)
    ? { code: 'narrow-output-scope', jobId: job.id, message: `narrow-output-scope: Job ${job.id} says touch only with fewer than three outputs; include every plausible file or use scope open with outputDirs` }
    : null;
}

// Lesson #46: surfaced to the coordinator without failing the job, since a mismatch is evidence
// about what ran, not proof the work is wrong.
const modelMismatchWarnings = state => state.jobs.filter(job => job.modelMismatch).map(job => `model mismatch: ${job.id} asked ${job.model}, ran ${job.actualModel}`);

// Lesson #64: a job that only completed through the result-file or worktree fallback surfaces
// which one, since its envelope was reconstructed rather than reported.
const codexEnvelopeFallbackWarnings = state => state.jobs.filter(job => job.envelopeFallback).map(job => `codex envelope fallback: ${job.envelopeFallback} (${job.id})`);

const permissionDenialWarnings = state => state.jobs.flatMap(job => (job.permissionDenials ?? []).map(denial => {
  const input = denial?.tool_input ?? denial?.input ?? '';
  const detail = input?.file_path ?? input?.path ?? (typeof input === 'string' ? input : JSON.stringify(input));
  return `permission denials: ${job.id}: ${denial?.tool_name ?? denial?.tool ?? 'unknown'} ${detail}`.replace(/[\r\n]/g, ' ').slice(0, 200);
}));

// Field lesson 122: shown by inspect/wait so a bad JSON output is visible before integrate ever
// tries to read it (e.g. as a mutants source).
const invalidJsonOutputWarnings = state => state.jobs.flatMap(job => (job.invalidJsonOutputs ?? []).map(file => `output-invalid-json: ${file}`));

// Field lesson 37: a worker edit that lands outside its declared outputs is silently discarded at
// integrate time; surfaced here (workspace-diff based) so `inspect`/`integrate` show it up front.
// Field lesson 157: a shell job's worktree diff can tell a brand-new stray file from a modified
// one (droppedWritesNew, populated only there); a non-shell job's copied workspace never carries
// that distinction, so job.droppedWritesNew stays undefined and the message is unchanged.
const droppedWriteWarnings = state => state.jobs.flatMap(job => (job.droppedWrites ?? []).map(file => `dropped write: ${file}${(job.droppedWritesNew ?? []).includes(file) ? ' (new)' : ''} (not in outputs)`));

// Field lesson #142: a synced venv's own interpreter directory lived under $HOME but inside a
// denied subtree (e.g. `~/.ssh`); surfaced, never fatal, since the worker may not need it anyway.
const venvInterpreterWarnings = state => state.jobs.flatMap(job => job.venvInterpreterDenied ?? []);

// Field lesson #252: a transcript existed (real usage lines) but named a model this rate table
// does not recognize — costUsd stays null, but that absence is worth a warning, not silence.
const costRateUnknownWarnings = state => state.jobs.filter(job => job.costWarning).map(job => job.costWarning);

// Field lesson #268: a red base this run auto-accepted (every failing location already covered by
// its own declared outputs) is never silent — surfaced the same way any other run-level warning is.
const redBaseAutoAcceptWarnings = state => state.redBaseAutoAccept ? [state.redBaseAutoAccept] : [];

const runWarnings = (state, extra = []) => [...modelMismatchWarnings(state), ...codexEnvelopeFallbackWarnings(state), ...permissionDenialWarnings(state), ...invalidJsonOutputWarnings(state), ...droppedWriteWarnings(state), ...venvInterpreterWarnings(state), ...costRateUnknownWarnings(state), ...redBaseAutoAcceptWarnings(state), ...state.jobs.filter(job => job.reportReaskRestored?.length).map(job => `report-reask-restored: ${job.id}: ${job.reportReaskRestored.join(', ')}`), ...(state.spendWarnings ?? []), ...extra];

function killedByMismatchWarnings(results) {
  const warnings = [];
  for (const result of results) {
    if (result.killedBy === undefined) continue;
    const claimed = Array.isArray(result.killedBy) ? result.killedBy : [result.killedBy];
    if (result.status !== 'killed') { warnings.push(`killedBy mismatch: mutant ${JSON.stringify(result.name)} claimed ${claimed.join(', ')} but was not killed (status: ${result.status})`); continue; }
    const unmatched = claimed.filter(name => !(result.tail ?? '').includes(name));
    if (unmatched.length) warnings.push(`killedBy mismatch: mutant ${JSON.stringify(result.name)} claimed ${unmatched.join(', ')}, not found among the tests that actually failed`);
  }
  return warnings;
}

function journalWarning(recovered) {
  return `integrate-journal-rolled-back: run ${recovered.runId} ${recovered.kind} jobs ${recovered.jobs.join(',')} restored ${recovered.files} files`;
}

// Field lesson #265: never change HEAD in a live checkout by hand; swarm's own worktree helpers
// never touch a live checkout's HEAD at all, so the nearest hook is a standing warning naming a
// root a live service (rig-service) is actually running from, reusing the existing
// `rig.portFile` config/probe instead of inventing a new config nobody would keep in sync.
export async function liveServiceCheckoutWarning(root, { config, env = process.env, home = os.homedir() } = {}) {
  const cfg = config ?? loadLocalConfig({ env, home });
  const port = await resolveRigServicePort({ config: cfg, env, home });
  if (port === null) return null;
  return { code: 'protected-checkout-live-service', message: `protected-checkout-live-service: ${root} has a live rig service on port ${port}; never run git checkout/reset/stash here by hand — worktrees only` };
}

export async function swarmDirNotIgnoredWarning(root) {
  const found = [];
  for (const file of SWARM_DIR_IGNORE_CONFIGS) {
    let text;
    try { text = (await fs.readFile(path.join(root, file), 'utf8')); } catch { continue; }
    if (file === 'pyproject.toml' && !text.includes('[tool.pytest')) continue;
    if (text.includes('.swarm')) return null;
    found.push(file);
  }
  return found.length ? `swarm-dir-not-ignored: ${found.join(', ')} never names .swarm/; job worktrees under .swarm/runs/ may be linted or collected` : null;
}

// Field lesson #196: a job's own worktree only ever gets its declared context (or a file git
// already tracks); a file git does not track sitting next to a declared context file (a build
// artifact dropped there by hand, outside the job's own outputs) is silently left behind, and the
// job discovers the gap only once it is already running. `tracked` is the same project-wide
// tracked-file list validateProject already computes once per call.
async function contextSiblingUntrackedWarnings(root, job, tracked) {
  const context = new Set(job.context ?? []);
  const dirs = new Set([...context].map(file => path.posix.dirname(String(file).replace(/\\/g, '/'))));
  const warnings = [];
  for (const dir of dirs) {
    let entries;
    try { entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    const found = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (context.has(rel) || tracked.has(rel)) continue;
      found.push(rel);
    }
    if (!found.length) continue;
    found.sort();
    const shown = [];
    for (const file of found.slice(0, 5)) {
      let binary = false;
      try { binary = (await fs.readFile(path.join(root, file))).subarray(0, 8000).includes(0); } catch { /* unreadable: report as text */ }
      shown.push(binary ? `${file} (binary)` : file);
    }
    const more = found.length - shown.length;
    warnings.push({
      code: 'context-sibling-untracked',
      jobId: job.id,
      dir,
      files: shown,
      message: `job ${job.id}'s context directory ${dir} has untracked file(s) not in context: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`,
    });
  }
  return warnings.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

export function modelRouteChangeNoSmokeTestWarning(manifest, job) {
  const changed = (job.outputs ?? []).filter(file => MODEL_ROUTE_FILE_RE.test(file));
  if (!changed.length) return null;
  const hasSmokeCheck = (manifest.checks ?? []).some(check => check.name === 'model-route-smoke' || check.argv.some(arg => MODEL_ROUTE_SMOKE_CHECK_RE.test(arg)));
  if (hasSmokeCheck) return null;
  return { code: 'model-route-no-smoke-test', jobId: job.id, files: changed, message: `model-route-no-smoke-test: Job ${job.id} changes ${changed.join(', ')}; declare a check named model-route-smoke (or an argv containing model-route-smoke/streaming-smoke) that sends one real streaming message through the project's own client before this route change lands` };
}

export function designOnlyBlockedOnTestWarning(job, result) {
  return isDesignOnlyCodexJob(job) && result?.status === 'blocked' && /\btests?\b/i.test(JSON.stringify(result.notes ?? ''))
    ? { code: 'design-only-blocked-on-test', jobId: job.id, message: `design-only-blocked-on-test: Job ${job.id} blocked on a test in a design-only job` }
    : null;
}

export { codexEnvelopeFallbackWarnings, contextSiblingUntrackedWarnings, costRateUnknownWarnings, droppedWriteWarnings, invalidJsonOutputWarnings, journalWarning, killedByMismatchWarnings, modelMismatchWarnings, permissionDenialWarnings, redBaseAutoAcceptWarnings, runWarnings, venvInterpreterWarnings };
