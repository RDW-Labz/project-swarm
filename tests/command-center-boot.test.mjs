// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildCommandCenterSnapshot, buildProjectCockpit } from '../tools/command-center-snapshot.mjs';
import { completionKey, hasCompleted } from '../tools/watch-assets/cc-tour.js';

process.env.SWARM_COMMAND_CENTER_BOOT_TEST = '1';

const assetsDir = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const hivePanelsPath = fileURLToPath(new URL('../tools/watch-assets/hive-panels.js', import.meta.url));
const dataModulePath = fileURLToPath(new URL('../tools/watch-assets/command-center-data.js', import.meta.url));

const NOW = Date.UTC(2026, 10, 26, 20, 0, 0);

function loadCommandCenterData() {
  const src = fs.readFileSync(dataModulePath, 'utf8');
  const box = { self: {} };
  vm.runInNewContext(src, box);
  return box.self.CommandCenterData;
}

async function ensureHivePanels(document) {
  if (globalThis.HivePanels?.renderHivePanels) return globalThis.HivePanels;
  const src = await fsPromises.readFile(hivePanelsPath, 'utf8');
  const box = {
    module: { exports: {} },
    exports: {},
    document,
    self: globalThis,
    globalThis,
  };
  vm.runInNewContext(src, box, { filename: hivePanelsPath });
  const api = box.module.exports?.renderHivePanels ? box.module.exports : box.HivePanels;
  globalThis.HivePanels = api;
  return api;
}

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

function matchesSelector(n, sel) {
  if (!n) return false;
  if (sel === '.hive-node' && n.classList?.contains('hive-node')) return true;
  if (sel === '.hive-legend' && n.classList?.contains('hive-legend')) return true;
  if (sel === '.cc-cockpit-shell' && n.classList?.contains('cc-cockpit-shell')) return true;
  if (sel === '.cc-cockpit-back-btn' && n.classList?.contains('cc-cockpit-back-btn')) return true;
  if (sel === '.cc-shell-message' && n.classList?.contains('cc-shell-message')) return true;
  if (sel === '.cc-tour-overlay' && n.classList?.contains('cc-tour-overlay')) return true;
  const tourMatch = String(sel).match(/^\[data-tour=['"]([^'"]+)['"]\]$/);
  if (tourMatch && n.getAttribute?.('data-tour') === tourMatch[1]) return true;
  return false;
}

