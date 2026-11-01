// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketToQueueJob } from '../tools/queue-commands.mjs';
import { listQueueJobsForProject } from '../tools/burst-route.mjs';
import { readyTickets } from '../tools/tickets.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';
import {
  renderCockpitTicketList,
  renderStackSummaryTiles,
  renderReadyEmptyState,
  renderTicketColumn,
  renderWorkerCards,
  layoutSummaryTileElement,
  boxesOverlap,
  queueVisibleJobs,
  cockpitColumns,
  workerCards,
  recentDone,
  shortTitle,
  agoText,
  ticketState,
  stageColour,
  STAGE_COLOURS,
} from '../tools/watch-assets/cockpit-lists.js';
import { compareStageIds, stageRingProgress } from '../tools/watch-assets/cockpit-view.js';
import {
  renderRunStream,
  readRunStreamWrapStyle,
} from '../tools/watch-assets/cockpit-run-stream.js';

const queueDeps = { ticketToQueueJob, listQueueJobsForProject };

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c),
    toString: () => [...set].join(' '),
  };
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
    parentNode: null,
    firstChild: null,
    ownerDocument: null,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(child) {
      this.children.push(child);
      this.childNodes = this.children;
      child.parentNode = this;
      this.firstChild = this.children[0] ?? null;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      this.childNodes = this.children;
      this.firstChild = this.children[0] ?? null;
      return child;
    },
    getBoundingClientRect() {
      const L = this._layout;
      if (L) {
        return {
          top: L.top,
          left: L.left,
          bottom: L.bottom,
          right: L.right,
          width: L.width ?? (L.right - L.left),
          height: L.height ?? (L.bottom - L.top),
        };
      }
      return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = n => {
        if (!n) return;
        if (sel === '[data-ticket-id]' && n.getAttribute?.('data-ticket-id')) out.push(n);
        if (sel === '.cockpit-metric-tile' && n.classList?.contains('cockpit-metric-tile')) out.push(n);
        if (sel === '.cockpit-run-stream-body' && n.classList?.contains('cockpit-run-stream-body')) out.push(n);
        for (const c of n.children || []) walk(c);
      };
      walk(this);
      return out;
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return classList.toString(); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

function makeDocument() {
  const head = makeElement('head');
  const body = makeElement('body');
  const byId = new Map();
  const document = {
    head,
    body,
    documentElement: makeElement('html'),
    getElementById: id => byId.get(id) || null,
    createElement: tag => {
      const el = makeElement(tag);
      el.ownerDocument = document;
      return el;
    },
  };
  document.documentElement.appendChild(head);
  document.documentElement.appendChild(body);
  head.ownerDocument = document;
  body.ownerDocument = document;
  return document;
}

function collectTicketIds(host) {
  return host.querySelectorAll('[data-ticket-id]').map(n => n.getAttribute('data-ticket-id'));
}

test('cockpit ticket list ids match queue for mixed-status fixture ledger', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const live = ledger.tickets.filter(t => !['cancelled', 'proposed'].includes(t.status));
  assert.ok(live.length >= 4, 'fixture should include several live tickets');
  const statusCycle = ['done', 'running', 'ready', 'blocked', 'todo'];
  for (let i = 0; i < live.length; i++) {
    live[i].status = statusCycle[i % statusCycle.length];
    if (live[i].status === 'blocked') {
      live[i].blockReason = 'deps';
      live[i].dependsOn = live[0]?.id ? [live[0].id] : [];
    }
  }
  const expected = queueVisibleJobs(ledger, {}, queueDeps).map(j => j.id);
  assert.ok(expected.length > 0, 'mixed ledger should still expose queue jobs');

  const document = makeDocument();
  const host = document.createElement('div');
  document.body.appendChild(host);
  renderCockpitTicketList(host, ledger, { projectConfig: {}, queueDeps });
  const rendered = collectTicketIds(host);
  assert.deepEqual(rendered, expected);
});

test('cockpit ticket list ids match swarm queue list for fixture ledger', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const expected = queueVisibleJobs(ledger, {}, queueDeps).map(j => j.id);

  const document = makeDocument();
  const host = document.createElement('div');
  document.body.appendChild(host);
  renderCockpitTicketList(host, ledger, { projectConfig: {}, queueDeps });
  const rendered = collectTicketIds(host);
  assert.deepEqual(rendered, expected);
});

test('empty ready list explains dependency blocking', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const build = ledger.tickets.filter(t => t.type !== 'human' && !['cancelled', 'proposed'].includes(t.status));
  const [a, b] = build.slice(0, 2);
  assert.ok(a?.id && b?.id);
  a.status = 'done';
  b.status = 'blocked';
  b.blockReason = 'deps';
  b.dependsOn = [a.id];
  for (const tkt of ledger.tickets) {
    if (tkt.status === 'ready' || tkt.status === 'todo') {
      tkt.status = 'blocked';
      tkt.blockReason = 'deps';
      tkt.dependsOn = [b.id];
    }
  }
  assert.equal(readyTickets(ledger.tickets).length, 0);

  const document = makeDocument();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const msg = renderReadyEmptyState(host, ledger, readyTickets);
  assert.match(msg, /No ready tickets/i);
  assert.match(msg, /blocked on dependencies/i);
  assert.match(msg, /\d+ blocked on dependencies/);
  assert.doesNotMatch(host.textContent, /nothing here/i);
});

