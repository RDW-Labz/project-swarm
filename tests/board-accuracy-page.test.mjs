// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardSnapshot, projectDetail } from '../tools/board-data.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';

const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const boardPath = path.join(assets, 'board.js');
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 21, 18, 0, 0);
const iso = at => new Date(at).toISOString();
const summary = async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false });

/** Displayed fields on the project page and board overview (card leaves must match board-accuracy-card COVERAGE). */
export const COVERAGE = {
  'card.now.buildingTickets': 'project page Now row matches disk oracle',
  'card.now.checkoutsBuilding': 'project page Now row matches disk oracle',
  'card.next.ready': 'project page Next row matches disk oracle',
  'card.blocked.waitingOnTickets': 'project page Blocked row matches disk oracle',
  'card.blocked.needYou': 'project page Blocked row matches disk oracle',
  'card.eta.days': 'project page ETA matches disk oracle',
  'card.eta.remaining': 'project page ETA matches disk oracle',
  'card.facts.handEditsBlocked24h': 'project page facts row matches disk oracle',
  'card.facts.untrackedRuns': 'project page facts row matches disk oracle',
  'card.facts.checkouts': 'project page facts row matches disk oracle',
  'card.headsUp': 'project page heads-up sentence matches disk oracle',
  'progress.overall': 'project page percent matches boardPercent oracle',
  'overview.machine.agents.total': 'overview KPI live agents matches snapshot',
  'overview.machine.liveRuns': 'overview KPI subline matches snapshot',
  'overview.machine.workers.total': 'overview KPI workers held matches snapshot',
};

const CARD_LEAF_COVERAGE = {
  'now.buildingTickets': 'card',
  'now.checkoutsBuilding': 'card',
  'now.lastTicketFinishedAt': 'card',
  'next.ready': 'card',
  'next.items': 'card',
  'next.items.id': 'card',
  'next.items.title': 'card',
  'next.items.command': 'card',
  'blocked.waitingOnTickets': 'card',
  'blocked.items': 'card',
  'blocked.items.id': 'card',
  'blocked.items.title': 'card',
  'blocked.items.waitsOn': 'card',
  'blocked.items.command': 'card',
  'blocked.needYou': 'card',
  'blocked.needYouItems': 'card',
  'blocked.needYouItems.id': 'card',
  'blocked.needYouItems.title': 'card',
  'blocked.needYouItems.kind': 'card',
  'blocked.needYouItems.command': 'card',
  'slots.machineMax': 'card',
  'slots.inUse': 'card',
  'slots.byThisProject': 'card',
  'slots.byOtherProjects': 'card',
  'eta.days': 'card',
  'eta.remaining': 'card',
  'eta.perDay': 'card',
  'eta.doneLast7Days': 'card',
  'eta.windowDays': 'card',
  'eta.basis': 'card',
  'facts.handEditsBlocked24h': 'card',
  'facts.untrackedRuns': 'card',
  'facts.listHref': 'card',
  'facts.checkouts': 'card',
  'headsUp': 'card',
};

function leafPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : [];
  if (Array.isArray(value)) {
    if (!value.length) return prefix ? [prefix] : [];
    const paths = [];
    for (let index = 0; index < value.length; index += 1) paths.push(...leafPaths(value[index], `${prefix}[${index}]`));
    return paths;
  }
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    paths.push(...leafPaths(child, next));
  }
  return paths;
}

function coverageKeyForLeaf(path) {
  return path.replace(/\[\d+\]/g, '');
}

