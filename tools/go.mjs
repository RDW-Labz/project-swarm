#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// One command from a manifest (or an already-started run) to a merged, reviewed change: run,
// integrate, commit exactly the integrated files, then ship. Every stage function is injected so
// this orchestrator never itself spawns a real agent CLI or talks to GitHub.
import { execFile } from 'node:child_process';

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

export function goExitCode(status) {
  return status === 'failed' ? 1 : 0;
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
      waited = await wait(root, started.id);
    } catch (error) {
      return { status: 'failed', stage: 'run', ...base, reason: error.message };
    }
    base.runId = started.id; base.cost = waited.costUsd ?? null; base.warnings = waited.warnings ?? [];
    if (waited.status !== 'complete') return { status: 'failed', stage: 'run', ...base, reason: `run ${waited.status}` };
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
