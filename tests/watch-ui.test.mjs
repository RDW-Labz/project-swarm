// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentState, agentsOf, laneUsage, costOf, WORKING_MS, ERROR_SHOWN_MS } from '../tools/board-data.mjs';
import { runDetail, compareRuns, layersOf } from '../tools/board-run.mjs';
import { createBoardApi } from '../tools/watch-cli.mjs';
import { createWatchServer } from '../tools/watch-server.mjs';
import { projectId } from '../tools/projects.mjs';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const iso = ms => new Date(ms).toISOString();
const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'watch-ui-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const read = f => fs.readFile(path.join(assets, f), 'utf8');
const lib = async () => { const box = { self: {} }; vm.runInNewContext(await read('board-lib.js'), box); return box.self.BoardLib; };
const plain = x => JSON.parse(JSON.stringify(x));

test('an agent\'s state comes from what its job recorded: output in the last 90 s is working, running without output is thinking, a fresh failure is error, nothing else is shown', () => {
  const run = (over = {}) => ({ status: 'running', progress: { lastOutputAt: iso(NOW - 10000) }, ...over });
  assert.equal(agentState(run(), NOW), 'working');
  assert.equal(agentState(run({ progress: { lastOutputAt: iso(NOW - WORKING_MS - 1000) } }), NOW), 'thinking', 'quiet for longer than 90 s');
  assert.equal(agentState(run({ progress: undefined }), NOW), 'thinking', 'started, no output yet');
  assert.equal(agentState(run({ progress: { lastOutputAt: 'garbage' } }), NOW), 'thinking');
  assert.equal(agentState({ status: 'failed', finishedAt: iso(NOW - 60000) }, NOW), 'error');
  assert.equal(agentState({ status: 'timeout', finishedAt: iso(NOW - 60000) }, NOW), 'error');
  assert.equal(agentState({ status: 'failed', finishedAt: iso(NOW - ERROR_SHOWN_MS - 1000) }, NOW), null, 'an old failure is not shown');
  assert.equal(agentState({ status: 'failed' }, NOW), null, 'no time recorded: not shown');
  for (const status of ['complete', 'queued', 'blocked', 'held', 'cancelled', undefined]) assert.equal(agentState({ status, finishedAt: iso(NOW) }, NOW), null, String(status));
  assert.equal(agentState(null, NOW), null);
});

test('agentsOf: one entry per running or just-failed agent of a LIVE run only; failed ones are listed but not counted as running; names are bounded', () => {
  const job = (id, status, extra = {}) => ({ id, agent: 'anthropic', model: 'claude-haiku-5-5', status, startedAt: iso(NOW - 5000), progress: { lastOutputAt: iso(NOW - 1000) }, ...extra });
  const runs = [
    { id: 'live1', state: { jobs: [job('a', 'running'), job('b', 'running', { progress: {} }), job('c', 'failed', { finishedAt: iso(NOW - 1000) }), job('d', 'queued'), job('e', 'complete')] } },
    { id: 'dead1', state: { jobs: [job('z', 'running')] } },
  ];
  const r = agentsOf(runs, new Set(['live1']), NOW);
  assert.deepEqual(r.list.map(a => [a.jobId, a.state]), [['a', 'working'], ['b', 'thinking'], ['c', 'error']]);
  assert.equal(r.total, 2);
  assert.deepEqual(plain(r.byLane), { Haiku: 2 });
  assert.equal(r.list[2].ended, iso(NOW - 1000));
  const many = agentsOf([{ id: 'l', state: { jobs: Array.from({ length: 500 }, (_, i) => job(`j${i}`, 'running')) } }], new Set(['l']), NOW);
  assert.equal(many.list.length, 200);
  assert.equal(many.total, 500, 'the count is the truth, the list is bounded');
});

test('costOf keeps what each lane did today (billed lanes: charged; flat-rate lanes: list value) so a lane\'s usage can be shown', () => {
  const j = (agent, usd, finished) => ({ id: agent + usd, agent, status: 'complete', costUsd: usd, usage: { total_tokens: 1 }, finishedAt: finished });
  const cost = costOf([{ state: { startedAt: iso(NOW - 100000), jobs: [j('anthropic', 2, iso(NOW - 1000)), j('codex', 5, iso(NOW - 2000)), j('codex', 7, iso(NOW - 3 * 86400000))] } }], NOW);
  assert.deepEqual(plain(cost.laneToday), { anthropic: 2, codex: 5 });
});

