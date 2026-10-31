// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { boardSnapshot, historyEventsOf } from '../tools/board-data.mjs';
import { createWatchServer } from '../tools/watch-server.mjs';
import { ledgerPath } from '../tools/tickets.mjs';
import { parsePsTime, redactUrl } from '../tools/watch-perf.mjs';

const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));

async function fixture(t, { projectCount = 9, ticketCount = 400, runs = 0 } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'board-snapshot-perf-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const projects = [];
  const ledgers = [];
  const summaryCalls = new Map();
  const profile = [];
  const historyFile = path.join(base, 'history.jsonl');
  await fs.writeFile(historyFile, '');
  for (let p = 0; p < projectCount; p++) {
    const root = path.join(base, `project-${p}`);
    const file = ledgerPath(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const ledger = {
      schema: 1, approved: true, updatedAt: new Date().toISOString(),
      tickets: Array.from({ length: ticketCount }, (_, i) => ({
        id: `T-${i}`, title: `Ticket ${i}`, status: 'ready', stage: 'S1',
        outputs: [`src/ticket-${i}.js`], dependsOn: [],
      })),
    };
    await fs.writeFile(file, JSON.stringify(ledger));
    ledgers.push(ledger);
    projects.push({ id: `p${p}`, name: `Project ${p}`, root });
    for (let r = 0; r < runs; r++) {
      const dir = path.join(root, '.swarm', 'runs', `run-${r}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({
        status: 'complete', startedAt: new Date(Date.now() - (r + 1) * 1000).toISOString(),
        jobs: [{ id: `T-${r}`, agent: 'codex', status: 'complete' }],
      }));
    }
  }
  const options = {
    projects, liveRuns: [], historyFile,
    env: { ...process.env, SWARM_LANES_DIR: path.join(base, 'lanes') },
    summary: async root => {
      summaryCalls.set(root, (summaryCalls.get(root) ?? 0) + 1);
      return { spendUsd: 0, capUsd: null };
    },
    worktreeRoot: async () => null,
    profile: event => profile.push(event),
  };
  return {
    base, projects, ledgers, options, summaryCalls, profile,
    writeLedger: async i => fs.writeFile(ledgerPath(projects[i].root), JSON.stringify(ledgers[i])),
    build: async () => {
      const start = performance.now();
      const cpu = process.cpuUsage();
      const snapshot = await boardSnapshot(options);
      const usage = process.cpuUsage(cpu);
      return { snapshot, ms: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000 };
    },
  };
}

test('snapshot budget: unchanged projects reuse aggregates and a ticket edit rebuilds only its project', async t => {
  const f = await fixture(t);
  const cold = await f.build();
  assert.ok(cold.ms < 3000, `cold snapshot ${cold.ms.toFixed(1)}ms exceeds 3s`);
  assert.equal(cold.snapshot.projects.length, 9);
  assert.ok(cold.snapshot.projects.every(p => p.tickets.total === 400));
  // The board enriches cards, removes transcript paths and appends worktree
  // labels. None of that may mutate the stored project value.
  cold.snapshot.projects[0].card.next.ready = -1;
  f.profile.length = 0;
  const warm = await f.build();
  assert.ok(warm.ms < 100, `unchanged snapshot ${warm.ms.toFixed(1)}ms exceeds 100ms`);
  assert.ok(warm.snapshot.projects.every(p => p.card.next.ready === 400));
  assert.equal(f.profile.filter(e => e.kind === 'project' && e.cached).length, 9);
  assert.deepEqual([...f.summaryCalls.values()], new Array(9).fill(1));

  f.ledgers[3].tickets[0].status = 'done';
  await f.writeLedger(3);
  f.profile.length = 0;
  const changed = await f.build();
  const project = changed.snapshot.projects.find(p => p.id === 'p3');
  assert.equal(project.tickets.byStatus.done, 1);
  assert.equal(project.card.next.ready, 399);
  assert.deepEqual(f.profile.filter(e => e.kind === 'project' && !e.cached).map(e => e.id), ['p3']);
  assert.equal(f.summaryCalls.get(f.projects[3].root), 2);
  assert.ok([...f.summaryCalls].every(([root, n]) => root === f.projects[3].root || n === 1));

  // Global history invalidates every dependent progress summary immediately.
  await fs.appendFile(f.options.historyFile, '{}\n');
  const before = [...f.summaryCalls.values()].reduce((a, b) => a + b, 0);
  await f.build();
  assert.equal([...f.summaryCalls.values()].reduce((a, b) => a + b, 0), before + 9);
  t.diagnostic(JSON.stringify({ coldMs: cold.ms, warmMs: warm.ms, changedMs: changed.ms,
    coldCpuMs: cold.cpuMs, warmCpuMs: warm.cpuMs }));
});

test('run edits, new/deleted runs and same-size atomic ledger replacements invalidate immediately', async t => {
  const f = await fixture(t, { projectCount: 2, ticketCount: 4, runs: 2 });
  await f.build();
  const file = path.join(f.projects[0].root, '.swarm', 'runs', 'run-0', 'state.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.status = 'failed';
  await fs.writeFile(file, JSON.stringify(state));
  let result = await f.build();
  assert.equal(result.snapshot.projects.find(p => p.id === 'p0').recentFailure, true);
  assert.equal(f.summaryCalls.get(f.projects[1].root), 1);

  const newDir = path.join(f.projects[0].root, '.swarm', 'runs', 'new-run');
  await fs.mkdir(newDir);
  await fs.writeFile(path.join(newDir, 'state.json'), JSON.stringify({ status: 'running', startedAt: new Date().toISOString(), jobs: [] }));
  result = await f.build();
  assert.equal(result.snapshot.projects.find(p => p.id === 'p0').lastRunStatus, 'running');
  await fs.rm(newDir, { recursive: true });
  result = await f.build();
  assert.equal(result.snapshot.projects.find(p => p.id === 'p0').lastRunStatus, 'failed');

  f.ledgers[1].tickets[0].status = 'blocked';
  await f.writeLedger(1);
  await f.build();
  const ledgerFile = ledgerPath(f.projects[1].root);
  const info = await fs.stat(ledgerFile);
  f.ledgers[1].tickets[0].status = 'running'; // same byte length
  await fs.writeFile(`${ledgerFile}.replacement`, JSON.stringify(f.ledgers[1]));
  await fs.utimes(`${ledgerFile}.replacement`, info.atime, info.mtime);
  await fs.rename(`${ledgerFile}.replacement`, ledgerFile);
  result = await f.build();
  assert.equal(result.snapshot.projects.find(p => p.id === 'p1').tickets.byStatus.running, 1);
  assert.equal(result.snapshot.projects.find(p => p.id === 'p1').tickets.byStatus.blocked, undefined);
});

test('history aggregates invalidate on ticket completion and do not share mutable rows', async t => {
  const f = await fixture(t, { projectCount: 1, ticketCount: 2 });
  const first = await historyEventsOf(f.projects[0]);
  first.push({ kind: 'poison' });
  assert.ok(!(await historyEventsOf(f.projects[0])).some(e => e.kind === 'poison'));
  for (const ticket of f.ledgers[0].tickets) ticket.status = 'done';
  await f.writeLedger(0);
  assert.ok((await historyEventsOf(f.projects[0])).some(e => e.kind === 'stage'));
});

test('ps time formats retain fractional seconds and URLs retain token redaction', () => {
  for (const [input, expected] of [['0:00.37', 0.37], ['2:03.45', 123.45],
    ['1:02:03.45', 3723.45], ['12.75', 12.75], [' 123 ', 123], ['2-01:02:03.45', 176523.45],
    ['', 0], ['garbage', 0], ['1:2oops', 0]]) {
    assert.ok(Math.abs(parsePsTime(input) - expected) < 1e-8, input);
  }
  assert.equal(redactUrl('http://localhost/?t=secret&view=board'), 'http://localhost/?t=…&view=board');
});

function request(server, route, etag) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(route, server.url), {
      headers: { 'x-watch-token': server.token, ...(etag ? { 'if-none-match': etag } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

async function startServer(t, f, now = Date.now) {
  const assetDir = path.join(f.base, 'assets');
  await fs.mkdir(assetDir);
  let builds = 0;
  const server = createWatchServer({
    root: f.base, assetDir, deltaFile, now, commandCenter: true,
    getRunSnapshot: async () => null, getPlanSnapshot: async () => null,
    getGallery: async () => ({}), commandList: [], contextCommands: () => [],
    env: f.options.env,
    board: { snapshot: async () => { builds++; return boardSnapshot({ ...f.options, now: now() }); } },
  });
  await server.listen();
  t.after(() => server.close());
  return { server, builds: () => builds };
}

test('six-second HTTP cache preserves ETags, shares concurrent requests and never hides ticket edits', async t => {
  const f = await fixture(t, { projectCount: 2, ticketCount: 20 });
  let now = Date.now();
  const s = await startServer(t, f, () => now);
  const first = await request(s.server, '/api/command-center');
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-content-type-options'], 'nosniff');
  assert.match(first.headers['content-security-policy'], /frame-ancestors 'none'/);
  now += 5000;
  const warm = await request(s.server, '/api/command-center', first.headers.etag);
  assert.equal(warm.status, 304);
  assert.equal(s.builds(), 1, 'a five-second poll must reuse the HTTP representation');
  f.ledgers[0].tickets[0].status = 'done';
  await f.writeLedger(0);
  const changed = await request(s.server, '/api/command-center', first.headers.etag);
  assert.equal(changed.status, 200);
  assert.equal(JSON.parse(changed.body).projects.find(p => p.id === 'p0').ticketCounts.done, 1);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.equal(s.builds(), 2);
  const cockpit = await request(s.server, '/api/command-center/project?id=p0');
  assert.equal(JSON.parse(cockpit.body).done, 1);
  f.ledgers[0].tickets[1].status = 'done';
  await f.writeLedger(0);
  const cockpitChanged = await request(s.server, '/api/command-center/project?id=p0', cockpit.headers.etag);
  assert.equal(JSON.parse(cockpitChanged.body).done, 2);
  now += 6001;
  const before = s.builds();
  const responses = await Promise.all(Array.from({ length: 6 }, () => request(s.server, '/api/command-center')));
  assert.ok(responses.every(res => res.status === 200));
  assert.equal(s.builds(), before + 1, 'expired concurrent requests must share the rebuild');
});

test('nine-project server stays below 5% CPU while polled every five seconds', { timeout: 60000 }, async t => {
  const f = await fixture(t, { runs: 12 });
  const s = await startServer(t, f);
  const start = performance.now();
  const first = await request(s.server, '/api/command-center');
  const coldMs = performance.now() - start;
  const cpu = process.cpuUsage();
  const idleStart = performance.now();
  let etag = first.headers.etag;
  let maxPollMs = 0;
  for (let i = 1; i <= 9; i++) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, idleStart + i * 5000 - performance.now())));
    const pollStart = performance.now();
    const response = await request(s.server, '/api/command-center', etag);
    maxPollMs = Math.max(maxPollMs, performance.now() - pollStart);
    assert.ok(response.status === 200 || response.status === 304);
    etag = response.headers.etag;
  }
  const elapsedMs = performance.now() - idleStart;
  const usage = process.cpuUsage(cpu);
  const cpuMs = (usage.user + usage.system) / 1000;
  const cpuPercent = cpuMs / elapsedMs * 100;
  t.diagnostic(JSON.stringify({ synthetic: true, projects: 9, tickets: 3600, runs: 108,
    coldHttpMs: coldMs, maxPollMs, cpuMs, elapsedMs, cpuPercent, builds: s.builds() }));
  assert.ok(cpuPercent < 5, `polling used ${cpuPercent.toFixed(2)}% CPU`);
});
