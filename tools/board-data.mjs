// SPDX-License-Identifier: Apache-2.0
// What the Swarm Watch board shows: one lane per registered project, with machine-wide totals above them.
// Everything is read from the project's own folder (its run states, ticket ledger, lessons) and nothing is ever mixed across projects:
// each function takes ONE project and reads only under its root. The machine-wide numbers are sums of the per-project numbers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runTotals, jobSpend, laneDayTotals } from './spend.mjs';
import { readLedger } from './tickets.mjs';
import { projectSummary } from './project-spend.mjs';
import { listLessons } from './lesson-store.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';
import os from 'node:os';

const DAY = 86400000;
const FLAT_RATE = new Set(['codex', 'cursor', 'claude', 'hermes', 'qwen']);   // subscription lanes: not billed per use
const ESTIMATED = new Set(['estimated-from-tokens', 'reservation']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const txt = (v, n = 160) => (v === null || v === undefined ? null : sanitizeWorkerText(v, n));
// Maps keyed by text from run files (lane names, statuses, project names) have no prototype: a lane called __proto__ or constructor must not reach Object.prototype.
const dict = () => Object.create(null);
// What leaves the module is an ordinary object again (Object.fromEntries defines each key as an own property, even one called __proto__).
const plain = d => Object.fromEntries(Object.entries(d));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// The name the board uses for a worker: Haiku, Sonnet, Opus, Codex, Cursor, GPU (our own or rented GPUs and local models).
export function laneLabel(agent, model) {
  const m = String(model ?? '').toLowerCase();
  if (['anthropic', 'claude'].includes(agent)) return m.includes('haiku') ? 'Haiku' : m.includes('sonnet') ? 'Sonnet' : m.includes('opus') ? 'Opus' : 'Claude';
  if (agent === 'codex') return 'Codex';
  if (agent === 'cursor') return 'Cursor';
  if (['rented', 'ollama', 'lambda'].includes(agent)) return 'GPU';
  return agent ? String(agent).slice(0, 20) : 'other';
}

// Parsed run states are remembered by path, size and modification time: a poll costs one stat per run, and a run that finished is read once.
const stateCache = new Map();
async function readRunStates(root, { limit = 5000 } = {}) {
  const dir = path.join(root, '.swarm', 'runs');
  let ids = [];
  try { ids = (await fs.readdir(dir)).filter(id => RUN_ID.test(id)).sort().slice(-limit); } catch { return []; }
  const runs = [];
  for (const id of ids) {
    try {
      const folder = await fs.lstat(path.join(dir, id));
      if (folder.isSymbolicLink() || !folder.isDirectory()) continue;
      const file = path.join(dir, id, 'state.json');
      const stat = await fs.stat(file);
      let hit = stateCache.get(file);
      if (!hit || hit.size !== stat.size || hit.mtimeMs !== stat.mtimeMs) {
        const state = JSON.parse(await fs.readFile(file, 'utf8'));
        hit = { size: stat.size, mtimeMs: stat.mtimeMs, state: state && typeof state === 'object' && !Array.isArray(state) && (state.jobs === undefined || Array.isArray(state.jobs)) ? state : null };
        if (stateCache.size > 20000) stateCache.clear();
        stateCache.set(file, hit);
      }
      if (hit.state) runs.push({ id, state: hit.state, mtimeMs: stat.mtimeMs });
    } catch { /* an unreadable run is not counted here; projectSummary reports it */ }
  }
  return runs;
}

const stageNumber = stage => { const m = /^S(\d+)$/.exec(String(stage ?? '')); return m ? Number(m[1]) : null; };

// Money for one project: the total is exactly what runTotals gives for every run (the number the project cap uses); today and the last 7 days
// split the same jobs by when they finished (a rental's dollars go to the day its run finished). `paid` lanes bill per use; flat-rate lanes
// (Codex, Cursor, Claude subscription) show their list-price value only, they cost nothing extra.
export function costOf(runs, now = Date.now()) {
  const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
  const out = { allUsd: 0, todayUsd: 0, weekUsd: 0, paidUsd: 0, paidEstimatedUsd: 0, flatRateListUsd: 0, flatRateJobs: 0 };
  const laneToday = dict();   // by agent lane: what jobs that finished today cost (billed lanes) or are worth at list price (flat-rate lanes)
  for (const { state } of runs) {
    out.allUsd += runTotals(state).usd;
    const rentalUsd = num(state.rental?.usd);
    const runDay = Date.parse(state.finishedAt ?? state.startedAt ?? '');
    // Today and the last 7 days count what is BILLED (per-use lanes and rented GPUs); flat-rate lanes show only in the all-time list value.
    const add = (usd, at) => { if (at >= startOfDay.getTime()) out.todayUsd += usd; if (at >= now - 7 * DAY) out.weekUsd += usd; };
    if (rentalUsd) { out.paidUsd += rentalUsd; if (Number.isFinite(runDay)) add(rentalUsd, runDay); }
    for (const job of state.jobs ?? []) {
      if (!job || typeof job !== 'object') continue;
      const usd = num(jobSpend(job).usd);
      if (!usd) { if (FLAT_RATE.has(job.agent) && job.status === 'complete') out.flatRateJobs += 1; continue; }
      const at = Date.parse(job.finishedAt ?? '') || runDay;
      if (Number.isFinite(at) && at >= startOfDay.getTime() && job.agent) laneToday[job.agent] = (laneToday[job.agent] ?? 0) + usd;
      if (FLAT_RATE.has(job.agent)) { out.flatRateListUsd += usd; out.flatRateJobs += 1; }
      else { out.paidUsd += usd; if (ESTIMATED.has(job.costSource)) out.paidEstimatedUsd += usd; if (Number.isFinite(at)) add(usd, at); }
    }
  }
  for (const key of Object.keys(out)) if (key.endsWith('Usd')) out[key] = Math.round(out[key] * 1e6) / 1e6;
  out.laneToday = Object.fromEntries(Object.entries(laneToday).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));
  return out;
}

