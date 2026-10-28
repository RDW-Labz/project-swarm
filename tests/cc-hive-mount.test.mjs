// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildCommandCenterSnapshot } from '../tools/command-center-snapshot.mjs';

const dataModulePath = fileURLToPath(new URL('../tools/watch-assets/command-center-data.js', import.meta.url));

/** The shared parser is a classic script; load it the way the page does. */
async function parseCommandCenterSnapshot(body) {
  const box = { self: {} };
  vm.runInNewContext(await fs.readFile(dataModulePath, 'utf8'), box);
  return box.self.CommandCenterData.parseCommandCenterSnapshot(body);
}

const hivePanelsPath = fileURLToPath(new URL('../tools/watch-assets/hive-panels.js', import.meta.url));
const htmlPath = fileURLToPath(new URL('../tools/watch-assets/command-center.html', import.meta.url));
const hiveCssPath = fileURLToPath(new URL('../tools/watch-assets/cc-hive.css', import.meta.url));

async function ensureHivePanels(document) {
  if (globalThis.HivePanels?.renderHiveDashboard) return globalThis.HivePanels;
  const src = await fs.readFile(hivePanelsPath, 'utf8');
  const box = { module: { exports: {} }, exports: {}, document, self: globalThis, globalThis };
  vm.runInNewContext(src, box, { filename: hivePanelsPath });
  const api = box.module.exports?.renderHiveDashboard ? box.module.exports : box.HivePanels;
  globalThis.HivePanels = api;
  return api;
}

const NOW = Date.UTC(2026, 9, 26, 21, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      if (force === true) set.add(c);
      else if (force === false) set.delete(c);
      else if (set.has(c)) set.delete(c);
      else set.add(c);
    },
    toString: () => [...set].join(' '),
  };
}

function walkTree(node, fn) {
  if (!node) return;
  fn(node);
  for (const c of node.children || []) walkTree(c, fn);
}

/** Compound selectors only: tag, .class, [attr], [attr="v"] in any mix. */
function matches(n, sel) {
  if (!n || !n.classList) return false;
  const re = /(^[a-z][a-z0-9]*)|\.([\w-]+)|\[([\w-]+)(?:="?([^"\]]*)"?)?\]/gi;
  let m;
  let any = false;
  while ((m = re.exec(sel))) {
    any = true;
    if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && !n.classList.contains(m[2])) return false;
    if (m[3]) {
      const v = n.getAttribute(m[3]);
      if (v === null) return false;
      if (m[4] !== undefined && v !== m[4]) return false;
    }
  }
  return any;
}

function makeElement(tag, rect = { width: 120, height: 44, left: 0, top: 0 }) {
  const classList = makeClassList();
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    classList,
    children: [],
    childNodes: [],
    style: { setProperty(name, value) { this[name] = value; } },
    dataset: {},
    attributes: {},
    textContent: '',
    parentNode: null,
    firstChild: null,
    _rect: { ...rect },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      this.firstChild = this.children[0] || null;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) {
        this.children.splice(i, 1);
        this.childNodes = this.children.slice();
        child.parentNode = null;
        this.firstChild = this.children[0] || null;
      }
      return child;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type);
      if (!list) return;
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent(evt) {
      for (const h of listeners.get(evt.type) || []) h(evt);
      return true;
    },
    getBoundingClientRect() {
      const r = this._rect;
      return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height };
    },
    querySelector(sel) {
      let found = null;
      walkTree(this, (n) => { if (!found && n !== this && matches(n, sel)) found = n; });
      return found;
    },
    querySelectorAll(sel) {
      const out = [];
      walkTree(this, (n) => { if (n !== this && matches(n, sel)) out.push(n); });
      return out;
    },
    getContext() {
      if (!this._ctx) {
        const calls = { clearRect: 0 };
        this._ctx = {
          calls,
          clearRect() { calls.clearRect += 1; },
          save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, stroke() {}, fill() {}, arc() {},
          fillRect() {}, fillText() {}, translate() {}, rotate() {}, drawImage() {}, setLineDash() {},
          createLinearGradient() { return { addColorStop() {} }; },
          createRadialGradient() { return { addColorStop() {} }; },
        };
      }
      return this._ctx;
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return classList.toString(); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

function createFakeDom() {
  let hidden = false;
  let reducedMotion = false;
  const rafCallbacks = [];
  let rafIdSeq = 1;
  const cancelled = new Set();
  const stageRect = { width: 900, height: 700, left: 10, top: 10 };

  const document = {
    createElement(tag) {
      const el = makeElement(tag);
      if (tag === 'canvas') el._rect = { ...stageRect };
      return el;
    },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
    addEventListener(type, handler) { if (type === 'visibilitychange') this._visHandler = handler; },
    removeEventListener(type, handler) { if (type === 'visibilitychange' && this._visHandler === handler) this._visHandler = null; },
    get hidden() { return hidden; },
    set hidden(v) { hidden = Boolean(v); },
    defaultView: null,
  };
  const win = { innerWidth: 1200, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  document.defaultView = win;

  const matchMedia = () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} });
  const requestAnimationFrame = (cb) => {
    const id = rafIdSeq++;
    rafCallbacks.push({ id, cb });
    return id;
  };
  const cancelAnimationFrame = (id) => { cancelled.add(id); };
  const flushOneFrame = (t = NOW) => {
    const pending = rafCallbacks.filter((x) => !cancelled.has(x.id));
    rafCallbacks.length = 0;
    for (const { id, cb } of pending) if (!cancelled.has(id)) cb(t);
  };

  return {
    document,
    win,
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    flushOneFrame,
    setReducedMotion(v) { reducedMotion = v; },
    setHidden(v) {
      document.hidden = v;
      if (document._visHandler) document._visHandler();
    },
    stageRect,
  };
}

