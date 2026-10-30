// SPDX-License-Identifier: Apache-2.0
// Run inspect, for the board: one run's jobs as a graph (who waits for whom), which jobs were run again, and a journal of what happened in time order with
// what each job cost. Everything comes from the run's own files (state.json and manifest.json); nothing is estimated, and a field the run did not record is
// left out rather than filled in. Read-only, and only reads under the project's own .swarm/runs/RUN.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeWorkerText } from './worker-text.mjs';
import { laneLabel } from './board-data.mjs';
import { jobSpend } from './spend.mjs';
import { sanitizeText } from './journal.mjs';
import { projectOrchestrator } from './board-orchestrator.mjs';

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
// Secrets redacted, control characters removed, length bounded: job text came from a worker.
const txt = (v, n = 160) => (v === null || v === undefined ? null : sanitizeText(sanitizeWorkerText(v, n)));
const iso = v => (Number.isFinite(Date.parse(v ?? '')) ? new Date(v).toISOString() : null);
const MAX_JOBS = 2000;
// Maps keyed by text from the run files have no prototype (a lane called __proto__ must not reach Object.prototype).
const dict = () => Object.create(null);
const plain = d => Object.fromEntries(Object.entries(d));

async function readJson(file) {
  // lstat, not stat: a symlink or a pipe named state.json is refused, never followed or waited on.
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 40 * 1024 * 1024) throw new Error('not a plain file, or too large');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// Layers for the graph: a job sits one layer after the deepest job it waits for. A cycle or a dependency on a job that is not in the run does not break it.
export function layersOf(jobs) {
  const byId = new Map(jobs.map(j => [j.id, j]));
  const depth = new Map();
  // Iterative (an explicit stack), so a long chain of jobs cannot overflow the call stack; a cycle is cut where it closes.
  for (const job of jobs) {
    if (depth.has(job.id)) continue;
    const visiting = new Set([job.id]);
    const stack = [{ id: job.id, i: 0, deps: null, best: 0 }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (!f.deps) f.deps = (byId.get(f.id)?.after ?? []).filter(d => byId.has(d));
      if (f.i < f.deps.length) {
        const d = f.deps[f.i++];
        if (depth.has(d)) f.best = Math.max(f.best, depth.get(d) + 1);
        else if (!visiting.has(d)) { visiting.add(d); stack.push({ id: d, i: 0, deps: null, best: 0 }); }
      } else {
        depth.set(f.id, f.best);
        visiting.delete(f.id);
        stack.pop();
        if (stack.length) { const parent = stack[stack.length - 1]; parent.best = Math.max(parent.best, f.best + 1); }
      }
    }
  }
  return depth;
}

