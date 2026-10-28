// SPDX-License-Identifier: Apache-2.0
// Read-only project split-quality metrics for the board's future panel.
import fs from 'node:fs/promises';
import { readLedger, logPath } from './tickets.mjs';
import { readRunStates } from './board-data.mjs';

const DAY = 86400000;
const PERCENT = value => `${Math.round(value * 100)}%`;
const UNKNOWN = '—';
const isoAt = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
};

// Ratios are stored as decimals; boundaries are inclusive and intentionally kept in one table.
export const SPLIT_THRESHOLDS = Object.freeze({
  overhead: Object.freeze({ green: 0.20, amber: 0.35 }),
  firstTry: Object.freeze({ green: 0.80, amber: 0.60 }),
  criticalPath: Object.freeze({ green: 0.15, amber: 0.25 }),
  waveFill: Object.freeze({ green: 0.75, amber: 0.50 }),
  collisions: Object.freeze({ green: 0, amber: 2 }),
  reviewCost: Object.freeze({ green: 0.25, amber: 0.75 }),
  sizes: Object.freeze({ green: 0.30, amber: 0.50 }),
});

const asTime = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : NaN;
};

const asTickets = ledger => Array.isArray(ledger?.tickets) ? ledger.tickets.filter(t => t && typeof t === 'object') : [];
const asJobs = state => Array.isArray(state?.jobs) ? state.jobs.filter(job => job && typeof job === 'object') : [];
const activeTickets = tickets => tickets.filter(ticket => !['cancelled', 'proposed'].includes(ticket.status));
const ratioGrade = (value, threshold) => value <= threshold.green ? 'green' : value <= threshold.amber ? 'amber' : 'red';
const inverseRatioGrade = (value, threshold) => value >= threshold.green ? 'green' : value >= threshold.amber ? 'amber' : 'red';
const countGrade = (value, threshold) => value === threshold.green ? 'green' : value <= threshold.amber ? 'amber' : 'red';

function metric({ key, label, value = null, display = UNKNOWN, unit, grade = 'unknown', basis, note }) {
  return { key, label, value, display, unit, grade, basis, note };
}

function unknownMetric(key, label, unit, basis, note) {
  return metric({ key, label, unit, basis, note });
}

async function readTicketEvents(root) {
  try {
    const text = await fs.readFile(logPath(root), 'utf8');
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
      } catch (parseError) { if (!(parseError instanceof SyntaxError)) console.error('[tools/split-quality.mjs] ticket event log line:', parseError?.message ?? parseError); }
    }
    return events;
  } catch {
    return [];
  }
}

async function readProjectData(root, now, windowDays) {
  const [ledger, events, runs] = await Promise.all([
    readLedger(root).catch((error) => {
      if (error?.code !== 'ENOENT') console.error('[tools/split-quality.mjs] readLedger:', error?.message ?? error);
      return null;
    }),
    readTicketEvents(root),
    readRunStates(root).catch(() => []),
  ]);
  const since = now - Math.max(0, Number.isFinite(windowDays) ? windowDays : 14) * DAY;
  const windowRuns = (Array.isArray(runs) ? runs : []).filter(run => {
    const started = asTime(run?.state?.startedAt);
    return Number.isFinite(started) && started >= since && started <= now;
  });
  return { ledger, tickets: asTickets(ledger), events, runs: windowRuns };
}

function isOverheadJob(job) {
  const type = String(job.type ?? '').toLowerCase();
  return ['review', 'fix', 'merge', 'test-fix'].includes(type) || Number(job.attempt) > 1 || /(^|-)(review|fix|retry|merge)(-|$)/.test(String(job.id ?? ''));
}

function computeOverhead(runs) {
  const jobs = runs.flatMap(run => asJobs(run.state));
  if (!jobs.length) return unknownMetric('overhead', 'Overhead ratio', '%', 'Run jobs started within the selected window.', 'No jobs started in the selected window.');
  const overhead = jobs.filter(isOverheadJob).length;
  const value = overhead / jobs.length;
  return metric({ key: 'overhead', label: 'Overhead ratio', value, display: PERCENT(value), unit: '%', grade: ratioGrade(value, SPLIT_THRESHOLDS.overhead), basis: `${overhead} overhead jobs / ${jobs.length} jobs`, note: 'Review, fix, merge, retry, and later-attempt jobs count as overhead.' });
}

