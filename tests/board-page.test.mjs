// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { registerProject, listProjects, removeProject, projectId } from '../tools/projects.mjs';
import { appendHistory, readHistory, historyCsv } from '../tools/history.mjs';
import { laneLabel, costOf, readRunStates, boardSnapshot, projectDetail, projectOverview, historyEventsOf } from '../tools/board-data.mjs';
import { projectOrchestrator } from '../tools/board-orchestrator.mjs';
import { projectSpend } from '../tools/project-spend.mjs';
import { createBoardApi, makeRunServer } from '../tools/watch-cli.mjs';
import { createWatchServer } from '../tools/watch-server.mjs';
import { runBoardCommand, backfillHistory } from '../tools/board-commands.mjs';
import { recordRunHistory, recordShipHistory, recordHistory } from '../tools/history-hooks.mjs';
import { createLedger, writeLedger } from '../tools/tickets.mjs';

const execFileP = promisify(execFile);
const NOW = Date.UTC(2026, 9, 18, 15, 0, 0);
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));
const realAssets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

const job = (id, agent, model, usd, finishedMs, extra = {}) => ({ id, agent, model, status: 'complete', costUsd: usd, finishedAt: iso(finishedMs), usage: { total_tokens: 100 }, ...extra });
async function project(t, name, { runs = {}, tickets = null, home }) {
  const root = path.join(home, name);
  await fs.mkdir(root, { recursive: true });
  for (const [id, state] of Object.entries(runs)) {
    await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, ...state }));
  }
  if (tickets) await writeLedger(root, createLedger({ scope: { name: name, version: 1, hash: 'a'.repeat(64) }, tickets }));
  return { id: projectId(root), name, root, addedAt: iso(NOW - 30 * DAY), lastSeen: iso(NOW) };
}
const tk = (id, stage, status, extra = {}) => ({ id, title: `Ticket ${id}`, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${id}.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status, stage, ...extra });

async function twoProjects(t) {
  const home = await tmp(t);
  const A = await project(t, 'parts-request-app', { home,
    runs: {
      'run-a1': { status: 'running', startedAt: iso(NOW - 3600000), jobs: [job('a-1', 'anthropic', 'claude-haiku-5-5', 0.5, NOW - 1800000, { costSource: 'estimated-from-tokens' }), job('a-2', 'anthropic', 'claude-sonnet-5-5', 1.25, NOW - 600000), { id: 'a-3', agent: 'codex', model: 'gpt-5.5', status: 'running' }, { id: 'a-4', agent: 'anthropic', model: 'claude-haiku-5-5', status: 'running' }, { id: 'a-5', agent: 'rented', model: 'qwen', status: 'queued' }, { id: 'a-6', agent: 'cursor', status: 'blocked' }] },
      'run-old': { status: 'complete', startedAt: iso(NOW - 20 * DAY), finishedAt: iso(NOW - 20 * DAY), jobs: [job('o-1', 'anthropic', 'claude-haiku-5-5', 2, NOW - 20 * DAY), job('o-2', 'claude', 'opus', 0.6, NOW - 20 * DAY)], rental: { usd: 3 } },
      'run-wk': { status: 'complete', startedAt: iso(NOW - 3 * DAY), finishedAt: iso(NOW - 3 * DAY), jobs: [job('w-1', 'openrouter', 'x', 0.25, NOW - 3 * DAY)] },
    },
    tickets: [tk('T-0001', 'S1', 'done'), tk('T-0002', 'S2', 'running'), tk('T-0003', 'S2', 'blocked'), tk('T-0004', 'S3', 'todo')] });
  // The other project reuses the SAME run id on purpose.
  const B = await project(t, 'project-swarm', { home,
    runs: { 'run-a1': { status: 'running', startedAt: iso(NOW - 600000), jobs: [job('b-1', 'anthropic', 'claude-haiku-5-5', 0.1, NOW - 60000), { id: 'b-2', agent: 'claude', model: 'opus', status: 'running' }] } },
    tickets: [tk('T-0001', 'S1', 'done'), tk('T-0002', 'S1', 'done')] });
  return { home, A, B };
}

test('projects: listed once per real path, skipped in scratch folders unless the file is chosen, removable without touching anything else', async t => {
  const home = await tmp(t);
  const file = path.join(home, 'projects.json');
  const root = path.join(home, 'app'); await fs.mkdir(root);
  assert.equal(await registerProject(root, { file, env: {} }), null, 'a temp folder is not a project by default');
  const first = await registerProject(root, { file, env: { SWARM_PROJECTS_FILE: file }, now: () => NOW });
  assert.equal(first.added, true);
  assert.equal(first.project.id, projectId(await fs.realpath(root)));
  assert.equal((await registerProject(root, { file, env: { SWARM_PROJECTS_FILE: file }, now: () => NOW + 1 })).added, false);
  assert.equal((await listProjects({ file })).length, 1);
  assert.equal(await registerProject(path.join(home, 'missing'), { file, env: { SWARM_PROJECTS_FILE: file } }), null);
  assert.equal(await removeProject(first.project.id, { file }), true);
  assert.deepEqual(await listProjects({ file }), []);
  await fs.stat(root);
});

