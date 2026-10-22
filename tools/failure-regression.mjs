// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { scrubText } from './errors.mjs';
import { safeWritableDir } from './journal.mjs';

export const FAILURE_STATUSES = new Set(['failed', 'timed-out', 'timedout', 'timeout', 'blocked']);
const SUMMARY_MAX = 120;
const REGRESSION_KEY_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX_RE = /\b[0-9a-fA-F]{16,}\b/g;
const HOME_RE = /(?:[A-Za-z]:\\Users\\[^\\]{1,64}|\/(?:Users|home)\/[^/\\]{1,64}|\/root(?=\/|\b))(?:[\\/][^\s'"),;]+)?/g;
const PATHISH_RE = /(?:[A-Za-z]:)?(?:\.\.?\/|\/)?[^\s'"]*(?:[\\/][^\s'"]+)+/g;

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function jobLane(job) {
  return String(job?.lane ?? job?.agent ?? '').trim();
}

function jobErrorText(job) {
  const raw = job?.error;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    return String(raw.message ?? raw.reason ?? raw.code ?? job.status ?? 'failure');
  }
  if (typeof job?.reason === 'string') return job.reason;
  return String(job?.status ?? 'failure');
}

export function normalizeCauseKey(message) {
  let text = String(message ?? '');
  text = text
    .replace(HOME_RE, ' ')
    .replace(PATHISH_RE, ' ')
    .replace(UUID_RE, ' ')
    .replace(HEX_RE, ' ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' ');
  text = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return text
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function jobSeenAt(job, runState) {
  const candidate = job?.finishedAt ?? job?.startedAt ?? runState?.finishedAt ?? runState?.startedAt ?? null;
  return typeof candidate === 'string' ? candidate : null;
}

function causeFromJob(runId, job, runState) {
  const summarySource = jobErrorText(job);
  const key = normalizeCauseKey(summarySource);
  const summary = clip(scrubText(summarySource, SUMMARY_MAX), SUMMARY_MAX);
  return {
    key,
    lane: jobLane(job),
    firstSeenAt: jobSeenAt(job, runState),
    runId,
    jobId: String(job?.id ?? ''),
    summary,
  };
}

function mergeCause(into, incoming) {
  if (!into) return incoming;
  const a = into.firstSeenAt;
  const b = incoming.firstSeenAt;
  if (a && b) {
    return Date.parse(b) < Date.parse(a) ? incoming : into;
  }
  if (b && !a) return incoming;
  return into;
}

export function failureCausesFromRuns(runStates) {
  const byKey = new Map();
  if (!runStates || typeof runStates !== 'object' || Array.isArray(runStates)) return [];

  for (const [runId, state] of Object.entries(runStates)) {
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    for (const job of jobs) {
      if (!FAILURE_STATUSES.has(job?.status)) continue;
      const cause = causeFromJob(runId, job, state);
      if (!cause.key) continue;
      byKey.set(cause.key, mergeCause(byKey.get(cause.key), cause));
    }
  }

  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export async function knownCauses(root) {
  const file = path.join(root, '.swarm/field/failure-causes.json');
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.causes)) return raw.causes;
    return [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export function newFailureCauses(causes, known) {
  const knownKeys = new Set(
    (known ?? []).map(entry => (typeof entry === 'string' ? entry : entry?.key)).filter(Boolean),
  );
  return (causes ?? []).filter(cause => cause?.key && !knownKeys.has(cause.key));
}

export function regressionStubFor(cause) {
  const key = String(cause?.key ?? 'unknown');
  const relPath = `tests/regressions/${key}.test.mjs`;
  const runId = String(cause?.runId ?? '');
  const jobId = String(cause?.jobId ?? '');
  const summary = String(cause?.summary ?? key);
  const todo = `Regression stub for ${summary}. Reproduce from run ${runId}, job ${jobId}.`;
  const content = [
    '// SPDX-License-Identifier: Apache-2.0',
    "import { test } from 'node:test';",
    '',
    `test.todo(${JSON.stringify(todo)}, () => {`,
    '});',
    '',
  ].join('\n');
  return { path: relPath, content };
}

export async function materializeRegressionStubs(root, causes, { writeFile, mkdir, stat } = fs) {
  const entries = (causes ?? []).map(cause => {
    const key = cause?.key;
    if (typeof key !== 'string' || !REGRESSION_KEY_RE.test(key)) throw new Error(`failure-regression-key-invalid: ${String(key ?? '')}`);
    const stub = regressionStubFor(cause);
    return { file: path.join(root, stub.path), content: stub.content };
  });
  if (!entries.length) return { written: [], skipped: [] };

  const directory = path.join(root, 'tests', 'regressions');
  await mkdir(directory, { recursive: true });
  const written = [];
  const skipped = [];
  for (const { file, content } of entries) {
    let exists = false;
    try {
      await stat(file);
      exists = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (exists) {
      skipped.push(file);
      continue;
    }
    try {
      await writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
      written.push(file);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      skipped.push(file);
    }
  }
  return { written, skipped };
}

export async function recordCauses(root, causes) {
  const existing = await knownCauses(root);
  const byKey = new Map(existing.map(entry => [entry.key, entry]));
  for (const cause of causes ?? []) {
    if (!cause?.key) continue;
    byKey.set(cause.key, mergeCause(byKey.get(cause.key), cause));
  }
  const merged = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const dir = await safeWritableDir(root, ['.swarm', 'field']);
  const file = path.join(dir, 'failure-causes.json');
  await fs.writeFile(file, `${JSON.stringify({ version: 1, causes: merged }, null, 2)}\n`, { mode: 0o600 });
  return merged;
}

// tools/swarm.mjs wiring is owned by the other seat; this is the single-call conversion hook.
export async function captureNewFailureCauses(root, runStates, deps = {}) {
  const readKnown = deps.knownCauses ?? knownCauses;
  const materialize = deps.materializeRegressionStubs ?? materializeRegressionStubs;
  const record = deps.recordCauses ?? recordCauses;
  const causes = failureCausesFromRuns(runStates);
  const known = await readKnown(root);
  const newCauses = newFailureCauses(causes, known);
  const fsDeps = deps.fs ?? (typeof deps.writeFile === 'function' && typeof deps.mkdir === 'function' && typeof deps.stat === 'function' ? deps : fs);
  const { written } = await materialize(root, newCauses, fsDeps);
  await record(root, newCauses);
  return { newCauses, written };
}