function makeElement(tag, rect = { width: 120, height: 44, left: 0, top: 0 }) {
  const classList = makeClassList();
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    classList,
    children: [],
    childNodes: [],
    style: { setProperty(name, value) { this[name] = value; } },
    dataset: {},
    attributes: {},
    textContent: '',
    parentNode: null,
    firstChild: null,
    ownerDocument: null,
    type: tag === 'button' ? 'button' : undefined,
    _rect: { ...rect },
    setAttribute(k, v) {
      this.attributes[k] = v;
      if (k === 'data-tour') this.dataset.tour = v;
    },
    getAttribute(k) {
      return this.attributes[k] ?? null;
    },
    appendChild(child) {
      this.children.push(child);
      this.childNodes = this.children;
      child.parentNode = this;
      this.firstChild = this.children[0] || null;
      return child;
    },
    append(...kids) {
      for (const child of kids) this.appendChild(child);
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
    replaceChildren(...kids) {
      this.children = [];
      this.childNodes = [];
      for (const k of kids) this.appendChild(k);
      this.firstChild = this.children[0] || null;
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
      for (const fn of listeners.get(evt.type) || []) fn(evt);
      return true;
    },
    click() {
      this.dispatchEvent({ type: 'click', preventDefault() {} });
    },
    focus() {
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    querySelector(sel) {
      let found = null;
      walkTree(this, (n) => {
        if (found) return;
        if (matchesSelector(n, sel)) found = n;
      });
      return found;
    },
    querySelectorAll(sel) {
      const out = [];
      walkTree(this, (n) => {
        if (matchesSelector(n, sel)) out.push(n);
      });
      return out;
    },
    getBoundingClientRect() {
      return {
        left: this._rect.left,
        top: this._rect.top,
        right: this._rect.left + this._rect.width,
        bottom: this._rect.top + this._rect.height,
        width: this._rect.width,
        height: this._rect.height,
      };
    },
    getContext() {
      if (!this._ctx) {
        this._ctx = {
          setTransform() {},
          clearRect() {},
          save() {},
          restore() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          quadraticCurveTo() {},
          stroke() {},
          fill() {},
          arc() {},
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
  const stageRect = { width: 900, height: 700, left: 10, top: 10 };
  let hidden = false;
  let reducedMotion = true;
  const rafCallbacks = [];
  let rafIdSeq = 1;
  const cancelled = new Set();

  const body = makeElement('body');
  body.querySelector = (sel) => {
    let found = null;
    walkTree(body, (n) => {
      if (!found && matchesSelector(n, sel)) found = n;
    });
    return found;
  };
  function docQuerySelector(sel) {
    let found = null;
    const walk = (n) => {
      if (found || !n) return;
      if (matchesSelector(n, sel)) {
        found = n;
        return;
      }
      for (const c of n.children || []) walk(c);
    };
    walk(body);
    if (!found) walk(rootFromDoc?.());
    return found;
  }

  function rootFromDoc() {
    return body.children[0] || null;
  }

  const document = {
    body,
    head: makeElement('head'),
    documentElement: makeElement('html'),
    hidden,
    activeElement: null,
    querySelector(sel) {
      return docQuerySelector(sel);
    },
    createElement(tag) {
      if (tag === 'canvas') {
        const c = makeElement('canvas');
        c._rect = { ...stageRect };
        return c;
      }
      const el = makeElement(tag);
      el.ownerDocument = document;
      return el;
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: text };
    },
    addEventListener(type, handler) {
      if (type === 'visibilitychange') this._visHandler = handler;
    },
    removeEventListener(type, handler) {
      if (type === 'visibilitychange' && this._visHandler === handler) this._visHandler = null;
    },
    get hidden() { return hidden; },
    set hidden(v) { hidden = Boolean(v); },
    defaultView: null,
  };

  const win = {
    innerWidth: 1200,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = win;

  const matchMedia = () => ({
    matches: reducedMotion,
    addEventListener() {},
    removeEventListener() {},
  });

  const requestAnimationFrame = (cb) => {
    const id = rafIdSeq++;
    rafCallbacks.push({ id, cb });
    return id;
  };

  const cancelAnimationFrame = (id) => {
    cancelled.add(id);
  };

  return {
    document,
    body,
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    stageRect,
  };
}

function boardFixture() {
  return {
    at: new Date(NOW).toISOString(),
    machine: { agents: { total: 2 }, cost: { allUsd: 5 } },
    projects: [
      {
        id: 'alpha',
        name: 'Alpha',
        agents: { total: 1, jobs: { running: 1 } },
        progress: { overall: 50 },
        card: { blocked: { needYou: 0 }, now: { buildingTickets: 1 }, next: { ready: 1 } },
        tickets: { byStatus: {} },
        ledger: { tickets: [{ id: 'T-1', title: 'One', status: 'ready', stage: 'S1' }], scope: { stages: [{ id: 'S1', name: 'Stage' }] } },
        orchestrator: { sessions: [{ id: 's1', state: 'working', lastAt: new Date(NOW).toISOString() }] },
        live: [{ runId: 'run-1', status: 'running', jobs: 1, done: 0 }],
      },
      {
        id: 'beta',
        name: 'Beta',
        agents: { total: 0 },
        progress: { overall: 10 },
        card: { blocked: { needYou: 0 }, now: { buildingTickets: 0 }, next: { ready: 0 } },
        tickets: { byStatus: {} },
      },
    ],
  };
}

function makeRuntime() {
  const dom = createFakeDom();
  globalThis.document = dom.document;
  globalThis.CommandCenterData = loadCommandCenterData();

  let pathname = '/command-center';
  const pushStates = [];
  const history = {
    pushState(_state, _title, url) {
      pathname = url;
      pushStates.push(url);
    },
  };
  const location = {
    get pathname() { return pathname; },
    set pathname(v) { pathname = v; },
    search: '',
  };

  const board = boardFixture();
  const hiveSnapshot = buildCommandCenterSnapshot(board, { now: NOW });
  const cockpit = buildProjectCockpit(board, 'alpha');

  let fetchCalls = 0;
  const fetchJson = async (url) => {
    fetchCalls += 1;
    if (String(url).includes('/api/command-center/project')) {
      return cockpit;
    }
    if (String(url).includes('/api/command-center')) {
      return hiveSnapshot;
    }
    throw new Error(`unexpected url ${url}`);
  };

  const intervals = [];
  const setInterval = (fn, ms) => {
    const id = intervals.length + 1;
    intervals.push({ id, fn, ms });
    return id;
  };
  const clearInterval = () => {};

  const timeouts = [];
  const setTimeout = (fn, ms) => {
    const id = timeouts.length + 1;
    timeouts.push({ id, fn, ms });
    return id;
  };
  const clearTimeout = () => {};

  const storage = {
    _data: new Map(),
    getItem(k) { return this._data.get(k) ?? null; },
    setItem(k, v) { this._data.set(k, v); },
  };

  const root = makeElement('div');
  root._rect = dom.stageRect;
  dom.body.appendChild(root);

  return {
    dom,
    root,
    history,
    location,
    fetchJson,
    fetchCalls: () => fetchCalls,
    setInterval,
    intervals,
    setTimeout,
    timeouts,
    clearTimeout,
    storage,
    hiveSnapshot,
    cockpit,
    board,
    pushStates,
  };
}

async function mountWithRuntime(rt) {
  await ensureHivePanels(rt.dom.document);
  const { mountCommandCenter } = await import('../tools/watch-assets/command-center-boot.js');
  const handle = mountCommandCenter(rt.root, {
    document: rt.dom.document,
    fetchJson: rt.fetchJson,
    location: rt.location,
    history: rt.history,
    now: () => NOW,
    setInterval: rt.setInterval,
    clearInterval: () => {},
    setTimeout: rt.setTimeout,
    clearTimeout: rt.clearTimeout,
    requestAnimationFrame: rt.dom.requestAnimationFrame,
    cancelAnimationFrame: rt.dom.cancelAnimationFrame,
    matchMedia: rt.dom.matchMedia,
    storage: rt.storage,
  });
  await handle.whenReady;
  return handle;
}

test('hive path renders project cards', async () => {
  const rt = makeRuntime();
  await mountWithRuntime(rt);
  const cards = rt.root.querySelectorAll('.hive-node');
  assert.equal(cards.length, rt.hiveSnapshot.projects.length);
});

test('project path renders the cockpit shell', async () => {
  const rt = makeRuntime();
  rt.location.pathname = '/command-center/project/alpha';
  await mountWithRuntime(rt);
  assert.ok(rt.root.querySelector('.cc-cockpit-shell'));
});

test('clicking a hive card pushes the project path', async () => {
  const rt = makeRuntime();
  await mountWithRuntime(rt);
  const card = rt.root.querySelector('.hive-node');
  assert.ok(card);
  card.click();
  assert.equal(rt.pushStates.at(-1), '/command-center/project/alpha');
});

test('back from cockpit returns to the hive view', async () => {
  const rt = makeRuntime();
  rt.location.pathname = '/command-center/project/alpha';
  const handle = await mountWithRuntime(rt);
  const back = rt.root.querySelector('.cc-cockpit-back-btn');
  assert.ok(back);
  back.click();
  assert.equal(rt.pushStates.at(-1), '/command-center');
  rt.location.pathname = '/command-center';
  await handle.refresh();
  assert.ok(rt.root.querySelector('.hive-node'));
  handle.destroy();
});

test('failed fetch shows an explanatory message', async () => {
  const rt = makeRuntime();
  rt.fetchJson = async () => {
    throw new Error('network down');
  };
  await mountWithRuntime(rt);
  const msg = rt.root.querySelector('.cc-shell-message');
  assert.ok(msg);
  assert.match(msg.textContent, /Could not load the Command Center/i);
  assert.match(msg.textContent, /network down/i);
});

test('refresh timer fetches again without clearing the hive', async () => {
  const rt = makeRuntime();
  const handle = await mountWithRuntime(rt);
  assert.equal(rt.fetchCalls(), 1);
  assert.ok(rt.root.querySelector('.hive-node'));
  const tick = rt.intervals.find((x) => x.ms === 5000);
  assert.ok(tick);
  await tick.fn();
  assert.equal(rt.fetchCalls(), 2);
  assert.ok(rt.root.querySelector('.hive-node'));
  handle.destroy();
});

test('guided tour runs only on the first visit', async () => {
  const rt = makeRuntime();
  const handle = await mountWithRuntime(rt);
  const overlay = rt.root.querySelector('.cc-tour-overlay')
    || rt.dom.body.querySelector('.cc-tour-overlay')
    || rt.dom.document.body.querySelector('.cc-tour-overlay');
  assert.ok(overlay, 'tour overlay on first visit');
  const skip = overlay?.children?.[0]?.children?.find?.((n) => n.textContent === 'Skip tour')
    || walkForText(overlay, 'Skip tour');
  assert.ok(skip);
  skip.click();
  assert.ok(hasCompleted(rt.storage, 'anonymous'));
  handle.destroy();

  rt.root.replaceChildren();
  const handle2 = await mountWithRuntime(rt);
  const again = rt.root.querySelector('.cc-tour-overlay')
    || rt.dom.body.querySelector('.cc-tour-overlay');
  assert.equal(again, null, 'no second tour');
  assert.equal(rt.storage.getItem(completionKey('anonymous')), '1');
  handle2.destroy();
});

function walkForText(node, text) {
  if (!node) return null;
  if (node.textContent === text) return node;
  for (const c of node.children || []) {
    const hit = walkForText(c, text);
    if (hit) return hit;
  }
  return null;
}

test('browser idle preload inserts modulepreload for cockpit without loading cockpit on Hive', async () => {
  const rt = makeRuntime();
  const cockpitMountHref = new URL(
    './cc-cockpit-mount.js',
    new URL('../tools/watch-assets/command-center-boot.js', import.meta.url),
  ).href;
  let idleFn;
  const oldIdle = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = (fn) => {
    idleFn = fn;
    return 1;
  };
  try {
    const handle = await mountWithRuntime(rt);
    assert.ok(rt.root.querySelector('.hive-node'), 'Hive is visible before any cockpit switch');
    assert.equal(rt.root.querySelector('.cc-cockpit-shell'), null);
    idleFn?.();
    const link = rt.dom.document.head.children.find((node) => node.rel === 'modulepreload');
    assert.ok(link, 'modulepreload link is appended while Hive idles');
    assert.equal(link.href, cockpitMountHref);
    assert.equal(link.as, undefined);
    assert.equal(link.crossOrigin, undefined);
    handle.destroy();
  } finally {
    globalThis.requestIdleCallback = oldIdle;
  }
});

test('prompt cockpit warm adds modulepreload within 300ms without waiting for idle', async () => {
  const rt = makeRuntime();
  const cockpitMountHref = new URL(
    './cc-cockpit-mount.js',
    new URL('../tools/watch-assets/command-center-boot.js', import.meta.url),
  ).href;
  const oldIdle = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = () => 1;
  try {
    await ensureHivePanels(rt.dom.document);
    const { mountCommandCenter } = await import('../tools/watch-assets/command-center-boot.js');
    const handle = mountCommandCenter(rt.root, {
      document: rt.dom.document,
      fetchJson: rt.fetchJson,
      location: rt.location,
      history: rt.history,
      now: () => NOW,
      setInterval: rt.setInterval,
      clearInterval: () => {},
      setTimeout: rt.setTimeout,
      clearTimeout: rt.clearTimeout,
      requestAnimationFrame: rt.dom.requestAnimationFrame,
      cancelAnimationFrame: rt.dom.cancelAnimationFrame,
      matchMedia: rt.dom.matchMedia,
      storage: rt.storage,
    });
    await handle.whenReady;
    assert.ok(rt.root.querySelector('.hive-node'));
    assert.equal(
      rt.dom.document.head.children.find((node) => node.rel === 'modulepreload'),
      undefined,
      'modulepreload is not inserted until the warm timer fires',
    );
    const warm = rt.timeouts.find((timer) => timer.ms === 300);
    assert.ok(warm, 'schedules a 300ms cockpit warm after the first Hive render');
    warm.fn();
    const link = rt.dom.document.head.children.find((node) => node.rel === 'modulepreload');
    assert.ok(link, 'modulepreload link is appended after the warm timer');
    assert.equal(link.href, cockpitMountHref);
    handle.destroy();
  } finally {
    globalThis.requestIdleCallback = oldIdle;
  }
});