test('history: append-only, deduped by key, newest first, filters, survives a restart, CSV is safe', async t => {
  const home = await tmp(t);
  const file = path.join(home, 'history', 'history.ndjson');
  const ev = (kind, at, extra = {}) => ({ project: 'parts-request-app', projectId: 'p1', kind, at, title: `${kind} thing`, ...extra });
  assert.deepEqual(await appendHistory([ev('run', iso(NOW - 2 * DAY), { key: 'run:1', run: 'r1', title: 'Run r1 done' }), ev('merge', iso(NOW - DAY), { key: 'merge:5', ref: '#5', url: 'https://github.com/o/r/pull/5' }), { kind: 'bogus' }], { file }), { added: 2 });
  const sizeBefore = (await fs.stat(file)).size, head = (await fs.readFile(file, 'utf8'));
  assert.deepEqual(await appendHistory([ev('run', iso(NOW), { key: 'run:1' })], { file }), { added: 0 }, 'the same key is never added twice');
  await appendHistory([ev('lesson', iso(NOW), { key: 'lesson:L1', project: 'project-swarm', projectId: 'p2', title: '=HYPERLINK("http://evil","x")' })], { file });
  assert.ok((await fs.readFile(file, 'utf8')).startsWith(head), 'earlier lines are never rewritten');
  assert.ok((await fs.stat(file)).size > sizeBefore);
  // "Restart": a different process reads the same file.
  const read = await execFileP(process.execPath, ['--input-type=module', '-e', `import {readHistory} from ${JSON.stringify(new URL('../tools/history.mjs', import.meta.url).href)}; const r = await readHistory({file:${JSON.stringify(file)}}); console.log(JSON.stringify(r.events.map(e=>e.kind)));`]);
  assert.deepEqual(JSON.parse(read.stdout), ['lesson', 'merge', 'run'], 'newest first, and still there');
  assert.equal((await readHistory({ file, project: 'project-swarm' })).total, 1);
  assert.equal((await readHistory({ file, project: 'p1', kind: 'merge' })).total, 1);
  assert.equal((await readHistory({ file, q: 'r1 done' })).total, 1);
  assert.equal((await readHistory({ file, from: iso(NOW - DAY - 1000).slice(0, 10), to: iso(NOW - DAY).slice(0, 10) })).total, 1);
  assert.equal((await readHistory({ file, q: 'nothing like this' })).total, 0);
  await fs.appendFile(file, 'not json\n{"kind":"nope"}\n');
  assert.equal((await readHistory({ file })).total, 3, 'garbage lines are skipped, not fatal');
  const csv = historyCsv((await readHistory({ file })).events);
  assert.match(csv.split('\n')[0], /^at,project,kind,title,ref,run,usd,url$/);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/, 'a formula is neutralised and quotes are escaped');
  assert.match(csv, /https:\/\/github\.com\/o\/r\/pull\/5/);
  assert.equal((await appendHistory([ev('pr', iso(NOW), { url: 'javascript:alert(1)' })], { file })).added, 1);
  assert.equal((await readHistory({ file, kind: 'pr' })).events[0].url, null, 'only an https address is kept as a link');
});

test('worker labels and the live agent count: only runs that are really alive, by lane and by project', async t => {
  assert.deepEqual(['anthropic claude-haiku-5-5', 'anthropic claude-sonnet-5-5', 'claude opus', 'codex x', 'cursor x', 'rented q', 'ollama q', 'lambda q'].map(s => laneLabel(...s.split(' '))), ['Haiku', 'Sonnet', 'Opus', 'Codex', 'Cursor', 'GPU', 'GPU', 'GPU']);
  const { A, B } = await twoProjects(t);
  const live = [{ runId: 'run-a1', root: A.root, startedAt: iso(NOW - 3600000) }, { runId: 'run-a1', root: B.root, startedAt: iso(NOW - 600000) }];
  const snap = await boardSnapshot({ projects: [A, B], liveRuns: live, now: NOW, summary: async () => ({ spendUsd: 0, capUsd: null }) });
  const a = snap.projects.find(p => p.id === A.id), b = snap.projects.find(p => p.id === B.id);
  assert.deepEqual(a.agents.byLane, { Codex: 1, Haiku: 1 });
  assert.deepEqual(b.agents.byLane, { Opus: 1 });
  assert.deepEqual(a.agents.jobs, { running: 2, queued: 1, blocked: 1 });
  assert.equal(snap.machine.agents.total, 3);
  assert.deepEqual(snap.machine.agents.byLane, { Codex: 1, Haiku: 1, Opus: 1 });
  assert.deepEqual(snap.machine.agents.byProject, { [A.id]: 2, [B.id]: 1 });
  // A run that is not alive (a crashed run whose state says running) counts no workers.
  const stale = await boardSnapshot({ projects: [A], liveRuns: [], now: NOW, summary: async () => ({}) });
  assert.equal(stale.machine.agents.total, 0);
  assert.equal(stale.projects[0].idle, true);
});

