// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardSnapshot } from '../tools/board-data.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';

const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const boardPath = path.join(assets, 'board.js');
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 21, 18, 0, 0);
const iso = at => new Date(at).toISOString();
const summary = async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false });

const BOARD_IDS = [
  'announce', 'deeplink', 'deeplinkText', 'deeplinkGo', 'staleBanner', 'liveDot', 'liveText', 'liveChip',
  'needsChip', 'count', 'scratch', 'scratchLabel', 'pauseMotion', 'helpBtn', 'tabs',
  'tab-overview', 'tab-cost', 'tab-agents', 'tab-events',
  'tab-overview-btn', 'tab-cost-btn', 'tab-agents-btn', 'tab-events-btn',
  'kpis', 'totalsNote', 'bays', 'orchCount', 'orchBay', 'orchNote', 'projTable', 'projCards', 'machinesNote',
  'needsCard', 'needs', 'needsBadge', 'markRead', 'fyi', 'fyiList', 'needsNote',
  'costKpis', 'orchTable', 'laneTable', 'laneNote', 'spendTable', 'agentsCount', 'agentsGrid', 'agentsSlots',
  'poolsTable', 'poolsNote', 'history', 'historyNote', 'q', 'fproject', 'fkind', 'ffrom', 'fto', 'csv', 'filters',
  'help', 'helpClose', 'helpTitle',
];

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
    addEventListener() {},
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      this.childNodes = this.children.slice();
      return child;
    },
    querySelector(sel) {
      const walk = n => {
        if (!n) return null;
        if (sel === '.watch-card-slots' && n.classList && n.classList.contains('watch-card-slots')) return n;
        if (sel === '.watch-card-rows' && n.classList && n.classList.contains('watch-card-rows')) return null;
        for (const c of n.children || []) {
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
        if (sel === '.watch-card-list code' && n.tagName === 'CODE') out.push(n);
        if (sel === '.watch-card-row' && n.classList && n.classList.contains('watch-card-row')) out.push(n);
        for (const c of n.children || []) walk(c);
      };
      walk(this);
      return out;
    },
    getBoundingClientRect() { return { top: 0, bottom: 100 }; },
    scrollIntoView() {},
    closest() { return null; },
    focus() {},
    contains() { return false; },
  };
  Object.defineProperty(node, 'className', {
    get() { return [...classList.toString().split(' ')].filter(Boolean).join(' '); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

async function installBoardDom() {
  const byId = new Map();
  const body = makeElement('body');
  for (const id of BOARD_IDS) {
    const n = makeElement('div', id);
    byId.set(id, n);
    body.appendChild(n);
  }
  const document = {
    getElementById: id => byId.get(id) || null,
    createElement: tag => makeElement(tag),
    body,
    hidden: false,
    addEventListener() {},
    documentElement: makeElement('html'),
  };
  const location = { hash: '', pathname: '/', search: '', assign() {} };
  const storage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } };
  globalThis.document = document;
  const win = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = win;
  globalThis.self = win;
  win.document = document;
  win.location = location;
  win.localStorage = storage;
  win.sessionStorage = storage;
  win.navigator = { clipboard: { writeText: async () => {} } };
  win.fetch = async () => ({ ok: false });
  win.innerHeight = 800;
  const libSrc = await fs.readFile(path.join(assets, 'board-lib.js'), 'utf8');
  const box = { self: win };
  vm.runInNewContext(libSrc, box);
  win.BoardLib = box.self.BoardLib;
  globalThis.BoardLib = win.BoardLib;
  globalThis.document = document;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  return document;
}

let boardModule;
async function loadBoardModule() {
  if (boardModule) return boardModule;
  await installBoardDom();
  process.env.SWARM_BOARD_CARD_TEST = '1';
  await import(boardPath);
  boardModule = globalThis.__swarmBoardTestExports;
  assert.ok(boardModule && boardModule.renderWatchProjectCard, 'board test exports');
  return boardModule;
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

function overviewForFixture(fixture, options = {}) {
  return boardSnapshot({
    projects: [fixture.projects[0]],
    liveRuns: options.liveRuns || [],
    now: NOW,
    env: fixture.env,
    summary,
    workers: { max: options.workersMax ?? 8 },
    ...options,
  }).then(snap => {
    const p = snap.projects[0];
    p.machine = p.machine || 'test-host';
    p.version = p.version || '1.99.0';
    return p;
  });
}

test('watch project card shows data from projectOverview.card', async t => {
  const { renderWatchProjectCard } = await loadBoardModule();
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const p = await overviewForFixture(fixture);
  const host = document.createElement('div');
  renderWatchProjectCard(p, host);
  const card = p.card;
  const text = collectText(host);
  assertNoForbiddenWords(text);
  assertNumberElements(host);
  assert.match(text, new RegExp(String(p.progress.overall)));
  assert.match(text, new RegExp(String(card.now.buildingTickets)));
  assert.match(text, new RegExp(String(card.now.checkoutsBuilding)));
  assert.match(text, new RegExp(String(card.next.ready)));
  assert.match(text, new RegExp(String(card.blocked.waitingOnTickets)));
  assert.match(text, new RegExp(String(card.blocked.needYou)));
  assert.match(text, new RegExp(String(card.facts.handEditsBlocked24h)));
  assert.match(text, new RegExp(String(card.facts.untrackedRuns)));
  assert.match(text, new RegExp(String(card.facts.checkouts)));
  if (card.eta.days !== null && card.eta.days !== undefined) {
    assert.match(text, new RegExp(String(card.eta.days)));
  } else {
    assert.match(text, /no estimate yet/);
  }
  const slot = host.querySelector('.watch-card-slots');
  assert.ok(slot);
  if (card.slots.machineMax !== null && card.slots.machineMax - card.slots.inUse === 0) {
    assert.match(slot.textContent, /Waiting for a free slot/);
    assert.doesNotMatch(slot.textContent, /slots free/);
  }
});

test('watch project card lists show exact commands for ready tickets', async t => {
  const { renderWatchProjectCard } = await loadBoardModule();
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const p = await overviewForFixture(fixture);
  const host = document.createElement('div');
  renderWatchProjectCard(p, host);
  const codes = host.querySelectorAll('.watch-card-list code');
  const commands = codes.map(c => c.textContent);
  for (const item of p.card.next.items) {
    if (item.command) assert.ok(commands.includes(item.command), item.command);
  }
});

test('finished project card is quiet without rows or heads-up', async t => {
  const { renderWatchProjectCard } = await loadBoardModule();
  const { approveLedger } = await import('../tools/tickets.mjs');
  const mergedPrs = [{ state: 'MERGED', number: 99, headRefName: 'swarm/finished', mergedAt: iso(NOW) }];
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json', prs: mergedPrs });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  let ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const ticket of ledger.tickets ?? []) {
    if (ticket.type === 'human' || ['cancelled', 'proposed'].includes(ticket.status)) continue;
    ticket.status = 'done';
  }
  ledger = approveLedger(ledger, { now: iso(NOW) });
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const p = await overviewForFixture(fixture, { prState: async () => mergedPrs });
  assert.equal(p.progress.finished, true);
  const host = document.createElement('div');
  renderWatchProjectCard(p, host);
  assert.equal(host.querySelectorAll('.watch-card-row').length, 0);
  assert.equal(host.querySelector('.watch-card-headsup-row'), null);
  assert.match(collectText(host), /Finished/);
  assertNoForbiddenWords(collectText(host));
});

test('slotsSentence never claims free slots when all are in use', async () => {
  const { slotsSentence } = await loadBoardModule();
  const full = slotsSentence({
    slots: { machineMax: 8, inUse: 8, byOtherProjects: 3, byThisProject: 5 },
    next: { ready: 4 },
  });
  assert.match(full.text, /Waiting for a free slot/);
  assert.doesNotMatch(full.text, /slots free/);
  const partial = slotsSentence({
    slots: { machineMax: 8, inUse: 2, byOtherProjects: 0, byThisProject: 2 },
  });
  assert.match(partial.text, /6 of 8 machine slots free/);
});

test('board.js source avoids forbidden wording in card helpers', async () => {
  const src = await fs.readFile(boardPath, 'utf8');
  assert.doesNotMatch(src, /off-ledger/i);
  assert.doesNotMatch(src, /split red/i);
  assert.match(src, /hand-edits blocked by the guard/);
  assert.match(src, /untracked runs/);
});
