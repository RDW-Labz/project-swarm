// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectId } from './projects.mjs';

const execFileAsync = promisify(execFile);

async function installHelpers() {
  const { patchPointer, snapshotVersion, versionDirFor } = await import('./install.mjs');
  return { patchPointer, snapshotVersion, versionDirFor };
}
const SEMVER = /^\d+\.\d+\.\d+$/;

export function isPinned(pointer) {
  if (!pointer || typeof pointer !== 'object') return false;
  if (typeof pointer.pinnedVersion === 'string' && pointer.pinnedVersion.length > 0) return true;
  return pointer.pinned === true;
}

export function pinOf(pointer) {
  if (!pointer || typeof pointer !== 'object') return null;
  if (typeof pointer.pinnedVersion === 'string' && SEMVER.test(pointer.pinnedVersion)) return pointer.pinnedVersion;
  if (isPinned(pointer) && typeof pointer.version === 'string' && SEMVER.test(pointer.version)) return pointer.version;
  return null;
}

export function overviewPinnedVersion(pointer) {
  return isPinned(pointer) ? pinOf(pointer) : null;
}

async function readRegistry(source) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(source, '.swarm-projects.json'), 'utf8'));
    return Array.isArray(value) ? value.filter(entry => typeof entry === 'string' && path.isAbsolute(entry)) : [];
  } catch { return []; }
}

export async function readPins(source) {
  const projects = await readRegistry(source);
  const pins = [];
  const unreadable = [];
  for (const projectDir of projects) {
    let project;
    try { project = await fs.realpath(projectDir); } catch { unreadable.push({ project: projectDir, error: 'project path missing' }); continue; }
    try {
      const { readRunnerPointer } = await import('./runner-pointer.mjs');
      const pointer = await readRunnerPointer(project);
      if (!isPinned(pointer)) continue;
      const at = pinOf(pointer);
      if (!at) { unreadable.push({ project, error: 'pinned but no valid version' }); continue; }
      pins.push({ project, pinnedAt: at, pointer });
    } catch (error) {
      unreadable.push({ project, error: error.code === 'ENOENT' ? 'no pointer file' : 'pointer unreadable' });
    }
  }
  return { pins, unreadable };
}

export async function pinnedVersions(source) {
  const map = new Map();
  const { pins } = await readPins(source);
  for (const { project, pinnedAt } of pins) {
    const list = map.get(pinnedAt) ?? [];
    list.push(project);
    map.set(pinnedAt, list);
  }
  return map;
}

export async function resolveRegisteredProject(installRoot, token, { listProjectsImpl } = {}) {
  if (!token || typeof token !== 'string') throw Error('project name or path required');
  const needle = token.trim();
  if (['--help', '-h', 'help'].includes(needle)) throw Error('Usage: swarm pin PROJECT VERSION | swarm unpin PROJECT');
  const registry = await readRegistry(installRoot);
  const entries = [];
  for (const dir of registry) {
    let real;
    try { real = await fs.realpath(dir); } catch { continue; }
    entries.push({ root: real, name: path.basename(real), id: projectId(real) });
  }
  if (listProjectsImpl) {
    for (const p of await listProjectsImpl()) {
      if (!entries.some(e => e.root === p.root)) entries.push({ root: p.root, name: p.name ?? path.basename(p.root), id: p.id });
    }
  }
  let resolved = null;
  if (path.isAbsolute(needle)) {
    const real = await fs.realpath(needle).catch(() => null);
    if (real) resolved = entries.find(e => e.root === real);
  }
  if (!resolved) resolved = entries.find(e => e.id === needle || e.name === needle);
  if (!resolved) {
    const matches = entries.filter(e => e.root.endsWith(path.sep + needle) || e.root === needle);
    if (matches.length === 1) resolved = matches[0];
  }
  if (!resolved) throw Error(`unknown registered project: ${needle}`);
  return resolved;
}

export function validatePinVersion(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) throw Error(`pin version must be x.y.z, got ${JSON.stringify(version)}`);
  return version;
}

async function gitAvailable(installRoot) {
  try {
    await execFileAsync('git', ['-C', installRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
    return true;
  } catch { return false; }
}

export async function ensureVersionInstalled(installRoot, version, { execFile = execFileAsync } = {}) {
  const { versionDirFor, snapshotVersion } = await installHelpers();
  const existing = await versionDirFor(installRoot, version);
  if (existing) return { installed: false, versionDir: existing };
  if (!await gitAvailable(installRoot)) throw Error('git is not available; cannot install a pinned release from a tag');
  const tag = `v${version}`;
  try { await execFile('git', ['-C', installRoot, 'rev-parse', '--verify', `${tag}^{commit}`], { encoding: 'utf8' }); }
  catch { throw Error(`release tag ${tag} does not exist in the install repository`); }
  const tmp = path.join(installRoot, 'versions', `.tag-extract-${process.pid}-${Date.now()}`);
  await fs.mkdir(tmp, { recursive: true });
  const tarPath = path.join(tmp, 'archive.tar');
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  try {
    await execFile('git', ['-C', installRoot, 'archive', '--format=tar', `--output=${tarPath}`, tag], { env: gitEnv });
    await execFile('tar', ['-xf', tarPath, '-C', tmp]);
    const versionDir = await snapshotVersion(tmp, version, { versionsParent: installRoot });
    return { installed: true, versionDir };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function pinProject(installRoot, projectRoot, version, options) {
  validatePinVersion(version);
  const install = await ensureVersionInstalled(installRoot, version, options);
  const { patchPointer } = await installHelpers();
  const written = await patchPointer(projectRoot, { pinned: true, pinnedVersion: version });
  return { project: projectRoot, version, ...install, ...written };
}

export async function unpinProject(projectRoot) {
  const file = path.join(projectRoot, '.project-swarm.json');
  let before, existing;
  try { before = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') throw Error('no .project-swarm.json in this project'); throw error; }
  try { existing = JSON.parse(before); } catch { throw Error('.project-swarm.json is not valid JSON'); }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw Error('.project-swarm.json is not a JSON object');
  if (!isPinned(existing)) return { project: projectRoot, changed: false };
  const { pinned, pinnedVersion, ...rest } = existing;
  const backup = `${file}.bak-${Date.now()}-${nodeCrypto.randomBytes(3).toString('hex')}`;
  await fs.writeFile(backup, before, { flag: 'wx', mode: 0o600 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(rest, null, 2)}\n`);
  await fs.rename(temp, file);
  return { project: projectRoot, changed: true, backup, was: { pinned, pinnedVersion } };
}

export async function listPinReport(installRoot) {
  const { pins, unreadable } = await readPins(installRoot);
  const { versionDirFor } = await installHelpers();
  const { runnerVersionAtRoot } = await import('./runner-version.mjs');
  const mapped = [];
  for (const p of pins) {
    let runnerVersion = null;
    try {
      const versionDir = await versionDirFor(installRoot, p.pinnedAt);
      if (versionDir) runnerVersion = await runnerVersionAtRoot(versionDir);
    } catch { /* listing still shows the pointer version */ }
    mapped.push({
      project: p.project,
      name: path.basename(p.project),
      pinnedAt: p.pinnedAt,
      runnerVersion: runnerVersion ?? p.pinnedAt,
    });
  }
  return { pins: mapped, unreadable };
}