test('cost: the machine totals are exactly the sums of the project totals, each project total is the number the cap uses, and estimated / flat-rate are marked', async t => {
  const { A, B } = await twoProjects(t);
  const snap = await boardSnapshot({ projects: [A, B], liveRuns: [], now: NOW, summary: async () => ({}) });
  for (const p of [A, B]) {
    const overview = snap.projects.find(x => x.id === p.id);
    assert.equal(overview.cost.allUsd, Math.round((await projectSpend(p.root)).usd * 1e6) / 1e6, `${p.name}: the board total is the project's own total`);
    assert.equal(overview.spend.usd, overview.cost.allUsd);
    assert.equal(snap.machine.cost.byProject[p.id].allUsd, overview.cost.allUsd);
  }
  const sum = key => Math.round(snap.projects.reduce((s, p) => s + p.cost[key], 0) * 1e6) / 1e6;
  for (const key of ['allUsd', 'todayUsd', 'weekUsd', 'flatRateTodayUsd', 'flatRateWeekUsd', 'paidUsd', 'paidEstimatedUsd', 'flatRateListUsd']) assert.equal(snap.machine.cost[key], sum(key), key);
  const a = snap.projects.find(p => p.id === A.id).cost;
  const r6 = x => Math.round(x * 1e6) / 1e6;
  assert.equal(a.allUsd, r6(0.5 + 1.25 + 2 + 0.6 + 3 + 0.25), 'jobs plus the rental');
  assert.equal(a.todayUsd, r6(0.5 + 1.25), 'only what finished today');
  assert.equal(a.weekUsd, r6(0.5 + 1.25 + 0.25), 'the last seven days');
  assert.equal(a.paidEstimatedUsd, 0.5, 'an estimate from tokens is marked as one');
  assert.equal(a.flatRateListUsd, 0.6, 'a Claude subscription job is a list value, not a bill');
  assert.equal(a.flatRateTodayUsd, 0, 'old flat-rate work is not today list value');
  assert.equal(a.flatRateWeekUsd, 0, 'old flat-rate work is not 7-day list value');
  assert.equal(a.paidUsd, r6(0.5 + 1.25 + 2 + 3 + 0.25), 'paid = billed per use, with the rented GPU');
  assert.equal(snap.machine.cost.allUsd, r6(a.allUsd + 0.1));
});

test('cost splits billed and flat-rate list value by day and cap basis is surfaced', async t => {
  const home = await tmp(t);
  const A = await project(t, 'cost-split', {
    home,
    runs: {
      today: { status: 'complete', finishedAt: iso(NOW - 1000), jobs: [job('billed', 'openrouter', 'x', 2, NOW - 1000), job('flat-today', 'claude', 'opus', 3, NOW - 2000)] },
      old: { status: 'complete', finishedAt: iso(NOW - 3 * DAY), jobs: [job('flat-old', 'codex', 'gpt-5.5', 4, NOW - 3 * DAY)] },
    },
  });
  const B = await project(t, 'cost-split-empty', { home });
  const runs = await readRunStates(A.root);
  const cost = costOf(runs, NOW);
  assert.deepEqual([cost.todayUsd, cost.weekUsd, cost.flatRateTodayUsd, cost.flatRateWeekUsd, cost.allUsd, cost.paidUsd, cost.flatRateListUsd], [2, 2, 3, 7, 9, 2, 7]);

  const defaultSummary = async () => ({ spendUsd: 9, capUsd: 10 });
  const overview = await projectOverview(A, [], { now: NOW, summary: defaultSummary });
  assert.equal(overview.spend.billedUsd, 2);
  assert.equal(overview.spend.listUsd, 7);
  assert.equal(overview.spend.capBasis, 'billed+list');
  assert.equal(overview.spend.capUsedUsd, 9);
  const injectedSummary = async () => ({ spendUsd: 9, listUsd: 9, billedUsd: 2, capUsd: 5 });
  const injected = await projectOverview(A, [], { now: NOW, summary: injectedSummary });
  assert.equal(injected.spend.capBasis, 'billed');
  assert.equal(injected.spend.capUsedUsd, 2);
  assert.equal(injected.spend.familyUsd, 9);
  assert.equal(injected.spend.familyBilledUsd, 2);

  const detail = await projectDetail(A, { now: NOW, summary: injectedSummary });
  assert.equal(detail.spend.billedUsd, 2);
  assert.equal(detail.spend.listUsd, 7);
  assert.equal(detail.spend.capBasis, 'billed');

  const snap = await boardSnapshot({ projects: [A, B], liveRuns: [], now: NOW, summary: async () => ({}) });
  for (const key of ['flatRateTodayUsd', 'flatRateWeekUsd', 'paidUsd', 'flatRateListUsd']) {
    assert.equal(snap.machine.cost[key], snap.projects.reduce((sum, p) => sum + p.cost[key], 0), key);
  }
});

test('project panels expose split quality and benchmark scorecards', async t => {
  const { A } = await twoProjects(t);
  const empty = await projectDetail(A, { now: NOW });
  assert.equal(empty.splitQuality.metrics.length, 7);
  assert.equal(empty.benchmarks.files, 0);

  const directory = path.join(A.root, 'evals/scorecard');
  await fs.mkdir(directory, { recursive: true });
  const scorecard = (week, generatedAt, value, extra = {}) => ({
    week,
    generatedAt,
    projects: [{ project: A.name, metrics: [{ name: 'billed_usd', value, status: 'measured', grade: 'green', trend: 'flat', previous: null, ...extra }] }],
    overall: { green: 1, amber: 0, red: 0, unknown: 0 },
    headline: '1 green, 0 amber, 0 red',
  });
  await fs.writeFile(path.join(directory, 'previous.json'), JSON.stringify(scorecard('2026-W41', '2026-10-11T15:00:00Z', 10)));
  await fs.writeFile(path.join(directory, 'latest.json'), JSON.stringify(scorecard('2026-W42', '2026-10-18T15:00:00Z', 8, { trend: 'down', previous: 10 })));
  const detail = await projectDetail(A, { now: NOW });
  assert.equal(detail.benchmarks.files, 2);
  assert.equal(detail.benchmarks.projects[0].metrics.find(metric => metric.name === 'billed_usd').verdict, 'better');

  const overview = await projectOverview(A, [], { now: NOW });
  assert.ok(overview.split && 'grade' in overview.split);
});

