// SPDX-License-Identifier: Apache-2.0
// Post-merge deploy watch (R-031): after a merge that deploys, track the deploy and run a 15-minute
// window that checks deployment status, production health, and error logs; on failure, offer rollback.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendEvent, safeWritableDir } from './journal.mjs';
import { rollbackOffer } from './deploy-rollback.mjs';
import { previewBase, realGet, validateHandoffConfig } from './handoff-docs.mjs';
import { pullErrors, validateErrorsConfig } from './errors.mjs';

const execFileP = promisify(execFile);
const deployWatchScript = fileURLToPath(import.meta.url);

export const WATCH_WINDOW_MS = 15 * 60 * 1000;
export const POLL_INTERVAL_MS = 60 * 1000;
export const DEPLOY_WATCH_STATE = '.swarm/deploy-watch/state.json';
export const USAGE =
  'usage: deploy-watch start --pr N --repo OWNER/NAME --sha COMMIT [--run] | status | run | merge PR [--repo OWNER/NAME]';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultNow = () => Date.now();

async function realExec(command, args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await execFileP(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
    };
  }
}

const parseJson = (r) => {
  try {
    return JSON.parse(String(r.stdout ?? ''));
  } catch {
    return undefined;
  }
};

/** True when the project profile says merges deploy to production (handoff.deploy is configured). */
export function mergeThatDeploys(handoffConfig) {
  return Array.isArray(handoffConfig?.deploy) && handoffConfig.deploy.length > 0;
}

export function watchEndsAtIso(startedAtMs) {
  return new Date(startedAtMs + WATCH_WINDOW_MS).toISOString();
}

function watchNowMs(nowArg = defaultNow) {
  return typeof nowArg === 'function' ? nowArg() : nowArg;
}

export function watchRemainingMs(state, nowArg = defaultNow) {
  if (!isObj(state) || typeof state.endsAt !== 'string') return 0;
  const end = Date.parse(state.endsAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, end - watchNowMs(nowArg));
}

export function isWatchWindowOpen(state, nowArg = defaultNow) {
  return isObj(state) && state.status === 'active' && watchRemainingMs(state, nowArg) > 0;
}

export function buildWatchState({ pr, repo, sha, startedAtMs = defaultNow() }) {
  const startedAt = new Date(startedAtMs).toISOString();
  return {
    version: 1,
    status: 'active',
    startedAt,
    endsAt: watchEndsAtIso(startedAtMs),
    merge: { pr: Math.trunc(pr), repo: String(repo), sha: String(sha) },
    ticks: 0,
    checks: [],
  };
}