function boardFixture() {
  return {
    at: iso(NOW),
    machine: { agents: { total: 4 }, cost: { allUsd: 12.5 } },
    projects: [
      {
        id: 'proj-a',
        name: 'Alpha',
        machine: 'host-a',
        agents: { total: 2, jobs: { running: 1 } },
        progress: { overall: 40 },
        card: { blocked: { needYou: 0 }, now: { buildingTickets: 1 }, next: { ready: 3 } },
        tickets: { byStatus: { done: 2, ready: 1, blocked: 1, review: 1, cancelled: 1, failed: 1 } },
        ledger: {
          tickets: [
            { id: 'T-1', title: 'One', status: 'done', doneAt: iso(NOW - 30 * 60000) },
            { id: 'T-2', title: 'Two', status: 'done', doneAt: iso(NOW - 5 * 3600000) },
            { id: 'T-3', title: 'Three', status: 'review' },
            { id: 'T-4', title: 'Four', status: 'blocked' },
          ],
        },
      },
      {
        id: 'proj-b',
        name: 'Beta',
        machine: 'host-b',
        agents: { total: 0 },
        progress: { overall: 80 },
        card: { blocked: { needYou: 2 }, now: { buildingTickets: 0 }, next: { ready: 0 } },
        tickets: { byStatus: { done: 4, cancelled: 1 } },
      },
    ],
  };
}

function collectText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  let s = node.textContent || '';
  for (const c of node.children || []) s += collectText(c);
  return s;
}

function mount(dom, snapshot, extra = {}) {
  const host = makeElement('div');
  const opened = [];
  return import('../tools/watch-assets/cc-hive-mount.js').then(({ renderHive }) => {
    const handle = renderHive(host, snapshot, {
      document: dom.document,
      now: () => NOW,
      requestAnimationFrame: extra.requestAnimationFrame || dom.requestAnimationFrame,
      cancelAnimationFrame: dom.cancelAnimationFrame,
      matchMedia: dom.matchMedia,
      onOpenProject: (id) => opened.push(id),
    });
    return { host, handle, opened };
  });
}

function counter(host, label) {
  const v = host.querySelector(`.v[data-k="${label}"]`);
  return v ? { text: v.textContent, source: v.getAttribute('data-source'), tip: v.getAttribute('data-tip') } : null;
}

