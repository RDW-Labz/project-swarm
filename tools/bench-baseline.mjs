// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PAID_LANES, spendDir } from './spend.mjs';
import { readLedger, logPath } from './tickets.mjs';
import { readJournal } from './journal.mjs';
import { readEvents } from './orchestrator-events.mjs';
import { combinedUsage } from './orchestrator-usage.mjs';
import { LOG_FILE } from './handbuild.mjs';
import { scanSecrets } from './security-scan.mjs';

const dayKey = at => new Date(at).toISOString().slice(0, 10);
const inWindow = (at, since, until) => {
  const t = Date.parse(at);
  return Number.isFinite(t) && t >= Date.parse(since) && t <= Date.parse(until);
};

/** Field-export style: timing-related failure causes count as flaky when not on the flake list. */
export function isTimingFailure(cause) {
  const s = String(cause ?? '').toLowerCase();
  return /\b(timeout|timed out|timing|flake|flaky|race|intermittent|slow test|latency|econnreset|etimedout|socket hang up)\b/.test(s);
}

function jobCategory(job) {
  const id = String(job?.id ?? '');
  const role = String(job?.role ?? '').toLowerCase();
  if (role === 'review' || /^review[-:]/i.test(id)) return 'reviews';
  if (role === 'orchestrator') return 'orchestrator';
  return 'workers';
}

function emptyUsdSplit() {
  return { workers: 0, reviews: 0, orchestrator: 0 };
}

function finalizeUsdSplit(raw) {
  return {
    workers: roundUsd(raw.workers ?? 0),
    reviews: roundUsd(raw.reviews ?? 0),
    orchestrator: roundUsd(raw.orchestrator ?? 0),
  };
}

function finalizeBilledSplit(raw) {
  return {
    workers: roundUsd(raw._workersBilled ?? 0),
    reviews: roundUsd(raw._reviewsBilled ?? 0),
    orchestrator: roundUsd(raw._orchestratorBilled ?? 0),
  };
}

function roundUsd(n) {
  return Math.round(n * 1e6) / 1e6;
}

function jobListUsd(job) {
  if (typeof job?.costUsd === 'number' && Number.isFinite(job.costUsd)) return job.costUsd;
  if (typeof job?.listUsd === 'number' && Number.isFinite(job.listUsd)) return job.listUsd;
  return 0;
}

function jobBilledUsd(job) {
  const lane = job?.agent;
  if (!PAID_LANES.includes(lane)) return 0;
  if (typeof job?.costUsd === 'number' && Number.isFinite(job.costUsd)) return job.costUsd;
  return 0;
}

function parseTicketLog(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object') out.push(e);
    } catch (error) {
      if (error?.name !== 'SyntaxError') console.error('[tools/bench-baseline.mjs] parseTicketLog JSON.parse:', error?.message ?? error);
    }
  }
  return out;
}

async function defaultReadRuns(root) {
  const dir = path.join(root, '.swarm', 'runs');
  const runs = [];
  let names = [];
  try { names = await fs.readdir(dir); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  for (const name of names) {
    const file = path.join(dir, name, 'state.json');
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      runs.push({ runId: state.id ?? state.runId ?? name, ...state });
    } catch (error) {
      if (error.code !== 'ENOENT') { /* ignore bad run dirs */ }
    }
  }
  return runs;
}

