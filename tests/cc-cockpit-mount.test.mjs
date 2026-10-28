// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectCockpit } from '../tools/command-center-snapshot.mjs';
import { ticketToQueueJob } from '../tools/queue-commands.mjs';
import { listQueueJobsForProject } from '../tools/burst-route.mjs';
import { readyTickets } from '../tools/tickets.mjs';
import { COCKPIT_LABELS } from '../tools/watch-assets/cockpit-orchestrator.js';
import { headlineTicketText, stageRingProgress } from '../tools/watch-assets/cockpit-view.js';
import { queueVisibleJobs, emptyReadyExplanation } from '../tools/watch-assets/cockpit-lists.js';
import { renderProjectCockpit } from '../tools/watch-assets/cc-cockpit-mount.js';

const queueDeps = { ticketToQueueJob, listQueueJobsForProject };
const NOW = Date.UTC(2026, 9, 26, 20, 0, 0);

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
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    classList,
    children: [],
    childNodes: [],
    style: {},
    dataset: {},
    attributes: {},
    textContent: '',
    parentNode: null,
    firstChild: null,
    ownerDocument: null,
    type: tag === 'button' ? 'button' : undefined,
    replaceChildren(...kids) {
      this.children = kids;
      this.childNodes = kids;
      this.firstChild = kids[0] ?? null;
      for (const k of kids) k.parentNode = this;
    },
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
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent({ type }) {
      for (const fn of listeners.get(type) || []) fn({ type, preventDefault() {} });
    },
    querySelector(sel) {
      const walk = n => {
        if (!n) return null;
        if (sel === 'h1' && n.tagName === 'H1') return n;
        if (sel === '.headline-num' && n.classList?.contains('headline-num')) return n;
        if (sel === '.cc-cockpit-back-btn' && n.classList?.contains('cc-cockpit-back-btn')) return n;
        if (sel === '.entity-label h2' && n.tagName === 'H2') {
          let p = n.parentNode;
          while (p) {
            if (p.classList?.contains('entity-label')) return n;
            p = p.parentNode;
          }
        }
        if (sel === '[data-cockpit-empty="ready"]' && n.getAttribute?.('data-cockpit-empty') === 'ready') return n;
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
        if (sel === '.cockpit-stage-ring' && n.classList?.contains('cockpit-stage-ring')) out.push(n);
        if (sel === '[data-ticket-id]' && n.getAttribute?.('data-ticket-id')) out.push(n);
        if (sel === '.cockpit-metric-tile' && n.classList?.contains('cockpit-metric-tile')) out.push(n);
        for (const c of n.children || []) walk(c);
      };
      walk(this);
      return out;
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
      return { top: 0, left: 0, bottom: 40, right: 120, width: 120, height: 40 };
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
    createTextNode: text => ({ nodeType: 3, textContent: text }),
  };
  document.documentElement.appendChild(head);
  document.documentElement.appendChild(body);
  head.ownerDocument = document;
  body.ownerDocument = document;
  return document;
}

function fakeBoard(overrides = {}) {
  return {
    at: '2026-10-26T12:00:00.000Z',
    machine: { agents: { total: 1 }, cost: { allUsd: 1 } },
    projects: [
      {
        id: 'alpha',
        name: 'Alpha',
        machine: 'host-a',
        progress: { overall: 50, stages: [{ id: 'S1', name: 'Stage one' }, { id: 'S2', name: 'Stage two' }] },
        orchestrator: { sessions: [{ id: 's1', state: 'thinking', lastAt: '2026-10-26T11:00:00.000Z' }] },
        runStream: [{ id: 'run-1', title: 'running', body: '1/4 jobs' }],
        ledger: {
          tickets: [
            { id: 'T-1', title: 'One', status: 'done', stage: 'S1' },
            { id: 'T-2', title: 'Two', status: 'running', stage: 'S1' },
            { id: 'T-3', title: 'Three', status: 'blocked', stage: 'S2', dependsOn: ['T-1'] },
          ],
          scope: { stages: [{ id: 'S1', name: 'Stage one' }, { id: 'S2', name: 'Stage two' }] },
        },
        ...overrides,
      },
    ],
  };
}

function collectTicketIds(host) {
  return host.querySelectorAll('[data-ticket-id]').map(n => n.getAttribute('data-ticket-id'));
}

test('renderProjectCockpit shows headline, orchestrator label, rings, tickets, empty ready, and back', () => {
  const board = fakeBoard();
  const project = buildProjectCockpit(board, 'alpha');
  assert.ok(project);

  const document = makeDocument();
  const host = document.createElement('div');
  document.body.appendChild(host);

  const prevDocument = globalThis.document;
  globalThis.document = document;

  let backCount = 0;
  const view = renderProjectCockpit(host, project, {
    document,
    now: () => NOW,
    onBack: () => { backCount += 1; },
  });

  const nums = host.querySelector('.headline-num');
  assert.ok(nums);
  assert.equal(nums.textContent, headlineTicketText(project.done, project.total));

  const orchHeading = host.querySelector('.entity-label h2');
  assert.ok(orchHeading);
  assert.ok(COCKPIT_LABELS.includes(orchHeading.textContent), orchHeading.textContent);

  const rings = host.querySelectorAll('.cockpit-stage-ring');
  assert.equal(rings.length, stageRingProgress(project.ledger).length);

  const expectedIds = queueVisibleJobs(project.ledger, { id: project.id }, queueDeps).map(j => j.id);
  assert.deepEqual(collectTicketIds(host), expectedIds);

  const ledger = { ...project.ledger, tickets: project.ledger.tickets.map(t => ({ ...t, status: t.id === 'T-1' ? 'done' : 'blocked', dependsOn: t.id === 'T-3' ? ['T-1'] : [] })) };
  for (const t of ledger.tickets) {
    if (t.status !== 'done') {
      t.status = 'blocked';
      t.dependsOn = ['T-1'];
    }
  }
  assert.equal(readyTickets(ledger.tickets).length, 0);
  const emptyMsg = emptyReadyExplanation(ledger, readyTickets);
  assert.ok(emptyMsg);

  const emptyProject = buildProjectCockpit({ ...board, projects: [{ ...board.projects[0], ledger }] }, 'alpha');
  view.update(emptyProject);
  const emptyEl = host.querySelector('[data-cockpit-empty="ready"]');
  assert.ok(emptyEl);
  assert.match(emptyEl.textContent, /No ready tickets/i);

  const backBtn = host.querySelector('.cc-cockpit-back-btn');
  backBtn.dispatchEvent({ type: 'click' });
  assert.equal(backCount, 1);

  view.destroy();
  assert.equal(host.children.length, 0);

  globalThis.document = prevDocument;
});
