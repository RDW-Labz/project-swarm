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

async function startCommandCenterServer({ commandCenterOn, boardPayload }) {
  const prevFlag = process.env.SWARM_COMMAND_CENTER;
  if (commandCenterOn) process.env.SWARM_COMMAND_CENTER = '1';

  const board = {
    snapshot: async () => boardPayload ?? fakeBoardPayload(),
    project: async (id) => (boardPayload
      ? boardPayload.projects.find((project) => project.id === id) ?? null
      : id === 'alpha' ? { id: 'alpha', name: 'Alpha' } : null),
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
    const server = await chromium.launchServer({ headless: true });
    const browser = await chromium.connect(server.wsEndpoint());
    return { server, browser };
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
let smokeServer;
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
  const pages = smokePages;
  const context = smokeContext;
  const browser = smokeBrowser;
  const server = smokeServer;
  const tracked = smokeTracked;

  for (const page of pages) {
    try {
      if (page) await page.close();
    } catch {
      /* continue */
    }
  }
  try {
    if (context) await context.close();
  } catch {
    /* continue */
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* continue */
    }
    smokeBrowser = undefined;
  }
  if (server) {
    try {
      await server.close();
    } catch {
      /* continue */
    }
    smokeServer = undefined;
  }
  await closeBrowserFully({ tracked });
  smokeContext = undefined;
  smokePages = [];
}

test.after(async () => {
  await cleanupSmokeBrowser();
  await disposeSmokeServers();
});

