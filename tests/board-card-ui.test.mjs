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
  'kpis', 'totalsNote', 'bays', 'orchCount', 'orchBay', 'orchNote', 'projectsSection', 'projViewToggle', 'projTable', 'projCards', 'machinesNote',
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
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    click() {
      for (const fn of listeners.click || []) fn({ target: this, preventDefault() {} });
    },
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
        if (sel === '.watch-card-next' && n.classList && n.classList.contains('watch-card-next')) return n;
        if (sel === '.watch-card-blocked' && n.classList && n.classList.contains('watch-card-blocked')) return n;
        if (sel.startsWith('[aria-label="') && sel.endsWith('"]')) {
          const want = sel.slice('[aria-label="'.length, -2);
          if (n.getAttribute && n.getAttribute('aria-label') === want) return n;
        }
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
        if (sel === '.watch-card-list' && n.classList && n.classList.contains('watch-card-list')) out.push(n);
        if (sel === '.watch-card-list-item' && n.classList && n.classList.contains('watch-card-list-item')) out.push(n);
        if (sel === '.watch-card-list code' && n.tagName === 'CODE') out.push(n);
        if (sel === '.watch-card-row' && n.classList && n.classList.contains('watch-card-row')) out.push(n);
        if (sel === 'button.copy' && n.tagName === 'BUTTON' && n.classList && n.classList.contains('copy')) out.push(n);
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

let savedGlobalNavigatorDescriptor;
let navigatorDescriptorCaptured = false;
let stubNavigator;

function applyGlobalNavigatorStub() {
  if (!stubNavigator || !navigatorDescriptorCaptured) return;
  Object.defineProperty(globalThis, 'navigator', {
    value: stubNavigator,
    configurable: true,
    writable: true,
  });
}

function restoreGlobalNavigator() {
  if (!navigatorDescriptorCaptured) return;
  if (savedGlobalNavigatorDescriptor === undefined) {
    delete globalThis.navigator;
  } else {
    Object.defineProperty(globalThis, 'navigator', savedGlobalNavigatorDescriptor);
  }
}

test.before(applyGlobalNavigatorStub);
test.after(restoreGlobalNavigator);

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
  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;
  win.navigator = { clipboard: { writeText: async () => {} } };
  win.navigator.clipboard._writes = [];
  const origWrite = win.navigator.clipboard.writeText.bind(win.navigator.clipboard);
  win.navigator.clipboard.writeText = async text => {
    win.navigator.clipboard._writes.push(text);
    return origWrite(text);
  };
  stubNavigator = win.navigator;
  if (!navigatorDescriptorCaptured) {
    savedGlobalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    navigatorDescriptorCaptured = true;
  }
  applyGlobalNavigatorStub();
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
  if (boardModule) {
    applyGlobalNavigatorStub();
    return boardModule;
  }
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

async function writeCardListFixture(fixture) {
  const root = fixture.root;
  const ledgerFile = path.join(root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const build = ledger.tickets.filter(ticket => ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status));
  const [a, b, c] = build.slice(0, 3);
  assert.ok(a?.id && b?.id && c?.id, 'fixture needs build tickets for blocked chain');
  a.status = 'done';
  b.status = 'blocked';
  b.blockReason = 'deps';
  b.dependsOn = [a.id];
  c.status = 'blocked';
  c.blockReason = 'deps';
  c.dependsOn = ['T-missing-dep'];
  const releasable = build.find(ticket => ticket.id !== a.id && ticket.id !== b.id && ticket.id !== c.id);
  assert.ok(releasable?.id, 'fixture needs ticket for releasable held item');
  releasable.status = 'blocked';
  releasable.blockReason = 'manual';
  releasable.dependsOn = [a.id];
  const proposedId = 'T-proposed-inbox';
  ledger.tickets.push({
    id: proposedId,
    title: 'Proposed from UI fixture',
    status: 'proposed',
    type: 'build',
    files: ['src/proposed.ts'],
    createdAt: iso(NOW),
  });
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const journalFile = path.join(root, '.swarm', 'project', 'journal.ndjson');
  await fs.mkdir(path.dirname(journalFile), { recursive: true });
  const humanId = 'inbox-human-1';
  const decisionId = 'inbox-decision-1';
  const blockerId = 'inbox-blocker-1';
  const journal = [
    { kind: 'human', id: humanId, title: 'Human journal task', ts: iso(NOW - 3600000) },
    { kind: 'blocker', id: blockerId, text: 'Journal blocker needs resolve', ts: iso(NOW - 1800000) },
    { kind: 'decision', id: decisionId, text: 'Pick a lane', confirm: true, confirmed: false, choice: 'cursor', options: ['cursor', 'codex'], ts: iso(NOW - 900000) },
  ];
  await fs.writeFile(journalFile, `${journal.map(line => JSON.stringify(line)).join('\n')}\n`);
  const runId = 'inbox-human-run';
  const runDir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'state.json'), `${JSON.stringify({
    id: runId,
    status: 'running',
    startedAt: iso(NOW - 600000),
    jobs: [{ id: 'job-human', heldReason: 'human', status: 'held', title: 'Run human gate', heldAt: iso(NOW - 600000) }],
  })}\n`);
}

