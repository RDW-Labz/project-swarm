// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { batchReleaseBump } from '../tools/release-train-bump.mjs';
import {
  emptyReleaseTrainStore,
  formatReleaseTrainStore,
  recordRunnerMerge,
  releaseTrainStorePath,
} from '../tools/release-train-types.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swarmCli = path.join(packageRoot, 'tools/swarm.mjs');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_BUMP = 'd'.repeat(40);
const MERGED_AT = '2026-10-21T12:00:00.000Z';

/**
 * @param {string} version
 */
async function makeProjectRoot(version = '1.0.0') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-release-train-cli-'));
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

/**
 * @param {string} root
 * @param {string[]} argv
 */
async function runSwarm(root, argv) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [swarmCli, '--root', root, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, SWARM_CONFIG: process.env.SWARM_CONFIG },
  });
  return { stdout, stderr };
}

test('AC1: swarm release-train status reports batched runner merges and the next bump from the live CLI', async (t) => {
  const root = await makeProjectRoot('1.1.0');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let store = emptyReleaseTrainStore('1.0.0');
  store = recordRunnerMerge(store, { kind: 'runner-only', sha: SHA_A, mergedAt: MERGED_AT, pr: 10, title: 'runner one' });
  store = batchReleaseBump(store, {
    trigger: 'scheduled',
    sha: SHA_BUMP,
    mergedAt: MERGED_AT,
    releaseTitle: 'Release 1.1.0',
  }, { packageVersion: '1.1.0', changelogHeading: '1.1.0' });
  store = recordRunnerMerge(store, { kind: 'runner-only', sha: SHA_B, mergedAt: MERGED_AT, pr: 11, title: 'runner two' });
  await writeStore(root, store);

  const { stdout } = await runSwarm(root, ['release-train', 'status', '--json']);
  const report = JSON.parse(stdout.trim());

  assert.equal(report.status, 'ok');
  assert.equal(report.lastReleasedVersion, '1.1.0');
  assert.equal(report.batchedReleases.length, 1);
  assert.deepEqual(report.batchedReleases[0].runnerMergeShas, [SHA_A]);
  assert.equal(report.batchedReleases[0].version, '1.1.0');
  assert.equal(report.pendingRunnerMerges.length, 1);
  assert.equal(report.pendingRunnerMerges[0].sha, SHA_B);
  assert.ok(report.nextBump);
  assert.equal(report.nextBump.version, '1.1.1');
  assert.equal(report.nextBump.releaseTitle, 'Release 1.1.1');
  assert.deepEqual(report.nextBump.runnerMergeShas, [SHA_B]);
});

test('AC1: swarm release-train status prints human output without --json', async (t) => {
  const root = await makeProjectRoot('1.0.0');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let store = emptyReleaseTrainStore('1.0.0');
  store = recordRunnerMerge(store, { kind: 'runner-only', sha: SHA_A, mergedAt: MERGED_AT });
  await writeStore(root, store);

  const { stdout } = await runSwarm(root, ['release-train', 'status']);
  assert.match(stdout, /release train \(last released 1\.0\.0\)/);
  assert.match(stdout, /pending runner merges: 1/);
  assert.match(stdout, /next bump: 1\.0\.1/);
});