test('command center browser smoke (Hive and Cockpit)', { timeout: 120_000 }, async () => {
  try {
    smokeOn = await startCommandCenterServer({ commandCenterOn: true });
    smokeOff = await startCommandCenterServer({ commandCenterOn: false });
    const launched = await launchChromium();
    smokeServer = launched.server;
    smokeBrowser = launched.browser;
    smokeTracked = trackBrowser(smokeServer);
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
    await cockpitDirectPage.goto(cockpitDirectUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await cockpitDirectPage.waitForSelector('#command-center-root', { state: 'attached', timeout: 30_000 });
    await cockpitDirectPage.waitForSelector('.cc-cockpit-shell, #cc-cockpit-main', { timeout: 30_000 });
    assertMonitorBag(bag, 'Cockpit-direct');
    await assertMainArea(cockpitDirectPage, '#cc-cockpit-main', 'Cockpit-direct');

    const page = await context.newPage();
    smokePages.push(page);
    attachPageMonitors(page, 'Hive', bag);
    attachPageMonitors(page, 'Cockpit', bag);

    const hiveUrl = `http://127.0.0.1:${smokeOn.port}/command-center?${smokeOn.pageAuthQuery}`;
    await page.goto(hiveUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await classicPage.waitForSelector('body', { timeout: 30_000 });
    assertMonitorBag(classicBag, 'Classic board');
    assert.ok(classic.body.length > 100, 'Classic board page: home HTML body was empty');

  } finally {
    await cleanupSmokeBrowser();
    await disposeSmokeServers();
  }
  assertNoLeftoverBrowser(smokeTracked);
});

async function scrollState(page, cardSelector) {
  return page.evaluate((selector) => {
    const cards = document.querySelectorAll(selector);
    const last = cards[cards.length - 1];
    if (!last) throw new Error(`No cards for ${selector}`);
    const rect = last.getBoundingClientRect();
    return {
      y: window.scrollY,
      maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      remaining: rect.bottom - window.innerHeight,
      lastVisible: rect.width > 0 && rect.height > 0
        && rect.top >= 0 && rect.bottom <= window.innerHeight
        && rect.left >= 0 && rect.right <= window.innerWidth,
    };
  }, cardSelector);
}

async function scrollUntil(page, cardSelector, label, input, goal, direction) {
  const { height } = page.viewportSize();
  for (let step = 0; step < 80; step += 1) {
    const state = await scrollState(page, cardSelector);
    if (goal === 'last' && state.lastVisible) return;
    if (goal === 'bottom' && state.maxY - state.y <= 1) return;
    if (goal === 'top' && state.y === 0) return;
    // Stop just past the card's bottom so a gesture cannot skip over it.
    const distance = goal === 'last' ? Math.max(40, state.remaining + 2) : height * 0.55;
    await input(direction * Math.min(height * 0.55, distance));
    await page.waitForFunction(({ before, sign }) => sign * (window.scrollY - before) > 0,
      { before: state.y, sign: direction }, { timeout: 3_000 }).catch(() => {
      assert.fail(`${label}: scrolling stopped at ${state.y} before reaching ${goal}`);
    });
    await page.waitForTimeout(150);
  }
  assert.fail(`${label}: did not reach ${goal} within 80 gestures`);
}

async function touchSwipe(page, session, delta) {
  const { width, height } = page.viewportSize();
  const x = Math.round(width / 2);
  const startY = delta > 0 ? height * 0.8 : height * 0.2;
  const point = (y) => [{ x, y, id: 1, radiusX: 1, radiusY: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(startY) });
  try {
    for (let step = 1; step <= 8; step += 1) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: point(startY - delta * step / 8),
      });
      await page.waitForTimeout(20);
    }
    // Pause before release to avoid a fling skipping the last card.
    await page.waitForTimeout(100);
  } finally {
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

test('command center scroll input reaches every card at desktop, tablet and phone sizes', { timeout: 180_000 }, async () => {
  const payload = fakeBoardPayload();
  const alpha = payload.projects[0];
  alpha.ledger.tickets = Array.from({ length: 24 }, (_, index) => ({
    id: `T-${index + 1}`, title: `Scroll regression ticket ${index + 1}`,
    status: index < 12 ? 'ready' : 'done', stage: 'S1',
  }));
  alpha.tickets = { byStatus: { ready: 12, done: 12 } };
  let server;
  let launched;
  let tracked;
  try {
    server = await startCommandCenterServer({ commandCenterOn: true, boardPayload: payload });
    launched = await launchChromium();
    tracked = trackBrowser(launched.server);
    for (const viewport of [
      { width: 1600, height: 900 }, { width: 1280, height: 800 },
      { width: 800, height: 900 }, { width: 390, height: 844 },
    ]) {
      const context = await launched.browser.newContext({
        viewport, hasTouch: true, isMobile: viewport.width === 390,
      });
      try {
        for (const [name, route, cardSelector] of [
          ['Hive', '/command-center', '.hive-card'],
          ['Cockpit', '/command-center/project/alpha', '.tk'],
        ]) {
          const page = await context.newPage();
          let session;
          const label = `${name} ${viewport.width}x${viewport.height}`;
          try {
            await page.goto(`http://127.0.0.1:${server.port}${route}?${server.pageAuthQuery}`, {
              waitUntil: 'domcontentloaded', timeout: 30_000,
            });
            await page.waitForSelector(name === 'Hive' ? '.hive-shell' : '.cc-cockpit-shell', { timeout: 30_000 });
            await page.waitForSelector(cardSelector, { timeout: 30_000 });
            if (name === 'Hive') {
              await page.getByRole('button', { name: 'Skip tour', exact: true }).click({ timeout: 10_000 });
              await page.waitForSelector('.cc-tour-overlay', { state: 'hidden', timeout: 10_000 });
            }
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(() => window.scrollTo(0, 0));
            const widths = await page.evaluate(() => ({
              scroll: document.documentElement.scrollWidth,
              client: document.documentElement.clientWidth,
            }));
            assert.equal(widths.scroll, widths.client, `${label}: horizontal overflow`);
            assert.ok((await scrollState(page, cardSelector)).maxY > 0, `${label}: fixture must scroll`);

            await page.mouse.move(viewport.width / 2, viewport.height / 2);
            const wheel = (delta) => page.mouse.wheel(0, delta);
            await scrollUntil(page, cardSelector, `${label} wheel`, wheel, 'last', 1);
            await scrollUntil(page, cardSelector, `${label} wheel`, wheel, 'bottom', 1);
            await scrollUntil(page, cardSelector, `${label} wheel`, wheel, 'top', -1);
            assert.equal(await page.evaluate(() => window.scrollY), 0, `${label}: wheel returns to top`);

            session = await context.newCDPSession(page);
            const swipe = (delta) => touchSwipe(page, session, delta);
            await scrollUntil(page, cardSelector, `${label} touch`, swipe, 'last', 1);
            // Desktop cards may already be visible; still exercise a real swipe in both directions.
            await scrollUntil(page, cardSelector, `${label} touch`, swipe, 'bottom', 1);
            await scrollUntil(page, cardSelector, `${label} touch`, swipe, 'top', -1);
            assert.equal(await page.evaluate(() => window.scrollY), 0, `${label}: touch returns to top`);

            if (viewport.width !== 390) {
              await page.evaluate(() => document.activeElement?.blur());
              await page.keyboard.press('PageDown');
              await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 5_000 });
              const afterPageDown = await page.evaluate(() => window.scrollY);
              await page.keyboard.press('Space');
              await page.waitForFunction((before) => window.scrollY > before, afterPageDown, { timeout: 5_000 });
              await page.waitForTimeout(300);
              await page.keyboard.press('Home');
              await page.evaluate(() => window.scrollTo(0, 0));
              await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 5_000 });
            }
          } finally {
            try {
              if (session) await session.detach();
            } finally {
              await page.close();
            }
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    try {
      if (launched) {
        try {
          await launched.browser.close();
        } finally {
          try {
            await launched.server.close();
          } finally {
            await closeBrowserFully({ tracked });
          }
        }
      }
    } finally {
      if (server) await server.dispose();
    }
  }
  assertNoLeftoverBrowser(tracked);
});