test('laneUsage: today per lane against its daily cap, the cap\'s reset at UTC midnight, and a rate-limit pause with the time it ends; only lanes with something to say; read-only', async t => {
  const dir = await tmp(t);
  await fs.mkdir(path.join(dir, 'spend'), { recursive: true }); await fs.mkdir(path.join(dir, 'lanes'), { recursive: true });
  const day = iso(NOW).slice(0, 10);
  await fs.writeFile(path.join(dir, 'spend/daily.json'), JSON.stringify({ version: 1, entries: { a: { day, lane: 'anthropic', usd: 3.5, tokens: 1 }, b: { day: '2026-10-18', lane: 'anthropic', usd: 99, tokens: 1 } } }));
  await fs.writeFile(path.join(dir, 'lanes/lanes.json'), JSON.stringify({ version: 1, slots: {}, pauses: { codex: { state: 'backoff', until: NOW + 600000 }, cursor: { state: 'paused', until: NOW - 1000 } } }));
  const before = await fs.readFile(path.join(dir, 'spend/daily.json'), 'utf8');
  const rows = await laneUsage({ laneToday: { codex: 4, claude: 1.25 }, spendDirectory: path.join(dir, 'spend'), lanesDirectory: path.join(dir, 'lanes'), caps: { anthropic: 20, openrouter: 5 }, now: NOW });
  const by = Object.fromEntries(rows.map(r => [r.lane, r]));
  assert.deepEqual([by.anthropic.todayUsd, by.anthropic.dailyCapUsd, by.anthropic.kind, by.anthropic.label], [3.5, 20, 'billed', 'Anthropic API'], 'yesterday is not today');
  assert.equal(by.anthropic.capResetsAt, '2026-10-20T00:00:00.000Z');
  assert.deepEqual([by.codex.todayUsd, by.codex.kind, by.codex.limited.state, by.codex.limited.until], [4, 'flat-rate', 'backoff', iso(NOW + 600000)]);
  assert.equal(by.cursor, undefined, 'a pause that already ended is not shown');
  assert.equal(by.claude.todayUsd, 1.25);
  assert.equal(by.openrouter.todayUsd, 0, 'a lane with a cap is listed even with no spend');
  assert.equal(await fs.readFile(path.join(dir, 'spend/daily.json'), 'utf8'), before);
  // every configured lane is listed, and a lane that ran jobs today is listed even when it reported no cost
  const all = Object.fromEntries((await laneUsage({ laneToday: {}, jobsToday: { codex: 11, cursor: 3 }, configured: ['codex', 'cursor', 'claude', 'anthropic'], spendDirectory: path.join(dir, 'none'), lanesDirectory: path.join(dir, 'none'), now: NOW })).map(r => [r.lane, r]));
  assert.deepEqual(Object.keys(all).sort(), ['anthropic', 'claude', 'codex', 'cursor']);
  assert.deepEqual([all.codex.jobsToday, all.codex.todayUsd, all.codex.kind, all.cursor.jobsToday, all.claude.jobsToday], [11, 0, 'flat-rate', 3, 0]);
  assert.deepEqual(await laneUsage({ spendDirectory: path.join(dir, 'none'), lanesDirectory: path.join(dir, 'none'), now: NOW }), [], 'no files, nothing to show');
});

async function runFixture(t) {
  const root = await tmp(t);
  const dir = path.join(root, '.swarm/runs/run-1');
  await fs.mkdir(dir, { recursive: true });
  const job = (id, status, o = {}) => ({ id, agent: 'claude', model: 'sonnet', status, queuedAt: iso(NOW - 9000), startedAt: iso(NOW - 8000), finishedAt: iso(NOW - 2000), durationMs: 6000, costUsd: 0.5, attempts: [{ agent: 'claude', model: 'sonnet', status }], ...o });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id: 'run-1', status: 'complete', startedAt: iso(NOW - 10000), finishedAt: iso(NOW), budget: { maxUsd: 5 }, jobs: [
    job('build', 'complete'), job('test', 'complete', { startedAt: iso(NOW - 6000), finishedAt: iso(NOW - 1000) }),
    job('docs', 'failed', { agent: 'codex', model: 'gpt', error: 'boom sk-ant-' + 'a'.repeat(30), attempts: [{ agent: 'codex', status: 'failed', error: 'first' }, { agent: 'claude', model: 'opus', status: 'failed' }] }),
    job('ship', 'complete', { startedAt: iso(NOW - 500), finishedAt: iso(NOW - 100) })] }));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, jobs: [{ id: 'build' }, { id: 'test', after: ['build'] }, { id: 'docs', after: ['build'] }, { id: 'ship', after: ['test', 'docs', 'ghost'] }] }));
  return { root, project: { id: projectId(root), name: 'p', root } };
}

test('run inspect: the graph layers come from what each job waited for, a job tried twice is flagged, the journal is in time order with each job\'s cost, secrets are redacted', async t => {
  const { project } = await runFixture(t);
  const r = await runDetail(project, 'run-1');
  const by = Object.fromEntries(r.jobs.map(j => [j.id, j]));
  assert.deepEqual([by.build.layer, by.test.layer, by.docs.layer, by.ship.layer], [0, 1, 1, 2]);
  assert.deepEqual(by.ship.after, ['test', 'docs', 'ghost']);
  assert.equal(r.layers, 3);
  assert.equal(r.hasGraph, true);
  assert.deepEqual([by.docs.rerun, by.build.rerun, by.docs.attempts.length], [true, false, 2]);
  assert.deepEqual(by.docs.attempts.map(a => a.lane), ['Codex', 'Opus']);
  assert.doesNotMatch(JSON.stringify(r), /sk-ant-a{10}/);
  assert.deepEqual(plain(r.totals), { jobs: 4, byStatus: { complete: 3, failed: 1 }, usd: 2, rerun: 1 });
  assert.equal(r.durationMs, 10000);
  const times = r.journal.map(e => e.at);
  assert.deepEqual(times, [...times].sort(), 'in time order');
  const ended = r.journal.filter(e => e.event !== 'queued' && e.event !== 'started');
  assert.deepEqual(ended.map(e => [e.job, e.event, e.usd]).sort(), [['build', 'finished', 0.5], ['docs', 'failed', 0.5], ['ship', 'finished', 0.5], ['test', 'finished', 0.5]]);
  assert.equal(r.journal.filter(e => e.event === 'queued').length, 4);
});

