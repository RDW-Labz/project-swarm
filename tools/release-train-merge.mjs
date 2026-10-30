// SPDX-License-Identifier: Apache-2.0
// Runner-only merges on the release train (R-016 / T-0064): merge without a package version bump,
// accumulate pending runner records, and leave batched version bumps to T-0065.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RUNNER_MERGE_KIND,
  emptyReleaseTrainStore,
  formatReleaseTrainStore,
  isReleaseSemver,
  normalizeReleaseSemver,
  parseReleaseTrainStore,
  recordRunnerMerge,
  releaseTrainStorePath,
} from './release-train-types.mjs';

/** Same rule as `releaseTitleVersion` in tools/ship.mjs (release-bump PRs, not runner-only). */
const RELEASE_TITLE_VERSION_RE = /^(?:Release\s+)?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/;

/**
 * Built tools the merge queue runs in order for a runner-only PR (shared contract; T-0068 wires CLI).
 *
 * @type {readonly { readonly module: string, readonly export: string }[]}
 */
export const RUNNER_ONLY_MERGE_TOOL_ORDER = Object.freeze([
  Object.freeze({ module: 'tools/merge-guard.mjs', export: 'runMerge' }),
  Object.freeze({ module: 'tools/release-train-merge.mjs', export: 'recordRunnerOnlyMergeOnProject' }),
]);

/**
 * @type {{ readonly kind: typeof RUNNER_MERGE_KIND, readonly tools: typeof RUNNER_ONLY_MERGE_TOOL_ORDER }}
 */
export const RUNNER_ONLY_MERGE_CONTRACT = Object.freeze({
  kind: RUNNER_MERGE_KIND,
  tools: RUNNER_ONLY_MERGE_TOOL_ORDER,
});

/**
 * @param {unknown} title
 * @returns {string | null}
 */
export function releaseTitleVersion(title) {
  return RELEASE_TITLE_VERSION_RE.exec(String(title ?? '').trim())?.[1] ?? null;
}

/**
 * @param {unknown} text
 * @returns {import('./release-train-types.mjs').ReleaseSemver | null}
 */
export function packageJsonVersionFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const version = JSON.parse(text).version;
    return isReleaseSemver(version) ? version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @returns {Promise<import('./release-train-types.mjs').ReleaseSemver | null>}
 */
export async function readInstalledPackageVersion(root) {
  try {
    const text = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    return packageJsonVersionFromText(text);
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   exec: (command: string, args: string[], options?: { cwd?: string }) => Promise<{ code: number, stdout?: string, stderr?: string }>,
 *   root: string,
 *   ref: string,
 * }} input
 * @returns {Promise<import('./release-train-types.mjs').ReleaseSemver | null>}
 */
export async function packageVersionAtGitRef({ exec, root, ref }) {
  const res = await exec('git', ['show', `${ref}:package.json`], { cwd: root });
  if (res.code !== 0) return null;
  return packageJsonVersionFromText(String(res.stdout ?? ''));
}

/**
 * Runner PRs must not bump package.json or use a release title; HEAD must match the train version.
 *
 * @param {{
 *   basePackageVersion?: unknown,
 *   headPackageVersion?: unknown,
 *   prTitle?: unknown,
 *   trainLastReleasedVersion?: unknown,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   packageVersion: import('./release-train-types.mjs').ReleaseSemver | null,
 *   code?: string,
 *   message?: string,
 * }}
 */
export function evaluateRunnerOnlyMergePolicy(input) {
  const titleVersion = releaseTitleVersion(input.prTitle);
  if (titleVersion) {
    return {
      ok: false,
      packageVersion: null,
      code: 'runner-merge-release-pr',
      message: `PR title names release ${titleVersion}; use a batched release-bump merge instead of runner-only`,
    };
  }
  const base = normalizeReleaseSemver(input.basePackageVersion);
  const head = normalizeReleaseSemver(input.headPackageVersion);
  if (!head) {
    return {
      ok: false,
      packageVersion: null,
      code: 'runner-merge-missing-head-version',
      message: 'HEAD package.json must contain a release semver',
    };
  }
  if (base && base !== head) {
    return {
      ok: false,
      packageVersion: head,
      code: 'runner-merge-version-bump',
      message: `runner-only merge must not change package.json version (${base} -> ${head})`,
    };
  }
  const train = normalizeReleaseSemver(input.trainLastReleasedVersion);
  if (train && head !== train) {
    return {
      ok: false,
      packageVersion: head,
      code: 'runner-merge-off-train',
      message: `HEAD version ${head} does not match train lastReleasedVersion ${train}`,
    };
  }
  return { ok: true, packageVersion: head };
}

