import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RUNNER_ONLY_MERGE_CONTRACT,
  evaluateRunnerOnlyMergePolicy,
  recordRunnerOnlyMergeOnProject,
} from '../tools/release-train-merge.mjs';
import { batchReleaseBump, releaseBumpCoherenceFields } from '../tools/release-train-bump.mjs';
import {
  RELEASE_BUMP_TRIGGERS,
  deriveSwarmUpdateAvailability,
  emptyReleaseTrainStore,
  formatReleaseTrainStore,
  recordRunnerMerge,
  releaseTrainStorePath,
} from '../tools/release-train-types.mjs';
import {
  releaseVersionReportFromBump,
  releaseVersionReportsFromStore,
  swarmUpdateAvailabilityForInstall,
} from '../tools/release-train-update.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_BUMP = 'd'.repeat(40);
const MERGED_AT = '2026-10-21T12:00:00.000Z';

/**
 * @param {string} version
 */
async function makeProjectRoot(version = '1.0.0') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-train-test-'));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version, private: true }, null, 2)}\n`,
  );
  return root;
}

/**
 * @param {string} root
 * @param {import('../tools/release-train-types.mjs').ReleaseTrainStore} store
 */
async function writeStore(root, store) {
  await fs.writeFile(releaseTrainStorePath(root), formatReleaseTrainStore(store));
}

test('AC1: runner-only merge contract runs merge guard then records without a version bump', () => {
  assert.equal(RUNNER_ONLY_MERGE_CONTRACT.kind, 'runner-only');
  assert.equal(RUNNER_ONLY_MERGE_CONTRACT.tools.length, 2);
  assert.equal(RUNNER_ONLY_MERGE_CONTRACT.tools[0].export, 'runMerge');
  assert.equal(RUNNER_ONLY_MERGE_CONTRACT.tools[1].export, 'recordRunnerOnlyMergeOnProject');
});