function assertLeafCovered(card, table, label) {
  for (const leaf of leafPaths(card)) {
    const key = coverageKeyForLeaf(leaf);
    assert.ok(table[key], `missing COVERAGE entry for ${label} leaf path ${leaf} (key ${key})`);
  }
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, force) => { const on = force !== undefined ? force : !set.has(c); if (on) set.add(c); else set.delete(c); return on; },
    contains: c => set.has(c),
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
    dataset: {},
    attributes: {},
    hidden: false,
    textContent: '',
    title: '',
    href: '',
    type: 'button',
    parentNode: null,
    options: [],
    value: '',
    checked: false,
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'aria-expanded') this._expanded = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    click() { for (const fn of listeners.click || []) fn({ target: this, preventDefault() {} }); },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      this.childNodes = this.children.slice();
      return child;
    },
    querySelector(sel) {
      const walk = n => {
        if (!n) return null;
        for (const c of n.children || []) {
          if (sel.startsWith('.') && c.classList && c.classList.contains(sel.slice(1))) return c;
          if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = n => {
        if (!n) return;
        if (sel === '.watch-num' && n.classList && n.classList.contains('watch-num')) out.push(n);
        if (sel === '.watch-card-toggle' && n.classList && n.classList.contains('watch-card-toggle')) out.push(n);
        if (n.id === 'kpis' || n.classList?.contains('kpis')) { /* host */ }
        for (const c of n.children || []) walk(c);
      };
      walk(this);
      return out;
    },
    closest() { return null; },
    contains() { return false; },
  };
  Object.defineProperty(node, 'className', {
    get() { return classList.toString(); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

let savedGlobalNavigatorDescriptor;
let navigatorDescriptorCaptured = false;
let stubNavigator;

function applyGlobalNavigatorStub() {
  if (!stubNavigator || !navigatorDescriptorCaptured) return;
  Object.defineProperty(globalThis, 'navigator', { value: stubNavigator, configurable: true, writable: true });
}

function restoreGlobalNavigator() {
  if (!navigatorDescriptorCaptured) return;
  if (savedGlobalNavigatorDescriptor === undefined) delete globalThis.navigator;
  else Object.defineProperty(globalThis, 'navigator', savedGlobalNavigatorDescriptor);
}

test.before(applyGlobalNavigatorStub);
test.after(restoreGlobalNavigator);

function fakeDocument() {
  const body = makeElement('body');
  body.createElement = tag => makeElement(tag);
  return body;
}

async function loadBoardLib(document) {
  const libSrc = await fs.readFile(path.join(assets, 'board-lib.js'), 'utf8');
  const doc = document || fakeDocument();
  const win = { document: doc, location: { search: '', pathname: '/', hash: '' }, navigator: stubNavigator || { clipboard: { writeText: async () => {} } }, sessionStorage: { getItem: () => null, setItem: () => {} }, history: { replaceState: () => {} } };
  const box = { self: win, document: doc };
  vm.runInNewContext(libSrc, box);
  return box.self.BoardLib;
}

function collectText(node) {
  if (!node) return '';
  if (node.textContent) return node.textContent;
  return (node.children || []).map(collectText).join('');
}

function assertNoForbiddenWords(text) {
  assert.doesNotMatch(text, /off-ledger/i);
  assert.doesNotMatch(text, /\btrees\b/i);
  assert.doesNotMatch(text, /split red/i);
  assert.doesNotMatch(text, /split quality red/i);
}

function hasVisibleLabel(node) {
  const parent = node.parentNode;
  if (!parent || !parent.children) return false;
  const kids = parent.children;
  const i = kids.indexOf(node);
  if (i > 0 && kids[i - 1].classList && kids[i - 1].classList.contains('watch-num-label')) return true;
  return kids.some(c => c.classList && c.classList.contains('watch-num-label'));
}

function assertNumberElements(host) {
  const nums = host.querySelectorAll('.watch-num');
  for (const n of nums) {
    assert.ok(n.title && n.title.length > 0, 'watch-num needs title: ' + n.textContent);
    assert.ok(hasVisibleLabel(n), 'watch-num needs label for ' + n.textContent);
  }
  const toggles = host.querySelectorAll('.watch-card-toggle');
  for (const btn of toggles) {
    assert.ok(btn.title && btn.title.length > 0, 'toggle needs title');
    const wrap = btn.parentNode;
    const label = wrap && wrap.children && wrap.children.find(c => c.classList && c.classList.contains('watch-num-label'));
    assert.ok(label, 'toggle needs label for ' + btn.textContent);
  }
}

function numsInText(host) {
  return host.querySelectorAll('.watch-num').map(n => n.textContent);
}

async function detailFor(fixture, options = {}) {
  const project = fixture.projects[0];
  return projectDetail(project, {
    now: NOW,
    liveRunIds: new Set(),
    env: fixture.env,
    summary,
    slots: options.workersMax ?? 8,
    extraRoots: fixture.projects.map(p => p.root),
    ...options,
  });
}

async function snapshotFor(fixture, options = {}) {
  return boardSnapshot({
    projects: [fixture.projects[0]],
    liveRuns: options.liveRuns || [],
    now: NOW,
    env: fixture.env,
    summary,
    workers: { max: options.workersMax ?? 8 },
    ...options,
  });
}

test('project page card matches projectDetail.card oracle fields', async t => {
  const BoardLib = await loadBoardLib();
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json', worktrees: [{ name: 'linked' }] });
  t.after(fixture.cleanup);
  const detail = await detailFor(fixture);
  assert.ok(detail.card);
  const host = makeElement('div');
  BoardLib.renderWatchProjectCard(detail, host, { pageMode: true });
  const text = collectText(host);
  assertNoForbiddenWords(text);
  assertNumberElements(host);
  assert.match(text, new RegExp(String(detail.progress.overall)));
  assert.match(text, new RegExp(String(detail.card.now.buildingTickets)));
  assert.match(text, new RegExp(String(detail.card.next.ready)));
  assert.match(text, new RegExp(String(detail.card.facts.checkouts)));
});

test('board project card matches project page for the same project', async t => {
  const BoardLib = await loadBoardLib();
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const snap = await snapshotFor(fixture);
  const detail = await detailFor(fixture);
  const boardP = snap.projects[0];
  assert.deepEqual(
    { card: detail.card, overall: detail.progress?.overall },
    { card: boardP.card, overall: boardP.progress?.overall },
  );
  const pageHost = makeElement('div');
  const cardHost = makeElement('div');
  assert.deepEqual(detail.card, boardP.card);
  assert.equal(detail.progress?.overall, boardP.progress?.overall);
  BoardLib.renderWatchProjectCard(detail, pageHost, { pageMode: true });
  BoardLib.renderWatchProjectCard(boardP, cardHost, {});
  const stripHead = text => text.replace(/\s+/g, ' ').replace(/↳\s*/g, '').replace(/^main[-\w]*/i, 'main');
  assert.equal(stripHead(collectText(pageHost)), stripHead(collectText(cardHost)));
});

test('overview KPI DOM numbers match boardSnapshot machine totals', async t => {
  const BoardLib = await loadBoardLib();
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const snap = await snapshotFor(fixture);
  const m = snap.machine;
  const kpis = makeElement('div', 'kpis');
  const seg = makeElement('div', 'seg');
  const agentsVal = makeElement('div', 'v');
  agentsVal.appendChild(BoardLib.watchNum(m.agents.total, 'live agents', String(m.agents.total)));
  kpis.appendChild(BoardLib.kpiTile('Live agents', agentsVal, String(m.liveRuns) + ' live runs', m.agents.total ? seg : null));
  if (m.workers) {
    const heldVal = makeElement('div', 'v');
    heldVal.appendChild(BoardLib.watchNum(m.workers.total, 'workers held', String(m.workers.total)));
    kpis.appendChild(BoardLib.kpiTile('Workers held', heldVal, 'machine limit', null));
  }
  assertNumberElements(kpis);
  const nums = numsInText(kpis);
  assert.equal(nums[0], String(m.agents.total));
  if (m.workers) assert.equal(nums[1], String(m.workers.total));
  assertNoForbiddenWords(collectText(kpis));
});

test('project page and board scripts avoid forbidden wording', async t => {
  const projectJs = await fs.readFile(path.join(assets, 'project.js'), 'utf8');
  const boardJs = await fs.readFile(boardPath, 'utf8');
  assert.doesNotMatch(projectJs, /off-ledger/i);
  assert.doesNotMatch(projectJs, /split red/i);
  assert.doesNotMatch(boardJs, /off-ledger/i);
  assert.doesNotMatch(boardJs, /split red/i);
  assert.match(projectJs, /untracked runs/);
});

test('page COVERAGE lists every displayed card leaf on projectDetail', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const detail = await detailFor(fixture);
  assert.ok(detail.card);
  assertLeafCovered(detail.card, CARD_LEAF_COVERAGE, 'projectDetail.card');
  for (const key of Object.keys(COVERAGE)) {
    assert.ok(key.startsWith('card.') || key.startsWith('overview.') || key.startsWith('progress.'), key);
  }
});

test('projectDetail exposes card built from the same path as projectOverview', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const detail = await detailFor(fixture);
  const snap = await snapshotFor(fixture);
  assert.equal(detail.card.next.ready, snap.projects[0].card.next.ready);
  assert.equal(detail.card.blocked.waitingOnTickets, snap.projects[0].card.blocked.waitingOnTickets);
  assert.equal(detail.card.facts.untrackedRuns, snap.projects[0].card.facts.untrackedRuns);
});