// What an agent is doing, from what the run recorded about its job (never guessed): running with output in the last 90 seconds is "working"; running with
// no output yet, or quiet for longer, is "thinking" (it started and has not answered); a job that failed or timed out in the last 10 minutes is "error".
export const WORKING_MS = 90 * 1000;
export const ERROR_SHOWN_MS = 10 * 60 * 1000;
export function agentState(job, now = Date.now()) {
  if (job?.status === 'running') {
    const last = Date.parse(job.progress?.lastOutputAt ?? '');
    return Number.isFinite(last) && now - last <= WORKING_MS ? 'working' : 'thinking';
  }
  if (job?.status === 'failed' || job?.status === 'timeout') {
    const finished = Date.parse(job.finishedAt ?? '');
    return Number.isFinite(finished) && now - finished <= ERROR_SHOWN_MS ? 'error' : null;
  }
  return null;
}

// The workers running right now in the runs that are really alive (their process exists), by lane label, and one entry per agent (running, or just failed).
export function agentsOf(runs, liveIds, now = Date.now()) {
  const byLane = dict();
  const jobs = { running: 0, queued: 0, blocked: 0 };
  const list = [];
  for (const { id, state } of runs) {
    if (!liveIds.has(id)) continue;
    for (const job of state.jobs ?? []) {
      if (!job || typeof job !== 'object') continue;
      const label = laneLabel(job.agent, job.model);
      const st = agentState(job, now);
      if (st) list.push({ runId: id, jobId: txt(job.id, 60), lane: label, agent: txt(job.agent, 30), state: st, since: job.startedAt ?? null, ...(st === 'error' ? { ended: job.finishedAt ?? null } : {}) });
      if (job.status === 'running') { byLane[label] = (byLane[label] ?? 0) + 1; jobs.running += 1; }
      else if (job.status === 'queued') jobs.queued += 1;
      else if (job.status === 'held' || job.status === 'blocked') jobs.blocked += 1;
    }
  }
  return { total: jobs.running, byLane: plain(byLane), jobs, list: list.slice(0, 200) };
}

export function ticketsOf(ledger) {
  const tickets = (ledger?.tickets ?? []).filter(t => t && typeof t === 'object');
  const byStatus = dict();
  for (const t of tickets) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const open = tickets.filter(t => ['todo', 'ready', 'running', 'review', 'blocked'].includes(t.status));
  const stages = open.map(t => stageNumber(t.stage)).filter(n => n > 0);
  const stage = !tickets.length ? null : stages.length ? `S${Math.min(...stages)}` : (tickets.some(t => stageNumber(t.stage) > 0) ? 'done' : null);
  return { total: tickets.filter(t => !['cancelled', 'proposed'].includes(t.status)).length, open: open.length, blocked: byStatus.blocked ?? 0, proposed: byStatus.proposed ?? 0, byStatus: plain(byStatus), stage };
}