test('Hive shows four labelled counters, one card per project with its ledger numbers, and opens a project on click', async () => {
  const dom = createFakeDom();
  globalThis.document = dom.document;
  await ensureHivePanels(dom.document);
  const snapshot = buildCommandCenterSnapshot(boardFixture(), { now: NOW });
  const { host, handle, opened } = await mount(dom, snapshot);

  assert.ok(host.querySelector('.hive-shell'));
  assert.deepEqual(counter(host, 'projects').text, '2');
  assert.equal(counter(host, 'projects').source, 'stats.projectsTotal');
  assert.equal(counter(host, 'agents').text, '4', 'agents from stats.agentsLive');
  assert.equal(counter(host, 'need you').text, '2', 'need you from stats.needsYouCount');
  assert.equal(counter(host, 'done 24h').text, '2', 'done 24h from hive.doneLast24h (ledger completions)');
  for (const label of ['projects', 'agents', 'done 24h', 'need you']) assert.ok(counter(host, label).tip.length, `${label} tooltip`);

  const cards = host.querySelectorAll('.hive-node');
  assert.equal(cards.length, snapshot.projects.length);
  assert.equal(cards[0].getAttribute('data-project-id'), 'proj-a');
  assert.equal(cards[1].getAttribute('data-project-id'), 'proj-b');
  const alpha = collectText(cards[0]);
  assert.match(alpha, /01Alpha/);
  assert.match(alpha, /tickets7/, 'tickets total counts every status but proposed');
  assert.match(alpha, /done2 of 6/, 'done of tickets that still count (cancelled left out)');
  assert.match(alpha, /blocked1/);
  assert.match(alpha, /in review1/);
  assert.match(alpha, /33%/);
  assert.equal(cards[0].getAttribute('data-status'), 'building');
  const beta = collectText(cards[1]);
  assert.match(beta, /DONE/);
  assert.match(beta, /cancelled1/, 'a finished project shows cancelled instead of blocked');
  assert.match(beta, /100%/);
  assert.match(beta, /1\.00/);
  assert.equal(cards[1].getAttribute('data-status'), 'done');

  const legend = host.querySelector('.hive-legend');
  assert.ok(legend);
  assert.equal(legend.querySelectorAll('i').length, 5);

  cards[0].dispatchEvent({ type: 'click' });
  cards[1].dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  assert.deepEqual(opened, ['proj-a', 'proj-b']);

  handle.destroy();
  assert.equal(host.children.length, 0);
});

test('Hive panels read the ledger: session log, hourly bars, per-project percent, totals', async () => {
  const dom = createFakeDom();
  globalThis.document = dom.document;
  await ensureHivePanels(dom.document);
  const snapshot = buildCommandCenterSnapshot(boardFixture(), { now: NOW });
  const { host, handle } = await mount(dom, snapshot);

  const log = collectText(host.querySelector('.hive-slog'));
  assert.match(log, /review.*T-3/);
  assert.match(log, /waits.*T-4/);
  assert.match(log, /done.*T-1.*30 min ago/);
  const bars = host.querySelector('.hive-bars').querySelectorAll('i');
  assert.equal(bars.length, 24);
  assert.equal(bars[23].getAttribute('data-tip'), '1 done, 1 h ago');
  assert.equal(bars[18].getAttribute('data-tip'), '1 done, 6 h ago');
  const panels = collectText(host.querySelector('.hive-panels'));
  assert.match(panels, /2projects on the board/);
  assert.match(panels, /read from host-a, host-b/);
  assert.match(panels, /Alpha.*33%/s);
  assert.match(panels, /Beta.*100%/s);
  assert.match(panels, /no per-lane job counts in the board data/, 'lanes missing from the payload say so');
  assert.match(panels, /tickets in the ledger.*12/s);
  assert.match(panels, /tickets left to do.*4/s);
  assert.match(panels, /held for you.*2/s);
  assert.match(panels, /saved by the swarm.*not measured yet/s);
  assert.ok(host.querySelector('svg'), 'completions-per-hour step chart');
  handle.destroy();
});

test('Hive says so when the snapshot has no ledger numbers (parsed snapshot, no extras)', async () => {
  const dom = createFakeDom();
  globalThis.document = dom.document;
  await ensureHivePanels(dom.document);
  const parsed = await parseCommandCenterSnapshot(buildCommandCenterSnapshot(boardFixture(), { now: NOW }));
  const { host, handle } = await mount(dom, parsed);
  const cards = host.querySelectorAll('.hive-node');
  assert.equal(cards.length, 2);
  assert.match(collectText(cards[0]), /no ledger numbers yet/);
  assert.equal(counter(host, 'done 24h').text, '—');
  const panels = collectText(host.querySelector('.hive-panels'));
  assert.match(panels, /no completion times in the ledger/);
  assert.match(panels, /no ledger counts yet/);
  assert.match(panels, /no ledger percentages yet/);
  handle.destroy();
});