test('board snapshots tag local cards, merge a local-view peer, keep tokens out, and expose stub pools', async t => {
  const home = await tmp(t);
  const A = await project(t, 'local-board-project', { home });
  const env = { SWARM_PROJECTS_FILE: path.join(home, 'projects.json'), SWARM_HISTORY_FILE: path.join(home, 'history.ndjson'), SWARM_CONFIG: path.join(home, 'missing-config.json'), SWARM_LANES_DIR: path.join(home, 'lanes'), SWARM_SPEND_DIR: path.join(home, 'spend') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [A] }));
  const peer = { name: 'mini', url: 'https://mini.ts.net', token: 'peer-token-123456' };
  const seen = {};
  const api = createBoardApi({
    env, now: () => NOW, live: async () => [], cacheMs: 0,
    listPeers: async () => [peer], versionInfo: async () => ({ version: '1.155.0' }),
    fetchImpl: async (url, init) => {
      seen.url = String(url); seen.headers = init.headers;
      return new Response(JSON.stringify({
        projects: [{ id: 'remote-project', name: 'remote-project', live: [], machine: 'mini' }],
        machine: { host: 'mini', orchestrator: { sessions: [] } }, server: { version: '1.154.0' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => api.close());
  const merged = await api.snapshot({ scratch: true });
  const local = merged.projects.find(p => p.id === A.id);
  const remote = merged.projects.find(p => p.id === 'remote-project');
  assert.deepEqual([local.machine, local.version, local.remote, merged.drift.drifted], [os.hostname(), '1.155.0', undefined, true]);
  assert.deepEqual([remote.remote, remote.machine, remote.version, remote.versionDrift], [true, 'mini', '1.154.0', true]);
  assert.match(seen.url, /[?&]local=1(?:&|$)/);
  assert.equal(new URL(seen.url).searchParams.has('t'), false);
  assert.equal(seen.headers['x-watch-token'], peer.token);
  assert.deepEqual(merged.peers, [{ name: peer.name, url: peer.url }]);
  assert.equal(JSON.stringify(merged.peers).includes(peer.token), false);
  assert.equal(merged.pools.source, 'stub');
  assert.ok(merged.pools.pools.some(pool => pool.id === 'machine'));

  const localOnly = await api.snapshot({ local: true, scratch: true });
  assert.equal(localOnly.projects.some(p => p.remote), false);
  assert.deepEqual(localOnly.peers, []);
  assert.equal(localOnly.drift.drifted, false);
});

test('the HTTP board local=1 skips peer discovery after token verification', async t => {
  const ctx = await twoProjects(t);
  let calls = 0;
  const board = await boardServer(t, ctx, {
    listPeers: async () => { calls += 1; throw new Error('peer discovery should be skipped'); },
    versionInfo: async () => ({ version: '1.155.0' }),
  });
  const data = JSON.parse((await get(board.port, '/api/board?local=1', { headers: { 'x-watch-token': board.token } })).body);
  assert.equal(calls, 0);
  assert.equal(data.projects.every(p => p.machine === os.hostname()), true);
  assert.deepEqual(data.peers, []);
});

test('project detail reports handled auto-decisions and orchestrator chat uses the full session id', async t => {
  const home = await tmp(t);
  const A = await project(t, 'handled-project', { home });
  await fs.mkdir(path.join(A.root, '.swarm/orchestrator'), { recursive: true });
  await fs.writeFile(path.join(A.root, '.swarm/orchestrator/events.ndjson'), `${JSON.stringify({ kind: 'auto-decision', at: iso(NOW - 1000), rule: 'safe-default', requestKind: 'ticket', requestId: 'T-1', reason: 'approved by policy' })}\n`);
  const detail = await projectDetail(A, { now: NOW });
  assert.equal(detail.handled.today, 1);
  assert.deepEqual(detail.handled.items[0], { at: iso(NOW - 1000), rule: 'safe-default', requestKind: 'ticket', requestId: 'T-1', reason: 'approved by policy', machine: '' });

  const fullId = 'session-full-id-1234567890';
  await fs.writeFile(path.join(A.root, '.swarm/orchestrator/events.ndjson'), `${JSON.stringify({ at: iso(NOW - 1000), s: fullId, e: 'prompt' })}\n`);
  const seen = [];
  const orchestrator = projectOrchestrator(A, { now: NOW, usage: () => null, chatUrl: id => { seen.push(id); return 'https://claude.ai/code/session_ABCDEFGHIJ'; } });
  assert.equal(seen[0], fullId);
  assert.equal(orchestrator.sessions[0].chatUrl, 'https://claude.ai/code/session_ABCDEFGHIJ');
});

test('stage, tickets, caps and last activity per project; a project is never mixed with another (same run id, same ticket ids)', async t => {
  const { A, B } = await twoProjects(t);
  const summaries = { [A.root]: { spendUsd: 7.6, capUsd: 10 }, [B.root]: { spendUsd: 0.1, capUsd: null } };
  const snap = await boardSnapshot({ projects: [A, B], liveRuns: [{ runId: 'run-a1', root: A.root }], now: NOW, summary: async root => summaries[root] });
  const a = snap.projects.find(p => p.id === A.id), b = snap.projects.find(p => p.id === B.id);
  assert.equal(a.stage, 'Stage 2');
  assert.deepEqual([a.tickets.open, a.tickets.blocked, a.tickets.total], [3, 1, 4]);
  assert.equal(b.stage, 'done');
  assert.equal(a.spend.capUsd, 10);
  assert.equal(a.spend.noCap, false);
  assert.equal(b.spend.noCap, true, 'no cap is said, never defaulted');
  assert.ok(a.lastActivityAt && b.lastActivityAt);
  assert.equal(a.idle, false);
  assert.equal(b.idle, true);
  const da = await projectDetail(A, { now: NOW }), db = await projectDetail(B, { now: NOW });
  assert.deepEqual(da.runs.map(r => r.runId).sort(), ['run-a1', 'run-old', 'run-wk']);
  assert.deepEqual(db.runs.map(r => r.runId), ['run-a1']);
  assert.equal(da.runs.find(r => r.runId === 'run-a1').jobs, 6);
  assert.equal(db.runs[0].jobs, 2, 'the same run id in the other project is a different run');
  assert.equal(da.tickets.length, 4);
  assert.equal(db.tickets.length, 2);
  assert.ok('progress' in da);
  assert.ok('progress' in db);
  assert.ok(!JSON.stringify(da).includes(B.root) && !JSON.stringify(db).includes(A.root), 'neither project\'s data names the other\'s folder');
  assert.equal(da.spend.byLane.Haiku, 2.5);
  assert.equal(db.spend.byLane.Haiku, 0.1);
});

test('the history of what is on disk can be backfilled, once: run, spend, stage and project events with keys', async t => {
  const { home, A, B } = await twoProjects(t);
  const env = { SWARM_PROJECTS_FILE: path.join(home, 'projects.json'), SWARM_HISTORY_FILE: path.join(home, 'h', 'history.ndjson') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [A, B] }));
  const first = await backfillHistory({ env });
  assert.ok(first >= 6, `${first} events`);
  assert.equal(await backfillHistory({ env }), 0, 'running it again adds nothing');
  const all = (await readHistory({ file: env.SWARM_HISTORY_FILE })).events;
  assert.ok(all.some(e => e.kind === 'stage' && e.project === 'project-swarm' && e.ref === 'S1'));
  assert.ok(all.some(e => e.kind === 'spend' && e.project === 'parts-request-app' && e.run === 'run-old' && e.usd === 5.6));
  assert.equal(all.filter(e => e.kind === 'run').length, 2, 'only finished runs are backfilled; a run still going writes its own entry when it ends');
  assert.ok(!all.some(e => e.run === 'run-a1'));
  const events = await historyEventsOf(A);
  assert.ok(events.every(e => e.projectId === A.id && e.project === 'parts-request-app'));
  // the commands
  const list = await runBoardCommand(home, 'projects', ['list'], { env });
  assert.match(list.stdout, /parts-request-app/);
  const csv = await runBoardCommand(home, 'history', ['--csv', '--kind', 'stage'], { env });
  assert.match(csv.stdout, /^at,project,kind/);
  assert.match(csv.stdout, /Stage S1 done/);
  assert.equal((await runBoardCommand(home, 'history', ['--bogus'], { env })).exitCode, 2);
});

test('hooks write the history of a run, a PR and a merge, and nothing in a scratch folder unless the file is chosen', async t => {
  const home = await tmp(t);
  const root = path.join(home, 'app'); await fs.mkdir(root);
  const state = { id: 'r-1', status: 'complete', finishedAt: iso(NOW), jobs: [job('j1', 'anthropic', 'claude-haiku-5-5', 0.4, NOW), job('j2', 'codex', 'x', 0, NOW)] };
  await recordRunHistory(root, state, { env: {} });
  const file = path.join(home, 'hist.ndjson');
  assert.deepEqual((await readHistory({ file })).events, [], 'nothing written for a temp folder without a chosen file');
  const env = { SWARM_HISTORY_FILE: file };
  await recordRunHistory(root, state, { env });
  await recordRunHistory(root, state, { env });
  await recordShipHistory(root, { status: 'merged', pr: 41, repo: 'o/app', url: 'https://github.com/o/app/pull/41', mergeSha: 'abcdef1234567890', runId: 'r-1' }, { env });
  await recordHistory(root, { kind: 'lesson', title: 'Lesson L-9', key: 'lesson:x:L-9' }, { env });
  const kinds = (await readHistory({ file })).events.map(e => e.kind).sort();
  assert.deepEqual(kinds, ['lesson', 'merge', 'pr', 'run', 'spend'], 'each once, even after a repeat');
  const merge = (await readHistory({ file, kind: 'merge' })).events[0];
  assert.match(merge.title, /Merged #41 on o\/app \(abcdef12\)/);
  assert.equal(merge.url, 'https://github.com/o/app/pull/41');
  const spend = (await readHistory({ file, kind: 'spend' })).events[0];
  assert.equal(spend.usd, 0.4);
});

// --- the server: links, auth, isolation --------------------------------------------------------------------------------------------------------------------

const get = (port, pathname, { method = 'GET', headers = {}, host } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { Host: host ?? `127.0.0.1:${port}`, ...headers } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
  });
  req.on('error', reject); req.end();
});

