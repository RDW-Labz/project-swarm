// SPDX-License-Identifier: Apache-2.0
import '../_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createWatchServer } from '../../tools/watch-server.mjs';
import {
  trackBrowser,
  closeBrowserFully,
  assertNoLeftoverBrowser,
} from './browser-cleanup.mjs';

const deltaFile = fileURLToPath(new URL('../../tools/watch-delta.mjs', import.meta.url));
const assetDir = fileURLToPath(new URL('../../tools/watch-assets', import.meta.url));

function cardProject(id, name, overall, extra = {}) {
  return {
    id,
    name,
    machine: `host-${id}`,
    agents: { total: 1 },
    spend: { usd: 10 },
    card: { blocked: { needYou: 0 }, now: { buildingTickets: 0 }, next: { ready: 0 } },
    progress: { overall },
    tickets: { byStatus: {} },
    ledger: { tickets: [], scope: { stages: [] } },
    ...extra,
  };
}

function fakeBoardPayload() {
  const alpha = cardProject('alpha', 'Alpha', 40, {
    agents: { total: 2, jobs: { running: 2 } },
    card: { blocked: { needYou: 1 }, now: { buildingTickets: 3 }, next: { ready: 2, items: [{ id: 'T-1', title: 'One' }] } },
    tickets: { byStatus: { failed: 1 } },
    orchestrator: { sessions: [{ id: 's1', state: 'working', lastAt: '2026-10-26T11:00:00.000Z' }] },
    live: [{ runId: 'run-1', status: 'running', jobs: 4, done: 1 }],
    ledger: {
      tickets: [
        { id: 'T-1', title: 'One', status: 'ready', stage: 'S1' },
        { id: 'T-2', title: 'Two', status: 'done', stage: 'S1' },
      ],
      scope: { stages: [{ id: 'S1', name: 'Stage 1' }] },
    },
  });
  return {
    at: '2026-10-26T12:00:00.000Z',
    machine: { agents: { total: 4 }, cost: { allUsd: 42.5 } },
    projects: [alpha, cardProject('beta', 'Beta', 80), cardProject('gamma', 'Gamma', 55), cardProject('delta', 'Delta', 20)],
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterRow(type, row, prev, bpp) {
  const out = Buffer.alloc(row.length);
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bpp ? out[i - bpp] : 0;
    const up = prev[i] ?? 0;
    const upLeft = i >= bpp ? prev[i - bpp] : 0;
    let v = row[i];
    if (type === 0) v = row[i];
    else if (type === 1) v = (row[i] + left) & 0xff;
    else if (type === 2) v = (row[i] + up) & 0xff;
    else if (type === 3) v = (row[i] + Math.floor((left + up) / 2)) & 0xff;
    else if (type === 4) v = (row[i] + paeth(left, up, upLeft)) & 0xff;
    else throw new Error(`unsupported PNG filter type ${type}`);
    out[i] = v;
  }
  return out;
}

function decodePngToRgba(buf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('invalid PNG signature');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('PNG must be 8-bit RGB or RGBA');
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  let rawPos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawPos++];
    const row = raw.subarray(rawPos, rawPos + stride);
    rawPos += stride;
    const recon = unfilterRow(filter, row, prev, bpp);
    prev = recon;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[o] = recon[x * 4];
        rgba[o + 1] = recon[x * 4 + 1];
        rgba[o + 2] = recon[x * 4 + 2];
        rgba[o + 3] = recon[x * 4 + 3];
      } else {
        rgba[o] = recon[x * 3];
        rgba[o + 1] = recon[x * 3 + 1];
        rgba[o + 2] = recon[x * 3 + 2];
        rgba[o + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

function distinctColorsSampled(rgba, width, height, grid = 40) {
  const seen = new Set();
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const x = Math.min(width - 1, Math.floor(((gx + 0.5) * width) / grid));
      const y = Math.min(height - 1, Math.floor(((gy + 0.5) * height) / grid));
      const o = (y * width + x) * 4;
      seen.add(`${rgba[o]},${rgba[o + 1]},${rgba[o + 2]},${rgba[o + 3]}`);
    }
  }
  return seen.size;
}

function assertScreenshotNotBlank(png, pageLabel) {
  assert.ok(png.length > 20480, `${pageLabel}: screenshot PNG too small (${png.length} bytes)`);
  const { width, height, rgba } = decodePngToRgba(png);
  const colors = distinctColorsSampled(rgba, width, height, 40);
  assert.ok(colors >= 8, `${pageLabel}: screenshot looks blank (${colors} distinct colors in 40×40 sample)`);
}

