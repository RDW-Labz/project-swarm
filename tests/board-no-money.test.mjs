// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBoardApi, stripMoney } from '../tools/watch-cli.mjs';
import { checkProjectCap } from '../tools/project-spend.mjs';
import { projectId } from '../tools/projects.mjs';

const MONEY_KEY = /usd|Usd|USD|cost|Cost|billed|Billed|listValue|flatRate|price|Price|spend|Spend|budget|Budget/;

function assertNoMoney(value, at = '$') {
  if (Array.isArray(value)) return value.forEach((item, i) => assertNoMoney(item, `${at}[${i}]`));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') assert.doesNotMatch(value, /\$\d/, at);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, MONEY_KEY, `${at}.${key}`);
    assert.notEqual(key, 'cap', `${at}.${key}`);
    assert.notEqual(key, 'caps', `${at}.${key}`);
    assertNoMoney(child, `${at}.${key}`);
  }
}

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-no-money-')));
  const root = path.join(home, 'parts-request-app');
  await fs.mkdir(path.join(root, '.swarm/runs/run-paid'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/run-paid/state.json'), JSON.stringify({
    id: 'run-paid', status: 'running', startedAt: '2026-10-21T12:00:00.000Z',
    jobs: [{ id: 'T-1', agent: 'anthropic', model: 'claude', status: 'complete', costUsd: 2.5, usage: { total_tokens: 100 } }],
  }));
  await fs.mkdir(path.join(home, 'spend'), { recursive: true });
  await fs.writeFile(path.join(home, 'spend/daily.json'), JSON.stringify({ version: 1, entries: {
    paid: { day: '2026-10-21', lane: 'anthropic', kind: 'actual', usd: 2.5, tokens: 100 },
  } }));
  const project = { id: projectId(root), name: 'parts-request-app', root, addedAt: '2026-10-21T12:00:00.000Z', lastSeen: '2026-10-21T12:00:00.000Z' };
  const env = {
    ...process.env,
    SWARM_PROJECTS_FILE: path.join(home, 'projects.json'),
    SWARM_HISTORY_FILE: path.join(home, 'history.ndjson'),
    SWARM_CONFIG: path.join(home, 'config.json'),
    SWARM_LANES_DIR: path.join(home, 'lanes'),
    SWARM_SPEND_DIR: path.join(home, 'spend'),
  };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [project] }));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, root, project, env };
}

test('watch board, project and live responses contain no money-shaped keys or dollar figures', async t => {
  const fx = await fixture(t);
  const api = createBoardApi({
    env: fx.env,
    now: () => Date.parse('2026-10-21T12:00:00.000Z'),
    live: async () => [{ runId: 'run-paid', root: fx.root, startedAt: '2026-10-21T12:00:00.000Z' }],
    cacheMs: 0,
  });
  t.after(() => api.close());
  for (const [name, response] of [
    ['board', await api.snapshot({ scratch: true, t: 'test-token' })],
    ['project', await api.project(fx.project.id)],
    ['live', await api.live(fx.project.id)],
  ]) {
    assert.ok(response, `${name} response exists`);
    assertNoMoney(response, name);
  }
});

test('stripMoney deep-copies and removes money objects while preserving non-money text', () => {
  const input = { ok: 1, capBasis: 'billed+list', spend: { usd: 3 }, cost: { total: 3 }, cap: { maxUsd: 4 }, nested: [{ price: 2, label: 'jobs' }] };
  const output = stripMoney(input);
  assert.deepEqual(output, { ok: 1, capBasis: 'billed+list', nested: [{ label: 'jobs' }] });
  assert.equal(input.spend.usd, 3, 'the response source is not mutated');
});

test('a project cap still refuses a new run after spend is recorded', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 1 } } }));
  const decision = await checkProjectCap(fx.root, { env: fx.env });
  assert.ok(decision, 'the cap refuses the run');
  assert.match(decision.message, /project-cap/);
});

test('watch assets never format money', async () => {
  for (const name of ['board.js', 'project.js', 'project-live.js']) {
    const source = await fs.readFile(new URL(`../tools/watch-assets/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Billed|List value|list value|usd\(|\$\d/, name);
  }
});
