// SPDX-License-Identifier: Apache-2.0
// What the Swarm Watch board shows: one lane per registered project, with machine-wide totals above them.
// Everything is read from the project's own folder (its run states, ticket ledger, lessons) and nothing is ever mixed across projects:
// each function takes ONE project and reads only under its root. The machine-wide numbers are sums of the per-project numbers.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runTotals, jobSpend, laneDayTotals } from './spend.mjs';
import { readLedger, ledgerPath, logPath, readyTickets as ticketsReadyToRun } from './tickets.mjs';
import { mainWorktreeRoot as discoverMainWorktreeRoot, projectSummary, worktreeFamily as discoverWorktreeFamily } from './project-spend.mjs';
import { isScratchRoot } from './projects.mjs';
import { listLessons } from './lesson-store.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectOrchestrator } from './board-orchestrator.mjs';
import { combinedUsage } from './orchestrator-usage.mjs';
import { boardPercent, buildProgress, cardEtaFromFamily, ledgerRoot, offLedgerRunHref, OFF_LEDGER_LIST_ANCHOR_ID, progressSummary } from './build-progress.mjs';
import { checkTicketTree } from './scope-integrity.mjs';
import { readEvents } from './orchestrator-events.mjs';
import { lanesDir } from './lanes.mjs';
import { boardInbox, needYouForProject, ticketReleaseAllowed } from './board-inbox.mjs';
import { effectiveStage, stageDisplay } from './build-progress.mjs';
import { doneTimes } from './client-report.mjs';
import { parseScope } from './scope.mjs';
import { ROUTE_ORDER } from './router.mjs';
import { isProviderLimitFailure } from './lane-pass-routing.mjs';
import { splitQuality } from './split-quality.mjs';
import { readScorecards, scorecardHistory } from './benchmark-scorecard.mjs';
import { handledForProject } from './handled.mjs';
import { overviewPinnedVersion } from './pins.mjs';

const DAY = 86400000;
// Cache derived data, not a timed copy of the board. Every lookup checks the inputs,
// including missing files and directory membership (new/deleted runs and ledgers).
const overviewCache = new Map();
const aggregateCache = new Map();
const gitCache = new Map();
const scopeInputs = new Map();
const callbackIds = new WeakMap();
let nextCallbackId = 0;
const callbackId = fn => {
  if (typeof fn !== 'function') return null;
  if (!callbackIds.has(fn)) callbackIds.set(fn, ++nextCallbackId);
  return callbackIds.get(fn);
};

