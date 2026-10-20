// SPDX-License-Identifier: Apache-2.0
// The live project overview: every run that is alive in ONE project, combined. The numbers come from the same run files the run pages read
// (state.json, manifest.json, through buildRunSnapshot), so a number here is the sum of the numbers on those pages. Nothing is estimated beyond
// what a run page already estimates; with nothing running it says so and shows what the project did last.
import { buildRunSnapshot } from './watch-state.mjs';
import { readRunStates, laneLabel, agentState, costOf } from './board-data.mjs';
import { runTotals } from './spend.mjs';
import { readLedger } from './tickets.mjs';
import { projectSummary } from './project-spend.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';
import { projectOrchestrator } from './board-orchestrator.mjs';

const txt = (v, n = 160) => (v === null || v === undefined ? null : sanitizeWorkerText(v, n));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const BLOCKED = new Set(['held', 'blocked']);
const MAP_CAP = 3000;          // squares on the combined map
const AGENT_CAP = 200;         // heads in all
const LANE_CAP = 12;           // bays; further lane names are folded into 'other'
const RECENT_CAP = 12;
const KNOWN_STATUS = new Set(['queued', 'running', 'complete', 'failed', 'timeout', 'held', 'blocked', 'cancelled']);
export const FINISHED = new Set(['complete', 'integrated', 'integrated-with-failures', 'failed', 'cancelled', 'error', 'timeout']);

const short = id => String(id).replace(/^(\d{4})\d{9}-/, '').slice(0, 14);

// Pure: the combined view of the runs given. `runs` are { id, state, manifest } for the runs alive now; `finishedToday` the same for runs that ended today.
export function combineLive({ project, runs, finishedToday = [], tickets = [], cost = null, capUsd = null, capError = null, lastActivityAt = null, now = Date.now() }) {
  const byTicket = new Map(tickets.filter(t => t && typeof t.id === 'string').map(t => [t.id, t]));
  const ordered = runs.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const jobsTotal = { running: 0, queued: 0, blocked: 0 };
  const stats = { done: 0, total: 0, running: 0, queued: 0, failed: 0, retries: 0, finished: 0, firstTry: 0, merged: 0, queue: 0, conflicts: 0 };
  const laneAgents = new Map();
  const laneCount = new Map();
  let heads = 0;
  const map = [];
  const runRows = [];
  const endedHere = [];   // a run whose process is still winding down but whose state says it is over: Recent, not Live, and not in the live numbers
  let etaMs = 0, etaKnown = true;
  ordered.forEach((run, idx) => {
    const snap = buildRunSnapshot(run.state, { manifest: run.manifest, now });
    if (snap.status !== 'live' && snap.status !== 'paused') { endedHere.push(run); return; }
    const jobs = Array.isArray(run.state.jobs) ? run.state.jobs.filter(j => j && typeof j === 'object') : [];
    const validIds = new Set(snap.jobs.map(j => j.id));
    for (const j of snap.jobs) {
      const st = j.status;
      if (st === 'running') jobsTotal.running += 1;
      else if (st === 'queued') jobsTotal.queued += 1;
      else if (BLOCKED.has(st)) jobsTotal.blocked += 1;
      const done = st === 'complete';
      const failed = st === 'failed' || st === 'timeout';
      if (done || failed) { stats.finished += 1; if (done && j.attempts <= 1) stats.firstTry += 1; }
      if (map.length < MAP_CAP) map.push({ run: run.id, idx, job: j.id, status: KNOWN_STATUS.has(st) ? st : 'other', lane: txt(laneLabel(j.agent, j.model), 20) });
    }
    for (const raw of jobs) {
      const id = txt(raw.id, 60);
      if (!validIds.has(id)) continue;   // the same jobs the counts use: no head for a job the numbers skip
      const st = agentState(raw, now);
      if (!st) continue;
      let label = txt(laneLabel(raw.agent, raw.model), 20);
      if (!laneCount.has(label) && laneCount.size >= LANE_CAP) label = 'other';
      laneCount.set(label, (laneCount.get(label) ?? 0) + 1);
      if (heads >= AGENT_CAP) continue;
      heads += 1;
      const t = byTicket.get(id);
      const list = laneAgents.get(label) ?? [];
      list.push({ run: run.id, runShort: short(run.id), idx, job: id, ticket: t ? txt(t.id, 20) : null, title: t ? txt(t.title, 100) : null, state: st, since: raw.startedAt ?? null, ...(st === 'error' ? { ended: raw.finishedAt ?? null } : {}) });
      laneAgents.set(label, list);
    }
    stats.done += snap.kpi.done; stats.total += snap.kpi.total; stats.running += snap.kpi.running; stats.queued += snap.kpi.queued;
    stats.failed += snap.kpi.failed; stats.retries += snap.kpi.retries;
    stats.merged += snap.mergeQueue?.integrated ?? 0; stats.queue += snap.mergeQueue?.batches ?? 0; stats.conflicts += snap.mergeQueue?.conflicts ?? 0;
    // Runs go on side by side, so all of them are done when the slowest is: the largest of the runs' own estimates. Unknown if a run has none, or is paused (not progressing).
    if (snap.status === 'paused' || snap.kpi.etaMs === null) etaKnown = false; else etaMs = Math.max(etaMs, snap.kpi.etaMs);
    const mine = jobs.map(j => txt(j.id, 60)).filter(id => byTicket.has(id));
    runRows.push({
      runId: run.id, short: short(run.id), idx, status: snap.status, startedAt: snap.startedAt, elapsedMs: snap.elapsedMs, branch: snap.branch,
      goal: snap.goal, tickets: mine.slice(0, 3), ticketCount: mine.length,
      done: snap.kpi.done, total: snap.kpi.total, running: snap.kpi.running, queued: snap.kpi.queued, failed: snap.kpi.failed,
      spendUsd: Math.round(runTotals(run.state).usd * 1e6) / 1e6, etaMs: snap.kpi.etaMs,
    });
  });
  const lanes = [...laneAgents.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([lane, agents]) => ({ lane, count: laneCount.get(lane) ?? agents.length, agents }));
  // Recent: the runs that ended (newest first), snapshots only for the few shown. Spend is the run's own total, the number the Overview tab uses.
  const ended = [...endedHere, ...finishedToday].sort((a, b) => (Date.parse(b.state.finishedAt ?? '') || 0) - (Date.parse(a.state.finishedAt ?? '') || 0));
  const recent = ended.slice(0, RECENT_CAP).map(({ id, state }) => {
    const jobs = (state.jobs ?? []).filter(j => j && typeof j === 'object');
    const snap = buildRunSnapshot(state, { now });
    return { runId: id, short: short(id), status: snap.status, result: txt(state.status, 30), finishedAt: state.finishedAt ?? null, done: snap.kpi.done, total: jobs.length, failed: snap.kpi.failed, costUsd: Math.round(runTotals(state).usd * 1e6) / 1e6 };
  });
  return {
    project: { id: project.id, name: txt(project.name, 80) },
    now: new Date(now).toISOString(),
    empty: runRows.length === 0 ? { lastActivityAt } : null,
    header: {
      jobs: jobsTotal, runsLive: runRows.length,
      spendTodayUsd: cost ? cost.todayUsd : null, spendUsd: cost ? cost.allUsd : null, capUsd, noCap: capUsd === null && !capError, capInvalid: Boolean(capError),
      etaMs: runRows.length ? (etaKnown ? etaMs : null) : null,
    },
    runs: runRows,
    lanes,
    map,
    mapTruncated: runRows.reduce((n, r) => n + r.total, 0) > map.length,
    stats: { ...stats, firstTryRate: stats.finished ? stats.firstTry / stats.finished : null },
    recent,
    finishedCount: ended.length,
  };
}

