// SPDX-License-Identifier: Apache-2.0
// What the Swarm Watch board shows: one lane per registered project, with machine-wide totals above them.
// Everything is read from the project's own folder (its run states, ticket ledger, lessons) and nothing is ever mixed across projects:
// each function takes ONE project and reads only under its root. The machine-wide numbers are sums of the per-project numbers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runTotals, jobSpend, laneDayTotals } from './spend.mjs';
import { readLedger } from './tickets.mjs';
import { mainWorktreeRoot, projectSummary } from './project-spend.mjs';
import { listLessons } from './lesson-store.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';
import os from 'node:os';
import { projectOrchestrator } from './board-orchestrator.mjs';
import { combinedUsage } from './orchestrator-usage.mjs';
import { buildProgress, progressSummary } from './build-progress.mjs';
import { ROUTE_ORDER } from './router.mjs';

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

const KNOWN_IDLE_LANES = Object.freeze(['Haiku', 'Sonnet', 'Opus', 'Codex', 'Cursor', 'GPU']);
const ROUTABLE_AGENTS = new Set(ROUTE_ORDER);
const MODEL_LANES = new Set(['Haiku', 'Sonnet', 'Opus']);
const GPU_AGENTS = new Set(['rented', 'ollama', 'lambda']);
const valueObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
function configuredModelOf(configured, agent) { return valueObject(configured)[agent]; }
function idleLabelForAgent(agent, configured) { return laneLabel(agent, configuredModelOf(configured, agent)); }
function idleAgentsForLabel(label) {
  if (label === 'Codex') return ['codex'];
  if (label === 'Cursor') return ['cursor'];
  if (MODEL_LANES.has(label) || label === 'Claude') return ['anthropic', 'claude'];
  if (label === 'GPU') return [...GPU_AGENTS];
  return [label];
}
function idleCountdown(until, now) {
  const seconds = Math.max(1, Math.ceil((until - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest ? ` ${rest}m` : ''}`;
}
function idleMoney(value) {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 1000000) / 1000000);
}

// Why an empty bay is empty. This deliberately uses only the caller's snapshots: it never
// probes a provider or changes lane state while the read-only board is being rendered.
export function laneIdleReasons({ running = {}, configured = {}, pauses = {}, demand = {}, caps = {}, todayUsd = {}, queued = {}, recent = {}, now = Date.now() } = {}) {
  const inputs = [configured, pauses, demand, caps, todayUsd, queued, recent];
  const labels = new Set(KNOWN_IDLE_LANES);
  for (const label of Object.keys(valueObject(running))) labels.add(label);
  for (const input of inputs) {
    for (const agent of Object.keys(valueObject(input))) {
      if (agent !== 'auto') labels.add(idleLabelForAgent(agent, configured));
    }
  }
  const configuredEntries = Object.entries(valueObject(configured)).filter(([, model]) => typeof model === 'string' && model.length > 0);
  const out = {};
  for (const label of labels) {
    if (Number(valueObject(running)[label]) > 0) continue;
    const agents = idleAgentsForLabel(label);
    let answer = null;
    for (const agent of agents) {
      const pause = valueObject(pauses)[agent];
      if (pause && Number.isFinite(pause.until) && pause.until > now) {
        const rate = pause.state === 'backoff';
        answer = { reason: rate ? 'rate-limited' : 'paused', text: `${rate ? 'rate limited' : 'quota paused'}, back in ${idleCountdown(pause.until, now)}`, until: new Date(pause.until).toISOString() };
        break;
      }
    }
    if (!answer) {
      for (const agent of agents) {
        const cap = Number(valueObject(caps)[agent]);
        const spent = Number(valueObject(todayUsd)[agent]);
        if (cap > 0 && Number.isFinite(spent) && spent >= cap) {
          const tomorrow = new Date(now);
          tomorrow.setUTCHours(0, 0, 0, 0);
          tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
          answer = { reason: 'daily-cap', text: `daily cap reached ($${idleMoney(spent)} of $${idleMoney(cap)})`, until: tomorrow.toISOString() };
          break;
        }
      }
    }
    const configuredAgents = agents.filter(agent => configuredEntries.some(([name]) => name === agent));
    if (!answer && configuredAgents.length === 0) {
      answer = { reason: 'not-set-up', text: label === 'GPU' ? 'no GPU configured' : 'not set up (no model in local config)' };
    }
    if (!answer) {
      for (const agent of agents) {
        const count = Number(valueObject(demand)[agent]);
        if (count > 0) { answer = { reason: 'waiting-slot', text: `${count} job${count === 1 ? '' : 's'} waiting for a slot` }; break; }
      }
    }
    if (!answer) {
      for (const agent of agents) {
        const count = Number(valueObject(queued)[agent]);
        if (count > 0) { answer = { reason: 'queued', text: `${count} queued, starting soon` }; break; }
      }
    }
    if (!answer && (label === 'Cursor' || label === 'Codex') && Number(valueObject(queued).auto) > 0) {
      const count = Number(valueObject(queued).auto);
      answer = { reason: 'routing', text: `${count} auto job${count === 1 ? '' : 's'} not routed yet` };
    }
    if (!answer && MODEL_LANES.has(label) && configuredAgents.length === 1 && configuredAgents[0] === 'claude') {
      answer = { reason: 'not-routed', text: 'only for expensive tier or after 2 failures' };
    }
    if (!answer) {
      for (const agent of configuredAgents) {
        if (agent !== 'hermes' && !ROUTABLE_AGENTS.has(agent)) {
          answer = { reason: 'not-routed', text: 'not in auto routing; only explicit jobs' };
          break;
        }
        if (agent === 'hermes') {
          answer = { reason: 'not-routed', text: 'research job type only' };
          break;
        }
      }
    }
    if (!answer) {
      let recentLabel = null;
      if (label === 'Codex' || label === 'Cursor') {
        const other = label === 'Codex' ? 'Cursor' : 'Codex';
        for (const [agent, value] of Object.entries(valueObject(recent))) {
          if (idleLabelForAgent(agent, configured) !== other) continue;
          const jobs = Number(value?.jobs);
          const explicit = Number(value?.explicit);
          if (jobs > 0 && explicit >= jobs / 2) { recentLabel = other; break; }
        }
      }
      answer = { reason: 'no-ready-jobs', text: recentLabel ? `no ready jobs; recent jobs named ${recentLabel} explicitly` : 'no ready jobs' };
    }
    out[label] = answer;
  }
  return out;
}

// Parsed run states are remembered by path, size and modification time: a poll costs one stat per run, and a run that finished is read once.
const stateCache = new Map();
export async function readRunStates(root, { limit = 5000 } = {}) {
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
  const out = { allUsd: 0, todayUsd: 0, weekUsd: 0, flatRateTodayUsd: 0, flatRateWeekUsd: 0, paidUsd: 0, paidEstimatedUsd: 0, flatRateListUsd: 0, flatRateJobs: 0 };
  const laneJobs = dict();    // by agent lane: how many jobs finished today, whatever they cost (a flat-rate lane may report no cost at all)
  const laneToday = dict();   // by agent lane: what jobs that finished today cost (billed lanes) or are worth at list price (flat-rate lanes)
  for (const { state } of runs) {
    out.allUsd += runTotals(state).usd;
    const rentalUsd = num(state.rental?.usd);
    const runDay = Date.parse(state.finishedAt ?? state.startedAt ?? '');
    // Today and the last 7 days split BILLED (per-use lanes and rented GPUs) from flat-rate LIST VALUE.
    const addBilled = (usd, at) => { if (at >= startOfDay.getTime()) out.todayUsd += usd; if (at >= now - 7 * DAY) out.weekUsd += usd; };
    const addListValue = (usd, at) => { if (at >= startOfDay.getTime()) out.flatRateTodayUsd += usd; if (at >= now - 7 * DAY) out.flatRateWeekUsd += usd; };
    if (rentalUsd) { out.paidUsd += rentalUsd; if (Number.isFinite(runDay)) addBilled(rentalUsd, runDay); }
    for (const job of state.jobs ?? []) {
      if (!job || typeof job !== 'object') continue;
      const usd = num(jobSpend(job).usd);
      if (job.agent && ['complete', 'failed', 'timeout'].includes(job.status)) {
        const doneAt = Date.parse(job.finishedAt ?? '') || runDay;
        if (Number.isFinite(doneAt) && doneAt >= startOfDay.getTime()) laneJobs[job.agent] = (laneJobs[job.agent] ?? 0) + 1;
      }
      if (!usd) { if (FLAT_RATE.has(job.agent) && job.status === 'complete') out.flatRateJobs += 1; continue; }
      const at = Date.parse(job.finishedAt ?? '') || runDay;
      if (Number.isFinite(at) && at >= startOfDay.getTime() && job.agent) laneToday[job.agent] = (laneToday[job.agent] ?? 0) + usd;
      if (FLAT_RATE.has(job.agent)) { out.flatRateListUsd += usd; out.flatRateJobs += 1; if (Number.isFinite(at)) addListValue(usd, at); }
      else { out.paidUsd += usd; if (ESTIMATED.has(job.costSource)) out.paidEstimatedUsd += usd; if (Number.isFinite(at)) addBilled(usd, at); }
    }
  }
  for (const key of Object.keys(out)) if (key.endsWith('Usd')) out[key] = Math.round(out[key] * 1e6) / 1e6;
  out.laneToday = Object.fromEntries(Object.entries(laneToday).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));
  out.laneJobsToday = Object.fromEntries(Object.entries(laneJobs));
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
export async function projectOverview(project, liveRuns, { now = Date.now(), summary = projectSummary, historyFile = undefined, deployStatus = null } = {}) {
  const runs = await readRunStates(project.root);
  const liveIds = new Set(liveRuns.map(r => r.runId));
  const ledger = await readLedger(project.root).catch(() => null);
  const spend = await summary(project.root).catch(error => ({ spendUsd: null, capUsd: null, capError: String(error.message).slice(0, 120) }));
  const overviewSpend = { usd: spend.usd ?? spend.spendUsd ?? null, capUsd: spend.capUsd ?? null, reached: spend.reached ?? false, why: spend.why ?? null, capBasis: spend.capBasis ?? 'billed+list' };
  const progress = await buildProgress({ root: project.root, projectId: project.id, now, historyFile, spend: overviewSpend, deploy: deployStatus ? deployStatus(project.root) : null }).then(progressSummary, () => null);
  const cost = costOf(runs, now);
  const agents = agentsOf(runs, liveIds, now);
  const lastRun = runs.length ? runs[runs.length - 1].state : null;
  const lastActivityMs = Math.max(0, ...runs.map(r => r.mtimeMs), Date.parse(ledger?.updatedAt ?? '') || 0);
  const tickets = ticketsOf(ledger);
  const readyTickets = tickets.byStatus.ready ?? 0;
  const idle = liveRuns.length === 0;
  return {
    id: project.id, name: txt(project.name, 80), root: project.root,
    stage: tickets.stage, tickets, readyTickets, idleWithReady: idle && readyTickets > 0,
    live: liveRuns.map(r => { const hit = runs.find(x => x.id === r.runId); const jobs = hit?.state.jobs ?? []; return { runId: r.runId, startedAt: r.startedAt ?? null, status: txt(hit?.state.status ?? 'running', 30), jobs: jobs.length, done: jobs.filter(j => j.status === 'complete').length }; }),
    agents, cost,
    orchestrator: (() => { try { return projectOrchestrator(project, { runs, now }); } catch { return { sessions: [], handBuilt: { files: 0, edits: 0, list: [] }, swarmBuilt: { files: 0 }, swarmPct: null, handPct: null, cost: { todayListUsd: 0, allListUsd: 0, todayTokens: 0, allTokens: 0 } }; } })(),
    spend: { usd: cost.allUsd, familyUsd: spend.spendUsd ?? null, sharedTrees: spend.sharedTrees ?? 1, capUsd: spend.capUsd ?? null, noCap: spend.capUsd === null || spend.capUsd === undefined ? !spend.capError : false, capInvalid: Boolean(spend.capError), reached: Boolean(spend.reached), capSource: spend.capSource ?? null, capInherited: Boolean(spend.capInherited), inheritedFrom: spend.inheritedFrom ?? null, why: spend.why ?? null, billedUsd: cost.paidUsd, listUsd: cost.flatRateListUsd, capBasis: spend.capBasis ?? 'billed+list' },
    progress,
    recentJobCounts: runs.slice(-6).map(r => (Array.isArray(r.state.jobs) ? r.state.jobs.length : 0)),
    lastRunAt: lastRun?.startedAt ?? null,
    lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    idle,
  };
}

// Many 1-job runs in a row leave the machine's slots empty (a run per ticket instead of a wave): the last three or more runs each held at most one job while the machine has room for
// several. Returns the warning text, or null.
export function underfilledWaves(counts, slots) {
  if (!Array.isArray(counts) || !Number.isInteger(slots) || slots < 4) return null;
  let streak = 0;
  for (let i = counts.length - 1; i >= 0 && counts[i] <= 1; i -= 1) streak += 1;
  return streak >= 3 ? `waves under-filled: 1 job of ${slots} slots (the last ${streak} runs each had 1 job); run the ready tickets as one wave` : null;
}

// The whole board: machine totals (sums of the project numbers) and one overview per registered project.
export async function boardSnapshot({ projects, liveRuns, now = Date.now(), summary, historyFile = undefined, workers = null, lanes = null, laneState = null, worktreeRoot = mainWorktreeRoot, deployStatus = null } = {}) {
  const overviews = [];
  const realRoot = async root => await fs.realpath(root).catch(() => path.resolve(root));
  // A live run belongs to the project whose real root it ran in, however the path was spelled.
  const live = await Promise.all(liveRuns.map(async r => ({ ...r, root: await fs.realpath(r.root).catch(() => r.root) })));
  for (const project of projects) {
    const projectRoot = await realRoot(project.root);
    const mine = live.filter(r => r.root === projectRoot);
    overviews.push(await projectOverview(project, mine, { now, summary, historyFile, deployStatus }));
  }
  const registered = new Map();
  for (const project of projects) registered.set(await realRoot(project.root), project);
  for (const overview of overviews) {
    overview.parentId = null;
    overview.worktree = false;
    overview.worktreeIds = [];
  }
  for (let i = 0; i < projects.length; i += 1) {
    let parentRoot = null;
    try { parentRoot = await worktreeRoot(projects[i].root); } catch { parentRoot = null; }
    if (!parentRoot) continue;
    const childReal = await realRoot(projects[i].root);
    const parentReal = await realRoot(parentRoot);
    const parent = registered.get(parentReal);
    if (!parent || parentReal === childReal) continue;
    const child = overviews[i];
    child.parentId = parent.id;
    child.worktree = true;
    const parentOverview = overviews.find(o => o.id === parent.id);
    if (parentOverview) parentOverview.worktreeIds.push(child.id);
  }
  for (const overview of overviews) {
    overview.worktreeIds.sort((a, b) => String(overviews.find(o => o.id === a)?.name ?? '').localeCompare(String(overviews.find(o => o.id === b)?.name ?? '')) || String(a).localeCompare(String(b)));
  }
  for (const o of overviews) { const warn = underfilledWaves(o.recentJobCounts, workers?.max); o.warnings = warn ? [{ code: 'waves-underfilled', text: warn }] : []; }
  const transcripts = new Set();
  const machine = { agents: { total: 0, byLane: dict(), byProject: dict(), list: [] }, cost: { todayUsd: 0, weekUsd: 0, allUsd: 0, flatRateTodayUsd: 0, flatRateWeekUsd: 0, paidUsd: 0, paidEstimatedUsd: 0, flatRateListUsd: 0, byProject: {} }, liveRuns: 0, orchestrator: { sessions: [], todayListUsd: 0, allListUsd: 0, handBuiltFiles: 0, swarmBuiltFiles: 0 } };
  for (const o of overviews) {
    machine.agents.total += o.agents.total;
    machine.agents.byProject[o.id] = o.agents.total;
    for (const a of o.agents.list ?? []) machine.agents.list.push({ ...a, projectId: o.id, project: o.name });
    for (const [lane, n] of Object.entries(o.agents.byLane)) machine.agents.byLane[lane] = (machine.agents.byLane[lane] ?? 0) + n;
    for (const key of ['todayUsd', 'weekUsd', 'flatRateTodayUsd', 'flatRateWeekUsd', 'allUsd', 'paidUsd', 'paidEstimatedUsd', 'flatRateListUsd']) machine.cost[key] += o.cost[key];
    for (const [agent, usd] of Object.entries(o.cost.laneToday ?? {})) (machine.cost.laneToday ??= dict())[agent] = (machine.cost.laneToday[agent] ?? 0) + usd;
    for (const [agent, n] of Object.entries(o.cost.laneJobsToday ?? {})) (machine.cost.laneJobsToday ??= dict())[agent] = (machine.cost.laneJobsToday[agent] ?? 0) + n;
    machine.cost.byProject[o.id] = { name: o.name, ...o.cost };
    machine.liveRuns += o.live.length;
    machine.orchestrator.sessions.push(...(o.orchestrator?.sessions ?? []));
    for (const name of o.orchestrator?.transcripts ?? []) transcripts.add(name);
    machine.orchestrator.handBuiltFiles += o.orchestrator?.handBuilt.files ?? 0; machine.orchestrator.swarmBuiltFiles += o.orchestrator?.swarmBuilt.files ?? 0;
  }
  for (const key of ['todayUsd', 'weekUsd', 'flatRateTodayUsd', 'flatRateWeekUsd', 'allUsd', 'paidUsd', 'paidEstimatedUsd', 'flatRateListUsd']) machine.cost[key] = Math.round(machine.cost[key] * 1e6) / 1e6;
  // One session can be in two projects' logs: the machine totals count each message once over all transcripts.
  { const c = transcripts.size ? combinedUsage([...transcripts], { now }) : { todayListUsd: 0, allListUsd: 0 }; machine.orchestrator.todayListUsd = c.todayListUsd; machine.orchestrator.allListUsd = c.allListUsd; }
  for (const o of overviews) if (o.orchestrator) delete o.orchestrator.transcripts;
  { const t = machine.orchestrator.handBuiltFiles + machine.orchestrator.swarmBuiltFiles; machine.orchestrator.swarmPct = t ? Math.round(machine.orchestrator.swarmBuiltFiles * 100 / t) : null; machine.orchestrator.handPct = t ? Math.round(machine.orchestrator.handBuiltFiles * 100 / t) : null; }
  machine.orchestrator.sessions.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  machine.agents.byLane = plain(machine.agents.byLane);
  machine.agents.byProject = plain(machine.agents.byProject);
  if (machine.cost.laneToday) machine.cost.laneToday = plain(machine.cost.laneToday);
  if (machine.cost.laneJobsToday) machine.cost.laneJobsToday = plain(machine.cost.laneJobsToday);
  machine.workers = workers;
  machine.lanes = lanes ? await lanes(machine.cost.laneToday ?? {}, machine.cost.laneJobsToday ?? {}) : [];
  const queued = dict();
  const recent = dict();
  try {
    for (const project of projects) {
      const states = await readRunStates(project.root);
      const projectRoot = await realRoot(project.root);
      const liveIds = new Set(live.filter(run => run.root === projectRoot).map(run => run.runId));
      for (const { id, state } of states) {
        for (const job of state.jobs ?? []) {
          if (!job || typeof job !== 'object' || typeof job.agent !== 'string') continue;
          if (liveIds.has(id) && job.status === 'queued') queued[job.agent] = (queued[job.agent] ?? 0) + 1;
          const finished = Date.parse(job.finishedAt ?? '');
          if (!Number.isFinite(finished) || finished < now - DAY || finished > now) continue;
          const entry = recent[job.agent] ??= { jobs: 0, explicit: 0 };
          entry.jobs += 1;
          if ((job.requestedAgent ?? job.agent) !== 'auto') entry.explicit += 1;
        }
      }
    }
    const extra = typeof laneState === 'function' ? await laneState() : {};
    machine.laneIdle = laneIdleReasons({ running: machine.agents.byLane, ...valueObject(extra), todayUsd: machine.cost.laneToday ?? {}, queued, recent, now });
  } catch {
    machine.laneIdle = {};
  }
  return { at: new Date(now).toISOString(), machine, projects: overviews };
}

// One project's page: its tickets by status, its run history, its spend by lane and its lessons. Reads only under project.root.
export async function projectDetail(project, { now = Date.now(), liveRunIds = new Set(), summary = projectSummary, historyFile = undefined, deployStatus = null } = {}) {
  const runs = await readRunStates(project.root, { limit: 200 });
  const ledger = await readLedger(project.root).catch(() => null);
  const tickets = (ledger?.tickets ?? []).filter(t => t && typeof t === 'object').slice(0, 1000).map(t => ({ id: txt(t.id, 20), title: txt(t.title, 140), status: txt(t.status, 20), stage: txt(t.stage, 10), risk: txt(t.risk, 10) }));
  const byLane = dict();
  for (const { state } of runs) for (const job of state.jobs ?? []) { if (!job || typeof job !== 'object') continue; const usd = num(jobSpend(job).usd); if (!usd) continue; const label = laneLabel(job.agent, job.model); byLane[label] = Math.round(((byLane[label] ?? 0) + usd) * 1e6) / 1e6; }
  const lessons = await listLessons(project.root).then(r => r.lessons.slice(0, 200).map(l => ({ id: txt(l.id, 40), what: txt(l.what ?? l.title ?? l.rule, 200), stage: txt(l.stage, 20), status: txt(l.guard?.status ?? l.status, 20) })), () => []);
  const detailCost = costOf(runs, now);
  const spend = (await summary(project.root).catch(() => ({}))) ?? {};
  const detailSpend = { usd: spend.spendUsd ?? detailCost.allUsd, capUsd: spend.capUsd ?? null, reached: spend.reached ?? false, why: spend.why ?? null, capBasis: spend.capBasis ?? 'billed+list' };
  const progress = await buildProgress({ root: project.root, projectId: project.id, now, historyFile, spend: detailSpend, deploy: deployStatus ? deployStatus(project.root) : null }).catch(() => null);
  return {
    id: project.id, name: txt(project.name, 80), root: project.root,
    tickets, ticketCounts: ticketsOf(ledger),
    runs: runs.slice().reverse().map(({ id, state }) => {
      const jobs = state.jobs ?? [];
      return { runId: id, status: txt(state.status, 30), live: liveRunIds.has(id), startedAt: state.startedAt ?? null, finishedAt: state.finishedAt ?? null, jobs: jobs.length, done: jobs.filter(j => j.status === 'complete').length, failed: jobs.filter(j => ['failed', 'timeout'].includes(j.status)).length, costUsd: Math.round(runTotals(state).usd * 1e6) / 1e6 };
    }),
    spend: { ...detailCost, byLane: plain(byLane), billedUsd: detailCost.paidUsd, listUsd: detailCost.flatRateListUsd, capBasis: spend.capBasis ?? 'billed+list' },
    progress,
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
// spend store counts by), and a rate-limit or quota pause with the time it ends. Every configured lane is listed, and every lane that ran a job today, even when it reported no
// cost (a flat-rate lane that cost nothing still ran). Read-only.
const PAID = new Set(['openrouter', 'openai', 'gemini', 'lambda', 'anthropic', 'rented']);
export async function laneUsage({ laneToday = {}, jobsToday = {}, configured = [], spendDirectory, lanesDirectory, caps = {}, now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const midnight = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1);
  let store = null;
  try { store = JSON.parse(await fs.readFile(path.join(spendDirectory, 'daily.json'), 'utf8')); } catch { /* nothing was ever spent */ }
  const spent = store && typeof store.entries === 'object' && store.entries ? laneDayTotals(store, { day }) : {};
  let lanes = null;
  try { lanes = JSON.parse(await fs.readFile(path.join(lanesDirectory, 'lanes.json'), 'utf8')); } catch { /* no lane has been used */ }
  const names = new Set([...Object.keys(laneToday), ...Object.keys(jobsToday), ...configured, ...Object.keys(spent), ...Object.keys(caps), ...Object.entries(lanes?.pauses ?? {}).filter(([, v]) => Number.isFinite(v?.until) && v.until > now).map(([k]) => k)]);
  const rows = [];
  for (const agent of [...names].sort()) {
    const paid = PAID.has(agent);
    const todayUsd = Math.round(num(paid ? (spent[agent]?.usd ?? laneToday[agent]) : laneToday[agent]) * 1e6) / 1e6;
    const cap = typeof caps[agent] === 'number' && caps[agent] > 0 ? caps[agent] : null;
    const pause = lanes?.pauses?.[agent];
    const limited = pause && Number.isFinite(pause.until) && pause.until > now ? { state: txt(pause.state, 20), until: new Date(pause.until).toISOString() } : null;
    const jobs = Number.isInteger(jobsToday[agent]) ? jobsToday[agent] : 0;
    rows.push({ lane: txt(agent, 30), jobsToday: jobs, label: agent === 'anthropic' ? 'Anthropic API' : laneLabel(agent, null), kind: paid ? 'billed' : 'flat-rate', todayUsd, dailyCapUsd: cap, capResetsAt: cap ? new Date(midnight).toISOString() : null, limited });
  }
  return rows;
}

// Events tab: a run row names its tickets (id and title), the lane and model that built each, and whether it passed; a failed one carries its short reason and retry count. Read from the run's own
// state file and the project's ledger at display time (the log keeps only the one-line title), never written back.
export async function enrichRunEvents(events, projects) {
  const byId = new Map((projects ?? []).map(p => [p.id, p]));
  const titles = new Map();
  const titlesOf = async project => {
    if (!titles.has(project.id)) {
      const ledger = await readLedger(project.root).catch(() => null);
      titles.set(project.id, new Map((ledger?.tickets ?? []).filter(t => t && typeof t.id === 'string').map(t => [t.id, t.title])));
    }
    return titles.get(project.id);
  };
  const out = [];
  for (const e of events) {
    const project = byId.get(e.projectId);
    if (e.kind !== 'run' || !e.run || !RUN_ID.test(e.run) || !project) { out.push(e); continue; }
    try {
      const file = path.join(project.root, '.swarm', 'runs', e.run, 'state.json');
      if ((await fs.lstat(path.dirname(file))).isSymbolicLink()) { out.push(e); continue; }
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      const names = await titlesOf(project);
      const jobs = (Array.isArray(state.jobs) ? state.jobs : []).filter(j => j && typeof j === 'object').slice(0, 8).map(j => {
        const outcome = j.status === 'complete' ? 'pass' : ['failed', 'timeout', 'cancelled'].includes(j.status) ? 'fail' : txt(j.status, 20);
        const attempts = Array.isArray(j.attempts) ? j.attempts.length : 1;
        return { id: txt(j.id, 60), title: names.get(j.id) ? txt(names.get(j.id), 100) : null, lane: laneLabel(j.agent, j.model), model: txt(j.model, 60), outcome, retries: Math.max(0, attempts - 1), reason: outcome === 'fail' && j.error ? txt(j.error, 120) : null };
      });
      out.push({ ...e, jobs, jobCount: Array.isArray(state.jobs) ? state.jobs.length : jobs.length });
    } catch { out.push(e); }
  }
  return out;
}
