// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workerQueueFile, diskGuard } from './worker-queue.mjs';
import { detectLaneOutcome } from './lane-plugins.mjs';

export const DEFAULT_GRACE_MS = 10 * 60 * 1000;
export const DEFAULT_HEARTBEAT_MS = 30 * 1000;

export function workerHome(home = os.homedir()) {
  return path.join(home, 'swarm-worker');
}

export function workerPaths(home = os.homedir()) {
  const root = workerHome(home);
  return { root, repos: path.join(root, 'repos'), worktrees: path.join(root, 'worktrees'), logs: path.join(root, 'logs'), lanes: path.join(root, 'lanes.json') };
}

export async function readWorkerLanes(home = os.homedir()) {
  const file = workerPaths(home).lanes;
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

export function laptopGate({ role, onCharger, lidOpen, brainReachable, force = false } = {}) {
  if (role !== 'remote+worker') return { ok: true, reason: 'not-laptop' };
  if (force) return { ok: true, reason: 'forced' };
  if (onCharger !== true) return { ok: false, reason: 'laptop-on-battery' };
  if (lidOpen !== true) return { ok: false, reason: 'laptop-lid-closed' };
  if (brainReachable !== true) return { ok: false, reason: 'laptop-cannot-reach-brain' };
  return { ok: true, reason: 'laptop-ready' };
}

export function laptopState({ role, onCharger, lidOpen, brainReachable, running = 0, userActive = false } = {}) {
  if (role !== 'remote+worker') return 'worker';
  if (onCharger !== true || lidOpen === false || brainReachable === false) return 'away';
  if (running > 0) return 'working';
  if (userActive) return 'docked-idle';
  return 'docked-idle';
}

export function slotsForMachine({ slots, role, onCharger, userActive } = {}) {
  const base = Number.isInteger(slots) && slots >= 0 ? slots : 1;
  if (role !== 'remote+worker') return base;
  if (onCharger !== true) return 0;
  return userActive ? Math.min(1, base) : base;
}

// Owner-measured ceiling is the start. Back off when the Mac reports thermal throttling or hard
// memory pressure, then recover one slot per clean sample. 2019 Intel i9s spend most of a long
// batch throttled, so this keeps them useful without cooking them.
export function tuneSlots({ current, ceiling, throttled = false, cpuSpeedLimit, cpuSchedulerLimit, memoryPressure, role, onCharger, userActive } = {}) {
  const base = slotsForMachine({ slots: ceiling, role, onCharger, userActive });
  if (base <= 0) return 0;
  const now = Number.isInteger(current) && current > 0 ? current : base;
  const hot = throttled === true
    || (cpuSpeedLimit !== undefined && cpuSpeedLimit < 100)
    || (cpuSchedulerLimit !== undefined && cpuSchedulerLimit < 100);
  if (hot || memoryPressure === 'hard') return Math.max(1, Math.min(base, Math.floor(now / 2)));
  if (memoryPressure === 'soft') return Math.max(1, Math.min(base, now));
  if (now < base) return Math.min(base, now + 1);
  return Math.min(base, now);
}

export function sshTarget(machine) {
  return `${machine.user}@${machine.host}`;
}

export function sshArgs(machine, remoteCommand, { key } = {}) {
  return [
    'ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes',
    '-i', key ?? path.join(os.homedir(), '.ssh', 'swarm_ed25519'), '--', sshTarget(machine), remoteCommand,
  ];
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function createSshTransport({ brain, runner = '~/.project-swarm/current/tools/swarm.mjs', run = spawnCapture, key } = {}) {
  const runnerExpr = runner.startsWith('~/') ? `"$HOME/${runner.slice(2)}"` : shellQuote(runner);
  const hosts = () => [...new Set([brain.host, ...(Array.isArray(brain.hosts) ? brain.hosts : [])].filter(Boolean))];
  const invoke = host => sshArgs({ ...brain, host }, `node ${runnerExpr} worker-rpc`, { key }).slice(1);
  const call = async (request) => {
    const errors = [];
    for (const host of hosts()) {
      const result = await run('ssh', invoke(host), { input: `${JSON.stringify(request)}\n`, timeout: 60000 });
      if (result.code !== 0) { errors.push(`${host}: ${String(result.stderr ?? '').trim()}`); continue; }
      const text = String(result.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '{}';
      const parsed = JSON.parse(text);
      if (parsed && parsed.error) { errors.push(`${host}: ${parsed.message ?? parsed.error}`); continue; }
      brain.host = host;
      brain.hosts = [host, ...hosts().filter(entry => entry !== host)];
      return parsed;
    }
    throw Object.assign(new Error(`brain rpc failed: ${errors.at(-1) ?? 'no brain host'}`), { code: 'worker-transport' });
  };
  return {
    next: ({ lanes, machine, capabilities = [] }) => call({ op: 'next', lanes, machine, capabilities, epoch: brain.epoch }),
    claim: (item, holder, { machine = null, lanes = null, capabilities = [] } = {}) => call({ op: 'claim', id: item.id, holder, machine, lanes, capabilities, epoch: brain.epoch }),
    renew: (item, holder) => call({ op: 'renew', id: item.id, holder, epoch: brain.epoch }),
    report: (item, holder, report) => call({ op: 'report', id: item.id, holder, report, epoch: brain.epoch }),
    heartbeat: ({ machine, ip }) => call({ op: 'heartbeat', machine, ip, epoch: brain.epoch }),
  };
}

export function spawnCapture(command, args, { input = '', timeout = 60 * 60 * 1000, cwd = process.cwd(), env = process.env, signal } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      try { child.kill('SIGTERM'); } catch {}
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      if (typeof timer.unref === 'function') timer.unref();
    };
    const onAbort = () => kill();
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }); });
    child.on('close', code => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr }); });
    child.stdin.end(input);
  });
}


