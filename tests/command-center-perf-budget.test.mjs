// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createWatchServer, watchAssetCacheControl } from '../tools/watch-server.mjs';

const assets = new URL('../tools/watch-assets/', import.meta.url);
const source = name => readFile(new URL(name, assets), 'utf8');

test('ambient work caps at 30 fps, sleeps after 5 seconds, and pauses hidden, offscreen and reduced motion', async () => {
  const { mountAmbientMotion } = await import('../tools/watch-assets/cc-hive-stage.js');
  const events = new Map();
  const frames = new Map();
  let id = 0;
  let draws = 0;
  let intersect;
  const media = { matches: false, addEventListener(_name, fn) { this.change = fn; }, removeEventListener() {} };
  const doc = { hidden: false, addEventListener: (n, fn) => events.set(n, fn), removeEventListener: n => events.delete(n) };
  const win = { IntersectionObserver: class { constructor(fn) { intersect = fn; } observe() {} disconnect() {} } };
  const motion = mountAmbientMotion({ element: {}, doc, win, media,
    raf: fn => { frames.set(++id, fn); return id; }, caf: n => frames.delete(n), draw: () => draws++ });
  const step = ts => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(ts)); };
  for (let ts = 0; ts <= 1000; ts += 5) step(ts);
  assert.ok(draws <= 31, `${draws} draws in one second`);
  step(5001);
  assert.equal(frames.size, 0, 'idle has no pending animation callback');
  events.get('pointermove')();
  assert.equal(frames.size, 1);
  intersect([{ isIntersecting: false }]);
  assert.equal(frames.size, 0);
  intersect([{ isIntersecting: true }]);
  assert.equal(frames.size, 1);
  doc.hidden = true; events.get('visibilitychange')();
  assert.equal(frames.size, 0);
  doc.hidden = false; events.get('visibilitychange')();
  assert.equal(frames.size, 1);
  media.matches = true; media.change();
  assert.equal(frames.size, 0);
  motion.destroy();
  assert.equal(events.size, 0);
});

