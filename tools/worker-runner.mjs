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

export function ghostGate({ role, onCharger, lidOpen, brainReachable, force = false } = {}) {
  if (role !== 'remote+worker') return { ok: true, reason: 'not-ghost' };
  if (force) return { ok: true, reason: 'forced' };
  if (onCharger !== true) return { ok: false, reason: 'ghost-on-battery' };
  if (lidOpen !== true) return { ok: false, reason: 'ghost-lid-closed' };
  if (brainReachable !== true) return { ok: false, reason: 'ghost-cannot-reach-brain' };
  return { ok: true, reason: 'ghost-ready' };
}

export function ghostState({ role, onCharger, lidOpen, brainReachable, running = 0, userActive = false } = {}) {
  if (role !== 'remote+worker') return 'worker';
  if (onCharger !== true || lidOpen === false || brainReachable === false) return 'away';
  if (running > 0) return 'working';
  if (userActive) return 'docked-idle';
  return 'docked-idle';
}

export function slotsForMachine({ slots, role, onCharger, userActive } = {}) {
  const base = Number.isInteger(slots) && slots > 0 ? slots : 1;
  if (role !== 'remote+worker') return base;
  if (onCharger !== true) return 0;
  return userActive ? Math.min(1, base) : base;
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

export function createSshTransport({ brain, runner = '~/.project-swarm/current/tools/swarm.mjs', run = spawnCapture, key } = {}) {
  const remote = (args) => `node ${runner} worker ${args.map(arg => JSON.stringify(String(arg))).join(' ')}`;
  return {
    async next({ lanes, machine }) {
      const result = await run('ssh', sshArgs(brain, remote(['next', '--json', '--lanes', lanes.join(','), ...(machine ? ['--machine', machine] : [])]), { key }));
      if (result.code !== 0) throw Object.assign(new Error(`brain next failed: ${result.stderr.trim()}`), { code: 'worker-transport' });
      const text = result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
      return text ? JSON.parse(text) : null;
    },
    async claim(item, holder) {
      const result = await run('ssh', sshArgs(brain, remote(['claim', item.id, '--holder', holder]), { key }));
      if (result.code !== 0) throw Object.assign(new Error(`brain claim failed: ${result.stderr.trim()}`), { code: 'worker-transport' });
      return JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}');
    },
    async renew(item, holder) {
      const result = await run('ssh', sshArgs(brain, remote(['renew', item.id, '--holder', holder]), { key }));
      if (result.code !== 0) throw Object.assign(new Error(`brain renew failed: ${result.stderr.trim()}`), { code: 'worker-transport' });
      return JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}');
    },
    async report(item, holder, report) {
      const encoded = Buffer.from(JSON.stringify(report)).toString('base64');
      const result = await run('ssh', sshArgs(brain, remote(['report', item.id, '--holder', holder, '--report', encoded]), { key }));
      if (result.code !== 0) throw Object.assign(new Error(`brain report failed: ${result.stderr.trim()}`), { code: 'worker-transport' });
      return JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}');
    },
  };
}

export function spawnCapture(command, args, { input = '', timeout = 60 * 60 * 1000, cwd = process.cwd(), env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr }); });
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
  const exists = await fs.stat(path.join(repo, '.git')).then(() => true, () => false);
  if (exists) {
    const fetched = await run('git', ['-C', repo, 'fetch', '--all', '--prune'], { timeout: 10 * 60 * 1000 });
    return { cloned: false, fetched: fetched.code === 0 };
  }
  if (!brain) throw Object.assign(new Error('repo is missing and no brain is configured'), { code: 'repo-missing' });
  const remote = `${brain.user}@${brain.host}:~/.project-swarm/mirrors/${project}.git`;
  await fs.mkdir(path.dirname(repo), { recursive: true, mode: 0o700 });
  const cloned = await run('git', ['clone', remote, repo], { timeout: 60 * 60 * 1000 });
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
  const branch = `worker/${machine.replace(/[^A-Za-z0-9._-]/g, '-')}/${String(item.id).replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 120);
  const dir = path.join(worktrees, String(item.id).replace(/[^A-Za-z0-9._-]/g, '-'));
  await fs.mkdir(worktrees, { recursive: true });
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

export async function executeItem({ item, holder, paths, runner, run = spawnCapture, heartbeatMs = DEFAULT_HEARTBEAT_MS, renew = null, now = Date.now, prepare = prepareWorktree, latest = latestRunReport, brain = null, key = null, ensure = ensureRepo } = {}) {
  const repo = path.join(paths.repos, item.project);
  await ensure({ repo, project: item.project, brain, key, run });
  const worktree = await prepare({ item, repo, worktrees: paths.worktrees, run });
  const manifestFile = await writeManifest(worktree.dir, item);
  let alive = true;
  let timer = null;
  if (typeof renew === 'function') {
    timer = setInterval(() => { if (alive) renew().catch(() => {}); }, heartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  try {
    const result = await run(process.execPath, [runner, 'run', manifestFile, '--jobs', item.job], { cwd: worktree.dir, timeout: 4 * 60 * 60 * 1000 });
    const report = await latest(worktree.dir);
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
        run: report?.run ?? null,
        summary: report?.summary ?? null,
        stderr: result.stderr.slice(-2000),
      },
      worktree,
    };
  } finally {
    alive = false;
    if (timer) clearInterval(timer);
  }
}

export async function runWorkerOnce({ lanes, holder, paths, runner, run = spawnCapture, transport, maxSlots = 1, freeDiskGb, role, onCharger, lidOpen, brainReachable, userActive, now = Date.now, brain = null, key = null, ensure = ensureRepo } = {}) {
  const disk = diskGuard(freeDiskGb);
  if (!disk.ok) return { action: 'stop', reason: `disk-below-${disk.min}gb`, freeDiskGb };
  const gate = ghostGate({ role, onCharger, lidOpen, brainReachable });
  if (!gate.ok) return { action: 'stop', reason: gate.reason };
  const slots = slotsForMachine({ slots: maxSlots, role, onCharger, userActive });
  if (slots < 1) return { action: 'stop', reason: 'no-slots' };
  let item;
  try { item = await transport.next({ lanes, machine: String(holder).split('/')[0] }); } catch (error) { return { action: 'error', reason: error.message }; }
  if (!item) return { action: 'idle' };
  try { await transport.claim(item, holder); } catch (error) { return { action: error.code === 'worker-lease-held' ? 'retry' : 'error', reason: error.message }; }
  let renew = null;
  if (typeof transport.renew === 'function') renew = () => transport.renew(item, holder);
  const result = await executeItem({ item, holder, paths, runner, run, renew, now, brain, key, ensure });
  await transport.report(item, holder, result.report);
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
