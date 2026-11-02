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
  readRunners,
  validateRunnersStore,
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

test('heartbeat sweep boundary: 119s after last beat is fresh, 120s is stale', async t => {
  const root = await tmp(t);
  const ticket = await seed(root, { id: 'T-0414' });
  const t0 = Date.now();
  const runnerId = 'cloud-boundary';

  await registerRunner(root, runnerId, { now: t0 });
  await claimForRunner(root, ticket.id, runnerId, { now: t0, leaseTtlMs: 60_000 });
  const lastBeat = t0 + 10_000;
  await recordHeartbeat(root, runnerId, { now: lastBeat });

  const justBefore = await sweepStaleHeartbeats(root, {
    now: lastBeat + HEARTBEAT_TIMEOUT_MS - 1,
  });
  assert.deepEqual(justBefore.returned, []);

  const atThreshold = await sweepStaleHeartbeats(root, {
    now: lastBeat + HEARTBEAT_TIMEOUT_MS,
  });
  assert.deepEqual(atThreshold.returned, [ticket.id]);
});

test('runner re-registers with same runnerId after heartbeat sweep; single store entry, new claim', async t => {
  const root = await tmp(t);
  const ticket = await seed(root, { id: 'T-0415' });
  const t0 = Date.now();
  const runnerId = 'cloud-respawn';

  await registerRunner(root, runnerId, { now: t0 });
  const firstLease = await claimForRunner(root, ticket.id, runnerId, {
    now: t0,
    leaseTtlMs: 60_000,
  });
  const lastBeat = t0 + 5_000;
  await recordHeartbeat(root, runnerId, { now: lastBeat });
  const sweepAt = lastBeat + HEARTBEAT_TIMEOUT_MS + 1;
  await sweepStaleHeartbeats(root, { now: sweepAt });

  const reregAt = sweepAt + 1_000;
  await registerRunner(root, runnerId, { now: reregAt });
  const store = await readRunners(root);
  assert.equal(Object.keys(store.runners).length, 1);
  assert.ok(store.runners[runnerId]);

  const secondLease = await claimForRunner(root, ticket.id, runnerId, {
    now: reregAt + 100,
    leaseTtlMs: 60_000,
  });
  assert.equal(secondLease.holderId, runnerId);
  assert.ok(secondLease.fencingToken > firstLease.fencingToken);
});

test('concurrent heartbeats leave burst-runners.json valid with one runner record', async t => {
  const root = await tmp(t);
  const t0 = Date.now();
  const runnerId = 'cloud-concurrent';
  await registerRunner(root, runnerId, { now: t0 });

  const [a, b] = await Promise.all([
    recordHeartbeat(root, runnerId, { now: t0 + 100 }),
    recordHeartbeat(root, runnerId, { now: t0 + 200 }),
  ]);
  assert.ok(a.lastHeartbeatAt);
  assert.ok(b.lastHeartbeatAt);

  const store = await readRunners(root);
  validateRunnersStore(store);
  assert.equal(Object.keys(store.runners).length, 1);
  const beats = [a.lastHeartbeatAt, b.lastHeartbeatAt];
  assert.ok(beats.includes(store.runners[runnerId].lastHeartbeatAt));
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