async function writeReadyListFixture(fixture) {
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const todos = ledger.tickets.filter(ticket => ticket.status === 'todo' && ticket.type !== 'human');
  assert.ok(todos.length >= 2, 'fixture needs todo tickets for ready list');
  todos[0].dependsOn = [];
  todos[1].dependsOn = [];
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
}

function rowListItems(row) {
  const idEl = (row.children || []).find(c => c.classList && c.classList.contains('watch-card-list-id'));
  const titleEl = (row.children || []).find(c => c.classList && c.classList.contains('watch-card-list-title'));
  const codeEl = (row.children || []).flatMap(c => (c.children || []).filter(ch => ch.tagName === 'CODE'));
  const copyBtn = (row.children || []).flatMap(c => (c.children || []).filter(ch => ch.tagName === 'BUTTON' && ch.classList.contains('copy')))[0];
  return { idEl, titleEl, codeEl: codeEl[0] || null, copyBtn };
}

function assertCardListItems(listEl, items) {
  assert.equal(listEl.hidden, false, 'list should be open');
  const rows = listEl.querySelectorAll('.watch-card-list-item');
  assert.equal(rows.length, items.length, 'list row count');
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const { idEl, titleEl, codeEl, copyBtn } = rowListItems(rows[i]);
    assert.equal(idEl?.textContent, item.id, `item[${i}].id`);
    assert.equal(titleEl?.textContent, item.title, `item[${i}].title`);
    if (item.command) {
      assert.ok(codeEl, `item[${i}] should have code`);
      assert.equal(codeEl.textContent, item.command, `item[${i}].command in code`);
      assert.ok(copyBtn, `item[${i}] should have copy button`);
    } else {
      assert.equal(codeEl, null, `item[${i}] should have no code element`);
    }
  }
}

async function assertCopyButtonsCopyExactCommands(listEl, items) {
  applyGlobalNavigatorStub();
  const rows = listEl.querySelectorAll('.watch-card-list-item');
  const clipboard = window.navigator.clipboard;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.command) continue;
    const { copyBtn } = rowListItems(rows[i]);
    const before = clipboard._writes.length;
    copyBtn.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(clipboard._writes.length, before + 1, `copy click for ${item.id}`);
    assert.equal(clipboard._writes[clipboard._writes.length - 1], item.command, `clipboard for ${item.id}`);
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

test('watch project card waiting list opens with ids, titles, commands and copy', async t => {
  const { renderWatchProjectCard } = await loadBoardModule();
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  await writeCardListFixture(fixture);
  const p = await overviewForFixture(fixture);
  assert.ok(p.card.blocked.items.length >= 1, 'waiting items from projectOverview');
  const host = document.createElement('div');
  renderWatchProjectCard(p, host);
  const waitBtn = host.querySelector('[aria-label="Show tickets waiting on dependencies"]');
  assert.ok(waitBtn);
  assert.equal(waitBtn.getAttribute('aria-expanded'), null);
  const blocked = host.querySelector('.watch-card-blocked');
  const listsBefore = blocked.querySelectorAll('.watch-card-list');
  assert.equal(listsBefore[0].hidden, true);
  waitBtn.click();
  assert.equal(waitBtn.getAttribute('aria-expanded'), 'true');
  assertCardListItems(listsBefore[0], p.card.blocked.items);
  await assertCopyButtonsCopyExactCommands(listsBefore[0], p.card.blocked.items);
});