test('summary tiles keep numeral, label, and footnote boxes disjoint at narrow viewport', () => {
  const document = makeDocument();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const viewport = { width: 390, height: 720 };
  renderStackSummaryTiles(host, [{
    label: 'Engines with a very long category label that should ellipsize',
    value: '999999',
    footnote: 'peak concurrent workers in the last hour',
    color: '#4d7cff',
  }]);
  const tiles = host.querySelectorAll('.cockpit-metric-tile');
  assert.equal(tiles.length, 1);
  layoutSummaryTileElement(tiles[0], viewport);
  const label = tiles[0].children.find(c => c.classList.contains('m-label'));
  const val = tiles[0].children.find(c => c.classList.contains('m-val'));
  const foot = tiles[0].children.find(c => c.classList.contains('m-foot'));
  const lr = label.getBoundingClientRect();
  const vr = val.getBoundingClientRect();
  const fr = foot.getBoundingClientRect();
  assert.equal(boxesOverlap(lr, vr), false, 'label vs numeral');
  assert.equal(boxesOverlap(lr, fr), false, 'label vs footnote');
  assert.equal(boxesOverlap(vr, fr), false, 'numeral vs footnote');
  assert.ok(vr.top >= lr.bottom - 0.5, 'numeral below label');
  assert.ok(fr.top >= vr.bottom - 0.5, 'footnote below numeral');
});

test('run stream item body uses wrap-friendly CSS not ellipsis truncation', () => {
  const document = makeDocument();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const long = 'worker-stream-event-'.repeat(24) + 'end-of-line-marker';
  renderRunStream(host, [{ id: 'run-1', title: 'live', body: long }]);
  const bodies = host.querySelectorAll('.cockpit-run-stream-body');
  assert.equal(bodies.length, 1);
  const style = readRunStreamWrapStyle(bodies[0]);
  assert.equal(style.whiteSpace, 'normal');
  assert.equal(style.overflowWrap, 'anywhere');
  assert.notEqual(style.textOverflow, 'ellipsis');
  assert.notEqual(style.overflow, 'hidden');
  assert.notEqual(style.maxHeight, '0px');
});

const T = (id, status, extra = {}) => ({ id, title: `Title ${id}`, status, ...extra });
const readyStub = tickets => tickets.filter(t => t.status === 'ready');

test('cockpit columns: running then ready on the left; review, blocked, newest done on the right', () => {
  const ledger = {
    tickets: [
      T('T-1', 'done', { doneAt: '2026-10-26T10:00:00Z' }),
      T('T-2', 'done', { doneAt: '2026-10-26T12:00:00Z' }),
      T('T-3', 'done', { doneAt: '2026-10-26T11:00:00Z' }),
      T('T-4', 'running'),
      T('T-5', 'ready'),
      T('T-6', 'ready'),
      T('T-7', 'review'),
      T('T-8', 'blocked'),
      T('T-9', 'todo'),
      T('T-10', 'cancelled'),
      T('T-11', 'proposed'),
    ],
  };
  const cols = cockpitColumns(ledger, readyStub);
  assert.deepEqual(cols.left.map(e => [e.ticket.id, e.state]), [['T-4', 'running'], ['T-5', 'ready'], ['T-6', 'ready']]);
  assert.deepEqual(cols.right.map(e => [e.ticket.id, e.state]), [
    ['T-7', 'review'], ['T-8', 'blocked'], ['T-2', 'done'], ['T-3', 'done'], ['T-1', 'done'],
  ]);
  assert.deepEqual(cols.counts, { ready: 2, running: 1, review: 1, blocked: 1, todo: 1, done: 3, cancelled: 1, proposed: 1 });
});

test('cockpit columns cap each side at eight cards and keep one done slot budget', () => {
  const tickets = [];
  for (let i = 1; i <= 12; i += 1) tickets.push(T(`T-${String(i).padStart(2, '0')}`, 'ready'));
  for (let i = 20; i < 25; i += 1) tickets.push(T(`T-${i}`, 'review'));
  for (let i = 30; i < 34; i += 1) tickets.push(T(`T-${i}`, 'blocked'));
  for (let i = 40; i < 44; i += 1) tickets.push(T(`T-${i}`, 'done'));
  const cols = cockpitColumns({ tickets }, readyStub);
  assert.equal(cols.left.length, 8);
  assert.equal(cols.right.length, 8);
  assert.deepEqual(cols.right.map(e => e.state), ['review', 'review', 'review', 'blocked', 'blocked', 'blocked', 'done', 'done']);
  assert.equal(cols.counts.ready, 12);
  assert.equal(cols.counts.review, 5);
});

