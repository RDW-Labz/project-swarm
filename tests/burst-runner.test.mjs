// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claim } from '../tools/ledger-lease.mjs';
import { createLedger, readLedger, writeLedger } from '../tools/tickets.mjs';
import {
  HEARTBEAT_TIMEOUT_MS,
  registerRunner,
  recordHeartbeat,
  sweepStaleHeartbeats,
  claimForRunner,
} from '../tools/burst-lease.mjs';
import {
  routeBurstTicket,
  recordBurstCompletion,
  readBurstCompletions,
  listQueueJobsForProject,
  cloudJobCount,
  BURST_LANE_TAG,
} from '../tools/burst-route.mjs';

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-burst-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

const burstTicket = (id, status = 'ready') => ({
  id,
  title: 'burst work',
  type: 'human',
  scopeRefs: [],
  size: 'S',
  risk: 'low',
  status,
  steps: ['run on cloud'],
  tags: [BURST_LANE_TAG],
});

async function seed(root, { id = 'T-0411', status = 'ready', tags } = {}) {
  const ticket = burstTicket(id, status);
  if (tags) ticket.tags = tags;
  const ledger = createLedger({ tickets: [ticket] });
  await writeLedger(root, ledger);
  return ticket;
}

test('cloud runner missing heartbeat for 120s returns lease; local worker can claim', async t => {
  const root = await tmp(t);
  const ticket = await seed(root, { id: 'T-0411' });
  const t0 = Date.now();
  const runnerId = 'cloud-a';
  const localId = 'local-worker';

  await registerRunner(root, runnerId, { now: t0 });
  const leased = await claimForRunner(root, ticket.id, runnerId, {
    now: t0,
    leaseTtlMs: 60 * 60 * 1000,
  });
  assert.equal(leased.holderId, runnerId);

  const lastBeat = t0 + 30_000;
  await recordHeartbeat(root, runnerId, { now: lastBeat });

  const sweepAt = lastBeat + HEARTBEAT_TIMEOUT_MS + 1;
  const { returned } = await sweepStaleHeartbeats(root, { now: sweepAt });
  assert.deepEqual(returned, [ticket.id]);

  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'ready');

  const localClaim = await claim(root, ticket.id, localId, { now: sweepAt + 1000, leaseTtlMs: 60_000 });
  assert.equal(localClaim.holderId, localId);
  assert.ok(localClaim.fencingToken > leased.fencingToken);
});

test('lane:burst on burst-enabled project routes to cloud runner and records completion', async t => {
  const root = await tmp(t);
  const ticket = await seed(root, { id: 'T-0412' });
  const t0 = Date.now();
  const runnerId = 'cloud-burst-1';
  const projectConfig = { burst: 'on' };

  const routed = await routeBurstTicket(root, ticket, projectConfig, { runnerId, now: t0 });
  assert.equal(routed.routed, true);
  assert.equal(routed.destination, 'cloud');
  assert.equal(routed.runnerId, runnerId);
  assert.equal(routed.lease.holderId, runnerId);

  let ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'running');

  const outcome = { exitCode: 0, stdout: 'ok' };
  const entry = await recordBurstCompletion(root, {
    ticketId: ticket.id,
    runnerId,
    fencingToken: routed.lease.fencingToken,
    outcome,
    now: t0 + 5000,
  });
  assert.equal(entry.type, 'burst.completed');
  assert.equal(entry.ticketId, ticket.id);

  const completions = await readBurstCompletions(root);
  assert.equal(completions.length, 1);
  assert.deepEqual(completions[0].outcome, outcome);

  ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'ready');
});

test('burst-disabled project shows zero cloud jobs despite other projects burst activity', async t => {
  const sharedJobs = [
    { id: 'job-1', tags: [BURST_LANE_TAG], project: 'burst-on-project' },
    { id: 'job-2', tags: ['lane:default'], project: 'burst-on-project' },
    { id: 'job-3', tags: [BURST_LANE_TAG], project: 'other-burst-on' },
  ];

  const burstOffConfig = {};
  const visible = listQueueJobsForProject(sharedJobs, burstOffConfig);
  assert.equal(cloudJobCount(sharedJobs, burstOffConfig), 0);
  assert.ok(visible.every(job => !job.tags?.includes(BURST_LANE_TAG)));

  const burstOnConfig = { burst: 'on' };
  assert.equal(cloudJobCount(sharedJobs, burstOnConfig), 2);
  assert.equal(listQueueJobsForProject(sharedJobs, burstOnConfig).length, 3);
});
