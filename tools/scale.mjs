// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const SCALE_DEFAULT_JOBS = 500;
export const SCALE_DEFAULT_CONCURRENCY = 500;

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

export function stubManifest(count, concurrency) {
  if (!Number.isInteger(count) || count < 1 || count > 500) throw Object.assign(new Error('scale jobs must be an integer 1–500'), { code: 'scale-jobs' });
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 512) throw Object.assign(new Error('scale concurrency must be an integer 1–512'), { code: 'scale-concurrency' });
  const jobs = Array.from({ length: count }, (_, n) => ({
    id: `job-${n}`,
    agent: 'ollama',
    model: 'stub',
    prompt: `Write out/${n}.txt`,
    context: ['input.txt'],
    outputs: [`out/${n}.txt`],
    timeoutMs: 30000,
  }));
  return {
    version: 1,
    concurrency,
    lanes: { ollama: { concurrency } },
    jobs,
  };
}

function stubBody(n) {
  const text = JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: `output ${n}\n` }] });
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
