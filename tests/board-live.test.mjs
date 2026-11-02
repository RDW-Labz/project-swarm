// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { combineLive, liveOverview } from '../tools/board-live.mjs';
import { createBoardApi } from '../tools/watch-cli.mjs';
import { createWatchServer } from '../tools/watch-server.mjs';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const iso = ms => new Date(NOW - ms).toISOString();
const job = (id, agent, model, status, o = {}) => ({ id, agent, model, lane: agent, status, startedAt: iso(500000), finishedAt: ['running', 'queued', 'held'].includes(status) ? undefined : iso(100000), costUsd: status === 'queued' ? 0 : 0.1, attempts: [{ agent, status }], progress: status === 'running' ? { lastOutputAt: iso(o.quiet ? 300000 : 10000) } : undefined, ...o });
const run = (id, status, jobs, extra = {}) => ({ id, state: { id, status, startedAt: iso(900000), ...(['complete', 'failed'].includes(status) ? { finishedAt: iso(100000) } : {}), jobs, ...extra }, manifest: { goal: `goal ${id}`, jobs: jobs.filter(Boolean).map(j => ({ id: j.id })) } });
const project = { id: 'p1', name: 'parts-request-app' };
const RA = '1792400000001-aaaa1111', RB = '1792400000002-bbbb2222', RC = '1792400000003-cccc3333';

test('two live runs combine: jobs, progress, first-try, retries, merged, ETA, lanes with ticket and run', () => {
  const a = run(RA, 'running', [job('T-1', 'anthropic', 'claude-haiku-5-5', 'complete'), job('T-2', 'claude', 'sonnet', 'running'), job('T-3', 'claude', 'sonnet', 'queued')], { mergeQueue: { batches: [{}, {}], integrated: ['x'], conflicts: [] } });
  const b = run(RB, 'running', [job('T-4', 'claude', 'opus', 'running', { quiet: true }), job('T-5', 'codex', 'gpt', 'complete', { attempts: [{ status: 'failed' }, { status: 'complete' }] }), job('T-6', 'codex', 'gpt', 'held')], { mergeQueue: { batches: [{}], integrated: ['y', 'z'], conflicts: ['c'] } });
  const d = combineLive({ project, runs: [b, a], tickets: [{ id: 'T-2', title: 'Fix the retry' }], cost: { todayUsd: 1.5, allUsd: 7 }, capUsd: 10, lastActivityAt: iso(1000), now: NOW });
  assert.equal(d.header.runsLive, 2);
  assert.deepEqual(d.header.jobs, { running: 2, queued: 1, blocked: 1 });
  assert.equal(d.header.spendTodayUsd, 1.5); assert.equal(d.header.capUsd, 10);
  assert.equal(d.empty, null);
  assert.deepEqual(d.runs.map(r => r.runId), [RA, RB], 'runs in a stable order');
  assert.deepEqual(d.runs.map(r => r.idx), [0, 1]);
  assert.equal(d.stats.done, 2); assert.equal(d.stats.total, 6);
  assert.equal(d.stats.finished, 2); assert.equal(d.stats.firstTry, 1); assert.equal(d.stats.firstTryRate, 0.5);
  assert.equal(d.stats.retries, 1);
  assert.equal(d.stats.merged, 3); assert.equal(d.stats.queue, 3); assert.equal(d.stats.conflicts, 1);
  assert.equal(d.map.length, 6);
  assert.deepEqual([...new Set(d.map.map(j => j.run))], [RA, RB]);
  const lanes = Object.fromEntries(d.lanes.map(l => [l.lane, l]));
  assert.equal(lanes.Sonnet.agents[0].job, 'T-2'); assert.equal(lanes.Sonnet.agents[0].ticket, 'T-2'); assert.equal(lanes.Sonnet.agents[0].title, 'Fix the retry'); assert.equal(lanes.Sonnet.agents[0].run, RA);
  assert.equal(lanes.Opus.agents[0].state, 'thinking', 'quiet for longer than 90 s');
  assert.equal(lanes.Sonnet.agents[0].state, 'working');
  assert.equal(lanes.Opus.agents[0].ticket, null, 'no ticket with that id: none is invented');
  assert.ok(d.runs.every(r => r.spendUsd >= 0));
});