// Optional real-browser measurement. Keep this in the fixture test so no production server or board is needed.
test('desktop Chromium nine-project idle CPU and navigation fixture', { skip: !process.env.SWARM_CC_BROWSER_PERF }, async t => {
  const { chromium } = await import('playwright');
  const board = { at: '2026-10-30T12:00:00Z', machine: { agents: { total: 9 } }, projects: Array.from({ length: 9 }, (_, i) => ({
    id: `project-${i}`, name: `Project ${i}`, machine: 'fixture', agents: { total: 1 },
    ledger: { tickets: Array.from({ length: 40 }, (_, j) => ({ id: `T-${j}`, title: `Ticket ${j}`, stage: 'S1', status: j < 20 ? 'done' : j === 20 ? 'running' : 'ready' })) },
    orchestrator: { sessions: [] },
  })) };
  const srv = createWatchServer({ root: fileURLToPath(assets), assetDir: fileURLToPath(assets),
    deltaFile: fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url)), commandCenter: true, board: { snapshot: async () => board } });
  const { port } = await srv.listen();
  t.after(() => srv.close());
  const browser = await chromium.launch({ headless: true,
    ...(process.env.SWARM_CC_CHROMIUM ? { executablePath: process.env.SWARM_CC_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const robotRequests = [];
  page.on('request', request => { if (/\/robot-[^/]+\.js/.test(request.url())) robotRequests.push(request.url()); });
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(`http://127.0.0.1:${port}/command-center?t=${srv.token}&tour=0`);
  await page.waitForSelector('.hive-node');
  const session = await browser.newBrowserCDPSession();
  const cpu = async () => (await session.send('SystemInfo.getProcessInfo')).processInfo.filter(p => p.type === 'renderer').reduce((sum, p) => sum + p.cpuTime, 0);
  const before = await cpu();
  const started = performance.now();
  await new Promise(resolve => setTimeout(resolve, 45000));
  const idleCpu = ((await cpu()) - before) / ((performance.now() - started) / 1000) * 100;
  const runningAnimations = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').map(a => ({ name: a.animationName, target: a.effect?.target?.className })));
  const visibleLaneHeads = await page.evaluate(() => [...document.querySelectorAll('[data-lane]')].some(node => {
    const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight;
  }));
  if (!visibleLaneHeads) assert.deepEqual(robotRequests, [], 'Hive without visible lane heads never loads the 3D robot graph');
  assert.deepEqual(runningAnimations, [], 'idle CSS also holds its composed frame');
  const switchMs = await page.evaluate(async () => {
    const started = performance.now();
    document.querySelector('.hive-node').click();
    while (!document.querySelector('.cc-cockpit-shell h1')) await new Promise(requestAnimationFrame);
    return performance.now() - started;
  });
  const backMs = await page.evaluate(async () => {
    const started = performance.now(); document.querySelector('.cc-cockpit-back-btn').click();
    while (!document.querySelector('.hive-node')) await new Promise(requestAnimationFrame);
    return performance.now() - started;
  });
  t.diagnostic(JSON.stringify({ idleCpuPercent: idleCpu, switchMs, backMs, runningAnimations, visibleLaneHeads, errors }));
  const reconciliation = await page.evaluate(async () => {
    const { renderProjectCockpit } = await import('/assets/cc-cockpit-mount.js');
    const token = new URL(location.href).searchParams.get('t');
    const project = await fetch('/api/command-center/project?id=project-0', { headers: { 'x-watch-token': token } }).then(r => r.json());
    const host = document.createElement('div'); document.body.appendChild(host);
    const decoration = [];
    const view = renderProjectCockpit(host, project, { document, now: () => Date.parse('2026-10-30T12:00:00Z'), matchMedia: () => ({ matches: true }),
      setTimeout: (fn, ms) => { decoration.push({ fn, ms }); return decoration.length; }, clearTimeout() {} });
    const shellBeforeDecoration = Boolean(host.querySelector('h1')) && !host.querySelector('.pxc');
    decoration.filter(timer => timer.ms === 0).forEach(timer => timer.fn());
    await Promise.resolve();
    const title = host.querySelector('h1');
    const card = host.querySelector('[data-ticket-id]');
    const observer = new MutationObserver(() => {});
    observer.observe(host, { attributes: true, childList: true, characterData: true, subtree: true });
    view.update(structuredClone(project));
    const unchangedMutations = observer.takeRecords().length;
    const changed = structuredClone(project); changed.name = 'Renamed project';
    view.update(changed);
    const result = { shellBeforeDecoration, decorated: Boolean(host.querySelector('.pxc')), unchangedMutations, titleRetained: title === host.querySelector('h1'), cardRetained: card === host.querySelector('[data-ticket-id]'), title: title.textContent };
    changed.ledger.tickets.find(ticket => ticket.id === card.dataset.ticketId).title = 'Updated ticket title';
    view.update(changed);
    result.changedCardRetained = card === host.querySelector(`[data-ticket-id="${card.dataset.ticketId}"]`);
    result.changedTitleBound = card.getAttribute('data-title') === 'Updated ticket title'
      && card.textContent.toLowerCase().includes('updated ticket title');
    observer.disconnect(); view.destroy(); host.remove();
    return result;
  });
  assert.deepEqual(reconciliation, { shellBeforeDecoration: true, decorated: true, unchangedMutations: 0, titleRetained: true, cardRetained: true, title: 'RENAMED PROJECT', changedCardRetained: true, changedTitleBound: true });
  assert.equal(robotRequests.some(url => /robot-(render|geometry|sim)\.js/.test(url)), false, 'Cockpit shell and pixel decoration never await the 3D graph');
  await page.evaluate(async () => {
    const { mountRobotHead } = await import('/assets/robot-head.js');
    const host = document.createElement('div'); host.id = 'perf-visible-head';
    host.style.cssText = 'position:fixed;top:10px;left:10px;width:56px;height:56px'; document.body.appendChild(host);
    window.perfVisibleHead = mountRobotHead(host, { state: 'working' });
  });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#perf-visible-head canvas'); return canvas && canvas.width !== 300;
  });
  await page.evaluate(() => { window.perfVisibleHead.setState('error'); window.perfVisibleHead.destroy(); document.querySelector('#perf-visible-head').remove(); delete window.perfVisibleHead; });
  assert.deepEqual(errors, []);
  if (!process.env.SWARM_CC_PERF_BASELINE) {
    assert.ok(idleCpu < 5, `idle renderer CPU ${idleCpu.toFixed(2)}%`);
    assert.ok(switchMs < 150, `Cockpit shell ${switchMs.toFixed(2)}ms`);
  }
});

function request(port, pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fixture(t, extra = {}) {
  let clock = Date.parse('2026-10-30T12:00:00Z');
  let revision = 1;
  let reads = 0;
  let runReads = 0;
  const optionsSeen = [];
  const timers = [];
  const srv = createWatchServer({
    root: fileURLToPath(assets), assetDir: fileURLToPath(assets),
    deltaFile: fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url)),
    commandCenter: true, now: () => clock,
    getRunSnapshot: async () => { runReads++; return null; },
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearIntervalFn() {},
    board: {
      snapshot: async options => {
        reads++;
        optionsSeen.push(options);
        return { version: revision, at: '2026-10-30T12:00:00Z', projects: [{
          id: 'alpha', name: `${options.local ? 'Local' : 'All'} ${revision}`,
          agents: { total: 0 }, ledger: { tickets: [] },
        }] };
      },
    }, ...extra,
  });
  const { port } = await srv.listen();
  t.after(() => srv.close());
  return {
    get: (pathname, headers = {}, method) => request(port, pathname, { 'x-watch-token': srv.token, ...headers }, method),
    advance: ms => { clock += ms; }, revise: () => { revision++; },
    reads: () => reads, runReads: () => runReads, optionsSeen, timers,
  };
}

test('assets use strong validators, Last-Modified, 304 precedence and HEAD', async t => {
  const f = await fixture(t);
  const initial = await f.get('/assets/command-center-boot.js');
  assert.equal(initial.status, 200);
  assert.match(initial.headers.etag, /^"[a-f0-9]+"$/);
  assert.ok(Date.parse(initial.headers['last-modified']));
  for (const headers of [
    { 'if-none-match': initial.headers.etag },
    { 'if-none-match': `"other", W/${initial.headers.etag}` },
    { 'if-modified-since': initial.headers['last-modified'] },
  ]) {
    const result = await f.get('/assets/command-center-boot.js', headers);
    assert.equal(result.status, 304);
    assert.equal(result.body.length, 0);
    assert.equal(result.headers.vary, 'Accept-Encoding');
  }
  assert.equal((await f.get('/assets/command-center-boot.js', {
    'if-none-match': '"stale"', 'if-modified-since': initial.headers['last-modified'],
  })).status, 200);
  const head = await f.get('/assets/command-center-boot.js', {}, 'HEAD');
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), initial.body.length);
});

