// SPDX-License-Identifier: Apache-2.0
// Shared release-train record shapes (R-016 / T-0063). Runner-only merges accumulate without a
// package version bump; one release-bump record batches them on a schedule or on demand; swarm
// update reports one clean semver per published release and distinguishes tag-pending from up to date.

import path from 'node:path';

/** Persisted store schema version. */
export const RELEASE_TRAIN_RECORD_VERSION = 1;

/** Relative path segments for `.swarm/project/release-train.json`. */
export const RELEASE_TRAIN_STORE_SEGMENTS = Object.freeze(['.swarm', 'project', 'release-train.json']);

/** package.json / install release version (no `v` prefix). */
export const RELEASE_SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Git tag for a published release (`v` + semver). */
export const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+)$/;

const SHA_RE = /^[0-9a-f]{40}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const RUNNER_MERGE_KIND = 'runner-only';
export const RELEASE_BUMP_KIND = 'release-bump';

export const RELEASE_BUMP_TRIGGERS = Object.freeze(['scheduled', 'on-demand']);

/**
 * @typedef {string} ReleaseSemver
 * One clean semver for an install release (`1.2.3`, never `v1.2.3`).
 * @exports ReleaseSemver
 */

/**
 * @typedef {'runner-only'} RunnerMergeKind
 * @exports RunnerMergeKind
 */

/**
 * @typedef {'release-bump'} ReleaseBumpKind
 * @exports ReleaseBumpKind
 */

/**
 * @typedef {'scheduled' | 'on-demand'} ReleaseBumpTrigger
 * @exports ReleaseBumpTrigger
 */

/**
 * @typedef {(
 *   | 'up-to-date'
 *   | 'update-available'
 *   | 'tag-pending'
 *   | 'no-newer-tag'
 * )} SwarmUpdateAvailabilityStatus
 * `tag-pending` means origin/main already names a newer version than the newest `v*` tag (the tag
 * is still on its way). `no-newer-tag` means nothing newer is published yet — not the same case.
 * @exports SwarmUpdateAvailabilityStatus
 */

/**
 * @typedef {Object} RunnerMergeRecord
 * @property {RunnerMergeKind} kind
 * @property {string} sha
 * @property {string} mergedAt
 * @property {number} [pr]
 * @property {string} [title]
 * Runner merges never carry their own version bump; they wait for a batched release bump.
 * @exports RunnerMergeRecord
 */

/**
 * @typedef {Object} ReleaseTagStatus
 * @property {string} name
 * @property {'pending' | 'published'} status
 * @property {number} [waitedSeconds]
 * @exports ReleaseTagStatus
 */

/**
 * @typedef {Object} ReleaseBumpRecord
 * @property {ReleaseBumpKind} kind
 * @property {ReleaseSemver} version
 * @property {ReleaseBumpTrigger} trigger
 * @property {string} sha
 * @property {string} mergedAt
 * @property {readonly string[]} runnerMergeShas
 * @property {string} [releaseTitle]
 * @property {ReleaseTagStatus} [tag]
 * @exports ReleaseBumpRecord
 */

/**
 * @typedef {RunnerMergeRecord | ReleaseBumpRecord} ReleaseTrainMergeRecord
 * @exports ReleaseTrainMergeRecord
 */

/**
 * @typedef {Object} ReleaseTrainStore
 * @property {number} version
 * @property {ReleaseSemver} lastReleasedVersion
 * @property {RunnerMergeRecord[]} pendingRunnerMerges
 * @property {ReleaseBumpRecord[]} releases
 * @exports ReleaseTrainStore
 */

/**
 * @typedef {Object} SwarmUpdateAvailability
 * @property {ReleaseSemver | null} current
 * @property {ReleaseSemver | null} latest
 * @property {ReleaseSemver | null} [pending]
 * @property {SwarmUpdateAvailabilityStatus} status
 * @property {boolean} updateAvailable
 * @property {boolean} tagPending
 * @property {string} [message]
 * @exports SwarmUpdateAvailability
 */

/**
 * @typedef {Object} ReleaseVersionReport
 * @property {ReleaseSemver} version
 * @property {string} [tag]
 * @property {SwarmUpdateAvailability} availability
 * One clean semver per published release for `swarm update` / install checks (T-0066).
 * @exports ReleaseVersionReport
 */