/**
 * @param {string} root
 * @param {string} text
 */
async function atomicWriteReleaseTrainStore(root, text) {
  const abs = releaseTrainStorePath(root);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, text, { flag: 'wx', mode: 0o644 });
    await fs.rename(tmp, abs);
  } catch (error) {
    await fs.unlink(tmp).catch((unlinkError) => {
      if (unlinkError?.code !== 'ENOENT') console.error('[tools/release-train-merge.mjs] atomic write tmp unlink:', unlinkError?.message ?? unlinkError);
    });
    throw error;
  }
}

/**
 * @param {string} root
 * @returns {Promise<import('./release-train-types.mjs').ReleaseTrainStore>}
 */
export async function readReleaseTrainStoreFromProject(root) {
  const text = await fs.readFile(releaseTrainStorePath(root), 'utf8');
  return parseReleaseTrainStore(text);
}

/**
 * @param {string} root
 * @param {import('./release-train-types.mjs').ReleaseTrainStore} store
 */
export async function writeReleaseTrainStoreToProject(root, store) {
  await atomicWriteReleaseTrainStore(root, formatReleaseTrainStore(store));
}

/**
 * @param {string} root
 * @param {import('./release-train-types.mjs').ReleaseSemver} lastReleasedVersion
 * @returns {Promise<import('./release-train-types.mjs').ReleaseTrainStore>}
 */
export async function loadOrInitReleaseTrainStore(root, lastReleasedVersion) {
  try {
    return await readReleaseTrainStoreFromProject(root);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      const store = emptyReleaseTrainStore(lastReleasedVersion);
      await writeReleaseTrainStoreToProject(root, store);
      return store;
    }
    throw error;
  }
}

/**
 * @param {{
 *   sha: unknown,
 *   mergedAt?: unknown,
 *   pr?: unknown,
 *   title?: unknown,
 * }} fields
 */
export function buildRunnerMergeRecord(fields) {
  const mergedAt = typeof fields.mergedAt === 'string' && fields.mergedAt.trim()
    ? fields.mergedAt.trim()
    : new Date().toISOString();
  return {
    kind: RUNNER_MERGE_KIND,
    sha: fields.sha,
    mergedAt,
    ...(fields.pr !== undefined ? { pr: fields.pr } : {}),
    ...(fields.title !== undefined ? { title: fields.title } : {}),
  };
}

/**
 * Record a merged runner-only PR on the train store without advancing lastReleasedVersion.
 *
 * @param {string} root
 * @param {{
 *   sha: unknown,
 *   mergedAt?: unknown,
 *   pr?: unknown,
 *   title?: unknown,
 *   basePackageVersion?: unknown,
 *   headPackageVersion?: unknown,
 * }} fields
 * @returns {Promise<{
 *   status: 'recorded',
 *   store: import('./release-train-types.mjs').ReleaseTrainStore,
 *   merge: import('./release-train-types.mjs').RunnerMergeRecord,
 * } | {
 *   status: 'refused',
 *   code: string,
 *   message: string,
 * }>}
 */