// One project's lane on the board. `liveRuns` are the alive runs of THIS project only.
export async function projectOverview(project, liveRuns, { now = Date.now(), summary = projectSummary } = {}) {
  const runs = await readRunStates(project.root);
  const liveIds = new Set(liveRuns.map(r => r.runId));
  const ledger = await readLedger(project.root).catch(() => null);
  const spend = await summary(project.root).catch(error => ({ spendUsd: null, capUsd: null, capError: String(error.message).slice(0, 120) }));
  const cost = costOf(runs, now);
  const agents = agentsOf(runs, liveIds, now);
  const lastRun = runs.length ? runs[runs.length - 1].state : null;
  const lastActivityMs = Math.max(0, ...runs.map(r => r.mtimeMs), Date.parse(ledger?.updatedAt ?? '') || 0);
  const tickets = ticketsOf(ledger);
  return {
    id: project.id, name: txt(project.name, 80), root: project.root,
    stage: tickets.stage, tickets,
    live: liveRuns.map(r => { const hit = runs.find(x => x.id === r.runId); const jobs = hit?.state.jobs ?? []; return { runId: r.runId, startedAt: r.startedAt ?? null, status: txt(hit?.state.status ?? 'running', 30), jobs: jobs.length, done: jobs.filter(j => j.status === 'complete').length }; }),
    agents, cost,
    spend: { usd: cost.allUsd, capUsd: spend.capUsd ?? null, noCap: spend.capUsd === null || spend.capUsd === undefined ? !spend.capError : false, capInvalid: Boolean(spend.capError), reached: Boolean(spend.reached) },
    lastRunAt: lastRun?.startedAt ?? null,
    lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    idle: liveRuns.length === 0,
  };
}

// The whole board: machine totals (sums of the project numbers) and one overview per registered project.
export async function boardSnapshot({ projects, liveRuns, now = Date.now(), summary, workers = null, lanes = null } = {}) {
  const overviews = [];
  // A live run belongs to the project whose real root it ran in, however the path was spelled.
  const live = await Promise.all(liveRuns.map(async r => ({ ...r, root: await fs.realpath(r.root).catch(() => r.root) })));
  for (const project of projects) {
    const mine = live.filter(r => r.root === project.root);
    overviews.push(await projectOverview(project, mine, { now, summary }));
  }
  const machine = { agents: { total: 0, byLane: dict(), byProject: dict(), list: [] }, cost: { todayUsd: 0, weekUsd: 0, allUsd: 0, paidUsd: 0, paidEstimatedUsd: 0, flatRateListUsd: 0, byProject: {} }, liveRuns: 0 };
  for (const o of overviews) {
    machine.agents.total += o.agents.total;
    machine.agents.byProject[o.id] = o.agents.total;
    for (const a of o.agents.list ?? []) machine.agents.list.push({ ...a, projectId: o.id, project: o.name });
    for (const [lane, n] of Object.entries(o.agents.byLane)) machine.agents.byLane[lane] = (machine.agents.byLane[lane] ?? 0) + n;
    for (const key of ['todayUsd', 'weekUsd', 'allUsd', 'paidUsd', 'paidEstimatedUsd', 'flatRateListUsd']) machine.cost[key] += o.cost[key];
    for (const [agent, usd] of Object.entries(o.cost.laneToday ?? {})) (machine.cost.laneToday ??= dict())[agent] = (machine.cost.laneToday[agent] ?? 0) + usd;
    machine.cost.byProject[o.id] = { name: o.name, ...o.cost };
    machine.liveRuns += o.live.length;
  }
  for (const key of ['todayUsd', 'weekUsd', 'allUsd', 'paidUsd', 'paidEstimatedUsd', 'flatRateListUsd']) machine.cost[key] = Math.round(machine.cost[key] * 1e6) / 1e6;
  machine.agents.byLane = plain(machine.agents.byLane);
  machine.agents.byProject = plain(machine.agents.byProject);
  if (machine.cost.laneToday) machine.cost.laneToday = plain(machine.cost.laneToday);
  machine.workers = workers;
  machine.lanes = lanes ? await lanes(machine.cost.laneToday ?? {}) : [];
  return { at: new Date(now).toISOString(), machine, projects: overviews };
}