// The IO around it: reads this project's own folder only. `liveRuns` are the alive runs of this project (their process exists).
export async function liveOverview(project, liveRuns, { now = Date.now(), summary = projectSummary, readManifest } = {}) {
  const all = await readRunStates(project.root, { limit: 400 });
  const liveIds = new Set(liveRuns.map(r => r.runId));
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const manifestOf = readManifest ?? (async id => { try { return JSON.parse(await fs.readFile(path.join(project.root, '.swarm', 'runs', id, 'manifest.json'), 'utf8')); } catch { return null; } });
  const live = [];
  for (const r of all.filter(x => liveIds.has(x.id))) live.push({ id: r.id, state: r.state, manifest: await manifestOf(r.id) });
  const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
  const finishedToday = all.filter(r => !liveIds.has(r.id) && FINISHED.has(r.state.status) && (Date.parse(r.state.finishedAt ?? '') || 0) >= startOfDay.getTime());
  const ledger = await readLedger(project.root).catch(() => null);
  const spend = await summary(project.root).catch(error => ({ capUsd: null, capError: String(error.message).slice(0, 120) }));
  const lastMs = Math.max(0, ...all.map(r => r.mtimeMs), Date.parse(ledger?.updatedAt ?? '') || 0);
  const orchestrator = (() => { try { return projectOrchestrator(project, { runs: all, now }); } catch { return null; } })();
  const combined = combineLive({
    project, runs: live, finishedToday, tickets: (ledger?.tickets ?? []).filter(t => t && typeof t === 'object').slice(0, 2000),
    cost: costOf(all, now), capUsd: spend.capUsd ?? null, capError: spend.capError ?? null, lastActivityAt: lastMs ? new Date(lastMs).toISOString() : null, now,
  });
  return { ...combined, orchestrator };
}
