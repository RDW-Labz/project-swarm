// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';

/**
 * @param {string} version
 * @returns {string | null}
 */
function bumpPatchReleaseSemver(version) {
  const trimmed = typeof version === 'string' ? version.trim() : '';
  const parts = trimmed.split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return `${nums[0]}.${nums[1]}.${nums[2] + 1}`;
}

/**
 * @param {string} root
 */
export async function releaseTrainStatusReport(root) {
  const { readReleaseTrainStore, readPackageVersion } = await import('./release-train-bump.mjs');
  const { compareReleaseSemver } = await import('./release-train-types.mjs');
  const resolved = path.resolve(root);
  const packageVersion = await readPackageVersion(resolved);
  const store = await readReleaseTrainStore(resolved);
  const batchedReleases = store.releases.map((release) => ({
    version: release.version,
    trigger: release.trigger,
    sha: release.sha,
    mergedAt: release.mergedAt,
    runnerMergeShas: [...release.runnerMergeShas],
    ...(release.releaseTitle !== undefined ? { releaseTitle: release.releaseTitle } : {}),
  }));
  const pendingRunnerMerges = store.pendingRunnerMerges.map((merge) => ({
    sha: merge.sha,
    mergedAt: merge.mergedAt,
    ...(merge.pr !== undefined ? { pr: merge.pr } : {}),
    ...(merge.title !== undefined ? { title: merge.title } : {}),
  }));
  let nextBump = null;
  if (pendingRunnerMerges.length > 0) {
    const version = packageVersion && compareReleaseSemver(packageVersion, store.lastReleasedVersion) > 0
      ? packageVersion
      : bumpPatchReleaseSemver(store.lastReleasedVersion);
    if (version) {
      nextBump = {
        version,
        releaseTitle: `Release ${version}`,
        runnerMergeShas: pendingRunnerMerges.map((merge) => merge.sha),
      };
    }
  }
  return {
    status: 'ok',
    lastReleasedVersion: store.lastReleasedVersion,
    packageVersion,
    pendingRunnerMerges,
    batchedReleases,
    nextBump,
  };
}

/**
 * @param {Awaited<ReturnType<typeof releaseTrainStatusReport>>} report
 */
export function formatReleaseTrainStatus(report) {
  const lines = [`release train (last released ${report.lastReleasedVersion})`];
  if (report.batchedReleases.length) {
    lines.push('batched releases:');
    for (const release of report.batchedReleases) {
      lines.push(`  ${release.version} (${release.trigger}) batches ${release.runnerMergeShas.length} runner merge(s)`);
    }
  } else {
    lines.push('batched releases: none');
  }
  lines.push(`pending runner merges: ${report.pendingRunnerMerges.length}`);
  if (report.nextBump) {
    lines.push(`next bump: ${report.nextBump.version} (${report.nextBump.runnerMergeShas.length} runner merge(s))`);
  } else {
    lines.push('next bump: none');
  }
  return `${lines.join('\n')}\n`;
}