// Revisions belong in validators, never keys. Touch on access/replacement so
// inactive projects cannot crowd out the current board.
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function touch(cache, key) {
  const value = cache.get(key);
  if (value !== undefined) { cache.delete(key); cache.set(key, value); }
  return value;
}
function remember(cache, key, value, limit = 32) {
  cache.delete(key);
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

async function fileIdentity(file, tree = false) {
  try {
    const info = await fs.lstat(file);
    const own = [file, info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs];
    if (tree && info.isDirectory()) {
      const entries = (await fs.readdir(file)).sort();
      return [own, await Promise.all(entries.map(name => fileIdentity(path.join(file, name), true)))];
    }
    return own;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [file, 'missing'];
    // A permission/I/O failure must never validate an old snapshot.
    throw error;
  }
}

async function gitDirectories(root) {
  const entry = path.join(root, '.git');
  let dir = entry;
  try {
    if ((await fs.lstat(entry)).isFile()) {
      const pointer = await fs.readFile(entry, 'utf8');
      const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
      if (match) dir = path.resolve(root, match[1].trim());
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let common = dir;
  try { common = path.resolve(dir, (await fs.readFile(path.join(dir, 'commondir'), 'utf8')).trim()); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  return { entry, dir, common };
}

async function gitIdentity(root, family = false) {
  const { entry, dir, common } = await gitDirectories(root);
  return JSON.stringify(await Promise.all([
    fileIdentity(entry), fileIdentity(path.join(dir, 'HEAD')), fileIdentity(path.join(dir, 'commondir')),
    fileIdentity(path.join(common, 'config')),
    ...(family ? [fileIdentity(path.join(common, 'worktrees'), true)] : []),
  ]));
}

async function mainWorktreeRoot(root) {
  const key = `main:${path.resolve(root)}`;
  const identity = await gitIdentity(root);
  const hit = gitCache.get(key);
  if (hit?.identity === identity) return hit.value;
  const value = await discoverMainWorktreeRoot(root);
  remember(gitCache, key, { identity, value });
  return value;
}

async function worktreeFamily(root, options) {
  const key = `family:${path.resolve(root)}:${JSON.stringify(options)}`;
  const identity = await gitIdentity(root, true);
  const hit = gitCache.get(key);
  if (hit?.identity === identity) return hit.value;
  const value = await discoverWorktreeFamily(root, options);
  remember(gitCache, key, { identity, value });
  return value;
}

async function projectFilesIdentity(root) {
  return Promise.all([
    fileIdentity(path.join(root, '.swarm'), true),
    fileIdentity(ledgerPath(root)), fileIdentity(logPath(root)),
    fileIdentity(path.join(root, '.project-swarm.json')),
    fileIdentity(path.join(root, 'docs', 'scope'), true),
    ...[...(scopeInputs.get(root) ?? [])].map(file => fileIdentity(file)),
    gitIdentity(root, true),
  ]);
}

/** Cheap validator shared by the board data cache and the HTTP representation cache. */
export async function boardSnapshotInputIdentity({ projects = [], env = process.env, historyFile, registryFile } = {}) {
  const extraRoots = projects.map(project => project.root).filter(Boolean);
  const roots = new Set();
  for (const root of extraRoots) {
    for (const member of await projectFamilyRoots(root, { env, extraRoots })) roots.add(member);
  }
  const files = [historyFile, registryFile].filter(Boolean);
  return fingerprint(await Promise.all([
    ...[...roots].sort().map(root => projectFilesIdentity(root)),
    ...files.map(file => fileIdentity(file)),
  ]));
}

// These fields have moving time windows even if no file changes. Rebuild at least
// once a minute, and at local midnight; never reuse a value after a clock reversal.
function cacheTimeValid(entry, now) {
  return entry && now >= entry.at && now - entry.at < 60000
    && startOfLocalDay(now) === startOfLocalDay(entry.at);
}

async function cachedAggregate(key, identity, now, build) {
  const hit = touch(aggregateCache, key);
  if (hit?.identity === identity && cacheTimeValid(hit, now)) return structuredClone(await hit.value);
  const entry = { identity, at: now, value: Promise.resolve().then(build) };
  remember(aggregateCache, key, entry);
  try { return structuredClone(await entry.value); }
  catch (error) { if (aggregateCache.get(key) === entry) aggregateCache.delete(key); throw error; }
}
export const UNTRACKED_HEADLINE_MS = 7 * DAY;
const UNTRACKED_WARNING = 'untracked work: no ledger ticket';
const LIVE_RUN = new Set(['queued', 'pending', 'running', 'active', 'in_progress', 'in-progress', 'live']);
const IGNORED_UNTRACKED_RUN_WORDS = /\b(?:smoke|lane-test|lane-bench|probe|doctor|bench)\b/i;

function runIsLiveForUntracked(state) {
  return state?.live === true || LIVE_RUN.has(String(state?.status ?? '').toLowerCase());
}

function stateTicketIdsForUntracked(state) {
  const ids = new Set();
  const visit = value => {
    if (typeof value === 'string') ids.add(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object') { visit(value.id); visit(value.ticket); visit(value.ticketId); }
  };
  visit(state?.ticketIds);
  visit(state?.tickets);
  return ids;
}

function jobTicketIdsForUntracked(job) {
  const ids = new Set();
  for (const key of ['id', 'ticket', 'ticketId', 'name']) if (typeof job?.[key] === 'string') ids.add(job[key]);
  return ids;
}

export function untrackedRunHasIgnoredName(state, jobs) {
  const manifestNames = [
    state?.manifest,
    state?.manifest?.file,
    state?.manifest?.fileName,
    state?.manifest?.filename,
    state?.manifest?.name,
    state?.manifest?.path,
    state?.manifestFile,
    state?.manifestFileName,
    state?.manifestName,
    state?.manifestPath,
    state?.request?.manifest,
    state?.request?.manifestFile,
    state?.options?.manifest,
    state?.options?.manifestFile,
    state?.name,
    state?.title,
    state?.label,
  ];
  if (manifestNames.some(value => typeof value === 'string' && IGNORED_UNTRACKED_RUN_WORDS.test(value))) return true;
  if (typeof state?.id === 'string' && IGNORED_UNTRACKED_RUN_WORDS.test(state.id)) return true;
  return jobs.some(job => typeof job?.id === 'string' && IGNORED_UNTRACKED_RUN_WORDS.test(job.id));
}

export function isOffLedgerUntrackedRun(state, ticketIds) {
  if (!state || state.nonIntegrating === true) return false;
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const ids = ticketIds instanceof Set ? ticketIds : new Set(ticketIds ?? []);
  const stateMapped = [...stateTicketIdsForUntracked(state)].some(id => ids.has(id));
  const untrackedJobs = jobs.filter(job => ![...jobTicketIdsForUntracked(job)].some(id => ids.has(id)));
  return Boolean(untrackedJobs.length || (!jobs.length && !stateMapped));
}

function runCostUsd(state) {
  return Math.round(num(runTotals(state).usd) * 1e6) / 1e6;
}

/** Full untracked list (all ages, includes smoke/probe/bench noise) and 7-day headline count for the board card. */
export function boardUntrackedSummary(records, ticketIds, { now = Date.now(), projectId = null } = {}) {
  const ids = ticketIds instanceof Set ? ticketIds : new Set(ticketIds ?? []);
  const runs = [];
  for (const record of records) {
    const state = record.state;
    if (!state || typeof state !== 'object') continue;
    const live = runIsLiveForUntracked(state);
    const started = Date.parse(state.startedAt ?? '');
    if (Number.isFinite(started) && started > now) continue;
    const jobs = Array.isArray(state.jobs) ? state.jobs : [];
    if (!isOffLedgerUntrackedRun(state, ids)) continue;
    const ignored = untrackedRunHasIgnoredName(state, jobs);
    const untrackedJobs = jobs.filter(job => ![...jobTicketIdsForUntracked(job)].some(id => ids.has(id)));
    runs.push({
      runId: record.runId ?? record.id,
      startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null,
      startedMs: Number.isFinite(started) ? started : 0,
      status: txt(state.status, 'unknown'),
      jobs: jobs.length,
      untrackedJobs: untrackedJobs.length,
      done: jobs.filter(job => job?.status === 'complete').length,
      costUsd: runCostUsd(state),
      ignored,
      name: txt(state.name ?? state.title ?? state.label, record.runId ?? record.id),
      href: offLedgerRunHref(projectId, record.runId ?? record.id),
    });
  }
  runs.sort((a, b) => (b.startedMs - a.startedMs) || String(a.runId).localeCompare(String(b.runId)));
  const headlineRuns = runs.filter(run => !run.ignored && run.startedMs >= now - UNTRACKED_HEADLINE_MS && run.startedMs <= now);
  const jobs = runs.reduce((total, run) => total + run.untrackedJobs, 0);
  const headlineJobs = headlineRuns.reduce((total, run) => total + run.untrackedJobs, 0);
  const newest = headlineRuns.slice(0, 5).map(run => ({ runId: run.runId, name: run.name, startedAt: run.startedAt, status: run.status }));
  const listHref = `#${OFF_LEDGER_LIST_ANCHOR_ID}`;
  const full = {
    runs,
    count: runs.length,
    jobs,
    newest: runs.slice(0, 5).map(run => ({ runId: run.runId, name: run.name, startedAt: run.startedAt, status: run.status })),
    warning: UNTRACKED_WARNING,
    listAnchorId: OFF_LEDGER_LIST_ANCHOR_ID,
    countHref: listHref,
    listHref,
  };
  return {
    full,
    headline: { count: headlineRuns.length, jobs: headlineJobs, newest, listHref },
    listHref,
  };
}

export function shouldArchiveUntrackedRun(state, ticketIds, { now = Date.now() } = {}) {
  if (!isOffLedgerUntrackedRun(state, ticketIds)) return false;
  if (runIsLiveForUntracked(state)) return false;
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  if (untrackedRunHasIgnoredName(state, jobs)) return true;
  const started = Date.parse(state.startedAt ?? '');
  if (!Number.isFinite(started)) return false;
  return started < now - UNTRACKED_HEADLINE_MS;
}

async function swarmPackageVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Start of the calendar day containing `now`, in the machine's local time zone (for tests and board activity). */
export function startOfLocalDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function projectActivityState({ activeLiveCount, lastActivityMs, now = Date.now() } = {}) {
  const live = Number(activeLiveCount) > 0;
  if (live) return { activity: 'building', idle: false };
  const start = startOfLocalDay(now);
  const at = Number(lastActivityMs);
  const activeToday = at >= start && at > 0 && at <= now;
  return activeToday ? { activity: 'active-today', idle: false } : { activity: 'idle', idle: true };
}

function familyActivityMs({ runs, liveRunIds, ledgers, liveRuns, ticketFinishedMs, now }) {
  const liveIds = liveRunIds instanceof Set ? liveRunIds : new Set(liveRunIds ?? []);
  const capped = ms => {
    const value = Number(ms);
    return Number.isFinite(value) && value > 0 && value <= now ? value : 0;
  };
  let newest = 0;
  for (const run of runs) {
    if (activeRunState(run.state)) {
      if (liveIds.has(run.id)) newest = Math.max(newest, capped(runActivityMs(run)));
      continue;
    }
    newest = Math.max(newest, capped(runActivityMs(run)));
  }
  for (const record of liveRuns ?? []) newest = Math.max(newest, capped(Date.parse(record.startedAt ?? '')));
  for (const ledger of ledgers ?? []) newest = Math.max(newest, capped(Date.parse(ledger?.updatedAt ?? '')));
  newest = Math.max(newest, capped(ticketFinishedMs));
  return newest;
}
const FLAT_RATE = new Set(['codex', 'cursor', 'claude', 'hermes', 'qwen']);   // subscription lanes: not billed per use
const ESTIMATED = new Set(['estimated-from-tokens', 'reservation']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const txt = (v, n = 160) => (v === null || v === undefined ? null : sanitizeWorkerText(v, n));
// Maps keyed by text from run files (lane names, statuses, project names) have no prototype: a lane called __proto__ or constructor must not reach Object.prototype.
const dict = () => Object.create(null);
// What leaves the module is an ordinary object again (Object.fromEntries defines each key as an own property, even one called __proto__).
const plain = d => Object.fromEntries(Object.entries(d));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const pathInside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
const activeRunState = state => state?.status === 'running' || state?.status === 'paused';
const runActivityMs = ({ state, mtimeMs } = {}) => Math.max(
  Number.isFinite(mtimeMs) ? mtimeMs : 0,
  Date.parse(state?.startedAt ?? '') || 0,
  Date.parse(state?.finishedAt ?? '') || 0,
  ...((state?.jobs ?? []).map(job => Date.parse(job?.finishedAt ?? '') || 0)),
);

// This deliberately stays as one exported predicate so the MacBook scratch-root helper can
// replace the path checks later without changing the board's callers. `facts` is injectable for
// tests; callers that inspect the filesystem should fill it from their own read-only snapshot.
export function isTestOrTempProject(project, facts = {}) {
  const root = path.resolve(String(project?.root ?? ''));
  const parts = root.split(path.sep).filter(Boolean);
  const tmpdir = path.resolve(String(facts.tmpdir ?? os.tmpdir()));
  const scratchBase = path.resolve(String(facts.scratchBase ?? path.join(os.homedir(), '.project-swarm-scratch')));
  const ledger = valueObject(facts.ledger);
  const openTickets = facts.openTickets ?? (Array.isArray(ledger.tickets) && ledger.tickets.some(ticket => ['todo', 'ready', 'running', 'review', 'blocked'].includes(ticket?.status)));
  const approvedLedger = facts.approvedLedger ?? Boolean(ledger.approved === true || ledger.approval === true || ledger.scope);
  const scopeFile = facts.scopeFile ?? facts.scope?.file ?? facts.scope === true;
  const spend = facts.spendUsd ?? facts.spend?.usd ?? facts.spend?.spendUsd ?? facts.spend ?? 0;
  const scratchFact = typeof facts.isScratchRoot === 'function' ? facts.isScratchRoot(root) : facts.isScratchRoot;
  const pathScratch = Boolean(
    scratchFact ?? isScratchRoot(root, { tmpdir }),
  ) || pathInside(root, scratchBase) || parts.some(part => part.startsWith('.tmp-test'));
  const segmentScratch = parts.some(part => ['tmp', 'temp', 'test', 'tests', '__tests__'].includes(part));
  const pointerScratch = Boolean(facts.pointerScratch ?? facts.pointer?.scratch ?? facts.pointer?.profile?.scratch);
  const markerScratch = Boolean(facts.marker ?? facts.markerFile);
  const pathLike = pathScratch || segmentScratch || pointerScratch || markerScratch;
  const pinned = Boolean(project?.pinned || facts.pinned);
  const live = Boolean(facts.live || facts.recentLive || facts.liveRun || (Array.isArray(facts.liveRuns) && facts.liveRuns.length));
  const recentRun = Boolean(facts.recentRun || facts.hasRunInLast7Days);
  const approvedOpen = Boolean(approvedLedger && (openTickets || (Array.isArray(facts.openTicketsList) && facts.openTicketsList.length)));
  if (pinned || live || recentRun || approvedOpen) return false;
  const hasScope = Boolean(scopeFile || approvedLedger || facts.hasScope);
  const hasRecentRun = recentRun;
  const hasSpend = Number(spend) > 0;
  const noScopeIdle = !hasScope && !hasRecentRun && !openTickets && !hasSpend;
  return pathLike || noScopeIdle;
}

async function pinnedVersionFor(root) {
  try {
    const pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8'));
    return overviewPinnedVersion(pointer);
  } catch {
    return null;
  }
}

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
        const backIn = idleCountdown(pause.until, now);
        answer = {
          reason: rate ? 'rate-limited' : 'paused',
          text: rate
            ? `${label} is rate limited; back in ${backIn}.`
            : `${label} is paused by its provider (quota or credit limit); back in ${backIn}.`,
          until: new Date(pause.until).toISOString(),
        };
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
          answer = {
            reason: 'daily-cap',
            text: `${label} hit its daily spend cap ($${idleMoney(spent)} of $${idleMoney(cap)}).`,
            until: tomorrow.toISOString(),
          };
          break;
        }
      }
    }
    const configuredAgents = agents.filter(agent => configuredEntries.some(([name]) => name === agent));
    if (!answer && configuredAgents.length === 0) {
      answer = {
        reason: 'not-set-up',
        text: label === 'GPU'
          ? `${label} is not set up: no GPU configured in the local config.`
          : `${label} is not set up: no model in the local config.`,
      };
    }
    if (!answer) {
      for (const agent of agents) {
        const count = Number(valueObject(demand)[agent]);
        if (count > 0) {
          answer = { reason: 'waiting-slot', text: `${count} ${label} job${count === 1 ? '' : 's'} waiting for a free slot.` };
          break;
        }
      }
    }
    if (!answer) {
      for (const agent of agents) {
        const count = Number(valueObject(queued)[agent]);
        if (count > 0) {
          answer = { reason: 'queued', text: `${count} job${count === 1 ? '' : 's'} queued for ${label}, starting soon.` };
          break;
        }
      }
    }
    if (!answer && (label === 'Cursor' || label === 'Codex') && Number(valueObject(queued).auto) > 0) {
      const count = Number(valueObject(queued).auto);
      answer = { reason: 'routing', text: `${count} auto job${count === 1 ? '' : 's'} not routed yet.` };
    }
    if (!answer && MODEL_LANES.has(label) && configuredAgents.length === 1 && configuredAgents[0] === 'claude') {
      answer = { reason: 'not-routed', text: `${label} is not in auto routing: only expensive-tier jobs or jobs after two failures on cheaper lanes.` };
    }
    if (!answer) {
      for (const agent of configuredAgents) {
        if (agent !== 'hermes' && !ROUTABLE_AGENTS.has(agent)) {
          answer = { reason: 'not-routed', text: `${label} is not in auto routing: only jobs that name it explicitly.` };
          break;
        }
        if (agent === 'hermes') {
          answer = { reason: 'not-routed', text: `${label} is not in auto routing: research job type only.` };
          break;
        }
      }
    }
    if (!answer) {
      for (const agent of agents) {
        const value = valueObject(recent)[agent];
        if (value?.lastProviderLimitAt) {
          answer = {
            reason: 'provider-limit',
            text: `${label} may be out of credits: its last job failed with a provider limit message. Refill it, or route work to another lane.`,
          };
          break;
        }
      }
    }
    if (!answer) {
      let recentOther = null;
      let recentOtherJobs = 0;
      if (label === 'Codex' || label === 'Cursor') {
        const other = label === 'Codex' ? 'Cursor' : 'Codex';
        let thisRecentJobs = 0;
        for (const agent of agents) {
          const value = valueObject(recent)[agent];
          if (value) thisRecentJobs += Number(value?.jobs) || 0;
        }
        if (thisRecentJobs === 0) {
          for (const [agent, value] of Object.entries(valueObject(recent))) {
            if (idleLabelForAgent(agent, configured) !== other) continue;
            const jobs = Number(value?.jobs);
            const explicit = Number(value?.explicit);
            if (jobs > 0 && explicit >= jobs / 2) {
              recentOther = other;
              recentOtherJobs = jobs;
              break;
            }
          }
        }
      }
      const idleBase = `${label} is idle: nothing in the queue is routed to ${label} right now.`;
      answer = {
        reason: 'no-ready-jobs',
        text: recentOther
          ? `${idleBase} The last ${recentOtherJobs} job${recentOtherJobs === 1 ? '' : 's'} went to ${recentOther} because their manifests named it.`
          : `${idleBase}`,
      };
    }
    out[label] = answer;
  }
  return out;
}

// One parsed state per file, bounded by count and source bytes. Oversized states
// can still be read for this request without living in the cache.
const stateCache = new Map();
const STATE_CACHE_ENTRIES = 512;
const STATE_CACHE_BYTES = 16 * 1024 * 1024;
let stateCacheBytes = 0;
function forgetState(file) {
  const hit = stateCache.get(file);
  if (hit) stateCacheBytes -= hit.bytes;
  stateCache.delete(file);
}
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
      let hit = touch(stateCache, file);
      if (!hit || hit.size !== stat.size || hit.mtimeMs !== stat.mtimeMs || hit.ctimeMs !== stat.ctimeMs || hit.ino !== stat.ino) {
        const source = await fs.readFile(file, 'utf8');
        const state = JSON.parse(source);
        forgetState(file);
        hit = { bytes: Buffer.byteLength(source), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, state: state && typeof state === 'object' && !Array.isArray(state) && (state.jobs === undefined || Array.isArray(state.jobs)) ? state : null };
        if (hit.bytes <= STATE_CACHE_BYTES) {
          while (stateCache.size >= STATE_CACHE_ENTRIES || stateCacheBytes + hit.bytes > STATE_CACHE_BYTES) {
            forgetState(stateCache.keys().next().value);
          }
          stateCache.set(file, hit);
          stateCacheBytes += hit.bytes;
        }
      }
      if (hit.state) runs.push({ id, state: hit.state, mtimeMs: stat.mtimeMs });
    } catch (error) {
      const code = error?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && error?.name !== 'SyntaxError') console.error('[tools/board-data.mjs] readRunStates run folder:', error?.message ?? error);
    }
  }
  return runs;
}