test('combined ETA is the slowest live run, unknown when a run has none yet', () => {
  const a = run(RA, 'running', [job('T-1', 'claude', 'sonnet', 'complete'), job('T-2', 'claude', 'sonnet', 'running')]);
  const b = run(RB, 'running', [job('T-3', 'claude', 'sonnet', 'queued')]);   // nothing finished: no rate, no estimate
  const both = combineLive({ project, runs: [a, b], now: NOW });
  assert.equal(both.header.etaMs, null);
  const only = combineLive({ project, runs: [a], now: NOW });
  assert.ok(only.header.etaMs > 0);
});

test('a run that finishes while the page is open: it leaves Live and the live numbers at once (even if its process still runs) and shows under Recent', () => {
  const finishing = run(RA, 'complete', [job('T-1', 'claude', 'sonnet', 'complete'), job('T-2', 'claude', 'sonnet', 'running')]);   // state says over; a leftover running job must not show as a live agent
  const other = run(RB, 'running', [job('T-3', 'claude', 'sonnet', 'running')]);
  const mid = combineLive({ project, runs: [finishing, other], now: NOW });
  assert.equal(mid.header.runsLive, 1);
  assert.deepEqual(mid.runs.map(r => r.runId), [RB]);
  assert.equal(mid.stats.total, 1, 'the finished run is not in the combined numbers');
  assert.equal(mid.header.jobs.running, 1);
  assert.equal(mid.map.length, 1);
  assert.equal(mid.lanes.flatMap(l => l.agents).length, 1, 'no head for the finished run');
  assert.equal(mid.recent.length, 1);
  assert.deepEqual({ id: mid.recent[0].runId, status: mid.recent[0].status }, { id: RA, status: 'complete' });
  assert.equal(mid.empty, null);
  // The next poll: its process is gone, so it comes from the finished-today list instead: the same Recent row.
  const after = combineLive({ project, runs: [other], finishedToday: [finishing], now: NOW });
  assert.equal(after.recent.length, 1);
  assert.equal(after.recent[0].done, 1); assert.equal(after.recent[0].total, 2);
  // And when the last live run ends the view is the empty state with the last activity and the run under Recent.
  const none = combineLive({ project, runs: [finishing], lastActivityAt: iso(100000), now: NOW });
  assert.deepEqual(none.empty, { lastActivityAt: iso(100000) });
  assert.equal(none.header.runsLive, 0); assert.equal(none.header.etaMs, null);
  assert.equal(none.recent.length, 1); assert.equal(none.finishedCount, 1);
});

test('spend: a run row and a Recent row use the run total (the number the Overview tab shows), not a partial sum', () => {
  const a = run(RA, 'running', [job('T-1', 'anthropic', 'claude-haiku-5-5', 'complete', { costUsd: 0.25 }), job('T-2', 'claude', 'sonnet', 'running', { costUsd: 0.1 })]);
  const d = combineLive({ project, runs: [a], now: NOW });
  const total = a.state.jobs.reduce((n, j) => n + j.costUsd, 0);
  assert.ok(Math.abs(d.runs[0].spendUsd - total) < 1e-9, `${d.runs[0].spendUsd} vs ${total}`);
});

test('a paused run makes the combined ETA unknown (it is not progressing)', () => {
  const a = run(RA, 'running', [job('T-1', 'claude', 'sonnet', 'complete'), job('T-2', 'claude', 'sonnet', 'queued')]);
  a.state.pause = { reason: 'rate limit' };
  const d = combineLive({ project, runs: [a], now: NOW });
  assert.equal(d.runs[0].status, 'paused');
  assert.equal(d.header.etaMs, null);
});

test('heads are built only for the jobs the numbers count; lanes and heads are capped; names are cleaned', () => {
  const bad = run(RA, 'running', [job('', 'claude', 'sonnet', 'running'), job('<img src=x>', 'claude', 'sonnet', 'running'), job('J-ok', 'claude', 'sonnet', 'running')]);
  const d = combineLive({ project, runs: [bad], now: NOW });
  const heads = d.lanes.flatMap(l => l.agents);
  assert.deepEqual(heads.map(h => h.job), ['J-ok'], 'a job with no id or a markup id gets no head, and is not counted either');
  assert.equal(d.stats.total, 1);
  const many = run(RB, 'running', Array.from({ length: 400 }, (_, i) => job(`J-${i}`, `agent-${i}`, 'm', 'running')));
  const m = combineLive({ project, runs: [many], now: NOW });
  assert.ok(m.lanes.length <= 13, `lanes ${m.lanes.length}`);
  assert.ok(m.lanes.flatMap(l => l.agents).length <= 200);
  assert.equal(m.lanes.reduce((n, l) => n + l.count, 0), 400, 'counts still add up');
  const odd = run(RC, 'running', [job('J-1', 'bad\u202eagent', 'm', 'running')]);
  assert.doesNotMatch(JSON.stringify(combineLive({ project, runs: [odd], now: NOW }).lanes), /\u202e/);
});