// One project's page: its tickets by status, its run history, its spend by lane and its lessons. Reads only under project.root.
export async function projectDetail(project, { now = Date.now(), liveRunIds = new Set() } = {}) {
  const runs = await readRunStates(project.root, { limit: 200 });
  const ledger = await readLedger(project.root).catch(() => null);
  const tickets = (ledger?.tickets ?? []).filter(t => t && typeof t === 'object').slice(0, 1000).map(t => ({ id: txt(t.id, 20), title: txt(t.title, 140), status: txt(t.status, 20), stage: txt(t.stage, 10), risk: txt(t.risk, 10) }));
  const byLane = dict();
  for (const { state } of runs) for (const job of state.jobs ?? []) { if (!job || typeof job !== 'object') continue; const usd = num(jobSpend(job).usd); if (!usd) continue; const label = laneLabel(job.agent, job.model); byLane[label] = Math.round(((byLane[label] ?? 0) + usd) * 1e6) / 1e6; }
  const lessons = await listLessons(project.root).then(r => r.lessons.slice(0, 200).map(l => ({ id: txt(l.id, 40), what: txt(l.what ?? l.title ?? l.rule, 200), stage: txt(l.stage, 20), status: txt(l.guard?.status ?? l.status, 20) })), () => []);
  return {
    id: project.id, name: txt(project.name, 80), root: project.root,
    tickets, ticketCounts: ticketsOf(ledger),
    runs: runs.slice().reverse().map(({ id, state }) => {
      const jobs = state.jobs ?? [];
      return { runId: id, status: txt(state.status, 30), live: liveRunIds.has(id), startedAt: state.startedAt ?? null, finishedAt: state.finishedAt ?? null, jobs: jobs.length, done: jobs.filter(j => j.status === 'complete').length, failed: jobs.filter(j => ['failed', 'timeout'].includes(j.status)).length, costUsd: Math.round(runTotals(state).usd * 1e6) / 1e6 };
    }),
    spend: { ...costOf(runs, now), byLane: plain(byLane) },
    lessons,
  };
}

// Backfill for the history log from what is on disk (runs, spend, lessons, stages): events carry keys, so running it again adds nothing new.
export async function historyEventsOf(project) {
  const events = [];
  const base = { project: project.name, projectId: project.id };
  events.push({ ...base, kind: 'project', key: `project:${project.id}`, at: project.addedAt, title: `Project ${project.name} registered` });
  const runs = await readRunStates(project.root, { limit: 1000 });
  for (const { id, state } of runs) {
    // A run that is still going is written by its own finish hook, with its final status and spend: backfilling it now would lock in a half-written entry.
    if (!['complete', 'failed', 'cancelled'].includes(state.status)) continue;
    const jobs = state.jobs ?? [];
    events.push({ ...base, kind: 'run', key: `run:${project.id}:${id}`, at: state.startedAt, run: id, ref: id, title: `Run ${id}: ${state.status ?? 'unknown'}, ${jobs.filter(j => j.status === 'complete').length}/${jobs.length} jobs` });
    const usd = runTotals(state).usd;
    if (usd > 0) events.push({ ...base, kind: 'spend', key: `spend:${project.id}:${id}`, at: state.finishedAt ?? state.startedAt, run: id, usd, title: `Run ${id} spent $${usd.toFixed(2)}` });
  }
  const ledger = await readLedger(project.root).catch(() => null);
  const live = (ledger?.tickets ?? []).filter(t => !['cancelled', 'proposed'].includes(t.status));
  for (const stage of [...new Set(live.map(t => t.stage).filter(s => stageNumber(s) > 0))]) {
    const mine = live.filter(t => t.stage === stage);
    if (mine.every(t => t.status === 'done')) events.push({ ...base, kind: 'stage', key: `stage:${project.id}:${stage}`, at: ledger.updatedAt, ref: stage, title: `Stage ${stage} done (${mine.length} tickets)` });
  }
  const { lessons } = await listLessons(project.root).catch(() => ({ lessons: [] }));
  for (const l of lessons) events.push({ ...base, kind: 'lesson', key: `lesson:${project.id}:${l.id}`, at: l.date ?? l.at ?? project.addedAt, ref: String(l.id), title: `Lesson ${l.id}: ${l.what ?? l.title ?? l.rule ?? ''}` });
  return events.filter(e => e.at);
}