function computeFirstTry(tickets, events) {
  const done = tickets.filter(ticket => ticket.status === 'done');
  if (!done.length) return unknownMetric('firstTry', 'First-try pass rate', '%', 'Done tickets and their transition history.', 'No done tickets are available.');
  const failed = new Set(events.filter(event => event.event === 'transition' && (event.to === 'blocked' || (['running', 'review'].includes(event.from) && ['todo', 'ready'].includes(event.to)))).map(event => event.id));
  const passed = done.filter(ticket => !failed.has(ticket.id)).length;
  const value = passed / done.length;
  return metric({ key: 'firstTry', label: 'First-try pass rate', value, display: PERCENT(value), unit: '%', grade: inverseRatioGrade(value, SPLIT_THRESHOLDS.firstTry), basis: `${passed} first-try tickets / ${done.length} done tickets`, note: 'A blocked transition or a running/review reset disqualifies a ticket.' });
}

function longestPath(tickets) {
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));
  const memo = new Map();
  const visit = (id, visiting) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    const nextVisiting = new Set(visiting).add(id);
    const ticket = byId.get(id);
    let length = 1;
    for (const dependency of Array.isArray(ticket?.dependsOn) ? ticket.dependsOn : []) {
      if (byId.has(dependency)) length = Math.max(length, 1 + visit(dependency, nextVisiting));
    }
    memo.set(id, length);
    return length;
  };
  let longest = 0;
  for (const ticket of tickets) longest = Math.max(longest, visit(ticket.id, new Set()));
  return longest;
}

function computeCriticalPath(tickets) {
  const active = activeTickets(tickets);
  if (!active.length) return unknownMetric('criticalPath', 'Critical path', '%', 'Non-cancelled, non-proposed tickets and dependsOn.', 'No non-cancelled, non-proposed tickets are available.');
  const longest = longestPath(active);
  const value = longest / active.length;
  return metric({ key: 'criticalPath', label: 'Critical path', value, display: `${longest} of ${active.length} (${PERCENT(value)})`, unit: '%', grade: ratioGrade(value, SPLIT_THRESHOLDS.criticalPath), basis: `${longest} tickets on the longest dependency chain / ${active.length} active tickets`, note: 'Dependency cycles are bounded and do not extend the path indefinitely.' });
}

function computeWaveFill(runs, slots) {
  if (!runs.length) return unknownMetric('waveFill', 'Wave fill', '%', 'Runs started within the selected window.', 'No runs started in the selected window.');
  const recent = runs.slice().sort((a, b) => asTime(a.state.startedAt) - asTime(b.state.startedAt)).slice(-6);
  const requestedSlots = Number(slots);
  const maxJobs = Math.max(...recent.map(run => asJobs(run.state).length), 0);
  const capacity = Number.isFinite(requestedSlots) && requestedSlots > 0 ? requestedSlots : maxJobs;
  if (!capacity) return unknownMetric('waveFill', 'Wave fill', '%', 'Jobs per run divided by machine slots.', 'Runs exist, but no positive slot capacity or jobs were recorded.');
  const value = recent.reduce((sum, run) => sum + Math.min(1, asJobs(run.state).length / capacity), 0) / recent.length;
  return metric({ key: 'waveFill', label: 'Wave fill', value, display: PERCENT(value), unit: '%', grade: inverseRatioGrade(value, SPLIT_THRESHOLDS.waveFill), basis: `${recent.length} runs; ${capacity} slots`, note: 'Each run fill is capped at 100% before averaging.' });
}

function hasRecordedConflicts(state) {
  return [state?.mergeQueue?.conflicts, state?.integration?.conflicts, state?.conflicts].some(conflicts => Array.isArray(conflicts) && conflicts.length > 0);
}

function computeCollisions(runs) {
  if (!runs.length) return unknownMetric('collisions', 'Collisions', 'collisions', 'Run conflict records and conflicting jobs.', 'No runs started in the selected window.');
  const runCollisions = runs.filter(run => hasRecordedConflicts(run.state)).length;
  const jobCollisions = runs.flatMap(run => asJobs(run.state)).filter(job => /conflict/i.test(String(job.status ?? '') + ' ' + String(job.error ?? ''))).length;
  const value = runCollisions + jobCollisions;
  return metric({ key: 'collisions', label: 'Collisions', value, display: String(value), unit: 'collisions', grade: countGrade(value, SPLIT_THRESHOLDS.collisions), basis: `${runCollisions} conflicting runs + ${jobCollisions} conflicting jobs`, note: 'A run with any recorded integration conflict counts once; conflicting jobs count individually.' });
}