test('gzip is negotiated and cached with a distinct strong validator; binaries stay unchanged', async t => {
  const f = await fixture(t);
  const plain = await f.get('/assets/command-center-boot.js');
  const zipped = await f.get('/assets/command-center-boot.js', { 'accept-encoding': 'br, gzip' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(zipped.body), plain.body);
  assert.ok(zipped.body.length < plain.body.length * 0.4);
  assert.notEqual(zipped.headers.etag, plain.headers.etag);
  assert.equal(Number(zipped.headers['content-length']), zipped.body.length);
  assert.equal((await f.get('/assets/command-center-boot.js', {
    'accept-encoding': 'gzip', 'if-none-match': zipped.headers.etag,
  })).status, 304);
  assert.equal((await f.get('/assets/command-center-boot.js', {
    'accept-encoding': 'gzip;q=0, *;q=1',
  })).headers['content-encoding'], undefined);
  const binary = await f.get('/assets/vendor/fluent-emoji/high_voltage_56.webp', { 'accept-encoding': 'gzip' });
  assert.equal(binary.status, 200);
  assert.equal(binary.headers['content-encoding'], undefined);
  t.diagnostic(`boot JS ${plain.body.length} bytes -> ${zipped.body.length} gzip bytes`);
});

test('cache policies distinguish fonts, vendor, JS/CSS, HTML and JSON', async t => {
  const f = await fixture(t);
  for (const name of ['font.woff2', 'font.woff', 'font.ttf', 'vendor/module.js', 'vendor/icon.webp']) {
    assert.equal(watchAssetCacheControl(name), 'public, max-age=31536000, immutable');
  }
  for (const pathname of ['/assets/command-center-boot.js', '/assets/cc-hive.css']) {
    assert.equal((await f.get(pathname)).headers['cache-control'], 'public, max-age=300, must-revalidate');
  }
  for (const pathname of ['/command-center', '/api/command-center']) {
    const res = await f.get(pathname, { 'accept-encoding': 'gzip' });
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.headers.vary, 'Accept-Encoding');
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.ok(res.headers.etag);
  }
});

async function waitForResponse(get, predicate) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const response = await get();
    if (predicate(response)) return response;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('snapshot did not refresh within five seconds');
}

test('one snapshot shares Hive, Cockpit and arbitrary queries through idle TTL expiry until a deep refresh', async t => {
  const f = await fixture(t, { snapshotMaxStaleMs: 120000 });
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.get('/api/command-center')));
  assert.equal(f.reads(), 1);
  const tag = responses[0].headers.etag;
  assert.equal((await f.get('/api/command-center', { 'if-none-match': tag })).status, 304);
  for (let i = 0; i < 20; i++) {
    const response = await f.get('/api/command-center?view=' + i);
    assert.deepEqual(response.body, responses[0].body);
  }
  const project = await f.get('/api/command-center/project?id=alpha');
  assert.equal(JSON.parse(project.body).id, 'alpha');
  assert.equal((await f.get('/api/command-center/project?id=alpha', { 'if-none-match': project.headers.etag })).status, 304);
  assert.equal((await f.get('/api/command-center/project?id=missing')).status, 404);
  assert.equal(f.reads(), 1, 'all ids and query strings share the board snapshot');
  assert.deepEqual(f.optionsSeen, [{ local: false, redact: true }]);
  f.revise();
  f.advance(59999);
  assert.equal((await f.get('/api/command-center', { 'if-none-match': tag })).status, 304);
  assert.equal(f.reads(), 1, 'fresh for the entire 60 second TTL');
  f.advance(1);
  const stale = await f.get('/api/command-center', { 'if-none-match': tag });
  assert.equal(stale.status, 304, 'the first expired request still uses the old validator');
  assert.equal(f.reads(), 1, 'idle TTL expiry does not start a full rebuild');
  assert.deepEqual((await f.get('/api/command-center')).body, responses[0].body);
  assert.equal((await f.get('/api/command-center/project?id=alpha', { 'if-none-match': project.headers.etag })).status, 304);
  assert.equal(f.reads(), 1, 'idle TTL expiry does not rebuild');
  f.advance(59999);
  assert.equal((await f.get('/api/command-center', { 'if-none-match': tag })).status, 304);
  assert.equal(f.reads(), 1, 'idle requests do not rebuild before the deep refresh boundary');
  f.advance(1);
  assert.equal((await f.get('/api/command-center', { 'if-none-match': tag })).status, 304);
  const changed = await waitForResponse(() => f.get('/api/command-center', { 'if-none-match': tag }),
    response => response.status === 200);
  assert.notEqual(changed.headers.etag, tag);
  assert.equal(JSON.parse(changed.body).projects[0].name, 'All 2');
  assert.equal(f.reads(), 2);
  const freshProject = await f.get('/api/command-center/project?id=alpha');
  assert.equal(JSON.parse(freshProject.body).name, 'All 2');
  assert.notEqual(freshProject.headers.etag, project.headers.etag);
  f.advance(59999);
  await f.get('/api/command-center');
  assert.equal(f.reads(), 2, 'exactly one deep rebuild renews the snapshot age');
  t.diagnostic('full builds: cold=1, idle at 60000/119999ms=1, deep refresh at 120000ms=2');
  assert.equal((await f.get('/api/command-center', { 'x-watch-token': '' })).status, 403);
});

