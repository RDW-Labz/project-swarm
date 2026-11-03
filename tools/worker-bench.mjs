// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { enqueueManifest, nextWorkerItem, claimWorkerItem, renewWorkerItem, reportWorkerItem, workerQueueFile, listWorkerItems } from './worker-queue.mjs';
import { executeItem, workerPaths } from './worker-runner.mjs';

export function memoryTransport(file, { env = process.env, home = os.homedir(), now = Date.now, leaseMs = 60 * 60 * 1000 } = {}) {
  const options = { file, env, home, now, leaseMs };
  return {
    next: ({ lanes }) => nextWorkerItem({ ...options, lanes }),
    claim: (item, holder) => claimWorkerItem(item.id, holder, options),
    renew: (item, holder) => renewWorkerItem(item.id, holder, options),
    report: (item, holder, report) => reportWorkerItem(item.id, holder, { ...options, status: report?.status === 'pass' ? 'done' : 'failed', report }),
  };
}

export async function runBench({ manifestPath, manifest, workers = 1, workMs = 25, file, paths, now = Date.now } = {}) {
  const queueFile = file ?? workerQueueFile({ env: process.env, home: process.cwd() });
  await fs.rm(queueFile, { force: true });
  const started = now();
  await enqueueManifest({ manifestPath, manifest, project: 'bench', file: queueFile, now });
  const transport = memoryTransport(queueFile, { now });
  const counts = { pass: 0, fail: 0, claimed: 0 };
  const work = async (workerId) => {
    for (;;) {
      const item = await transport.next({ lanes: ['claude', 'codex', 'gemini', 'opencode', 'cursor'] });
      if (!item) return;
      try { await transport.claim(item, `bench/${workerId}`); } catch (error) { if (error.code === 'worker-lease-held') continue; throw error; }
      counts.claimed += 1;
      const result = await executeItem({
        item,
        holder: `bench/${workerId}`,
        paths,
        runner: 'bench',
        brain: null,
        key: null,
        ensure: async () => ({}),
        prepare: async () => {
          const dir = await fs.mkdtemp(path.join(os.tmpdir(), `worker-bench-${workerId}-`));
          return { dir, branch: `bench/${workerId}` };
        },
        latest: async () => ({ run: 'bench', status: 'complete', jobs: 1, complete: 1, failed: 0, summary: { files: [] } }),
        renew: () => transport.renew(item, `bench/${workerId}`),
        run: async () => { await new Promise(resolve => setTimeout(resolve, workMs)); return { code: 0, stdout: '', stderr: '' }; },
      });
      await transport.report(item, `bench/${workerId}`, result.report);
      if (result.ok) counts.pass += 1; else counts.fail += 1;
      if (result.worktree?.dir) await fs.rm(result.worktree.dir, { recursive: true, force: true }).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, workers) }, (_, index) => work(index + 1)));
  const items = await listWorkerItems({ file: queueFile, now });
  const elapsedMs = now() - started;
  const jobs = Array.isArray(manifest?.jobs) ? manifest.jobs.length : items.length;
  return {
    workers,
    jobs,
    claimed: counts.claimed,
    pass: counts.pass,
    fail: counts.fail,
    passRate: counts.claimed ? counts.pass / counts.claimed : 0,
    elapsedMs,
    msPerTicket: counts.claimed ? elapsedMs / counts.claimed : null,
    costUsd: 0,
    file: queueFile,
  };
}

export async function runBenchFromFile({ manifestPath, workers = 1, workMs = 25, file } = {}) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  return runBench({ manifestPath, manifest, workers, workMs, file, paths: workerPaths(os.homedir()) });
}

export function benchSummary(results) {
  return results.map(result => `${result.workers} worker(s): ${result.claimed}/${result.jobs} tickets, ${result.pass} pass, ${result.fail} fail, ${result.elapsedMs} ms, ${result.msPerTicket?.toFixed(1)} ms/ticket, $${result.costUsd.toFixed(4)}`).join('\n');
}