// Who holds the machine's workers right now: the slots in the shared lane store, by project and lane (the project a slot was claimed for is recorded on it).
// A slot whose process is gone is not counted. `max` is the machine-wide limit (null: none), `demand` what projects are waiting for.
export async function workersHeld({ dir, max = null, invalid = false, isAlive: probe = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } } } = {}) {
  const seen = new Map();
  const isAlive = pid => { if (!seen.has(pid)) seen.set(pid, probe(pid)); return seen.get(pid); };
  let store = null;
  try { store = JSON.parse(await fs.readFile(path.join(dir, 'lanes.json'), 'utf8')); } catch { /* no workers have ever been claimed */ }
  const host = os.hostname();
  const byProject = dict();
  let total = 0;
  for (const [agent, slots] of Object.entries(store?.slots ?? {})) {
    for (const slot of Array.isArray(slots) ? slots : []) {
      if (!slot || (slot.host === host && !isAlive(slot.pid))) continue;
      const key = typeof slot.project === 'string' && slot.project ? slot.project : 'unknown';
      const lane = agent === 'anthropic' ? 'Anthropic API' : laneLabel(agent, null);
      const entry = byProject[key] ??= { total: 0, byLane: dict() };
      entry.total += 1; entry.byLane[lane] = (entry.byLane[lane] ?? 0) + 1; total += 1;
    }
  }
  const demand = dict();
  // Waiting entries are per run and lane; the board shows them per project, and only the fresh ones (a waiting run refreshes its entry every poll).
  for (const entry of Object.values(store?.demand ?? {})) {
    if (!entry || typeof entry.project !== 'string' || !Number.isInteger(entry.count) || entry.count <= 0 || !(Date.now() - entry.at <= 5000) || (entry.host === host && !isAlive(entry.pid))) continue;
    demand[entry.project] = (demand[entry.project] ?? 0) + entry.count;
  }
  for (const entry of Object.values(byProject)) entry.byLane = plain(entry.byLane);
  return { max, ...(invalid ? { invalid: true } : {}), total, free: max ? Math.max(0, max - total) : null, byProject: plain(byProject), demand: plain(demand) };
}

// Per lane today: what it cost (billed lanes) or is worth at list price (flat-rate lanes), its daily cap and when the cap resets (UTC midnight, the day the
// spend store counts by), and a rate-limit or quota pause with the time it ends. Only lanes with something to say are listed. Read-only.
const PAID = new Set(['openrouter', 'openai', 'gemini', 'lambda', 'anthropic', 'rented']);
export async function laneUsage({ laneToday = {}, spendDirectory, lanesDirectory, caps = {}, now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const midnight = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1);
  let store = null;
  try { store = JSON.parse(await fs.readFile(path.join(spendDirectory, 'daily.json'), 'utf8')); } catch { /* nothing was ever spent */ }
  const spent = store && typeof store.entries === 'object' && store.entries ? laneDayTotals(store, { day }) : {};
  let lanes = null;
  try { lanes = JSON.parse(await fs.readFile(path.join(lanesDirectory, 'lanes.json'), 'utf8')); } catch { /* no lane has been used */ }
  const names = new Set([...Object.keys(laneToday), ...Object.keys(spent), ...Object.keys(caps), ...Object.keys(lanes?.pauses ?? {})]);
  const rows = [];
  for (const agent of [...names].sort()) {
    const paid = PAID.has(agent);
    const todayUsd = Math.round(num(paid ? (spent[agent]?.usd ?? laneToday[agent]) : laneToday[agent]) * 1e6) / 1e6;
    const cap = typeof caps[agent] === 'number' && caps[agent] > 0 ? caps[agent] : null;
    const pause = lanes?.pauses?.[agent];
    const limited = pause && Number.isFinite(pause.until) && pause.until > now ? { state: txt(pause.state, 20), until: new Date(pause.until).toISOString() } : null;
    if (!todayUsd && !cap && !limited) continue;
    rows.push({ lane: txt(agent, 30), label: agent === 'anthropic' ? 'Anthropic API' : laneLabel(agent, null), kind: paid ? 'billed' : 'flat-rate', todayUsd, dailyCapUsd: cap, capResetsAt: cap ? new Date(midnight).toISOString() : null, limited });
  }
  return rows;
}