export async function runDetail(project, runId) {
  if (!RUN_ID.test(String(runId))) return null;
  const dir = path.join(project.root, '.swarm', 'runs', runId);
  let folder;
  try { folder = await fs.lstat(dir); } catch { return null; }
  if (folder.isSymbolicLink() || !folder.isDirectory()) return null;
  let state, manifest = null;
  try { state = await readJson(path.join(dir, 'state.json')); } catch { return null; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  try { manifest = await readJson(path.join(dir, 'manifest.json')); } catch (error) {
    if (error?.code === 'ENOENT') { /* an old run may have no manifest: the graph then has no edges */ }
    else if (error instanceof SyntaxError) console.error('[tools/board-run.mjs] corrupt manifest.json (SyntaxError)');
    else console.error('[tools/board-run.mjs] read manifest.json:', error?.message ?? error);
  }
  const after = new Map((Array.isArray(manifest?.jobs) ? manifest.jobs : []).map(j => [String(j?.id), Array.isArray(j?.after) ? j.after.map(String) : []]));
  const jobs = (Array.isArray(state.jobs) ? state.jobs : []).filter(j => j && typeof j === 'object' && !Array.isArray(j)).slice(0, MAX_JOBS).map(j => {
    const attempts = Array.isArray(j.attempts) ? j.attempts : [];
    const usd = jobSpend(j).usd;
    const queued = iso(j.queuedAt), started = iso(j.startedAt), finished = iso(j.finishedAt);
    return {
      id: txt(j.id, 60), lane: laneLabel(j.agent, j.model), agent: txt(j.agent, 30), model: txt(j.model, 60), status: txt(j.status, 20),
      after: (after.get(String(j.id)) ?? []).slice(0, 50).map(d => txt(d, 60)),
      queuedAt: queued, startedAt: started, finishedAt: finished, durationMs: Number.isFinite(j.durationMs) ? j.durationMs : null,
      costUsd: usd, costSource: txt(j.costSource, 30),
      // Run again = the job was tried more than once (a retry, or sent up to another lane): each attempt is in the run's own record.
      attempts: attempts.slice(0, 8).map(a => ({ lane: laneLabel(a.agent, a.model), status: txt(a.status, 20), error: a.error ? txt(a.error, 160) : null })),
      rerun: attempts.length > 1,
      error: j.error ? txt(j.error, 200) : null,
    };
  });
  const layers = layersOf(jobs);
  for (const j of jobs) j.layer = layers.get(j.id) ?? 0;
  // The journal: every recorded time of every job, in order. Cost is shown where the job finished (the run records it per job, not per attempt).
  const journal = [];
  for (const j of jobs) {
    if (j.queuedAt) journal.push({ at: j.queuedAt, job: j.id, lane: j.lane, event: 'queued' });
    if (j.startedAt) journal.push({ at: j.startedAt, job: j.id, lane: j.lane, event: 'started' });
    if (j.finishedAt) journal.push({ at: j.finishedAt, job: j.id, lane: j.lane, event: j.status === 'complete' ? 'finished' : (j.status ?? 'ended'), usd: j.costUsd, rerun: j.rerun, error: j.error });
  }
  // At the same instant: queued, then started, then ended; then by job id. A fixed order, so the replay is the same every time.
  const rank = e => (e.event === 'queued' ? 0 : e.event === 'started' ? 1 : 2);
  journal.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rank(a) - rank(b) || (String(a.job) < String(b.job) ? -1 : String(a.job) > String(b.job) ? 1 : 0)));
  const byStatus = dict();
  for (const j of jobs) byStatus[j.status ?? 'unknown'] = (byStatus[j.status ?? 'unknown'] ?? 0) + 1;
  const totalUsd = jobs.reduce((s, j) => s + (j.costUsd ?? 0), 0);
  const lanes = dict();
  for (const j of jobs) { const l = lanes[j.lane] ??= { jobs: 0, usd: 0 }; l.jobs += 1; l.usd += j.costUsd ?? 0; }
  // The Claude Code sessions driving this project (the Orchestrator lane), so a run page shows everything working in one place.
  const orchestrator = (() => { try { return projectOrchestrator(project, { runs: [] }).sessions; } catch { return []; } })();
  return {
    orchestrator,
    runId: txt(runId, 120), projectId: project.id, project: txt(project.name, 80), status: txt(state.status, 30),
    startedAt: iso(state.startedAt), finishedAt: iso(state.finishedAt),
    durationMs: iso(state.startedAt) && iso(state.finishedAt) ? Date.parse(state.finishedAt) - Date.parse(state.startedAt) : null,
    budgetUsd: Number.isFinite(state.budget?.maxUsd) ? state.budget.maxUsd : null,
    hasGraph: after.size > 0 && jobs.some(j => j.after.length),
    totals: { jobs: jobs.length, byStatus: plain(byStatus), usd: Math.round(totalUsd * 1e6) / 1e6, rerun: jobs.filter(j => j.rerun).length },
    lanes: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, { jobs: v.jobs, usd: Math.round(v.usd * 1e6) / 1e6 }])),
    jobs, journal: journal.slice(0, 6000), layers: Math.max(-1, ...jobs.map(j => j.layer)) + 1,
  };
}

// Two runs side by side: totals, lanes and the jobs they share (a job id that appears in both: its status, time and cost in each).
export function compareRuns(a, b) {
  if (!a || !b) return null;
  const byId = new Map(b.jobs.map(j => [j.id, j]));
  const shared = a.jobs.filter(j => byId.has(j.id)).map(j => {
    const o = byId.get(j.id);
    return { id: j.id, a: { status: j.status, durationMs: j.durationMs, costUsd: j.costUsd, rerun: j.rerun }, b: { status: o.status, durationMs: o.durationMs, costUsd: o.costUsd, rerun: o.rerun } };
  });
  const laneNames = [...new Set([...Object.keys(a.lanes), ...Object.keys(b.lanes)])].sort();
  const pick = r => ({ runId: r.runId, status: r.status, startedAt: r.startedAt, durationMs: r.durationMs, totals: r.totals, budgetUsd: r.budgetUsd });
  return { a: pick(a), b: pick(b), lanes: laneNames.map(l => ({ lane: l, a: a.lanes[l] ?? null, b: b.lanes[l] ?? null })), shared: shared.slice(0, 500), onlyA: a.jobs.filter(j => !byId.has(j.id)).length, onlyB: b.jobs.length - shared.length };
}
