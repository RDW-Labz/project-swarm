// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const SCALE_DEFAULT_JOBS = 500;
export const SCALE_DEFAULT_CONCURRENCY = 500;
export const SCALE_MAX_JOBS = 5000;

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function queueLatencyMs(jobs) {
  const waits = [];
  for (const job of jobs) {
    const queued = Date.parse(job.queuedAt);
    const started = Date.parse(job.startedAt);
    if (Number.isFinite(queued) && Number.isFinite(started) && started >= queued) waits.push(started - queued);
  }
  return { count: waits.length, p50: percentile(waits, 50), p95: percentile(waits, 95), max: waits.length ? Math.max(...waits) : null };
}

export function stubManifest(count, concurrency, dir = 'out') {
  if (!Number.isInteger(count) || count < 1 || count > SCALE_MAX_JOBS) throw Object.assign(new Error(`scale jobs must be an integer 1–${SCALE_MAX_JOBS}`), { code: 'scale-jobs' });
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2048) throw Object.assign(new Error('scale concurrency must be an integer 1–2048'), { code: 'scale-concurrency' });
  const jobs = Array.from({ length: count }, (_, n) => ({
    id: `job-${n}`,
    agent: 'ollama',
    model: 'stub',
    prompt: `Write ${dir}/${n}.txt`,
    context: ['input.txt'],
    outputs: [`${dir}/${n}.txt`],
    timeoutMs: 30000,
  }));
  return {
    version: 1,
    concurrency,
    lanes: { ollama: { concurrency } },
    jobs,
  };
}

function stubBody(n, dir = 'out') {
  const text = JSON.stringify({ summary: 'done', files: [{ path: `${dir}/${n}.txt`, content: `output ${n}\n` }] });
  return JSON.stringify({ done: true, done_reason: 'stop', message: { content: text } });
}

export async function prepareScaleRepo(root) {
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await fs.writeFile(path.join(root, 'input.txt'), 'original input\n');
  await exec('git', ['-C', root, 'add', 'input.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=Scale', '-c', 'user.email=scale@example.invalid', 'commit', '-qm', 'fixture']);
}

export async function scaleStub(root, { jobs = SCALE_DEFAULT_JOBS, concurrency = SCALE_DEFAULT_CONCURRENCY, holdMs = 0, runManifest, integrateRun } = {}) {
  if (typeof runManifest !== 'function' || typeof integrateRun !== 'function') throw Object.assign(new Error('scale requires runManifest and integrateRun'), { code: 'scale-deps' });
  const manifest = stubManifest(jobs, concurrency);
  const lanesDir = path.join(root, '.swarm-scale-lanes');
  const spendDir = path.join(root, '.swarm-scale-spend');
  await fs.mkdir(lanesDir, { recursive: true });
  await fs.mkdir(spendDir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), SWARM_LANES_DIR: lanesDir, SWARM_SPEND_DIR: spendDir, SWARM_CONFIG: path.join(os.tmpdir(), 'swarm-scale-missing-config.json') };
  const cores = os.cpus().length || 1;
  const cpuStart = process.cpuUsage();
  const wallStart = Date.now();
  let lastCpu = cpuStart, lastAt = wallStart, peakRssBytes = 0, peakCpuPercent = 0;
  const sample = () => {
    const mem = process.memoryUsage().rss;
    if (mem > peakRssBytes) peakRssBytes = mem;
    const now = Date.now();
    const cpu = process.cpuUsage();
    const wall = now - lastAt;
    if (wall > 0) {
      const usedMs = ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000;
      peakCpuPercent = Math.max(peakCpuPercent, (usedMs / wall / cores) * 100);
    }
    lastCpu = cpu;
    lastAt = now;
  };
  sample();
  const timer = setInterval(sample, 50);
  let state;
  try {
    state = await runManifest(root, manifest, {
      env,
      id: 'scale-stub',
      fetchImpl: async (_url, options) => {
        const match = /out\/(\d+)\.txt/.exec(String(options?.body ?? ''));
        if (!match) throw new Error('stub request did not name an output');
        if (holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs));
        return new Response(stubBody(match[1]), { headers: { 'content-type': 'application/json' } });
      },
    });
  } finally {
    clearInterval(timer);
    sample();
  }
  const cpu = process.cpuUsage(cpuStart);
  const mergeStart = Date.now();
  const integrate = state.jobs.every(job => job.status === 'complete') ? await integrateRun(root, state.id, { queue: true }) : null;
  const mergeMs = Date.now() - mergeStart;
  const files = integrate?.files?.length ?? 0;
  const spent = state.jobs.reduce((sum, job) => sum + (typeof job.costUsd === 'number' ? job.costUsd : 0), 0);
  return {
    kind: 'stub',
    jobs,
    concurrency,
    complete: state.jobs.filter(job => job.status === 'complete').length,
    failed: state.jobs.filter(job => job.status !== 'complete').length,
    costUsd: spent,
    peakRssBytes,
    cores,
    peakCpuPercent: Math.round(peakCpuPercent * 10) / 10,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
    durationMs: Date.now() - wallStart,
    queueLatencyMs: queueLatencyMs(state.jobs),
    peakConcurrency: state.peakConcurrency ?? null,
    merge: { files, ms: integrate ? mergeMs : null, filesPerSecond: integrate && mergeMs > 0 ? Math.round((files / mergeMs) * 10000) / 10 : null },
  };
}

// ---- the full practice check: the stub run, then what surrounds it at that size (Phase 17 step A) --------------------------------------------------------
const time = async fn => { const t = Date.now(); const value = await fn(); return { ms: Date.now() - t, value }; };