export async function recordRunnerOnlyMergeOnProject(root, fields) {
  const headFromDisk = fields.headPackageVersion ?? await readInstalledPackageVersion(root);
  const headVersion = normalizeReleaseSemver(headFromDisk);
  if (!headVersion) {
    return {
      status: 'refused',
      code: 'runner-merge-missing-head-version',
      message: 'HEAD package.json must contain a release semver',
    };
  }
  let store;
  try {
    store = await readReleaseTrainStoreFromProject(root);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      store = await loadOrInitReleaseTrainStore(root, headVersion);
    } else {
      throw error;
    }
  }
  const policy = evaluateRunnerOnlyMergePolicy({
    basePackageVersion: fields.basePackageVersion,
    headPackageVersion: headFromDisk,
    prTitle: fields.title,
    trainLastReleasedVersion: store.lastReleasedVersion,
  });
  if (!policy.ok) {
    return { status: 'refused', code: policy.code ?? 'runner-merge-refused', message: policy.message ?? 'runner-only merge refused' };
  }
  const nextStore = recordRunnerMerge(store, buildRunnerMergeRecord(fields));
  await writeReleaseTrainStoreToProject(root, nextStore);
  const recorded = nextStore.pendingRunnerMerges[nextStore.pendingRunnerMerges.length - 1];
  return { status: 'recorded', store: nextStore, merge: recorded };
}

/**
 * @param {{
 *   exec: (command: string, args: string[], options?: { cwd?: string }) => Promise<{ code: number, stdout?: string, stderr?: string }>,
 *   root: string,
 *   baseRef: string,
 *   headRef: string,
 *   prTitle?: unknown,
 * }} input
 */
export async function preflightRunnerOnlyMerge(input) {
  const basePackageVersion = await packageVersionAtGitRef({
    exec: input.exec,
    root: input.root,
    ref: input.baseRef,
  });
  const headPackageVersion = await packageVersionAtGitRef({
    exec: input.exec,
    root: input.root,
    ref: input.headRef,
  });
  let trainLastReleasedVersion = null;
  try {
    const store = await readReleaseTrainStoreFromProject(input.root);
    trainLastReleasedVersion = store.lastReleasedVersion;
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
    trainLastReleasedVersion = headPackageVersion;
  }
  const policy = evaluateRunnerOnlyMergePolicy({
    basePackageVersion,
    headPackageVersion,
    prTitle: input.prTitle,
    trainLastReleasedVersion,
  });
  return policy.ok
    ? { status: 'ok', packageVersion: policy.packageVersion }
    : { status: 'refused', code: policy.code ?? 'runner-merge-refused', message: policy.message ?? 'runner-only merge refused' };
}

/**
 * After `runMerge` succeeds, append the merge to `.swarm/project/release-train.json`.
 *
 * @param {string} root
 * @param {{ status?: string, sha?: string, pr?: number }} mergeResult
 * @param {{ mergedAt?: string, title?: string, basePackageVersion?: unknown, headPackageVersion?: unknown }} [meta]
 */
export async function followUpRunnerOnlyMerge(root, mergeResult, meta = {}) {
  if (mergeResult?.status !== 'merged' || !mergeResult.sha) {
    return { status: 'skipped', reason: 'merge-not-complete' };
  }
  return recordRunnerOnlyMergeOnProject(root, {
    sha: mergeResult.sha,
    mergedAt: meta.mergedAt,
    pr: mergeResult.pr,
    title: meta.title,
    basePackageVersion: meta.basePackageVersion,
    headPackageVersion: meta.headPackageVersion,
  });
}

const USAGE = 'usage: release-train-merge record --sha SHA [--merged-at ISO] [--pr N] [--title TEXT] [--json]';

/**
 * @param {string[]} argv
 */
async function runCli(argv) {
  const args = [...argv];
  if (args[0] !== 'record') {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  args.shift();
  let sha = null;
  let mergedAt;
  let pr;
  let title;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--sha') {
      sha = args[++i];
      continue;
    }
    if (flag === '--merged-at') {
      mergedAt = args[++i];
      continue;
    }
    if (flag === '--pr') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 1;
        return;
      }
      pr = n;
      continue;
    }
    if (flag === '--title') {
      title = args[++i];
      continue;
    }
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (!sha) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const out = await recordRunnerOnlyMergeOnProject(process.cwd(), { sha, mergedAt, pr, title });
  const line = JSON.stringify(out);
  if (json) process.stdout.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
  process.exitCode = out.status === 'recorded' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli(process.argv.slice(2));
}