// A board project rooted at the main checkout owns the whole checkout family. A linked
// worktree keeps its own view; scratch worktrees are included when the caller supplies the
// scratch root (the fixture and the board both do this through SWARM_SCRATCH_ROOT).
export async function projectFamilyRoots(root, { ownOnly = false, env = process.env, extraRoots = [] } = {}) {
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  if (ownOnly || await mainWorktreeRoot(realRoot)) return [realRoot];
  let members;
  try { members = await worktreeFamily(realRoot, { all: true, env }); } catch (error) {
    console.error('[tools/board-data.mjs] projectFamilyRoots worktreeFamily:', error?.message ?? error);
    members = [realRoot];
  }
  const roots = new Set();
  for (const member of members ?? []) roots.add(await fs.realpath(member).catch(() => path.resolve(member)));
  const scratch = env?.SWARM_SCRATCH_ROOT || env?.SWARM_SCRATCH_DIR;
  const scratchRoot = scratch ? await fs.realpath(scratch).catch(() => path.resolve(scratch)) : null;
  const addScratch = candidate => {
    if (!scratchRoot || !candidate) return;
    const resolved = path.resolve(candidate);
    if (resolved === scratchRoot || resolved.startsWith(`${scratchRoot}${path.sep}`)) roots.add(resolved);
  };
  for (const candidate of extraRoots ?? []) addScratch(candidate);
  if (scratchRoot) {
    try {
      for (const name of await fs.readdir(scratchRoot)) {
        const candidate = path.join(scratchRoot, name);
        try { if ((await fs.stat(candidate)).isDirectory()) addScratch(candidate); } catch (error) {
          if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] projectFamilyRoots scratch entry:', error?.message ?? error);
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] projectFamilyRoots readdir scratch:', error?.message ?? error);
    }
  }
  return [...roots];
}

export async function readProjectRunStates(root, { ownOnly = false, env = process.env, extraRoots = [], limit = 5000, familyRoots = null } = {}) {
  const roots = familyRoots ?? await projectFamilyRoots(root, { ownOnly, env, extraRoots });
  const out = [];
  for (const member of roots) {
    const real = await fs.realpath(member).catch(() => path.resolve(member));
    for (const record of await readRunStates(real, { limit })) out.push({ ...record, root: real });
  }
  return out;
}