test('run inspect: no manifest means no edges (and it says so), a cycle or a missing dependency does not break the layers, and only a real run folder of the project is read', async t => {
  const { project, root } = await runFixture(t);
  await fs.rm(path.join(root, '.swarm/runs/run-1/manifest.json'));
  const r = await runDetail(project, 'run-1');
  assert.deepEqual([r.hasGraph, r.layers, r.jobs.every(j => j.after.length === 0)], [false, 1, true]);
  assert.deepEqual([...layersOf([{ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] }, { id: 'c', after: ['nope'] }]).entries()].map(([k]) => k).sort(), ['a', 'b', 'c']);
  for (const bad of ['../run-1', 'run-1/../run-1', '', 'x'.repeat(200), '.hidden', 'nope']) assert.equal(await runDetail(project, bad), null, bad);
  await fs.symlink(path.join(root, '.swarm/runs/run-1'), path.join(root, '.swarm/runs/linked'));
  assert.equal(await runDetail(project, 'linked'), null, 'a symlinked run folder is not followed');
  await fs.writeFile(path.join(root, '.swarm/runs/run-1/state.json'), '{ not json');
  assert.equal(await runDetail(project, 'run-1'), null);
});

test('compare: totals and lanes side by side, the job ids both runs share with a changed outcome, and what only one run has', async t => {
  const { project, root } = await runFixture(t);
  const dir2 = path.join(root, '.swarm/runs/run-2'); await fs.mkdir(dir2, { recursive: true });
  const state = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs/run-1/state.json'), 'utf8'));
  state.status = 'failed'; state.finishedAt = iso(NOW + 20000);
  state.jobs = state.jobs.filter(j => j.id !== 'ship').map(j => (j.id === 'build' ? { ...j, status: 'failed', costUsd: 1.5 } : j)).concat([{ ...state.jobs[0], id: 'extra', agent: 'cursor', model: 'composer' }]);
  await fs.writeFile(path.join(dir2, 'state.json'), JSON.stringify(state));
  const [a, b] = [await runDetail(project, 'run-1'), await runDetail(project, 'run-2')];
  const c = compareRuns(a, b);
  assert.deepEqual([c.a.runId, c.b.runId, c.onlyA, c.onlyB], ['run-1', 'run-2', 1, 1]);
  assert.equal(c.shared.length, 3);
  assert.deepEqual(c.shared.find(s => s.id === 'build'), { id: 'build', a: { status: 'complete', durationMs: 6000, costUsd: 0.5, rerun: false }, b: { status: 'failed', durationMs: 6000, costUsd: 1.5, rerun: false } });
  assert.ok(c.lanes.some(l => l.lane === 'Cursor' && l.a === null && l.b.jobs === 1));
  assert.equal(compareRuns(a, null), null);
});

test('the board serves the run inspector behind the token: the page, the data, compare; a wrong token, an unknown project or run, and a bad run id are refused', async t => {
  const home = await tmp(t);
  const { project } = await runFixture(t);
  const env = { ...process.env, SWARM_PROJECTS_FILE: path.join(home, 'p.json'), SWARM_HISTORY_FILE: path.join(home, 'h.ndjson'), SWARM_LANES_DIR: path.join(home, 'l'), SWARM_SPEND_DIR: path.join(home, 's'), SWARM_PHONE_DIR: path.join(home, 'ph') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ ...project, addedAt: iso(NOW), lastSeen: iso(NOW) }] }));
  const api = createBoardApi({ env, now: () => NOW, live: async () => [], cacheMs: 0 });
  const server = createWatchServer({ root: home, getRunSnapshot: async () => null, getPlanSnapshot: async () => ({ present: false }), getGallery: async () => ({ schema: 1, screens: [] }), getBoard: async () => ({ runs: [] }), board: api, indexName: 'board.html', assetDir: assets, deltaFile, commandList: [], contextCommands: () => [] });
  const { url } = await server.listen();
  t.after(() => server.close());
  const token = new URL(url).searchParams.get('t');
  const get = (p, headers = {}) => new Promise((resolve, reject) => http.get(new URL(p, url), { headers }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
  const q = (run, extra = '') => `/api/run?id=${project.id}&run=${run}${extra}`;
  const auth = { 'x-watch-token': token };
  const ok = await get(q('run-1'), auth);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).totals.jobs, 4);
  assert.match((await get(`/run?id=${project.id}&run=run-1&t=${token}`)).body, /Job graph/);
  assert.equal((await get(`/run?id=${project.id}&run=run-1`)).status, 403);
  assert.equal((await get(`/api/run?id=${project.id}&run=run-1&t=wrong`)).status, 403);
  assert.equal((await get(`/api/run?id=${project.id}&run=run-1`)).status, 403);
  assert.equal((await get(q('nope'), auth)).status, 404);
  assert.equal((await get(`/api/run?id=ffffffffffff&run=run-1`, auth)).status, 404);
  assert.equal((await get(q('..%2Frun-1'), auth)).status, 404);
  assert.equal((await get(q('run-1', '&compare=nope'), auth)).status, 404);
  assert.equal((await get(q('run-1', '&compare=run-1'), auth)).status, 200);
});

