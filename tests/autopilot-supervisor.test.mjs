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
import {
  autopilotOffPath,
  computeIdleWithReady,
  createAutopilotSupervisor,
  runAutopilotPrefCommand,
  setAutopilotOff,
  shouldSuperviseProject,
  superviseProjectLoop,
} from '../tools/autopilot-supervisor.mjs';
import { createLedger, writeLedger, ticketSetHash } from '../tools/tickets.mjs';
import { projectId } from '../tools/projects.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ap-sup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

const tk = (id, status) => ({
  id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'],
  files: [`src/${id}.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false,
  status, stage: 'S1',
});

async function approvedLedger(root, tickets) {
  const ledger = createLedger({ scope: { name: 'p', version: 1, hash: 'a'.repeat(64) }, tickets });
  ledger.approved = {
    at: new Date().toISOString(),
    by: 'owner',
    scopeHash: ledger.scope.hash,
    ticketsHash: ticketSetHash(ledger.tickets),
  };
  await writeLedger(root, ledger);
  return ledger;
}

test('computeIdleWithReady requires ready tickets, no live run, and free slots when max is known', () => {
  assert.equal(computeIdleWithReady({ liveRunCount: 0, readyTickets: 2, freeMachineSlots: 1 }), true);
  assert.equal(computeIdleWithReady({ liveRunCount: 1, readyTickets: 2, freeMachineSlots: 1 }), false);
  assert.equal(computeIdleWithReady({ liveRunCount: 0, readyTickets: 0, freeMachineSlots: 1 }), false);
  assert.equal(computeIdleWithReady({ liveRunCount: 0, readyTickets: 2, freeMachineSlots: 0 }), false);
  assert.equal(computeIdleWithReady({ liveRunCount: 0, readyTickets: 2, freeMachineSlots: null }), true);
});

test('shouldSuperviseProject skips scratch, off, unapproved, and empty ledgers', async t => {
  const root = await tmp(t);
  const project = { id: projectId(root), root, name: 'p' };
  const approved = await approvedLedger(root, [tk('T-0001', 'ready')]);
  const readApproved = async () => approved;
  assert.equal(await shouldSuperviseProject(project, {
    isScratchRootFn: () => true,
    readLedgerFn: readApproved,
  }), false);
  assert.equal(await shouldSuperviseProject(project, {
    isScratchRootFn: () => false,
    isOffFn: async () => true,
    readLedgerFn: readApproved,
  }), false);
  const bare = await tmp(t);
  const bareProject = { id: projectId(bare), root: bare, name: 'bare' };
  assert.equal(await shouldSuperviseProject(bareProject, {
    isScratchRootFn: () => false,
    readLedgerFn: async () => null,
  }), false);
  assert.equal(await shouldSuperviseProject(project, {
    isScratchRootFn: () => false,
    isOffFn: async () => false,
    readLedgerFn: readApproved,
  }), true);
  const unapproved = { ...approved, approved: null };
  assert.equal(await shouldSuperviseProject(project, {
    isScratchRootFn: () => false,
    readLedgerFn: async () => unapproved,
  }), false);
});

test('supervisor reconcile starts a loop per eligible project only', async () => {
  const roots = {
    a: '/proj/a',
    b: '/proj/b',
    scratch: '/scratch/x',
    off: '/proj/off',
  };
  const started = [];
  const supervisor = createAutopilotSupervisor({
    listProjectsFn: async () => [
      { root: roots.a, id: 'a' },
      { root: roots.b, id: 'b' },
      { root: roots.scratch, id: 's' },
      { root: roots.off, id: 'o' },
    ],
    shouldSupervise: async project => project.root === roots.a || project.root === roots.b,
    superviseLoop: async (root, deps, { signal }) => {
      started.push(root);
      await new Promise(resolve => {
        signal.addEventListener('abort', resolve, { once: true });
      });
    },
  });
  await supervisor.reconcile();
  assert.deepEqual([...started].sort(), [roots.a, roots.b].sort());
  assert.equal(supervisor.loops().size, 2);
  await supervisor.stop();
  assert.equal(supervisor.loops().size, 0);
});

test('lock contention backs off before retrying', async () => {
  const sleeps = [];
  let attempts = 0;
  const controller = new AbortController();
  const root = '/fake/root';
  const promise = superviseProjectLoop(root, {
    lockBackoffMs: 100,
    intervalMs: 100,
    sleep: async ms => { sleeps.push(ms); },
    acquireAutopilotLock: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('busy'), { code: 'autopilot-running' });
      return async () => {};
    },
    runAutopilot: async () => { controller.abort(); },
    autopilotDeps: () => ({}),
  }, { signal: controller.signal });
  await promise.catch(() => {});
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps.slice(0, 1), [100]);
});

test('autopilot off and on toggles the marker file', async t => {
  const root = await tmp(t);
  await setAutopilotOff(root, true);
  await fs.access(autopilotOffPath(root));
  const off = await runAutopilotPrefCommand(root, ['off']);
  assert.match(off.stdout, /autopilot: off/);
  const on = await runAutopilotPrefCommand(root, ['on']);
  assert.match(on.stdout, /autopilot: on/);
  await assert.rejects(fs.access(autopilotOffPath(root)));
});

test('swarm autopilot status reports on', async t => {
  const root = await tmp(t);
  await exec('git', ['init', '-q', root]);
  const env = { ...process.env, HOME: root };
  const { stdout } = await exec(process.execPath, [swarm, '--root', root, 'autopilot', 'status'], { env });
  assert.match(stdout, /autopilot: on/);
});