test('a failed run: its failed jobs and error heads are real, it is not counted as live, and the failure shows in Recent', () => {
  const failing = run(RC, 'running', [job('T-9', 'codex', 'gpt', 'failed', { finishedAt: iso(60000), attempts: [{ status: 'failed' }, { status: 'failed' }] }), job('T-10', 'claude', 'sonnet', 'running')]);
  const d = combineLive({ project, runs: [failing], now: NOW });
  assert.equal(d.stats.failed, 1);
  assert.equal(d.stats.retries, 1);
  assert.equal(d.runs[0].failed, 1);
  const codex = d.lanes.find(l => l.lane === 'Codex');
  assert.equal(codex.agents[0].state, 'error');
  assert.equal(codex.agents[0].ended, iso(60000));
  const dead = run(RB, 'failed', [job('T-1', 'claude', 'sonnet', 'failed', { finishedAt: iso(120000) })]);
  const after = combineLive({ project, runs: [], finishedToday: [dead], now: NOW });
  assert.equal(after.recent[0].status, 'failed'); assert.equal(after.recent[0].failed, 1);
  assert.equal(after.empty !== null, true);
});

test('hostile text: a lane or job named __proto__ cannot pollute, job text is cleaned, a null job is skipped', () => {
  const evil = run(RA, 'running', [job('T-1', '__proto__', 'x', 'running'), null, job('constructor', 'claude', 'opus', 'running')]);
  const d = combineLive({ project, runs: [evil], now: NOW });
  const round = JSON.parse(JSON.stringify(d));
  assert.ok(round.lanes.some(l => l.lane === '__proto__' || l.lane.startsWith('__proto')), 'the lane is an ordinary entry');
  assert.equal(Object.keys(Object.prototype).length, 0);
  assert.equal(Object.getPrototypeOf(round.stats), Object.prototype);
  assert.equal(round.lanes.flatMap(l => l.agents).length, 2);
});

test('the combined map is capped, and says so', () => {
  const many = run(RA, 'running', Array.from({ length: 3200 }, (_, i) => job(`J-${i}`, 'claude', 'sonnet', 'queued')));
  const d = combineLive({ project, runs: [many], now: NOW });
  assert.equal(d.map.length, 3000);
  assert.equal(d.mapTruncated, true);
});

test('liveOverview reads only this project: its runs, spend today, cap, recent runs and last activity', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'live-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (id, state, manifest) => { const dir = path.join(root, '.swarm', 'runs', id); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state)); if (manifest) await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest)); };
  const now = Date.now(); const ago = ms => new Date(now - ms).toISOString();
  const mk = (id, status, jobs) => ({ id, status, startedAt: ago(900000), ...(status === 'running' ? {} : { finishedAt: ago(100000) }), jobs });
  const J = (id, status) => ({ id, agent: 'anthropic', model: 'claude-haiku-5-5', status, startedAt: ago(500000), finishedAt: status === 'running' ? undefined : ago(100000), costUsd: 0.1, attempts: [{}], progress: status === 'running' ? { lastOutputAt: ago(5000) } : undefined });
  await write(RA, mk(RA, 'running', [J('T-1', 'complete'), J('T-2', 'running')]), { goal: 'first' });
  await write(RB, mk(RB, 'running', [J('T-3', 'running')]), { goal: 'second' });
  await write(RC, mk(RC, 'complete', [J('T-4', 'complete')]));
  await write('1792000000000-old00000', { ...mk('1792000000000-old00000', 'complete', [J('T-0', 'complete')]), finishedAt: ago(3 * 86400000) });
  const d = await liveOverview({ id: 'p1', name: 'x', root }, [{ runId: RA }, { runId: RB }], { now, summary: async () => ({ capUsd: 5 }) });
  assert.equal(d.header.runsLive, 2);
  assert.equal(d.header.capUsd, 5);
  assert.equal(d.header.jobs.running, 2);
  assert.deepEqual(d.recent.map(r => r.runId), [RC], 'only runs that finished today');
  assert.ok(d.runs.every(r => r.goal));
  assert.equal(d.header.spendTodayUsd > 0, true);
  const idle = await liveOverview({ id: 'p1', name: 'x', root }, [], { now, summary: async () => ({ capUsd: null }) });
  assert.equal(idle.empty !== null, true);
  assert.ok(idle.empty.lastActivityAt);
  assert.equal(idle.header.noCap, true);
});

