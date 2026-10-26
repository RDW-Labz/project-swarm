// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runQueueCommand, JOB_GRANTS_DIR } from '../tools/queue-commands.mjs';
import { claim } from '../tools/ledger-lease.mjs';
import { createLedger, writeLedger } from '../tools/tickets.mjs';
import { SWARM_JOB_GRANT_FILE, SWARM_JOB_ID, loadJobGrantSecrets } from '../tools/job-grants.mjs';

const NODE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const NEEDS = ['DATABASE_URL'];

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-queue-route-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

async function seed(root, { id = 'T-9001', status = 'ready' } = {}) {
  const ledger = createLedger({
    tickets: [{
      id,
      title: 'queue route test',
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
  return {
    SWARM_NODE_SELF_FILE: selfFile,
    HOME: root,
    DATABASE_URL: 'postgres://127.0.0.1:5432/route-test',
  };
}

async function writeIsolatedProject(root, { isolated = true } = {}) {
  await fs.writeFile(
    path.join(root, '.project-swarm.json'),
    `${JSON.stringify({
      version: 1,
      sandbox: {
        isolated,
        needs: NEEDS,
      },
    })}\n`,
    { mode: 0o644 },
  );
}

test('isolated project queue claim creates a per-job grant for the ticket id and reports env handles', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  await writeIsolatedProject(root);
  const env = await nodeEnv(root);
  const t0 = Date.now();
  let capturedGrant;
  const res = await runQueueCommand(root, ['claim', id], {
    env,
    now: t0,
    createJobGrant: async opts => {
      const { createJobGrant } = await import('../tools/job-grants.mjs');
      capturedGrant = await createJobGrant(opts);
      return capturedGrant;
    },
  });
  assert.equal(res.exitCode, 0);
  const legacyLine = `claimed ${id} for ${NODE_ID}\n`;
  assert.ok(res.stdout.startsWith(legacyLine));
  const grantFile = path.join(root, JOB_GRANTS_DIR, id, 'grant.env');
  assert.match(res.stdout, new RegExp(`${SWARM_JOB_ID}=${id}`));
  assert.match(res.stdout, new RegExp(`${SWARM_JOB_GRANT_FILE}=${grantFile.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(res.stdout.includes('SWARM_JOB_GRANT_KEY'), false);
  assert.equal(capturedGrant.jobId, id);
  await fs.access(grantFile);
  const secrets = await loadJobGrantSecrets(capturedGrant.containerEnv);
  assert.equal(secrets.DATABASE_URL, env.DATABASE_URL);
});

test('legacy project queue claim output is unchanged and creates no grant', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  const env = await nodeEnv(root);
  const t0 = Date.now();
  const res = await runQueueCommand(root, ['claim', id], { env, now: t0 });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, `claimed ${id} for ${NODE_ID}\n`);
  await assert.rejects(
    () => fs.access(path.join(root, JOB_GRANTS_DIR, id, 'grant.env')),
    /ENOENT/,
  );
});

test('failed queue claim on an isolated project does not create an orphaned grant', async t => {
  const root = await tmp(t);
  const id = await seed(root);
  await writeIsolatedProject(root);
  const env = await nodeEnv(root);
  const t0 = Date.now();
  await claim(root, id, 'other-holder', { now: t0, leaseTtlMs: 60_000 });
  let grantCalls = 0;
  const res = await runQueueCommand(root, ['claim', id], {
    env,
    now: t0 + 1000,
    createJobGrant: async (...args) => {
      grantCalls += 1;
      const { createJobGrant } = await import('../tools/job-grants.mjs');
      return createJobGrant(...args);
    },
  });
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stdout, /claim rejected/);
  assert.equal(grantCalls, 0);
  await assert.rejects(
    () => fs.access(path.join(root, JOB_GRANTS_DIR, id, 'grant.env')),
    /ENOENT/,
  );
});