test('watch project card need-you list opens with ids, titles, commands and copy', async t => {
  const { renderWatchProjectCard } = await loadBoardModule();
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  await writeCardListFixture(fixture);
  const p = await overviewForFixture(fixture);
  assert.ok(p.card.blocked.needYouItems.length >= 1, 'need-you items from projectOverview');
  const host = document.createElement('div');
  renderWatchProjectCard(p, host);
  const needBtn = host.querySelector('[aria-label="Show need-you items"]');
  assert.ok(needBtn);
  const blocked = host.querySelector('.watch-card-blocked');
  const lists = blocked.querySelectorAll('.watch-card-list');
  assert.equal(lists[1].hidden, true);
  needBtn.click();
  assert.equal(needBtn.getAttribute('aria-expanded'), 'true');
  assertCardListItems(lists[1], p.card.blocked.needYouItems);
  await assertCopyButtonsCopyExactCommands(lists[1], p.card.blocked.needYouItems);
});

test('watch project card ready list opens with ids, titles, commands and copy', async t => {
  const { renderWatchProjectCard } = await loadBoardModule();
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  await writeReadyListFixture(fixture);
  const p = await overviewForFixture(fixture);
  assert.ok(p.card.next.items.length >= 1, 'ready items from projectOverview');
  const host = document.createElement('div');
  renderWatchProjectCard(p, host);
  const readyBtn = host.querySelector('[aria-label="Show ready tickets"]');
  assert.ok(readyBtn);
  assert.equal(readyBtn.getAttribute('aria-expanded'), null);
  const nextBlock = host.querySelector('.watch-card-next');
  const readyList = nextBlock.querySelectorAll('.watch-card-list')[0];
  assert.ok(readyList);
  assert.equal(readyList.hidden, true);
  readyBtn.click();
  assert.equal(readyBtn.getAttribute('aria-expanded'), 'true');
  assertCardListItems(readyList, p.card.next.items);
  await assertCopyButtonsCopyExactCommands(readyList, p.card.next.items);
  readyBtn.click();
  assert.equal(readyBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(readyList.hidden, true);
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

test('project cards grid is default at all widths; table is optional', async () => {
  const cssPath = path.join(assets, 'swarm-ui.css');
  const css = await fs.readFile(cssPath, 'utf8');
  const baseCardsRule = /\.cards\s*\{[^}]*display:\s*grid/i;
  assert.match(css, baseCardsRule, '.cards uses display grid outside media queries');
  const cssNoMedia = css.replace(/@media[\s\S]*?\{[\s\S]*?\}/g, '');
  assert.doesNotMatch(cssNoMedia, /(?:^|[\n\r])\s*\.cards\s*\{[^}]*display:\s*none/i);
  assert.match(css, /minmax\(340px/i);

  const { applyProjectsView, readProjectsView, PROJECTS_VIEW_KEY } = await loadBoardModule();
  const section = document.getElementById('projectsSection');
  const toggle = document.getElementById('projViewToggle');
  const storage = window.localStorage;
  delete storage._d[PROJECTS_VIEW_KEY];

  assert.equal(readProjectsView(), 'cards');
  applyProjectsView(readProjectsView());
  assert.equal(section.classList.contains('projects-view-table'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');

  applyProjectsView('table');
  assert.equal(section.classList.contains('projects-view-table'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(storage.getItem(PROJECTS_VIEW_KEY), 'table');

  applyProjectsView('cards');
  assert.equal(section.classList.contains('projects-view-table'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(storage.getItem(PROJECTS_VIEW_KEY), 'cards');
});
