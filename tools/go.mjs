#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// One command from a manifest (or an already-started run) to a merged, reviewed change: run,
// integrate, commit exactly the integrated files, then ship. Every stage function is injected so
// this orchestrator never itself spawns a real agent CLI or talks to GitHub.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mainWorktreeRoot } from './project-spend.mjs';

// A manifest path always carries a `.` (a `.json` extension); a run id never does, so this is
// enough to tell the two positional shapes of `go`'s target apart without touching the filesystem.
const RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

function firstLine(text) {
  const line = String(text ?? '').split('\n')[0] ?? '';
  return line.slice(0, 200);
}

function commitExec(file, args, { cwd } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

// Stages only the run's own integrated files (`git add --` plus that exact list), never
// `git add -A`, so a commit made on the way to `ship` can never sweep in an unrelated dirty file.
export async function commitOutputs(root, files, message, { exec = commitExec } = {}) {
  if (!files.length) return { status: 'failed', reason: 'nothing to commit' };
  const addRes = await exec('git', ['add', '--', ...files], { cwd: root });
  if (addRes.code !== 0) return { status: 'failed', reason: `git add failed: ${firstLine(addRes.stderr)}` };
  const commitRes = await exec('git', ['commit', '-m', message], { cwd: root });
  if (commitRes.code !== 0) return { status: 'failed', reason: `git commit failed: ${firstLine(commitRes.stderr)}` };
  return { status: 'committed' };
}

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const TICKET_ID_RE = /^T-\d+$/;
const INTEGRATION_SKIP_PATHS = new Set(['coordination/HANDOFF.md', 'coordination/TASK.md', 'docs/state/usage-ledger.md']);

function normalizeRepoPath(file) {
  return String(file).replace(/\\/g, '/');
}

function skipIntegrationCommitPath(file) {
  const rel = normalizeRepoPath(file);
  if (INTEGRATION_SKIP_PATHS.has(rel)) return true;
  return rel === '.swarm' || rel.startsWith('.swarm/');
}

function integrationTicketIds(manifest) {
  const ids = new Set();
  for (const job of manifest?.jobs ?? []) {
    if (typeof job.ticket === 'string' && job.ticket) ids.add(job.ticket);
    else if (typeof job.id === 'string' && TICKET_ID_RE.test(job.id)) ids.add(job.id);
  }
  return [...ids].sort();
}

function integrationCommitMessage(runId, manifest, files) {
  const tickets = integrationTicketIds(manifest);
  const ticketPart = tickets.length ? ` (${tickets.join(', ')})` : '';
  const lines = [`swarm integrate: run ${runId}${ticketPart}: ${files.length} files`, '', ...files, '', `Swarm-Run: ${runId}`];
  if (tickets.length) lines.push(`Swarm-Tickets: ${tickets.join(',')}`);
  return lines.join('\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gitInRoot(exec, root, args, { env } = {}) {
  return exec('git', ['-C', root, ...args], { cwd: root, env });
}

const INTEGRATE_COMMIT_BRANCHES_KEY = 'integrate.commitBranches';

function integrateCommitBranchesInvalidReason(detail) {
  return `.project-swarm.json ${INTEGRATE_COMMIT_BRANCHES_KEY} ${detail}`;
}

function validCommitBranchPatterns(value) {
  if (!Array.isArray(value)) return null;
  const patterns = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry) return null;
    patterns.push(entry);
  }
  return patterns;
}

function patternMatchesBranch(branch, pattern) {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return branch.startsWith(prefix);
  }
  return branch === pattern;
}

function patternMatchesAnyProtected(pattern, protectedLower) {
  for (const name of protectedLower) {
    if (patternMatchesBranch(name, pattern)) return true;
  }
  return false;
}

function filterCommitBranchPatterns(patterns, protectedLower) {
  return patterns.filter(pattern => pattern !== '*' && !patternMatchesAnyProtected(pattern, protectedLower));
}

export function branchAllowedForIntegrateCommit(branch, patterns, { remoteHeadReadable = true, protectedLower = null } = {}) {
  const effective = remoteHeadReadable || !protectedLower
    ? patterns
    : filterCommitBranchPatterns(patterns, protectedLower);
  for (const pattern of effective) {
    if (patternMatchesBranch(branch, pattern)) return true;
  }
  return false;
}

