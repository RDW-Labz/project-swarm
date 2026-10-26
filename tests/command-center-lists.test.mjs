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
  layoutSummaryTileElement,
  boxesOverlap,
  queueVisibleJobs,
} from '../tools/watch-assets/cockpit-lists.js';
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
    variant: 'engines',
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