test('/api/live is read-only and token-protected, 404 for an unknown project, and the page serves', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'live-api-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'proj'); await fs.mkdir(path.join(root, '.swarm', 'runs', RA), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', RA, 'state.json'), JSON.stringify({ id: RA, status: 'running', startedAt: new Date().toISOString(), jobs: [{ id: 'T-1', agent: 'claude', model: 'sonnet', status: 'running', attempts: [{}] }] }));
  const { projectId } = await import('../tools/projects.mjs');
  const file = path.join(home, 'projects.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [{ id: projectId(root), name: 'proj', root, addedAt: new Date().toISOString(), lastSeen: new Date().toISOString() }] }));
  const env = { ...process.env, SWARM_PROJECTS_FILE: file, SWARM_HISTORY_FILE: path.join(home, 'h.ndjson'), SWARM_CONFIG: path.join(home, 'c.json'), SWARM_LANES_DIR: path.join(home, 'l'), SWARM_SPEND_DIR: path.join(home, 's') };
  const api = createBoardApi({ env, live: async () => [{ runId: RA, root: path.resolve(root), startedAt: new Date().toISOString() }] });
  const server = createWatchServer({ root: home, getRunSnapshot: async () => null, getPlanSnapshot: async () => ({ present: false }), getGallery: async () => ({ schema: 1, screens: [] }), getBoard: async () => ({ runs: [] }), board: api, indexName: 'board.html', commandList: [], contextCommands: () => [], assetDir: fileURLToPath(new URL('../tools/watch-assets/', import.meta.url)), deltaFile: fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url)) });
  const { url } = await server.listen();
  t.after(async () => { await server.close(); await api.close(); });
  const u = new URL(url); const id = projectId(root);
  const get = async p => fetch(`${u.origin}${p}`, { redirect: 'manual' });
  assert.equal((await get(`/api/live?id=${id}`)).status, 403);
  const ok = await get(`/api/live?id=${id}&t=${u.searchParams.get('t')}`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.header.runsLive, 1); assert.equal(body.lanes[0].agents[0].job, 'T-1');
  assert.equal((await get(`/api/live?id=nope&t=${u.searchParams.get('t')}`)).status, 404);
  assert.equal((await fetch(`${u.origin}/api/live?id=${id}&t=${u.searchParams.get('t')}`, { method: 'POST' })).status, 405);
  const page = await get(`/project?id=${id}&t=${u.searchParams.get('t')}`);
  assert.match(await page.text(), /id="pane-live"/);
  assert.equal((await get('/assets/project-live.js')).status, 200);
});

test('the Live tab page: tabs with Live first, controls named, no inline script, module and classic scripts present', async () => {
  const dir = new URL('../tools/watch-assets/', import.meta.url);
  const html = await fs.readFile(new URL('project.html', dir), 'utf8');
  assert.match(html, /role="tablist"/);
  assert.ok(html.indexOf('data-tab="live"') < html.indexOf('data-tab="overview"'));
  assert.match(html, /id="tab-live-btn"[^>]*aria-selected="true"/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
  assert.match(html, /<script type="module" src="assets\/project-live\.js">/);
  const js = await fs.readFile(new URL('project-live.js', dir), 'utf8');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.match(js, /\/open\/run\?id=/);
  // The head cap and reduced motion are the board's: heads come from robot-head.js, which owns the budget.
  assert.match(js, /from '\.\/robot-head\.js'/);
  assert.match(js, /reducedMotion\(\)/);
  // Review fixes: tabs update the address in place (Back must leave the page), time-based fields do not redraw the tab, a fetch has a limit, polling follows the visible tab,
  // run-file text never becomes a CSS class, and a failed first load says so.
  assert.match(js, /history\.replaceState/);
  assert.doesNotMatch(js, /location\.hash\s*=/);
  assert.match(js, /VOLATILE = \{[^}]*elapsedMs[^}]*etaMs[^}]*since/);
  assert.match(js, /AbortController/);
  assert.match(js, /\$\('pane-live'\)\.hidden/);
  assert.match(js, /STATE_COLORS\[j\.status\] \? j\.status : 'other'/);
  assert.match(js, /Project not found/);
});
