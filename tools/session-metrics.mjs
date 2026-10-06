// SPDX-License-Identifier: Apache-2.0
// Field lesson 133: a background scout/ask run, and check/mutant execution inside integrate, were
// both invisible to session-level idle-time accounting — neither wrote a record anywhere a reader
// could find. Every record here shares the same {startedAt, finishedAt, costUsd} property names a
// run's own state.json carries at its top level, so one reader can scan both shapes the same way.
import fs from 'node:fs/promises';
import path from 'node:path';

export const SESSION_METRICS_DIR = '.swarm/session-metrics';
const KIND_RE = /^[a-z]+$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

function recordPath(root, kind, id) {
  if (!KIND_RE.test(kind)) throw new Error(`Invalid session-metrics kind: ${kind}`);
  if (!ID_RE.test(id)) throw new Error(`Invalid session-metrics id: ${id}`);
  return path.join(root, SESSION_METRICS_DIR, kind, `${id}.json`);
}

export async function writeSessionMetric(root, kind, id, { startedAt, finishedAt = null, costUsd = null, ...metadata } = {}) {
  if (typeof startedAt !== 'string' || !startedAt) throw new Error('writeSessionMetric requires startedAt');
  // Keep newer fields (checks, jobs, attribution, and provider metadata) without changing the
  // legacy record keys or requiring every writer to know about every metric version.
  const record = { ...metadata, kind, id, startedAt, finishedAt, costUsd };
  const target = recordPath(root, kind, id);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await fs.rename(temporary, target);
  return record;
}

// Every record back, oldest first; missing or corrupt entries are skipped, never thrown, since
// this reads records this same module wrote, not a place a caller reports errors against.
export async function readSessionMetrics(root, { kinds } = {}) {
  const base = path.join(root, SESSION_METRICS_DIR);
  let kindDirs;
  try { kindDirs = await fs.readdir(base, { withFileTypes: true }); } catch { return []; }
  const records = [];
  for (const entry of kindDirs) {
    if (!entry.isDirectory() || (kinds && !kinds.includes(entry.name))) continue;
    const dir = path.join(base, entry.name);
    let files;
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try { records.push(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))); } catch { /* skip unreadable/corrupt */ }
    }
  }
  return records.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}

// Per skill: jobs that had it attached (named or paths, never index-only) vs jobs that did not,
// and each group's own rework share — the fraction whose outputs were touched again by another
// job, of a later run of the same root, within 24h of this job finishing. `jobs` is a flat list
// across every run of interest, each `{ root, runId, startedAt, finishedAt, outputs, skills }`,
// the same shape a run's own state.json job record already carries.
const DAY_MS = 24 * 60 * 60 * 1000;
export function reworkBySkill(jobs) {
  const names = new Set();
  for (const job of jobs) for (const skill of job.skills ?? []) if (skill.attached !== 'index-only') names.add(skill.name);
  const hasSkill = (job, name) => (job.skills ?? []).some(skill => skill.name === name && skill.attached !== 'index-only');
  const followedUp = job => jobs.some(other => other !== job && other.root === job.root && other.runId !== job.runId
    && Date.parse(other.startedAt ?? other.finishedAt ?? '') > Date.parse(job.finishedAt ?? '')
    && Date.parse(other.startedAt ?? other.finishedAt ?? '') - Date.parse(job.finishedAt ?? '') <= DAY_MS
    && (other.outputs ?? []).some(file => (job.outputs ?? []).includes(file)));
  const summarize = group => { const rework = group.filter(followedUp).length; return { jobs: group.length, reworkJobs: rework, reworkShare: group.length ? rework / group.length : null }; };
  const result = {};
  for (const name of names) result[name] = { withSkill: summarize(jobs.filter(job => hasSkill(job, name))), withoutSkill: summarize(jobs.filter(job => !hasSkill(job, name))) };
  return result;
}

function summarizeJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const followedUp = job => list.some(other => other !== job && other.root === job.root && other.runId !== job.runId
    && Date.parse(other.startedAt ?? other.finishedAt ?? '') > Date.parse(job.finishedAt ?? '')
    && Date.parse(other.startedAt ?? other.finishedAt ?? '') - Date.parse(job.finishedAt ?? '') <= DAY_MS
    && (other.outputs ?? []).some(file => (job.outputs ?? []).includes(file)));
  const reworkJobs = list.filter(followedUp).length;
  return { jobs: list.length, reworkJobs, reworkShare: list.length ? reworkJobs / list.length : null };
}

function failedCheck(check) {
  if (!check || typeof check !== 'object') return false;
  if (check.passed === false || check.ok === false) return true;
  return ['failed', 'failed-check', 'red', 'error', 'timeout'].includes(check.status);
}

