// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanSecretsDetailed } from './security-scan.mjs';

const HASH = /^[a-f0-9]{64}$/;
const PROJECT_ID = /^[a-f0-9]{8,64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_CATEGORY = /^[a-z0-9-]{1,32}$/;
const SAFE_TAG = /^[a-z0-9-]{1,32}$/;
const MAX_EXPORT_BYTES = 512 * 1024;
const KNOWN_AREAS = new Set(['tool', 'gotchas', 'security', 'release', 'testing', 'workflow']);
const KNOWN_LANES = new Set(['fast', 'standard', 'slow', 'cheap', 'mid', 'expensive']);
const KNOWN_LESSON_STATUSES = new Set(['queued', 'built', 'shipped', 'dropped', 'open', 'closed']);
const SEMVER_LIKE = /^\d+\.\d+\.\d+$/;
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}T/;
const HOME_PATH = /(?:^|[^A-Za-z0-9])\/(?:Users|home)\/[^/\s]+\//;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/;
const PHONE = /(?:^|[^\d])(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?:$|[^\d])/;

const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asString = value => typeof value === 'string' ? value : '';
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function projectHash(projectId) {
  return createHash('sha256').update(String(projectId ?? ''), 'utf8').digest('hex');
}

function jsonText(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function piiKinds(text) {
  const kinds = [];
  if (EMAIL.test(text)) kinds.push('email');
  if (PHONE.test(text)) kinds.push('phone');
  if (IPV4.test(text)) kinds.push('ipv4');
  if (HOME_PATH.test(text)) kinds.push('home-path');
  return kinds;
}

function unsafeError(reason, findings = []) {
  const label = reason ?? [...findings].sort().join(', ');
  const error = new Error(`field-export-unsafe: ${label}`);
  error.code = 'field-export-unsafe';
  if (reason) error.reason = reason;
  error.findings = reason ? [reason] : [...findings].sort();
  return error;
}

async function assertSafe(text, scan, kinds = []) {
  const found = new Set(kinds);
  const scanResult = await scan([{ path: 'field-export.json', content: text }]);
  const secretFindings = Array.isArray(scanResult) ? scanResult : scanResult?.findings;
  if (Array.isArray(scanResult?.skipped) && scanResult.skipped.length > 0) throw unsafeError('scan-skipped');
  const pii = piiKinds(text);
  for (const kind of pii) found.add(kind);
  if (Array.isArray(secretFindings) && secretFindings.length > 0) found.add('secret');
  if (found.size > 0) throw unsafeError(null, found);
}

function safeLessonId(value) {
  const id = asString(value);
  return SAFE_ID.test(id) ? id : createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 12);
}

function safeCategory(value, known) {
  return typeof value === 'string' && (known.has(value) || SAFE_CATEGORY.test(value)) ? value : 'other';
}

function safeLessonStatus(value) {
  return typeof value === 'string' && KNOWN_LESSON_STATUSES.has(value) ? value : 'other';
}

function safeLessonVersion(value) {
  return typeof value === 'string' && SEMVER_LIKE.test(value) ? value : null;
}