export function ticketDoneAtMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? at : NaN;
}

export async function lastTicketFinishedAt(roots, runs, ledgers, { env = process.env } = {}) {
  const scanRoots = new Set();
  const addRoot = async candidate => {
    if (!candidate) return;
    scanRoots.add(await fs.realpath(candidate).catch(() => path.resolve(candidate)));
  };
  for (const root of roots ?? []) await addRoot(root);
  const anchor = roots?.[0];
  if (anchor && !(await mainWorktreeRoot(anchor))) {
    try {
      for (const member of await worktreeFamily(anchor, { all: true, env })) await addRoot(member);
    } catch (error) {
      console.error('[tools/board-data.mjs] lastTicketFinishedAt worktreeFamily:', error?.message ?? error);
    }
    const scratch = env?.SWARM_SCRATCH_ROOT || env?.SWARM_SCRATCH_DIR;
    if (scratch) {
      const scratchRoot = await fs.realpath(scratch).catch(() => path.resolve(scratch));
      try {
        for (const name of await fs.readdir(scratchRoot)) {
          const candidate = path.join(scratchRoot, name);
          try {
            if ((await fs.stat(candidate)).isDirectory()) await addRoot(candidate);
          } catch (error) {
            if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] lastTicketFinishedAt scratch entry:', error?.message ?? error);
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] lastTicketFinishedAt readdir scratch:', error?.message ?? error);
      }
    }
  }
  const doneIds = new Set();
  for (const ledger of ledgers) for (const ticket of ledger?.tickets ?? []) if (ticket?.status === 'done' && ticket.id) doneIds.add(String(ticket.id));
  let newest = 0;
  const add = (id, value) => {
    const at = ticketDoneAtMs(value);
    if (id && Number.isFinite(at)) { doneIds.add(String(id)); newest = Math.max(newest, at); }
  };
  for (const root of scanRoots) {
    try { for (const [id, at] of await doneTimes(root)) add(id, at); } catch (error) {
      if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] lastTicketFinishedAt doneTimes:', error?.message ?? error);
    }
  }
  for (const ledger of ledgers) {
    const history = Array.isArray(ledger?.history) ? ledger.history : Array.isArray(ledger?.history?.events) ? ledger.history.events : [];
    for (const event of history) {
      const status = event?.status ?? event?.to ?? event?.nextStatus ?? event?.transition?.to;
      const id = event?.ticketId ?? event?.ticket ?? event?.transition?.ticketId;
      if (String(status).toLowerCase() === 'done') add(id, event?.at ?? event?.finishedAt ?? event?.updatedAt ?? event?.timestamp);
    }
  }
  for (const record of runs) {
    for (const job of record.state?.jobs ?? []) {
      const ids = [job?.ticketId, job?.ticket, job?.id].filter(Boolean).map(String);
      if (!ids.some(id => doneIds.has(id))) continue;
      for (const id of ids) add(id, job?.finishedAt);
    }
  }
  return newest ? new Date(newest).toISOString() : null;
}

async function familyLedgers(roots) {
  return Promise.all(roots.map(async root => await readLedger(root).catch((error) => {
    if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] familyLedgers readLedger:', error?.message ?? error);
    return null;
  })));
}

function finishedProgress(raw) {
  if (!raw) return null;
  const deployed = raw.milestones?.find(item => item.key === 'deployed');
  const deployDone = deployed?.state === 'done' || deployed?.currentDone === true;
  const noDeployConfigured = deployed?.state === 'unknown' || !deployed;
  const finished = Boolean(raw.finished && (deployDone || noDeployConfigured));
  const summary = progressSummary({ ...raw, finished });
  if (!finished && summary) summary.current = raw.milestones?.find(item => item.state === 'current')?.label ?? 'Unknown';
  return summary ? { ...summary, finished } : summary;
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

async function scopeFor(root, ledger) {
  let relative = ledger?.scope?.file ? String(ledger.scope.file) : null;
  if (!relative) {
    const roadmap = path.join(root, 'docs', 'scope', 'roadmap.md');
    try { await fs.stat(roadmap); relative = path.join('docs', 'scope', 'roadmap.md'); } catch { relative = path.join('docs', 'scope', 'scope.md'); }
  }
  const file = path.resolve(root, relative);
  const base = path.resolve(root);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) return null;
  // A ledger may name a scope document outside docs/scope. Remember that input
  // too, so editing it invalidates the overview without touching the ledger.
  if (!pathInside(file, path.join(root, 'docs', 'scope'))) remember(scopeInputs, root, new Set([file]));
  try { return parseScope(await fs.readFile(file, 'utf8')); } catch { return null; }
}

export function ticketsOf(ledger, scope = null) {
  const tickets = (ledger?.tickets ?? []).filter(t => t && typeof t === 'object' && t.type !== 'human');
  const byStatus = dict();
  for (const t of tickets) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const open = tickets.filter(t => ['todo', 'ready', 'running', 'review', 'blocked'].includes(t.status));
  const stageIds = open.map(ticket => effectiveStage(scope, ticket)).filter(stage => stage && stage !== 'none');
  const stageId = !tickets.length ? 'none' : stageIds.length ? stageIds.slice().sort((a, b) => stageNumber(a) - stageNumber(b) || a.localeCompare(b))[0] : (tickets.some(t => stageNumber(effectiveStage(scope, t)) > 0) ? 'done' : 'none');
  return { total: tickets.filter(t => !['cancelled', 'proposed'].includes(t.status)).length, open: open.length, blocked: byStatus.blocked ?? 0, proposed: byStatus.proposed ?? 0, byStatus: plain(byStatus), stage: stageId === 'done' ? 'done' : stageDisplay(scope, stageId), stageId };
}

// A linked worktree reads its own ledger; a main checkout reads the newest approved ledger in
// its family. Both board cards and project pages use this single ownership decision.
export async function boardOwnOnly(root) {
  return Boolean(await mainWorktreeRoot(root));
}

function familyRunningTickets(ledgers) {
  const ids = new Set();
  for (const ledger of ledgers ?? []) {
    for (const ticket of ledger?.tickets ?? []) if (ticket?.status === 'running' && ticket.id) ids.add(String(ticket.id));
  }
  return ids.size;
}

function checkoutsBuildingCount(roots, runs) {
  const liveRoots = new Set();
  for (const run of runs ?? []) if (activeRunState(run.state)) liveRoots.add(run.root);
  let count = 0;
  for (const root of roots ?? []) if (liveRoots.has(root)) count += 1;
  return count;
}