export async function readIntegrateCommitBranches(root) {
  const readPointer = async pointerFile => {
    try {
      const text = await fs.readFile(pointerFile, 'utf8');
      try {
        return { pointer: JSON.parse(text) };
      } catch {
        return { error: integrateCommitBranchesInvalidReason('is not valid JSON') };
      }
    } catch (error) {
      if (error.code === 'ENOENT') return { missing: true };
      return { error: integrateCommitBranchesInvalidReason(`cannot be read (${error.code ?? 'error'})`) };
    }
  };

  let result = await readPointer(path.join(root, '.project-swarm.json'));
  if (result.missing) {
    const mainRoot = await mainWorktreeRoot(root);
    if (mainRoot && path.resolve(mainRoot) !== path.resolve(root)) {
      result = await readPointer(path.join(mainRoot, '.project-swarm.json'));
    }
  }
  if (result.error) return { patterns: [], error: result.error };
  if (result.missing) return { patterns: [], error: null };

  const raw = result.pointer?.integrate?.commitBranches;
  if (raw === undefined) return { patterns: [], error: null };
  const patterns = validCommitBranchPatterns(raw);
  if (patterns === null) return { patterns: [], error: integrateCommitBranchesInvalidReason('must be an array of non-empty strings') };
  return { patterns, error: null };
}

async function readIntegrateCommitBranchContext(exec, root, gitEnv) {
  const protectedLower = new Set(['main', 'master']);

  const initRes = await gitInRoot(exec, root, ['config', '--get', 'init.defaultBranch'], { env: gitEnv });
  if (initRes.code === 0 && initRes.stdout?.trim()) {
    protectedLower.add(initRes.stdout.trim().toLowerCase());
  }

  let remoteHeadReadable = false;
  const refRes = await gitInRoot(exec, root, ['for-each-ref', '--format=%(symref)', 'refs/remotes/*/HEAD'], { env: gitEnv });
  if (refRes.code === 0 && refRes.stdout) {
    for (const line of refRes.stdout.split('\n')) {
      const symref = line.trim();
      if (!symref) continue;
      const match = /^refs\/remotes\/[^/]+\/(.+)$/.exec(symref);
      if (!match) continue;
      remoteHeadReadable = true;
      protectedLower.add(match[1].toLowerCase());
    }
  }

  return { protectedLower, remoteHeadReadable };
}

function isProtectedBranch(branch, protectedLower) {
  return protectedLower.has(branch.toLowerCase());
}

const DEFAULT_BRANCH_UNDETERMINED_SKIP =
  'integrate.commitBranches would match via * or a default-branch pattern, but the default branch could not be determined (no remote HEAD); only swarm/* and explicitly named branches commit';