test('AC1: evaluateRunnerOnlyMergePolicy rejects a release title on a runner PR', () => {
  const result = evaluateRunnerOnlyMergePolicy({
    basePackageVersion: '1.0.0',
    headPackageVersion: '1.0.0',
    prTitle: 'Release 1.1.0',
    trainLastReleasedVersion: '1.0.0',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'runner-merge-release-pr');
});

test('AC1: evaluateRunnerOnlyMergePolicy rejects a package.json version bump', () => {
  const result = evaluateRunnerOnlyMergePolicy({
    basePackageVersion: '1.0.0',
    headPackageVersion: '1.1.0',
    prTitle: 'fix runner',
    trainLastReleasedVersion: '1.0.0',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'runner-merge-version-bump');
});

test('AC1: evaluateRunnerOnlyMergePolicy accepts unchanged version aligned with the train', () => {
  const result = evaluateRunnerOnlyMergePolicy({
    basePackageVersion: '1.0.0',
    headPackageVersion: '1.0.0',
    prTitle: 'runner change',
    trainLastReleasedVersion: '1.0.0',
  });
  assert.equal(result.ok, true);
  assert.equal(result.packageVersion, '1.0.0');
});

test('AC1: recordRunnerOnlyMergeOnProject accumulates pending merges without advancing lastReleasedVersion', async () => {
  const root = await makeProjectRoot('2.0.0');
  const store = emptyReleaseTrainStore('2.0.0');
  await writeStore(root, store);

  const out = await recordRunnerOnlyMergeOnProject(root, {
    sha: SHA_A,
    mergedAt: MERGED_AT,
    pr: 42,
    title: 'runner fix',
    basePackageVersion: '2.0.0',
    headPackageVersion: '2.0.0',
  });

  assert.equal(out.status, 'recorded');
  assert.equal(out.store.lastReleasedVersion, '2.0.0');
  assert.equal(out.store.pendingRunnerMerges.length, 1);
  assert.equal(out.store.pendingRunnerMerges[0].sha, SHA_A);
  assert.equal(out.store.releases.length, 0);
});

test('AC1: batchReleaseBump batches pending runner merges on scheduled trigger', () => {
  let store = emptyReleaseTrainStore('1.0.0');
  store = recordRunnerMerge(store, { kind: 'runner-only', sha: SHA_A, mergedAt: MERGED_AT });
  store = recordRunnerMerge(store, { kind: 'runner-only', sha: SHA_B, mergedAt: MERGED_AT });

  const next = batchReleaseBump(store, {
    trigger: 'scheduled',
    sha: SHA_BUMP,
    mergedAt: MERGED_AT,
    releaseTitle: 'Release 1.1.0',
  }, { packageVersion: '1.1.0', changelogHeading: '1.1.0' });

  assert.equal(next.lastReleasedVersion, '1.1.0');
  assert.deepEqual(next.pendingRunnerMerges, []);
  assert.equal(next.releases.length, 1);
  assert.equal(next.releases[0].trigger, 'scheduled');
  assert.deepEqual(next.releases[0].runnerMergeShas, [SHA_A, SHA_B]);
});

test('AC1: batchReleaseBump batches pending runner merges on on-demand trigger', () => {
  let store = emptyReleaseTrainStore('3.0.0');
  store = recordRunnerMerge(store, { kind: 'runner-only', sha: SHA_C, mergedAt: MERGED_AT });

  const next = batchReleaseBump(store, {
    trigger: 'on-demand',
    sha: SHA_BUMP,
    mergedAt: MERGED_AT,
    version: '3.1.0',
    releaseTitle: 'Release 3.1.0',
  }, { packageVersion: '3.1.0', changelogHeading: '3.1.0' });

  assert.equal(next.lastReleasedVersion, '3.1.0');
  assert.equal(next.releases[0].trigger, 'on-demand');
  assert.deepEqual(next.releases[0].runnerMergeShas, [SHA_C]);
});

test('AC1: batchReleaseBump requires a known trigger', () => {
  const store = emptyReleaseTrainStore('1.0.0');
  assert.throws(
    () => batchReleaseBump(store, { trigger: 'manual', sha: SHA_BUMP, mergedAt: MERGED_AT }, { packageVersion: '1.1.0' }),
    (error) => error.code === 'release-bump-invalid',
  );
  for (const trigger of RELEASE_BUMP_TRIGGERS) {
    assert.ok(RELEASE_BUMP_TRIGGERS.includes(trigger));
  }
});

test('AC1: releaseBumpCoherenceFields ties package, title, and changelog for a batched bump', () => {
  const coherent = releaseBumpCoherenceFields({
    packageVersion: '1.2.0',
    releaseTitle: 'Release 1.2.0',
    changelogHeading: '1.2.0',
  });
  assert.equal(coherent.packageVersion, '1.2.0');
  assert.equal(coherent.titleVersion, '1.2.0');
  assert.equal(coherent.changelogHeading, '1.2.0');
});

test('AC2: deriveSwarmUpdateAvailability reports up-to-date when current matches latest tag', () => {
  const availability = deriveSwarmUpdateAvailability({
    current: '1.5.0',
    latestTagged: '1.5.0',
    originMainVersion: '1.5.0',
  });
  assert.equal(availability.status, 'up-to-date');
  assert.equal(availability.updateAvailable, false);
  assert.equal(availability.tagPending, false);
});

test('AC2: swarmUpdateAvailabilityForInstall surfaces tag-pending when main is ahead of tags', () => {
  const availability = swarmUpdateAvailabilityForInstall({
    current: '1.4.0',
    latestTagged: '1.4.0',
    originMainVersion: '1.5.0',
  });
  assert.equal(availability.status, 'tag-pending');
  assert.equal(availability.pending, '1.5.0');
  assert.equal(availability.tagPending, true);
  assert.equal(availability.updateAvailable, false);
});

test('AC2: releaseVersionReportsFromStore yields one clean semver per batched release', () => {
  let store = emptyReleaseTrainStore('1.0.0');
  store = recordRunnerMerge(store, { kind: 'runner-only', sha: SHA_A, mergedAt: MERGED_AT });
  store = batchReleaseBump(store, {
    trigger: 'on-demand',
    sha: SHA_BUMP,
    mergedAt: MERGED_AT,
    releaseTitle: 'Release 1.1.0',
  }, { packageVersion: '1.1.0', changelogHeading: '1.1.0' });

  const availability = deriveSwarmUpdateAvailability({
    current: '1.1.0',
    latestTagged: '1.1.0',
    originMainVersion: '1.1.0',
  });
  const reports = releaseVersionReportsFromStore(store, availability);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].version, '1.1.0');
  assert.equal(reports[0].tag, undefined);
  assert.equal(reports[0].availability.status, 'up-to-date');
  assert.match(reports[0].version, /^\d+\.\d+\.\d+$/);
});

test('AC2: releaseVersionReportFromBump pairs a clean semver with a v-prefixed tag when published', () => {
  const bump = {
    kind: 'release-bump',
    version: '2.2.0',
    trigger: 'scheduled',
    sha: SHA_BUMP,
    mergedAt: MERGED_AT,
    runnerMergeShas: [SHA_A],
    tag: { name: 'v2.2.0', status: 'published' },
  };
  const availability = deriveSwarmUpdateAvailability({
    current: '2.2.0',
    latestTagged: '2.2.0',
    originMainVersion: '2.2.0',
  });
  const report = releaseVersionReportFromBump(bump, availability);
  assert.equal(report.version, '2.2.0');
  assert.equal(report.tag, 'v2.2.0');
  assert.equal(report.availability.status, 'up-to-date');
});
