// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const PANEL_FAIL_TEXT = 'This panel failed to render.';
const PROJECT_ID = 'large-fixture';

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, force) => {
      const on = force !== undefined ? force : !set.has(c);
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
    contains: (c) => set.has(c),
    toString: () => [...set].join(' '),
  };
}

function makeElement(tag, id) {
  const classList = makeClassList();
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    id: id || '',
    className: '',
    classList,
    children: [],
    childNodes: [],
    style: {},
    attributes: {},
    hidden: false,
    textContent: '',
    href: '',
    parentNode: null,
    firstChild: null,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    remove() {
      if (this.parentNode) {
        const p = this.parentNode;
        p.children = p.children.filter((c) => c !== this);
        p.childNodes = p.childNodes.filter((c) => c !== this);
        this.parentNode = null;
      }
    },
    insertBefore(child, ref) {
      const idx = ref ? this.children.indexOf(ref) : 0;
      if (idx < 0) {
        this.appendChild(child);
        return child;
      }
      this.children.splice(idx, 0, child);
      this.childNodes.splice(idx, 0, child);
      child.parentNode = this;
      this.firstChild = this.children[0] || null;
      return child;
    },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      this.firstChild = this.children[0] || null;
      return child;
    },
    closest() { return null; },
    querySelector(sel) {
      const walk = (n) => {
        if (!n) return null;
        if (sel === 'h2' && n.tagName === 'H2') return n;
        for (const c of n.children || []) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  };
  Object.defineProperty(node, 'className', {
    get() { return classList.toString(); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

function makeSvgElement(tag) {
  const node = makeElement(tag);
  node.setAttribute = function setAttribute(k, v) { this.attributes[k] = v; };
  return node;
}

function createProjectDom() {
  const byId = Object.create(null);
  const reg = (id, node) => {
    node.id = id;
    byId[id] = node;
    return node;
  };
  const main = makeElement('main');
  const pane = makeElement('section', 'pane-overview');
  reg('progress', makeElement('section', 'progress')).appendChild(reg('progressBody', makeElement('div', 'progressBody')));
  pane.appendChild(byId.progress);
  reg('split', makeElement('section', 'split')).appendChild(reg('splitBody', makeElement('div', 'splitBody')));
  pane.appendChild(byId.split);
  reg('handled', makeElement('section', 'handled')).appendChild(reg('handledBody', makeElement('div', 'handledBody')));
  pane.appendChild(byId.handled);
  reg('bench', makeElement('section', 'bench')).appendChild(reg('benchBody', makeElement('div', 'benchBody')));
  pane.appendChild(byId.bench);
  pane.appendChild(reg('tickets', makeElement('div', 'tickets')));
  pane.appendChild(reg('runs', makeElement('div', 'runs')));
  pane.appendChild(reg('lessons', makeElement('div', 'lessons')));
  main.appendChild(pane);

  function findById(id, root) {
    if (!root) return null;
    if (root.id === id) return root;
    for (const child of root.children || []) {
      const hit = findById(id, child);
      if (hit) return hit;
    }
    return null;
  }
  const doc = {
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    createElementNS: (_ns, tag) => makeSvgElement(tag),
    getElementById: (id) => byId[id] || findById(id, main) || findById(id, doc.body),
    querySelector(sel) {
      if (sel === 'main') return main;
      return null;
    },
  };
  doc.body.appendChild(main);

  for (const id of ['back', 'crumbBack', 'crumbAll', 'crumbProject', 'title', 'root', 'liveDot', 'liveText']) {
    reg(id, makeElement(id === 'title' ? 'h1' : 'a', id));
  }

  return { doc, byId, main };
}

function largeProjectPayload(overrides = {}) {
  const tickets = [];
  const statuses = ['todo', 'ready', 'running', 'done', 'blocked', 'review'];
  for (let i = 0; i < 220; i += 1) {
    tickets.push({
      id: `T-${i}`,
      title: `Ticket ${i}`,
      status: statuses[i % statuses.length],
      stage: 'S1',
      risk: 'low',
    });
  }
  const byStatus = Object.create(null);
  for (const ticket of tickets) {
    byStatus[ticket.status] = (byStatus[ticket.status] || 0) + 1;
  }
  const runs = [];
  for (let i = 0; i < 600; i += 1) {
    runs.push({
      runId: `run-${i}`,
      status: i % 17 === 0 ? 'failed' : 'complete',
      live: false,
      startedAt: '2026-10-21T12:00:00.000Z',
      jobs: 3,
      done: 2,
      failed: i % 17 === 0 ? 1 : 0,
    });
  }
  const lessons = [];
  for (let i = 0; i < 200; i += 1) {
    lessons.push({ id: `L-${i}`, what: `Lesson ${i}`, stage: 'S1' });
  }
  return {
    id: PROJECT_ID,
    name: 'Large fixture project',
    root: '/tmp/large-fixture',
    card: {
      now: { buildingTickets: 2, checkoutsBuilding: 1, lastTicketFinishedAt: '2026-10-21T11:00:00.000Z' },
      next: { ready: 1, items: [{ id: 'T-ready', title: 'Ready one', command: 'swarm tickets T-ready' }] },
      blocked: { waitingOnTickets: 0, items: [], needYou: 0, needYouItems: [] },
      slots: { machineMax: 8, inUse: 1, byThisProject: 1, byOtherProjects: 0 },
      eta: { days: 3, remaining: 10, perDay: 2, doneLast7Days: 14, windowDays: 7 },
      facts: { handEditsBlocked24h: 0, untrackedRuns: 0, checkouts: 1, listHref: '#untracked' },
      headsUp: 'Stage S1 has 2 tickets that write the same file in the same wave, so they cannot run together.',
    },
    progress: {
      overall: 42,
      percent: { board: { done: 21, total: 50, pct: 42 } },
    },
    benchmarks: {
      files: 1,
      week: '2026-W42',
      headline: 'fixture scorecard',
      projects: [{
        project: 'Large fixture project',
        metrics: [{
          name: 'pass_rate',
          label: 'Pass rate',
          value: 0.91,
          previous: 0.88,
          grade: 'green',
          verdict: 'better',
          weekly: [{ value: 0.8 }, { value: 0.91 }],
        }],
      }],
    },
    handled: {
      today: 1,
      week: 4,
      items: [{ at: '2026-10-21T10:00:00.000Z', rule: 'auto-merge', requestKind: 'ticket', requestId: 'T-1', reason: 'policy' }],
    },
    tickets,
    ticketCounts: { byStatus },
    runs,
    lessons,
    ...overrides,
  };
}

function collectText(node) {
  if (!node) return '';
  if (node.textContent) return node.textContent;
  return (node.children || []).map(collectText).join('');
}

async function loadBoardLib(win, doc) {
  const libSrc = await fs.readFile(path.join(assets, 'board-lib.js'), 'utf8');
  const box = { self: win, document: doc };
  vm.runInNewContext(libSrc, box);
  return box.self.BoardLib;
}

async function mountProjectPage({ fetchImpl, projectId = PROJECT_ID } = {}) {
  const { doc, byId } = createProjectDom();
  const win = {
    document: doc,
    location: { search: `?id=${encodeURIComponent(projectId)}`, pathname: '/project', hash: '' },
    navigator: { clipboard: { writeText: async () => {} } },
    sessionStorage: { getItem: () => 'test-token', setItem: () => {} },
    history: { replaceState: () => {}, state: null },
    console: { error() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    Date: Date,
    fetch: fetchImpl,
    __swarmProjectFetchWrapped: false,
  };
  win.self = win;
  win.window = win;
  win.BoardLib = await loadBoardLib(win, doc);
  const projectSrc = await fs.readFile(path.join(assets, 'project.js'), 'utf8');
  const intervalCallbacks = [];
  const sandbox = {
    self: win,
    window: win,
    document: doc,
    location: win.location,
    URLSearchParams,
    console: win.console,
    setInterval(fn) {
      intervalCallbacks.push(fn);
      return intervalCallbacks.length;
    },
    clearInterval: () => {},
    fetch(input, init) { return win.fetch(input, init); },
  };
  vm.runInNewContext(projectSrc, sandbox);
  const pollLoad = intervalCallbacks[1] || null;
  return { win, byId, doc, pollLoad };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushLoads() {
  for (let i = 0; i < 15; i += 1) await tick();
}

async function waitForPanels(byId) {
  for (let i = 0; i < 40; i += 1) {
    await tick();
    if (byId.tickets.children.length && byId.runs.children.length && byId.lessons.children.length) {
      return;
    }
  }
  throw new Error('project page panels did not render');
}

test('large project payload renders every overview panel', async () => {
  const payload = largeProjectPayload();
  const { byId } = await mountProjectPage({
    fetchImpl: async () => ({
      ok: true,
      json: async () => payload,
    }),
  });
  await waitForPanels(byId);

  assert.ok(byId.tickets.children.length > 0, 'tickets panel has children');
  assert.ok(byId.runs.children.length > 0, 'runs panel has children');
  assert.ok(byId.lessons.children.length > 0, 'lessons panel has children');
  assert.ok(byId.progressBody.children.length > 0, 'progress panel renders');
  assert.ok(byId.handledBody.children.length > 0, 'handled panel renders');
  assert.ok(byId.benchBody.children.length > 0, 'benchmark panel renders');
  assert.equal(byId.split.hidden, false, 'split section shows when headsUp is set');
  assert.ok(byId.splitBody.children.length > 0, 'split panel renders');

  const pageText = [
    collectText(byId.progressBody),
    collectText(byId.splitBody),
    collectText(byId.handledBody),
    collectText(byId.benchBody),
    collectText(byId.tickets),
    collectText(byId.runs),
    collectText(byId.lessons),
  ].join('\n');
  assert.doesNotMatch(pageText, new RegExp(PANEL_FAIL_TEXT));
  assert.equal(byId.title.textContent, payload.name);
});

test('one broken panel does not block the other overview panels', async () => {
  const broken = { ...largeProjectPayload(), tickets: null };
  const { byId } = await mountProjectPage({
    fetchImpl: async () => ({ ok: true, json: async () => broken }),
  });
  await flushLoads();

  assert.ok(byId.progressBody.children.length > 0, 'progress still renders after a panel error');
  assert.ok(byId.runs.children.length > 0, 'runs still render after a panel error');
  assert.match(collectText(byId.tickets), new RegExp(PANEL_FAIL_TEXT));
  assert.doesNotMatch(collectText(byId.runs), new RegExp(PANEL_FAIL_TEXT));
});

test('failed fetch and bad JSON show the load banner instead of blank sections', async () => {
  const { byId, doc } = await mountProjectPage({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => null }),
  });
  await flushLoads();
  const banner = doc.getElementById('projectLoadError');
  assert.ok(banner, 'load error banner exists');
  assert.match(banner.textContent, /Could not load this project: HTTP 500/);
  assert.equal(byId.tickets.children.length, 0);
  assert.equal(byId.runs.children.length, 0);

  const { doc: doc2 } = await mountProjectPage({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    }),
  });
  await flushLoads();
  const banner2 = doc2.getElementById('projectLoadError');
  assert.ok(banner2);
  assert.match(banner2.textContent, /Could not load this project: invalid JSON/);
});

test('successful render clears a prior load error banner', async () => {
  const payload = largeProjectPayload();
  let attempt = 0;
  const { doc, byId, pollLoad } = await mountProjectPage({
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, status: 503, json: async () => null };
      }
      return { ok: true, json: async () => payload };
    },
  });
  await flushLoads();
  assert.ok(doc.getElementById('projectLoadError'));
  assert.ok(pollLoad, 'project page registers a load poller');
  pollLoad();
  await waitForPanels(byId);
  assert.equal(doc.getElementById('projectLoadError'), null);
});
