// SPDX-License-Identifier: Apache-2.0
// Advisory task sizing. This module neither starts workers nor changes a manifest.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateManifest, validateProject } from './swarm.mjs';

const execFileAsync = promisify(execFile);

export const PREFLIGHT_THRESHOLDS = Object.freeze({ outputs: 5, contextBytes: 160 * 1024 });
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

// Field lesson 129: a check's manifest argv (e.g. `python3 -m pytest`) can hit whatever
// interpreter happens to be on PATH; if that interpreter or module is missing, the failure is
// only discovered once integrate runs the check for real. Resolving argv[0] must skip past any
// `env VAR=... ` prefix tokens, since those are not the program being run.
export const PROBE_TIMEOUT_MS = 3000;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PYTHON_BIN_RE = /^python3?$/;

export function resolveCheckProbe(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  let i = 0;
  if (argv[0] === 'env') {
    i = 1;
    while (i < argv.length && ENV_ASSIGN_RE.test(argv[i])) i += 1;
  }
  if (i >= argv.length) return null;
  const program = argv[i];
  // A `python3 -m X` form (direct, or wrapped by `uv run ...`) is probed by importing the
  // module, not merely by checking the interpreter starts; every other form probes `--version`.
  for (let m = i + 1; m < argv.length - 1; m += 1) {
    if (argv[m] === '-m' && PYTHON_BIN_RE.test(path.basename(argv[m - 1])) && !argv[m + 1].startsWith('-')) {
      return { program: argv[m - 1], module: argv[m + 1], kind: 'module', probeArgv: [...argv.slice(i, m), '-c', `import ${argv[m + 1]}`] };
    }
  }
  return { program, kind: 'interpreter', probeArgv: [program, '--version'] };
}

async function defaultProbeExec(probeArgv, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  await execFileAsync(probeArgv[0], probeArgv.slice(1), { timeout: timeoutMs, encoding: 'utf8' });
}

export function describeProbeFailure(failure) {
  return failure.kind === 'module'
    ? `check "${failure.check}" needs Python module ${failure.module} (via ${failure.program}), which could not be imported`
    : `check "${failure.check}" needs ${failure.program}, which was not found`;
}

