// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runQueueCommand } from '../tools/queue-commands.mjs';
import { readLeases } from '../tools/ledger-lease.mjs';
import { createLedger, readLedger, writeLedger } from '../tools/tickets.mjs';
import { BURST_LANE_TAG } from '../tools/burst-route.mjs';

const NODE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-burst-route-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

async function nodeEnv(root) {
  const selfFile = path.join(root, 'node-self');
  await fs.writeFile(selfFile, `${NODE_ID}\n`, { mode: 0o600 });
  return { SWARM_NODE_SELF_FILE: selfFile, HOME: root };
}

function humanTicket(id, { status = 'ready', tags, title = 'work' } = {}) {
  return {
    id,
    title,
    type: 'human',
    scopeRefs: [],
    size: 'S',
    risk: 'low',
    status,
    steps: ['step'],
    ...(tags ? { tags } : {}),
  };
}

async function seedLedger(root, tickets) {
  const ledger = createLedger({ tickets });
  await writeLedger(root, ledger);
}

function listRows(stdout) {
  return stdout
    .trimEnd()
    .split('\n')
    .filter(line => line.length > 0 && line !== '(empty)');
}

test('swarm queue list on burst-off project hides lane:burst rows', async t => {
  const root = await tmp(t);
  await seedLedger(root, [
    humanTicket('T-1001', { status: 'ready' }),
    humanTicket('T-1002', {
      status: 'running',
      tags: [BURST_LANE_TAG],
      title: 'other-project burst activity',
    }),
    humanTicket('T-1003', { status: 'done', tags: [BURST_LANE_TAG] }),
  ]);

  const res = await runQueueCommand(root, ['list'], {
    project: { burst: 'off' },
  });
  assert.equal(res.exitCode, 0);
  const rows = listRows(res.stdout);
  assert.deepEqual(rows, ['T-1001\tready']);
  assert.ok(!res.stdout.includes('lane:burst'));
});

test('swarm queue list on burst-on project includes lane:burst rows', async t => {
  const root = await tmp(t);
  await seedLedger(root, [
    humanTicket('T-2001', { status: 'ready' }),
    humanTicket('T-2002', { status: 'running', tags: [BURST_LANE_TAG] }),
  ]);

  const res = await runQueueCommand(root, ['list'], {
    project: { burst: 'on' },
  });
  assert.equal(res.exitCode, 0);
  const rows = listRows(res.stdout);
  assert.deepEqual(rows, [
    'T-2001\tready',
    'T-2002\trunning\tlane:burst',
  ]);
});

test('claim lane:burst on burst-on project with --runner routes to cloud runner', async t => {
  const root = await tmp(t);
  const id = 'T-3001';
  await seedLedger(root, [humanTicket(id, { tags: [BURST_LANE_TAG] })]);
  const t0 = Date.now();
  const runnerId = 'cloud-runner-1';
  const env = await nodeEnv(root);

  const res = await runQueueCommand(root, ['claim', id, '--runner', runnerId], {
    env,
    now: t0,
    project: { burst: 'on' },
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, new RegExp(`claimed ${id} for ${runnerId}`));
  assert.doesNotMatch(res.stdout, new RegExp(NODE_ID));

  const leases = await readLeases(root);
  assert.equal(leases.leases[id].holderId, runnerId);

  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'running');
});

test('claim non-burst ticket uses local lease holder', async t => {
  const root = await tmp(t);
  const id = 'T-3002';
  await seedLedger(root, [humanTicket(id)]);
  const t0 = Date.now();
  const env = await nodeEnv(root);

  const res = await runQueueCommand(root, ['claim', id], {
    env,
    now: t0,
    project: { burst: 'on' },
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, new RegExp(`claimed ${id} for ${NODE_ID}`));

  const leases = await readLeases(root);
  assert.equal(leases.leases[id].holderId, NODE_ID);
});

test('claim lane:burst on burst-off project uses local lease holder', async t => {
  const root = await tmp(t);
  const id = 'T-3003';
  await seedLedger(root, [humanTicket(id, { tags: [BURST_LANE_TAG] })]);
  const t0 = Date.now();
  const env = await nodeEnv(root);

  const res = await runQueueCommand(root, ['claim', id, '--runner', 'ignored-runner'], {
    env,
    now: t0,
    project: { burst: 'off' },
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, new RegExp(`claimed ${id} for ${NODE_ID}`));

  const leases = await readLeases(root);
  assert.equal(leases.leases[id].holderId, NODE_ID);
});
