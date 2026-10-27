// SPDX-License-Identifier: Apache-2.0
// T-0073: quarantine moves, retry read-only context, partial-wave merge integration (R-017).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  moveFailedTicketOutputsToQuarantine,
  quarantineScopeWaveFailures,
  quarantineReadOnlyContext,
  quarantineReadOnlyContextForRetry,
  attachQuarantineReadOnlyContextFromRecord as attachFromRecordQuarantine,
  waveFailureRecordRel,
  quarantinedOutputRel,
  WAVE_QUARANTINE_ROOT,
  buildWaveFailureRecord,
} from '../tools/wave-quarantine.mjs';
import {
  applyQuarantineReadOnlyContextToJob,
  attachQuarantineReadOnlyContextFromRecord,
  attachQuarantineReadOnlyContextToRetryJob,
  WAVE_QUARANTINE_READ_ONLY_REASON,
} from '../tools/wave-retry-context.mjs';
import {
  passingScopeWaveJobIds,
  skippedScopeWaveJobIds,
  mergeQueueIntegrationSucceeded,
  integratePassingScopeWaveJobs,
} from '../tools/wave-pass-integrate.mjs';

async function tempProjectRoot(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wave-quarantine-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('AC1: moveFailedTicketOutputsToQuarantine moves declared outputs into the quarantine tree', async (t) => {
  const root = await tempProjectRoot(t);
  const runId = 'scope-run-1';
  const ticketId = 'T-0099';
  const sourceRel = 'evals/wave-fixture/out.txt';
  await fs.mkdir(path.dirname(path.join(root, sourceRel)), { recursive: true });
  await fs.writeFile(path.join(root, sourceRel), 'failed worker bytes\n', 'utf8');

  const record = await moveFailedTicketOutputsToQuarantine({
    root,
    runId,
    wave: 2,
    ticketId,
    jobId: ticketId,
    outputPaths: [sourceRel],
    reason: 'checks failed',
    failedAt: '2026-10-21T00:00:00.000Z',
  });

  const quarantineRel = quarantinedOutputRel({ runId, ticketId, sourcePath: sourceRel });
  assert.equal(record.outputs[0].source, sourceRel);
  assert.equal(record.outputs[0].path, quarantineRel);
  await assert.rejects(() => fs.access(path.join(root, sourceRel)));
  const quarantined = await fs.readFile(path.join(root, quarantineRel), 'utf8');
  assert.equal(quarantined, 'failed worker bytes\n');

  const metaRel = waveFailureRecordRel({ runId, ticketId });
  const onDisk = JSON.parse(await fs.readFile(path.join(root, metaRel), 'utf8'));
  assert.equal(onDisk.ticketId, ticketId);
  assert.equal(onDisk.reason, 'checks failed');
});

test('AC1: quarantineScopeWaveFailures quarantines each failed ticket in a wave', async (t) => {
  const root = await tempProjectRoot(t);
  const runId = 'wave-multi';
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.mkdir(path.join(root, 'b'), { recursive: true });
  await fs.writeFile(path.join(root, 'a/one.txt'), '1');
  await fs.writeFile(path.join(root, 'b/two.txt'), '2');

  const records = await quarantineScopeWaveFailures({
    root,
    runId,
    wave: 1,
    passingTicketIds: ['T-0100', 'T-0101'],
    failedTickets: [
      { ticketId: 'T-0098', jobId: 'T-0098', outputPaths: ['a/one.txt'] },
      { ticketId: 'T-0099', jobId: 'T-0099', outputPaths: ['b/two.txt'], reason: 'timeout' },
    ],
    failedAt: '2026-10-21T01:00:00.000Z',
  });

  assert.equal(records.length, 2);
  assert.deepEqual(records[0].passingTicketIds, ['T-0100', 'T-0101']);
  assert.ok(records[1].reason === 'timeout');
  for (const record of records) {
    const ctx = quarantineReadOnlyContext(record);
    assert.ok(ctx.every((p) => p.startsWith(`${WAVE_QUARANTINE_ROOT}/`)));
    for (const rel of ctx) {
      await fs.access(path.join(root, rel));
    }
  }
});

test('AC1: retry jobs receive quarantined paths as read-only context', async (t) => {
  const root = await tempProjectRoot(t);
  const runId = 'retry-run';
  const ticketId = 'T-0073';
  const sourceRel = 'tools/retry-fixture.js';
  await fs.mkdir(path.dirname(path.join(root, sourceRel)), { recursive: true });
  await fs.writeFile(path.join(root, sourceRel), '// prior attempt\n', 'utf8');

  const record = await moveFailedTicketOutputsToQuarantine({
    root,
    runId,
    wave: 1,
    ticketId,
    jobId: ticketId,
    outputPaths: [sourceRel],
  });

  const readOnly = await quarantineReadOnlyContextForRetry({ root, runId, ticketId });
  const metaRel = waveFailureRecordRel({ runId, ticketId });
  assert.deepEqual(readOnly, quarantineReadOnlyContext(record));

  const fromQuarantine = attachFromRecordQuarantine({ id: ticketId, context: ['docs/scope/context/overview.md'] }, record);
  assert.ok(fromQuarantine.context.includes(metaRel));
  assert.ok(fromQuarantine.context.includes(record.outputs[0].path));
  assert.ok(fromQuarantine.context.includes('docs/scope/context/overview.md'));

  const fromRetryModule = attachQuarantineReadOnlyContextFromRecord(
    { id: ticketId, outputs: [sourceRel], context: [] },
    record,
    { exists: () => true },
  );
  assert.ok(fromRetryModule.context.includes(metaRel));
  assert.ok(fromRetryModule.context.includes(record.outputs[0].path));
  assert.equal(fromRetryModule.allowProtectedContext, WAVE_QUARANTINE_READ_ONLY_REASON);
  assert.ok(!fromRetryModule.context.includes(sourceRel), 'declared outputs are not duplicated as context');

  const loaded = await attachQuarantineReadOnlyContextToRetryJob(
    { id: ticketId, context: [] },
    { root, runId, ticketId, exists: () => true },
  );
  assert.deepEqual(
    loaded.context.sort(),
    applyQuarantineReadOnlyContextToJob({ context: [] }, readOnly).context.sort(),
  );
});

test('AC1: applyQuarantineReadOnlyContextToJob ignores paths outside the quarantine tree', () => {
  const job = { id: 'T-0001', context: [], outputs: [] };
  const merged = applyQuarantineReadOnlyContextToJob(job, [
    'src/leaked.ts',
    `${WAVE_QUARANTINE_ROOT}/run/T-0001/wave-failure.json`,
  ]);
  assert.deepEqual(merged.context, [`${WAVE_QUARANTINE_ROOT}/run/T-0001/wave-failure.json`]);
});

test('AC2: passingScopeWaveJobIds and skippedScopeWaveJobIds bisect incomplete jobs out of integration', () => {
  const state = {
    jobs: [
      { id: 'T-0100', status: 'complete' },
      { id: 'T-0101', status: 'complete' },
      { id: 'T-0102', status: 'failed' },
      { id: 'T-0103', status: 'running' },
    ],
  };
  assert.deepEqual(passingScopeWaveJobIds(state), ['T-0100', 'T-0101']);
  assert.deepEqual(skippedScopeWaveJobIds(state), ['T-0102', 'T-0103']);
});

test('AC2: mergeQueueIntegrationSucceeded is true when passing jobs integrated and checks stayed green', () => {
  assert.equal(
    mergeQueueIntegrationSucceeded({
      mergeQueue: { state: 'integrated', integrated: ['T-0100', 'T-0101'], checkFailed: [], securityBlocked: [] },
    }),
    true,
  );
  assert.equal(
    mergeQueueIntegrationSucceeded({
      mergeQueue: {
        state: 'integrated',
        integrated: ['T-0100'],
        checkFailed: [{ jobId: 'T-0102' }],
        securityBlocked: [],
      },
    }),
    false,
  );
  assert.equal(
    mergeQueueIntegrationSucceeded({ mergeQueue: { state: 'final-check-failed', integrated: ['T-0100'] } }),
    false,
  );
});

test('AC2: integratePassingScopeWaveJobs skips merge queue when no job completed', async (t) => {
  const root = await tempProjectRoot(t);
  const runId = 'wave-all-failed';
  const stateDir = path.join(root, '.swarm/runs', runId);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, 'state.json'),
    JSON.stringify({
      id: runId,
      jobs: [
        { id: 'T-0300', status: 'failed' },
        { id: 'T-0301', status: 'timeout' },
      ],
    }),
    'utf8',
  );

  const result = await integratePassingScopeWaveJobs(root, runId);
  assert.equal(result.integrated, false);
  assert.equal(result.jobs, 0);
  assert.equal(result.checksPassed, true);
  assert.deepEqual(result.passingJobIds, []);
  assert.deepEqual(result.skippedJobIds, ['T-0300', 'T-0301']);
});