test('a watched ticket change triggers a full rebuild at TTL expiry, then idle requests wait for the backstop', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-rebuild-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ticketsFile = path.join(root, '.swarm/project/tickets.json');
  await mkdir(path.dirname(ticketsFile), { recursive: true });
  const tickets = title => writeFile(ticketsFile, JSON.stringify({ tickets: [{ id: 'T1', title, status: 'ready' }] }));
  await tickets('Initial ticket');
  let builds = 0;
  let projectReads = 0;
  const project = async () => {
    const ledger = JSON.parse(await readFile(ticketsFile, 'utf8'));
    return { id: 'alpha', root, name: ledger.tickets[0].title, ledger };
  };
  const f = await fixture(t, { snapshotMaxStaleMs: 120000, board: {
    async snapshot() {
      builds++;
      return { at: '2026-10-30T12:00:00Z', projects: [{ ...await project(), name: 'Full ' + builds }] };
    },
    async project() { projectReads++; return project(); },
  } });
  await f.get('/api/command-center');
  assert.equal(builds, 1);
  f.advance(59999);
  await tickets('Changed watched ticket');
  f.timers.find(timer => timer.ms === 1000).fn();
  const patched = await waitForResponse(() => f.get('/api/command-center'),
    response => JSON.parse(response.body).projects[0].name === 'Changed watched ticket');
  assert.equal(projectReads, 1, 'the one-second detector applies the existing live patch');
  assert.equal(builds, 1, 'a live patch before TTL expiry does not rebuild');
  f.advance(1);
  assert.equal((await f.get('/api/command-center', { 'if-none-match': patched.headers.etag })).status, 304);
  await waitForResponse(() => f.get('/api/command-center'),
    response => JSON.parse(response.body).projects[0].name === 'Full 2');
  assert.equal(builds, 2, 'the first request at the TTL starts exactly one rebuild after a detected change');
  f.advance(60000);
  await f.get('/api/command-center');
  assert.equal(builds, 2, 'starting the rebuild clears the detected-change flag');
  f.advance(59999);
  await f.get('/api/command-center/project?id=alpha');
  assert.equal(builds, 2, 'unchanged watched inputs stay idle until the backstop');
  f.advance(1);
  await waitForResponse(() => f.get('/api/command-center'),
    response => JSON.parse(response.body).projects[0].name === 'Full 3');
  assert.equal(builds, 3);
  t.diagnostic('full builds: cold=1, live patch=1, changed TTL=2, next idle TTL=2, next deep refresh=3');
});

test('a change found by the rebuild scan survives until the next TTL cycle', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-rebuild-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ticketsFile = path.join(root, '.swarm/project/tickets.json');
  await mkdir(path.dirname(ticketsFile), { recursive: true });
  await writeFile(ticketsFile, JSON.stringify({ tickets: [] }));
  let builds = 0;
  const f = await fixture(t, { snapshotMaxStaleMs: 90000, board: {
    async snapshot() {
      const revision = ++builds;
      const ledger = JSON.parse(await readFile(ticketsFile, 'utf8'));
      if (revision === 2) {
        await writeFile(ticketsFile, JSON.stringify({ tickets: [{ id: 'T1', title: 'Changed during rebuild', status: 'ready' }] }));
      }
      return { at: '2026-10-30T12:00:00Z', projects: [{ id: 'alpha', root, name: 'Full ' + revision, ledger }] };
    },
  } });
  await f.get('/api/command-center');
  f.advance(90000);
  await waitForResponse(() => f.get('/api/command-center'),
    response => JSON.parse(response.body).projects[0].name === 'Full 2');
  assert.equal(builds, 2, 'the configured deep backstop starts one rebuild');
  f.advance(60000);
  await waitForResponse(() => f.get('/api/command-center'),
    response => JSON.parse(response.body).projects[0].name === 'Full 3');
  assert.equal(builds, 3, 'a change during the rebuild is retained for the next TTL, before the backstop');
  f.advance(60000);
  await f.get('/api/command-center');
  assert.equal(builds, 3, 'the next rebuild consumes the change without repeating idle rebuilds');
  t.diagnostic('full builds: cold=1, configured deep refresh=2, rebuild-scan change at next TTL=3, next idle TTL=3');
});

test('explicit local-only requests preserve query semantics and redaction without retaining another snapshot', async t => {
  const f = await fixture(t);
  const shared = await f.get('/api/command-center');
  for (let i = 0; i < 2; i++) {
    const local = await f.get('/api/command-center?local=1&redact=0');
    assert.equal(JSON.parse(local.body).projects[0].name, 'Local 1');
    assert.notEqual(local.headers.etag, shared.headers.etag);
  }
  const cockpit = await f.get('/api/command-center/project?id=alpha&local=1&redact=0');
  assert.equal(JSON.parse(cockpit.body).name, 'Local 1');
  assert.equal(f.reads(), 4, 'local variants are computed without another cache');
  assert.ok(f.optionsSeen.every(options => options.redact === true));
  const after = await f.get('/api/command-center');
  assert.deepEqual(after.body, shared.body);
  assert.equal(f.reads(), 4, 'local variants do not replace the shared snapshot');
});

