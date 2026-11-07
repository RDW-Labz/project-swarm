// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWatchServer } from '../tools/watch-server.mjs';
import { buildProjectCockpit, buildCommandCenterSnapshot } from '../tools/command-center-snapshot.mjs';
import { renderProjectCockpit } from '../tools/watch-assets/cc-cockpit-mount.js';
import { renderHive } from '../tools/watch-assets/cc-hive-mount.js';

const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));

const MONEY_KEY = /usd|Usd|USD|cost|Cost|spend|Spend/;
const DOLLAR_IN_TEXT = /\$\s?\d/;

function assertSnapshotNoMoney(value, at = '$') {
  if (Array.isArray(value)) return value.forEach((item, i) => assertSnapshotNoMoney(item, `${at}[${i}]`));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') assert.doesNotMatch(value, DOLLAR_IN_TEXT, at);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, MONEY_KEY, `${at}.${key}`);
    assertSnapshotNoMoney(child, `${at}.${key}`);
  }
}

const BOARD_MARK = '<!doctype html><title>classic-board</title>';
const CC_HTML = `<!doctype html><title>command-center</title>
<script type="module" src="assets/command-center-boot.js"></script>`;

function fakeBoardPayload() {
  return {
    at: '2026-10-26T12:00:00.000Z',
    machine: {
      agents: { total: 3 },
      cost: { allUsd: 12 },
    },
    projects: [
      {
        id: 'abc',
        name: 'Abc',
        machine: 'host-a',
        agents: { total: 1 },
        spend: { usd: 5 },
        card: { blocked: { needYou: 0 }, now: { buildingTickets: 1 }, next: { ready: 0 } },
        progress: { overall: 25 },
        tickets: { byStatus: {} },
        ledger: { tickets: [], scope: { stages: [] } },
      },
    ],
  };
}

function request({ port, reqPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: reqPath,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

async function unknownPathResponse(port) {
  return request({ port, reqPath: '/no-such-watch-route' });
}

async function expectSameAsUnknown(port, reqPath, headers = {}) {
  const baseline = await unknownPathResponse(port);
  const res = await request({ port, reqPath, headers });
  assert.equal(res.status, baseline.status);
  assert.equal(res.body, baseline.body);
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c),
    toggle: (c, force) => {
      if (force === true) set.add(c);
      else if (force === false) set.delete(c);
      else if (set.has(c)) set.delete(c);
      else set.add(c);
    },
    toString: () => [...set].join(' '),
  };
}

const SELECTOR_TOKEN = /^(?:([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\])/;

function parseCompound(text) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let rest = text;
  while (rest) {
    const m = rest.match(SELECTOR_TOKEN);
    if (!m) throw new Error(`unsupported selector: ${text}`);
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else out.attrs.push([m[4], m[5]]);
    rest = rest.slice(m[0].length);
  }
  return out;
}

function matchesCompound(node, c) {
  if (!node || !node.classList || typeof node.getAttribute !== 'function') return false;
  if (c.tag && node.tagName !== c.tag) return false;
  if (c.id && node.id !== c.id) return false;
  if (!c.classes.every(k => node.classList.contains(k))) return false;
  return c.attrs.every(([k, v]) => {
    const got = node.getAttribute(k);
    return v === undefined ? got != null : got === v;
  });
}

