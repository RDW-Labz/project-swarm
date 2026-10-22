// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OPENCODE_SESSION_SQL,
  opencodeDbPath,
  opencodeSessionsForProject,
  queryOpencodeSessions,
  validateOrchestratorFields,
  runOrchestratorCommand,
  externalOrchestratorTokens,
  readRegisteredOrchestratorsSync,
} from '../tools/external-orchestrators.mjs';
import { projectOrchestrator } from '../tools/board-orchestrator.mjs';
import { projectId } from '../tools/projects.mjs';

const tmp = async t => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-extorch-'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

const NOW = Date.UTC(2026, 9, 22, 15, 0, 0);
const projectOf = root => ({ id: projectId(root), root, name: 'demo' });

test('opencode SQL selects only session columns and never secret tables', () => {
  const sql = OPENCODE_SESSION_SQL.toLowerCase();
  assert.match(sql, /from session/);
  assert.ok(!sql.includes('auth'), sql);
  assert.ok(!sql.includes('credential'), sql);
  assert.ok(!sql.includes('account'), sql);
  assert.ok(!sql.includes('message'), sql);
  assert.ok(!sql.includes(' part'), sql);
  assert.ok(!sql.includes('tool-output'), sql);
  for (const col of ['tokens_input', 'tokens_output', 'directory', 'cost', 'time_updated']) {
    assert.ok(sql.includes(col), col);
  }
});

test('opencodeDbPath honours SWARM_OPENCODE_DB and XDG_DATA_HOME', () => {
  const home = '/tmp/home';
  assert.equal(opencodeDbPath({ SWARM_OPENCODE_DB: '/custom/db' }, home), '/custom/db');
  assert.equal(
    opencodeDbPath({ XDG_DATA_HOME: '/xdg/data' }, home),
    path.join('/xdg/data', 'opencode', 'opencode.db'),
  );
});

test('opencode sessions map to board cards with working state and approximate tokens', () => {
  const root = '/proj/demo';
  const project = projectOf(root);
  const updated = NOW - 30_000;
  const created = Date.UTC(2026, 9, 21, 12, 0, 0);
  const rows = [{
    id: 'sess-full-id-123',
    directory: path.join(root, 'src'),
    cost: 0.42,
    tokens_input: 100,
    tokens_output: 50,
    tokens_reasoning: 10,
    tokens_cache_read: 5,
    model: 'gpt-5',
    time_created: created,
    time_updated: updated,
  }];
  const cards = opencodeSessionsForProject(project, rows, { now: NOW });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].tool, 'opencode');
  assert.equal(cards[0].state, 'working');
  assert.equal(cards[0].tokensToday, 160);
  assert.equal(cards[0].cacheReadToday, 5);
  assert.equal(cards[0].approximate, true);
  assert.equal(cards[0].costUsdReported, 0.42);
  assert.equal(cards[0].costSource, 'reported by opencode');
});

test('opencode directory must be inside project (symlink target counts)', async t => {
  const root = await tmp(t);
  const real = path.join(root, 'real-proj');
  await fs.mkdir(real, { recursive: true });
  const link = path.join(root, 'link-proj');
  await fs.symlink(real, link);
  const project = projectOf(real);
  const rows = [{
    id: 'a',
    directory: link,
    cost: 0,
    tokens_input: 1,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    time_created: NOW,
    time_updated: NOW,
  }];
  assert.equal(opencodeSessionsForProject(project, rows, { now: NOW }).length, 1);
  const outside = projectOf(path.join(root, 'other'));
  assert.equal(opencodeSessionsForProject(outside, rows, { now: NOW }).length, 0);
});

test('queryOpencodeSessions uses injected exec and filters by 24h', async t => {
  const db = path.join(await tmp(t), 'fake.db');
  await fs.writeFile(db, '');
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: JSON.stringify([
      { id: 'old', directory: '/p', time_updated: NOW - 25 * 60 * 60 * 1000, tokens_input: 1, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, cost: 0, time_created: NOW },
      { id: 'new', directory: '/p', time_updated: NOW - 1000, tokens_input: 2, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, cost: 0, time_created: NOW },
    ]) };
  };
  const rows = await queryOpencodeSessions({ execFileImpl, env: { SWARM_OPENCODE_DB: db }, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'new');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-readonly', '-json', db]);
  assert.equal(calls[0].args[3], OPENCODE_SESSION_SQL);
});