function blockedDependencyCard(ledger) {
  const byId = new Map((ledger?.tickets ?? []).map(ticket => [ticket.id, ticket]));
  const items = [];
  let waitingOnTickets = 0;
  for (const ticket of ledger?.tickets ?? []) {
    if (ticket?.status !== 'blocked') continue;
    const waitsOn = (ticket.dependsOn ?? []).filter(dep => byId.get(dep)?.status !== 'done');
    if (!waitsOn.length) continue;
    if (ticket.blockReason && ticket.blockReason !== 'deps') continue;
    waitingOnTickets += 1;
    const command = ticketReleaseAllowed(ticket, ledger) ? `swarm tickets ${ticket.id} --release` : null;
    items.push({ id: ticket.id, title: txt(ticket.title, 140), waitsOn, command });
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { waitingOnTickets, items };
}

function watchCardHeadsUp({ ledger, scope, recentJobCounts, slots, finished }) {
  if (finished) return null;
  const tree = checkTicketTree({ scope, tickets: ledger?.tickets ?? [] });
  const conflicts = tree.conflicts ?? [];
  if (conflicts.length) {
    const groups = new Map();
    for (const conflict of conflicts) {
      const stage = (ledger?.tickets ?? []).find(ticket => conflict.tickets?.includes(ticket.id))?.stage ?? 'unknown';
      const key = `${stage}\0${conflict.file}`;
      const entry = groups.get(key) ?? { stage, tickets: new Set() };
      for (const id of conflict.tickets ?? []) entry.tickets.add(id);
      groups.set(key, entry);
    }
    const worst = [...groups.values()].sort((a, b) => b.tickets.size - a.tickets.size)[0];
    const count = worst.tickets.size;
    const stageLabel = /^S\d+$/i.test(String(worst.stage)) ? `Stage ${worst.stage}` : `Stage ${worst.stage}`;
    return `${stageLabel} has ${count} ticket${count === 1 ? '' : 's'} that write the same file in the same wave, so they cannot run together.`;
  }
  const waves = underfilledWaves(recentJobCounts, slots);
  if (waves) return `${waves.charAt(0).toUpperCase()}${waves.slice(1)}.`;
  return null;
}

function guardBlockedLast24h(roots, now) {
  const since = now - DAY;
  let count = 0;
  for (const root of roots ?? []) {
    for (const event of readEvents(root, { limit: 4000 })) {
      if (event.e !== 'blocked') continue;
      const at = Date.parse(event.at ?? '');
      if (Number.isFinite(at) && at >= since && at <= now) count += 1;
    }
  }
  return count;
}

export function watchCardSlots({ held, familyProjectIds, projectId }) {
  const machineMax = held?.max ?? null;
  const inUse = held?.total ?? 0;
  const family = new Set([...(familyProjectIds ?? []), projectId].filter(Boolean));
  let byThisProject = 0;
  let byOtherProjects = 0;
  for (const [key, entry] of Object.entries(held?.byProject ?? {})) {
    const total = entry?.total ?? 0;
    if (family.has(key)) byThisProject += total;
    else if (key !== 'unknown') byOtherProjects += total;
  }
  return { machineMax, inUse, byThisProject, byOtherProjects };
}

export function enrichWatchCard(card, { held, familyProjectIds, projectId, inbox } = {}) {
  if (!card) return card;
  const need = needYouForProject(inbox, projectId);
  card.blocked.needYou = need.needYou;
  card.blocked.needYouItems = need.needYouItems;
  card.slots = watchCardSlots({ held, familyProjectIds, projectId });
  return card;
}

async function buildWatchCard({
  ledger,
  scope,
  ledgers,
  roots,
  runs,
  ticketFinishedAt,
  progressFinished,
  projectId,
  now,
  recentJobCounts,
  slots,
  historyFile,
}) {
  const readyList = ticketsReadyToRun(ledger?.tickets ?? []);
  const blocked = blockedDependencyCard(ledger);
  const eta = await cardEtaFromFamily({ roots, ledger, now });
  const familyTicketIds = new Set();
  for (const familyLedger of ledgers ?? []) {
    for (const ticket of familyLedger?.tickets ?? []) if (ticket?.id) familyTicketIds.add(String(ticket.id));
  }
  const untrackedSummary = boardUntrackedSummary(
    runs.map(run => ({ runId: run.id, state: run.state })),
    familyTicketIds,
    { now, projectId },
  );
  const headsUp = watchCardHeadsUp({ ledger, scope, recentJobCounts, slots, finished: progressFinished });
  return {
    now: {
      buildingTickets: familyRunningTickets(ledgers),
      checkoutsBuilding: checkoutsBuildingCount(roots, runs),
      lastTicketFinishedAt: ticketFinishedAt,
    },
    next: {
      ready: readyList.length,
      items: readyList.map(ticket => ({ id: ticket.id, title: txt(ticket.title, 140), command: `swarm tickets ${ticket.id}` })),
    },
    blocked: {
      waitingOnTickets: blocked.waitingOnTickets,
      items: blocked.items,
      needYou: 0,
      needYouItems: [],
    },
    slots: { machineMax: slots ?? null, inUse: 0, byThisProject: 0, byOtherProjects: 0 },
    eta,
    facts: {
      handEditsBlocked24h: guardBlockedLast24h(roots, now),
      untrackedRuns: untrackedSummary.headline.count ?? 0,
      listHref: untrackedSummary.listHref ?? `#${OFF_LEDGER_LIST_ANCHOR_ID}`,
      checkouts: (roots ?? []).length,
    },
    headsUp,
  };
}

// One project's lane on the board. `liveRuns` are the alive runs of THIS project only.
export async function projectOverview(project, liveRuns, options = {}) {
  const { now = Date.now(), env = process.env, historyFile, summary = projectSummary, deployStatus, prState } = options;
  const roots = options.familyRoots ?? await projectFamilyRoots(project.root, {
    ownOnly: options.worktree || Boolean(await mainWorktreeRoot(project.root)), env, extraRoots: options.extraRoots,
  });
  const identityOf = async () => JSON.stringify(await Promise.all([
    ...roots.map(root => projectFilesIdentity(root)),
    ...(historyFile ? [fileIdentity(historyFile)] : []),
  ]));
  const key = path.resolve(project.root);
  // Keep only the current context/aggregate. Changing live state and registry
  // metadata previously allocated another large key and aggregate each poll.
  const context = fingerprint([project, liveRuns, roots, options.slots, options.worktree, env,
    callbackId(summary), callbackId(deployStatus), prState]);
  const validatedIdentityOf = async () => fingerprint([context, await identityOf()]);
  const identity = await validatedIdentityOf();
  const hit = touch(overviewCache, key);
  if (hit?.identity === identity && cacheTimeValid(hit, now)) {
    options.profile?.({ kind: 'project', id: project.id, cached: true });
    return structuredClone(await hit.value);
  }
  const started = performance.now();
  const entry = { identity, at: now };
  entry.value = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = entry.identity;
      const value = await buildProjectOverview(project, liveRuns, { ...options, now, familyRoots: roots });
      const after = await validatedIdentityOf();
      if (before === after) return value;
      entry.identity = after;
    }
    throw new Error(`Project inputs kept changing during snapshot: ${project.id}`);
  })();
  remember(overviewCache, key, entry);
  try {
    const value = await entry.value;
    options.profile?.({ kind: 'project', id: project.id, cached: false, ms: performance.now() - started });
    return structuredClone(value);
  } catch (error) {
    if (overviewCache.get(key) === entry) overviewCache.delete(key);
    throw error;
  }
}