test('the board page helpers (unread, liveness, countdown, bays, hash, graph layout, replay) do what the page relies on', async () => {
  const L = await lib();
  const items = [{ projectId: 'p', kind: 'blocker', id: 'a' }, { projectId: 'p', kind: 'human', id: 'b' }];
  assert.deepEqual(plain(L.unread(items, [])), ['p|blocker|a', 'p|human|b']);
  assert.deepEqual(plain(L.unread(items, ['p|blocker|a'])), ['p|human|b']);
  assert.deepEqual(plain(L.unread([], ['x'])), []);
  assert.equal(L.remember(Array.from({ length: 500 }, (_, i) => `k${i}`), ['new'], 500).length, 500);
  assert.equal(L.remember(['a'], ['a', 'b'], 500).join(), 'a,b');
  assert.deepEqual(plain(L.liveness(NOW - 2000, NOW)), { state: 'live', ageS: 2 });
  assert.equal(L.liveness(NOW - 20000, NOW).state, 'stale');
  assert.equal(L.liveness(0, NOW).state, 'stale');
  assert.equal(L.countdown(iso(NOW + 30000), NOW), 'in 30 s');
  assert.equal(L.countdown(iso(NOW + 12 * 60000), NOW), 'in 12 min');
  assert.equal(L.countdown(iso(NOW + 125 * 60000), NOW), 'in 2 h 5 min');
  assert.equal(L.countdown(iso(NOW - 1000), NOW), 'now');
  assert.equal(L.countdown('junk', NOW), '');
  const bays = L.bays([{ lane: 'Haiku', state: 'working' }, { lane: 'Haiku', state: 'error' }, { lane: 'Zeta', state: 'thinking' }], []);
  const haiku = bays.find(b => b.lane === 'Haiku');
  assert.deepEqual([haiku.agents.length, haiku.running, haiku.idle], [2, 1, false], 'a failed agent is listed but not counted as running');
  assert.equal(bays.find(b => b.lane === 'Sonnet').idle, true, 'no agent running: a sleeping head, never an invented agent');
  assert.ok(bays.some(b => b.lane === 'Zeta'));
  assert.deepEqual(plain(L.parseHash('#tab=cost')), { tab: 'cost' });
  assert.deepEqual(plain(L.parseHash('#run=abc123/1792-aaaa')), { run: { projectId: 'abc123', runId: '1792-aaaa' } });
  for (const bad of ['#tab=evil', '#run=../x/y', '#run=a/b/c', '#javascript:alert(1)', '', undefined]) assert.deepEqual(plain(L.parseHash(bad)), {}, String(bad));
  const g = L.layoutGraph([{ id: 'a', layer: 0, after: [] }, { id: 'b', layer: 1, after: ['a'] }, { id: 'c', layer: 1, after: ['a', 'zz'] }]);
  assert.deepEqual(plain(g.edges), [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]);
  assert.ok(g.pos.b.x > g.pos.a.x && g.pos.c.y > g.pos.b.y);
  const journal = [{ job: 'a', event: 'queued' }, { job: 'a', event: 'started' }, { job: 'a', event: 'finished', usd: 0.5 }, { job: 'b', event: 'started' }, { job: 'b', event: 'failed', usd: 0.25 }];
  assert.deepEqual(plain(L.replay(journal, 2)), { spentUsd: 0, running: 1, ended: 0 });
  assert.deepEqual(plain(L.replay(journal, 5)), { spentUsd: 0.75, running: 0, ended: 2 });
  assert.deepEqual(plain(L.replay(journal, 0)), { spentUsd: 0, running: 0, ended: 0 });
});

test('the ported robot heads: attributed and licensed, they draw every state the board uses, and only the five states the swarm can back are mapped', async () => {
  const license = await read('ROBOT-HEADS-LICENSE.txt').catch(() => '');
  assert.match(license, /MIT License/);
  assert.match(license, /Fayaz Ahmed/);
  for (const f of ['color', 'ticker', 'light', 'geometry', 'faces', 'sim', 'render']) {
    const src = await read(`robot-${f}.js`);
    assert.match(src.split('\n')[0], /Ported from https:\/\/github\.com\/fayazara\/robot-heads .*commit 58ebf6439a8125a769f63b22ffd35bc18834b1b5\. MIT License/, f);
    assert.doesNotMatch(src, /\bimport React\b|from 'react'|from "react"/, 'no React');
  }
  const { FACES } = await import('../tools/watch-assets/robot-faces.js');
  const { RobotSim, restPose } = await import('../tools/watch-assets/robot-sim.js');
  const { STATES } = await import('../tools/watch-assets/robot-head.js').catch(() => ({ STATES: ['idle', 'thinking', 'working', 'error', 'sleeping'] }));
  for (const s of ['idle', 'thinking', 'working', 'error', 'sleeping']) {
    assert.ok(FACES[s], `a face for ${s}`);
    const sim = new RobotSim(0.5, s); sim.setState(s);
    for (let i = 0; i < 30; i += 1) sim.update(0.05);
    assert.ok(Number.isFinite(sim.pose.yaw ?? 0), `${s} steps without NaN`);
    assert.ok(restPose(s), `${s} has a still frame (reduced motion)`);
  }
  assert.ok(STATES.length >= 5);
  const board = await read('board.js');
  assert.match(board, /var HEAD_STATE = \{ working: 'working', thinking: 'thinking', error: 'error', sleeping: 'sleeping' \}/);
});