async function boardServer(t, { A, B, home }, apiOptions = {}) {
  const env = { SWARM_PROJECTS_FILE: path.join(home, 'projects.json'), SWARM_HISTORY_FILE: path.join(home, 'h.ndjson') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [A, B] }));
  await backfillHistory({ env });
  const api = createBoardApi({ env, now: () => NOW, live: async () => [{ runId: 'run-a1', root: A.root, startedAt: iso(NOW) }], cacheMs: 0, ...apiOptions });
  const server = createWatchServer({ root: home, assetDir: realAssets, deltaFile, idleMs: 600000, getRunSnapshot: async () => null, getPlanSnapshot: async () => ({ present: false }), getGallery: async () => ({ schema: 1, screens: [] }), getBoard: async () => ({ runs: [] }), board: api, indexName: 'board.html', commandList: [], contextCommands: () => [] });
  await server.listen();
  t.after(async () => { await server.close(); await api.close(); });
  return { server, api, port: Number(new URL(server.url).port), token: server.token };
}

test('the board: every data route needs the token, only GET, wrong host refused; links open the right project and run', async t => {
  const ctx = await twoProjects(t);
  const { server, api, port, token } = await boardServer(t, ctx);
  const { A, B } = ctx;
  for (const route of ['/api/board', `/api/project?id=${A.id}`, '/api/history', '/history.csv', `/open/run?id=${A.id}&run=run-a1`, `/project?id=${A.id}`, '/']) {
    assert.equal((await get(port, route)).status, 403, `${route} without a token`);
    assert.equal((await get(port, `${route}${route.includes('?') ? '&' : '?'}t=wrong`)).status, 403, `${route} with a wrong token`);
  }
  assert.equal((await get(port, '/api/board', { method: 'POST', headers: { 'x-watch-token': token } })).status, 405);
  assert.equal((await get(port, '/api/board', { host: 'evil.example:80', headers: { 'x-watch-token': token } })).status, 421);
  const page = await get(port, `/?t=${token}`);
  assert.match(page.body, /Every project on this machine/);
  const projectPage = await get(port, `/project?id=${A.id}&t=${token}`);
  assert.equal(projectPage.status, 200);
  assert.match(projectPage.body, /assets\/project\.js/);
  const data = JSON.parse((await get(port, '/api/board?scratch=1', { headers: { 'x-watch-token': token } })).body);
  assert.equal(data.projects.length, 2);
  assert.equal(data.machine.agents.total, 2);
  assert.equal((await get(port, `/api/project?id=${A.id}`, { headers: { 'x-watch-token': token } })).status, 200);
  assert.equal((await get(port, '/api/project?id=nope', { headers: { 'x-watch-token': token } })).status, 404);
  assert.equal((await get(port, `/api/project?id=${encodeURIComponent('../../etc')}`, { headers: { 'x-watch-token': token } })).status, 404, 'a project is named by id, never by a path');
  // The page builds its links without the token and with the ids: a click on a run row goes to /open/run.
  const js = (await get(port, '/assets/board.js')).body;
  assert.match(js, /\/open\/run\?id=/);
  assert.match(js, /\/project\?id=/);
  assert.doesNotMatch(js, /innerHTML|eval\(/);
  // Opening a run starts that run's own Watch page, with its own token, and reuses it.
  const open = await get(port, `/open/run?id=${A.id}&run=run-a1`, { headers: { 'x-watch-token': token } });
  assert.equal(open.status, 302);
  const target = new URL(open.headers.location);
  assert.equal(target.hostname, '127.0.0.1');
  assert.notEqual(Number(target.port), port, 'its own server');
  assert.notEqual(target.searchParams.get('t'), token, 'its own token');
  const snapshot = JSON.parse((await get(Number(target.port), '/api/snapshot', { headers: { 'x-watch-token': target.searchParams.get('t') } })).body);
  assert.equal(snapshot.run.runId, 'run-a1');
  assert.equal(snapshot.run.jobs.length, 6, 'it is project A\'s run-a1, not B\'s');
  assert.equal((await get(Number(target.port), '/api/snapshot')).status, 403, 'the run page keeps its own token protection');
  const again = await get(port, `/open/run?id=${A.id}&run=run-a1`, { headers: { 'x-watch-token': token } });
  assert.equal(again.headers.location, open.headers.location, 'reused, not started twice');
  assert.equal(api.watcherCount(), 1);
  const other = new URL((await get(port, `/open/run?id=${B.id}&run=run-a1`, { headers: { 'x-watch-token': token } })).headers.location);
  const otherSnap = JSON.parse((await get(Number(other.port), '/api/snapshot', { headers: { 'x-watch-token': other.searchParams.get('t') } })).body);
  assert.equal(otherSnap.run.jobs.length, 2, 'the same run id in project B opens B\'s run');
  assert.equal(api.watcherCount(), 2);
  assert.equal((await get(port, `/open/run?id=${A.id}&run=nope`, { headers: { 'x-watch-token': token } })).status, 404);
  assert.equal((await get(port, `/open/run?id=${A.id}&run=${encodeURIComponent('../x')}`, { headers: { 'x-watch-token': token } })).status, 404);
  assert.equal((await get(port, '/open/run?id=unknown&run=run-a1', { headers: { 'x-watch-token': token } })).status, 404);
  assert.equal((await get(port, `/open/run?id=${B.id}&run=run-old`, { headers: { 'x-watch-token': token } })).status, 404, 'a run of another project is not reachable through this one');
});

test('the board: history search, filters and CSV over HTTP, and history survives a restart of the server', async t => {
  const ctx = await twoProjects(t);
  const first = await boardServer(t, ctx);
  const all = JSON.parse((await get(first.port, '/api/history?scratch=1', { headers: { 'x-watch-token': first.token } })).body);
  assert.ok(all.total >= 6);
  const onlyB = JSON.parse((await get(first.port, `/api/history?scratch=1&project=${ctx.B.id}`, { headers: { 'x-watch-token': first.token } })).body);
  assert.ok(onlyB.events.length > 0 && onlyB.events.every(e => e.projectId === ctx.B.id), 'filtered by project');
  const stages = JSON.parse((await get(first.port, '/api/history?scratch=1&kind=stage', { headers: { 'x-watch-token': first.token } })).body);
  assert.ok(stages.events.every(e => e.kind === 'stage'));
  assert.equal(JSON.parse((await get(first.port, '/api/history?scratch=1&q=run-old', { headers: { 'x-watch-token': first.token } })).body).events.every(e => /run-old/.test(`${e.title} ${e.run}`)), true);
  const csv = await get(first.port, '/history.csv?scratch=1&kind=stage', { headers: { 'x-watch-token': first.token } });
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.headers['content-disposition'], /attachment/);
  assert.match(csv.body, /^at,project,kind,title,ref,run,url\n/);
  assert.match(csv.body, /Stage S1 done/);
  // restart: a new server over the same files shows the same history
  await first.server.close(); await first.api.close();
  const second = await boardServer(t, ctx);
  const again = JSON.parse((await get(second.port, '/api/history?scratch=1', { headers: { 'x-watch-token': second.token } })).body);
  assert.equal(again.total, all.total, 'nothing lost, nothing doubled by the restart');
});

