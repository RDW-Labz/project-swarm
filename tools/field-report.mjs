// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

const HASH = /^[a-f0-9]{64}$/;

/** Keys that must never appear in a field report (raw customer lesson / bundle content). */
export const CUSTOMER_CONTENT_KEYS = new Set([
  'rule',
  'what',
  'fix',
  'probe',
  'content',
  'caughtBy',
  'stage',
  'project',
]);

const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asString = value => typeof value === 'string' ? value : '';
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function generatedAt(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError('field report requires a valid now value');
  return date.toISOString();
}

function bumpCount(map, key) {
  const label = asString(key) || 'other';
  map[label] = (map[label] ?? 0) + 1;
}

export function lessonMetadataOnly(lesson) {
  const source = asObject(lesson);
  const tags = Array.isArray(source.tags)
    ? source.tags.filter(tag => typeof tag === 'string').slice(0, 10)
    : [];
  return {
    id: asString(source.id),
    area: asString(source.area) || 'other',
    status: asString(source.status) || 'other',
    version: typeof source.version === 'string' ? source.version : null,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : null,
    ruleLength: finiteNumber(source.ruleLength) ?? 0,
    tags,
  };
}

export function runMetadataOnly(run) {
  const source = asObject(run);
  return {
    lane: asString(source.lane) || 'other',
    jobs: finiteNumber(source.jobs),
    pass: finiteNumber(source.pass),
    fail: finiteNumber(source.fail),
    medianMinutes: finiteNumber(source.medianMinutes),
  };
}

export function bundleMetadataOnly(bundle, { source } = {}) {
  const raw = asObject(bundle);
  const exportedAt = asString(raw.exportedAt || raw.generatedAt);
  const lessons = Array.isArray(raw.lessons) ? raw.lessons.map(lessonMetadataOnly) : [];
  const runs = Array.isArray(raw.runs) ? raw.runs.map(runMetadataOnly) : [];
  return {
    source: asString(source) || 'unknown',
    projectId: asString(raw.projectId),
    exportedAt,
    scannedClean: raw.scannedClean === true,
    scanMarkedAt: typeof raw.scanMarkedAt === 'string' ? raw.scanMarkedAt : null,
    lessonCount: lessons.length,
    runCount: runs.length,
    lessons,
    runs,
  };
}

function assertBundleReadable(metadata) {
  if (!HASH.test(metadata.projectId)) return false;
  if (!Number.isFinite(Date.parse(metadata.exportedAt))) return false;
  return true;
}

async function readBundleFiles(root, source, relativeDir) {
  const dir = path.resolve(root, relativeDir);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'));
    } catch {
      continue;
    }
    const metadata = bundleMetadataOnly(parsed, { source });
    if (source === 'inbox' && metadata.scannedClean !== true) continue;
    if (!assertBundleReadable(metadata)) continue;
    records.push(metadata);
  }
  return records;
}

export async function collectFieldBundleMetadata(root) {
  const inbox = await readBundleFiles(root, 'inbox', path.join('.swarm', 'field', 'inbox'));
  const exports = await readBundleFiles(root, 'exports', path.join('.swarm', 'field', 'exports'));
  return [...inbox, ...exports];
}

export function aggregateFieldReport(records, { now } = {}) {
  const bundles = Array.isArray(records) ? records : [];
  const sources = { inbox: 0, exports: 0 };
  const lessonsByArea = {};
  const lessonsByStatus = {};
  const runsByLane = {};
  const projects = {};
  let lessonTotal = 0;
  let runTotal = 0;
  let jobCount = 0;
  let passCount = 0;
  let failCount = 0;
  const exportedAt = [];

  for (const bundle of bundles) {
    const meta = bundleMetadataOnly(bundle, { source: bundle.source });
    if (!assertBundleReadable(meta)) continue;
    if (meta.source === 'inbox') sources.inbox++;
    else if (meta.source === 'exports') sources.exports++;
    exportedAt.push(meta.exportedAt);
    const project = projects[meta.projectId] ?? {
      bundles: 0,
      lessonCount: 0,
      runCount: 0,
      earliestExportedAt: meta.exportedAt,
      latestExportedAt: meta.exportedAt,
    };
    project.bundles++;
    project.lessonCount += meta.lessonCount;
    project.runCount += meta.runCount;
    if (meta.exportedAt < project.earliestExportedAt) project.earliestExportedAt = meta.exportedAt;
    if (meta.exportedAt > project.latestExportedAt) project.latestExportedAt = meta.exportedAt;
    projects[meta.projectId] = project;

    for (const lesson of meta.lessons) {
      lessonTotal++;
      bumpCount(lessonsByArea, lesson.area);
      bumpCount(lessonsByStatus, lesson.status);
    }
    for (const run of meta.runs) {
      runTotal++;
      bumpCount(runsByLane, run.lane);
      if (run.jobs !== null) jobCount += run.jobs;
      if (run.pass !== null) passCount += run.pass;
      if (run.fail !== null) failCount += run.fail;
    }
  }

  exportedAt.sort();
  return {
    generatedAt: generatedAt(now),
    bundleCount: bundles.length,
    sources,
    timestamps: {
      earliestExportedAt: exportedAt[0] ?? null,
      latestExportedAt: exportedAt.length ? exportedAt[exportedAt.length - 1] : null,
    },
    projects,
    lessons: {
      total: lessonTotal,
      byArea: lessonsByArea,
      byStatus: lessonsByStatus,
    },
    runs: {
      total: runTotal,
      byLane: runsByLane,
      jobCount,
      passCount,
      failCount,
    },
  };
}

export async function buildFieldReport(root, { now } = {}) {
  const records = await collectFieldBundleMetadata(root);
  return aggregateFieldReport(records, { now });
}

export async function writeFieldReport(root, report, { dir } = {}) {
  const output = asObject(report);
  if (!Number.isFinite(Date.parse(asString(output.generatedAt)))) {
    throw new TypeError('field report requires generatedAt');
  }
  const folder = path.resolve(root, dir ?? path.join('.swarm', 'field', 'reports'));
  const stamp = new Date(output.generatedAt).toISOString().slice(0, 10);
  const file = path.join(folder, `${stamp}-aggregate.json`);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(output)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

export function assertReportHasNoCustomerContent(report) {
  const walk = value => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (CUSTOMER_CONTENT_KEYS.has(key)) {
        const error = new Error(`field-report-unsafe: ${key}`);
        error.code = 'field-report-unsafe';
        error.key = key;
        throw error;
      }
      walk(child);
    }
  };
  walk(report);
}

/** Entry point for `swarm field report` (wired from tools/swarm.mjs in a later ticket). */
export async function runFieldReport(root, { now, write = true } = {}) {
  const report = await buildFieldReport(root, { now });
  assertReportHasNoCustomerContent(report);
  if (write) await writeFieldReport(root, report);
  return report;
}
