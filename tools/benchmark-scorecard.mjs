// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const FILE_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9-]{1,40})\.json$/;
const METRIC_KEY = /^[a-zA-Z0-9_.-]{1,60}$/;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function skipped(file, reason) {
  return { file, reason };
}

function validDateString(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateBenchmark(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'JSON must be an object';
  if (value.version !== 1) return 'version must be 1';
  if (!validDateString(value.at)) return 'at must be an ISO time';
  if (typeof value.label !== 'string' || value.label.length === 0) return 'label must be a string';
  if (typeof value.source !== 'string' || value.source.length === 0 || value.source.length > 200) {
    return 'source must be a short string';
  }
  if (!value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics)) {
    return 'metrics must be an object';
  }

  for (const [key, metric] of Object.entries(value.metrics)) {
    if (!METRIC_KEY.test(key)) return `invalid metric key: ${key}`;
    if (!metric || typeof metric !== 'object' || Array.isArray(metric)) {
      return `metric ${key} must be an object`;
    }
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) {
      return `metric ${key} value must be a number`;
    }
    if (typeof metric.unit !== 'string' || metric.unit.length === 0) {
      return `metric ${key} unit must be a string`;
    }
    if (metric.better !== 'lower' && metric.better !== 'higher') {
      return `metric ${key} better must be lower or higher`;
    }
    if (metric.label !== undefined && typeof metric.label !== 'string') {
      return `metric ${key} label must be a string`;
    }
  }

  return null;
}

function benchmarkPath(root) {
  if (typeof root !== 'string') return null;
  return path.join(root, 'docs', 'state', 'benchmarks');
}

/**
 * Read the benchmark files for a project. Bad files are reported and never
 * make this function reject.
 */
export async function readBenchmarks(root) {
  const directory = benchmarkPath(root);
  if (!directory) return { files: [], skipped: [skipped(String(root), 'root must be a path')] };

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    return { files: [], skipped: [skipped(directory, `cannot read directory: ${error?.code || 'error'}`)] };
  }

  const regularFiles = entries.filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  const output = { files: [], skipped: [] };

  for (let index = 0; index < regularFiles.length; index += 1) {
    const entry = regularFiles[index];
    const file = entry.name;
    if (index >= MAX_FILES) {
      output.skipped.push(skipped(file, 'file limit exceeded'));
      continue;
    }

    const match = FILE_NAME.exec(file);
    if (!match) {
      output.skipped.push(skipped(file, 'file name does not match the benchmark format'));
      continue;
    }

    const fullPath = path.join(directory, file);
    let size;
    try {
      size = (await stat(fullPath)).size;
    } catch (error) {
      output.skipped.push(skipped(file, `cannot stat file: ${error?.code || 'error'}`));
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      output.skipped.push(skipped(file, 'file is larger than 256 KB'));
      continue;
    }

    let value;
    try {
      value = JSON.parse(await readFile(fullPath, 'utf8'));
    } catch (error) {
      output.skipped.push(skipped(file, error instanceof SyntaxError ? 'invalid JSON' : `cannot read file: ${error?.code || 'error'}`));
      continue;
    }

    const reason = validateBenchmark(value);
    if (reason) {
      output.skipped.push(skipped(file, reason));
      continue;
    }

    output.files.push({
      name: file,
      path: fullPath,
      version: value.version,
      at: value.at,
      label: value.label,
      source: value.source,
      metrics: value.metrics,
    });
  }

  return output;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Return an ISO week such as 2027-W01. */
export function isoWeek(date) {
  const value = asDate(date);
  if (!value) return null;

  value.setUTCHours(0, 0, 0, 0);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(value.getUTCFullYear(), 0, 1);
  const week = Math.ceil((((value.getTime() - yearStart) / 86400000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function compareFiles(a, b) {
  const at = Date.parse(a.at) - Date.parse(b.at);
  if (at !== 0) return at;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function metricEntries(input) {
  if (Array.isArray(input)) return { files: input, skipped: [] };
  if (input && typeof input === 'object') {
    return {
      files: Array.isArray(input.files) ? input.files : [],
      skipped: Array.isArray(input.skipped) ? [...input.skipped] : [],
    };
  }
  return { files: [], skipped: [] };
}

function fileData(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const value = entry.data && typeof entry.data === 'object' ? entry.data : entry;
  if (!validDateString(value.at) || !value.metrics || typeof value.metrics !== 'object') return null;
  return {
    ...value,
    name: entry.name || value.name || '',
  };
}

function weeksFor(now, count) {
  const date = asDate(now);
  if (!date || !Number.isFinite(count) || count <= 0) return [];
  const total = Math.floor(count);
  return Array.from({ length: total }, (_, index) => isoWeek(new Date(date.getTime() - (total - index - 1) * WEEK_MS)));
}

function verdictFor(baseline, latest, changePct, better) {
  if (!baseline || !latest || baseline.file === latest.file) return 'unknown';
  if ((baseline.value === 0 && latest.value === 0) || (changePct !== null && Math.abs(changePct) < 2)) return 'flat';
  if (changePct === null) return 'unknown';
  const improved = better === 'higher' ? changePct > 0 : changePct < 0;
  return improved ? 'better' : 'worse';
}

/** Build a read-only scorecard from parsed benchmark files. */
export function scorecard(input, { now = Date.now(), weeks = 12 } = {}) {
  const source = metricEntries(input);
  const files = source.files.map(fileData).filter(Boolean).sort(compareFiles);
  const weekNames = weeksFor(now, weeks);
  const allKeys = new Set();
  for (const file of files) {
    for (const key of Object.keys(file.metrics)) allKeys.add(key);
  }

  const metrics = [...allKeys].sort().map((key) => {
    const withMetric = files.filter((file) => file.metrics[key] && typeof file.metrics[key].value === 'number');
    const labelled = withMetric.filter((file) => file.label === 'baseline');
    const baselineFile = (labelled.length ? labelled : withMetric)[0] || null;
    const latestFile = withMetric[withMetric.length - 1] || null;
    const baselineMetric = baselineFile?.metrics[key];
    const latestMetric = latestFile?.metrics[key];
    const baseline = baselineFile && baselineMetric ? { value: baselineMetric.value, at: baselineFile.at } : null;
    const latest = latestFile && latestMetric ? { value: latestMetric.value, at: latestFile.at } : null;
    const change = baseline && latest ? latest.value - baseline.value : null;
    const changePct = baseline && latest && baseline.value !== 0 ? (change / Math.abs(baseline.value)) * 100 :
      (baseline && latest && baseline.value === 0 && latest.value === 0 ? 0 : null);
    const weekly = weekNames.flatMap((week) => {
      const weeklyFiles = withMetric.filter((file) => isoWeek(file.at) === week);
      const file = weeklyFiles[weeklyFiles.length - 1];
      return file ? [{ week, value: file.metrics[key].value }] : [];
    });
    const description = latestMetric || baselineMetric;

    return {
      key,
      label: description.label ?? key,
      unit: description.unit,
      better: description.better,
      baseline,
      latest,
      change,
      changePct,
      verdict: verdictFor(baseline && { ...baseline, file: baselineFile }, latest && { ...latest, file: latestFile }, changePct, description.better),
      weekly,
    };
  });

  return { metrics, weeks: weekNames, skipped: source.skipped, files: files.length };
}