/**
 * @typedef {Object} ReleaseBumpCoherence
 * @property {boolean} ok
 * @property {ReleaseSemver | null} packageVersion
 * @property {ReleaseSemver | null} titleVersion
 * @property {string | null} changelogHeading
 * @property {'release-version-mismatch'} [code]
 * @exports ReleaseBumpCoherence
 */

/**
 * @param {string} root
 * @returns {string}
 */
export function releaseTrainStorePath(root) {
  return path.join(root, ...RELEASE_TRAIN_STORE_SEGMENTS);
}

/**
 * @param {unknown} value
 * @returns {value is ReleaseSemver}
 */
export function isReleaseSemver(value) {
  return typeof value === 'string' && RELEASE_SEMVER_RE.test(value.trim());
}

/**
 * @param {unknown} tagOrVersion
 * @returns {ReleaseSemver | null}
 */
export function normalizeReleaseSemver(tagOrVersion) {
  if (typeof tagOrVersion !== 'string') return null;
  const trimmed = tagOrVersion.trim();
  if (RELEASE_SEMVER_RE.test(trimmed)) return trimmed;
  const fromTag = RELEASE_TAG_RE.exec(trimmed);
  return fromTag ? fromTag[1] : null;
}

/**
 * @param {string} label
 * @param {string} message
 * @param {string} [code]
 */
function trainError(label, message, code = 'release-train-invalid') {
  throw Object.assign(new Error(`${label}: ${message}`), { code });
}

/**
 * @param {unknown} sha
 * @param {string} label
 */
function assertSha(sha, label) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) trainError(label, 'sha must be a 40-character git commit id');
  return sha.toLowerCase();
}

/**
 * @param {unknown} mergedAt
 * @param {string} label
 */
function assertMergedAt(mergedAt, label) {
  if (typeof mergedAt !== 'string' || !ISO_RE.test(mergedAt) || Number.isNaN(Date.parse(mergedAt))) {
    trainError(label, 'mergedAt must be an ISO-8601 UTC timestamp');
  }
  return mergedAt;
}

/**
 * @param {unknown} record
 * @returns {RunnerMergeRecord}
 */
export function validateRunnerMergeRecord(record) {
  const label = 'runner-merge';
  if (!record || typeof record !== 'object' || Array.isArray(record)) trainError(label, 'record must be an object');
  if (record.kind !== RUNNER_MERGE_KIND) trainError(label, `kind must be ${RUNNER_MERGE_KIND}`);
  if ('version' in record) trainError(label, 'runner-only merges must not include a version bump');
  const sha = assertSha(record.sha, label);
  const mergedAt = assertMergedAt(record.mergedAt, label);
  if (record.pr !== undefined && (!Number.isInteger(record.pr) || record.pr <= 0)) {
    trainError(label, 'pr must be a positive integer when set');
  }
  if (record.title !== undefined && (typeof record.title !== 'string' || !record.title.trim() || record.title.length > 200)) {
    trainError(label, 'title must be 1-200 characters when set');
  }
  return {
    kind: RUNNER_MERGE_KIND,
    sha,
    mergedAt,
    ...(record.pr !== undefined ? { pr: record.pr } : {}),
    ...(record.title !== undefined ? { title: record.title.trim() } : {}),
  };
}

/**
 * @param {unknown} tag
 * @returns {ReleaseTagStatus}
 */
export function validateReleaseTagStatus(tag) {
  const label = 'release-tag';
  if (!tag || typeof tag !== 'object' || Array.isArray(tag)) trainError(label, 'tag must be an object');
  if (typeof tag.name !== 'string' || !RELEASE_TAG_RE.test(tag.name.trim())) {
    trainError(label, 'name must be a v-prefixed release tag');
  }
  if (tag.status !== 'pending' && tag.status !== 'published') {
    trainError(label, 'status must be pending or published');
  }
  if (tag.waitedSeconds !== undefined && (!Number.isFinite(tag.waitedSeconds) || tag.waitedSeconds < 0)) {
    trainError(label, 'waitedSeconds must be a non-negative number when set');
  }
  return {
    name: tag.name.trim(),
    status: tag.status,
    ...(tag.waitedSeconds !== undefined ? { waitedSeconds: tag.waitedSeconds } : {}),
  };
}

/**
 * @param {unknown} record
 * @returns {ReleaseBumpRecord}
 */