async function buildProjectOverview(project, liveRuns, { now = Date.now(), summary = projectSummary, historyFile = undefined, deployStatus = null, slots = null, worktree = false, env = process.env, familyRoots = null, extraRoots = [], prState = undefined } = {}) {
  const ownOnly = worktree || Boolean(await mainWorktreeRoot(project.root));
  const roots = familyRoots ?? await projectFamilyRoots(project.root, { ownOnly, env, extraRoots });
  const runs = await readProjectRunStates(project.root, { ownOnly, env, familyRoots: roots });
  const ledgers = ownOnly ? [await readLedger(project.root).catch((error) => {
    if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] projectOverview readLedger:', error?.message ?? error);
    return null;
  })] : await familyLedgers(roots);
  const liveStateRuns = [];
  const liveStateByRecord = new Map();
  for (const record of liveRuns) {
    const root = await fs.realpath(record.root ?? project.root).catch(() => record.root ?? project.root);
    const stateRun = runs.find(run => run.root === root && run.id === record.runId);
    if (stateRun) {
      liveStateRuns.push({ ...stateRun, liveRoot: root });
      liveStateByRecord.set(record, stateRun.state);
    }
  }
  const visibleRuns = new Map(runs.map(run => [`${run.root}|${run.id}`, run]));
  for (const run of liveStateRuns) visibleRuns.set(`${run.liveRoot}|${run.id}`, run);
  const liveRunsForAgents = [...visibleRuns.values()];
  // The caller's list is already a live snapshot. Registry-derived records carry their
  // state on the record; direct callers may only provide runId/root, so use the state file
  // we just read to keep those explicitly supplied live runs visible too.
  const activeLiveRuns = liveRuns.filter(record => {
    if (activeRunState(record.state)) return true;
    if (record.state !== undefined) return false;
    return activeRunState(liveStateByRecord.get(record));
  });
  const liveIds = new Set(activeLiveRuns.map(r => r.runId));
  let selected;
  try { selected = await ledgerRoot(project.root, { ownOnly }); } catch (error) {
    console.error('[tools/board-data.mjs] projectOverview ledgerRoot:', error?.message ?? error);
    selected = { root: project.root, ledger: await readLedger(project.root).catch((readError) => {
      if (readError?.code !== 'ENOENT') console.error('[tools/board-data.mjs] projectOverview readLedger fallback:', readError?.message ?? readError);
      return null;
    }) };
  }
  const ledger = selected.ledger;
  const scope = await scopeFor(selected.root, ledger);
  const spend = await summary(project.root).catch(error => ({ spendUsd: null, capUsd: null, capError: String(error.message).slice(0, 120) }));
  const capBasis = spend.capBasis ?? (typeof spend.billedUsd === 'number' ? 'billed' : 'billed+list');
  const capUsedUsd = capBasis === 'billed' ? spend.billedUsd : spend.spendUsd;
  const overviewSpend = { usd: capUsedUsd ?? spend.usd ?? spend.spendUsd ?? null, capUsd: spend.capUsd ?? null, reached: spend.reached ?? false, why: spend.why ?? null, capBasis };
  const rawProgress = await buildProgress({ root: project.root, projectId: project.id, now, historyFile, spend: overviewSpend, deploy: deployStatus ? deployStatus(project.root) : null, ownOnly, prState }).catch((error) => {
    console.error('[tools/board-data.mjs] projectOverview buildProgress:', error?.message ?? error);
    return null;
  });
  const progress = rawProgress ? { ...finishedProgress(rawProgress), overall: boardPercent(rawProgress), _rawFinished: rawProgress.finished } : null;
  const progressFinished = progress?._rawFinished ?? false;
  if (progress) delete progress._rawFinished;
  const cost = costOf(runs, now);
  const agents = agentsOf(liveRunsForAgents, liveIds, now);
  const lastRun = runs.slice().sort((a, b) => (Date.parse(b.state?.startedAt ?? '') || 0) - (Date.parse(a.state?.startedAt ?? '') || 0))[0]?.state ?? null;
  const ticketFinishedAt = await lastTicketFinishedAt(roots, runs, ledgers, { env });
  const ticketFinishedMs = Date.parse(ticketFinishedAt ?? '') || 0;
  const lastActivityMs = Math.max(
    0,
    ...runs.map(runActivityMs),
    ...liveRuns.map(r => Date.parse(r.startedAt ?? '') || 0),
    ...ledgers.map(item => Date.parse(item?.updatedAt ?? '') || 0),
    ticketFinishedMs,
  );
  const familyActivityAtMs = familyActivityMs({ runs, liveRunIds: liveIds, ledgers, liveRuns, ticketFinishedMs, now });
  const recentFailure = runs.some(run => {
    const at = Math.max(Date.parse(run.state?.finishedAt ?? '') || 0, Date.parse(run.state?.startedAt ?? '') || 0);
    return ['failed', 'timeout'].includes(run.state?.status) && at > 0 && at <= now && now - at <= 7 * DAY;
  });
  const tickets = ticketsOf(ledger, scope);
  const readyTickets = tickets.byStatus.ready ?? 0;
  const { activity, idle } = projectActivityState({ activeLiveCount: activeLiveRuns.length, lastActivityMs: familyActivityAtMs, now });
  const split = await splitQuality({ root: project.root, now, slots }).then(result => {
    const metrics = Array.isArray(result?.metrics) ? result.metrics : [];
    const red = metrics.filter(metric => metric?.grade === 'red');
    const amber = metrics.find(metric => metric?.grade === 'amber');
    return { grade: result?.grade ?? 'unknown', reds: red.length, worst: red[0]?.label ?? amber?.label ?? null };
  }).catch((error) => {
    console.error('[tools/board-data.mjs] projectOverview splitQuality:', error?.message ?? error);
    return null;
  });
  const handled = await handledForProject(project.root, { now }).catch((error) => {
    console.error('[tools/board-data.mjs] projectOverview handledForProject:', error?.message ?? error);
    return null;
  });
  const pinnedVersion = await pinnedVersionFor(project.root);
  const recentJobCounts = runs.slice().sort((a, b) => (Date.parse(a.state?.startedAt ?? '') || 0) - (Date.parse(b.state?.startedAt ?? '') || 0)).slice(-6).map(r => (Array.isArray(r.state.jobs) ? r.state.jobs.length : 0));
  const card = await buildWatchCard({
    ledger,
    scope,
    ledgers,
    roots,
    runs,
    ticketFinishedAt,
    progressFinished,
    projectId: project.id,
    now,
    recentJobCounts,
    slots,
    historyFile,
  });
  const installedVersion = await swarmPackageVersion();
  return {
    id: project.id, name: txt(project.name, 80), root: project.root,
    machine: os.hostname(),
    version: installedVersion,
    pinnedVersion,
    stage: tickets.stage, tickets, readyTickets, idleWithReady: activeLiveRuns.length === 0 && readyTickets > 0,
    live: liveRuns.map(r => { const hit = liveStateRuns.find(x => x.id === r.runId && x.liveRoot === r.root) ?? liveStateRuns.find(x => x.id === r.runId); const jobs = hit?.state.jobs ?? []; return { runId: r.runId, startedAt: r.startedAt ?? hit?.state.startedAt ?? null, status: txt(hit?.state.status ?? 'running', 30), jobs: jobs.length, done: jobs.filter(j => j.status === 'complete').length }; }),
    liveCount: activeLiveRuns.length,
    agents, cost,
    handled,
    orchestrator: (() => { try { return projectOrchestrator(project, { runs, now }); } catch { return { sessions: [], handBuilt: { files: 0, edits: 0, list: [] }, swarmBuilt: { files: 0 }, swarmPct: null, handPct: null, cost: { todayListUsd: 0, allListUsd: 0, todayTokens: 0, allTokens: 0 } }; } })(),
    spend: { usd: cost.allUsd, familyUsd: spend.spendUsd ?? null, familyBilledUsd: spend.billedUsd ?? null, capUsedUsd: capUsedUsd ?? null, sharedTrees: spend.sharedTrees ?? 1, capUsd: spend.capUsd ?? null, noCap: spend.capUsd === null || spend.capUsd === undefined ? !spend.capError : false, capInvalid: Boolean(spend.capError), reached: Boolean(spend.reached), capSource: spend.capSource ?? null, capInherited: Boolean(spend.capInherited), inheritedFrom: spend.inheritedFrom ?? null, why: spend.why ?? null, billedUsd: cost.paidUsd, listUsd: cost.flatRateListUsd, capBasis },
    progress,
    split,
    recentJobCounts,
    card,
    lastRunAt: lastRun?.startedAt ?? null,
    lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    lastTicketFinishedAt: ticketFinishedAt,
    checkouts: roots.length,
    activity,
    idle,
    testOrTemp: Boolean(project.testOrTemp),
    lastRunStatus: lastRun?.status ?? null,
    recentFailure,
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
export async function boardSnapshot({ projects, liveRuns, now = Date.now(), summary, historyFile = undefined, workers = null, lanes = null, laneState = null, worktreeRoot = mainWorktreeRoot, deployStatus = null, env = process.env, prState = undefined, profile } = {}) {
  const started = performance.now();
  const overviews = [];
  const realRoot = async root => await fs.realpath(root).catch(() => path.resolve(root));
  const inputProjects = Array.isArray(projects) ? projects : [];
  // A live registry entry is not enough by itself: a process can leave a stale entry after the
  // run state has finished. Paused runs remain live while their registry entry (and therefore
  // their worker process) is alive.
  const liveCandidates = await Promise.all((Array.isArray(liveRuns) ? liveRuns : []).map(async r => {
    const root = await realRoot(r.root);
    const state = (await readRunStates(root)).find(run => run.id === r.runId)?.state;
    // A registry record with no state status is still watchable for the short window in which
    // the state file is being finalized; it is not included in liveCount unless the state is live.
    return state && (activeRunState(state) || r.status === undefined) ? { ...r, root, state } : null;
  }));
  const live = liveCandidates.filter(Boolean);
  const registered = new Map();
  for (const project of inputProjects) registered.set(await realRoot(project.root), project);
  const parentIds = [];
  for (const project of inputProjects) {
    let parentRoot = null;
    try { parentRoot = await worktreeRoot(project.root); } catch { parentRoot = null; }
    const childReal = await realRoot(project.root);
    const parentReal = parentRoot ? await realRoot(parentRoot) : null;
    parentIds.push(parentReal && parentReal !== childReal && registered.has(parentReal) ? registered.get(parentReal).id : null);
  }
  const linkedRows = await Promise.all(inputProjects.map(async project => Boolean(await mainWorktreeRoot(await realRoot(project.root)))));
  const families = await Promise.all(inputProjects.map(async (project, index) => {
    const root = await realRoot(project.root);
    try {
      const members = linkedRows[index] ? [root] : await projectFamilyRoots(root, { env, extraRoots: inputProjects.map(item => item.root) });
      return new Set(await Promise.all(members.map(member => realRoot(member))));
    } catch { return new Set([root]); }
  }));
  // Keep injected/custom parent discovery useful in tests and for a registry that was written
  // before git's worktree metadata settled; the real family call above still adds unregistered
  // scratch/job worktrees.
  for (let i = 0; i < inputProjects.length; i += 1) {
    if (!parentIds[i]) continue;
    const childRoot = await realRoot(inputProjects[i].root);
    const parentIndex = inputProjects.findIndex(project => project.id === parentIds[i]);
    if (parentIndex >= 0) families[parentIndex].add(childRoot);
  }
  const overviewFamilyIds = [];
  for (let i = 0; i < inputProjects.length; i += 1) {
    const project = inputProjects[i];
    const projectRoot = await realRoot(project.root);
    const family = families[i];
    const ownFamily = linkedRows[i] ? new Set([projectRoot]) : family;
    const familyRuns = await readProjectRunStates(projectRoot, { ownOnly: linkedRows[i], env, familyRoots: [...ownFamily] });
    const displayName = String(project.name ?? '').trim();
    if ((!displayName || displayName === String(project.id)) && familyRuns.length === 0) continue;
    const candidates = parentIds[i]
      ? live.filter(r => r.root === projectRoot)
      : live.filter(r => family.has(r.root));
    const activeMine = candidates.filter(record => activeRunState(record.state));
    const mine = activeMine.length ? activeMine : candidates;
    overviews.push(await projectOverview(project, mine, { now, summary, historyFile, deployStatus, slots: workers?.max ?? null, worktree: Boolean(parentIds[i] || linkedRows[i]), env, familyRoots: parentIds[i] || !linkedRows[i] ? [...family] : null, extraRoots: inputProjects.map(item => item.root), prState, profile }));
    const familyIds = new Set([project.id]);
    for (const root of family) {
      const member = registered.get(root);
      if (member?.id) familyIds.add(member.id);
    }
    overviewFamilyIds.push(familyIds);
  }
  for (const overview of overviews) {
    overview.parentId = null;
    overview.worktree = false;
    overview.worktreeIds = [];
  }
  const byId = new Map(overviews.map(overview => [overview.id, overview]));
  for (let i = 0; i < inputProjects.length; i += 1) {
    const parentId = parentIds[i];
    if (!parentId) continue;
    const child = byId.get(inputProjects[i].id);
    if (!child) continue;
    child.parentId = parentId;
    child.worktree = true;
    const parentOverview = byId.get(parentId);
    if (parentOverview) parentOverview.worktreeIds.push(child.id);
  }
  for (const overview of overviews) {
    overview.worktreeIds.sort((a, b) => String(overviews.find(o => o.id === a)?.name ?? '').localeCompare(String(overviews.find(o => o.id === b)?.name ?? '')) || String(a).localeCompare(String(b)));
  }
  for (const overview of overviews) {
    if (!overview.worktreeIds.length || !overview.progress?.headline) continue;
    const count = overview.worktreeIds.length;
    overview.progress.headline += ` (incl. ${count} worktree${count === 1 ? '' : 's'})`;
  }
  let heldWorkers = { total: 0, max: workers?.max ?? null, byProject: {} };
  try { heldWorkers = await workersHeld({ dir: lanesDir(env), max: workers?.max ?? null }); } catch (error) {
    console.error('[tools/board-data.mjs] boardSnapshot workersHeld:', error?.message ?? error);
  }
  let inboxSnapshot = { items: [] };
  try {
    const identity = await boardSnapshotInputIdentity({ projects: inputProjects, env, historyFile });
    const laneIdentity = await fileIdentity(lanesDir(env), true);
    inboxSnapshot = await cachedAggregate(`inbox:${lanesDir(env)}`,
      fingerprint([inputProjects, env, identity, laneIdentity, heldWorkers]), now,
      () => boardInbox({ projects: inputProjects, now, env }));
  } catch (error) {
    console.error('[tools/board-data.mjs] boardSnapshot boardInbox:', error?.message ?? error);
  }
  for (let i = 0; i < overviews.length; i += 1) {
    enrichWatchCard(overviews[i].card, { held: heldWorkers, familyProjectIds: overviewFamilyIds[i], projectId: overviews[i].id, inbox: inboxSnapshot });
  }
  for (const o of overviews) {
    const liveWarnings = [];
    const wavesWarning = underfilledWaves(o.recentJobCounts, workers?.max ?? o.card?.slots?.machineMax);
    const waveHeadsUp = wavesWarning ? `${wavesWarning.charAt(0).toUpperCase()}${wavesWarning.slice(1)}.` : null;
    const splitHeadsUp = o.card?.headsUp && o.card.headsUp !== waveHeadsUp;
    const splitWarning = (o.split?.reds > 0 || o.split?.grade === 'red')
      ? {
        code: 'split-quality-red',
        text: splitHeadsUp ? o.card.headsUp : (o.split?.worst ? String(o.split.worst) : 'Split quality needs attention'),
      }
      : null;
    if (splitWarning) liveWarnings.push(splitWarning);
    if (wavesWarning) liveWarnings.push({ code: 'waves-underfilled', text: wavesWarning });
    const history = Array.isArray(o.history) ? o.history : [];
    o.history = o.progress?.finished ? [...history, ...liveWarnings] : history;
    o.warnings = o.progress?.finished ? [] : liveWarnings;
  }
  const blocked = overview => Boolean(
    overview.idleWithReady || overview.tickets?.blocked > 0 || overview.spend?.reached ||
    overview.recentFailure || overview.needsYou || overview.progress?.needsYou || overview.progress?.blocked,
  );
  const projectOrder = (a, b) => {
    const group = overview => (overview.liveCount ?? overview.live.length) ? 0 : blocked(overview) ? 1 : 2;
    return group(a) - group(b)
      || (Date.parse(b.lastActivityAt ?? '') || 0) - (Date.parse(a.lastActivityAt ?? '') || 0)
      || String(a.name ?? '').localeCompare(String(b.name ?? ''))
      || String(a.id ?? '').localeCompare(String(b.id ?? ''));
  };
  const top = overviews.filter(overview => !overview.parentId).sort(projectOrder);
  const ordered = [];
  for (const parent of top) {
    ordered.push(parent);
    overviews.filter(child => child.parentId === parent.id).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? ''))).forEach(child => ordered.push(child));
  }
  for (const overview of overviews) if (!ordered.includes(overview)) ordered.push(overview);
  overviews.splice(0, overviews.length, ...ordered);
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
    // Parent cards include their worktree runs, so the machine count uses the normalized registry
    // once rather than summing the intentionally overlapping parent/child cards.
    machine.orchestrator.sessions.push(...(o.orchestrator?.sessions ?? []));
    for (const name of o.orchestrator?.transcripts ?? []) transcripts.add(name);
    machine.orchestrator.handBuiltFiles += o.orchestrator?.handBuilt.files ?? 0; machine.orchestrator.swarmBuiltFiles += o.orchestrator?.swarmBuilt.files ?? 0;
  }
  machine.liveRuns = live.filter(run => activeRunState(run.state)).length;
  for (const key of ['todayUsd', 'weekUsd', 'flatRateTodayUsd', 'flatRateWeekUsd', 'allUsd', 'paidUsd', 'paidEstimatedUsd', 'flatRateListUsd']) machine.cost[key] = Math.round(machine.cost[key] * 1e6) / 1e6;
  // One session can be in two projects' logs: the machine totals count each message once over all transcripts.
  {
    const files = [...transcripts].sort();
    const identity = JSON.stringify(await Promise.all(files.map(file => fileIdentity(file))));
    const c = files.length ? await cachedAggregate(`usage:${lanesDir(env)}`, fingerprint([files, identity]), now,
      () => combinedUsage(files, { now })) : { todayListUsd: 0, allListUsd: 0 };
    machine.orchestrator.todayListUsd = c.todayListUsd; machine.orchestrator.allListUsd = c.allListUsd;
  }
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
  const recentLatest = dict();
  try {
    for (const project of inputProjects) {
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
          const latest = recentLatest[job.agent];
          if (!latest || finished > latest.finished) recentLatest[job.agent] = { finished, job };
        }
      }
    }
    for (const [agent, { finished, job }] of Object.entries(recentLatest)) {
      if (!isProviderLimitFailure(job)) continue;
      const entry = recent[agent] ??= { jobs: 0, explicit: 0 };
      entry.lastProviderLimitAt = finished;
    }
    const extra = typeof laneState === 'function' ? await laneState() : {};
    machine.laneIdle = laneIdleReasons({ running: machine.agents.byLane, ...valueObject(extra), todayUsd: machine.cost.laneToday ?? {}, queued, recent, now });
  } catch {
    machine.laneIdle = {};
  }
  profile?.({ kind: 'board', ms: performance.now() - started });
  return { at: new Date(now).toISOString(), machine, projects: overviews };
}