function matchesChain(node, chain) {
  if (!matchesCompound(node, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let p = node.parentNode; p && i >= 0; p = p.parentNode) {
    if (matchesCompound(p, chain[i])) i -= 1;
  }
  return i < 0;
}

function makeElement(tag) {
  const classList = makeClassList();
  const node = {
    tagName: String(tag).toUpperCase(),
    classList,
    children: [],
    attributes: {},
    style: {
      setProperty(name, value) { this[name] = value; },
    },
    parentNode: null,
    hidden: false,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    contains() { return false; },
    open: false,
    querySelectorAll(sel) {
      const chain = sel.trim().split(/\s+/).map(parseCompound);
      const out = [];
      const walk = n => {
        for (const c of n.children || []) {
          if (matchesChain(c, chain)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 40, right: 120, width: 120, height: 40 }; },
    offsetWidth: 270,
    offsetHeight: 132,
    getContext() {
      return {
        setTransform() {},
        clearRect() {},
        scale() {},
        save() {},
        restore() {},
        beginPath() {},
        arc() {},
        fill() {},
        stroke() {},
      };
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return classList.toString(); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

function makeDocument(defaultView) {
  const document = {
    hidden: false,
    defaultView,
    addEventListener() {},
    removeEventListener() {},
    createElement: tag => {
      const el = makeElement(tag);
      el.ownerDocument = document;
      return el;
    },
    createTextNode: text => ({ nodeType: 3, textContent: text }),
    createElementNS: () => makeElement('svg'),
    fonts: { ready: Promise.resolve() },
    body: makeElement('body'),
  };
  return document;
}

function renderCockpitTabsHarness(pageQuery) {
  const fakeLocation = { search: `?${pageQuery}` };
  const win = {
    location: fakeLocation,
    addEventListener() {},
    removeEventListener() {},
  };
  const document = makeDocument(win);
  document.defaultView = win;
  const host = document.createElement('div');
  const board = fakeBoardPayload();
  board.projects[0].ledger.tickets = [
    { id: 'T-1', title: 'One', status: 'done', stage: 'S1' },
  ];
  board.projects[0].ledger.scope = { stages: [{ id: 'S1', name: 'Stage one' }] };
  board.projects[0].orchestrator = { sessions: [] };
  const project = buildProjectCockpit(board, 'abc');
  const view = renderProjectCockpit(host, project, {
    document,
    window: win,
    now: () => Date.UTC(2026, 9, 26, 12, 0, 0),
    glitch: () => false,
    mountRobotHead: () => ({ setState() {}, destroy() {} }),
  });
  const tabs = host.querySelectorAll('.tabs a');
  return { view, tabs, tokenSuffix: fakeLocation.search };
}

test('cockpit view tabs preserve the page token in hrefs', async () => {
  const on = await startWatchServer({ commandCenter: true });
  try {
    const { view, tabs, tokenSuffix } = renderCockpitTabsHarness(on.pageQuery());
    assert.equal(tabs.length, 2);
    assert.equal(tabs[0].href, `/command-center${tokenSuffix}`);
    assert.equal(tabs[0].getAttribute('aria-current'), 'page');
    assert.equal(tabs[1].href, `/classic${tokenSuffix}`);

    const ccPage = await request({ port: on.port, reqPath: tabs[0].href });
    assert.equal(ccPage.status, 200);
    assert.match(ccPage.body, /command-center-boot\.js/);

    const classicPage = await request({ port: on.port, reqPath: tabs[1].href });
    assert.equal(classicPage.status, 200);
    assert.equal(classicPage.body, BOARD_MARK);

    view.destroy();
  } finally {
    await on.dispose();
  }
});

test('hive view tabs preserve the page token in hrefs', async () => {
  const on = await startWatchServer({ commandCenter: true });
  const prevPanels = globalThis.HivePanels;
  globalThis.HivePanels = {
    deriveHiveView: (snap) => ({
      at: snap.at,
      agents: 0,
      doneLast24h: null,
      needs: 0,
      projects: (snap.projects || []).map((p) => ({
        id: p.id,
        name: p.name || p.id,
        cat: 'live',
        counts: null,
        pct: 0,
        needs: 0,
        agents: 0,
        tag: 'live',
        color: '#336699',
        raw: p,
        counted: 0,
      })),
      events: [],
      throughput: null,
      lanes: [],
      prs: [],
      totals: {},
      spend: null,
      machines: 0,
      projectsTotal: (snap.projects || []).length,
    }),
    renderHiveDashboard: () => ({ heads: [] }),
  };
  try {
    const tokenSuffix = `?${on.pageQuery()}`;
    const win = {
      location: { search: tokenSuffix },
      innerWidth: 1200,
      devicePixelRatio: 1,
      addEventListener() {},
      removeEventListener() {},
      setTimeout(fn, ms) { return setTimeout(fn, ms); },
    };
    const document = makeDocument(win);
    document.defaultView = win;
    const host = document.createElement('div');
    const snapshot = buildCommandCenterSnapshot(fakeBoardPayload(), {
      now: Date.UTC(2026, 9, 26, 12, 0, 0),
    });
    const handle = renderHive(host, snapshot, {
      document,
      now: () => Date.UTC(2026, 9, 26, 12, 0, 0),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      matchMedia: () => ({ matches: true }),
      onOpenProject: () => {},
    });
    const tabs = host.querySelectorAll('.hive-nav a.hive-tab');
    assert.equal(tabs.length, 3);
    assert.equal(tabs[0].href, `/command-center${tokenSuffix}`);
    assert.equal(tabs[0].getAttribute('aria-current'), 'page');
    assert.equal(tabs[1].href, `/command-center/project/abc${tokenSuffix}`);
    assert.equal(tabs[2].href, `/classic${tokenSuffix}`);
    handle.destroy();
  } finally {
    globalThis.HivePanels = prevPanels;
    await on.dispose();
  }
});

async function startWatchServer({ commandCenter, env } = {}) {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-routes-flag-'));
  await fs.writeFile(path.join(assetDir, 'board.html'), BOARD_MARK);
  await fs.writeFile(path.join(assetDir, 'project.html'), '<!doctype html><title>project</title>');
  await fs.writeFile(path.join(assetDir, 'run.html'), '<!doctype html><title>run</title>');
  await fs.writeFile(path.join(assetDir, 'command-center.html'), CC_HTML);
  await fs.writeFile(path.join(assetDir, 'command-center-boot.js'), 'export {};\n');

  const board = {
    snapshot: async () => fakeBoardPayload(),
    project: async (id) => (id === 'abc' ? { id: 'abc', name: 'Abc' } : null),
    live: async () => null,
    history: async () => ({ events: [] }),
    historyCsv: async () => '',
    openRun: async () => null,
    run: async () => null,
  };

  const nav = {
    project: { id: 'abc', name: 'Abc' },
    runId: 'run-1',
    openBoard: async () => null,
  };

  const srv = createWatchServer({
    root: assetDir,
    assetDir,
    deltaFile,
    idleMs: 60000,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    board,
    nav,
    indexName: 'board.html',
    commandList: [],
    contextCommands: () => [],
    ...(commandCenter !== undefined ? { commandCenter } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  await srv.listen();
  const port = Number(new URL(srv.url).port);
  const watchAuth = { 'x-watch-token': srv.token };
  return {
    port,
    watchAuth,
    pageQuery: () => `t=${srv.token}`,
    dispose: async () => {
      await srv.close();
      await fs.rm(assetDir, { recursive: true, force: true });
    },
  };
}

test('command center routes are absent when the flag is off', async () => {
  const off = await startWatchServer({ commandCenter: false });
  try {
    const paths = [
      '/command-center',
      '/command-center/project/abc',
      '/api/command-center',
      '/api/command-center/project?id=abc',
    ];
    for (const reqPath of paths) {
      await expectSameAsUnknown(off.port, reqPath);
      await expectSameAsUnknown(off.port, reqPath, off.watchAuth);
    }

    const homeDenied = await request({ port: off.port, reqPath: '/' });
    assert.equal(homeDenied.status, 403);

    const home = await request({ port: off.port, reqPath: `/?${off.pageQuery()}` });
    assert.equal(home.status, 200);
    assert.equal(home.body, BOARD_MARK);

    const classicDenied = await request({ port: off.port, reqPath: '/classic' });
    assert.equal(classicDenied.status, 403);
    const classic = await request({ port: off.port, reqPath: `/classic?${off.pageQuery()}` });
    assert.equal(classic.status, 200);
    assert.equal(classic.body, BOARD_MARK);
  } finally {
    await off.dispose();
  }
});

test('command center routes are on by default when env and option leave the flag unset', async () => {
  const on = await startWatchServer({ env: {} });
  try {
    const api = await request({ port: on.port, reqPath: '/api/command-center', headers: on.watchAuth });
    assert.equal(api.status, 200);
    const root = await request({ port: on.port, reqPath: `/?${on.pageQuery()}` });
    assert.match(root.body, /command-center-boot\.js/);
  } finally {
    await on.dispose();
  }
});

test('command center HTML and JSON when the flag is on', async () => {
  const on = await startWatchServer({ commandCenter: true });
  try {
    const deniedPage = await request({ port: on.port, reqPath: '/command-center' });
    const deniedRoot = await request({ port: on.port, reqPath: '/' });
    assert.equal(deniedPage.status, deniedRoot.status);
    assert.equal(deniedPage.body, deniedRoot.body);

    const hive = await request({ port: on.port, reqPath: `/command-center?${on.pageQuery()}` });
    assert.equal(hive.status, 200);
    assert.match(hive.body, /command-center-boot\.js/);

    const dashboardRoot = await request({ port: on.port, reqPath: `/?${on.pageQuery()}` });
    assert.equal(dashboardRoot.status, 200);
    assert.match(dashboardRoot.body, /command-center-boot\.js/);

    const classicDenied = await request({ port: on.port, reqPath: '/classic' });
    assert.equal(classicDenied.status, 403);
    const classic = await request({ port: on.port, reqPath: `/classic?${on.pageQuery()}` });
    assert.equal(classic.status, 200);
    assert.equal(classic.body, BOARD_MARK);

    const deniedApi = await request({ port: on.port, reqPath: '/api/command-center' });
    assert.equal(deniedApi.status, 403);

    const api = await request({ port: on.port, reqPath: '/api/command-center', headers: on.watchAuth });
    assert.equal(api.status, 200);
    const body = JSON.parse(api.body);
    assert.equal(body.stats.projectsTotal.value, 1);
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].id, 'abc');

    const cockpit = await request({
      port: on.port,
      reqPath: '/api/command-center/project?id=abc',
      headers: on.watchAuth,
    });
    assert.equal(cockpit.status, 200);
    assert.equal(JSON.parse(cockpit.body).id, 'abc');

    assertSnapshotNoMoney(body, '/api/command-center');
    assertSnapshotNoMoney(JSON.parse(cockpit.body), '/api/command-center/project');

    const missing = await request({
      port: on.port,
      reqPath: '/api/command-center/project?id=missing',
      headers: on.watchAuth,
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body, 'not found');
  } finally {
    await on.dispose();
  }
});

test('command center flag follows SWARM_COMMAND_CENTER=1 in env', async () => {
  const on = await startWatchServer({ env: { SWARM_COMMAND_CENTER: '1' } });
  try {
    const res = await request({ port: on.port, reqPath: '/api/command-center', headers: on.watchAuth });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).stats.projectsTotal.value, 1);
  } finally {
    await on.dispose();
  }
});

test('command center project paths reject unsafe ids', async () => {
  const on = await startWatchServer({ commandCenter: true });
  try {
    const badPaths = [
      '/command-center/project/a/b',
      `/command-center/project/${encodeURIComponent('..')}`,
      '/command-center/project/x%2Fy',
    ];
    for (const reqPath of badPaths) {
      await expectSameAsUnknown(on.port, `${reqPath}?${on.pageQuery()}`);
    }

    const slashApi = await request({
      port: on.port,
      reqPath: '/api/command-center/project?id=a%2Fb',
      headers: on.watchAuth,
    });
    assert.equal(slashApi.status, 404);

    const dotApi = await request({
      port: on.port,
      reqPath: '/api/command-center/project?id=..',
      headers: on.watchAuth,
    });
    assert.equal(dotApi.status, 404);

    const ok = await request({
      port: on.port,
      reqPath: `/command-center/project/abc?${on.pageQuery()}`,
    });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /command-center-boot\.js/);
  } finally {
    await on.dispose();
  }
});

test('classic board routes stay the same with the flag on or off', async () => {
  const off = await startWatchServer({ commandCenter: false });
  const on = await startWatchServer({ commandCenter: true });
  try {
    for (const ctx of [off, on]) {
      const projectDenied = await request({ port: ctx.port, reqPath: '/project' });
      assert.equal(projectDenied.status, 403);
      const project = await request({ port: ctx.port, reqPath: `/project?${ctx.pageQuery()}` });
      assert.equal(project.status, 200);
      assert.match(project.body, /<title>project<\/title>/);

      const runDenied = await request({ port: ctx.port, reqPath: '/run' });
      assert.equal(runDenied.status, 403);
      const run = await request({ port: ctx.port, reqPath: `/run?${ctx.pageQuery()}` });
      assert.equal(run.status, 200);
      assert.match(run.body, /<title>run<\/title>/);
    }

    const offHome = await request({ port: off.port, reqPath: `/?${off.pageQuery()}` });
    assert.equal(offHome.body, BOARD_MARK);
    const offClassic = await request({ port: off.port, reqPath: `/classic?${off.pageQuery()}` });
    assert.equal(offClassic.body, BOARD_MARK);

    const onRoot = await request({ port: on.port, reqPath: `/?${on.pageQuery()}` });
    assert.match(onRoot.body, /command-center-boot\.js/);
    const onClassic = await request({ port: on.port, reqPath: `/classic?${on.pageQuery()}` });
    assert.equal(onClassic.body, BOARD_MARK);
  } finally {
    await off.dispose();
    await on.dispose();
  }
});