export function validateReleaseBumpRecord(record) {
  const label = 'release-bump';
  if (!record || typeof record !== 'object' || Array.isArray(record)) trainError(label, 'record must be an object');
  if (record.kind !== RELEASE_BUMP_KIND) trainError(label, `kind must be ${RELEASE_BUMP_KIND}`);
  if (!isReleaseSemver(record.version)) trainError(label, 'version must be a release semver');
  if (!RELEASE_BUMP_TRIGGERS.includes(record.trigger)) {
    trainError(label, `trigger must be one of ${RELEASE_BUMP_TRIGGERS.join(', ')}`);
  }
  const sha = assertSha(record.sha, label);
  const mergedAt = assertMergedAt(record.mergedAt, label);
  if (!Array.isArray(record.runnerMergeShas)) trainError(label, 'runnerMergeShas must be an array');
  const runnerMergeShas = record.runnerMergeShas.map((item, index) => assertSha(item, `${label}.runnerMergeShas[${index}]`));
  if (record.releaseTitle !== undefined && (typeof record.releaseTitle !== 'string' || !record.releaseTitle.trim())) {
    trainError(label, 'releaseTitle must be a non-empty string when set');
  }
  const tag = record.tag === undefined ? undefined : validateReleaseTagStatus(record.tag);
  return {
    kind: RELEASE_BUMP_KIND,
    version: record.version.trim(),
    trigger: record.trigger,
    sha,
    mergedAt,
    runnerMergeShas,
    ...(record.releaseTitle !== undefined ? { releaseTitle: record.releaseTitle.trim() } : {}),
    ...(tag ? { tag } : {}),
  };
}

/**
 * @param {ReleaseSemver} lastReleasedVersion
 * @returns {ReleaseTrainStore}
 */
export function emptyReleaseTrainStore(lastReleasedVersion) {
  if (!isReleaseSemver(lastReleasedVersion)) trainError('release-train-store', 'lastReleasedVersion must be a release semver');
  return {
    version: RELEASE_TRAIN_RECORD_VERSION,
    lastReleasedVersion: lastReleasedVersion.trim(),
    pendingRunnerMerges: [],
    releases: [],
  };
}

/**
 * @param {unknown} store
 * @returns {ReleaseTrainStore}
 */
export function validateReleaseTrainStore(store) {
  const label = 'release-train-store';
  if (!store || typeof store !== 'object' || Array.isArray(store)) trainError(label, 'store must be an object');
  if (store.version !== RELEASE_TRAIN_RECORD_VERSION) {
    trainError(label, `version must be ${RELEASE_TRAIN_RECORD_VERSION}`);
  }
  if (!isReleaseSemver(store.lastReleasedVersion)) trainError(label, 'lastReleasedVersion must be a release semver');
  if (!Array.isArray(store.pendingRunnerMerges)) trainError(label, 'pendingRunnerMerges must be an array');
  if (!Array.isArray(store.releases)) trainError(label, 'releases must be an array');
  const pendingRunnerMerges = store.pendingRunnerMerges.map(validateRunnerMergeRecord);
  const releases = store.releases.map(validateReleaseBumpRecord);
  return {
    version: RELEASE_TRAIN_RECORD_VERSION,
    lastReleasedVersion: store.lastReleasedVersion.trim(),
    pendingRunnerMerges,
    releases,
  };
}

/**
 * @param {string} text
 * @returns {ReleaseTrainStore}
 */
export function parseReleaseTrainStore(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    trainError('release-train-store', `invalid JSON: ${error.message}`);
  }
  return validateReleaseTrainStore(parsed);
}

/**
 * @param {{
 *   packageVersion?: unknown,
 *   titleVersion?: unknown,
 *   changelogHeading?: unknown,
 * }} fields
 * @returns {ReleaseBumpCoherence}
 */
export function checkReleaseBumpCoherence(fields) {
  const packageVersion = isReleaseSemver(fields.packageVersion) ? fields.packageVersion.trim() : null;
  const titleVersion = isReleaseSemver(fields.titleVersion) ? fields.titleVersion.trim() : null;
  const changelogHeading = typeof fields.changelogHeading === 'string' ? fields.changelogHeading.trim() : null;
  if (!titleVersion) {
    return { ok: true, packageVersion, titleVersion, changelogHeading };
  }
  const ok = packageVersion === titleVersion && changelogHeading !== 'Unreleased' && changelogHeading === titleVersion;
  return {
    ok,
    packageVersion,
    titleVersion,
    changelogHeading,
    ...(ok ? {} : { code: 'release-version-mismatch' }),
  };
}