test('the board server never reads outside the registered projects: an id it does not know opens nothing, and projects.json cannot be used to read other files', async t => {
  const ctx = await twoProjects(t);
  const { port, token } = await boardServer(t, ctx);
  const outside = path.join(ctx.home, 'outside'); await fs.mkdir(path.join(outside, '.swarm/runs/r9'), { recursive: true });
  await fs.writeFile(path.join(outside, '.swarm/runs/r9/state.json'), JSON.stringify({ id: 'r9', status: 'running', jobs: [] }));
  assert.equal((await get(port, `/open/run?id=${projectId(outside)}&run=r9`, { headers: { 'x-watch-token': token } })).status, 404);
  assert.equal((await get(port, `/api/project?id=${projectId(outside)}`, { headers: { 'x-watch-token': token } })).status, 404);
});

test('a swarm command in a folder lists it as a project (only when the file is chosen for a scratch folder); help and version do not; swarm projects add / remove', async t => {
  const home = await tmp(t);
  const root = path.join(home, 'app'); await fs.mkdir(root);
  const env = { ...process.env, SWARM_PROJECTS_FILE: path.join(home, 'projects.json'), SWARM_HISTORY_FILE: path.join(home, 'h.ndjson'), SWARM_CONFIG: path.join(home, 'none.json') };
  const run = (...args) => execFileP(process.execPath, ['tools/swarm.mjs', '--root', root, ...args], { env }).then(r => r.stdout, e => e.stdout ?? '');
  await run('--help');
  await run('version');
  assert.deepEqual(await listProjects({ file: env.SWARM_PROJECTS_FILE }), []);
  await run('tickets');
  const listed = await listProjects({ file: env.SWARM_PROJECTS_FILE });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'app');
  assert.match((await readHistory({ file: env.SWARM_HISTORY_FILE })).events[0].title, /Project app registered/);
  assert.match(await run('projects'), new RegExp(listed[0].id));
  assert.match(await run('projects', 'remove', listed[0].id), /removed/);
  assert.match(await run('projects', 'add', root), /added: app/);
});