function isReviewJob(job) {
  return String(job.type ?? '').toLowerCase() === 'review' || /review/i.test(String(job.id ?? ''));
}

function computeReviewCost(runs, events, now, windowDays) {
  const since = now - Math.max(0, Number.isFinite(windowDays) ? windowDays : 14) * DAY;
  const doneIds = new Set(events.filter(event => event.event === 'transition' && event.to === 'done' && Number.isFinite(asTime(event.at)) && asTime(event.at) >= since && asTime(event.at) <= now).map(event => event.id).filter(id => typeof id === 'string'));
  if (!doneIds.size) return unknownMetric('reviewCost', 'Review $ per ticket', '$/ticket', 'Review job costUsd divided by tickets transitioned to done in the selected window.', 'No tickets transitioned to done in the selected window.');
  const cost = runs.flatMap(run => asJobs(run.state)).filter(isReviewJob).reduce((sum, job) => sum + (Number.isFinite(Number(job.costUsd)) ? Math.max(0, Number(job.costUsd)) : 0), 0);
  const value = cost / doneIds.size;
  return metric({ key: 'reviewCost', label: 'Review $ per ticket', value, display: `$${value.toFixed(2)}`, unit: '$/ticket', grade: ratioGrade(value, SPLIT_THRESHOLDS.reviewCost), basis: `$${cost.toFixed(2)} review cost / ${doneIds.size} tickets done`, note: 'Only review jobs and done transitions inside the selected window are counted.' });
}

function computeSizes(tickets) {
  const counted = activeTickets(tickets);
  if (!counted.length) return unknownMetric('sizes', 'Ticket sizes', '% M', 'Non-cancelled, non-proposed tickets classified by size.', 'No non-cancelled, non-proposed tickets are available.');
  const m = counted.filter(ticket => ticket.size === 'M' || (Array.isArray(ticket.files) && ticket.files.length > 6)).length;
  const s = counted.length - m;
  const value = m / counted.length;
  return metric({ key: 'sizes', label: 'Ticket sizes', value, display: `${s} S · ${m} M (${PERCENT(value)} M)`, unit: '% M', grade: ratioGrade(value, SPLIT_THRESHOLDS.sizes), basis: `${m} M-sized / ${counted.length} counted tickets`, note: 'Tickets with more than 6 files are counted as M even without an M size marker.' });
}

function unknownResult(now) {
  const metrics = [
    unknownMetric('overhead', 'Overhead ratio', '%', 'Run jobs started within the selected window.', 'Project data could not be read.'),
    unknownMetric('firstTry', 'First-try pass rate', '%', 'Done tickets and their transition history.', 'Project data could not be read.'),
    unknownMetric('criticalPath', 'Critical path', '%', 'Non-cancelled, non-proposed tickets and dependsOn.', 'Project data could not be read.'),
    unknownMetric('waveFill', 'Wave fill', '%', 'Jobs per run divided by machine slots.', 'Project data could not be read.'),
    unknownMetric('collisions', 'Collisions', 'collisions', 'Run conflict records and conflicting jobs.', 'Project data could not be read.'),
    unknownMetric('reviewCost', 'Review $ per ticket', '$/ticket', 'Review job costUsd divided by tickets transitioned to done in the selected window.', 'Project data could not be read.'),
    unknownMetric('sizes', 'Ticket sizes', '% M', 'Non-cancelled, non-proposed tickets classified by size.', 'Project data could not be read.'),
  ];
  return { metrics, grade: 'unknown', at: isoAt(now) };
}

export async function splitQuality({ root, now = Date.now(), slots = null, windowDays = 14 } = {}) {
  const time = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  try {
    const { ledger, tickets, events, runs } = await readProjectData(root, time, windowDays);
    const metrics = [
      computeOverhead(runs),
      computeFirstTry(tickets, events),
      computeCriticalPath(tickets),
      computeWaveFill(runs, slots),
      computeCollisions(runs),
      computeReviewCost(runs, events, time, windowDays),
      computeSizes(tickets),
    ];
    const known = metrics.map(item => item.grade).filter(grade => grade !== 'unknown');
    const grade = known.length ? ['red', 'amber', 'green'].find(candidate => known.includes(candidate)) : 'unknown';
    return { metrics, grade, at: isoAt(time) };
  } catch {
    return unknownResult(time);
  }
}