/**
 * Compare two release semvers (same rules as `tools/swarm.mjs` update).
 * @param {ReleaseSemver | null | undefined} a
 * @param {ReleaseSemver | null | undefined} b
 * @returns {number}
 */
export function compareReleaseSemver(a, b) {
  const parse = (value) => {
    if (!isReleaseSemver(value)) return null;
    return value.trim().split('.').map(part => Number(part));
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * @param {{
 *   current?: unknown,
 *   latestTagged?: unknown,
 *   originMainVersion?: unknown,
 * }} input
 * @returns {SwarmUpdateAvailability}
 */
export function deriveSwarmUpdateAvailability(input) {
  const current = normalizeReleaseSemver(input.current);
  const latest = normalizeReleaseSemver(input.latestTagged);
  const pending = normalizeReleaseSemver(input.originMainVersion);
  const tagPending = Boolean(pending && (!latest || compareReleaseSemver(pending, latest) > 0));
  if (tagPending) {
    return {
      current,
      latest,
      pending,
      status: 'tag-pending',
      updateAvailable: false,
      tagPending: true,
      message: pending ? `tag pending for ${pending}; retry in a minute` : undefined,
    };
  }
  const updateAvailable = Boolean(latest && current && compareReleaseSemver(latest, current) > 0);
  if (updateAvailable) {
    return {
      current,
      latest,
      status: 'update-available',
      updateAvailable: true,
      tagPending: false,
    };
  }
  if (current && latest && compareReleaseSemver(current, latest) === 0) {
    return {
      current,
      latest,
      status: 'up-to-date',
      updateAvailable: false,
      tagPending: false,
    };
  }
  return {
    current,
    latest,
    status: 'no-newer-tag',
    updateAvailable: false,
    tagPending: false,
  };
}

/**
 * @param {{
 *   version: unknown,
 *   tag?: unknown,
 *   availability: SwarmUpdateAvailability,
 * }} report
 * @returns {ReleaseVersionReport}
 */
export function validateReleaseVersionReport(report) {
  const label = 'release-version-report';
  if (!report || typeof report !== 'object' || Array.isArray(report)) trainError(label, 'report must be an object');
  if (!isReleaseSemver(report.version)) trainError(label, 'version must be a release semver');
  if (report.tag !== undefined && (typeof report.tag !== 'string' || !RELEASE_TAG_RE.test(report.tag.trim()))) {
    trainError(label, 'tag must be a v-prefixed release tag when set');
  }
  const tagSemver = report.tag ? normalizeReleaseSemver(report.tag) : null;
  if (tagSemver && tagSemver !== report.version.trim()) {
    trainError(label, 'tag must match version');
  }
  const availability = report.availability;
  if (!availability || typeof availability !== 'object' || Array.isArray(availability)) {
    trainError(label, 'availability must be an object');
  }
  const allowed = new Set(['up-to-date', 'update-available', 'tag-pending', 'no-newer-tag']);
  if (!allowed.has(availability.status)) trainError(label, 'availability.status is invalid');
  if (typeof availability.updateAvailable !== 'boolean' || typeof availability.tagPending !== 'boolean') {
    trainError(label, 'availability flags must be booleans');
  }
  if (availability.tagPending !== (availability.status === 'tag-pending')) {
    trainError(label, 'availability.tagPending must agree with status');
  }
  if (availability.status === 'tag-pending' && !availability.pending && !availability.message) {
    trainError(label, 'tag-pending availability needs pending version or message');
  }
  return {
    version: report.version.trim(),
    ...(report.tag !== undefined ? { tag: report.tag.trim() } : {}),
    availability: {
      current: normalizeReleaseSemver(availability.current),
      latest: normalizeReleaseSemver(availability.latest),
      ...(availability.pending !== undefined ? { pending: normalizeReleaseSemver(availability.pending) } : {}),
      status: availability.status,
      updateAvailable: availability.updateAvailable,
      tagPending: availability.tagPending,
      ...(availability.message !== undefined ? { message: String(availability.message) } : {}),
    },
  };
}