test('a finished run writes its history by itself (run and spend), once', async t => {
  const { runManifest } = await import('../tools/swarm.mjs');
  const home = await tmp(t);
  const root = path.join(home, 'repo'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n'); await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  const exec = (...a) => execFileP('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e.i', ...a]);
  await execFileP('git', ['init', '-q', root]); await exec('add', '.'); await exec('commit', '-qm', 'i');
  await fs.writeFile(path.join(home, 'config.json'), '{}');
  const file = path.join(home, 'h.ndjson');
  const before = process.env.SWARM_HISTORY_FILE;
  process.env.SWARM_HISTORY_FILE = file;
  t.after(() => { if (before === undefined) delete process.env.SWARM_HISTORY_FILE; else process.env.SWARM_HISTORY_FILE = before; });
  const state = await runManifest(root, { version: 1, concurrency: 1, jobs: [{ id: 'j', agent: 'ollama', model: 'm', prompt: 'Write out/0.txt', context: ['input.txt'], outputs: ['out/0.txt'], timeoutMs: 5000 }] }, { root, env: { ...process.env, SWARM_CONFIG: path.join(home, 'config.json'), SWARM_SPEND_DIR: path.join(home, 'spend') }, liveDir: path.join(home, 'live'), fetchImpl: async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }, message: { content: JSON.stringify({ summary: 'done', files: [{ path: 'out/0.txt', content: 'x' }] }) } }), { headers: { 'content-type': 'application/json' } }) });
  assert.equal(state.status, 'complete');
  for (let i = 0; i < 50; i += 1) { if ((await readHistory({ file })).total) break; await new Promise(r => setTimeout(r, 50)); }
  const events = (await readHistory({ file })).events;
  assert.equal(events.filter(e => e.kind === 'run').length, 1);
  assert.match(events[0].title, new RegExp(`Run ${state.id}: complete, 1/1 jobs`));
});