test('AC2: buildWaveFailureRecord records passing tickets that integrated in the same wave', () => {
  const record = buildWaveFailureRecord({
    runId: 'scope-1',
    wave: 3,
    ticketId: 'T-0200',
    jobId: 'T-0200',
    failedAt: '2026-10-21T12:00:00.000Z',
    outputs: [
      {
        source: 'x.txt',
        path: `${WAVE_QUARANTINE_ROOT}/scope-1/T-0200/files/x.txt`,
      },
    ],
    passingTicketIds: ['T-0201', 'T-0202'],
  });
  assert.deepEqual(record.passingTicketIds, ['T-0201', 'T-0202']);
});

test('AC2: quarantining a failed ticket leaves passing ticket outputs in place', async (t) => {
  const root = await tempProjectRoot(t);
  await fs.writeFile(path.join(root, 'pass.txt'), 'ok', 'utf8');
  await fs.writeFile(path.join(root, 'bad.txt'), 'bad', 'utf8');
  const records = await quarantineScopeWaveFailures({
    root,
    runId: 'wave-mixed',
    wave: 1,
    passingTicketIds: ['T-0400'],
    failedTickets: [{ ticketId: 'T-0401', jobId: 'T-0401', outputPaths: ['bad.txt'] }],
  });
  assert.deepEqual(records[0].passingTicketIds, ['T-0400']);
  assert.equal(await fs.readFile(path.join(root, 'pass.txt'), 'utf8'), 'ok');
  await assert.rejects(() => fs.access(path.join(root, 'bad.txt')));
});
