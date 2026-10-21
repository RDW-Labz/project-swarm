// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectId } from '../tools/projects.mjs';
import { projectOverview } from '../tools/board-data.mjs';
import { createLedger, writeLedger } from '../tools/tickets.mjs';

const NOW = Date.UTC(2026, 9, 18, 15, 0, 0);
const iso = ms => new Date(ms).toISOString();
const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-idle-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};
const tk = (id, stage, status, extra = {}) => ({
  id, title: `Ticket ${id}`, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'],
  files: [`src/${id}.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false,
  status, stage, ...extra,
});

async function fixtureProject(t, { tickets = [], liveRuns = [] }) {
  const home = await tmp(t);
  const name = 'idle-ready-fixture';
  const root = path.join(home, name);
  await fs.mkdir(root, { recursive: true });
  if (tickets.length) {
    await writeLedger(root, createLedger({ scope: { name, version: 1, hash: 'a'.repeat(64) }, tickets }));
  }
  const project = { id: projectId(root), name, root, addedAt: iso(NOW), lastSeen: iso(NOW) };
  const summary = async () => ({ spendUsd: 0, capUsd: null });
  const overview = await projectOverview(project, liveRuns, { now: NOW, summary });
  return overview;
}

test('idle with ready tickets sets idleWithReady and readyTickets', async t => {
  const overview = await fixtureProject(t, {
    tickets: [
      tk('T-0001', 'S1', 'ready'),
      tk('T-0002', 'S1', 'ready'),
      tk('T-0003', 'S1', 'ready'),
      tk('T-0004', 'S1', 'todo'),
    ],
  });
  assert.equal(overview.readyTickets, 3);
  assert.equal(overview.idleWithReady, true);
  assert.equal(overview.idle, true);
});

test('a live run clears idleWithReady', async t => {
  const home = await tmp(t);
  const name = 'live-run-fixture';
  const root = path.join(home, name);
  await fs.mkdir(path.join(root, '.swarm/runs/run-live'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/run-live/state.json'), JSON.stringify({
    status: 'running', startedAt: iso(NOW), jobs: [{ id: 'j-1', agent: 'codex', status: 'running' }],
  }));
  await writeLedger(root, createLedger({
    scope: { name, version: 1, hash: 'a'.repeat(64) },
    tickets: [tk('T-0001', 'S1', 'ready'), tk('T-0002', 'S1', 'ready')],
  }));
  const project = { id: projectId(root), name, root, addedAt: iso(NOW), lastSeen: iso(NOW) };
  const overview = await projectOverview(project, [{ runId: 'run-live', root, startedAt: iso(NOW) }], {
    now: NOW,
    summary: async () => ({ spendUsd: 0, capUsd: null }),
  });
  assert.equal(overview.readyTickets, 2);
  assert.equal(overview.idleWithReady, false);
  assert.equal(overview.idle, false);
});

test('zero ready tickets gives idleWithReady false', async t => {
  const overview = await fixtureProject(t, {
    tickets: [tk('T-0001', 'S1', 'todo'), tk('T-0002', 'S1', 'running')],
  });
  assert.equal(overview.readyTickets, 0);
  assert.equal(overview.idleWithReady, false);
});

test('board.js shows idle-with-ready badge text and danger pill class', async () => {
  const boardJs = await fs.readFile(fileURLToPath(new URL('../tools/watch-assets/board.js', import.meta.url)), 'utf8');
  assert.match(boardJs, /Idle with '\s*\+\s*p\.readyTickets\s*\+\s*'\s+ready tickets/);
  assert.match(boardJs, /idleWithReady/);
  assert.match(boardJs, /'bad'/);
});
