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

const NOW = Date.UTC(2026, 9, 26, 20, 45, 0);
const iso = (ms) => new Date(ms).toISOString();

/** One shared Hive view model: counters, cards and the three panels read the same snapshot. */
function hiveSnapshot() {
  const counts = (o) => ({ source: 'projects.tickets.byStatus', ...o });
  return {
    at: iso(NOW),
    stats: {
      projectsTotal: { label: 'Projects', value: 4, unit: 'count', source: 'projects.length', explanation: 'x' },
      agentsLive: { label: 'Agents live', value: 3, unit: 'count', source: 'machine.agents.total', explanation: 'x' },
      needsYouCount: { label: 'Needs you', value: 2, unit: 'count', source: 'projects[].card.blocked.needYou', explanation: 'x' },
      spendUsd: { label: 'Spend', value: 42.5, unit: 'usd', source: 'machine.cost.allUsd', explanation: 'x' },
    },
    projects: [
      { id: 'hive-alpha', name: 'Alpha', needsYou: { value: 2, source: 'a' }, liveAgents: { value: 0, source: 'a' }, ticketCounts: counts({ total: 10, done: 4, ready: 2, blocked: 1, review: 1, cancelled: 2, remaining: 4 }) },
      { id: 'hive-beta', name: 'Beta', liveAgents: { value: 2, source: 'b' }, ticketCounts: counts({ total: 6, done: 1, ready: 3, blocked: 0, review: 2, cancelled: 0, remaining: 5 }) },
      { id: 'hive-gamma', name: 'Gamma', liveAgents: { value: 0, source: 'c' }, ticketCounts: counts({ total: 5, done: 1, ready: 0, blocked: 3, review: 0, cancelled: 1, remaining: 3 }) },
      { id: 'hive-delta', name: 'Delta', ticketCounts: counts({ total: 3, done: 3, ready: 0, blocked: 0, review: 0, cancelled: 0, remaining: 0 }) },
    ],
    hive: {
      throughput24h: [0, 2, 0, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
      doneLast24h: 11,
      lanes: { cursor: { jobs24h: 30, running: 1 }, claude: { jobs24h: 10, running: 0 } },
      prs: [{ number: 12, title: 'First' }, { number: 13, title: 'Second' }],
      events: [
        { kind: 'review', id: 'T-9', title: 'Needs a look' },
        { kind: 'done', id: 'T-8', title: 'Shipped', at: iso(NOW - 3 * 3600000) },
        { kind: 'pr', id: '#12', title: 'First' },
      ],
    },
  };
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
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
    classList,
    children: [],
    childNodes: [],
    style: {},
    attributes: {},
    textContent: '',
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
    addEventListener() {},
    querySelectorAll(sel) {
      const out = [];
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      walkTree(this, (n) => {
        if (n === this) return;
        if (cls ? n.classList?.contains(cls) : n.tagName === sel.toUpperCase()) out.push(n);
      });
      return out;
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return classList.toString(); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

async function loadHivePanels() {
  const document = {
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
  };
  globalThis.document = document;
  const box = { module: { exports: {} }, exports: {}, document, self: globalThis, globalThis };
  vm.runInNewContext(await fs.readFile(hivePanelsPath, 'utf8'), box, { filename: hivePanelsPath });
  return box.module.exports?.renderHiveDashboard ? box.module.exports : box.HivePanels;
}

function collectText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  let s = node.textContent || '';
  for (const c of node.children || []) s += collectText(c);
  return s;
}

test('deriveHiveView maps each project to its colour category, percent and ledger rows', async () => {
  const { deriveHiveView } = await loadHivePanels();
  const view = deriveHiveView(hiveSnapshot());
  const by = Object.fromEntries(view.projects.map((p) => [p.id, p]));
  assert.equal(by['hive-alpha'].cat, 'need', 'needs you beats everything but done');
  assert.equal(by['hive-alpha'].pct, 50, '4 done of 8 that still count (10 minus 2 cancelled)');
  assert.equal(by['hive-alpha'].counted, 8);
  assert.equal(by['hive-beta'].cat, 'building', 'live agents');
  assert.equal(by['hive-beta'].pct, 17);
  assert.equal(by['hive-gamma'].cat, 'blocked', 'blocked tickets and nothing running');
  assert.equal(by['hive-delta'].cat, 'done');
  assert.equal(by['hive-delta'].pct, 100);
  assert.equal(by['hive-delta'].tag, 'DONE');
  assert.equal(by['hive-alpha'].color, '#ff4d7e');
  assert.equal(view.projects.length, 4);
});

test('deriveHiveView reads counters and totals from labelled stats and the ledger counts', async () => {
  const { deriveHiveView } = await loadHivePanels();
  const view = deriveHiveView(hiveSnapshot());
  assert.equal(view.projectsTotal, 4);
  assert.equal(view.agents, 3, 'agents from stats.agentsLive');
  assert.equal(view.needs, 2, 'need you from stats.needsYouCount');
  assert.equal(view.spend, 42.5);
  assert.equal(view.doneLast24h, 11);
  assert.deepEqual(
    { tickets: view.totals.tickets, done: view.totals.done, ready: view.totals.ready, blocked: view.totals.blocked, review: view.totals.review, remaining: view.totals.remaining, counted: view.totals.counted },
    { tickets: 24, done: 9, ready: 5, blocked: 4, review: 3, remaining: 12, counted: 21 },
  );
  assert.deepEqual(view.lanes.map((l) => l.name), ['cursor', 'claude'], 'lanes sorted by jobs');
});

test('deriveHiveView leaves missing data null so panels can say so', async () => {
  const { deriveHiveView } = await loadHivePanels();
  const view = deriveHiveView({ at: iso(NOW), stats: {}, projects: [{ id: 'p', name: 'P', needsYou: { value: 1 }, liveAgents: { value: 2 } }] });
  assert.equal(view.projects[0].counts, null);
  assert.equal(view.projects[0].pct, null);
  assert.equal(view.doneLast24h, null);
  assert.equal(view.throughput, null);
  assert.equal(view.lanes, null);
  assert.equal(view.prs, null);
  assert.equal(view.totals.tickets, null);
  assert.equal(view.agents, 2, 'falls back to the project live-agent fields');
  assert.equal(view.needs, 1);
  assert.deepEqual(view.events.map((e) => e.kind), ['needs', 'run'], 'session log falls back to project signals');
});

test('renderHiveDashboard draws the session log, bars, project and lane rows, kv figures and the step chart', async () => {
  const panels = await loadHivePanels();
  const view = panels.deriveHiveView(hiveSnapshot());
  const root = makeElement('div');
  const mounted = [];
  const out = panels.renderHiveDashboard(root, view, {
    nowMs: NOW,
    mountHead: (host, o) => { mounted.push(o); return { destroy() {} }; },
  });

  const log = collectText(root.querySelectorAll('.hive-slog')[0]);
  assert.match(log, /reviewT-9 Needs a look/);
  assert.match(log, /doneT-8 Shipped 3 h ago/);
  assert.match(log, /pr#12 First/);

  assert.equal(root.querySelectorAll('.hive-panel').length, 3);
  assert.equal(root.querySelectorAll('.hive-bars')[0].children.length, 24);

  const rows = root.querySelectorAll('.hive-hbar');
  const widths = rows.map((r) => r.children.find((c) => c.tagName === 'I').children[0].style.transform);
  assert.ok(widths.includes('scaleX(0.5)'), 'Alpha 50%');
  assert.ok(widths.includes('scaleX(1)'), 'Delta 100%');
  assert.ok(widths.includes('scaleX(0.75)'), 'cursor 30 of 40 jobs');
  assert.ok(widths.includes('scaleX(0.25)'), 'claude 10 of 40 jobs');

  assert.deepEqual(mounted.map((m) => [m.id, m.state, m.size]), [['lane-cursor', 'working', 30], ['lane-claude', 'sleeping', 30]]);
  assert.equal(out.heads.length, 2);

  const text = collectText(root);
  assert.match(text, /4projects on the board/);
  assert.match(text, /tickets in the ledger24/);
  assert.match(text, /tickets left to do12/);
  assert.match(text, /open pull requests2/);
  assert.match(text, /worker jobs in 24 h40/);
  assert.match(text, /spend recorded\$42\.5/);
  assert.match(text, /held for you2/);
  assert.match(text, /done in 24 h11/);
  assert.match(text, /ready to start5/);
  assert.match(text, /waiting on others4/);
  assert.match(text, /saved by the swarmnot measured yet/);
  assert.doesNotMatch(text, /placeholder|sample|simulate/i);
});

test('renderHiveDashboard shows a short muted line for every missing source', async () => {
  const panels = await loadHivePanels();
  const view = panels.deriveHiveView({ at: iso(NOW), stats: {}, projects: [{ id: 'p', name: 'P' }] });
  const root = makeElement('div');
  panels.renderHiveDashboard(root, view, { nowMs: NOW });
  const muted = root.querySelectorAll('.hive-muted').map(collectText);
  assert.ok(muted.includes('no ledger events yet'));
  assert.ok(muted.includes('no completion times in the ledger'));
  assert.ok(muted.includes('no ledger percentages yet'));
  assert.ok(muted.includes('no per-lane job counts in the board data'));
  assert.ok(muted.includes('no ledger counts yet'));
  const text = collectText(root);
  assert.match(text, /tickets in the ledger—/);
  assert.match(text, /open pull requests—/);
  assert.equal(root.querySelectorAll('svg').length, 0, 'no empty chart box');
});