function metricJobs(input) {
  if (Array.isArray(input)) return input.flatMap(record => record?.jobs ?? []);
  if (Array.isArray(input?.jobs)) return input.jobs;
  return (input?.records ?? []).flatMap(record => record?.jobs ?? []);
}

function metricIntegrates(input) {
  if (Array.isArray(input?.integrates)) return input.integrates;
  if (Array.isArray(input?.records)) return input.records.filter(record => record?.kind === 'integrate');
  if (input?.kind === 'integrate') return [input];
  return [];
}

// Lesson #365: rework is the useful primary health signal. `checksPassed` is deliberately not
// consulted here: an integrate with no checks has no evidence for a red rate, even if an older
// caller persisted a truthy checksPassed flag.
export function summarizeSessionMetrics(input = {}) {
  const jobs = metricJobs(input);
  const integrates = metricIntegrates(input);
  const checks = integrates.flatMap(integrate => Array.isArray(integrate?.checks) ? integrate.checks : []);
  const reworkShare = reworkBySkill(jobs);
  return {
    reworkShare,
    // Keep the explicit old name for consumers that adopted the helper before this summary.
    reworkBySkill: reworkShare,
    reworkShareOverall: summarizeJobs(jobs).reworkShare,
    red_rate: checks.length ? checks.filter(failedCheck).length / checks.length : 'n/a: no integrate checks',
  };
}

function timeValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value ?? '');
}

function stepTime(step) {
  return timeValue(step?.at ?? step?.timestamp ?? step?.startedAt ?? step?.time);
}

// Lesson #369: a hand step is attribution, not a worker window. It is therefore attached to an
// idle gap only when its timestamp falls inside that gap. Existing records without hand steps
// retain their exact legacy shape.
export function idleGaps(records, { minMinutes = 5, handSteps = [] } = {}) {
  const usable = (records ?? [])
    .filter(record => typeof record?.startedAt === 'string' && typeof record?.finishedAt === 'string')
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const gaps = [];
  for (let index = 1; index < usable.length; index++) {
    const start = usable[index - 1].finishedAt;
    const end = usable[index].startedAt;
    const minutes = (Date.parse(end) - Date.parse(start)) / 60000;
    if (Number.isFinite(minutes) && minutes >= minMinutes) {
      const gap = { start, end, minutes: Math.round(minutes * 10) / 10 };
      const steps = [...handSteps, ...(usable[index - 1].handSteps ?? []), ...(usable[index].handSteps ?? [])]
        .filter(step => stepTime(step) >= Date.parse(start) && stepTime(step) <= Date.parse(end))
        .map(step => typeof step === 'string' ? step : step.step ?? step.label ?? step.name ?? step.attribution)
        .filter(Boolean);
      if (steps.length) gap.handSteps = [...new Set(steps)];
      gaps.push(gap);
    }
  }
  return gaps;
}

function asNow(value) {
  const result = timeValue(value);
  return Number.isFinite(result) ? result : Date.now();
}

function taskIsRunnable(task) {
  if (!task || task.blocked === true || task.unblocked === false || task.runnable === false) return false;
  return !['blocked', 'complete', 'completed', 'done', 'closed', 'cancelled'].includes(task.status);
}

// Return event records instead of printing them so the monitor's JSON snapshot stays
// machine-readable and callers can choose their own presentation.
export function idleSeatEvents({ now = Date.now(), jobs = [], tasks = [], lastWorkerFinishedAt, idleSince, minMinutes = 5 } = {}) {
  if (jobs.some(job => ['running', 'starting', 'in-progress'].includes(job?.status))) return [];
  const nowMs = asNow(now);
  const sinceMs = timeValue(lastWorkerFinishedAt ?? idleSince);
  if (!Number.isFinite(sinceMs)) return [];
  const idleMinutes = (nowMs - sinceMs) / 60000;
  if (!Number.isFinite(idleMinutes) || idleMinutes < minMinutes) return [];
  const runnableItems = (tasks ?? []).filter(taskIsRunnable);
  return [{
    type: 'idle-seat',
    since: new Date(sinceMs).toISOString(),
    at: new Date(nowMs).toISOString(),
    idleMinutes: Math.round(idleMinutes * 10) / 10,
    runnableTasks: runnableItems.map(task => task.id ?? task.taskId ?? task.key).filter(Boolean),
    runnableItems,
  }];
}

// Row #210: a coordinator's own idle time between two recorded windows (whatever kind each is —
// a run, checks, mutants, ask, scout) is exactly the gap between one record's end and the next
// record's start; only a gap this long is worth a lesson row of its own, so anything shorter is
// left out rather than padding the list with routine turnaround.
