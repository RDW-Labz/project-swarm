// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runQueueCommand } from '../tools/queue-commands.mjs';
import { claim } from '../tools/ledger-lease.mjs';
import { createLedger, readLedger, writeLedger } from '../tools/tickets.mjs';

const NODE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-queue-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

async function seed(root, { id = 'T-9001', status = 'ready' } = {}) {
  const ledger = createLedger({
    tickets: [{
      id,
      title: 'queue test',
      type: 'human',
      scopeRefs: [],
      size: 'S',
      risk: 'low',
      status,
      steps: ['work'],
    }],
  });
  await writeLedger(root, ledger);
  return id;
}

async function nodeEnv(root) {
  const selfFile = path.join(root, 'node-self');
  await fs.writeFile(selfFile, `${NODE_ID}\n`, { mode: 0o600 });
  return { SWARM_NODE_SELF_FILE: selfFile, HOME: root };
}

test('queue claim succeeds for a ready ticket', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  const res = await runQueueCommand(root, ['claim', id], { env: await nodeEnv(root), now: t0 });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /claimed T-9001/);
  assert.match(res.stdout, new RegExp(NODE_ID));
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'running');
});

test('queue claim rejected when lease is still active', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  await claim(root, id, 'other-holder', { now: t0, leaseTtlMs: 60_000 });
  const res = await runQueueCommand(root, ['claim', id], { env: await nodeEnv(root), now: t0 + 1000 });
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stdout, /claim rejected/);
});

test('queue release --expired sweeps expired leases back to ready', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const t0 = Date.now();
  const ttl = 5_000;
  await claim(root, id, 'node-a', { now: t0, leaseTtlMs: ttl });
  const res = await runQueueCommand(root, ['release', '--expired'], { env: await nodeEnv(root), now: t0 + ttl + 1 });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, new RegExp(id));
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'ready');
});

test('queue release --expired is a no-op when nothing is expired', async t => {
  const root = await tmp(t);
  await seed(root);
  const res = await runQueueCommand(root, ['release', '--expired'], { env: await nodeEnv(root), now: Date.now() });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /no expired leases/);
});
