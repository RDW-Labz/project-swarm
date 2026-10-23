// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SKIP_NAMES = new Set(['.git', 'node_modules', '.swarm']);

async function walkFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Copy the integrated working tree into snapshotDir and write a manifest.
 * snapshotDir must be outside root; its previous contents are removed first.
 */
export async function captureIntegratedSnapshot({ root, snapshotDir, integratedRunId } = {}) {
  if (!root || !snapshotDir) throw new TypeError('root and snapshotDir are required');
  const src = path.resolve(root);
  const dest = path.resolve(snapshotDir);
  if (dest === src || dest.startsWith(src + path.sep)) {
    throw new Error('snapshotDir must be outside the integrated tree');
  }
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  const manifest = [];
  for (const file of await walkFiles(src)) {
    const relPath = toPosix(path.relative(src, file));
    const target = path.join(dest, ...relPath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
    manifest.push({ path: relPath, sha256: await sha256File(target) });
  }

  const record = {
    integratedRunId: integratedRunId ?? null,
    root: src,
    snapshotDir: dest,
    files: manifest,
  };
  await writeFile(path.join(dest, '.snapshot-manifest.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/**
 * Return the first integrated run that a job depends on, or null.
 * integratedRuns is a Map of run id to { id, status }.
 */
export function integratedDependencyFor(job, integratedRuns) {
  const deps = Array.isArray(job?.dependsOn) ? job.dependsOn : [];
  for (const id of deps) {
    const run = integratedRuns?.get?.(id);
    if (run?.status === 'integrated') return run;
  }
  return null;
}

/**
 * For a job that depends on an integrated run, capture the integrated tree automatically.
 * Returns the snapshot record, or null when the job has no integrated dependency.
 */
export async function snapshotForDependentJob({ job, integratedRuns, root, snapshotRoot } = {}) {
  const run = integratedDependencyFor(job, integratedRuns);
  if (!run) return null;
  if (!snapshotRoot) throw new TypeError('snapshotRoot is required for a dependent job');
  const snapshotDir = path.join(snapshotRoot, safeName(job.id ?? 'job'));
  return captureIntegratedSnapshot({ root, snapshotDir, integratedRunId: run.id });
}
