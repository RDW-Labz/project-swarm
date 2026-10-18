import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const STOP_FILE = '.swarm/stop.json';

const GPU_ATTEMPTS = 3;
const GPU_RETRY_MS = 1000;
const GPU_BILLING = 'the rented node may still be billing: terminate the instance in the provider console now';

const errText = (e) => (e && e.message ? e.message : String(e));
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stopPath = (root) => join(root, STOP_FILE);

export async function readStopMarker(root) {
  let raw;
  try {
    raw = await readFile(stopPath(root), 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : { at: null, reason: 'unreadable marker' };
  }
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return { at: null, reason: 'unreadable marker' };
    return {
      at: typeof obj.at === 'string' ? obj.at : null,
      reason: typeof obj.reason === 'string' ? obj.reason : '',
    };
  } catch {
    return { at: null, reason: 'unreadable marker' };
  }
}

export async function stopGuard(root) {
  const marker = await readStopMarker(root);
  if (!marker) return null;
  const when = marker.at ?? 'an unknown time';
  return { code: 'stopped', message: `stopped: swarm stop --all ran at ${when}; run swarm stop --clear first` };
}

export async function clearStop(root) {
  try {
    await unlink(stopPath(root));
    return { cleared: true };
  } catch (e) {
    return e && e.code === 'ENOENT' ? { cleared: false } : { cleared: false, error: errText(e) };
  }
}

async function writeMarker(root, reason) {
  await mkdir(join(root, '.swarm'), { recursive: true });
  const tmp = stopPath(root) + '.tmp';
  const body = JSON.stringify({ at: new Date().toISOString(), reason }) + String.fromCharCode(10);
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, stopPath(root));
}

async function pollUntil(check, { waitMs, pollMs, sleep }) {
  let waited = 0;
  for (;;) {
    if (await check()) return true;
    if (waited >= waitMs) return false;
    const step = Math.min(pollMs, waitMs - waited);
    await sleep(step);
    waited += step;
  }
}

async function markerStep(root, deps) {
  const name = 'marker';
  try {
    await writeMarker(root, deps.reason ?? 'swarm stop --all');
    return { name, status: 'done', detail: STOP_FILE };
  } catch (e) {
    return { name, status: 'failed', detail: `cannot write marker: ${errText(e)}` };
  }
}

async function runsStep(root, deps, opts) {
  const name = 'runs';
  let listed;
  try {
    listed = await deps.listRuns(root);
    if (!Array.isArray(listed)) throw new Error('the run list is not an array');
  } catch (e) {
    return { name, status: 'failed', detail: `cannot list runs: ${errText(e)}` };
  }
  const running = listed.filter((r) => r.status === 'running').map((r) => r.id);
  if (running.length === 0) return { name, status: 'nothing', detail: 'no running runs' };
  const notes = [];
  for (const id of running) {
    try {
      await deps.cancelRun(root, id);
    } catch (e) {
      notes.push(`cancel ${id}: ${errText(e)}`);
    }
  }
  let stillIds = running;
  const stopped = await pollUntil(async () => {
    try {
      const now = await deps.listRuns(root);
      if (!Array.isArray(now)) throw new Error('the run list is not an array');
      stillIds = now.filter((r) => r.status === 'running').map((r) => r.id);
    } catch (e) {
      notes.push(`poll: ${errText(e)}`);
    }
    return stillIds.length === 0;
  }, opts);
  if (stopped) return { name, status: 'done', detail: `stopped ${running.length} run(s)` };
  return { name, status: 'failed', detail: [`still running: ${stillIds.join(', ')}`, ...notes].join('; ') };
}

