// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeSelfFile, parseNodeId, getNodeId } from '../tools/node-identity.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let importNonce = 0;
async function loadNodeIdentityFresh() {
  importNonce += 1;
  return import(`../tools/node-identity.mjs?fresh=${importNonce}`);
}

test('first use generates a node id and writes ~/.project-swarm/nodes/self', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'node-id-home-'));
  const env = { HOME: home };
  const file = nodeSelfFile(env, home);
  await fs.rm(file, { force: true });
  await fs.rm(path.dirname(file), { recursive: true, force: true });

  const id = await getNodeId({ env, home });
  assert.match(id, UUID_RE);
  assert.equal(await fs.readFile(file, 'utf8'), `${id}\n`);
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const dirStat = await fs.stat(path.dirname(file));
  assert.equal(dirStat.mode & 0o777, 0o700);
});

test('getNodeId is idempotent across repeated calls', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'node-id-idem-'));
  const env = { HOME: home };
  const a = await getNodeId({ env, home });
  const b = await getNodeId({ env, home });
  const c = await getNodeId({ env, home });
  assert.equal(a, b);
  assert.equal(b, c);
});

test('node id persists across a simulated fresh process', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'node-id-persist-'));
  const env = { HOME: home };
  const first = await getNodeId({ env, home });
  const mod = await loadNodeIdentityFresh();
  const second = await mod.getNodeId({ env, home });
  assert.equal(second, first);
  assert.equal(parseNodeId(await fs.readFile(nodeSelfFile(env, home), 'utf8')), first);
});
