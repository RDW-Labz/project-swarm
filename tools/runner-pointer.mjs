// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const RUNNER_POINTER_LOCAL = '.swarm/runner-pointer.json';
export const TRACKED_POINTER = '.project-swarm.json';
export const RELEASE_POINTER_KEYS = Object.freeze(['version', 'install']);

function isProtectedBranch(branch) {
  return branch === 'main' || branch === 'master' || branch === 'HEAD';
}

async function gitPorcelain(root, relPath) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain', '--', relPath], { encoding: 'utf8' });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function currentBranch(root) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    try {
      const { stdout } = await execFileAsync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' });
      return stdout.trim();
    } catch {
      return '';
    }
  }
}

async function readJsonFile(file, { label = file } = {}) {
  const text = await fs.readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON; fix or remove it by hand`);
  }
}

function releaseSlice(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const key of RELEASE_POINTER_KEYS) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

function stripReleaseFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const next = { ...obj };
  for (const key of RELEASE_POINTER_KEYS) delete next[key];
  return next;
}

async function writeAtomicJson(file, value, { mode = 0o644 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${nodeCrypto.randomBytes(3).toString('hex')}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fs.rename(temp, file);
  return file;
}

/** Merged view: machine-local release fields win; tracked file is the fallback for unmigrated projects. */
export async function readRunnerPointer(root, { allowMissing = false } = {}) {
  const trackedPath = path.join(root, TRACKED_POINTER);
  const localPath = path.join(root, RUNNER_POINTER_LOCAL);
  let tracked = null;
  try {
    tracked = await readJsonFile(trackedPath, { label: TRACKED_POINTER });
    if (!tracked || typeof tracked !== 'object' || Array.isArray(tracked)) tracked = null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let local = null;
  try {
    local = await readJsonFile(localPath, { label: RUNNER_POINTER_LOCAL });
    if (!local || typeof local !== 'object' || Array.isArray(local)) {
      throw new Error(`${RUNNER_POINTER_LOCAL} is not a JSON object; fix it by hand`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') local = null;
    else throw error;
  }
  if (!tracked && !local) {
    if (allowMissing) return {};
    const missing = new Error(`no ${TRACKED_POINTER} in ${root}`);
    missing.code = 'ENOENT';
    throw missing;
  }
  const merged = { ...(tracked ?? {}) };
  if (local) Object.assign(merged, releaseSlice(local));
  return merged;
}

export async function writeReleasePointer(root, patch) {
  const localPath = path.join(root, RUNNER_POINTER_LOCAL);
  let before = null;
  let existing = {};
  try {
    before = await fs.readFile(localPath, 'utf8');
    existing = JSON.parse(before);
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new Error(`${RUNNER_POINTER_LOCAL} is not a JSON object; fix it by hand`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = { ...existing };
  for (const key of RELEASE_POINTER_KEYS) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (JSON.stringify(existing) === JSON.stringify(next)) return { changed: false, backup: null };
  let backup = null;
  if (before !== null) {
    backup = `${localPath}.bak-${Date.now()}-${nodeCrypto.randomBytes(3).toString('hex')}`;
    await fs.writeFile(backup, before, { flag: 'wx', mode: 0o600 });
  }
  await writeAtomicJson(localPath, next, { mode: 0o644 });
  return { changed: true, backup };
}

async function writeTrackedProfile(root, value) {
  const trackedPath = path.join(root, TRACKED_POINTER);
  let before = null;
  try { before = await fs.readFile(trackedPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (before !== null && JSON.stringify(JSON.parse(before)) === JSON.stringify(value)) return false;
  const backup = before !== null
    ? `${trackedPath}.bak-${Date.now()}-${nodeCrypto.randomBytes(3).toString('hex')}`
    : null;
  if (backup) await fs.writeFile(backup, before, { flag: 'wx', mode: 0o600 });
  await writeAtomicJson(trackedPath, value, { mode: 0o644 });
  return true;
}

/**
 * One-time migration: copy release fields into the local file; strip them from the tracked file only when it is clean and the branch is not protected.
 * Never runs git add or git commit.
 */
export async function migrateRunnerPointer(root, { exec = execFileAsync } = {}) {
  const trackedPath = path.join(root, TRACKED_POINTER);
  let before;
  try { before = await fs.readFile(trackedPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { status: 'noop' }; throw error; }
  let tracked;
  try {
    tracked = JSON.parse(before);
  } catch {
    return { status: 'noop' };
  }
  if (!tracked || typeof tracked !== 'object' || Array.isArray(tracked)) return { status: 'noop' };
  const fromTracked = releaseSlice(tracked);
  if (!Object.keys(fromTracked).length) return { status: 'noop' };

  const localPath = path.join(root, RUNNER_POINTER_LOCAL);
  let local = {};
  try {
    local = await readJsonFile(localPath);
    if (!local || typeof local !== 'object' || Array.isArray(local)) {
      return { status: 'deferred', reason: 'corrupt-local' };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') return { status: 'deferred', reason: 'corrupt-local' };
  }
  const mergedLocal = { ...local };
  for (const key of RELEASE_POINTER_KEYS) {
    if (fromTracked[key] !== undefined && mergedLocal[key] === undefined) mergedLocal[key] = fromTracked[key];
  }
  if (JSON.stringify(local) !== JSON.stringify(mergedLocal)) {
    await writeAtomicJson(localPath, mergedLocal, { mode: 0o644 });
  }

  let gitRepo = false;
  try {
    await execFileAsync('git', ['-C', root, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
    gitRepo = true;
  } catch { gitRepo = false; }
  const dirty = gitRepo ? await gitPorcelain(root, TRACKED_POINTER) : true;
  const branch = gitRepo ? await currentBranch(root) : '';
  if (!gitRepo || dirty || isProtectedBranch(branch)) {
    if (!gitRepo) return { status: 'deferred', reason: 'not-git' };
    return { status: 'deferred', reason: dirty ? 'dirty-tracked' : 'protected-branch' };
  }

  const stripped = stripReleaseFields(tracked);
  if (JSON.stringify(stripped) === JSON.stringify(tracked)) return { status: 'noop' };
  await writeTrackedProfile(root, stripped);
  return { status: 'migrated' };
}

/** Ensures a new link writes install in the tracked file and release fields only in the local file. */
export async function bootstrapProjectPointer(root, { install, version }) {
  const trackedPath = path.join(root, TRACKED_POINTER);
  let hasTracked = false;
  try { await fs.access(trackedPath); hasTracked = true; } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[tools/runner-pointer.mjs] bootstrap access tracked pointer:', trackedPath, error?.message ?? error);
  }
  if (!hasTracked) {
    // First link: tracked file names the install; release fields are also written locally (updates touch only the local file).
    await writeAtomicJson(trackedPath, { install, version }, { mode: 0o644 });
  }
  return writeReleasePointer(root, { install, version });
}