function httpGet({ port, reqPath }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: reqPath,
        headers: { Host: `127.0.0.1:${port}` },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

function attachPageMonitors(page, pageLabel, bag) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bag.consoleErrors.push(`${pageLabel}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    bag.pageErrors.push(`${pageLabel}: ${err?.message || String(err)}`);
  });
  page.on('response', (res) => {
    const status = res.status();
    const req = res.request();
    if (req.resourceType() === 'stylesheet') {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('text/css')) {
        bag.badResponses.push(
          `${pageLabel}: stylesheet wrong content-type ${ct || '(missing)'} ${res.url()}`,
        );
      }
    }
    if (status < 400) return;
    const url = res.url();
    if (status === 404 && /favicon\.ico(?:\?|$)/.test(url)) return;
    bag.badResponses.push(`${pageLabel}: HTTP ${status} ${url}`);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (/favicon\.ico(?:\?|$)/.test(url)) return;
    const why = req.failure()?.errorText || 'failed';
    bag.badResponses.push(`${pageLabel}: request failed ${why} ${url}`);
  });
}

function assertMonitorBag(bag, pageLabel) {
  const pick = (arr) => arr.filter((l) => l.startsWith(`${pageLabel}:`)).map((l) => l.slice(pageLabel.length + 2));
  const consoleErrs = pick(bag.consoleErrors);
  const pageErrs = pick(bag.pageErrors);
  const badReqs = pick(bag.badResponses);
  if (consoleErrs.length) {
    assert.fail(`${pageLabel} page: ${consoleErrs.length} console errors: ${consoleErrs.join(' | ')}`);
  }
  if (pageErrs.length) {
    assert.fail(`${pageLabel} page: ${pageErrs.length} page errors: ${pageErrs.join(' | ')}`);
  }
  if (badReqs.length) {
    assert.fail(`${pageLabel} page: ${badReqs.length} failed requests: ${badReqs.join(' | ')}`);
  }
}

async function assertMainArea(page, mainSelector, pageLabel) {
  const stats = await page.evaluate((sel) => {
    const main = document.querySelector(sel);
    if (!main) return { missing: true };
    const text = (main.innerText || '').replace(/\s+/g, ' ').trim();
    let boxed = 0;
    for (const el of main.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) boxed += 1;
    }
    return { textLen: text.length, boxed };
  }, mainSelector);
  assert.ok(!stats.missing, `${pageLabel} page: main area selector missing (${mainSelector})`);
  assert.ok(stats.textLen > 200, `${pageLabel} page: main visible text too short (${stats.textLen} chars)`);
  assert.ok(stats.boxed >= 20, `${pageLabel} page: too few laid-out elements in main (${stats.boxed})`);
}

async function startCommandCenterServer({ commandCenterOn }) {
  const prevFlag = process.env.SWARM_COMMAND_CENTER;
  if (commandCenterOn) process.env.SWARM_COMMAND_CENTER = '1';

  const board = {
    snapshot: async () => fakeBoardPayload(),
    project: async (id) => (id === 'alpha' ? { id: 'alpha', name: 'Alpha' } : null),
    live: async () => null,
    history: async () => ({ events: [] }),
    historyCsv: async () => '',
    openRun: async () => null,
    run: async () => null,
  };
  const nav = {
    project: { id: 'alpha', name: 'Alpha' },
    runId: 'run-1',
    openBoard: async () => null,
  };

  const srv = createWatchServer({
    root: assetDir,
    assetDir,
    deltaFile,
    idleMs: 600_000,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    board,
    nav,
    indexName: 'board.html',
    commandList: [],
    contextCommands: () => [],
    env: process.env,
    commandCenter: commandCenterOn,
  });
  await srv.listen();
  const port = Number(new URL(srv.url).port);
  const pageAuthQuery = `t=${srv.token}`;

  return {
    port,
    pageAuthQuery,
    dispose: async () => {
      await srv.close();
      if (commandCenterOn) {
        if (prevFlag === undefined) delete process.env.SWARM_COMMAND_CENTER;
        else process.env.SWARM_COMMAND_CENTER = prevFlag;
      }
    },
  };
}

function ensurePlaywrightBrowserPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const realHome = process.env.SWARM_REAL_HOME;
  if (!realHome) return;
  const candidates = [
    path.join(realHome, 'Library', 'Caches', 'ms-playwright'),
    path.join(realHome, '.cache', 'ms-playwright'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
      return;
    }
  }
}

async function launchChromium() {
  ensurePlaywrightBrowserPath();
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/executable doesn't exist|browser|chromium/i.test(msg)) {
      assert.fail('Chromium is not installed for Playwright. Run: npx playwright install chromium');
    }
    throw err;
  }
}

let smokeOn;
let smokeOff;
let smokeBrowser;
let smokeContext;
let smokePages = [];
let smokeTracked;

async function disposeSmokeServers() {
  const tasks = [];
  if (smokeOn) tasks.push(smokeOn.dispose().catch(() => {}));
  if (smokeOff) tasks.push(smokeOff.dispose().catch(() => {}));
  smokeOn = undefined;
  smokeOff = undefined;
  await Promise.all(tasks);
}

async function cleanupSmokeBrowser() {
  await closeBrowserFully({
    browser: smokeBrowser,
    context: smokeContext,
    pages: smokePages,
    tracked: smokeTracked,
  });
}

test.after(async () => {
  await cleanupSmokeBrowser();
  await disposeSmokeServers();
});

test('command center browser smoke (Hive and Cockpit)', { timeout: 120_000 }, async () => {
  try {
    smokeOn = await startCommandCenterServer({ commandCenterOn: true });
    smokeOff = await startCommandCenterServer({ commandCenterOn: false });
    smokeBrowser = await launchChromium();
    smokeTracked = trackBrowser(smokeBrowser);
  } catch (err) {
    await disposeSmokeServers();
    throw err;
  }
  const bag = { consoleErrors: [], pageErrors: [], badResponses: [] };

  try {
    smokeContext = await smokeBrowser.newContext({ viewport: { width: 1440, height: 900 } });
    const context = smokeContext;

    const cockpitDirectPage = await context.newPage();
    smokePages.push(cockpitDirectPage);
    attachPageMonitors(cockpitDirectPage, 'Cockpit-direct', bag);
    const cockpitDirectUrl = `http://127.0.0.1:${smokeOn.port}/command-center/project/alpha?${smokeOn.pageAuthQuery}`;
    await cockpitDirectPage.goto(cockpitDirectUrl, { waitUntil: 'networkidle', timeout: 60_000 });
    await cockpitDirectPage.waitForSelector('#command-center-root', { state: 'attached', timeout: 30_000 });
    await cockpitDirectPage.waitForSelector('.cc-cockpit-shell, #cc-cockpit-main', { timeout: 30_000 });
    assertMonitorBag(bag, 'Cockpit-direct');
    await assertMainArea(cockpitDirectPage, '#cc-cockpit-main', 'Cockpit-direct');

    const page = await context.newPage();
    smokePages.push(page);
    attachPageMonitors(page, 'Hive', bag);
    attachPageMonitors(page, 'Cockpit', bag);

    const hiveUrl = `http://127.0.0.1:${smokeOn.port}/command-center?${smokeOn.pageAuthQuery}`;
    await page.goto(hiveUrl, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForSelector('#command-center-root', { state: 'attached', timeout: 30_000 });
    await page.waitForSelector('.hive-shell', { timeout: 30_000 });
    assertMonitorBag(bag, 'Hive');
    await assertMainArea(page, '#command-center-root', 'Hive');
    const hiveShot = await page.screenshot({ type: 'png', fullPage: false });
    assertScreenshotNotBlank(hiveShot, 'Hive page');

    await page.locator('[data-project-id="alpha"]').click();
    await page.waitForURL((url) => url.pathname === '/command-center/project/alpha', { timeout: 30_000 });
    await page.waitForSelector('#command-center-root', { state: 'attached', timeout: 30_000 });
    await page.waitForSelector('.cc-cockpit-shell, #cc-cockpit-main', { timeout: 30_000 });
    assertMonitorBag(bag, 'Cockpit');
    await assertMainArea(page, '#cc-cockpit-main', 'Cockpit');
    const cockpitShot = await page.screenshot({ type: 'png', fullPage: false });
    assertScreenshotNotBlank(cockpitShot, 'Cockpit page');

    const ccOff = await httpGet({ port: smokeOff.port, reqPath: '/command-center' });
    assert.equal(ccOff.status, 404, 'Flag-off check: /command-center should be 404');

    const classic = await httpGet({ port: smokeOff.port, reqPath: `/?${smokeOff.pageAuthQuery}` });
    assert.equal(classic.status, 200, 'Classic board page: / should return 200 when flag is off');

    const classicBag = { consoleErrors: [], pageErrors: [], badResponses: [] };
    const classicPage = await context.newPage();
    smokePages.push(classicPage);
    attachPageMonitors(classicPage, 'Classic board', classicBag);
    await classicPage.goto(`http://127.0.0.1:${smokeOff.port}/?${smokeOff.pageAuthQuery}`, {
      waitUntil: 'networkidle',
      timeout: 60_000,
    });
    assertMonitorBag(classicBag, 'Classic board');
    assert.ok(classic.body.length > 100, 'Classic board page: home HTML body was empty');

  } finally {
    await cleanupSmokeBrowser();
    await disposeSmokeServers();
  }
  assertNoLeftoverBrowser(smokeTracked);
});