test('update with the same data keeps the card elements; a new agent count shows a toast', async () => {
  const dom = createFakeDom();
  globalThis.document = dom.document;
  await ensureHivePanels(dom.document);
  const board = boardFixture();
  const { host, handle } = await mount(dom, buildCommandCenterSnapshot(board, { now: NOW }));
  const before = host.querySelectorAll('.hive-node');
  handle.update(buildCommandCenterSnapshot(board, { now: NOW }));
  const after = host.querySelectorAll('.hive-node');
  assert.equal(after[0], before[0], 'unchanged data does not rebuild the cards (robot heads keep running)');

  board.machine.agents.total = 6;
  handle.update(buildCommandCenterSnapshot(board, { now: NOW }));
  assert.equal(counter(host, 'agents').text, '6');
  assert.match(collectText(host.querySelector('.hive-toast')), /2 agents started/);
  handle.destroy();
});

test('Hive animates the canvas, stops while the tab is hidden, and destroy cancels the loop', async () => {
  const dom = createFakeDom();
  globalThis.document = dom.document;
  await ensureHivePanels(dom.document);
  let scheduled = 0;
  const raf = (cb) => { scheduled += 1; return dom.requestAnimationFrame(cb); };
  const snapshot = buildCommandCenterSnapshot(boardFixture(), { now: NOW });
  const { host, handle } = await mount(dom, snapshot, { requestAnimationFrame: raf });
  const canvas = host.querySelector('canvas');
  assert.ok(scheduled >= 1);
  const before = canvas._ctx.calls.clearRect;
  dom.flushOneFrame(NOW + 50);
  assert.ok(canvas._ctx.calls.clearRect > before);

  dom.setHidden(true);
  dom.flushOneFrame(NOW + 100);
  const afterHidden = canvas._ctx.calls.clearRect;
  dom.flushOneFrame(NOW + 150);
  assert.equal(canvas._ctx.calls.clearRect, afterHidden, 'hidden document pauses the animation loop');

  handle.destroy();
  const beforeFlush = scheduled;
  dom.flushOneFrame(NOW + 500);
  assert.equal(scheduled, beforeFlush);
});

test('Hive draws one still frame when reduced motion is preferred', async () => {
  const dom = createFakeDom();
  dom.setReducedMotion(true);
  globalThis.document = dom.document;
  await ensureHivePanels(dom.document);
  let scheduled = 0;
  const raf = (cb) => { scheduled += 1; return dom.requestAnimationFrame(cb); };
  const { host, handle } = await mount(dom, buildCommandCenterSnapshot(boardFixture(), { now: NOW }), { requestAnimationFrame: raf });
  const canvas = host.querySelector('canvas');
  const drawsAfterMount = canvas._ctx.calls.clearRect;
  assert.ok(drawsAfterMount >= 1);
  assert.equal(scheduled, 0, 'reduced motion: no animation loop');
  dom.flushOneFrame(NOW + 40);
  dom.flushOneFrame(NOW + 80);
  assert.equal(canvas._ctx.calls.clearRect, drawsAfterMount);
  handle.destroy();
});

test('command-center.html links the stylesheets in the contract order and keeps one module script', async () => {
  const html = await fs.readFile(htmlPath, 'utf8');
  const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [
    '/assets/cc-theme.css',
    '/assets/swarm-ui.css',
    '/assets/cc-phone.css',
    '/assets/command-center.css',
    '/assets/cc-hive.css',
    '/assets/cc-cockpit.css',
  ]);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  assert.match(html, /<script type="module" src="\/assets\/command-center-boot\.js"><\/script>/);
  assert.match(html, /id="command-center-root"/);
});

test('cc-hive.css scopes every selector under .hive-body or .hive-shell and loads no remote font', async () => {
  const css = (await fs.readFile(hiveCssPath, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /https?:\/\/|googleapis|gstatic/);
  const bad = [];
  for (const line of css.split('\n')) {
    const t = line.trim();
    if (!t.includes('{') || t.startsWith('@')) continue;
    const selector = t.slice(0, t.indexOf('{'));
    for (const part of selector.split(',')) {
      if (!/^\.hive-(body|shell)\b/.test(part.trim())) bad.push(part.trim());
    }
  }
  assert.deepEqual(bad, []);
});