test('register, heartbeat, and list round trip', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  const reg = await runOrchestratorCommand(root, ['register', '--tool', 'codex', '--model', 'gpt-5', '--session', 'sess-abc'], { now: NOW });
  assert.equal(reg.exitCode, 0);
  const sessionId = reg.stdout.trim();
  assert.equal(sessionId, 'sess-abc');
  const hb = await runOrchestratorCommand(root, ['heartbeat', '--session', 'sess-abc', '--tokens', '900', '--cost-usd', '1.5', '--state', 'working'], { now: NOW + 1000 });
  assert.equal(hb.exitCode, 0);
  const list = await runOrchestratorCommand(root, ['list', '--json'], { now: NOW + 1000 });
  const entries = JSON.parse(list.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tokensToday, 900);
  assert.equal(entries[0].costUsd, 1.5);
  assert.equal(entries[0].state, 'working');
});

test('stale heartbeat shows idle; dropped after 24h', async t => {
  const root = await tmp(t);
  const dir = path.join(root, '.swarm', 'orchestrators');
  await fs.mkdir(dir, { recursive: true });
  const at = new Date(NOW).toISOString();
  const file = path.join(dir, 'codex-stale.json');
  await fs.writeFile(file, `${JSON.stringify({ tool: 'codex', model: 'm', sessionId: 'stale', startedAt: at, lastHeartbeat: at, tokensToday: 1, costUsd: 0 })}\n`);
  const idle = readRegisteredOrchestratorsSync(root, { now: NOW + 11 * 60 * 1000 });
  assert.equal(idle.length, 1);
  assert.equal(idle[0].state, 'idle');
  const gone = readRegisteredOrchestratorsSync(root, { now: NOW + 25 * 60 * 60 * 1000 });
  assert.equal(gone.length, 0);
  assert.equal(fsSync.existsSync(file), false);
});

test('validation rejects bad tool, model, and numbers', () => {
  assert.ok(validateOrchestratorFields({ tool: '../evil', model: 'ok' }).includes('tool'));
  assert.ok(validateOrchestratorFields({ tool: 'codex', model: '/path' }).includes('model'));
  assert.ok(validateOrchestratorFields({ tool: 'codex', model: 'm', tokensToday: -1 }).includes('tokensToday'));
  const badReg = runOrchestratorCommand('/tmp', ['register', '--tool', '', '--model', 'm']);
  return badReg.then(res => assert.equal(res.exitCode, 2));
});

test('externalOrchestratorTokens sums registered and opencode rows', async t => {
  const root = await tmp(t);
  const project = projectOf(root);
  const dir = path.join(root, '.swarm', 'orchestrators');
  await fs.mkdir(dir, { recursive: true });
  const at = new Date(NOW).toISOString();
  await fs.writeFile(path.join(dir, 'codex-t1.json'), `${JSON.stringify({ tool: 'codex', model: 'm', sessionId: 't1', startedAt: at, lastHeartbeat: at, tokensToday: 100, costUsd: 0 })}\n`);
  const opencodeRows = [{
    id: 'o1',
    directory: root,
    cost: 1,
    tokens_input: 40,
    tokens_output: 10,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    time_created: NOW,
    time_updated: NOW,
  }];
  const totals = externalOrchestratorTokens([project], { now: NOW, opencodeRows });
  assert.equal(totals.todayTokens, 150);
});

test('projectOrchestrator merges external sessions into totals', async t => {
  const root = await tmp(t);
  const project = projectOf(root);
  const external = [{
    id: 'codex01',
    project: 'demo',
    projectId: project.id,
    tool: 'codex',
    model: 'gpt-5',
    state: 'working',
    lastAt: new Date(NOW).toISOString(),
    since: new Date(NOW).toISOString(),
    tokensToday: 500,
    tokensAll: 500,
    costUsdReported: 2,
  }];
  const o = projectOrchestrator(project, { runs: [], now: NOW, externalSessions: external });
  assert.equal(o.sessions.length, 1);
  assert.equal(o.sessions[0].tool, 'codex');
  assert.equal(o.cost.todayTokens, 500);
  assert.equal(o.cost.todayCostUsdReported, 2);
});