export function mirrorRoot(home = os.homedir()) {
  return path.join(home, '.project-swarm', 'mirrors');
}

export async function mirrorRepo({ source, name, home = os.homedir(), run = spawnCapture } = {}) {
  if (!name || !/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw Object.assign(new Error('invalid mirror name'), { code: 'mirror-invalid' });
  const dir = path.join(mirrorRoot(home), `${name}.git`);
  const exists = await fs.stat(dir).then(() => true, () => false);
  if (!exists) {
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    const cloned = await run('git', ['clone', '--mirror', source, dir], { timeout: 30 * 60 * 1000 });
    if (cloned.code !== 0) throw Object.assign(new Error(`mirror failed: ${cloned.stderr.trim()}`), { code: 'mirror-failed' });
  } else {
    const updated = await run('git', ['-C', dir, 'remote', 'update', '--prune'], { timeout: 30 * 60 * 1000 });
    if (updated.code !== 0) throw Object.assign(new Error(`mirror update failed: ${updated.stderr.trim()}`), { code: 'mirror-failed' });
  }
  return { dir };
}

export async function ensureRepo({ repo, project, brain, key, home = os.homedir(), run = spawnCapture } = {}) {
  const gitEnv = { ...process.env, ...(key ? { GIT_SSH_COMMAND: `ssh -i ${key} -o BatchMode=yes -o StrictHostKeyChecking=accept-new` } : {}) };
  const exists = await fs.stat(path.join(repo, '.git')).then(() => true, () => false);
  if (exists) {
    const fetched = await run('git', ['-C', repo, 'fetch', '--all', '--prune'], { timeout: 10 * 60 * 1000, env: gitEnv });
    return { cloned: false, fetched: fetched.code === 0 };
  }
  if (!brain) throw Object.assign(new Error('repo is missing and no brain is configured'), { code: 'repo-missing' });
  const remote = `${brain.user}@${brain.host}:${project}.git`;
  await fs.mkdir(path.dirname(repo), { recursive: true, mode: 0o700 });
  const cloned = await run('git', ['clone', remote, repo], { timeout: 60 * 60 * 1000, env: gitEnv });
  if (cloned.code !== 0) throw Object.assign(new Error(`repo clone failed: ${cloned.stderr.trim()}`), { code: 'repo-clone-failed' });
  return { cloned: true, fetched: true };
}

export async function latestRunReport(worktree) {
  const dir = path.join(worktree, '.swarm', 'runs');
  let names;
  try { names = await fs.readdir(dir); } catch { return null; }
  const entries = await Promise.all(names.map(async name => {
    const file = path.join(dir, name, 'state.json');
    try {
      const stat = await fs.stat(file);
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      return { name, at: stat.mtimeMs, state };
    } catch { return null; }
  }));
  const latest = entries.filter(Boolean).sort((a, b) => b.at - a.at)[0];
  if (!latest) return null;
  const jobs = latest.state.jobs ?? [];
  return {
    run: latest.name,
    status: latest.state.status ?? 'unknown',
    jobs: jobs.length,
    complete: jobs.filter(job => job.status === 'complete').length,
    failed: jobs.filter(job => ['failed', 'timeout'].includes(job.status)).length,
    summary: latest.state.summary ?? null,
  };
}

export async function prepareWorktree({ item, repo, worktrees, base = 'origin/main', machine = os.hostname(), run = spawnCapture } = {}) {
  const safeId = String(item.id).replace(/[^A-Za-z0-9._-]/g, '-');
  const attempt = String(item.attempts ?? 0);
  const branch = `worker/${machine.replace(/[^A-Za-z0-9._-]/g, '-')}/${safeId}-${attempt}`.slice(0, 180);
  const dir = path.join(worktrees, `${safeId}-${attempt}`);
  await fs.mkdir(worktrees, { recursive: true });
  await run('git', ['-C', repo, 'worktree', 'remove', '--force', dir], { timeout: 60000 }).catch(() => ({}));
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await run('git', ['-C', repo, 'worktree', 'prune'], { timeout: 60000 }).catch(() => ({}));
  const add = await run('git', ['-C', repo, 'worktree', 'add', '-B', branch, dir, base], { timeout: 120000 });
  if (add.code !== 0) throw Object.assign(new Error(`worktree-add-failed: ${add.stderr.trim()}`), { code: 'worktree-add-failed' });
  return { dir, branch };
}

export async function cleanWorktrees({ repo, worktrees, olderThanMs = 7 * 24 * 60 * 60 * 1000, now = Date.now, run = spawnCapture } = {}) {
  let names;
  try { names = await fs.readdir(worktrees); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const dir = path.join(worktrees, name);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat || now() - stat.mtimeMs < olderThanMs) continue;
    const result = await run('git', ['-C', repo, 'worktree', 'remove', '--force', dir], { timeout: 60000 });
    if (result.code === 0) removed.push(name);
  }
  return removed;
}

