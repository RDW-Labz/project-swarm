// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const hivePanelsPath = path.join(assets, 'hive-panels.js');

async function loadHivePanels() {
  installDom();
  const src = await fs.readFile(hivePanelsPath, 'utf8');
  const box = {
    module: { exports: {} },
    exports: {},
    document: globalThis.document,
    self: globalThis,
    globalThis,
  };
  vm.runInNewContext(src, box, { filename: hivePanelsPath });
  const out = box.module.exports;
  if (out && typeof out.renderEventLog === 'function') { return out; }
  return box.HivePanels || box.self?.HivePanels;
}

let HivePanels;

const NOW = Date.UTC(2026, 9, 26, 20, 45, 0);

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c),
    toString: () => [...set].join(' '),
  };
}

function walkTree(node, fn) {
  if (!node) return;
  fn(node);
  for (const c of node.children || []) walkTree(c, fn);
}

function makeElement(tag) {
  const classList = makeClassList();
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    classList,
    children: [],
    childNodes: [],
    style: {},
    attributes: {},
    textContent: '',
    title: '',
    width: 360,
    height: 40,
    parentNode: null,
    firstChild: null,
    setAttribute(k, v) { this.attributes[k] = v; },
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
        this.firstChild = this.children[0] || null;
      }
      return child;
    },
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      const i = this.children.indexOf(ref);
      if (i < 0) return this.appendChild(child);
      this.children.splice(i, 0, child);
      this.childNodes = this.children.slice();
      child.parentNode = this;
      this.firstChild = this.children[0] || null;
      return child;
    },
    querySelector(sel) {
      let found = null;
      walkTree(this, n => {
        if (found) return;
        if (sel === '.lane-bars' && n.classList?.contains('lane-bars')) found = n;
        if (sel === '.lane-fill' && n.classList?.contains('lane-fill')) found = n;
        if (sel === '.gates-hero' && n.classList?.contains('gates-hero')) found = n;
        if (sel === '.savings-rows' && n.classList?.contains('savings-rows')) found = n;
        if (sel === '.fill' && n.classList?.contains('fill')) found = n;
        if (sel === 'canvas.mini-chart' && n.tagName === 'CANVAS' && n.classList?.contains('mini-chart')) found = n;
        if (sel === '.event-tag' && n.classList?.contains('event-tag')) found = n;
        if (sel === '.event-time' && n.classList?.contains('event-time')) found = n;
      });
      return found;
    },
    querySelectorAll(sel) {
      const out = [];
      walkTree(this, n => {
        if (sel === '.lane-fill' && n.classList?.contains('lane-fill')) out.push(n);
        if (sel === '.lane-row' && n.classList?.contains('lane-row')) out.push(n);
        if (sel === '.saving-row' && n.classList?.contains('saving-row')) out.push(n);
        if (sel === '.fill' && n.classList?.contains('fill')) out.push(n);
        if (sel === 'li' && n.tagName === 'LI') out.push(n);
        if (sel === '.event-tag' && n.classList?.contains('event-tag')) out.push(n);
      });
      return out;
    },
    getContext() {
      return {
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fill() {},
        arc() {},
      };
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return classList.toString(); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

function installDom() {
  const document = {
    createElement(tag) {
      return makeElement(tag);
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: text };
    },
  };
  globalThis.document = document;
}

function collectText(node) {
  if (!node) return '';
  if (node.textContent) return node.textContent;
  return (node.children || []).map(collectText).join('');
}