/** After a stub run of `jobs` workers in `root`: how the Watch board answers over that run (snapshot, project, live tab, run inspector), what the panic button does to a second run
 * that is still going, and whether a backup of a project with that many tickets writes and verifies. Everything is in the throwaway repo; nothing is spent. */
export async function scaleFull(root, { jobs = 1000, concurrency = 1000, runManifest, integrateRun, board, stop, backup, ledger }) {
  const out = { jobs, concurrency };
  out.run = await scaleStub(root, { jobs, concurrency, holdMs: 20, runManifest, integrateRun });
  // A second run, still going: the Watch board is measured over it, then the panic button stops it.
  const quietEnv = { PATH: process.env.PATH, HOME: os.tmpdir(), SWARM_LANES_DIR: path.join(root, '.swarm-scale-lanes'), SWARM_SPEND_DIR: path.join(root, '.swarm-scale-spend'), SWARM_CONFIG: path.join(os.tmpdir(), 'swarm-scale-missing-config.json') };
  const holdLive = 4000;
  // Its files go to a folder of their own: the first run's integrated files are in the working tree and a run refuses to name files that exist untracked.
  const running = runManifest(root, stubManifest(jobs, concurrency, 'live'), { env: quietEnv, id: 'scale-live', fetchImpl: async (_u, options) => { const m = /live\/(\d+)\.txt/.exec(String(options?.body ?? '')); await new Promise(r => setTimeout(r, holdLive)); return new Response(stubBody(m?.[1] ?? '0', 'live'), { headers: { 'content-type': 'application/json' } }); } });
  // Wait until the run has really started its workers (its state file lists them as running).
  const startedAt = Date.now();
  let startedJobs = 0;
  while (Date.now() - startedAt < 20000) {
    try { const st = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'runs', 'scale-live', 'state.json'), 'utf8')); startedJobs = (st.jobs ?? []).filter(j => j.status === 'running').length; } catch { /* not written yet */ }
    if (startedJobs >= Math.min(jobs, concurrency) * 0.9) break;
    await new Promise(r => setTimeout(r, 50));
  }
  out.liveRunStartMs = Date.now() - startedAt;
  out.liveRunning = startedJobs;
  const projectsFile = path.join(root, '.swarm-scale-projects.json');
  const id = board.projectId(root);
  await fs.writeFile(projectsFile, JSON.stringify({ version: 1, projects: [{ id, name: 'scale-throwaway', root, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() }] }));
  const env = { ...process.env, SWARM_PROJECTS_FILE: projectsFile, SWARM_HISTORY_FILE: path.join(root, '.swarm-scale-history.ndjson'), SWARM_LANES_DIR: path.join(root, '.swarm-scale-lanes'), SWARM_SPEND_DIR: path.join(root, '.swarm-scale-spend'), SWARM_CONFIG: path.join(os.tmpdir(), 'swarm-scale-missing-config.json') };
  const api = board.createBoardApi({ env, live: async () => [{ runId: 'scale-live', root, startedAt: new Date().toISOString() }], cacheMs: 0 });
  try {
    const snap = await time(() => api.snapshot());
    const proj = await time(() => api.project(id));
    const live = await time(() => api.live(id));
    const run = await time(() => api.run(id, 'scale-live'));
    out.watch = { snapshotMs: snap.ms, projectMs: proj.ms, liveMs: live.ms, runInspectorMs: run.ms, liveJobsRunning: live.value?.header?.jobs?.running ?? null, liveMapSquares: live.value?.map?.length ?? null, liveHeads: (live.value?.lanes ?? []).reduce((n, l) => n + l.agents.length, 0), inspectorJobs: run.value?.jobs?.length ?? null, bytes: { snapshot: JSON.stringify(snap.value).length, live: JSON.stringify(live.value).length, run: JSON.stringify(run.value).length } };
  } finally { await api.close?.().catch(() => {}); }
  // The panic button, with the workers still going.
  const stopped = await time(() => stop.runStopAll(root, stop.deps));
  const stopAt = Date.now();
  const ended = await Promise.race([running.then(s => ({ state: s })), new Promise(r => setTimeout(() => r(null), 60000))]);
  const counts = {};
  for (const j of ended?.state?.jobs ?? []) counts[j.status] = (counts[j.status] ?? 0) + 1;
  out.panic = { stopMs: stopped.ms, stopOk: stopped.value.ok, steps: stopped.value.steps.map(x => `${x.name}:${x.status}${x.detail ? ` (${String(x.detail).slice(0, 60)})` : ''}`), runEndedMsAfterStop: ended ? Date.now() - stopAt : null, runStatus: ended?.state?.status ?? null, runError: ended?.state?.error ?? ended?.state?.idle ?? null, jobStatuses: counts, markerWritten: Boolean(await stop.readMarker(root)) };
  await stop.clear(root);
  // Backups: a ledger with `jobs` tickets and a journal of `jobs` lines.
  await ledger.write(root, jobs);
  const made = await time(() => backup.create(root, { reason: 'scale' }));
  const verified = await time(() => backup.verify(root, made.value.id));
  out.backup = { createMs: made.ms, files: made.value.files ?? null, bytes: made.value.bytes ?? null, verifyMs: verified.ms, verifyOk: verified.value.ok };
  out.ok = out.run.complete === jobs && out.run.failed === 0 && out.panic.runStatus === 'cancelled' && out.panic.stopOk && out.backup.verifyOk;
  return out;
}