// One project's page: its tickets by status, its run history, its spend by lane and its lessons. Reads only under project.root.
export async function projectDetail(project, { now = Date.now(), liveRunIds = new Set(), summary = projectSummary, historyFile = undefined, deployStatus = null, slots = null, env = process.env, extraRoots = [] } = {}) {
  const ownOnly = await boardOwnOnly(project.root);
  const roots = await projectFamilyRoots(project.root, { ownOnly, env, extraRoots });
  const runs = await readProjectRunStates(project.root, { ownOnly, env, familyRoots: roots, limit: 200 });
  const ledgers = ownOnly ? [await readLedger(project.root).catch((error) => {
    if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] projectDetail readLedger:', error?.message ?? error);
    return null;
  })] : await familyLedgers(roots);
  let selected;
  try { selected = await ledgerRoot(project.root, { ownOnly }); } catch (error) {
    console.error('[tools/board-data.mjs] projectDetail ledgerRoot:', error?.message ?? error);
    selected = { root: project.root, ledger: await readLedger(project.root).catch((readError) => {
      if (readError?.code !== 'ENOENT') console.error('[tools/board-data.mjs] projectDetail readLedger fallback:', readError?.message ?? readError);
      return null;
    }) };
  }
  const ledger = selected.ledger;
  const scope = await scopeFor(selected.root, ledger);
  const tickets = (ledger?.tickets ?? []).filter(t => t && typeof t === 'object').slice(0, 1000).map(t => { const stageId = effectiveStage(scope, t); return { id: txt(t.id, 20), title: txt(t.title, 140), status: txt(t.status, 20), stage: stageDisplay(scope, stageId), stageId, risk: txt(t.risk, 10) }; });
  const byLane = dict();
  for (const { state } of runs) for (const job of state.jobs ?? []) { if (!job || typeof job !== 'object') continue; const usd = num(jobSpend(job).usd); if (!usd) continue; const label = laneLabel(job.agent, job.model); byLane[label] = Math.round(((byLane[label] ?? 0) + usd) * 1e6) / 1e6; }
  const lessons = await listLessons(project.root).then(r => r.lessons.slice(0, 200).map(l => ({ id: txt(l.id, 40), what: txt(l.what ?? l.title ?? l.rule, 200), stage: stageDisplay(scope, l.stage), stageId: txt(l.stage, 20) || 'none', status: txt(l.guard?.status ?? l.status, 20) })), () => []);
  const detailCost = costOf(runs, now);
  const spend = (await summary(project.root).catch(() => ({}))) ?? {};
  const capBasis = spend.capBasis ?? (typeof spend.billedUsd === 'number' ? 'billed' : 'billed+list');
  const capUsedUsd = capBasis === 'billed' ? spend.billedUsd : spend.spendUsd;
  const detailSpend = { usd: capUsedUsd ?? detailCost.allUsd, capUsd: spend.capUsd ?? null, reached: spend.reached ?? false, why: spend.why ?? null, capBasis };
  const progress = await buildProgress({ root: project.root, projectId: project.id, now, historyFile, spend: detailSpend, deploy: deployStatus ? deployStatus(project.root) : null, ownOnly }).then(raw => {
    if (!raw) return null;
    const overall = boardPercent(raw);
    return { ...raw, finished: finishedProgress(raw)?.finished ?? false, overall, percent: { ...raw.percent, overall } };
  }).catch((error) => {
    console.error('[tools/board-data.mjs] projectDetail buildProgress:', error?.message ?? error);
    return null;
  });
  const split = await splitQuality({ root: project.root, now, slots }).catch((error) => {
    console.error('[tools/board-data.mjs] projectDetail splitQuality:', error?.message ?? error);
    return null;
  });
  const benchmarks = await readScorecards(project.root).then(input => scorecardHistory(input)).catch((error) => {
    console.error('[tools/board-data.mjs] projectDetail readScorecards:', error?.message ?? error);
    return null;
  });
  const handled = await handledForProject(project.root, { now, limit: 20 }).catch((error) => {
    console.error('[tools/board-data.mjs] projectDetail handledForProject:', error?.message ?? error);
    return null;
  });
  const pinnedVersion = await pinnedVersionFor(project.root);
  const lastRun = runs.slice().sort((a, b) => (Date.parse(b.state?.startedAt ?? '') || 0) - (Date.parse(a.state?.startedAt ?? '') || 0))[0]?.state ?? null;
  const ticketFinishedAt = await lastTicketFinishedAt(roots, runs, ledgers, { env });
  const progressFinished = progress?.finished ?? false;
  const recentJobCounts = runs.slice().sort((a, b) => (Date.parse(a.state?.startedAt ?? '') || 0) - (Date.parse(b.state?.startedAt ?? '') || 0)).slice(-6).map(r => (Array.isArray(r.state?.jobs) ? r.state.jobs.length : 0));
  let card = await buildWatchCard({
    ledger,
    scope,
    ledgers,
    roots,
    runs,
    ticketFinishedAt,
    progressFinished,
    projectId: project.id,
    now,
    recentJobCounts,
    slots,
    historyFile,
  });
  let heldWorkers = { total: 0, max: slots ?? null, byProject: {} };
  try { heldWorkers = await workersHeld({ dir: lanesDir(env), max: slots ?? null }); } catch (error) {
    console.error('[tools/board-data.mjs] projectDetail workersHeld:', error?.message ?? error);
  }
  let inboxSnapshot = { items: [] };
  try { inboxSnapshot = await boardInbox({ projects: [project], now, env }); } catch (error) {
    console.error('[tools/board-data.mjs] projectDetail boardInbox:', error?.message ?? error);
  }
  enrichWatchCard(card, { held: heldWorkers, familyProjectIds: [project.id], projectId: project.id, inbox: inboxSnapshot });
  const installedVersion = await swarmPackageVersion();
  const lastActivityMs = Math.max(0, ...runs.map(runActivityMs), ...ledgers.map(item => Date.parse(item?.updatedAt ?? '') || 0), Date.parse(ticketFinishedAt ?? '') || 0);
  const scopeTickets = ticketsOf(ledger, scope);
  const readyTickets = scopeTickets.byStatus.ready ?? 0;
  const liveIds = liveRunIds;
  const { activity } = projectActivityState({ activeLiveCount: liveIds.size, lastActivityMs, now });
  const familyTicketIds = new Set();
  for (const familyLedger of ledgers ?? []) {
    for (const ticket of familyLedger?.tickets ?? []) if (ticket?.id) familyTicketIds.add(String(ticket.id));
  }
  const untrackedOnDisk = boardUntrackedSummary(
    runs.map(run => ({ runId: run.id, state: run.state })),
    familyTicketIds,
    { now, projectId: project.id },
  ).full;
  return {
    id: project.id, name: txt(project.name, 80), root: project.root,
    machine: os.hostname(),
    version: installedVersion,
    pinnedVersion,
    card,
    progress,
    readyTickets,
    activity,
    idleWithReady: liveIds.size === 0 && readyTickets > 0,
    tickets, ticketCounts: ticketsOf(ledger, scope),
    runs: runs.slice().reverse().map(({ id, state }) => {
      const jobs = state.jobs ?? [];
      return { runId: id, status: txt(state.status, 30), live: liveRunIds.has(id), startedAt: state.startedAt ?? null, finishedAt: state.finishedAt ?? null, jobs: jobs.length, done: jobs.filter(j => j.status === 'complete').length, failed: jobs.filter(j => ['failed', 'timeout'].includes(j.status)).length, costUsd: Math.round(runTotals(state).usd * 1e6) / 1e6 };
    }),
    spend: { ...detailCost, byLane: plain(byLane), billedUsd: detailCost.paidUsd, listUsd: detailCost.flatRateListUsd, capBasis },
    lastRunAt: lastRun?.startedAt ?? null,
    lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    lastTicketFinishedAt: ticketFinishedAt,
    checkouts: roots.length,
    untracked: untrackedOnDisk,
    splitQuality: split,
    benchmarks,
    handled,
    lessons,
  };
}

