// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWatchServer } from '../tools/watch-server.mjs';
import { createBoardInputDetector } from '../tools/board-data.mjs';
import { buildCommandCenterSnapshot, patchCommandCenterSnapshot } from '../tools/command-center-snapshot.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const json = async (file, body) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(body)); };
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const settle = () => new Promise(resolve => setImmediate(resolve));

test('ticket, inbox and run changes push within one tick and refresh only that cached project', { timeout: 15000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-live-'));
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const roots = ['alpha', 'beta'].map(id => path.join(dir, id));
  const tickets = root => path.join(root, '.swarm/project/tickets.json');
  const inbox = root => path.join(root, '.swarm/inbox/state.json');
  const run = root => path.join(root, '.swarm/runs/123/state.json');
  for (const root of roots) {
    await json(tickets(root), { tickets: [{ id: 'T1', title: 'Build', status: 'running' }] });
    await json(inbox(root), { needsYou: 0 });
    await json(run(root), { status: 'running', jobs: [{ status: 'running' }] });
  }
  let builds = 0;
  const projectReads = [];
  async function project(id) {
    const root = roots[id === 'alpha' ? 0 : 1];
    const ledger = await read(tickets(root));
    const need = await read(inbox(root));
    const state = await read(run(root));
    const byStatus = {};
    for (const ticket of ledger.tickets) byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1;
    return { id, name: id, root, machine: os.hostname(), ledger,
      tickets: { byStatus }, agents: { total: state.status === 'running' ? 1 : 0 },
      card: { now: { buildingTickets: byStatus.running ?? 0 }, blocked: { needYou: need.needsYou } } };
  }
  const server = createWatchServer({ root: dir, commandCenter: true,
    assetDir: path.join(repo, 'tools/watch-assets'), deltaFile: path.join(repo, 'tools/watch-delta.mjs'),
    getRunSnapshot: async () => null,
    board: {
      async snapshot() { builds++; return { at: new Date().toISOString(), machine: { agents: { total: 2 } }, projects: await Promise.all(['alpha', 'beta'].map(project)) }; },
      async project(id) { projectReads.push(id); return project(id); },
    },
  });
  t.after(() => server.close());
  const { url, port } = await server.listen();
  const origin = new URL(url).origin;
  const auth = { 'x-watch-token': server.token };
  const full = () => fetch(`${origin}/api/command-center`, { headers: auth });
  const cold = await (await full()).json();
  assert.equal(builds, 1);
  const page = await fetch(`${origin}/command-center?t=${server.token}`);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, new RegExp(`^swarm_watch_${port}=`));
  for (const suffix of ['', `?t=${server.token}`]) {
    assert.equal((await fetch(`${origin}/api/command-center/events${suffix}`)).status, 403);
  }
  assert.equal((await fetch(`${origin}/api/command-center/events`, { headers: { cookie: cookie.replace(server.token, 'wrong') } })).status, 403);
  assert.equal((await fetch(`${origin}/api/command-center/events`, { method: 'POST', headers: auth })).status, 405);
  const head = await fetch(`${origin}/api/command-center/events`, { method: 'HEAD', headers: auth });
  assert.equal(head.status, 200);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${origin}/api/command-center/events`, { headers: { cookie }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(new URL(response.url).search, '');
  const reader = response.body.getReader();
  let buffer = '';
  let transcript = '';
  async function nextChange() {
    while (true) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith('event: cc-change\n')) return JSON.parse(frame.split('\ndata: ')[1]);
      } else {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        const text = new TextDecoder().decode(chunk.value);
        buffer += text; transcript += text;
      }
    }
  }
  const latencies = [];
  async function change(write) {
    const start = performance.now();
    await write();
    const event = await nextChange();
    const latency = performance.now() - start;
    latencies.push(Math.round(latency));
    assert.ok(latency < 1800, `event took ${latency}ms`);
    assert.deepEqual(event.projects, ['alpha']);
    assert.equal(event.kind, 'cc-change');
    assert.ok(Number.isFinite(Date.parse(event.at)));
    return (await full()).json();
  }
  const done = await change(() => json(tickets(roots[0]), { tickets: [{ id: 'T1', title: 'Build', status: 'done', doneAt: new Date().toISOString() }] }));
  assert.equal(done.projects[0].ticketCounts.done, 1);
  assert.equal(done.hive.doneLast24h, 1);
  assert.deepEqual(done.projects[1], cold.projects[1]);
  const needs = await change(() => json(inbox(roots[0]), { needsYou: 2 }));
  assert.equal(needs.stats.needsYouCount.value, 2);
  assert.equal(needs.projects[0].needsYou.value, 2);
  const failed = await change(() => json(run(roots[0]), { status: 'failed', jobs: [{ status: 'failed' }] }));
  assert.equal(failed.stats.agentsLive.value, 1);
  assert.equal(failed.projects[0].liveAgents.value, 0);
  assert.equal(builds, 1, 'changes do not rebuild the full board');
  assert.deepEqual(projectReads, ['alpha', 'alpha', 'alpha']);
  const cockpit = await (await fetch(`${origin}/api/command-center/project?id=alpha`, { headers: auth })).json();
  assert.equal(cockpit.ledger.tickets[0].status, 'done');
  assert.equal(cockpit.card.needsYou.value, 2);
  assert.equal(cockpit.hive.doneLast24h, 1);
  assert.ok(!transcript.includes(server.token));
  assert.ok(!logs.join('\n').includes(server.token));
  assert.ok(!JSON.stringify(failed).includes(server.token));
  t.diagnostic(`ticket/inbox/run event latency ms: ${latencies.join(', ')}; full builds: ${builds}`);
  controller.abort();
});

test('shared lane/history changes identify their project and partial reads are retried', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-shared-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lanesFile = path.join(dir, 'lanes.json');
  const historyFile = path.join(dir, 'history.ndjson');
  await json(lanesFile, { slots: {} });
  await fs.writeFile(historyFile, '');
  const detector = createBoardInputDetector({ lanesFile, historyFile });
  const projects = ['a', 'b'].map(id => ({ id, root: path.join(dir, id) }));
  assert.deepEqual(await detector.scan(projects), []);
  await json(lanesFile, { slots: { codex: [{ project: 'a', pid: 123 }] } });
  assert.deepEqual(await detector.scan(projects), ['a']);
  await fs.appendFile(historyFile, JSON.stringify({ projectId: 'b', kind: 'run', at: new Date().toISOString() }) + '\n');
  assert.deepEqual(await detector.scan(projects), ['b']);
  await fs.writeFile(lanesFile, '{');
  await json(path.join(projects[0].root, '.swarm/project/tickets.json'), { tickets: [{ id: 'T', status: 'done' }] });
  await assert.rejects(detector.scan(projects), SyntaxError);
  await json(lanesFile, { slots: { codex: [{ project: 'a', pid: 123 }] } });
  assert.deepEqual(await detector.scan(projects), ['a']);
  assert.deepEqual(await detector.scan(projects), []);
});

test('metadata detects creation, atomic replacement, deletion and project-family ownership', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-inputs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const detector = createBoardInputDetector();
  const projects = [{ id: 'parent', root: dir }, { id: 'child', root: dir }];
  assert.deepEqual(await detector.scan(projects), []);
  const file = path.join(dir, '.swarm/runs/new/state.json');
  await json(file, { status: 'running' });
  assert.deepEqual((await detector.scan(projects)).sort(), ['child', 'parent']);
  assert.deepEqual(await detector.scan(projects), []);
  await json(`${file}.tmp`, { status: 'failed' });
  await fs.rename(`${file}.tmp`, file);
  assert.deepEqual((await detector.scan(projects)).sort(), ['child', 'parent']);
  await fs.rm(file);
  assert.deepEqual((await detector.scan(projects)).sort(), ['child', 'parent']);
});

test('incremental snapshot preserves unrelated cards and clears stale throughput/events', () => {
  const board = { at: new Date().toISOString(), projects: [
    { id: 'a', card: { blocked: { needYou: 1 } }, ledger: { tickets: [{ id: 'T', status: 'done', doneAt: new Date().toISOString() }] } },
    { id: 'b', card: { blocked: { needYou: 0 } } },
  ] };
  const snapshot = buildCommandCenterSnapshot(board);
  const unchanged = snapshot.projects[1];
  board.projects[0].ledger.tickets[0].status = 'running';
  board.projects[0].card.blocked.needYou = 0;
  patchCommandCenterSnapshot(snapshot, board, ['a']);
  assert.equal(snapshot.projects[1], unchanged);
  assert.equal(snapshot.stats.needsYouCount.value, 0);
  assert.equal(snapshot.hive.doneLast24h, undefined);
  assert.equal(snapshot.hive.events, undefined);
});

test('SSE client patches cards, counters and cockpit without fetching a full snapshot; visibility and polling survive', async t => {
  process.env.SWARM_COMMAND_CENTER_BOOT_TEST = '1';
  const { mountCommandCenter } = await import('../tools/watch-assets/command-center-boot.js');
  const oldData = globalThis.CommandCenterData;
  globalThis.CommandCenterData = { parseCommandCenterSnapshot: body => body };
  t.after(() => { globalThis.CommandCenterData = oldData; });
  const listeners = new Map();
  const document = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  let clears = 0;
  const root = { replaceChildren: () => clears++, setAttribute() {} };
  const sources = [];
  class EventSource {
    constructor(url) { this.url = url; this.handlers = new Map(); sources.push(this); }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    close() { this.closed = true; }
    send(ids) { this.handlers.get('cc-change')({ data: JSON.stringify({ kind: 'cc-change', projects: ids }) }); }
  }
  const requests = [];
  let pendingFull = null;
  let needs = 0;
  const card = id => ({ id, name: id, needsYou: { value: needs } });
  const full = () => ({ at: new Date().toISOString(), projects: [card('a'), card('b')], stats: { needsYouCount: { value: needs } }, hive: { doneLast24h: needs } });
  const project = id => ({ id, ledger: { tickets: [] }, card: card(id), stats: full().stats, hive: full().hive, at: full().at });
  const patches = [];
  let mountedBody;
  const cockpitPatches = [];
  const intervals = new Map();
  const location = { pathname: '/command-center', search: '?t=secret-bootstrap-token' };
  const mount = mountCommandCenter(root, { document, location, EventSource,
    history: { pushState(_a, _b, value) { location.pathname = value; } },
    fetchJson: async url => { requests.push(url); return url === '/api/command-center' ? pendingFull ?? full() : project(new URL(url, 'http://local').searchParams.get('id')); },
    renderHive: (_root, _snapshot, deps) => { mountedBody = deps.rawSnapshot; return { update: (parsed, raw) => patches.push(structuredClone(raw)), destroy() {} }; },
    loadCockpit: async () => ({ renderProjectCockpit: () => ({ update: body => cockpitPatches.push(body), destroy() {} }) }),
    loadTour: async () => ({ maybeStartFirstVisit() {} }),
    setTimeout: () => 1, clearTimeout() {}, setInterval: (fn, ms) => { intervals.set(ms, fn); return ms; }, clearInterval: id => intervals.delete(id),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, matchMedia: () => ({ matches: true }),
  });
  t.after(() => mount.destroy());
  await mount.whenReady;
  assert.equal(sources[0].url, '/api/command-center/events');
  const initialClears = clears;
  needs = 3;
  sources[0].send(['a']);
  await settle();
  assert.deepEqual(requests, ['/api/command-center', '/api/command-center/project?id=a']);
  assert.equal(clears, initialClears);
  assert.equal(patches.at(-1).projects[0].needsYou.value, 3);
  assert.equal(mountedBody.projects[0].needsYou.value, 0, 'patches preserve the previous render data for comparison');
  assert.equal(patches.at(-1).stats.needsYouCount.value, 3);
  assert.equal(patches.at(-1).hive.doneLast24h, 3);
  assert.equal(patches.at(-1).projects[1].needsYou.value, 0);
  let finishPoll;
  const stale = { ...full(), at: '2000-01-01T00:00:00.000Z' };
  pendingFull = new Promise(resolve => { finishPoll = resolve; });
  const poll = intervals.get(5000)();
  needs = 5;
  sources[0].send(['a']);
  await settle();
  finishPoll(stale);
  await poll;
  pendingFull = null;
  assert.equal(patches.at(-1).stats.needsYouCount.value, 5, 'a delayed poll cannot overwrite a newer event patch');
  location.pathname = '/command-center/project/a';
  await mount.refresh();
  needs = 4;
  sources[0].send(['a']);
  await settle();
  assert.equal(cockpitPatches.at(-1).card.needsYou.value, 4);
  assert.equal(requests.filter(url => url === '/api/command-center').length, 2);
  await intervals.get(5000)();
  assert.equal(cockpitPatches.at(-1).card.needsYou.value, 4, 'poll remains available without SSE');
  document.hidden = true;
  listeners.get('visibilitychange')();
  assert.equal(sources[0].closed, true);
  assert.equal(intervals.size, 0);
  document.hidden = false;
  listeners.get('visibilitychange')();
  await settle();
  assert.equal(sources.length, 2);
  mount.destroy();
  assert.equal(sources[1].closed, true);
  assert.ok(requests.every(url => !url.includes('secret-bootstrap-token')));
});
