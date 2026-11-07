// SPDX-License-Identifier: Apache-2.0
// One clean semver per batched release for swarm update and install checks (R-016 / T-0066).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPackageVersion } from './release-train-bump.mjs';
import { packageJsonVersionFromText, readReleaseTrainStoreFromProject } from './release-train-merge.mjs';
import {
  compareReleaseSemver,
  deriveSwarmUpdateAvailability,
  isReleaseSemver,
  normalizeReleaseSemver,
  validateReleaseVersionReport,
} from './release-train-types.mjs';

const execFileAsync = promisify(execFile);

/**
 * @param {import('./release-train-types.mjs').ReleaseSemver} version
 * @returns {string}
 */
export function releaseTagName(version) {
  if (!isReleaseSemver(version)) {
    throw Object.assign(new Error('release-tag: version must be a release semver'), { code: 'release-train-invalid' });
  }
  return `v${version.trim()}`;
}

/**
 * @param {unknown} stdout
 * @returns {string[]}
 */
export function parseLsRemoteReleaseTags(stdout) {
  const tags = [];
  for (const match of String(stdout ?? '').matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)/g)) {
    tags.push(match[1]);
  }
  return tags;
}

/**
 * @param {readonly string[]} tags
 * @returns {import('./release-train-types.mjs').ReleaseSemver | null}
 */
export function highestTaggedReleaseSemver(tags) {
  let best = null;
  for (const tag of tags) {
    const version = normalizeReleaseSemver(tag);
    if (!version) continue;
    if (!best || compareReleaseSemver(version, best) > 0) best = version;
  }
  return best;
}

/**
 * @param {{
 *   current?: unknown,
 *   latestTagged?: unknown,
 *   originMainVersion?: unknown,
 * }} input
 * @returns {import('./release-train-types.mjs').SwarmUpdateAvailability}
 */
export function swarmUpdateAvailabilityForInstall(input) {
  return deriveSwarmUpdateAvailability(input);
}

/**
 * @param {import('./release-train-types.mjs').ReleaseBumpRecord} bump
 * @param {import('./release-train-types.mjs').SwarmUpdateAvailability} availability
 * @returns {import('./release-train-types.mjs').ReleaseVersionReport}
 */
export function releaseVersionReportFromBump(bump, availability) {
  const version = bump.version.trim();
  const tagFromRecord = bump.tag?.name?.trim();
  const tag = tagFromRecord && normalizeReleaseSemver(tagFromRecord) === version
    ? tagFromRecord
    : (bump.tag?.status === 'published' ? releaseTagName(version) : undefined);
  return validateReleaseVersionReport({
    version,
    ...(tag ? { tag } : {}),
    availability,
  });
}

/**
 * One {@link ReleaseVersionReport} per batched release bump (runner-only merges have no semver).
 *
 * @param {import('./release-train-types.mjs').ReleaseTrainStore} store
 * @param {import('./release-train-types.mjs').SwarmUpdateAvailability} availability
 * @returns {import('./release-train-types.mjs').ReleaseVersionReport[]}
 */
export function releaseVersionReportsFromStore(store, availability) {
  return store.releases.map((bump) => releaseVersionReportFromBump(bump, availability));
}

/**
 * @param {{
 *   exec?: (
 *     command: string,
 *     args: string[],
 *     options?: { cwd?: string, encoding?: string },
 *   ) => Promise<{ stdout: string, stderr: string }>,
 *   root: string,
 * }} input
 * @returns {Promise<{
 *   current: import('./release-train-types.mjs').ReleaseSemver | null,
 *   latestTagged: import('./release-train-types.mjs').ReleaseSemver | null,
 *   originMainVersion: import('./release-train-types.mjs').ReleaseSemver | null,
 * }>}
 */
export async function readGitReleaseSignals({ exec = execFileAsync, root }) {
  const resolved = path.resolve(root);
  const current = await readPackageVersion(resolved);
  let latestTagged = null;
  let originMainVersion = null;
  try {
    const { stdout } = await exec('git', ['-C', resolved, 'ls-remote', '--tags', '--refs', 'origin', 'v*'], {
      encoding: 'utf8',
    });
    latestTagged = highestTaggedReleaseSemver(parseLsRemoteReleaseTags(stdout));
  } catch (error) {
    if (typeof error?.code !== 'number') {
      console.error('[tools/release-train-update.mjs] git ls-remote:', error?.message ?? error);
    }
  }
  try {
    const { stdout } = await exec('git', ['-C', resolved, 'show', 'origin/main:package.json'], { encoding: 'utf8' });
    originMainVersion = packageJsonVersionFromText(stdout);
  } catch (error) {
    if (typeof error?.code !== 'number') {
      console.error('[tools/release-train-update.mjs] origin/main package.json:', error?.message ?? error);
    }
  }
  return { current, latestTagged, originMainVersion };
}

/**
 * Install/update view: git tags and origin/main package version, with one semver per train release.
 *
 * @param {string} root
 * @param {{
 *   exec?: (
 *     command: string,
 *     args: string[],
 *     options?: { cwd?: string, encoding?: string },
 *   ) => Promise<{ stdout: string, stderr: string }>,
 * }} [options]
 */
export async function readSwarmUpdateReleaseContext(root, options = {}) {
  const signals = await readGitReleaseSignals({ exec: options.exec, root });
  const availability = swarmUpdateAvailabilityForInstall({
    current: signals.current,
    latestTagged: signals.latestTagged,
    originMainVersion: signals.originMainVersion,
  });
  let releases = [];
  try {
    const store = await readReleaseTrainStoreFromProject(path.resolve(root));
    releases = releaseVersionReportsFromStore(store, availability);
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
  }
  return { signals, availability, releases };
}

const USAGE = 'usage: release-train-update check [--root DIR]';

/**
 * @param {string[]} argv
 */
async function runCli(argv) {
  const args = [...argv];
  if (args[0] !== 'check') {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  args.shift();
  let root = process.cwd();
  while (args[0]?.startsWith('--')) {
    const flag = args.shift();
    if (flag === '--root') {
      const value = args.shift();
      if (!value) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 1;
        return;
      }
      root = value;
    } else {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
  }
  const context = await readSwarmUpdateReleaseContext(root);
  const line = JSON.stringify(context);
  process.stdout.write(`${line}\n`);
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli(process.argv.slice(2));
}