test('motion rules in the code: heads stay still under reduced motion or when paused, stop drawing off screen; the stylesheet turns animation off; no pointer-following', async () => {
  const head = await read('robot-head.js');
  assert.match(head, /prefers-reduced-motion: reduce/);
  assert.match(head, /IntersectionObserver/);
  assert.match(head, /let still = paused \|\| reducedMotion\(\) \|\| !visible/);
  assert.match(head, /export const MAX_ANIMATED = 12/);
  assert.match(head, /const FRAME_S = 1 \/ 15/);
  assert.match(head, /sim\.pointer = null/);
  const css = await read('swarm-ui.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
  assert.match(css, /body\.paused-motion/);
  assert.match(await read('board.js'), /if \(reducedMotion\(\)\) \{ \$\('pauseMotion'\)\.hidden = true; \}/);
});

test('the pages never build HTML from data, load nothing from the internet, and keep the keyboard, deep links and read-only promise', async () => {
  for (const f of ['board.js', 'run.js', 'robot-head.js', 'board-lib.js', 'project.js']) {
    assert.doesNotMatch(await read(f), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, f);
  }
  for (const f of ['board.html', 'run.html', 'project.html', 'swarm-ui.css', 'board.js', 'run.js']) {
    const text = await read(f);
    const urls = [...text.matchAll(/https?:\/\/[^\s"')]+/g)].map(m => m[0]).filter(u => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(urls, [], `${f} loads or links nothing external`);
    assert.doesNotMatch(text, /@import|<link[^>]+(googleapis|cdn)/i, f);
  }
  const board = await read('board.js');
  for (const key of ["e.key === '/'", "e.key === '?'", "e.key === 'u'", "e.key === 'p'", "e.key >= '1' && e.key <= '4'", "e.key === 'Escape'"]) assert.ok(board.includes(key), key);
  assert.match(board, /L\.parseHash\(location\.hash\)/);
  assert.match(board, /Read-only: the board never answers anything/);
  const html = await read('board.html');
  for (const id of ['tab-overview', 'tab-cost', 'tab-agents', 'tab-events', 'needsChip', 'scratch', 'liveChip', 'help']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.doesNotMatch(await read('board.js'), /method:\s*['"](POST|PUT|PATCH|DELETE)/i, 'the board only reads');
});

test('provenance and the design system: third-party sources, commits and licenses are logged; the skill is installed project-local; every token the design doc names exists in the stylesheet', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const third = await fs.readFile(path.join(root, 'docs/third-party.md'), 'utf8');
  for (const needle of ['github.com/fayazara/robot-heads', '58ebf6439a8125a769f63b22ffd35bc18834b1b5', 'github.com/nextlevelbuilder/ui-ux-pro-max-skill', '56ea9cf174ed86786187daa9de0e6247cb0747e4', 'MIT', 'orca', 'ruflo', 'archify', 'ComfyUI', 'openhuman', 'zero code', 'text-to-cad', 'CLI-Anything']) assert.ok(third.includes(needle), needle);
  const skill = await fs.readFile(path.join(root, '.claude/skills/ui-ux-pro-max/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: ui-ux-pro-max/);
  assert.match(await fs.readFile(path.join(root, '.claude/skills/ui-ux-pro-max/LICENSE'), 'utf8'), /MIT License[\s\S]*Next Level Builder/);
  await assert.rejects(fs.access(path.join(root, '.claude/skills/ui-ux-pro-max/scripts/tests')), 'the upstream tests were left out');
  const doc = await fs.readFile(path.join(root, 'docs/design/swarm-watch-design-system.md'), 'utf8');
  const css = await read('swarm-ui.css');
  const tokens = [...new Set([...doc.matchAll(/`(--[a-z0-9-]+)`/g)].map(m => m[1]))];
  assert.ok(tokens.length >= 20, 'the doc names the tokens');
  for (const token of tokens) assert.ok(css.includes(`${token}:`), `${token} is defined in swarm-ui.css`);
  assert.match(doc, /ui-ux-pro-max/);
  assert.match(doc, /UX checks/);
});

test('contrast: every text colour of the design system is at least 4.5:1 on the surfaces it sits on, and focus has a visible ring', async () => {
  const css = await read('swarm-ui.css');
  const token = name => { const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css); assert.ok(m, `--${name} is a hex colour`); return m[1]; };
  const channel = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = hex => 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) + 0.7152 * channel(parseInt(hex.slice(3, 5), 16)) + 0.0722 * channel(parseInt(hex.slice(5, 7), 16));
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  for (const text of ['fg', 'muted', 'faint', 'accent', 'warn', 'bad', 'info', 'lav']) for (const surface of ['bg', 'card', 'card-2']) assert.ok(ratio(token(text), token(surface)) >= 4.5, `${text} on ${surface}: ${ratio(token(text), token(surface)).toFixed(2)}`);
  assert.ok(ratio('#a7f3d0', '#0f3a2a') >= 4.5, 'the selected tab');
  assert.ok(ratio('#1a1202', token('warn')) >= 4.5, 'the unread badge');
  assert.match(css, /:focus-visible \{ outline: none; box-shadow: var\(--ring\)/);
  assert.match(css, /@media \(max-width: 960px\)[\s\S]*min-height: 44px/);
});

test('review fixes: a lane, job or status called __proto__ or constructor is only a name (no prototype pollution anywhere), in the server data and in the page helpers', async t => {
  const root = await tmp(t);
  const dir = path.join(root, '.swarm/runs/run-1'); await fs.mkdir(dir, { recursive: true });
  const job = (id, agent, status) => ({ id, agent, model: 'x', status, queuedAt: iso(NOW - 9000), startedAt: iso(NOW - 8000), finishedAt: iso(NOW - 1000), costUsd: 1, usage: { total_tokens: 1 }, progress: { lastOutputAt: iso(NOW - 1000) }, attempts: [{ agent, status }] });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id: 'run-1', status: 'running', startedAt: iso(NOW - 10000), jobs: [job('__proto__', '__proto__', '__proto__'), job('constructor', 'constructor', 'running'), job('toString', 'hasOwnProperty', 'running'), null, 'junk', [], job('ok', 'claude', 'complete')] }));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ jobs: [{ id: '__proto__' }, { id: 'constructor', after: ['__proto__'] }, { id: 'toString', after: ['constructor', '__proto__'] }] }));
  const project = { id: projectId(root), name: 'p', root };
  const r = await runDetail(project, 'run-1');
  assert.equal(({}).jobs, undefined, 'Object.prototype was not touched');
  assert.equal(({}).usd, undefined);
  assert.equal(r.totals.jobs, 4, 'null, a string and an array in the job list are skipped');
  assert.equal(r.jobs.find(j => j.id === 'toString').layer, 2);
  assert.equal(r.lanes['__proto__'].jobs, 1);
  assert.equal(r.totals.byStatus['__proto__'], 1);
  const live = agentsOf([{ id: 'run-1', state: JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')) }], new Set(['run-1']), NOW);
  assert.equal(({}).jobs, undefined);
  assert.equal(live.byLane.constructor, 1);
  assert.equal(live.total, 2);
  const cost = costOf([{ state: { startedAt: iso(NOW - 10000), jobs: [job('a', '__proto__', 'complete'), null] } }], NOW);
  assert.equal(cost.laneToday['__proto__'], 1);
  assert.equal(({}).usd, undefined);
  const L = await lib();
  const bays = L.bays([{ lane: '__proto__', state: 'working' }, { lane: 'constructor', state: 'thinking' }], []);
  assert.equal(bays.find(b => b.lane === '__proto__').agents.length, 1);
  const g = L.layoutGraph([{ id: '__proto__', layer: 0, after: [] }, { id: 'constructor', layer: 1, after: ['__proto__'] }]);
  assert.equal(g.edges.length, 1);
  assert.equal(L.unread([{ projectId: 'p', kind: 'k', id: '__proto__' }], ['p|k|__proto__']).length, 0);
  assert.equal(({}).agents, undefined);
});

test('review fixes: a symlinked or non-file state.json is refused (never followed or waited on), a long chain of jobs does not overflow the stack, and replay order is fixed', async t => {
  const root = await tmp(t);
  const dir = path.join(root, '.swarm/runs/run-1'); await fs.mkdir(dir, { recursive: true });
  const outside = path.join(root, 'outside.json'); await fs.writeFile(outside, JSON.stringify({ id: 'x', status: 'complete', jobs: [] }));
  await fs.symlink(outside, path.join(dir, 'state.json'));
  const project = { id: projectId(root), name: 'p', root };
  assert.equal(await runDetail(project, 'run-1'), null, 'a symlinked state file is not read');
  await fs.rm(path.join(dir, 'state.json'));
  await fs.mkdir(path.join(dir, 'state.json'));
  assert.equal(await runDetail(project, 'run-1'), null, 'a directory is not a state file');
  const chain = Array.from({ length: 2000 }, (_, i) => ({ id: `j${i}`, after: i ? [`j${i - 1}`] : [] }));
  assert.equal(layersOf(chain).get('j1999'), 1999);
  assert.deepEqual([...layersOf([{ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] }]).values()].sort(), [0, 1]);
  await fs.rm(path.join(dir, 'state.json'), { recursive: true });
  const same = iso(NOW);
  const mk = id => ({ id, agent: 'claude', model: 'sonnet', status: 'complete', queuedAt: same, startedAt: same, finishedAt: same, costUsd: 0.1, attempts: [{ agent: 'claude' }] });
  const run = jobs => fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id: 'run-1', status: 'complete', startedAt: same, finishedAt: same, jobs }));
  await run([mk('b'), mk('a'), mk('c')]);
  const one = (await runDetail(project, 'run-1')).journal.map(e => `${e.job}:${e.event}`);
  await run([mk('c'), mk('a'), mk('b')]);
  const two = (await runDetail(project, 'run-1')).journal.map(e => `${e.job}:${e.event}`);
  assert.deepEqual(one, two, 'the order does not depend on the order the jobs were written in');
  assert.deepEqual(one.slice(0, 3), ['a:queued', 'b:queued', 'c:queued'], 'at the same instant: all queued first');
  assert.deepEqual(one.slice(3, 6), ['a:started', 'b:started', 'c:started']);
});