async function autopilotStep(root, deps, opts) {
  const name = 'autopilot';
  let pid;
  try {
    pid = await deps.readAutopilotPid(root);
  } catch (e) {
    return { name, status: 'failed', detail: `cannot read autopilot pid: ${errText(e)}` };
  }
  if (pid == null) return { name, status: 'nothing', detail: 'no autopilot pid' };
  if (!Number.isInteger(pid) || pid <= 0) {
    return { name, status: 'failed', detail: `invalid pid: ${String(pid)}` };
  }
  let alive = true;
  try {
    alive = await deps.isAlive(pid);
  } catch {
    alive = true;
  }
  if (!alive) return { name, status: 'nothing', detail: `pid ${pid} from the lock is already gone (stale lock)` };
  // A lock can be stale, restored or planted: the pid is signalled only when it really is an autopilot.
  if (typeof deps.isAutopilot === 'function') {
    let isOurs = false;
    try {
      isOurs = (await deps.isAutopilot(pid)) === true;
    } catch {
      isOurs = false;
    }
    if (!isOurs) return { name, status: 'failed', detail: `pid ${pid} is alive but is not a swarm autopilot (stale lock?): not signalled; stop it by hand if it is yours` };
  }
  const notes = [];
  const signal = async (sig) => {
    try {
      await deps.kill(pid, sig);
    } catch (e) {
      notes.push(`${sig}: ${errText(e)}`);
    }
  };
  const gone = async () => {
    try {
      return !(await deps.isAlive(pid));
    } catch {
      return false;
    }
  };
  await signal('SIGTERM');
  let stopped = await pollUntil(gone, opts);
  if (!stopped) {
    await signal('SIGKILL');
    stopped = await pollUntil(gone, opts);
  }
  if (stopped) return { name, status: 'done', detail: `pid ${pid} stopped` };
  return { name, status: 'failed', detail: [`pid ${pid} still alive after SIGKILL`, ...notes].join('; ') };
}

async function verifyGpu(deps, notes) {
  try {
    await deps.gpuStatus();
  } catch (e) {
    notes.push(`status: ${errText(e)}`);
    return false;
  }
  try {
    return (await deps.gpuSession()) == null;
  } catch (e) {
    notes.push(`verify: ${errText(e)}`);
    return false;
  }
}

async function gpuStep(deps, sleep) {
  const name = 'gpu';
  let session;
  try {
    session = await deps.gpuSession();
  } catch (e) {
    return { name, status: 'failed', detail: `cannot read gpu session: ${errText(e)}; ${GPU_BILLING}` };
  }
  if (session == null) return { name, status: 'nothing', detail: 'no gpu session' };
  const notes = [];
  let verified = false;
  for (let attempt = 1; attempt <= GPU_ATTEMPTS && !verified; attempt++) {
    let downOk = true;
    try {
      await deps.gpuDown();
    } catch (e) {
      downOk = false;
      notes.push(`down ${attempt}: ${errText(e)}`);
    }
    // A down call that failed is never a verified stop, even when it already removed the session record.
    verified = downOk && (await verifyGpu(deps, notes));
    if (!verified && attempt < GPU_ATTEMPTS) await sleep(GPU_RETRY_MS);
  }
  if (verified) return { name, status: 'done', detail: 'gpu session ended and verified' };
  return {
    name,
    status: 'failed',
    detail: `gpu session still active after ${GPU_ATTEMPTS} attempts (${notes.join('; ')}); ${GPU_BILLING}`,
  };
}

async function backupStep(root, deps) {
  const name = 'backup';
  if (typeof deps.backup !== 'function') return { name, status: 'failed', detail: 'no backup function' };
  try {
    const r = await deps.backup(root, { reason: 'stop --all' });
    return { name, status: 'done', detail: r && r.id ? `backup ${r.id}` : 'backup written' };
  } catch (e) {
    return { name, status: 'failed', detail: `backup failed: ${errText(e)}` };
  }
}

export async function runStopAll(root, deps = {}) {
  const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);
  const pollMs = Math.max(1, num(deps.pollMs, 500));
  const waitMs = Math.max(0, num(deps.waitMs, 15000));
  const sleep = deps.sleep ?? defaultSleep;
  const opts = { waitMs, pollMs, sleep };
  const steps = [];
  steps.push(await markerStep(root, deps));
  // The autopilot goes first: while it lives it could start a new run in the gap after the runs are cancelled.
  steps.push(await autopilotStep(root, deps, opts));
  steps.push(await runsStep(root, deps, opts));
  const gpu = await gpuStep(deps, sleep);
  steps.push(gpu);
  steps.push(await backupStep(root, deps));
  return {
    ok: steps.every((s) => s.status !== 'failed'),
    billingRisk: gpu.status === 'failed',
    steps,
  };
}

export function exitCodeFor(result) {
  return result.ok ? 0 : 2;
}

export function formatStopLines(result) {
  return result.steps.map((s) => `${s.name}: ${s.status}${s.detail ? ' - ' + s.detail : ''}`);
}