// Backfill for the history log from what is on disk (runs, spend, lessons, stages): events carry keys, so running it again adds nothing new.
export async function historyEventsOf(project) {
  const identity = fingerprint([project, await projectFilesIdentity(project.root)]);
  return cachedAggregate(`history:${path.resolve(project.root)}`, identity, Date.now(), () => buildHistoryEvents(project));
}

async function buildHistoryEvents(project) {
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
  const ledger = await readLedger(project.root).catch((error) => {
    if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] historyEventsOf readLedger:', error?.message ?? error);
    return null;
  });
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
  try { store = JSON.parse(await fs.readFile(path.join(dir, 'lanes.json'), 'utf8')); } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] workersHeld read lanes.json:', error?.message ?? error);
  }
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
  try { store = JSON.parse(await fs.readFile(path.join(spendDirectory, 'daily.json'), 'utf8')); } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] laneUsage read daily.json:', error?.message ?? error);
  }
  const spent = store && typeof store.entries === 'object' && store.entries ? laneDayTotals(store, { day }) : {};
  let lanes = null;
  try { lanes = JSON.parse(await fs.readFile(path.join(lanesDirectory, 'lanes.json'), 'utf8')); } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] laneUsage read lanes.json:', error?.message ?? error);
  }
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
      const ledger = await readLedger(project.root).catch((error) => {
        if (error?.code !== 'ENOENT') console.error('[tools/board-data.mjs] enrichRunEvents readLedger:', error?.message ?? error);
        return null;
      });
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
