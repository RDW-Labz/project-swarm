// SPDX-License-Identifier: Apache-2.0
import { assertScratchOutsideRepo, scratchRootDir } from './claude-shell.mjs';
import { compareSemver, parseSemver } from './swarm/core-2.mjs';
import { highestSemver } from './swarm/core-11.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const FOLDER_VERSION = /^(\d+\.\d+\.\d+)-/;

export function runnerRootFromImportMeta(importMetaUrl) {
  return path.dirname(path.dirname(fileURLToPath(importMetaUrl)));
}

export function installRootFromRunnerRoot(runnerRoot) {
  return path.basename(path.dirname(runnerRoot)) === 'versions'
    ? path.dirname(path.dirname(runnerRoot))
    : runnerRoot;
}

export function versionFromVersionFolderName(folderName) {
  const match = FOLDER_VERSION.exec(String(folderName));
  return match ? match[1] : null;
}

async function writeRunnerPackageJson(runnerRoot, version) {
  const pkgPath = path.join(runnerRoot, 'package.json');
  await fs.writeFile(pkgPath, `${JSON.stringify({ name: 'project-swarm', version }, null, 2)}\n`);
}

/** Repair package.json in a versions/X.Y.Z-hash dir when missing or symlinked to the install base. */
export async function repairRunnerPackageJson(runnerRoot) {
  runnerRoot = await fs.realpath(runnerRoot);
  if (path.basename(path.dirname(runnerRoot)) !== 'versions') return { repaired: false };
  const folderVersion = versionFromVersionFolderName(path.basename(runnerRoot));
  if (!folderVersion) return { repaired: false };
  const pkgPath = path.join(runnerRoot, 'package.json');
  let stat;
  try {
    stat = await fs.lstat(pkgPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await writeRunnerPackageJson(runnerRoot, folderVersion);
      return { repaired: true };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    await fs.unlink(pkgPath);
    await writeRunnerPackageJson(runnerRoot, folderVersion);
    return { repaired: true };
  }
  if (stat.isFile()) return { repaired: false };
  return { repaired: false };
}

export async function migrateVersionPackageJson(installRoot) {
  installRoot = await fs.realpath(installRoot);
  const versionsDir = path.join(installRoot, 'versions');
  let entries;
  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const repaired = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runnerRoot = path.join(versionsDir, entry.name);
    const result = await repairRunnerPackageJson(runnerRoot);
    if (result.repaired) repaired.push(runnerRoot);
  }
  return repaired;
}

async function readVersionFromRunnerRoot(runnerRoot) {
  const folderVersion = versionFromVersionFolderName(path.basename(runnerRoot));
  const pkgPath = path.join(runnerRoot, 'package.json');
  let fromFile = null;
  try {
    const stat = await fs.lstat(pkgPath);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      fromFile = JSON.parse(await fs.readFile(pkgPath, 'utf8')).version;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const version = fromFile ?? folderVersion;
  if (!version) throw new Error(`could not determine runner version under ${runnerRoot}`);
  if (folderVersion && fromFile && fromFile !== folderVersion) {
    throw new Error(`runner package.json version ${fromFile} does not match folder ${folderVersion}`);
  }
  return version;
}

/** Version of the swarm runner executing this module (from import.meta.url of tools/swarm.mjs). */
export async function runnerVersion(importMetaUrl) {
  const runnerRoot = await fs.realpath(runnerRootFromImportMeta(importMetaUrl));
  await repairRunnerPackageJson(runnerRoot);
  return readVersionFromRunnerRoot(runnerRoot);
}

export async function runnerVersionAtRoot(runnerRoot) {
  runnerRoot = await fs.realpath(runnerRoot);
  await repairRunnerPackageJson(runnerRoot);
  return readVersionFromRunnerRoot(runnerRoot);
}

export async function swarmVersion(installOrRunnerRoot, { check = false, importMetaUrl } = {}) {
  let installRoot;
  let version;
  if (importMetaUrl) {
    const runnerRoot = await fs.realpath(runnerRootFromImportMeta(importMetaUrl));
    await repairRunnerPackageJson(runnerRoot);
    version = await readVersionFromRunnerRoot(runnerRoot);
    installRoot = await fs.realpath(installRootFromRunnerRoot(runnerRoot));
  } else {
    installRoot = await fs.realpath(installOrRunnerRoot);
    version = await readVersionFromRunnerRoot(installRoot);
  }
  let tag = null;
  try {
    tag = (await execFileAsync('git', ['-C', installRoot, 'describe', '--tags', '--exact-match'], { encoding: 'utf8' })).stdout.trim() || null;
  } catch { tag = null; }
  const result = { version, installRoot, tag };
  if (check) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', installRoot, 'ls-remote', '--tags', '--refs', 'origin', 'v*'], { encoding: 'utf8' });
      const tags = [...stdout.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)/g)].map(m => m[1]);
      const latest = highestSemver(tags);
      result.latest = latest ? latest.replace(/^v/, '') : null;
      result.updateAvailable = latest ? compareSemver(parseSemver(latest), parseSemver(version)) > 0 : false;
    } catch (error) {
      result.latest = null;
      result.checkError = String(error.message ?? error).split('\n')[0].slice(0, 200);
    }
    const root2 = scratchRootDir({ env: process.env });
    try {
      await assertScratchOutsideRepo(root2, file => fs.access(file));
      result.scratchOutsideRepo = true;
    } catch {
      result.scratchOutsideRepo = false;
      result.scratchRoot = root2;
    }
  }
  return result;
}