test('review fixes: a damaged project list is never overwritten, one entry per folder with a matching id, scratch places are skipped', async t => {
  const home = await tmp(t);
  const file = path.join(home, 'projects.json');
  const env = { SWARM_PROJECTS_FILE: file };
  const root = path.join(home, 'app'); await fs.mkdir(root);
  const real = await fs.realpath(root);
  await fs.writeFile(file, '{ this is not json');
  await assert.rejects(registerProject(root, { file, env }), /projects-unreadable/);
  assert.equal(await fs.readFile(file, 'utf8'), '{ this is not json', 'the damaged file is left as it was');
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [{ id: 'wrong', root: real, name: 'a' }, { id: projectId(real), root: real, name: 'a' }, { id: projectId(real), root: real, name: 'dup' }, { id: 'x', root: 'relative/path', name: 'r' }] }));
  const list = await listProjects({ file });
  assert.deepEqual(list.map(p => p.name), ['a'], 'a wrong id, a duplicate and a relative path are dropped');
  for (const scratch of ['/tmp/some-project', '/private/tmp/some-project']) assert.equal(await registerProject(scratch, { file, env: {} }), null, scratch);
  const worker = path.join(home, 'app', '.swarm', 'workspaces', 'r1'); await fs.mkdir(worker, { recursive: true });
  assert.equal(await registerProject(worker, { file, env: {} }), null, 'a worker copy inside .swarm is not a project');
});

test('review fixes: history dedupes a key written twice by two processes, restarts a torn line, ignores hostile fields on read', async t => {
  const home = await tmp(t);
  const file = path.join(home, 'h.ndjson');
  const line = e => `${JSON.stringify(e)}\n`;
  const ev = (key, extra = {}) => ({ at: iso(NOW), project: 'p', projectId: 'pid', kind: 'spend', key, title: 'Spent', usd: 1, ...extra });
  await fs.writeFile(file, line(ev('spend:1')) + line(ev('spend:1')) + JSON.stringify(ev('torn')).slice(0, 20));
  const first = await readHistory({ file });
  assert.equal(first.total, 1, 'the same key twice counts once');
  await appendHistory([ev('after-torn')], { file });
  assert.equal((await readHistory({ file })).total, 2, 'the new event is not swallowed by the torn line');
  await fs.appendFile(file, line({ ...ev('hostile'), url: 'javascript:alert(1)', usd: 'lots', at: 'not a date', title: '\u001b[31mred\u001b[0m' }));
  const hostile = (await readHistory({ file })).events.find(e => e.key === 'hostile');
  assert.equal(hostile.url, null);
  assert.equal(hostile.usd, null);
  assert.doesNotMatch(hostile.title, /\u001b/);
  assert.ok(Number.isFinite(Date.parse(hostile.at)));
  const before = (await readHistory({ file })).total;
  await fs.appendFile(file, line(ev('late')));
  assert.equal((await readHistory({ file })).total, before + 1, 'a change to the file is seen (the parsed copy is re-read only when the file changed)');
});

test('review fixes: a live run through a symlinked folder still belongs to its project; a symlinked run folder is not read; windows count what is billed', async t => {
  const { A } = await twoProjects(t);
  const link = path.join(path.dirname(A.root), 'link-to-parts');
  await fs.symlink(A.root, link);
  const snap = await boardSnapshot({ projects: [A], liveRuns: [{ runId: 'run-a1', root: link }], now: NOW, summary: async () => ({}) });
  assert.equal(snap.projects[0].agents.total, 2, 'matched by the real folder');
  const outside = path.join(path.dirname(A.root), 'elsewhere'); await fs.mkdir(path.join(outside, 'x'), { recursive: true });
  await fs.writeFile(path.join(outside, 'x', 'state.json'), JSON.stringify({ id: 'sym', status: 'running', jobs: [{ id: 'z', agent: 'codex', status: 'running' }] }));
  await fs.symlink(path.join(outside, 'x'), path.join(A.root, '.swarm/runs/sym'));
  const detail = await projectDetail(A, { now: NOW });
  assert.ok(!detail.runs.some(r => r.runId === 'sym'), 'a run folder that is a link is skipped');
  // today and 7 days = billed lanes only (the Claude subscription job is a list value, never billed)
  const cost = costOf([{ id: 'r', state: { jobs: [job('f', 'claude', 'opus', 9, NOW - 1000), job('p', 'anthropic', 'claude-haiku-5-5', 1, NOW - 1000)] } }], NOW);
  assert.deepEqual([cost.todayUsd, cost.weekUsd, cost.allUsd, cost.flatRateListUsd], [1, 1, 10, 9]);
});

test('review fixes: two clicks on one run start one server, and no more than six stay open (the oldest is closed)', async t => {
  const ctx = await twoProjects(t);
  const env = { SWARM_PROJECTS_FILE: path.join(ctx.home, 'projects.json'), SWARM_HISTORY_FILE: path.join(ctx.home, 'h.ndjson') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [ctx.A, ctx.B] }));
  for (let n = 0; n < 8; n += 1) { await fs.mkdir(path.join(ctx.A.root, '.swarm/runs', `many-${n}`), { recursive: true }); await fs.writeFile(path.join(ctx.A.root, '.swarm/runs', `many-${n}`, 'state.json'), JSON.stringify({ id: `many-${n}`, status: 'complete', jobs: [] })); }
  const idles = [];
  const api = createBoardApi({ env, now: () => NOW, live: async () => [], runServer: (root, runId, extra) => { idles.push(extra?.idleMs); return makeRunServer(root, runId, extra); } });
  t.after(() => api.close());
  const [one, two] = await Promise.all([api.openRun(ctx.A.id, 'many-0'), api.openRun(ctx.A.id, 'many-0')]);
  assert.equal(one, two);
  assert.equal(idles.length, 1, 'one server for two simultaneous clicks');
  assert.ok(idles[0] <= 10 * 60 * 1000, 'a board-started server idles out sooner');
  for (let n = 1; n < 8; n += 1) await api.openRun(ctx.A.id, `many-${n}`);
  assert.equal(api.watcherCount(), 6);
});