function safeLessonCreatedAt(value) {
  return typeof value === 'string' && ISO_DATE_PREFIX.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

function projectLessons(lessons) {
  return lessons.map(lesson => ({
    id: safeLessonId(lesson?.id),
    area: safeCategory(lesson?.area, KNOWN_AREAS),
    status: safeLessonStatus(lesson?.status),
    version: safeLessonVersion(lesson?.version),
    createdAt: safeLessonCreatedAt(lesson?.createdAt),
    ruleLength: typeof lesson?.rule === 'string' ? lesson.rule.length : 0,
    tags: Array.isArray(lesson?.tags) ? lesson.tags.filter(tag => typeof tag === 'string' && SAFE_TAG.test(tag)).slice(0, 10) : [],
  }));
}

function firstValue(objects, keys) {
  for (const object of objects) {
    const source = asObject(object);
    for (const key of keys) {
      const value = finiteNumber(source[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function jobStatus(job) {
  const status = asString(asObject(job).status || asObject(job).result || job).toLowerCase();
  if (['pass', 'passed', 'success', 'succeeded', 'complete', 'completed'].includes(status)) return 'pass';
  if (['fail', 'failed', 'failure', 'error', 'errored'].includes(status)) return 'fail';
  return null;
}

function jobMinutes(job) {
  const source = asObject(job);
  const minutes = firstValue([source], ['minutes', 'durationMinutes', 'elapsedMinutes', 'medianMinutes']);
  if (minutes !== null) return minutes;
  const milliseconds = firstValue([source], ['durationMs', 'elapsedMs', 'durationMilliseconds']);
  return milliseconds === null ? null : milliseconds / 60000;
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function runAggregate(state) {
  const root = asObject(state);
  const summary = asObject(root.summary);
  const outcome = asObject(root.outcome);
  const nested = [root, summary, outcome];
  const jobsValue = root.jobs ?? summary.jobs ?? outcome.jobs;
  const jobs = Array.isArray(jobsValue) ? jobsValue : null;
  const jobSummary = asObject(jobsValue);
  const countSources = [...nested, jobSummary];
  const counts = jobs ? jobs.reduce((result, job) => {
    const status = jobStatus(job);
    if (status) result[status]++;
    return result;
  }, { pass: 0, fail: 0 }) : null;
  const explicitJobs = firstValue(countSources, ['jobs', 'jobCount', 'totalJobs', 'total']);
  const explicitPass = firstValue(countSources, ['pass', 'passed', 'passCount', 'passedJobs']);
  const explicitFail = firstValue(countSources, ['fail', 'failed', 'failCount', 'failedJobs']);
  const durationValues = Array.isArray(jobSummary.durations) ? jobSummary.durations : [];
  const durations = jobs ? jobs.map(jobMinutes).filter(value => value !== null)
    : durationValues.map(value => finiteNumber(value)).filter(value => value !== null);
  const explicitMedian = firstValue([...countSources], ['medianMinutes', 'medianDurationMinutes']);
  return {
    lane: safeCategory(typeof root.lane === 'string' ? root.lane : summary.lane, KNOWN_LANES),
    jobs: jobs ? jobs.length : explicitJobs,
    pass: counts && explicitPass === null ? counts.pass : explicitPass,
    fail: counts && explicitFail === null ? counts.fail : explicitFail,
    medianMinutes: explicitMedian === null ? median(durations) : explicitMedian,
  };
}

async function readRunStates(root) {
  const runsDir = path.join(root, '.swarm', 'runs');
  let entries;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const states = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const stateFile = path.join(runsDir, entry.name, 'state.json');
    let text;
    try {
      text = await fs.readFile(stateFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    let state;
    try { state = JSON.parse(text); } catch { continue; }
    states.push(runAggregate(state));
  }
  return states;
}

async function readProjectLessons(root, projectId) {
  const lessonsRoot = path.resolve(root, 'lessons');
  const folder = path.resolve(lessonsRoot, projectId);
  const relative = path.relative(lessonsRoot, folder);
  if (!PROJECT_ID.test(projectId) || relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('field-export-bad-project');
    error.code = 'field-export-bad-project';
    throw error;
  }
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const lessons = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
    let parsed;
    try { parsed = JSON.parse(await fs.readFile(path.join(folder, entry.name), 'utf8')); } catch { continue; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) lessons.push(parsed);
  }
  return lessons;
}

function exportedAt(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('field export requires a valid now value');
  return date.toISOString();
}

export async function exportFieldData(root, { now, projectId, scan = scanSecretsDetailed } = {}) {
  if (typeof scan !== 'function') throw new TypeError('field export scan must be a function');
  if (projectId === undefined || projectId === null || String(projectId).length === 0) {
    throw new TypeError('field export requires projectId');
  }
  const rawProjectId = String(projectId);
  const lessons = await readProjectLessons(root, rawProjectId);
  const inputText = jsonText(lessons);
  const data = {
    projectId: projectHash(rawProjectId),
    exportedAt: exportedAt(now),
    lessons: projectLessons(lessons),
    runs: await readRunStates(root),
  };
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EXPORT_BYTES) throw unsafeError('export-too-large');
  await assertSafe(inputText, scan);
  await assertSafe(serialized, scan);
  return data;
}

export async function writeFieldExport(root, data, { dir } = {}) {
  const output = asObject(data);
  if (!HASH.test(asString(output.projectId))) throw new TypeError('field export projectId must be a hash');
  const stamp = asString(output.exportedAt || output.generatedAt);
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime())) throw new TypeError('field export requires exportedAt');
  const folder = path.resolve(root, dir ?? path.join('.swarm', 'field', 'exports'));
  const file = path.join(folder, `${date.toISOString().slice(0, 10)}-${output.projectId}.json`);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(output)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}
