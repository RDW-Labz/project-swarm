// SPDX-License-Identifier: Apache-2.0
// Batch one scheduled or on-demand release version bump for accumulated runner merges (R-016 / T-0065).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_BUMP_TRIGGERS,
  buildReleaseBumpFromPending,
  emptyReleaseTrainStore,
  formatReleaseTrainStore,
  isReleaseSemver,
  parseReleaseTrainStore,
  recordReleaseBump,
  releaseTrainStorePath,
  validateReleaseTrainStore,
} from './release-train-types.mjs';

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Same prefix rule as `tools/ship.mjs` `releaseTitleVersion` (plain semver segment only). */
const RELEASE_TITLE_VERSION_RE = /^(?:Release\s+)?(\d+\.\d+\.\d+)\b/;

const CHANGELOG_TOP_HEADING_RE = /^##\s+(.+)$/m;

/**
 * @param {string} label
 * @param {string} message
 * @param {string} [code]
 */
function bumpError(label, message, code = 'release-bump-invalid') {
  throw Object.assign(new Error(`${label}: ${message}`), { code });
}

/**
 * @param {unknown} title
 * @returns {string | null}
 */
export function releaseTitleVersion(title) {
  return RELEASE_TITLE_VERSION_RE.exec(String(title ?? '').trim())?.[1] ?? null;
}

/**
 * @param {string} [root]
 * @returns {Promise<string | null>}
 */
export async function readPackageVersion(root = OWN_ROOT) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const version = pkg?.version;
    return typeof version === 'string' && isReleaseSemver(version) ? version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} [root]
 * @returns {Promise<string | null>}
 */
export async function readChangelogTopHeading(root = OWN_ROOT) {
  try {
    const text = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
    return CHANGELOG_TOP_HEADING_RE.exec(text)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @returns {Promise<import('./release-train-types.mjs').ReleaseTrainStore>}
 */
export async function readReleaseTrainStore(root = OWN_ROOT) {
  const storePath = releaseTrainStorePath(root);
  try {
    return parseReleaseTrainStore(await fs.readFile(storePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      const lastReleasedVersion = await readPackageVersion(root);
      if (!lastReleasedVersion) {
        bumpError('release-train-store', 'package.json version is required to initialize the release train');
      }
      return emptyReleaseTrainStore(lastReleasedVersion);
    }
    throw error;
  }
}

/**
 * @param {string} root
 * @param {import('./release-train-types.mjs').ReleaseTrainStore} store
 */
export async function writeReleaseTrainStore(root, store) {
  const validated = validateReleaseTrainStore(store);
  const storePath = releaseTrainStorePath(root);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  const body = formatReleaseTrainStore(validated);
  try {
    await fs.writeFile(tmp, body, { flag: 'wx', mode: 0o644 });
    await fs.rename(tmp, storePath);
  } catch (error) {
    await fs.unlink(tmp).catch((unlinkError) => {
      if (unlinkError?.code === 'ENOENT') return;
      console.error('[tools/release-train-bump.mjs] unlink tmp after failed write:', unlinkError?.message ?? unlinkError);
    });
    throw error;
  }
}

/**
 * @param {{
 *   packageVersion?: unknown,
 *   releaseTitle?: unknown,
 *   changelogHeading?: unknown,
 * }} fields
 * @returns {{
 *   packageVersion: string | null,
 *   titleVersion: string | null,
 *   changelogHeading: string | null,
 * }}
 */
export function releaseBumpCoherenceFields(fields) {
  const packageVersion = isReleaseSemver(fields.packageVersion) ? fields.packageVersion.trim() : null;
  const changelogHeading = typeof fields.changelogHeading === 'string' ? fields.changelogHeading.trim() : null;
  const fromTitle = fields.releaseTitle !== undefined ? releaseTitleVersion(fields.releaseTitle) : null;
  const titleVersion = fromTitle
    ?? (typeof fields.releaseTitle === 'string' && isReleaseSemver(fields.releaseTitle) ? fields.releaseTitle.trim() : null);
  return { packageVersion, titleVersion, changelogHeading };
}

/**
 * One release bump batches pending runner merges (scheduled or on-demand) and advances the train.
 *
 * @param {import('./release-train-types.mjs').ReleaseTrainStore} store
 * @param {{
 *   trigger: unknown,
 *   sha: unknown,
 *   mergedAt: unknown,
 *   version?: unknown,
 *   runnerMergeShas?: unknown,
 *   releaseTitle?: unknown,
 *   tag?: unknown,
 * }} fields
 * @param {{
 *   packageVersion?: unknown,
 *   changelogHeading?: unknown,
 * }} [workspace]
 * @returns {import('./release-train-types.mjs').ReleaseTrainStore}
 */
export function batchReleaseBump(store, fields, workspace = {}) {
  const label = 'release-bump';
  if (!RELEASE_BUMP_TRIGGERS.includes(fields.trigger)) {
    bumpError(label, `trigger must be one of ${RELEASE_BUMP_TRIGGERS.join(', ')}`);
  }
  const packageVersion = isReleaseSemver(workspace.packageVersion)
    ? workspace.packageVersion.trim()
    : (isReleaseSemver(fields.version) ? fields.version.trim() : null);
  if (!packageVersion) {
    bumpError(label, 'package.json must name a release semver for a batched bump');
  }
  if (fields.version !== undefined && isReleaseSemver(fields.version) && fields.version.trim() !== packageVersion) {
    bumpError(label, 'version must match package.json for a batched bump', 'release-version-mismatch');
  }
  const version = packageVersion;
  const pendingDefault = !Array.isArray(fields.runnerMergeShas);
  if (pendingDefault && store.pendingRunnerMerges.length === 0) {
    bumpError(label, 'no pending runner merges to batch');
  }
  const bump = buildReleaseBumpFromPending(store, {
    version,
    trigger: fields.trigger,
    sha: fields.sha,
    mergedAt: fields.mergedAt,
    ...(fields.runnerMergeShas !== undefined ? { runnerMergeShas: fields.runnerMergeShas } : {}),
    ...(fields.releaseTitle !== undefined ? { releaseTitle: fields.releaseTitle } : {}),
    ...(fields.tag !== undefined ? { tag: fields.tag } : {}),
  });
  const coherence = releaseBumpCoherenceFields({
    packageVersion,
    releaseTitle: fields.releaseTitle,
    changelogHeading: workspace.changelogHeading,
  });
  if (fields.releaseTitle !== undefined && !coherence.titleVersion) {
    bumpError(label, 'releaseTitle must name a release semver', 'release-version-mismatch');
  }
  const titleVersion = coherence.titleVersion ?? version;
  return recordReleaseBump(store, bump, {
    packageVersion: coherence.packageVersion ?? version,
    titleVersion,
    changelogHeading: coherence.changelogHeading ?? undefined,
  });
}

/**
 * Read the train store and workspace release files, batch pending runner merges, and persist.
 *
 * @param {string} root
 * @param {{
 *   trigger: unknown,
 *   sha: unknown,
 *   mergedAt: unknown,
 *   version?: unknown,
 *   runnerMergeShas?: unknown,
 *   releaseTitle?: unknown,
 *   tag?: unknown,
 * }} fields
 */
export async function applyBatchReleaseBump(root, fields) {
  const store = await readReleaseTrainStore(root);
  const packageVersion = await readPackageVersion(root);
  const changelogHeading = await readChangelogTopHeading(root);
  const next = batchReleaseBump(store, fields, { packageVersion, changelogHeading });
  await writeReleaseTrainStore(root, next);
  return next;
}