test('review fixes in the page: one poll at a time, nothing rebuilt when nothing changed (keyboard focus stays), stale bays removed, announcements only on change, and a run link that does not trap the Back button', async () => {
  const board = await read('board.js');
  assert.match(board, /if \(state\.polling\) \{ return; \}/);
  assert.match(board, /\.then\(function \(\) \{ state\.polling = false; \}\)/);
  assert.match(board, /if \(sig === state\.needsSig\) \{ return; \}/);
  assert.match(board, /if \(psig === state\.projSig\) \{ return; \}/);
  assert.match(board, /if \(csig === state\.costSig\) \{ return; \}/);
  assert.match(board, /map\.forEach\(function \(v, lane\) \{ if \(!names\[lane\]\)/);
  assert.match(board, /sessionStorage\.getItem\('swarm-deeplink'\)/);
  assert.match(board, /\$\('deeplink'\)\.hidden = false/);
  assert.match(board, /\$\('announce'\)\.textContent = said/);
  const html = await read('board.html');
  assert.match(html, /id="announce" role="status" aria-live="polite" aria-atomic="true"/);
  assert.doesNotMatch(html, /id="liveChip"[^>]*role="status"/, 'a clock-like chip is not a live region');
  assert.match(html, /id="deeplink" hidden/);
});

test('the per-run page uses the board design system: shared tokens first, no navy palette, no corner brackets', async () => {
  const dir = new URL('../tools/watch-assets/', import.meta.url);
  const names = (await fs.readdir(dir)).filter(n => /\.(css|js|html)$/.test(n) && !/^(swarm-ui\.css|board\.(js|html)|project\.(js|html)|run\.(js|html)|robot-.*|board-lib\.js)$/.test(n));
  const files = {};
  for (const n of names) files[n] = await fs.readFile(new URL(n, dir), 'utf8');
  const read = n => files[n];
  const html = read('index.html');
  assert.ok(html.indexOf('assets/swarm-ui.css') > -1 && html.indexOf('assets/swarm-ui.css') < html.indexOf('assets/watch.css'));
  assert.doesNotMatch(html, /class="[^"]*\bhud\b/);
  assert.match(html, /<header class="topbar">/);
  assert.equal((html.match(/<button class="tab" role="tab"/g) ?? []).length, 4);
  assert.match(html, /class="toggle-group"/);
  // The old navy/lime palette and fonts are gone from every run-page file (the board's own files are out of this list).
  const old = /#(?:0c1430|101b3e|15214a|1a2856|273770|33468a|dfe6fb|94a2cf|66739f|b9f25c|5aa8ff|3fd6c4|ffb547|ff8a6b|c39bff|f2d26b|ff5f6f)\b|rgba\((?:12, ?20, ?48|26, ?40, ?86|21, ?33, ?74|185, ?242, ?92|90, ?168, ?255)/i;
  for (const n of names) { assert.doesNotMatch(read(n), old, n); assert.doesNotMatch(read(n), /Unbounded|JetBrains Mono|Figtree/, n); }
  assert.doesNotMatch(read('watch.css'), /\.hud\b/);
  assert.match(read('watch.css'), /prefers-reduced-motion/);
  // Class names that swarm-ui.css gives another meaning (.seg is the board's 6px stacked bar) are not used as buttons by any run-page script.
  for (const n of names.filter(x => x.endsWith('.js'))) assert.doesNotMatch(read(n), /el\('div', 'seg'\)|className = 'seg'/, n);
  // The wrapper keeps the phone's safe-area padding (a `.wrap` class would override it).
  assert.match(html, /<div class="app run">/);
  assert.doesNotMatch(html, /class="app wrap"/);
});

test('costOf counts the jobs a lane finished today even when the job reported no cost', () => {
  const finishedAt = iso(NOW - 1000);
  const job = (id, agent, status, extra = {}) => ({ id, agent, model: 'm', status, finishedAt, ...extra });
  const out = costOf([{ state: { id: 'r', startedAt: iso(NOW - 5000), jobs: [job('a', 'codex', 'complete'), job('b', 'codex', 'failed'), job('c', 'cursor', 'complete'), job('d', 'anthropic', 'complete', { costUsd: 0.01 }), job('e', 'codex', 'running')] } }], NOW);
  assert.deepEqual(out.laneJobsToday, { codex: 2, cursor: 1, anthropic: 1 });
});

test('Overview and Agents read one count; worker slots held without a running job are said, not hidden', async () => {
  const L = await lib();
  const m = { agents: { total: 0 }, workers: { total: 4, max: 4 } };
  assert.deepEqual({ ...L.agentCounts(m) }, { live: 0, held: 4, unshown: 4 });
  assert.match(L.slotsText(m), /4 worker slots are held \(4 held, 0 agents running\)/);
  assert.equal(L.slotsText({ agents: { total: 4 }, workers: { total: 4 } }), '');
  const board = await read('board.js');
  assert.match(board, /L\.slotsText\(data\.machine\)/);
  assert.match(board, /L\.agentCounts\(m\)\.held \+ ' worker slots held'/);
});

import { underfilledWaves, enrichRunEvents } from '../tools/board-data.mjs';
test('many 1-job runs in a row warn that the waves are under-filled', () => {
  assert.match(underfilledWaves([12, 1, 1, 1], 12), /waves under-filled: 1 job of 12 slots/);
  assert.equal(underfilledWaves([1, 1], 12), null, 'two is not a pattern');
  assert.equal(underfilledWaves([1, 1, 1, 8], 12), null, 'the last run was full');
  assert.equal(underfilledWaves([1, 1, 1], 2), null, 'a small machine has no spare slots');
});

test('Events: a run row names its tickets, lane and model, pass or fail, with the reason and retries of a failure', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/runs/run-9'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/run-9/state.json'), JSON.stringify({ id: 'run-9', status: 'failed', jobs: [
    { id: 'T-0277', agent: 'codex', model: 'gpt-6.1-sol', status: 'complete', attempts: [{ status: 'complete' }] },
    { id: 'T-0286', agent: 'anthropic', model: 'claude-haiku-5-5', status: 'failed', error: 'tests failed: a.test.ts', attempts: [{ status: 'failed' }, { status: 'failed' }] }] }));
  const { createLedger, writeLedger } = await import('../tools/tickets.mjs');
  await writeLedger(root, createLedger({ scope: { name: 'S', version: 1, hash: 'a'.repeat(64) }, tickets: [{ id: 'T-0277', title: 'Staff list page', type: 'build', status: 'done', files: ['src/a.ts'], acceptance: ['x'], scopeRefs: ['R-001'], dependsOn: [], size: 'S', risk: 'low' }] }));
  const rows = await enrichRunEvents([{ kind: 'run', run: 'run-9', projectId: 'p1', title: 'Run run-9' }, { kind: 'pr', title: 'x' }], [{ id: 'p1', root }]);
  assert.deepEqual(rows[0].jobs.map(j => [j.id, j.title, j.lane, j.model, j.outcome, j.retries, j.reason]), [
    ['T-0277', 'Staff list page', 'Codex', 'gpt-6.1-sol', 'pass', 0, null],
    ['T-0286', null, 'Haiku', 'claude-haiku-5-5', 'fail', 1, 'tests failed: a.test.ts']]);
  assert.equal(rows[1].jobs, undefined);
  assert.equal((await enrichRunEvents([{ kind: 'run', run: '../x', projectId: 'p1', title: 't' }], [{ id: 'p1', root }]))[0].jobs, undefined, 'a bad run id is never read');
});