test('stale Hive and Cockpit return without waiting for a single background rebuild', async t => {
  let reads = 0;
  let release;
  let entered;
  const building = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { snapshotMaxStaleMs: 120000, board: { snapshot: async () => {
    const revision = ++reads;
    if (revision > 1) { entered(); await gate; }
    return { at: '2026-10-30T12:00:00Z', projects: [{ id: 'alpha', name: 'Revision ' + revision, ledger: { tickets: [] } }] };
  } } });
  const initial = await f.get('/api/command-center');
  const cockpit = await f.get('/api/command-center/project?id=alpha');
  f.advance(120000);
  const start = performance.now();
  let timeout;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('stale response waited for rebuild')), 1500); });
  t.after(() => clearTimeout(timeout));
  const stale = await Promise.race([f.get('/api/command-center'), deadline]);
  await building;
  const polls = await Promise.race([Promise.all(Array.from({ length: 12 }, (_, i) =>
    f.get(i % 2 ? '/api/command-center/project?id=alpha' : '/api/command-center',
      { 'if-none-match': i % 2 ? cockpit.headers.etag : initial.headers.etag }))), deadline]);
  clearTimeout(timeout);
  assert.deepEqual(stale.body, initial.body);
  assert.ok(polls.every(response => response.status === 304));
  assert.equal(reads, 2, 'only one refresh starts while its result is unresolved');
  const staleMs = performance.now() - start;
  release();
  await waitForResponse(() => f.get('/api/command-center'),
    response => JSON.parse(response.body).projects[0].name === 'Revision 2');
  await f.get('/api/command-center/project?id=alpha');
  assert.equal(reads, 2);
  f.advance(120000);
  const nextStale = await f.get('/api/command-center');
  assert.equal(JSON.parse(nextStale.body).projects[0].name, 'Revision 2');
  await waitForResponse(() => f.get('/api/command-center'),
    response => JSON.parse(response.body).projects[0].name === 'Revision 3');
  assert.equal(reads, 3);
  t.diagnostic(JSON.stringify({ staleBatchMs: staleMs, concurrentStaleRequests: 13, builds: reads }));
});