async function writeManifest(worktree, item) {
  const data = item.manifestData;
  if (!data) throw Object.assign(new Error('work item has no manifest data'), { code: 'worker-manifest-missing' });
  const file = path.join(worktree, '.swarm-worker-manifest.json');
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export async function executeItem({ item, holder, paths, runner, run = spawnCapture, heartbeatMs = DEFAULT_HEARTBEAT_MS, renew = null, now = Date.now, prepare = prepareWorktree, latest = latestRunReport, brain = null, key = null, gitKey = null, ensure = ensureRepo, signal = null } = {}) {
  const controller = new AbortController();
  const onExternal = () => controller.abort();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onExternal, { once: true }); }
  let renewError = null;
  let alive = true;
  let timer = null;
  if (typeof renew === 'function') {
    timer = setInterval(() => { if (alive) renew().catch(error => { renewError = error; controller.abort(); }); }, heartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  try {
    const repo = path.join(paths.repos, item.project);
    await ensure({ repo, project: item.project, brain, key: gitKey ?? key, run });
    const worktree = await prepare({ item, repo, worktrees: paths.worktrees, run });
    const manifestFile = await writeManifest(worktree.dir, item);
    const result = await run(process.execPath, [runner, 'run', manifestFile, '--jobs', item.job], { cwd: worktree.dir, timeout: 4 * 60 * 60 * 1000, signal: controller.signal });
    let pushed = false;
    let pushError = null;
    if (brain && gitKey) {
      const gitEnv = { ...process.env, GIT_SSH_COMMAND: `ssh -i ${gitKey} -o BatchMode=yes -o StrictHostKeyChecking=accept-new` };
      const status = await run('git', ['-C', worktree.dir, 'status', '--porcelain'], { timeout: 60000, env: gitEnv });
      if (String(status.stdout ?? '').trim()) {
        await run('git', ['-C', worktree.dir, 'add', '-A'], { timeout: 60000, env: gitEnv });
        await run('git', ['-C', worktree.dir, '-c', 'user.name=Swarm Worker', '-c', 'user.email=worker@swarm.invalid', 'commit', '-m', `worker ${item.job}`], { timeout: 120000, env: gitEnv });
      }
      const remote = `${brain.user}@${brain.host}:${item.project}.git`;
      const push = await run('git', ['-C', worktree.dir, 'push', '--force', remote, `HEAD:refs/heads/${worktree.branch}`], { timeout: 180000, env: gitEnv });
      pushed = push.code === 0;
      if (!pushed) pushError = String(push.stderr ?? '').trim().split('\n').at(-1) ?? 'push failed';
    }
    const report = await latest(worktree.dir);
    if (renewError) {
      return { ok: false, state: 'lease-lost', exitCode: result.code, report: { status: 'fail', retry: true, lane: item.lane, model: item.model, run: report?.run ?? null, summary: report?.summary ?? null, stderr: String(renewError.message ?? renewError) }, worktree };
    }
    const outcome = detectLaneOutcome({ lane: item.lane, exitCode: result.code, stdout: result.stdout, stderr: result.stderr });
    const ok = result.code === 0 && outcome.state === 'ok';
    return {
      ok,
      state: outcome.state,
      exitCode: result.code,
      report: {
        status: ok ? 'pass' : outcome.state === 'rate-limited' ? 'rate-limited' : outcome.state === 'logged-out' ? 'logged-out' : 'fail',
        files: report?.summary?.files ?? null,
        tests: report?.summary?.checks ?? null,
        timeMs: report ? null : null,
        lane: item.lane,
        model: item.model,
        branch: worktree.branch,
        project: item.project,
        machine: String(holder).split('/')[0],
        job: item.job,
        title: item.title,
        pushed,
        ...(pushError ? { pushError } : {}),
        run: report?.run ?? null,
        summary: report?.summary ?? null,
        stderr: result.stderr.slice(-2000),
      },
      worktree,
    };
  } finally {
    alive = false;
    if (timer) clearInterval(timer);
    if (signal) signal.removeEventListener('abort', onExternal);
  }
}

export async function runWorkerOnce({ lanes, capabilities = [], holder, paths, runner, run = spawnCapture, transport, maxSlots = 1, freeDiskGb, role, onCharger, lidOpen, brainReachable, userActive, now = Date.now, brain = null, key = null, gitKey = null, ensure = ensureRepo, monitor = null, monitorMs = 30000 } = {}) {
  const disk = diskGuard(freeDiskGb);
  if (!disk.ok) return { action: 'stop', reason: `disk-below-${disk.min}gb`, freeDiskGb };
  const gate = laptopGate({ role, onCharger, lidOpen, brainReachable });
  if (!gate.ok) return { action: 'stop', reason: gate.reason };
  const slots = slotsForMachine({ slots: maxSlots, role, onCharger, userActive });
  if (slots < 1) return { action: 'stop', reason: 'no-slots' };
  let item;
  try { item = await transport.next({ lanes, capabilities, machine: String(holder).split('/')[0] }); } catch (error) { return { action: 'error', reason: error.message }; }
  if (!item) return { action: 'idle' };
  try { await transport.claim(item, holder, { machine: String(holder).split('/')[0], lanes, capabilities }); } catch (error) { return { action: ['worker-lease-held', 'worker-queue-paused', 'worker-lane-cooling', 'worker-lane-mismatch'].includes(error.code) ? 'retry' : 'error', reason: error.message }; }
  let renew = null;
  if (typeof transport.renew === 'function') renew = () => transport.renew(item, holder);
  const controller = new AbortController();
  let monitorError = null;
  let monitorTimer = null;
  if (typeof monitor === 'function') {
    monitorTimer = setInterval(async () => {
      const verdict = await monitor().catch(error => ({ ok: false, reason: error.message }));
      if (!verdict?.ok && !controller.signal.aborted) { monitorError = verdict?.reason ?? 'monitor-failed'; controller.abort(); }
    }, monitorMs);
    if (typeof monitorTimer.unref === 'function') monitorTimer.unref();
  }
  let result;
  try {
    result = await executeItem({ item, holder, paths, runner, run, renew, now, brain, key, gitKey, ensure, signal: controller.signal });
  } catch (error) {
    result = { ok: false, state: 'error', report: { status: 'fail', retry: true, lane: item.lane, model: item.model, error: error.message } };
  } finally {
    if (monitorTimer) clearInterval(monitorTimer);
  }
  if (monitorError) result = { ...result, ok: false, state: 'aborted', report: { ...(result.report ?? {}), status: 'fail', retry: true, lane: item.lane, model: item.model, error: monitorError } };
  try { await transport.report(item, holder, result.report); }
  catch (error) { return { action: 'ran', item, ...result, reportError: error.message }; }
  return { action: 'ran', item, ...result };
}

export async function workerLoop({ base, intervalMs = 15000, maxIterations = Infinity, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), shouldStop = () => false, probe = async () => ({}) } = {}) {
  const results = [];
  for (let i = 0; i < maxIterations && !shouldStop(); i += 1) {
    const state = await probe();
    const result = await runWorkerOnce({ ...base, ...state });
    results.push(result);
    if (result.action === 'ran') continue;
    await sleep(intervalMs);
  }
  return results;
}