async function defaultReadTicketLog(root) {
  try { return await fs.readFile(logPath(root), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function defaultReadHandbuildLog(root) {
  try { return await fs.readFile(path.join(root, LOG_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function defaultReadSpendStore(_root, env = process.env) {
  const file = path.join(spendDir(env), 'daily.json');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function defaultReadOrchestratorUsage(root, events) {
  const names = [...new Set((events ?? []).map(e => e.tp).filter(Boolean))];
  if (!names.length) return null;
  return combinedUsage(names);
}

function waveRecordsFromRuns(runs) {
  const waves = [];
  for (const run of runs ?? []) {
    if (Array.isArray(run.waves)) waves.push(...run.waves);
    else if (Array.isArray(run.waveRecords)) waves.push(...run.waveRecords);
  }
  return waves;
}

function ticketPrNumber(ticket) {
  if (Number.isInteger(ticket?.pr)) return ticket.pr;
  if (Number.isInteger(ticket?.pullRequest)) return ticket.pullRequest;
  return null;
}

function firstTransition(log, id, to) {
  const hits = log
    .filter(e => e.event === 'transition' && e.id === id && e.to === to && e.at)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return hits[0] ?? null;
}

function mergedTicketIds({ ledger, ticketLog, mergedPullRequests, since, until }) {
  const prByNumber = new Map((mergedPullRequests ?? []).map(pr => [pr.number, pr]));
  const tickets = ledger?.tickets ?? [];
  const ids = new Set();
  for (const t of tickets) {
    const pr = ticketPrNumber(t);
    if (pr != null && prByNumber.has(pr)) {
      const mergedAt = prByNumber.get(pr).mergedAt;
      if (inWindow(mergedAt, since, until)) ids.add(t.id);
      continue;
    }
    if (t.status === 'done') {
      const done = firstTransition(ticketLog, t.id, 'done');
      if (done && inWindow(done.at, since, until)) ids.add(t.id);
    }
  }
  return [...ids].sort();
}

function jobsInWindow(runs, since, until) {
  const jobs = [];
  for (const run of runs ?? []) {
    const runId = run.runId ?? run.id;
    for (const job of run.jobs ?? []) {
      const end = job.finishedAt ?? job.startedAt;
      if (!end || !inWindow(end, since, until)) continue;
      jobs.push({ ...job, runId });
    }
  }
  return jobs;
}

function linkJobsToTickets(jobs, ticketIds) {
  const set = new Set(ticketIds);
  const byTicket = new Map(ticketIds.map(id => [id, []]));
  for (const job of jobs) {
    const tid = job.ticketId ?? job.ticket;
    if (tid && set.has(tid)) byTicket.get(tid).push(job);
  }
  return byTicket;
}

function countInterruptions({ journal, orchEvents, handbuildLog, since, until }) {
  const perDay = new Map();
  const bump = (at) => {
    if (!inWindow(at, since, until)) return;
    const d = dayKey(at);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  };
  for (const e of journal ?? []) {
    const at = e.ts ?? e.at;
    if (!at) continue;
    if (e.kind === 'decision') bump(at);
    if (e.kind === 'action' && /approve|approval/i.test(String(e.action ?? ''))) bump(at);
    if (e.kind === 'blocker' && e.resolved === true && (e.resolvedBy === 'owner' || e.by === 'owner')) bump(at);
  }
  for (const e of orchEvents ?? []) {
    if (e.e === 'blocked' && inWindow(e.at, since, until)) bump(e.at);
  }
  for (const line of parseHandbuildLines(handbuildLog)) {
    if ((line.event === 'approve' || line.event === 'deny') && line.by === 'owner') bump(line.at);
  }
  return perDay;
}

function parseHandbuildLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (error) {
      if (error?.name !== 'SyntaxError') console.error('[tools/bench-baseline.mjs] parseHandbuildLines JSON.parse:', error?.message ?? error);
    }
  }
  return out;
}

function countIncidents({ journal, handbuildLog, since, until }) {
  let dirty = 0, branch = 0, falsePos = 0;
  const bump = (e, at) => { if (!inWindow(at, since, until)) return; return true; };
  for (const e of journal ?? []) {
    const at = e.ts ?? e.at;
    if (!at) continue;
    const action = String(e.action ?? e.code ?? '');
    if (e.kind === 'action' && /dirty[-_]?tree/i.test(action)) { if (bump(e, at)) dirty += 1; }
    if (e.kind === 'action' && /branch[-_]?switch/i.test(action)) { if (bump(e, at)) branch += 1; }
    if (e.kind === 'action' && /guard[-_]?false[-_]?positive/i.test(action)) { if (bump(e, at)) falsePos += 1; }
  }
  for (const line of parseHandbuildLines(handbuildLog)) {
    if (!line.at) continue;
    if (line.event === 'dirty-tree' && bump(line, line.at)) dirty += 1;
    if (line.event === 'branch-switch' && bump(line, line.at)) branch += 1;
    if (line.event === 'false-positive' && bump(line, line.at)) falsePos += 1;
  }
  return { dirty_tree_incidents: dirty, branch_switch_incidents: branch, guard_false_positives: falsePos };
}

function idleSlotPct(waves, since, until) {
  const rows = (waves ?? []).filter(w => w?.at && inWindow(w.at, since, until));
  if (!rows.length) return { status: 'missing', note: 'wave records', value: null, unit: 'percent', n: 0 };
  let idle = 0, slots = 0;
  for (const w of rows) {
    const ready = Array.isArray(w.readyTickets) ? w.readyTickets.length : Number(w.ready ?? 0);
    const cap = Number(w.slots);
    if (!Number.isFinite(cap) || cap <= 0 || ready <= 0) continue;
    const used = Math.min(ready, cap);
    idle += cap - used;
    slots += cap;
  }
  if (!slots) return { status: 'missing', note: 'wave records', value: null, unit: 'percent', n: 0 };
  const value = Math.round((idle / slots) * 1000) / 10;
  return { status: 'estimated', note: 'wave records', value, unit: 'percent', n: rows.length };
}

function metricMeasured(value, unit, n = 1, note = null) {
  return { value, unit, status: 'measured', n, note };
}

function metricMissing(note) {
  return { value: null, unit: null, status: 'missing', n: 0, note };
}

function metricEstimated(value, unit, n, note) {
  return { value, unit, status: 'estimated', n, note };
}

function assertBaselinePrivacy(baseline) {
  const content = JSON.stringify(baseline);
  const findings = scanSecrets([{ path: 'baseline.json', content }]);
  if (findings.length) throw new Error(`baseline-privacy: ${findings[0].rule}`);
}

function defaultReaders(root) {
  return {
    readRuns: () => defaultReadRuns(root),
    readLedger: () => readLedger(root),
    readTicketLog: () => defaultReadTicketLog(root),
    readJournal: () => readJournal(root, { limit: Infinity }),
    readOrchestratorEvents: () => readEvents(root, { limit: Infinity }),
    readHandbuildLog: () => defaultReadHandbuildLog(root),
    readSpendStore: env => defaultReadSpendStore(root, env),
    readOrchestratorUsage: events => defaultReadOrchestratorUsage(root, events),
  };
}

export async function collectBaseline({
  root,
  project,
  since,
  until,
  now = Date.now,
  readers: readerOverrides = null,
  mergedPullRequests = [],
  flakeList = [],
  processEnv = process.env,
} = {}) {
  const readers = { ...defaultReaders(root), ...readerOverrides };
  const [runs, ledger, ticketLogText, journal, orchEvents, handbuildLog, spendStore] = await Promise.all([
    readers.readRuns(root),
    readers.readLedger(root),
    readers.readTicketLog(root),
    readers.readJournal(root),
    readers.readOrchestratorEvents(root),
    readers.readHandbuildLog(root),
    readers.readSpendStore(root, processEnv),
  ]);
  const ticketLog = parseTicketLog(ticketLogText);
  let orchUsage = null;
  if (readers.readOrchestratorUsage) {
    try { orchUsage = await readers.readOrchestratorUsage(root, orchEvents); }
    catch { orchUsage = null; }
  }

  const mergedIds = mergedTicketIds({ ledger, ticketLog, mergedPullRequests, since, until });
  const jobs = jobsInWindow(runs, since, until);
  const jobsByTicket = linkJobsToTickets(jobs, mergedIds);
  const waves = waveRecordsFromRuns(runs);

  const perTicket = [];
  const readyMs = [];
  const prByNumber = new Map((mergedPullRequests ?? []).map(pr => [pr.number, pr]));

  for (const id of mergedIds) {
    const ticket = (ledger?.tickets ?? []).find(t => t.id === id);
    const ready = firstTransition(ticketLog, id, 'ready');
    const prNum = ticket ? ticketPrNumber(ticket) : null;
    let readyToMergedMs = null;
    let readyStatus = 'estimated';
    if (ready) {
      const pr = prNum != null ? prByNumber.get(prNum) : null;
      if (pr?.mergedAt) {
        readyToMergedMs = Date.parse(pr.mergedAt) - Date.parse(ready.at);
        readyStatus = 'measured';
      } else {
        const done = firstTransition(ticketLog, id, 'done');
        if (done) readyToMergedMs = Date.parse(done.at) - Date.parse(ready.at);
      }
    }
    if (readyToMergedMs !== null && Number.isFinite(readyToMergedMs)) readyMs.push(readyToMergedMs);

    const listRaw = emptyUsdSplit();
    const billedRaw = emptyUsdSplit();
    for (const job of jobsByTicket.get(id) ?? []) {
      const cat = jobCategory(job);
      const list = jobListUsd(job);
      const billed = jobBilledUsd(job);
      listRaw[cat] = (listRaw[cat] ?? 0) + list;
      billedRaw[cat] = (billedRaw[cat] ?? 0) + billed;
    }
    perTicket.push({
      id,
      readyToMergedMs,
      readyStatus,
      billedUsd: finalizeBilledSplit({ _workersBilled: billedRaw.workers, _reviewsBilled: billedRaw.reviews, _orchestratorBilled: billedRaw.orchestrator }),
      listUsd: finalizeUsdSplit(listRaw),
    });
  }

  const totalList = emptyUsdSplit();
  const totalBilled = emptyUsdSplit();
  for (const row of perTicket) {
    for (const k of ['workers', 'reviews', 'orchestrator']) {
      totalList[k] += row.listUsd[k] ?? 0;
      totalBilled[k] += row.billedUsd[k] ?? 0;
    }
  }

  const completeJobs = jobs.filter(j => j.status === 'complete');
  const firstTry = completeJobs.filter(j => (j.retries ?? 0) === 0);
  const retryTotal = jobs.reduce((s, j) => s + (Number.isFinite(j.retries) ? j.retries : 0), 0);
  const flakes = new Set(flakeList ?? []);
  let flaky = 0;
  for (const job of jobs) {
    if (job.status === 'complete') continue;
    const testName = job.testName ?? job.failedTest ?? job.check;
    if (testName && flakes.has(testName)) { flaky += 1; continue; }
    const cause = job.error ?? job.failure ?? job.message ?? '';
    if (isTimingFailure(cause)) flaky += 1;
  }

  const interruptions = countInterruptions({ journal, orchEvents, handbuildLog, since, until });
  const incidents = countIncidents({ journal, handbuildLog, since, until });
  const idle = idleSlotPct(waves, since, until);

  let orchTokensMetric = metricMissing('orchestrator usage');
  if (orchUsage && Number.isFinite(orchUsage.allTokens)) {
    const per = mergedIds.length ? orchUsage.allTokens / mergedIds.length : null;
    orchTokensMetric = metricMeasured(per, 'tokens', mergedIds.length, null);
  }

  const anyEstimatedReady = perTicket.some(t => t.readyStatus === 'estimated');
  const readyMetric = mergedIds.length && readyMs.length
    ? (anyEstimatedReady
      ? metricEstimated(
        readyMs.reduce((a, b) => a + b, 0) / readyMs.length,
        'ms',
        readyMs.length,
        'done transition used without merged pull request',
      )
      : metricMeasured(readyMs.reduce((a, b) => a + b, 0) / readyMs.length, 'ms', readyMs.length, null))
    : mergedIds.length
      ? metricMissing('ticket transitions')
      : metricMissing('merged tickets');

  const spendNote = spendStore ? null : 'spend store';
  const billedStatus = jobs.length ? 'measured' : metricMissing('run states').status;
  const listStatus = jobs.length ? 'measured' : 'missing';

  const metrics = {
    ready_to_merged_ms: readyMetric,
    billed_usd: billedStatus === 'missing'
      ? metricMissing('run states')
      : { value: finalizeBilledSplit({ _workersBilled: totalBilled.workers, _reviewsBilled: totalBilled.reviews, _orchestratorBilled: totalBilled.orchestrator }), unit: 'usd', status: 'measured', n: mergedIds.length, note: spendNote },
    list_usd: listStatus === 'missing'
      ? metricMissing('run states')
      : { value: finalizeUsdSplit(totalList), unit: 'usd', status: 'measured', n: mergedIds.length, note: null },
    first_try_pass_rate: jobs.length
      ? metricMeasured(completeJobs.length ? firstTry.length / completeJobs.length : 0, 'ratio', completeJobs.length, null)
      : metricMissing('run states'),
    retries: jobs.length ? metricMeasured(retryTotal, 'count', jobs.length, null) : metricMissing('run states'),
    flaky_failures: jobs.length
      ? (flakes.size || jobs.some(j => j.status !== 'complete')
        ? metricEstimated(flaky, 'count', jobs.length, 'timing classifier')
        : metricMeasured(flaky, 'count', jobs.length, null))
      : metricMissing('run states'),
    owner_interruptions_per_day: journal
      ? metricMeasured([...interruptions.values()].reduce((a, b) => a + b, 0), 'count', interruptions.size, null)
      : metricMissing('journal'),
    idle_slot_pct: idle,
    dirty_tree_incidents: journal || handbuildLog
      ? metricMeasured(incidents.dirty_tree_incidents, 'count', 1, null)
      : metricMissing('journal or handbuild log'),
    branch_switch_incidents: journal || handbuildLog
      ? metricMeasured(incidents.branch_switch_incidents, 'count', 1, null)
      : metricMissing('journal or handbuild log'),
    guard_false_positives: journal || handbuildLog
      ? metricMeasured(incidents.guard_false_positives, 'count', 1, null)
      : metricMissing('journal or handbuild log'),
    orchestrator_tokens_per_merged_ticket: orchTokensMetric,
  };

  const perDay = [...interruptions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, n]) => ({ day, interruptions: n }));

  const baseline = {
    version: 1,
    project,
    window: { since, until },
    generatedAt: new Date(now()).toISOString(),
    metrics,
    perTicket: perTicket.map(({ readyStatus: _s, ...rest }) => rest),
    perDay,
  };

  assertBaselinePrivacy(baseline);
  return baseline;
}

export function formatBaseline(baseline) {
  const m = baseline?.metrics ?? {};
  const lines = [
    `Baseline ${baseline?.project ?? ''}`.trim(),
    `Window: ${baseline?.window?.since ?? ''} .. ${baseline?.window?.until ?? ''}`,
    '',
    '| metric | value | status | n |',
    '| --- | --- | --- | --- |',
  ];
  for (const [name, row] of Object.entries(m)) {
    let val = row?.value;
    if (val && typeof val === 'object') val = `w:${val.workers} r:${val.reviews} o:${val.orchestrator}`;
    lines.push(`| ${name} | ${val ?? '-'} | ${row?.status ?? '-'} | ${row?.n ?? 0} |`);
  }
  lines.push('', 'Per ticket:', '| id | ready_ms | billed_w | list_w |', '| --- | --- | --- | --- |');
  for (const t of baseline?.perTicket ?? []) {
    lines.push(`| ${t.id} | ${t.readyToMergedMs ?? '-'} | ${t.billedUsd?.workers ?? 0} | ${t.listUsd?.workers ?? 0} |`);
  }
  if (lines.length > 40) return lines.slice(0, 39).join('\n') + '\n…';
  return lines.join('\n');
}

export async function writeBaseline({ baseline, file }) {
  assertBaselinePrivacy(baseline);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.bench-baseline.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(baseline, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await handle.close().catch((closeError) => { console.error('[tools/bench-baseline.mjs] writeBaseline handle.close:', closeError?.message ?? closeError, tmp); });
    await fs.rm(tmp, { force: true });
    throw error;
  }
}