test('startup warm is non-blocking, shares cold requests and is ready before the first dashboard visit', async t => {
  let reads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { board: { snapshot: async () => {
    reads++;
    await gate;
    return { at: '2026-10-30T12:00:00Z', projects: [] };
  } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, 'listen starts one background attempt without a dashboard request');
  let coldFinished = false;
  const cold = Promise.all([f.get('/api/command-center'), f.get('/api/command-center/project?id=missing')])
    .then(responses => { coldFinished = true; return responses; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(coldFinished, false, 'cold requests wait for startup build');
  assert.equal(reads, 1);
  release();
  assert.deepEqual((await cold).map(response => response.status), [200, 404]);
  assert.equal((await f.get('/api/command-center')).status, 200);
  assert.equal(reads, 1, 'warm visit does not rebuild');
});

test('failed startup warm retries on demand; failed refresh keeps stale data and validators', async t => {
  let reads = 0;
  let fail = true;
  const f = await fixture(t, { board: { snapshot: async () => {
    reads++;
    if (fail) throw new Error('fixture build failed');
    return { at: '2026-10-30T12:00:00Z', projects: [] };
  } } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reads, 1, 'warming makes only one attempt');
  assert.equal((await f.get('/api/command-center')).status, 500);
  fail = false;
  const initial = await f.get('/api/command-center');
  assert.equal(initial.status, 200);
  fail = true;
  f.advance(120000);
  assert.equal((await f.get('/api/command-center', { 'if-none-match': initial.headers.etag })).status, 304);
  await new Promise(resolve => setTimeout(resolve, 30));
  fail = false;
  assert.deepEqual((await f.get('/api/command-center')).body, initial.body);
  await new Promise(resolve => setTimeout(resolve, 30));
  const before = reads;
  assert.equal((await f.get('/api/command-center', { 'if-none-match': initial.headers.etag })).status, 304);
  assert.equal(reads, before, 'successful retry renews the TTL even for identical bytes');
});

test('an idle board does not read run state before any event stream opens', async t => {
  const f = await fixture(t);
  await f.timers.find(timer => timer.ms === 1000).fn();
  assert.equal(f.runReads(), 0);
});

test('warm caches preserve remote identity, token checks and read-only routes', async t => {
  const f = await fixture(t, { remote: { hosts: ['board.example'], login: 'owner@example.com' } });
  const identity = { 'tailscale-user-login': 'owner@example.com' };
  const warm = await f.get('/api/command-center', identity);
  assert.equal(warm.status, 200);
  assert.equal((await f.get('/api/command-center', { 'if-none-match': warm.headers.etag })).status, 403);
  assert.equal((await f.get('/api/command-center', { ...identity, 'x-watch-token': '', 'if-none-match': warm.headers.etag })).status, 403);
  assert.equal((await f.get('/api/command-center?t=wrong', { ...identity, 'x-watch-token': '' })).status, 403);
  assert.equal((await f.get('/api/command-center', { ...identity, 'tailscale-funnel-request': '1' })).status, 403);
  const board = await f.get('/api/board', identity);
  assert.equal(JSON.parse(board.body).openRun, false);
  assert.equal((await f.get('/open/run?id=alpha', identity)).status, 404);
});

test('Hive entry imports exclude Cockpit, robot, tour and palette; supplied entry source budget', async t => {
  const [boot, hive, html] = await Promise.all([
    source('command-center-boot.js'), source('cc-hive-mount.js'), source('command-center.html'),
  ]);
  const staticImports = text => [...text.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  for (const text of [boot, hive]) {
    assert.doesNotMatch(staticImports(text).join('\n'), /cockpit|robot|cc-tour|command-palette/);
  }
  assert.doesNotMatch(staticImports(boot).join('\n'), /cc-router/, 'legacy router imports the robot-backed layout');
  assert.match(boot, /import\('\.\/cc-cockpit-mount\.js'\)/);
  assert.match(boot, /COCKPIT_WARM_MODULES/);
  for (const rel of [
    './cc-cockpit-mount.js',
    './cockpit-view.js',
    './cockpit-lists.js',
    './cockpit-orchestrator.js',
    './orchestrator-view.js',
    './robot-head.js',
    './cc-ledger-browser.js',
    './cc-glitch.js',
    './cc-tour.js',
  ]) {
    assert.match(boot, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(boot, /link\.rel\s*=\s*['"]modulepreload['"]/);
  assert.match(boot, /new URL\(rel,\s*import\.meta\.url\)\.href/);
  assert.match(boot, /setTimeoutFn\(\(\)\s*=>\s*\{[\s\S]*preloadCockpit\(warmProjectId\)[\s\S]*\},\s*300\)/);
  assert.match(boot, /schedulePromptCockpitWarm\(snapshot\.projects\[0\]\?\.id\)/);
  assert.doesNotMatch(boot, /modulepreload[\s\S]*\.as\s*=/);
  assert.match(hive, /import\('\.\/robot-head\.js'\)/);
  assert.match(boot, /import\('\.\/command-palette\.js'\)/);
  assert.match(html, /command-center-boot\.js/);
  const bytes = Buffer.byteLength(boot) + Buffer.byteLength(hive);
  const zipped = gzipSync(boot).length + gzipSync(hive).length;
  assert.ok(bytes < 80000, `entry source ${bytes} exceeds 80 KB`);
  assert.ok(zipped < 22000, `entry gzip ${zipped} exceeds 22 KB`);
  const support = await Promise.all(['cc-hive-stage.js', 'hive-panels.js'].map(source));
  const suppliedHiveGzip = zipped + support.reduce((sum, text) => sum + gzipSync(text).length, 0);
  assert.ok(suppliedHiveGzip < 45000, `Hive entry, runtime and panels gzip ${suppliedHiveGzip} exceeds 45 KB`);
  const robotHead = await source('robot-head.js');
  assert.deepEqual(staticImports(robotHead), [], 'robot facade must defer its 3D graph until an actual mount');
  t.diagnostic(`2 supplied Hive entry modules: ${bytes} bytes -> ${zipped} gzip bytes; graph dependencies excluded from this budget`);
  t.diagnostic(`Hive entries + shared runtime + panels: ${suppliedHiveGzip} gzip bytes (45 KB budget)`);
});

test('hover-prefetched Cockpit data paints before a slow navigation refresh', async t => {
  process.env.SWARM_COMMAND_CENTER_BOOT_TEST = '1';
  const oldData = globalThis.CommandCenterData;
  globalThis.CommandCenterData = { parseCommandCenterSnapshot: data => data };
  t.after(() => { globalThis.CommandCenterData = oldData; });
  const { mountCommandCenter } = await import('../tools/watch-assets/command-center-boot.js');
  const location = { pathname: '/command-center' };
  let hiveDeps;
  let projectCalls = 0;
  let finishRefresh;
  const rendered = [];
  const handle = mountCommandCenter({ replaceChildren() {}, setAttribute() {} }, {
    document: { hidden: false, addEventListener() {}, removeEventListener() {} }, location,
    history: { pushState(_state, _title, pathname) { location.pathname = pathname; } },
    fetchJson: async url => {
      if (!url.includes('/project')) return { projects: [{ id: 'alpha' }] };
      if (++projectCalls === 1) return { id: 'alpha', name: 'Prefetched' };
      return new Promise(resolve => { finishRefresh = resolve; });
    },
    renderHive: (_root, _data, deps) => { hiveDeps = deps; return { destroy() {} }; },
    loadCockpit: async () => ({ renderProjectCockpit: (_root, project) => { rendered.push(project); return { update() {}, destroy() {} }; } }),
    loadTour: async () => ({ maybeStartFirstVisit() {} }),
    setInterval: () => 1, clearInterval() {}, requestAnimationFrame() {}, cancelAnimationFrame() {}, matchMedia() {},
  });
  t.after(() => handle.destroy());
  await handle.whenReady;
  hiveDeps.preloadCockpit('alpha');
  await new Promise(resolve => setImmediate(resolve));
  hiveDeps.onOpenProject('alpha');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rendered, [{ id: 'alpha', name: 'Prefetched' }], 'shell and cached data render while the new response is unresolved');
  finishRefresh({ id: 'alpha', name: 'Fresh' });
});

test('300ms warm timer prefetches first project into cache for a fast Cockpit switch', async t => {
  process.env.SWARM_COMMAND_CENTER_BOOT_TEST = '1';
  const oldData = globalThis.CommandCenterData;
  globalThis.CommandCenterData = { parseCommandCenterSnapshot: data => data };
  t.after(() => { globalThis.CommandCenterData = oldData; });
  const { mountCommandCenter } = await import('../tools/watch-assets/command-center-boot.js');
  const location = { pathname: '/command-center' };
  const projectUrls = [];
  let finishNav;
  let navPending = false;
  const rendered = [];
  const timeouts = [];
  const handle = mountCommandCenter({ replaceChildren() {}, setAttribute() {} }, {
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    location,
    history: { pushState(_state, _title, pathname) { location.pathname = pathname; } },
    fetchJson: async url => {
      if (url.includes('/project')) {
        projectUrls.push(url);
        if (navPending) return new Promise(resolve => { finishNav = resolve; });
        return { id: 'alpha', name: 'Warm cached' };
      }
      return { projects: [{ id: 'alpha' }, { id: 'beta' }] };
    },
    renderHive: (_root, _data) => ({
      update() {},
      destroy() {},
    }),
    loadCockpit: async () => ({
      renderProjectCockpit: (_root, project) => {
        rendered.push(project);
        return { update() {}, destroy() {} };
      },
    }),
    loadTour: async () => ({ maybeStartFirstVisit() {} }),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout: () => {},
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    matchMedia() {},
  });
  t.after(() => handle.destroy());
  await handle.whenReady;
  assert.equal(projectUrls.length, 0);
  const warm = timeouts.find(timer => timer.ms === 300);
  assert.ok(warm, 'Hive schedules warm after first render');
  warm.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(projectUrls.length, 1);
  assert.match(projectUrls[0], /id=alpha/);
  navPending = true;
  location.pathname = '/command-center/project/alpha';
  void handle.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rendered, [{ id: 'alpha', name: 'Warm cached' }], 'switch paints from warm cache while nav fetch is pending');
  finishNav({ id: 'alpha', name: 'Fresh' });
});

test('browser path modulepreloads cockpit graph from boot URL without import before Hive navigation', async t => {
  process.env.SWARM_COMMAND_CENTER_BOOT_TEST = '1';
  const oldData = globalThis.CommandCenterData;
  globalThis.CommandCenterData = { parseCommandCenterSnapshot: data => data };
  t.after(() => { globalThis.CommandCenterData = oldData; });
  const { mountCommandCenter } = await import('../tools/watch-assets/command-center-boot.js');
  const expectedHrefs = [
    './cc-cockpit-mount.js',
    './cockpit-view.js',
    './cockpit-lists.js',
    './cockpit-orchestrator.js',
    './orchestrator-view.js',
    './robot-head.js',
    './cc-ledger-browser.js',
    './cc-glitch.js',
    './cc-tour.js',
  ].map((rel) => new URL(
    rel,
    new URL('../tools/watch-assets/command-center-boot.js', import.meta.url),
  ).href);
  const links = [];
  const document = {
    hidden: false,
    head: { appendChild(link) { links.push(link); return link; } },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        rel: '',
        href: '',
        as: undefined,
        crossOrigin: undefined,
        remove() {},
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const location = { pathname: '/command-center' };
  const handle = mountCommandCenter({ replaceChildren() {}, setAttribute() {} }, {
    document,
    location,
    history: { pushState(_state, _title, pathname) { location.pathname = pathname; } },
    fetchJson: async url => (url.includes('/project') ? { id: 'alpha' } : { projects: [{ id: 'alpha' }] }),
    renderHive: (_root, _data, deps) => {
      deps.preloadCockpit('alpha');
      return { update() {}, destroy() {} };
    },
    loadTour: async () => ({ maybeStartFirstVisit() {} }),
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    matchMedia() {},
  });
  t.after(() => handle.destroy());
  await handle.whenReady;
  assert.equal(location.pathname, '/command-center');
  assert.equal(links.length, expectedHrefs.length);
  assert.deepEqual(links.map((link) => link.href), expectedHrefs);
  for (const link of links) {
    assert.equal(link.rel, 'modulepreload');
    assert.equal(link.as, undefined);
    assert.equal(link.crossOrigin, undefined);
  }
});

test('boot defers Cockpit and optional UI, polls at 5000ms, pauses hidden and refreshes on return', async t => {
  process.env.SWARM_COMMAND_CENTER_BOOT_TEST = '1';
  const oldData = globalThis.CommandCenterData;
  globalThis.CommandCenterData = { parseCommandCenterSnapshot: data => data };
  t.after(() => { globalThis.CommandCenterData = oldData; });
  const { mountCommandCenter } = await import('../tools/watch-assets/command-center-boot.js');
  const events = new Map();
  const document = {
    hidden: false,
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name),
  };
  const root = { replaceChildren() {}, setAttribute() {} };
  const location = { pathname: '/command-center' };
  const timers = new Map();
  const timeouts = [];
  let timerId = 0;
  let calls = 0;
  let cockpitLoads = 0;
  let tourLoads = 0;
  let paletteLoads = 0;
  let hiveDeps;
  const oldIdle = globalThis.requestIdleCallback;
  const oldCancel = globalThis.cancelIdleCallback;
  let idle;
  globalThis.requestIdleCallback = fn => { idle = fn; return 1; };
  globalThis.cancelIdleCallback = () => {};
  t.after(() => { globalThis.requestIdleCallback = oldIdle; globalThis.cancelIdleCallback = oldCancel; });
  const handle = mountCommandCenter(root, {
    document, location, history: { pushState(_state, _title, pathname) { location.pathname = pathname; } },
    fetchJson: async url => { calls++; return url.includes('/project') ? { id: 'alpha' } : { projects: [{ id: 'alpha' }] }; },
    renderHive: (_root, _data, deps) => { hiveDeps = deps; return { update() {}, destroy() {} }; },
    loadCockpit: async () => { cockpitLoads++; return { renderProjectCockpit: () => ({ destroy() {} }) }; },
    loadTour: async () => { tourLoads++; return { maybeStartFirstVisit() {} }; },
    loadPalette: async () => { paletteLoads++; return { createCommandPalette: () => ({ bind() {}, unbind() {} }) }; },
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearInterval: id => timers.delete(id),
    setTimeout: (fn, ms) => { const id = ++timerId; timeouts.push({ id, fn, ms }); return id; },
    clearTimeout: () => {},
    requestAnimationFrame() {}, cancelAnimationFrame() {}, matchMedia() {},
  });
  t.after(() => handle.destroy());
  await handle.whenReady;
  assert.equal(cockpitLoads + tourLoads + paletteLoads, 0);
  assert.equal(calls, 1);
  assert.ok(timeouts.some((timer) => timer.ms === 300), 'Hive entry schedules prompt cockpit warm');
  assert.deepEqual(hiveDeps.rawSnapshot, { projects: [{ id: 'alpha' }] });
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  assert.equal(timer.ms, 5000);
  await timer.fn();
  assert.equal(calls, 2);
  document.hidden = true;
  events.get('visibilitychange')();
  assert.equal(timers.size, 0);
  await timer.fn();
  assert.equal(calls, 2, 'even a queued poll does no hidden request');
  document.hidden = false;
  events.get('visibilitychange')();
  assert.equal(calls, 3, 'visible resumes immediately');
  assert.equal(timers.size, 1);
  await Promise.resolve();
  hiveDeps.onOpenProject('alpha');
  await handle.refresh();
  assert.equal(cockpitLoads, 1);
  idle();
  await Promise.resolve();
  assert.equal(tourLoads, 1);
  await events.get('keydown')({ key: 'k', ctrlKey: true, preventDefault() {} });
  assert.equal(paletteLoads, 1);
  handle.destroy();
  assert.equal(timers.size, 0);
  assert.equal(events.size, 0);
});

test('Hive loads robot code only for a visible lane head, shares its raw response, and destroys deferred heads', async t => {
  const { renderHive } = await import('../tools/watch-assets/cc-hive-mount.js');
  const events = new Map();
  const node = tag => ({
    tagName: tag, children: [], style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    get firstChild() { return this.children[0]; },
    setAttribute() {}, querySelector() { return null; },
    addEventListener() {}, removeEventListener() {}, getContext() { return null; },
    getBoundingClientRect() { return { width: 800, height: 600 }; },
  });
  let idle;
  let robotLoads = 0;
  let mounts = 0;
  let destroys = 0;
  let rawFetches = 0;
  const paused = [];
  const observers = [];
  const win = {
    innerWidth: 1200, requestAnimationFrame() {}, requestIdleCallback: fn => { idle = fn; },
    fetch: () => { rawFetches++; }, addEventListener() {}, removeEventListener() {},
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} disconnect() {}
    },
  };
  const document = {
    hidden: false, defaultView: win, body: node('body'), createElement: node,
    createTextNode: textContent => ({ textContent }),
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
  };
  const root = node('div');
  const oldPanels = globalThis.HivePanels;
  globalThis.HivePanels = {
    deriveHiveView: data => ({ ...data, projects: [], agents: 0, needs: 0, projectsTotal: 0, doneLast24h: null }),
    renderHiveDashboard: (host, view, deps) => ({ heads: [deps.mountHead(host, { state: 'idle', label: 'Alpha' })] }),
  };
  t.after(() => { globalThis.HivePanels = oldPanels; });
  const handle = renderHive(root, { projects: [] }, {
    document, now: () => 0, rawSnapshot: { projects: [] },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, matchMedia: () => ({ matches: false }),
    loadRobot: async () => {
      robotLoads++;
      return { setAnimationPaused: value => paused.push(value), mountRobotHead: () => {
        mounts++;
        assert.equal(root.children.length, 1, 'shell exists before robot mount');
        return { destroy() { destroys++; } };
      } };
    },
  });
  assert.equal(root.children.length, 1);
  assert.equal(robotLoads, 0);
  assert.equal(rawFetches, 0);
  assert.equal(idle, undefined, 'offscreen heads do not even schedule a robot import');
  observers[0].callback([{ isIntersecting: false }]);
  assert.equal(robotLoads, 0);
  observers[0].callback([{ isIntersecting: true }]);
  idle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(robotLoads, 1);
  assert.equal(mounts, 1);
  document.hidden = true;
  events.get('visibilitychange')();
  assert.equal(paused.at(-1), true);
  handle.update({ projects: [] }, { projects: [] });
  assert.equal(rawFetches, 0);
  handle.destroy();
  assert.equal(destroys, 1);
});