// The "Watch" link of every live run on the board, exactly as board.js builds it, must open a page (200): on the local board through /open/run, on the remote board (which never starts
// a run's own page on the computer) through the run inspector.
test('every Watch link on the board resolves, locally and on the remote board; a board older than the install says so', async t => {
  const home = await tmp(t);
  const { project } = await runFixture(t);
  const env = { ...process.env, SWARM_PROJECTS_FILE: path.join(home, 'p.json'), SWARM_HISTORY_FILE: path.join(home, 'h.ndjson'), SWARM_LANES_DIR: path.join(home, 'l'), SWARM_SPEND_DIR: path.join(home, 's'), SWARM_PHONE_DIR: path.join(home, 'ph') };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ ...project, addedAt: iso(NOW), lastSeen: iso(NOW) }] }));
  const liveRoot = await fs.realpath(project.root);
  const live = async () => [{ runId: 'run-1', root: liveRoot, pid: process.pid, startedAt: iso(NOW - 1000) }];
  const boardSource = await read('board.js');
  const hrefs = (data) => {   // board.js's own link builders, run against the data the server sent
    const box = { state: { data }, T: 'TOKEN', encodeURIComponent };
    vm.runInNewContext(boardSource.slice(boardSource.indexOf('function runHref'), boardSource.indexOf('function link(')), box);
    return data.projects.flatMap(p => p.live.map(r => box.watchHref(p.id, r.runId)));
  };
  for (const remote of [undefined, { port: 0, token: 'x', hosts: ['me.ts.net'], login: 'me@x.com' }]) {
    const api = createBoardApi({ env, now: () => NOW, live, cacheMs: 0 });
    const server = createWatchServer({ root: home, getRunSnapshot: async () => null, getPlanSnapshot: async () => ({ present: false }), getGallery: async () => ({ schema: 1, screens: [] }), getBoard: async () => ({ runs: [] }), board: api, indexName: 'board.html', assetDir: assets, deltaFile, commandList: [], contextCommands: () => [], ...(remote ? { remote } : {}) });
    const { url } = await server.listen();
    t.after(() => server.close());
    api.setBoardUrl?.(url);
    t.after(() => api.close());
    const token = new URL(url).searchParams.get('t');
    const headers = { ...(remote ? { 'tailscale-user-login': 'me@x.com' } : {}), 'x-watch-token': token };
    const fetchPath = (p, base = url) => new Promise((resolve, reject) => http.get(new URL(p, base), { headers }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: b })); }).on('error', reject));
    const board = JSON.parse((await fetchPath('/api/board?scratch=1')).body);
    assert.equal(board.openRun, !remote);
    assert.equal(typeof board.server.version, 'string');
    assert.equal(board.server.stale, false, 'a development checkout has no install to be older than');
    const runDetail = JSON.parse((await fetchPath(`/api/run?id=${project.id}&run=run-1`)).body);
    assert.equal(runDetail.openRun, !remote, 'the run page knows whether it may link to the run\'s own page');
    assert.ok(Array.isArray(runDetail.orchestrator));
    const liveTab = JSON.parse((await fetchPath(`/api/live?id=${project.id}`)).body);
    assert.ok(liveTab.orchestrator && Array.isArray(liveTab.orchestrator.sessions), 'the Live tab carries the orchestrator');
    const links = hrefs(board);
    assert.ok(links.length > 0, 'the fixture has a live run with a Watch link');
    for (const link of links) {
      let res = await fetchPath(link);
      if (res.status === 302) res = await fetchPath(res.location);   // the run's own page, on its own server (and token)
      assert.equal(res.status, 200, `${remote ? 'remote' : 'local'} Watch link ${link} -> ${res.status}`);
    }
  }
});

import { versionInfo } from '../tools/server-version.mjs';
test('a server started from an older install snapshot reports itself stale', async t => {
  const install = await tmp(t);
  for (const [dir, v] of [['versions/1.135.0-aaaa', '1.135.0'], ['versions/1.140.0-bbbb', '1.140.0']]) { await fs.mkdir(path.join(install, dir), { recursive: true }); await fs.writeFile(path.join(install, dir, 'package.json'), JSON.stringify({ version: v })); }
  await fs.symlink(path.join(install, 'versions/1.140.0-bbbb'), path.join(install, 'current'));
  const old = await versionInfo({ ownRoot: path.join(install, 'versions/1.135.0-aaaa') });
  assert.deepEqual(old, { version: '1.135.0', installedVersion: '1.140.0', stale: true });
  assert.equal((await versionInfo({ ownRoot: path.join(install, 'versions/1.140.0-bbbb') })).stale, false);
  assert.equal((await versionInfo({ ownRoot: install })).installedVersion, null);
  const board = await read('board.js');
  assert.match(board, /data\.server && data\.server\.stale/);
  assert.match(await read('board.html'), /id="staleBanner"/);
});