export async function readDeployWatchState(root) {
  const file = path.join(root, DEPLOY_WATCH_STATE);
  try {
    const text = await fs.readFile(file, 'utf8');
    const state = JSON.parse(text);
    return isObj(state) ? state : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeDeployWatchState(root, state) {
  const dir = await safeWritableDir(root, ['.swarm', 'deploy-watch']);
  const file = path.join(dir, 'state.json');
  await fs.writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  return state;
}

export { rollbackOffer } from './deploy-rollback.mjs';

export async function readProjectProfile(root, deps = {}) {
  if (deps.profile !== undefined && deps.profile !== null) return deps.profile;
  try {
    const { readProfile } = await import('./scope-commands.mjs');
    return await readProfile(root);
  } catch {
    return null;
  }
}

export function profileWatchConfigs(profile) {
  const handoff = profile?.handoff ? validateHandoffConfig(profile.handoff).config : null;
  const errorsConfig = profile?.errors ? validateErrorsConfig(profile.errors).config : null;
  return { handoff, errorsConfig };
}

export function mergeRefsFromShipOrMergeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const prRaw = result.pr && typeof result.pr === 'object' ? result.pr.number : result.pr;
  const pr = Number(prRaw);
  const repo = typeof result.repo === 'string' ? result.repo : null;
  const sha = String(result.mergeSha ?? result.sha ?? '');
  if (!Number.isFinite(pr) || pr < 1 || !repo || !SHA_RE.test(sha)) return null;
  return { pr, repo, sha };
}

/** Spawn a detached `deploy-watch run` to poll through the 15-minute window. */
export function spawnDetachedDeployWatchRun(root) {
  const child = spawn(process.execPath, [deployWatchScript, 'run'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { pid: child.pid ?? null };
}

/**
 * After `swarm merge` or a merged `ship` result: start the watch (when handoff.deploy is set) and
 * spawn the polling window in the background unless `runWindow` is true (run inline in-process).
 */
export async function kickoffDeployWatchAfterMergeShip(root, result, deps = {}) {
  if (!result || result.status !== 'merged') return { status: 'skipped', reason: 'not-merged' };
  const refs = mergeRefsFromShipOrMergeResult(result);
  if (!refs) return { status: 'refused', reason: 'bad-merge-refs' };
  const existing = await readDeployWatchState(root);
  if (
    isObj(existing)
    && existing.merge?.sha === refs.sha
    && (existing.status === 'active' || existing.status === 'passed' || existing.status === 'failed')
  ) {
    return { status: 'already-watching', state: existing };
  }
  const profile = await readProjectProfile(root, deps);
  const { handoff, errorsConfig } = profileWatchConfigs(profile);
  const runInline = deps.runWindow === true;
  const started = await startDeployWatch(
    root,
    {
      pr: refs.pr,
      repo: refs.repo,
      sha: refs.sha,
      handoffConfig: handoff,
      errorsConfig,
      runWindow: runInline,
    },
    deps,
  );
  if (started.status === 'watching' && !runInline && deps.spawnRunner !== false) {
    started.runner = spawnDetachedDeployWatchRun(root);
  }
  return started;
}

/** Merge guard with post-merge deploy watch (used by swarm merge / ship once wired). */
export async function runMerge(root, args, deps = {}) {
  const { runMerge: merge } = await import('./merge-guard.mjs');
  const res = await merge(root, args, deps);
  if (res.status === 'merged') {
    res.deployWatch = await kickoffDeployWatchAfterMergeShip(root, res, deps);
  }
  return res;
}

/** Ship/merge history hook: record history then start deploy watch on merged results. */
export async function recordShipHistoryWithDeployWatch(root, result, opts = {}) {
  const { recordShipHistory } = await import('./history-hooks.mjs');
  await recordShipHistory(root, result, opts);
  if (result?.status === 'merged') {
    return kickoffDeployWatchAfterMergeShip(root, result, opts);
  }
  return { status: 'skipped', reason: 'not-merged' };
}

async function checkGithubDeployStatus(exec, repo, sha) {
  if (!REPO_RE.test(repo) || !SHA_RE.test(sha)) {
    return { ok: false, kind: 'deploy', reason: 'invalid-merge-refs' };
  }
  const r = await exec('gh', ['api', `repos/${repo}/commits/${sha}/status`]);
  if (r.code !== 0) {
    return { ok: false, kind: 'deploy', reason: 'github-status-unavailable' };
  }
  const body = parseJson(r);
  const state = typeof body?.state === 'string' ? body.state : 'unknown';
  if (state === 'pending') return { ok: true, kind: 'deploy', pending: true, state };
  if (state === 'success') return { ok: true, kind: 'deploy', state };
  return { ok: false, kind: 'deploy', reason: `github-status-${state}` };
}

async function checkProductionHealth(handoffConfig, { fetchImpl } = {}) {
  const base = previewBase({ config: handoffConfig });
  if (base.error) return { ok: false, kind: 'health', reason: base.error };
  const healthUrl = `${base.base.replace(/\/$/, '')}/health`;
  let res;
  try {
    res = await realGet(healthUrl, { fetchImpl });
  } catch {
    res = await realGet(base.base, { fetchImpl });
  }
  if (res.status >= 200 && res.status <= 299) return { ok: true, kind: 'health', url: healthUrl };
  return { ok: false, kind: 'health', reason: `health-http-${res.status || 'unreachable'}` };
}

async function checkProductionErrors(root, startedAtMs, errorsConfig, pullErrorsImpl) {
  const cfg = errorsConfig ?? validateErrorsConfig({}).config;
  let pulled;
  try {
    pulled = await pullErrorsImpl(root, { config: cfg });
  } catch (error) {
    return { ok: false, kind: 'errors', reason: String(error?.message ?? 'errors-source-failed').slice(0, 120) };
  }
  const since = startedAtMs - 60_000;
  const eventMs = (ev) => {
    const raw = ev?.at ?? ev?.timestamp;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
    const t = Date.parse(String(raw ?? ''));
    return Number.isFinite(t) ? t : NaN;
  };
  const bad = (pulled.events ?? []).filter((ev) => {
    const t = eventMs(ev);
    return Number.isFinite(t) && t >= since;
  });
  if (bad.length) {
    return { ok: false, kind: 'errors', reason: `production-errors-${bad.length}`, count: bad.length };
  }
  return { ok: true, kind: 'errors', lines: pulled.lines ?? 0 };
}

/** One poll cycle: deploy status, health URL, and production error logs. */
export async function pollDeployWatchTick(
  root,
  state,
  { handoffConfig, errorsConfig, exec = realExec, pullErrorsImpl = pullErrors, fetchImpl } = {},
) {
  const merge = state?.merge;
  if (!isObj(merge)) return { ok: false, failures: [{ reason: 'no-merge-in-state' }] };
  const checks = await Promise.all([
    checkGithubDeployStatus(exec, merge.repo, merge.sha),
    checkProductionHealth(handoffConfig, { fetchImpl }),
    checkProductionErrors(root, Date.parse(state.startedAt), errorsConfig, pullErrorsImpl),
  ]);
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}

/**
 * After a successful merge: when the project deploys on merge, persist watch state and optionally run the window.
 * Returns { status: 'skipped' } when handoff.deploy is not configured.
 */
export async function startDeployWatch(
  root,
  { pr, repo, sha, handoffConfig, errorsConfig, runWindow = false },
  {
    now = defaultNow,
    append = appendEvent,
    sleep = defaultSleep,
    exec = realExec,
    pullErrorsImpl = pullErrors,
    fetchImpl,
  } = {},
) {
  if (!Number.isFinite(pr) || pr < 1 || !REPO_RE.test(String(repo ?? '')) || !SHA_RE.test(String(sha ?? ''))) {
    return { status: 'refused', reason: 'bad-merge-refs' };
  }
  if (!mergeThatDeploys(handoffConfig)) {
    return { status: 'skipped', reason: 'merge-does-not-deploy' };
  }
  const startedAtMs = now();
  const state = buildWatchState({ pr, repo, sha, startedAtMs });
  await writeDeployWatchState(root, state);
  await append(root, {
    kind: 'checkpoint',
    id: 'deploy-watch',
    phase: 'start',
    pr: Math.trunc(pr),
    repo: String(repo),
    sha: String(sha),
    endsAt: state.endsAt,
  }, { now });
  if (!runWindow) return { status: 'watching', state };
  const finished = await runDeployWatchWindow(root, {
    state,
    handoffConfig,
    errorsConfig,
    sleep,
    now,
    exec,
    pullErrorsImpl,
    fetchImpl,
    append,
  });
  return { status: finished.status, state: finished.state, rollback: finished.rollback };
}

/** Run checks every POLL_INTERVAL_MS until the 15-minute window ends or a check fails. */
export async function runDeployWatchWindow(
  root,
  { state, handoffConfig, errorsConfig, sleep = defaultSleep, now = defaultNow, exec = realExec, pullErrorsImpl = pullErrors, fetchImpl, append = appendEvent },
) {
  let current = { ...state, status: 'active' };
  const handoff = handoffConfig ?? null;
  while (isWatchWindowOpen(current, now())) {
    const tick = await pollDeployWatchTick(root, current, {
      handoffConfig: handoff,
      errorsConfig,
      exec,
      pullErrorsImpl,
      fetchImpl,
    });
    current = {
      ...current,
      ticks: (current.ticks ?? 0) + 1,
      lastTickAt: new Date(now()).toISOString(),
      checks: tick.checks,
    };
    if (!tick.ok) {
      const reason = tick.failures.map((f) => f.reason).join('; ') || 'watch-check-failed';
      const rollback = rollbackOffer(handoff, reason);
      current = { ...current, status: 'failed', failure: reason, rollbackOffer: rollback };
      await writeDeployWatchState(root, current);
      await append(root, {
        kind: 'human',
        id: `deploy-watch-${current.merge.sha}`,
        text: rollback.guidance,
        run: 'deploy-watch',
      }, { now });
      return { status: 'failed', state: current, rollback };
    }
    await writeDeployWatchState(root, current);
    const remaining = watchRemainingMs(current, now());
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
  current = { ...current, status: 'passed', finishedAt: new Date(now()).toISOString() };
  await writeDeployWatchState(root, current);
  await append(root, {
    kind: 'checkpoint',
    id: 'deploy-watch',
    phase: 'passed',
    sha: current.merge?.sha,
    ticks: current.ticks,
  }, { now });
  return { status: 'passed', state: current };
}

function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const opts = { runWindow: false };
  const positional = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--run') opts.runWindow = true;
    else if (a === '--pr') opts.pr = Number(list[++i]);
    else if (a === '--repo') opts.repo = list[++i];
    else if (a === '--sha') opts.sha = list[++i];
    else if (a.startsWith('--')) return { error: `unknown-flag: ${a}` };
    else positional.push(a);
  }
  if (positional[0]) opts.command = positional[0];
  return opts;
}

export async function runDeployWatchCli(root, argv, deps = {}) {
  const opts = parseArgs(argv);
  if (opts.error) return { status: 'refused', reason: opts.error };
  const command = opts.command ?? 'status';
  if (command === 'status') {
    const state = await readDeployWatchState(root);
    if (!state) return { status: 'idle' };
    return {
      status: state.status ?? 'unknown',
      active: isWatchWindowOpen(state, deps.now?.() ?? defaultNow()),
      remainingMs: watchRemainingMs(state, deps.now?.() ?? defaultNow()),
      state,
    };
  }
  if (command === 'run') {
    const state = await readDeployWatchState(root);
    if (!state) return { status: 'refused', reason: 'no-active-watch' };
    if (!isWatchWindowOpen(state, deps.now?.() ?? defaultNow())) {
      return { status: 'refused', reason: 'watch-window-ended', state };
    }
    const profile = deps.profile ?? null;
    const handoff = profile?.handoff ? validateHandoffConfig(profile.handoff).config : null;
    const errorsConfig = profile?.errors ? validateErrorsConfig(profile.errors).config : null;
    return runDeployWatchWindow(root, {
      state,
      handoffConfig: handoff,
      errorsConfig,
      ...deps,
    });
  }
  if (command === 'start') {
    const profile = deps.profile ?? null;
    const handoff = profile?.handoff ? validateHandoffConfig(profile.handoff).config : null;
    const errorsConfig = profile?.errors ? validateErrorsConfig(profile.errors).config : null;
    return startDeployWatch(
      root,
      {
        pr: opts.pr,
        repo: opts.repo,
        sha: opts.sha,
        handoffConfig: handoff,
        errorsConfig,
        runWindow: opts.runWindow,
      },
      deps,
    );
  }
  if (command === 'merge') {
    const mergePos = positional.slice(1);
    const mergeArgs = [...mergePos];
    if (opts.repo) mergeArgs.push('--repo', opts.repo);
    const profile = deps.profile ?? (await readProjectProfile(root, deps));
    return runMerge(root, mergeArgs, { ...deps, profile });
  }
  return { status: 'refused', reason: USAGE };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  let profile = null;
  try {
    const { readProfile } = await import('./scope-commands.mjs');
    profile = await readProfile(process.cwd());
  } catch {
    profile = null;
  }
  const out = await runDeployWatchCli(process.cwd(), argv, { profile });
  console.log(JSON.stringify(out));
  process.exitCode = out.status === 'passed' || out.status === 'watching' || out.status === 'idle' || out.status === 'skipped' ? 0 : 1;
}