test('recent done is newest first by finish time, ids descending when no time is recorded', () => {
  const stamped = recentDone({ tickets: [T('T-1', 'done', { doneAt: 1000 }), T('T-2', 'done', { doneAt: 3000 }), T('T-3', 'done')] }, 3);
  assert.deepEqual(stamped.map(t => t.id), ['T-2', 'T-1', 'T-3']);
  const unstamped = recentDone({ tickets: [T('T-1', 'done'), T('T-3', 'done'), T('T-2', 'done'), T('T-4', 'ready')] }, 2);
  assert.deepEqual(unstamped.map(t => t.id), ['T-3', 'T-2']);
});

test('worker cards read the finish time from the ledger and say so when it is missing', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const cards = workerCards({
    tickets: [T('T-1', 'done', { doneAt: '2026-10-26T11:30:00Z', stage: 'S1' }), T('T-2', 'done', { stage: 'S1' })],
  }, now, 4);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].id, 'T-1');
  assert.equal(cards[0].tag, 'NEWEST');
  assert.equal(cards[0].ago, '30 min ago');
  assert.equal(cards[0].pct, 98);
  assert.equal(cards[1].tag, 'DONE');
  assert.equal(cards[1].ago, '');
  assert.equal(cards[1].pct, 100);

  const document = makeDocument();
  const host = document.createElement('div');
  document.body.appendChild(host);
  renderWorkerCards(host, cards);
  assert.equal(host.children.length, 2);
  assert.ok(host.children[0].classList.contains('new'));
  assert.equal(host.children[1].children[1].children[0].children[1].textContent, 'stage S1');
  renderWorkerCards(host, []);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].textContent, 'No finished tickets yet.');
});

test('ticket columns: hot first card on the right, staggered margins, empty line', () => {
  const document = makeDocument();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const entries = [1, 2, 3, 4, 5].map(i => ({ ticket: T(`T-${i}`, 'review', { stage: 'S2' }), state: 'review' }));
  renderTicketColumn(host, entries, { side: 'R' });
  assert.deepEqual(collectTicketIds(host), ['T-1', 'T-2', 'T-3', 'T-4', 'T-5']);
  assert.ok(host.children[0].classList.contains('hot'));
  assert.equal(host.children[1].classList.contains('hot'), false);
  assert.equal(host.children[0].style.marginRight, '0px');
  assert.equal(host.children[0].style.marginLeft, '36px');
  assert.equal(host.children[2].style.marginRight, '20px');
  assert.equal(host.children[0].getAttribute('data-status'), 'review');

  renderTicketColumn(host, entries.slice(0, 3), { side: 'L' });
  assert.equal(host.children.some(c => c.classList.contains('hot')), false);
  assert.equal(host.children[1].style.marginLeft, '10px');
  assert.equal(host.children[1].style.marginRight, '26px');

  renderTicketColumn(host, [], { side: 'R', emptyText: 'Nothing here yet' });
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].getAttribute('data-cockpit-empty'), 'column');
});

test('ticket card helpers: short names, ages, states and stage colours', () => {
  assert.equal(shortTitle('Autopilot pauses during integrate or e2e and resumes afterward'), 'autopilot pauses');
  assert.equal(shortTitle('Make build tickets own their test files in ticket-manifest prompts'), 'build tickets own their test');
  assert.equal(shortTitle('Per-checkout lock so only one base check runs per worktree at a time'), 'per-checkout lock');
  assert.equal(shortTitle(''), '');
  assert.equal(agoText(0), 'just now');
  assert.equal(agoText(5 * 60000), '5 min ago');
  assert.equal(agoText(120 * 60000), '2 h ago');
  assert.equal(agoText(4320 * 60000), '3 d ago');
  assert.equal(ticketState('running'), 'running');
  assert.equal(ticketState('done'), 'done');
  assert.equal(ticketState('blocked'), 'blocked');
  assert.equal(ticketState('review'), 'review');
  assert.equal(ticketState('todo'), 'ready');
  assert.equal(stageColour('S3'), STAGE_COLOURS[3]);
  assert.equal(stageColour('S10'), STAGE_COLOURS[3]);
  assert.equal(stageColour(undefined), STAGE_COLOURS[0]);
});

test('stageRingProgress orders S1, S2, S10 numerically when stages come from ticket keys', () => {
  const rings = stageRingProgress({
    tickets: [
      { id: 'T-1', status: 'todo', stage: 'S10' },
      { id: 'T-2', status: 'todo', stage: 'S1' },
      { id: 'T-3', status: 'todo', stage: 'S2' },
    ],
  });
  assert.deepEqual(rings.map(r => r.id), ['S1', 'S2', 'S10']);
  assert.deepEqual(['S1', 'S2', 'S10'].sort(compareStageIds), ['S1', 'S2', 'S10']);
});
