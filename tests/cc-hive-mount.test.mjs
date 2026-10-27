// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildCommandCenterSnapshot } from '../tools/command-center-snapshot.mjs';
import { HIVE_LANES, HIVE_LANE_CSS_VAR } from '../tools/watch-assets/hive-layout.js';

const hivePanelsPath = fileURLToPath(new URL('../tools/watch-assets/hive-panels.js', import.meta.url));

async function ensureHivePanels(document) {
  if (globalThis.HivePanels?.renderHivePanels) return globalThis.HivePanels;
  const src = await fs.readFile(hivePanelsPath, 'utf8');
  const box = {
    module: { exports: {} },
    exports: {},
    document,
    self: globalThis,
    globalThis,
  };
  vm.runInNewContext(src, box, { filename: hivePanelsPath });
  const api = box.module.exports?.renderHivePanels
    ? box.module.exports
    : box.HivePanels;
  globalThis.HivePanels = api;
  return api;
}

const NOW = Date.UTC(2026, 9, 26, 21, 0, 0);

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

function makeElement(tag, rect = { width: 120, height: 44, left: 0, top: 0 }) {
  const classList = makeClassList();
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    classList,
    children: [],
    childNodes: [],
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
    },
    dataset: {},
    attributes: {},
    textContent: '',
    parentNode: null,
    firstChild: null,
    width: 0,
    height: 0,
    _rect: { ...rect },
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    getAttribute(k) {
      return this.attributes[k] ?? null;
    },
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
      const list = listeners.get(evt.type) || [];
      for (const h of list) h(evt);
      return true;
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
    querySelector(sel) {
      let found = null;
      walkTree(this, (n) => {
        if (found) return;
        if (sel === '.name' && n.classList?.contains('name')) found = n;
        if (sel === '.lbl' && n.classList?.contains('lbl')) found = n;
        if (sel === '.val' && n.classList?.contains('val')) found = n;
        if (sel === '.val.num' && n.classList?.contains('val') && n.classList?.contains('num')) found = n;
      });
      return found;
    },
    querySelectorAll(sel) {
      const out = [];
      walkTree(this, (n) => {
        if (sel === '.cc-stat' && n.classList?.contains('cc-stat')) out.push(n);
        if (sel === '.hive-node' && n.classList?.contains('hive-node')) out.push(n);
        if (sel === '.hive-legend span' && n.tagName === 'SPAN' && n.parentNode?.classList?.contains('hive-legend')) {
          out.push(n);
        }
      });
      return out;
    },
    getContext() {
      if (!this._ctx) {
        const calls = { clearRect: 0, staticDrawn: 0, animatedDrawn: 0 };
        this._ctx = {
          calls,
          setTransform() {},
          clearRect() {
            calls.clearRect += 1;
          },
          save() {},
          restore() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          quadraticCurveTo() {},
          stroke() {
            calls.animatedDrawn += 1;
          },
          fill() {
            calls.staticDrawn += 1;
          },
          arc() {},
        };
      }
      return this._ctx;
    },
  };
  Object.defineProperty(node, 'className', {
    get() {
      return classList.toString();
    },
    set(v) {
      classList.add(...String(v).split(/\s+/).filter(Boolean));
    },
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
    hidden,
    createElement(tag) {
      if (tag === 'canvas') {
        const c = makeElement('canvas');
        c._rect = { ...stageRect };
        return c;
      }
      return makeElement(tag);
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
    get hidden() {
      return hidden;
    },
    set hidden(v) {
      hidden = Boolean(v);
    },
    defaultView: null,
  };

  const matchMedia = () => ({
    matches: reducedMotion,
    addEventListener(type, handler) {
      this._handler = handler;
    },
    removeEventListener(type, handler) {
      if (this._handler === handler) this._handler = null;
    },
    _fireChange() {
      if (this._handler) this._handler();
    },
  });

  const win = {
    innerWidth: 1200,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = win;

  const requestAnimationFrame = (cb) => {
    const id = rafIdSeq++;
    rafCallbacks.push({ id, cb });
    return id;
  };

  const cancelAnimationFrame = (id) => {
    cancelled.add(id);
  };

  const flushOneFrame = (t = NOW) => {
    const pending = rafCallbacks.filter((x) => !cancelled.has(x.id));
    rafCallbacks.length = 0;
    for (const { id, cb } of pending) {
      if (!cancelled.has(id)) cb(t);
    }
  };

  return {
    document,
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    flushOneFrame,
    setReducedMotion(v) {
      reducedMotion = v;
    },
    setHidden(v) {
      document.hidden = v;
      if (document._visHandler) document._visHandler();
    },
    stageRect,
  };
}

function boardFixture() {
  return {
    at: new Date(NOW).toISOString(),
    machine: {
      agents: { total: 4 },
      cost: { allUsd: 12.5 },
    },
    projects: [
      {
        id: 'proj-a',
        name: 'Alpha',
        agents: { total: 2, jobs: { running: 1 } },
        progress: { overall: 40 },
        card: { blocked: { needYou: 0 }, now: { buildingTickets: 1 }, next: { ready: 3 } },
        tickets: { byStatus: { failed: 0 } },
        machine: 'host-a',
      },
      {
        id: 'proj-b',
        name: 'Beta',
        agents: { total: 0 },
        progress: { overall: 80 },
        card: { blocked: { needYou: 2 }, now: { buildingTickets: 0 }, next: { ready: 0 } },
        tickets: { byStatus: { failed: 1 } },
        machine: 'host-b',
      },
    ],
  };
}

function statFigure(statEl) {
  const lbl = (statEl.children || []).find((c) => c.classList?.contains('lbl'));
  const val = (statEl.children || []).find((c) => c.classList?.contains('val'));
  return {
    label: lbl ? lbl.textContent : '',
    value: val ? val.textContent : '',
    title: val ? val.getAttribute('title') : null,
  };
}

test('renderHive shows four labelled stats, project cards, legend colours, and interactions', async () => {
  const dom = createFakeDom();
  globalThis.document = dom.document;
  const { renderHive } = await import('../tools/watch-assets/cc-hive-mount.js');
  await ensureHivePanels(dom.document);

  const snapshot = buildCommandCenterSnapshot(boardFixture(), { now: NOW });
  const opened = [];
  const host = makeElement('div');
  host._rect = dom.stageRect;

  const mount = renderHive(host, snapshot, {
    document: dom.document,
    now: () => NOW,
    requestAnimationFrame: dom.requestAnimationFrame,
    cancelAnimationFrame: dom.cancelAnimationFrame,
    matchMedia: dom.matchMedia,
    onOpenProject: (id) => opened.push(id),
  });

  const strip = host.children[0]?.children?.[1];
  assert.ok(strip?.classList?.contains('hive-stat-strip'));
  const stats = strip.querySelectorAll('.cc-stat');
  assert.equal(stats.length, 4);
  for (const s of stats) {
    const fig = statFigure(s);
    assert.ok(fig.label.length);
    assert.ok(fig.value.length);
    assert.ok(fig.title && fig.title.length);
  }

  const stage = host.children[0]?.children?.[2];
  const nodes = stage?.children?.find((c) => c.id === 'hive-nodes');
  const cards = nodes.querySelectorAll('.hive-node');
  assert.equal(cards.length, snapshot.projects.length);

  const legend = host.children[0]?.children?.[0]?.children?.[0];
  assert.ok(legend?.classList?.contains('hive-legend'));
  const rows = legend.children;
  assert.equal(rows.length, HIVE_LANES.length);
  for (let i = 0; i < HIVE_LANES.length; i += 1) {
    const lane = HIVE_LANES[i];
    const swatch = rows[i].children[0];
    assert.equal(swatch.style.background, `var(${HIVE_LANE_CSS_VAR[lane]})`);
  }

  cards[0].dispatchEvent({ type: 'click' });
  assert.deepEqual(opened, ['proj-a']);

  const canvas = stage.children.find((c) => c.tagName === 'CANVAS');
  const before = canvas._ctx.calls.clearRect;
  dom.flushOneFrame(NOW + 50);
  assert.ok(canvas._ctx.calls.clearRect > before);

  dom.setHidden(true);
  const rafBefore = dom.flushOneFrame;
  dom.flushOneFrame(NOW + 100);
  const afterHidden = canvas._ctx.calls.clearRect;
  dom.flushOneFrame(NOW + 150);
  assert.equal(canvas._ctx.calls.clearRect, afterHidden, 'hidden document pauses animation loop');

  mount.destroy();
  assert.equal(host.children.length, 0);
});

test('renderHive draws one static frame when reduced motion is preferred', async () => {
  const dom = createFakeDom();
  dom.setReducedMotion(true);
  globalThis.document = dom.document;
  const { renderHive } = await import('../tools/watch-assets/cc-hive-mount.js');
  await ensureHivePanels(dom.document);

  const snapshot = buildCommandCenterSnapshot(boardFixture(), { now: NOW });
  const host = makeElement('div');
  host._rect = dom.stageRect;

  const mount = renderHive(host, snapshot, {
    document: dom.document,
    now: () => NOW,
    requestAnimationFrame: dom.requestAnimationFrame,
    cancelAnimationFrame: dom.cancelAnimationFrame,
    matchMedia: dom.matchMedia,
    onOpenProject: () => {},
  });

  const stage = host.children[0]?.children?.[2];
  const canvas = stage.children.find((c) => c.tagName === 'CANVAS');
  const drawsAfterMount = canvas._ctx.calls.clearRect;
  assert.ok(drawsAfterMount >= 1);

  dom.flushOneFrame(NOW + 40);
  dom.flushOneFrame(NOW + 80);
  assert.equal(canvas._ctx.calls.clearRect, drawsAfterMount, 'reduced motion: no ongoing redraw loop');

  mount.destroy();
});

test('destroy cancels scheduled animation frame', async () => {
  const dom = createFakeDom();
  globalThis.document = dom.document;
  const { renderHive } = await import('../tools/watch-assets/cc-hive-mount.js');
  await ensureHivePanels(dom.document);
  const snapshot = buildCommandCenterSnapshot(boardFixture(), { now: NOW });
  const host = makeElement('div');
  host._rect = dom.stageRect;

  let scheduled = 0;
  const raf = (cb) => {
    scheduled += 1;
    return dom.requestAnimationFrame(cb);
  };

  const mount = renderHive(host, snapshot, {
    document: dom.document,
    now: () => NOW,
    requestAnimationFrame: raf,
    cancelAnimationFrame: dom.cancelAnimationFrame,
    matchMedia: dom.matchMedia,
    onOpenProject: () => {},
  });

  assert.ok(scheduled >= 1);
  mount.destroy();
  const beforeFlush = scheduled;
  dom.flushOneFrame(NOW + 500);
  assert.equal(scheduled, beforeFlush);
});