test('event log renders journal entries as plain-word text with tag and age', async () => {
  HivePanels = await loadHivePanels();
  const { renderEventLog, journalEntrySentence } = HivePanels;
  const host = makeElement('ul');
  const events = [
    {
      kind: 'blocker',
      id: 'b-1',
      text: 'Journal blocker needs resolve',
      ts: new Date(NOW - 55_000).toISOString(),
    },
    {
      kind: 'run',
      id: 'run-1',
      phase: 'integrate',
      ts: new Date(NOW - 12_000).toISOString(),
    },
  ];
  assert.match(journalEntrySentence(events[0]), /Blocker: Journal blocker needs resolve/);
  renderEventLog(host, events, { nowMs: NOW });
  const text = collectText(host);
  assert.doesNotMatch(text, /\{"kind":/);
  assert.doesNotMatch(text, /"text":/);
  assert.match(text, /Blocker: Journal blocker needs resolve/);
  assert.match(text, /Run update: integrate/);
  const tags = host.querySelectorAll('.event-tag');
  assert.equal(tags.length, 2);
  assert.ok(tags.some(t => t.classList.contains('safety')));
  assert.match(text, /55s/);
  assert.match(text, /12s/);
  const times = host.querySelectorAll('.event-tag');
  assert.ok(host.querySelector('.event-time') || text.includes('s'));
});

test('lane bar widths are proportional to per-lane counts', async () => {
  HivePanels = await loadHivePanels();
  const { renderLanesPanel, laneRowsFromCounts } = HivePanels;
  const rows = laneRowsFromCounts({ cursor: 80, codex: 20 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'cursor');
  assert.equal(rows[0].fillPct, 80);
  assert.equal(rows[1].fillPct, 20);

  const host = makeElement('section');
  renderLanesPanel(host, { cursor: 80, codex: 20 });
  const fills = host.querySelectorAll('.lane-fill');
  assert.equal(fills.length, 2);
  assert.equal(fills[0].style.width, '80.00%');
  assert.equal(fills[1].style.width, '20.00%');
});

test('savings panel renders injected figures with matching fill widths', async () => {
  HivePanels = await loadHivePanels();
  const { renderSavingsPanel, savingsRowFillPct } = HivePanels;
  assert.equal(savingsRowFillPct({ value: 32, max: 50 }), 64);
  assert.equal(savingsRowFillPct({ value: 59, unit: 'pct' }), 59);

  const host = makeElement('section');
  renderSavingsPanel(host, [
    { label: 'llm wakes skipped', value: 32, max: 50, title: 'savings.llmWakesSkipped' },
    { label: 'stale context dropped', value: 59, unit: 'pct', title: 'savings.staleContextDroppedPct' },
  ], { throughputSamples: [1, 2, 3] });

  const text = collectText(host);
  assert.match(text, /llm wakes skipped/);
  assert.match(text, /32/);
  assert.match(text, /59%/);
  const fills = host.querySelectorAll('.fill');
  assert.equal(fills.length, 2);
  assert.equal(fills[0].style.width, '64.00%');
  assert.equal(fills[1].style.width, '59.00%');
});

test('agoText counts minutes, hours and days like the artifact', async () => {
  HivePanels = await loadHivePanels();
  const { agoText } = HivePanels;
  assert.equal(agoText(20_000), 'just now');
  assert.equal(agoText(30 * 60_000), '30 min ago');
  assert.equal(agoText(89 * 60_000), '89 min ago');
  assert.equal(agoText(3 * 3_600_000), '3 h ago');
  assert.equal(agoText(2 * 86_400_000), '2 d ago');
});

test('stepPath draws one riser per hour and scales to the busiest hour', async () => {
  HivePanels = await loadHivePanels();
  const { stepPath } = HivePanels;
  const d = stepPath([0, 4, 2, 0]);
  assert.match(d, /^M0,64 /, 'first hour starts at the baseline');
  assert.match(d, /L75,64 L75,8 /, 'busiest hour rises to the top (y 8)');
  assert.match(d, /L150,8 L150,36 /);
  assert.match(d, /L225,36 L225,64 /);
  assert.match(d, /L300,64$/, 'path closes flat at the right edge');
  assert.match(stepPath([0, 0]), /^M0,64 L150,64 L150,64 L300,64$/, 'no completions: a flat line');
});

test('session log rows carry the kind colour, ledger id, title and age; empty is one muted line', async () => {
  HivePanels = await loadHivePanels();
  const { renderSessionLog } = HivePanels;
  const host = makeElement('div');
  renderSessionLog(host, [
    { kind: 'review', id: 'T-1', title: 'Look at it' },
    { kind: 'done', id: 'T-2', title: 'Done thing', at: new Date(NOW - 5 * 60_000).toISOString() },
  ], NOW);
  assert.equal(host.children.length, 2);
  assert.equal(host.children[0].attributes['data-kind'], 'review');
  assert.equal(host.children[0].children[0].style.color, 'var(--red)');
  assert.equal(host.children[1].children[0].style.color, 'var(--blue)');
  const text = collectText(host);
  assert.match(text, /T-2 Done thing 5 min ago/);
  const empty = makeElement('div');
  renderSessionLog(empty, [], NOW);
  assert.equal(collectText(empty), 'no ledger events yet');
});

test('sparklinePoints maps min and max samples to chart height bounds', async () => {
  HivePanels = await loadHivePanels();
  const { sparklinePoints } = HivePanels;
  const height = 40;
  const padY = 2;
  const pts = sparklinePoints([0, 10], { width: 100, height, padY, padX: 0 });
  assert.equal(pts.length, 2);
  const bottom = height - padY;
  const top = padY;
  const minPt = pts.find(p => p.value === 0);
  const maxPt = pts.find(p => p.value === 10);
  assert.ok(minPt);
  assert.ok(maxPt);
  assert.equal(minPt.y, bottom);
  assert.equal(maxPt.y, top);
  assert.equal(minPt.x, 0);
  assert.equal(maxPt.x, 100);
});