export async function commitIntegratedRun(root, { runId, state, manifest, autoCommit = true, exec = commitExec, env, appendEvent, sleepMs = sleep } = {}) {
  const skipped = reason => ({ commit: { status: 'skipped', reason }, humanLine: `committed nothing: ${reason}` });
  if (autoCommit === false) return skipped('autoCommit disabled');

  const gitEnv = { ...process.env, ...(env ?? {}) };
  const branchRes = await gitInRoot(exec, root, ['symbolic-ref', '--short', 'HEAD'], { env: gitEnv });
  if (branchRes.code !== 0 || !branchRes.stdout?.trim()) return skipped('not on a branch');
  const branch = branchRes.stdout.trim();

  const { protectedLower, remoteHeadReadable } = await readIntegrateCommitBranchContext(exec, root, gitEnv);
  if (isProtectedBranch(branch, protectedLower)) {
    return skipped(`checkout is on ${branch}, the main branch; integrate never commits there (not a swarm/* branch)`);
  }

  const { patterns, error: commitBranchesError } = await readIntegrateCommitBranches(root);
  const onSwarmBranch = branch.startsWith('swarm/');
  const warnings = [];
  if (commitBranchesError) {
    if (!onSwarmBranch) return skipped(commitBranchesError);
    warnings.push(commitBranchesError);
  }

  const branchContext = { remoteHeadReadable, protectedLower };
  const onNamedBranch = branchAllowedForIntegrateCommit(branch, patterns, branchContext);
  if (!onSwarmBranch && !onNamedBranch) {
    const wouldMatchIgnored = !remoteHeadReadable
      && branchAllowedForIntegrateCommit(branch, patterns, { remoteHeadReadable: true })
      && !branchAllowedForIntegrateCommit(branch, patterns, branchContext);
    if (wouldMatchIgnored) return skipped(DEFAULT_BRANCH_UNDETERMINED_SKIP);
    return skipped(`checkout is on ${branch}, not a swarm/* branch or a branch named in .project-swarm.json integrate.commitBranches`);
  }

  const stagedRes = await gitInRoot(exec, root, ['diff', '--cached', '--name-only'], { env: gitEnv });
  if (stagedRes.code !== 0) return skipped('git could not read the index');
  if (stagedRes.stdout.trim()) return skipped('other files are already staged');

  const candidates = [...new Set([...(state.integratedFiles ?? []), ...(state.integratedNewFiles ?? [])])]
    .map(normalizeRepoPath)
    .filter(file => file && !skipIntegrationCommitPath(file));

  for (const file of candidates) {
    const expected = state.integratedHashes?.[file];
    if (typeof expected !== 'string' || !expected) return skipped(`missing integrated hash for ${file}`);
    let bytes;
    try { bytes = await fs.readFile(path.join(root, file)); } catch { return skipped(`hash mismatch: ${file}`); }
    if (digest(bytes) !== expected) return skipped(`hash mismatch: ${file}`);
  }

  const toCommit = [];
  for (const file of candidates) {
    const tracked = await gitInRoot(exec, root, ['ls-files', '--error-unmatch', '--', file], { env: gitEnv });
    if (tracked.code !== 0) {
      try { await fs.access(path.join(root, file)); toCommit.push(file); } catch { /* absent */ }
      continue;
    }
    const diff = await gitInRoot(exec, root, ['diff', '--quiet', 'HEAD', '--', file], { env: gitEnv });
    if (diff.code !== 0) toCommit.push(file);
  }

  if (!toCommit.length) return skipped('nothing to commit');

  const message = integrationCommitMessage(runId, manifest, toCommit);
  const addRes = await gitInRoot(exec, root, ['add', '--', ...toCommit], { env: gitEnv });
  if (addRes.code !== 0) {
    return { commit: { status: 'failed', reason: `git add failed: ${firstLine(addRes.stderr)}` }, humanLine: `committed nothing: git add failed: ${firstLine(addRes.stderr)}` };
  }

  let commitRes = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    commitRes = await gitInRoot(exec, root, ['commit', '-m', message], { env: gitEnv });
    if (commitRes.code === 0) break;
    const lockHint = /index\.lock/i.test(`${commitRes.stderr}${commitRes.stdout}`);
    if (!lockHint || attempt === 2) break;
    await sleepMs(300);
  }

  if (commitRes.code !== 0) {
    const reason = firstLine(commitRes.stderr) || 'git commit failed';
    await gitInRoot(exec, root, ['restore', '--staged', '--', ...toCommit], { env: gitEnv }).catch(() => {});
    return { commit: { status: 'failed', reason }, humanLine: `committed nothing: ${reason}` };
  }

  const shaRes = await gitInRoot(exec, root, ['rev-parse', 'HEAD'], { env: gitEnv });
  const sha = shaRes.stdout?.trim() ?? '';
  const commit = { status: 'committed', sha, branch, files: toCommit, message };
  const humanLine = `committed ${toCommit.length} files on ${branch}: ${sha.slice(0, 8)} (run ${runId})`;
  if (typeof appendEvent === 'function') {
    await appendEvent({
      kind: 'integration',
      run: runId,
      status: 'committed',
      branch,
      sha: sha.slice(0, 8),
      files: toCommit.length,
      text: humanLine,
    }).catch(() => {});
  }
  if (warnings.length) return { commit, humanLine, warnings };
  return { commit, humanLine };
}

export function goExitCode(status) {
  return status === 'failed' ? 1 : 0;
}