// One probe per distinct resolved probe command (not per check), so two checks sharing an
// interpreter+module pair cost a single spawn; `exec` is an injectable seam so tests never need
// a real interpreter on PATH.
export async function probeCheckInterpreters(manifest, { exec = defaultProbeExec, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const checks = [
    ...(manifest.checks ?? []).map(check => ({ check: check.name ?? check.argv.join(' '), argv: check.argv })),
    ...(manifest.mutantCheck ? [{ check: 'mutantCheck', argv: manifest.mutantCheck.argv }] : []),
    ...(manifest.preChecks ?? []).map((argv, index) => ({ check: `preCheck-${index + 1}`, argv })),
  ];
  const cache = new Map();
  const failures = [];
  for (const { check, argv } of checks) {
    const resolved = resolveCheckProbe(argv);
    if (!resolved) continue;
    const key = JSON.stringify(resolved.probeArgv);
    if (!cache.has(key)) {
      cache.set(key, exec(resolved.probeArgv, { timeoutMs }).then(() => null, error => ({
        kind: resolved.kind, program: resolved.program, module: resolved.module ?? null,
        error: error?.message ?? String(error),
      })));
    }
    const result = await cache.get(key);
    if (result) failures.push({ check, ...result });
  }
  return failures;
}

export async function preflightProject(root, manifest, { exec, timeoutMs } = {}) {
  validateManifest(manifest);
  const probeFailures = await probeCheckInterpreters(manifest, { ...(exec ? { exec } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  if (probeFailures.length) {
    throw Object.assign(new Error(`Check interpreter probe failed: ${probeFailures.map(describeProbeFailure).join('; ')}`), { details: { probeFailures } });
  }
  // Use the same guarded reads as execution. Do not follow validation with a
  // second, unguarded filesystem walk merely to gather size information.
  const validated = await validateProject(root, manifest);
  const advisories = [...validated.warnings, ...await projectToolWarnings(root)];
  const copies = new Map();
  const jobs = validated.jobs.map((checked, index) => {
    const job = manifest.jobs[index];
    if (!Array.isArray(checked.files)) throw new Error('Preflight requires file metadata from validateProject');
    const files = checked.files.map(file => ({ ...file })).sort(byPath);
    for (const file of files.filter(file => file.exists)) {
      const entry = copies.get(file.path) ?? { path: file.path, jobs: [], copiedBytes: 0 };
      entry.jobs.push({ id: job.id, bytes: file.bytes, context: file.context, output: file.output });
      entry.copiedBytes += file.bytes;
      copies.set(file.path, entry);
    }
    if (job.outputs.length > PREFLIGHT_THRESHOLDS.outputs) advisories.push({
      code: 'review-output-scope', jobId: job.id, actual: job.outputs.length, threshold: PREFLIGHT_THRESHOLDS.outputs,
      message: 'Review whether these outputs span independent concerns. Split coherent deliverables with separate writers; keep coupled files together.',
    });
    if (checked.contextBytes > PREFLIGHT_THRESHOLDS.contextBytes) advisories.push({
      code: 'review-context-size', jobId: job.id, actual: checked.contextBytes, threshold: PREFLIGHT_THRESHOLDS.contextBytes,
      message: 'Review the largest copied files and provide only context needed for the acceptance check. Size is a review signal, not proof that the task is too large.',
    });
    return {
      // tier/tierReason are validated routing metadata for the coordinator; they are
      // advisory only here and never change which model or provider actually runs.
      id: job.id, agent: job.agent, model: job.model ?? null, tier: job.tier ?? null, tierReason: job.tierReason ?? null,
      outputCount: job.outputs.length, contextBytes: checked.contextBytes,
      files, largestContexts: files.filter(file => file.exists).sort((a, b) => b.bytes - a.bytes || byPath(a, b)).slice(0, 5),
    };
  });

  const writers = new Map(manifest.jobs.flatMap(job => job.outputs.map(file => [file.toLowerCase(), { jobId: job.id, path: file }])));
  const snapshotHazards = [];
  for (const job of manifest.jobs) {
    for (const file of job.context) {
      const writer = writers.get(file.toLowerCase());
      if (writer && writer.jobId !== job.id) snapshotHazards.push({
        path: file, writerJobId: writer.jobId, readerJobId: job.id,
        message: 'The reader receives the pre-run snapshot, not this writer’s output. Agree on an exact stable contract or move the reader to a later run after integration; concurrency 1 does not establish a dependency.',
      });
    }
  }
  const repeatedContext = [...copies.values()].filter(entry => entry.jobs.length > 1).sort(byPath).map(entry => ({
    ...entry,
    repeatedBytes: entry.copiedBytes - Math.max(...entry.jobs.map(job => job.bytes)),
  }));
  return {
    status: 'preflight', validated: true, advisoryOnly: true,
    concurrency: manifest.concurrency ?? 2, jobCount: jobs.length,
    totalContextBytes: jobs.reduce((sum, job) => sum + job.contextBytes, 0),
    thresholds: { ...PREFLIGHT_THRESHOLDS }, jobs, repeatedContext, snapshotHazards, advisories,
    reviewRequired: advisories.length > 0 || snapshotHazards.length > 0,
    limitations: [
      'Output counts and byte thresholds do not measure semantic complexity, model tokens, speedup, or useful worker capacity.',
      'Repeated context may be necessary for correctness. Files include existing outputs because workers receive those snapshots too.',
      'This report covers one manifest at one moment. It does not reserve files, detect other active runs, or make dependencies execute in order.',
      'No source contents, prompt text, provider calls, automatic splitting, or worker dispatch are included in this report.',
    ],
  };
}

// Static, advisory inspection only. Do not execute JS configs or follow symlinks.
// An unrecognized/extended config remains a warning, never proof of exclusion.
export async function projectToolWarnings(root){
 const warnings=[];
 for(const entry of (await fs.readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const file=entry.name;
  let key;
  if(/^tsconfig(?:\.[^.]+)?\.json$/.test(file))key='exclude';
  else if(/^(vitest|vite)\.config\.[cm]?[jt]s$/.test(file))key='exclude';
  else if(/^jest\.config\.[cm]?[jt]s$/.test(file))key='testPathIgnorePatterns';
  else if(/^eslint\.config\.[cm]?[jt]s$/.test(file)||/^\.eslintrc(?:\..+)?$/.test(file))key='ignores|ignorePatterns';
  else if(/^playwright\.config\.[cm]?[jt]s$/.test(file))key='testIgnore';
  else if(['pytest.ini','.pytest.ini','pyproject.toml','setup.cfg','tox.ini'].includes(file))key='norecursedirs';
  else if(file==='package.json')key='testPathIgnorePatterns';
  else continue;
  if(!entry.isFile()){warnings.push({code:'swarm-tool-exclusion',path:file,message:'Cannot statically verify tool exclusions (not a regular file); review .swarm/ exclusions in docs/setup.md.'});continue;}
  const full=path.join(root,file);
  if((await fs.stat(full)).size>1024*1024){warnings.push({code:'swarm-tool-exclusion',path:file,message:'Config too large for static exclusion check; review .swarm/ exclusions.'});continue;}
  const text=await fs.readFile(full,'utf8');
  if(file==='package.json'&&!/"jest"\s*:/.test(text))continue;
  if(['pyproject.toml','setup.cfg','tox.ini'].includes(file)&&!/\[(?:tool\.pytest(?:\.ini_options)?|pytest|tool:pytest)\]/.test(text))continue;
  // Limit matches to the named array/line so an unrelated mention cannot hide a warning.
  const settings=[...text.matchAll(new RegExp(`(?:${key})["']?\\s*[:=]\\s*(\\[[^\\]]*\\]|[^\\n]*)`,'g'))].map(match=>match[1]);
  if(settings.some(setting=>/\.swarm(?:[/'"\s*\]]|$)/.test(setting)))continue;
  warnings.push({code:'swarm-tool-exclusion',path:file,message:'This config may scan .swarm/ source and test copies. No explicit exclusion found by the best-effort static check; see docs/setup.md and docs/kickoff.md. Extended, dynamic, and narrow include configs need manual review.'});
 }
 return warnings;
}
