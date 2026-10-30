import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeReviewRecord } from '../tools/swarm.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-review-record-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { id: 'review-5', baseCommit: 'a'.repeat(40) };
  const workspace = path.join(root, 'workspace');
  const resultFile = 'coordination/review/train5-review.json';
  const bytes = Buffer.from('{\r\n  "verdict": "pass"\r\n}\r\n');
  await fs.mkdir(path.join(root, '.swarm/runs', state.id), { recursive: true });
  await fs.mkdir(path.dirname(path.join(workspace, resultFile)), { recursive: true });
  await fs.writeFile(path.join(workspace, resultFile), bytes);
  const job = {
    id: 'review', agent: 'claude', model: 'claude-opus-4-6', status: 'complete',
    outputs: [resultFile], finishedAt: '2026-10-30T12:00:00.000Z',
  };
  const recordFile = path.join(root, '.swarm/runs', state.id, 'review-record.json');
  return { root, state, workspace, job, resultFile, bytes, recordFile };
}

function stampedResultBytes(baseCommit, body = { verdict: 'pass' }) {
  return Buffer.from(`${JSON.stringify({ ...body, head: baseCommit })}\n`);
}

test('runner writes review record from completed job and exact workspace bytes', async (t) => {
  const f = await fixture(t);
  const stampedBytes = stampedResultBytes(f.state.baseCommit);
  await writeReviewRecord(f.root, f.state, f.job, f.workspace);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.workspace, f.resultFile), 'utf8')), {
    verdict: 'pass', head: f.state.baseCommit,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(f.recordFile, 'utf8')), {
    version: 1, runId: f.state.id, jobId: f.job.id, agent: f.job.agent, model: f.job.model,
    manifest: '.swarm/runs/review-5/manifest.json', head: f.state.baseCommit,
    status: 'complete', resultFile: f.resultFile,
    resultHash: createHash('sha256').update(stampedBytes).digest('hex'),
    finishedAt: f.job.finishedAt, stateFile: '.swarm/runs/review-5/state.json',
  });
  assert.deepEqual(await fs.readdir(path.dirname(f.recordFile)), ['review-record.json']);
});

test('runner stamps missing head on result JSON before hashing', async (t) => {
  const f = await fixture(t);
  const stampedBytes = stampedResultBytes(f.state.baseCommit);
  await writeReviewRecord(f.root, f.state, f.job, f.workspace);
  assert.equal(
    JSON.parse(await fs.readFile(f.recordFile, 'utf8')).resultHash,
    createHash('sha256').update(stampedBytes).digest('hex'),
  );
});

test('runner overwrites wrong head on result JSON before hashing', async (t) => {
  const f = await fixture(t);
  const wrongHead = 'b'.repeat(40);
  await fs.writeFile(
    path.join(f.workspace, f.resultFile),
    `${JSON.stringify({ verdict: 'pass', head: wrongHead })}\n`,
  );
  const stampedBytes = stampedResultBytes(f.state.baseCommit);
  await writeReviewRecord(f.root, f.state, f.job, f.workspace);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.workspace, f.resultFile), 'utf8')), {
    verdict: 'pass', head: f.state.baseCommit,
  });
  assert.equal(
    JSON.parse(await fs.readFile(f.recordFile, 'utf8')).resultHash,
    createHash('sha256').update(stampedBytes).digest('hex'),
  );
});

test('runner hashes non-object result JSON without stamping', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('[1,2]\n');
  await fs.writeFile(path.join(f.workspace, f.resultFile), bytes);
  await writeReviewRecord(f.root, f.state, f.job, f.workspace);
  assert.deepEqual(await fs.readFile(path.join(f.workspace, f.resultFile)), bytes);
  assert.equal(
    JSON.parse(await fs.readFile(f.recordFile, 'utf8')).resultHash,
    createHash('sha256').update(bytes).digest('hex'),
  );
});

test('runner uses actualModel when no requested model exists', async (t) => {
  const f = await fixture(t);
  await writeReviewRecord(f.root, f.state, { ...f.job, model: null, actualModel: 'opus-actual' }, f.workspace);
  assert.equal(JSON.parse(await fs.readFile(f.recordFile, 'utf8')).model, 'opus-actual');
});

for (const output of ['src/example.mjs', 'coordination/review/train5-review-run.json', 'elsewhere/train5-review.json']) {
  test('runner does not write review record for ' + output, async (t) => {
    const f = await fixture(t);
    await writeReviewRecord(f.root, f.state, { ...f.job, outputs: [output] }, f.workspace);
    await assert.rejects(fs.access(f.recordFile), { code: 'ENOENT' });
  });
}

for (const status of ['running', 'failed', 'blocked', 'cancelled']) {
  test('runner does not attest a ' + status + ' job', async (t) => {
    const f = await fixture(t);
    await writeReviewRecord(f.root, f.state, { ...f.job, status }, f.workspace);
    await assert.rejects(fs.access(f.recordFile), { code: 'ENOENT' });
  });
}

test('runner warns without writing a record when result bytes cannot be read', async (t) => {
  const f = await fixture(t);
  const warnings = [];
  await writeReviewRecord(f.root, f.state, { ...f.job, outputs: ['coordination/review/missing-review.json'] }, f.workspace, { warn: warning => warnings.push(warning) });
  await assert.rejects(fs.access(f.recordFile), { code: 'ENOENT' });
  assert.deepEqual(warnings, ['review-record-write-failed']);
});
