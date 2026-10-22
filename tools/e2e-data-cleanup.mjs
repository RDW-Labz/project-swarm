// SPDX-License-Identifier: Apache-2.0
import os from 'node:os';
import path from 'node:path';

const TRACK_KINDS = new Set(['tmpdir', 'file', 'db']);

function resolveRoot(root) {
  if (typeof root !== 'string' || !root) throw new Error('e2e-cleanup: root must be a non-empty string');
  return path.resolve(root);
}

function resolveRunId(runId) {
  if (typeof runId !== 'string' || !runId || runId.includes(path.sep) || runId.includes('\0')) {
    throw new Error('e2e-cleanup: runId must be a non-empty path segment');
  }
  return runId;
}

export function pathAllowed(target, root, tmpdir) {
  const resolved = path.resolve(String(target));
  const rootBase = path.resolve(root);
  const tmpBase = path.resolve(tmpdir);
  if (resolved === rootBase || resolved.startsWith(`${rootBase}${path.sep}`)) return true;
  if (resolved === tmpBase || resolved.startsWith(`${tmpBase}${path.sep}`)) return true;
  return false;
}

export function createE2eDataTracker({ root, runId, tmpdir = os.tmpdir() }) {
  const projectRoot = resolveRoot(root);
  const id = resolveRunId(runId);
  const tempRoot = path.resolve(tmpdir);
  const e2eDir = path.join(projectRoot, '.swarm', 'e2e', id);
  const entries = [];

  const track = (kind, value) => {
    if (!TRACK_KINDS.has(kind)) throw new Error(`e2e-cleanup: unknown track kind ${kind}`);
    if (kind === 'db') {
      if (typeof value !== 'string' || !value) throw new Error('e2e-cleanup: db name must be a non-empty string');
      if (!entries.some((e) => e.kind === kind && e.value === value)) entries.push({ kind, value });
      return;
    }
    if (typeof value !== 'string' || !value) throw new Error(`e2e-cleanup: ${kind} path must be a non-empty string`);
    const resolved = path.resolve(value);
    if (!entries.some((e) => e.kind === kind && e.value === resolved)) entries.push({ kind, value: resolved });
  };

  const e2ePath = (...parts) => path.join(e2eDir, ...parts);

  return {
    root: projectRoot,
    runId: id,
    tmpdir: tempRoot,
    e2eDir,
    e2ePath,
    track,
    entries: () => entries.map((e) => ({ ...e })),
  };
}

export async function cleanupE2eData(tracker, { rm, dropDb, tmpdir = tracker?.tmpdir ?? os.tmpdir() } = {}) {
  if (!tracker || typeof tracker.entries !== 'function') throw new Error('e2e-cleanup: tracker is required');
  if (typeof rm !== 'function') throw new Error('e2e-cleanup: rm is required');
  if (typeof dropDb !== 'function') throw new Error('e2e-cleanup: dropDb is required');

  const root = tracker.root;
  const tempRoot = path.resolve(tmpdir);
  const removed = [];
  const refused = [];
  const errors = [];

  for (const entry of tracker.entries()) {
    const { kind, value } = entry;
    if (kind === 'db') {
      try {
        await dropDb(value);
        removed.push({ kind, value });
      } catch (error) {
        errors.push({ kind, value, error: String(error?.message ?? error) });
      }
      continue;
    }
    if (!pathAllowed(value, root, tempRoot)) {
      refused.push({ kind, value });
      continue;
    }
    try {
      await rm(value, { recursive: true, force: true });
      removed.push({ kind, value });
    } catch (error) {
      errors.push({ kind, value, error: String(error?.message ?? error) });
    }
  }

  return { removed, refused, errors };
}

export async function withE2eCleanup(fn, opts) {
  if (typeof fn !== 'function') throw new Error('e2e-cleanup: fn must be a function');
  const { root, runId, rm, dropDb, tmpdir } = opts ?? {};
  const tracker = createE2eDataTracker({ root, runId, tmpdir });
  try {
    return await fn(tracker);
  } finally {
    await cleanupE2eData(tracker, { rm, dropDb, tmpdir: tracker.tmpdir });
  }
}
