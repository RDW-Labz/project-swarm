// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKER_TOKEN_ENV,
  issueWorkerToken,
  revokeWorkerToken,
  verifyWorkerToken,
  redactWorkerToken,
} from '../tools/worker-token.mjs';

const testTmpBase = process.env.SWARM_TEST_TMP || os.tmpdir();

function fakeHex(ch, len) {
  return String(ch).repeat(len);
}

async function makeProjectRoot(t) {
  const root = await fs.mkdtemp(path.join(testTmpBase, 'worker-proof-root-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function recordPath(root, runId, jobId) {
  return path.join(root, '.swarm', 'runs', runId, 'worker-tokens', `${jobId}.json`);
}

test('issue, verify inside workspace and subfolder', async (t) => {
  const root = await makeProjectRoot(t);
  const runId = 'run-1';
  const jobId = 'job-a';
  const workspace = await fs.mkdtemp(path.join(testTmpBase, 'ws-a-'));
  const sub = path.join(workspace, 'nested');
  await fs.mkdir(sub);

  const proof = await issueWorkerToken({ root, runId, jobId, workspace });
  assert.match(proof, /^[0-9a-f]{64}$/);

  const inWs = await verifyWorkerToken({ root, token: proof, cwd: workspace });
  assert.equal(inWs.ok, true);
  assert.equal(inWs.runId, runId);
  assert.equal(inWs.jobId, jobId);

  const inSub = await verifyWorkerToken({ root, token: proof, cwd: sub });
  assert.equal(inSub.ok, true);
});

test('verify rejects another job workspace, repo root, wrong proof, expiry, revoke, symlink, bad ids', async (t) => {
  const root = await makeProjectRoot(t);
  const runId = 'run-cross';
  const jobA = 'job-a';
  const jobB = 'job-b';
  const wsA = await fs.mkdtemp(path.join(testTmpBase, 'ws-cross-a-'));
  const wsB = await fs.mkdtemp(path.join(testTmpBase, 'ws-cross-b-'));

  const proofA = await issueWorkerToken({ root, runId, jobId: jobA, workspace: wsA });
  await issueWorkerToken({ root, runId, jobId: jobB, workspace: wsB });

  const otherWs = await verifyWorkerToken({ root, token: proofA, cwd: wsB });
  assert.equal(otherWs.ok, false);
  assert.equal(otherWs.reason, 'cwd-outside-workspace');

  const atRoot = await verifyWorkerToken({ root, token: proofA, cwd: root });
  assert.equal(atRoot.ok, false);

  const wrongProof = fakeHex('d', 64);
  const wrong = await verifyWorkerToken({ root, token: wrongProof, cwd: wsA });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'not-found');

  const shortProof = fakeHex('e', 32);
  const malformed = await verifyWorkerToken({ root, token: shortProof, cwd: wsA });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'invalid-token');

  const issuedAt = Date.now();
  const expiredProof = await issueWorkerToken({
    root,
    runId: 'run-exp',
    jobId: 'job-exp',
    workspace: wsA,
    ttlMs: 1000,
    now: issuedAt,
  });
  const expired = await verifyWorkerToken({
    root,
    token: expiredProof,
    cwd: wsA,
    now: issuedAt + 2000,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');

  const revokeRun = 'run-rev';
  const revokeJob = 'job-rev';
  const revokeWs = await fs.mkdtemp(path.join(testTmpBase, 'ws-rev-'));
  const revokeProof = await issueWorkerToken({
    root,
    runId: revokeRun,
    jobId: revokeJob,
    workspace: revokeWs,
  });
  await revokeWorkerToken({ root, runId: revokeRun, jobId: revokeJob });
  const afterRevoke = await verifyWorkerToken({ root, token: revokeProof, cwd: revokeWs });
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.reason, 'not-found');

  await assert.rejects(
    () => issueWorkerToken({ root, runId: '../evil', jobId: jobA, workspace: wsA }),
    /runId/,
  );

  const symRun = 'run-sym';
  const symJob = 'job-sym';
  const tokensDir = path.join(root, '.swarm', 'runs', symRun);
  await fs.mkdir(tokensDir, { recursive: true });
  const linkTarget = await fs.mkdtemp(path.join(testTmpBase, 'sym-target-'));
  await fs.symlink(linkTarget, path.join(tokensDir, 'worker-tokens'));
  await assert.rejects(
    () => issueWorkerToken({ root, runId: symRun, jobId: symJob, workspace: wsA }),
    /symlink/,
  );
});

test('stored record is hash-only with safe modes; revoke is idempotent; re-issue invalidates prior proof', async (t) => {
  const root = await makeProjectRoot(t);
  const runId = 'run-store';
  const jobId = 'job-store';
  const workspace = await fs.mkdtemp(path.join(testTmpBase, 'ws-store-'));

  const firstProof = await issueWorkerToken({ root, runId, jobId, workspace });
  const file = recordPath(root, runId, jobId);
  const raw = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(raw, new RegExp(firstProof));
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed.hash, 'string');
  assert.equal(parsed.hash.length, 64);
  assert.equal(parsed.revoked, false);

  const dirStat = await fs.stat(path.dirname(file));
  const fileStat = await fs.stat(file);
  assert.equal(dirStat.mode & 0o777, 0o700);
  assert.equal(fileStat.mode & 0o777, 0o600);

  await revokeWorkerToken({ root, runId, jobId });
  await revokeWorkerToken({ root, runId, jobId });

  const stale = await verifyWorkerToken({ root, token: firstProof, cwd: workspace });
  assert.equal(stale.ok, false);

  const secondProof = await issueWorkerToken({ root, runId, jobId, workspace });
  assert.notEqual(firstProof, secondProof);

  const oldStillBad = await verifyWorkerToken({ root, token: firstProof, cwd: workspace });
  assert.equal(oldStillBad.ok, false);

  const newOk = await verifyWorkerToken({ root, token: secondProof, cwd: workspace });
  assert.equal(newOk.ok, true);
});

test('redactWorkerToken scrubs proof and env-shaped hex', () => {
  const ch = 'f';
  const proof = fakeHex(ch, 64);
  const sample = `log ${proof} tail ${WORKER_TOKEN_ENV}=${proof} end`;
  const out = redactWorkerToken(sample, proof);
  assert.ok(!out.includes(proof));
  assert.match(out, /redacted/);
  assert.match(out, new RegExp(`${WORKER_TOKEN_ENV}=redacted`));
});