export function firstJobOrError(state) {
  const jobs = state?.jobs;
  if (Array.isArray(jobs) && jobs.length > 0 && jobs[0] != null) return { record: jobs[0] };
  if (state?.error != null && state.error !== '') return { error: String(state.error) };
  const status = state?.status;
  if (status != null && status !== '') return { error: `run ${status}` };
  return { error: 'run produced no job results' };
}

export function waitResultCost(waited) {
  const { record } = firstJobOrError(waited ?? {});
  if (record && typeof record.costUsd === 'number') return record.costUsd;
  return waited?.costUsd ?? null;
}

// Stage functions (run/wait/integrate/commit/ship) are always supplied by the caller: swarm.mjs
// wires the real ones for `swarm go`, tests inject fakes so none of this touches a real agent CLI
// or GitHub. `flags` carries commitMessage, repo, payloadPath, requireSections, mutants,
// mergeMethod, timeoutMs (already parsed and validated by the caller).
export async function go(root, target, flags, deps) {
  const { run, wait, integrate, commit, ship } = deps;
  const base = { runId: null, cost: null, warnings: [], integrate: null, ship: null, reason: null };
  const runId = RUN_ID_RE.test(target) ? target : null;

  if (runId === null) {
    let started, waited;
    try {
      started = await run(root, target);
      base.runId = started.id;
      waited = await wait(root, started.id);
    } catch (error) {
      return { status: 'failed', stage: 'run', ...base, reason: error.message, ...(error.code ? { code: error.code } : {}) };
    }
    base.runId = started.id; base.cost = waitResultCost(waited); base.warnings = waited?.warnings ?? [];
    if (waited?.status !== 'complete') {
      const { error } = firstJobOrError(waited ?? {});
      return { status: 'failed', stage: 'run', ...base, reason: error ?? `run ${waited?.status ?? 'unknown'}` };
    }
  } else {
    base.runId = runId;
  }

  let integrated;
  try {
    integrated = await integrate(root, base.runId, { mutants: Boolean(flags.mutants), ...(flags.noFlakeCheck ? { noFlakeCheck: true } : {}) });
  } catch (error) {
    return { status: 'failed', stage: 'integrate', ...base, reason: error.message };
  }
  base.integrate = integrated;
  if (integrated.checksPassed === false) {
    const failing = (integrated.checks ?? []).filter(check => !['passed', 'skipped'].includes(check.status)).map(check => check.name);
    return { status: 'failed', stage: 'integrate', ...base, reason: `checks failed: ${failing.join(', ')}` };
  }
  // Any mutant result counts, not only one asked for with --mutants: the real integrate stage
  // also runs a manifest's own mutants, and a survivor there must never reach commit or ship.
  if (integrated.mutantsPassed === false) {
    return { status: 'failed', stage: 'integrate', ...base, reason: 'mutants survived or errored' };
  }

  let status = 'integrated', stage = 'integrate';

  if (flags.commitMessage) {
    let committed;
    try { committed = await commit(root, integrated.files, flags.commitMessage); }
    catch (error) { return { status: 'failed', stage: 'commit', ...base, reason: error.message }; }
    if (committed.status !== 'committed') return { status: 'failed', stage: 'commit', ...base, reason: committed.reason };
    status = 'committed'; stage = 'commit';
  }

  if (flags.payloadPath) {
    let shipped;
    try {
      shipped = await ship(root, base.runId, {
        repo: flags.repo, payloadPath: flags.payloadPath, requireSections: flags.requireSections ?? [],
        mergeMethod: flags.mergeMethod, timeoutMs: flags.timeoutMs,
        ...(flags.tagTimeoutMs !== undefined ? { tagTimeoutMs: flags.tagTimeoutMs } : {}),
        ...(flags.noFlakeCheck ? { noFlakeCheck: true } : {}),
        ...(flags.exemptions?.length ? { exemptions: flags.exemptions } : {}),
      });
    } catch (error) { return { status: 'failed', stage: 'ship', ...base, reason: error.message }; }
    base.ship = shipped; stage = 'ship';
    if (!['merged', 'held', 'ready'].includes(shipped.status)) return { status: 'failed', stage, ...base, reason: shipped.reason ?? null };
    return { status: shipped.status, stage, ...base };
  }

  return { status, stage, ...base };
}
