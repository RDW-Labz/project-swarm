// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectCockpit } from '../tools/command-center-snapshot.mjs';
import { readyTickets } from '../tools/tickets.mjs';
import { COCKPIT_LABELS } from '../tools/watch-assets/cockpit-orchestrator.js';
import {
  cockpitSubline,
  stageRingProgress,
  orchestratorHeadState,
  orchestratorCaption,
} from '../tools/watch-assets/cockpit-view.js';
import { emptyReadyExplanation, STAGE_COLOURS } from '../tools/watch-assets/cockpit-lists.js';
import { renderProjectCockpit } from '../tools/watch-assets/cc-cockpit-mount.js';

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

const TOKEN = /^(?:([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\])/;

/** One compound selector: tag, #id, .class and [attr] / [attr="v"] in any mix. */
function parseCompound(text) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let rest = text;
  while (rest) {
    const m = rest.match(TOKEN);
    if (!m) throw new Error(`unsupported selector: ${text}`);
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else out.attrs.push([m[4], m[5]]);
    rest = rest.slice(m[0].length);
  }
  return out;
}

function matchesCompound(node, c) {
  if (!node || !node.classList || typeof node.getAttribute !== 'function') return false;
  if (c.tag && node.tagName !== c.tag) return false;
  if (c.id && node.id !== c.id) return false;
  if (!c.classes.every(k => node.classList.contains(k))) return false;
  return c.attrs.every(([k, v]) => {
    const got = node.getAttribute(k);
    return v === undefined ? got != null : got === v;
  });
}

function matchesChain(node, chain) {
  if (!matchesCompound(node, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let p = node.parentNode; p && i >= 0; p = p.parentNode) {
    if (matchesCompound(p, chain[i])) i -= 1;
  }
  return i < 0;
}

function makeElement(tag) {
  const classList = makeClassList();
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
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
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      this.firstChild = this.children[0] ?? null;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      this.firstChild = this.children[0] ?? null;
      return child;
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
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
    querySelectorAll(sel) {
      const chain = sel.trim().split(/\s+/).map(parseCompound);
      const out = [];
      const walk = n => {
        for (const c of n.children || []) {
          if (matchesChain(c, chain)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 40, right: 120, width: 120, height: 40 }; },
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
  const document = {
    head,
    body,
    documentElement: makeElement('html'),
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

function textOf(node) {
  if (!node) return '';
  if (node.textContent) return node.textContent;
  return (node.children || []).map(textOf).join('');
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

function ticketIds(root) {
  return root.querySelectorAll('[data-ticket-id]').map(n => n.getAttribute('data-ticket-id'));
}

function setup() {
  const document = makeDocument();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const heads = [];
  const mountRobotHead = (_host, opts) => {
    const h = {
      opts,
      states: [opts.state],
      destroyed: false,
      setState(s) { this.states.push(s); },
      destroy() { this.destroyed = true; },
    };
    heads.push(h);
    return h;
  };
  return { document, host, heads, mountRobotHead };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('renderProjectCockpit binds title, counters, columns, orchestrator, streams and stack to the project payload', async () => {
  const board = fakeBoard();
  const project = buildProjectCockpit(board, 'alpha');
  assert.ok(project);
  const { document, host, heads, mountRobotHead } = setup();
  const prevDocument = globalThis.document;
  globalThis.document = document;

  let backCount = 0;
  const view = renderProjectCockpit(host, project, {
    document,
    now: () => NOW,
    onBack: () => { backCount += 1; },
    glitch: () => false,
    mountRobotHead,
  });

  const shell = host.querySelector('.cc-cockpit-shell');
  assert.ok(shell);
  assert.equal(shell.getAttribute('data-project-id'), 'alpha');
  assert.ok(host.querySelector('#cc-cockpit-main'));

  // title block: name from project.name, counts line from project.done / project.total
  assert.equal(textOf(host.querySelector('h1')), 'ALPHA');
  assert.equal(textOf(host.querySelector('.sub2')), cockpitSubline(project.done, project.total));
  assert.match(textOf(host.querySelector('.sub2')), new RegExp(`^${project.total} TICKETS`));
  assert.match(textOf(host.querySelector('.crumbs')), /The Hive/);

  // stage strip: one segment per ledger stage, counts from the ledger
  const rings = stageRingProgress(project.ledger);
  assert.equal(host.querySelectorAll('.strip i').length, rings.length);
  assert.equal(textOf(host.querySelector('.stripl span')), rings.map(r => `${r.id} ${r.done}/${r.total}`).join('  ·  '));

  // header counters: which number comes from which field
  const counter = k => textOf(host.querySelector(`.cnt .v[data-k="${k}"]`));
  assert.equal(counter('tickets'), String(project.total));
  assert.equal(counter('done'), String(project.done));
  assert.equal(counter('agents'), String(project.ledger.tickets.filter(t => t.status === 'running').length));

  // columns: running first on the left; review, blocked, then latest done on the right; data-ticket-id on each card
  const expectedLeft = ['T-2', ...readyTickets(project.ledger.tickets).filter(t => t.status !== 'running').map(t => t.id).sort()];
  assert.deepEqual(ticketIds(host.querySelector('#tickets-left')), expectedLeft);
  assert.deepEqual(ticketIds(host.querySelector('#tickets-right')), ['T-3', 'T-1']);
  const hot = host.querySelector('#tickets-right .tk.hot');
  assert.ok(hot);
  assert.equal(hot.getAttribute('data-ticket-id'), 'T-3');
  assert.equal(host.querySelector('#tickets-left .tk').getAttribute('data-status'), 'running');
  assert.equal(host.querySelector('#tickets-right .tk[data-ticket-id="T-1"]').getAttribute('data-status'), 'done');

  // orchestrator label and head state come from the session, the head is mounted once at 290px
  const lab = host.querySelector('.lab');
  const label = lab.getAttribute('data-orchestrator');
  assert.ok(COCKPIT_LABELS.includes(label), label);
  assert.equal(textOf(host.querySelector('.lab small')), orchestratorCaption(label, false));
  await tick();
  assert.equal(heads.length, 1);
  assert.equal(heads[0].opts.size, 290);
  assert.equal(heads[0].opts.state, orchestratorHeadState(label, false));

  // now panel: the running ticket leads
  assert.equal(textOf(host.querySelector('.now .t')), 'T-2');
  assert.match(textOf(host.querySelector('.now .k')), /NOW RUNNING/);
  assert.match(textOf(host.querySelectorAll('.now .d').pop()), /1 ticket running now/);

  // worker stream: latest finished tickets; run stream: the project's runs
  assert.equal(host.querySelectorAll('[data-cockpit-worker-stream="true"] .wc').length, 1);
  assert.equal(host.querySelector('[data-cockpit-worker-stream="true"] .wc').getAttribute('title'), 'T-1: One');
  assert.equal(host.querySelectorAll('[data-cockpit-run-stream="true"] .wc').length, 1);
  assert.match(textOf(host.querySelector('.wstream h2')), /LATEST FINISHED TICKETS/);

  // stack: total and one tile per ledger bucket
  assert.equal(textOf(host.querySelector('.stack .n')), `${project.total} TICKETS`);
  const tileValues = Object.fromEntries(host.querySelectorAll('.cockpit-metric-tile').map(t => [textOf(t.children[0]).toLowerCase(), textOf(t.children[1])]));
  assert.equal(tileValues.done, '1');
  assert.equal(tileValues.running, '1');
  assert.equal(tileValues.waiting, '1');

  // the head follows the orchestrator without a remount; a second poll does not mount again
  const waiting = buildProjectCockpit(fakeBoard({
    orchestrator: { sessions: [{ id: 's1', state: 'waiting', lastAt: '2026-10-26T11:30:00.000Z' }] },
  }), 'alpha');
  view.update(waiting);
  await tick();
  assert.equal(heads.length, 1);
  const label2 = host.querySelector('.lab').getAttribute('data-orchestrator');
  assert.ok(typeof label2 === 'string' && label2.length > 0);
  assert.equal(heads[0].states[heads[0].states.length - 1], orchestratorHeadState(label2, false));

  // empty ready list explains itself
  const ledger = {
    ...project.ledger,
    tickets: [
      { id: 'T-1', title: 'One', status: 'done', stage: 'S1' },
      { id: 'T-2', title: 'Two', status: 'blocked', stage: 'S1', dependsOn: ['T-9'] },
      { id: 'T-9', title: 'Nine', status: 'blocked', stage: 'S2', dependsOn: ['T-2'] },
    ],
  };
  assert.equal(readyTickets(ledger.tickets).length, 0);
  assert.ok(emptyReadyExplanation(ledger, readyTickets));
  view.update(buildProjectCockpit({ ...board, projects: [{ ...board.projects[0], ledger }] }, 'alpha'));
  const emptyEl = host.querySelector('[data-cockpit-empty="ready"]');
  assert.ok(emptyEl);
  assert.match(textOf(emptyEl), /No ready tickets/i);
  assert.deepEqual(ticketIds(host.querySelector('#tickets-left')), []);

  host.querySelector('.cc-cockpit-back-btn').dispatchEvent({ type: 'click' });
  assert.equal(backCount, 1);

  view.destroy();
  assert.equal(host.children.length, 0);
  assert.equal(heads[0].destroyed, true);

  globalThis.document = prevDocument;
});

test('renderProjectCockpit uses server readyIds for NEXT UP and header when ledger strips dependsOn', async () => {
  const project = {
    id: 'strip-ready',
    name: 'Strip',
    ledger: {
      tickets: [
        { id: 'R-1', title: 'Ready one', status: 'ready' },
        { id: 'T-1', title: 'Todo blocked in full ledger', status: 'todo' },
      ],
    },
    sessions: [],
    meta: { project: 'Strip' },
    readyIds: ['R-1'],
    counts: {
      total: 9,
      done: 3,
      ready: 1,
      review: 0,
      blocked: 0,
      todo: 1,
      cancelled: 0,
      proposed: 0,
      superseded: 0,
      remaining: 6,
      percentDone: 33,
      counted: 9,
      needsYou: 7,
    },
    card: { blocked: { needYou: 7 } },
    total: 9,
    done: 3,
    percentDone: 33,
    runStream: [],
  };
  const { document, host, mountRobotHead } = setup();
  const prevDocument = globalThis.document;
  globalThis.document = document;
  const view = renderProjectCockpit(host, project, {
    document,
    now: () => NOW,
    glitch: () => false,
    mountRobotHead,
  });
  const counter = k => {
    const cnt = host.querySelector('.cnt');
    for (const cell of cnt.children) {
      for (const child of cell.children) {
        if (child.getAttribute?.('data-k') === k) return textOf(child);
      }
    }
    return '';
  };
  assert.equal(counter('tickets'), '9');
  assert.equal(counter('done'), '3');
  assert.equal(counter('need you'), '7');
  assert.match(textOf(host.querySelector('.now .k')), /NEXT UP/);
  assert.match(textOf(host.querySelector('.now .k')), /1 \/ 1/);
  assert.equal(textOf(host.querySelector('.now .t')), 'R-1');
  const leftIds = ticketIds(host.querySelector('#tickets-left'));
  assert.deepEqual(leftIds, ['R-1']);
  assert.ok(!leftIds.includes('T-1'));
  const tileValues = Object.fromEntries(
    host.querySelectorAll('.cockpit-metric-tile').map(t => [textOf(t.children[0]).toLowerCase(), textOf(t.children[1])]),
  );
  assert.equal(tileValues.ready, '1');
  view.destroy();
  globalThis.document = prevDocument;
});

test('renderProjectCockpit shows short muted lines when the project has no tickets', async () => {
  const project = buildProjectCockpit(fakeBoard({
    orchestrator: { sessions: [] },
    runStream: [],
    ledger: { tickets: [] },
    progress: null,
  }), 'alpha');
  const { document, host, mountRobotHead } = setup();
  const prevDocument = globalThis.document;
  globalThis.document = document;

  const view = renderProjectCockpit(host, project, { document, now: () => NOW, glitch: () => false, mountRobotHead });
  assert.equal(textOf(host.querySelector('.sub2')), 'NO TICKETS IN THE LEDGER');
  assert.match(textOf(host.querySelector('.stripl span')), /no stage ledger/);
  assert.equal(host.querySelectorAll('.strip i').length, 1);
  assert.match(textOf(host.querySelector('[data-cockpit-empty="ready"]')), /No ready tickets/);
  assert.match(textOf(host.querySelector('#tickets-right .cockpit-ticket-empty')), /No review, blocked or finished tickets/);
  assert.match(textOf(host.querySelector('.wgrid')), /No finished tickets yet/);
  assert.match(textOf(host.querySelector('.now .k')), /STATUS/);
  assert.equal(textOf(host.querySelector('.now .t')), 'Idle');
  assert.equal(host.querySelector('.cnt .v[data-k="agents"]').textContent, '0');
  view.destroy();
  globalThis.document = prevDocument;
});

test('stage strip colours follow the segment order', () => {
  assert.equal(STAGE_COLOURS.length, 7);
  const project = buildProjectCockpit(fakeBoard(), 'alpha');
  const { document, host, mountRobotHead } = setup();
  const prevDocument = globalThis.document;
  globalThis.document = document;
  const view = renderProjectCockpit(host, project, { document, now: () => NOW, glitch: () => false, mountRobotHead });
  const segs = host.querySelectorAll('.strip i');
  assert.equal(segs[0].style.background, STAGE_COLOURS[0]);
  assert.equal(segs[1].style.background, STAGE_COLOURS[1]);
  view.destroy();
  globalThis.document = prevDocument;
});

test('renderProjectCockpit view tabs use bare paths without window or defaultView location', () => {
  const project = buildProjectCockpit(fakeBoard(), 'alpha');
  const document = makeDocument();
  document.defaultView = null;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const prevDocument = globalThis.document;
  globalThis.document = document;
  const view = renderProjectCockpit(host, project, {
    document,
    window: {},
    now: () => NOW,
    glitch: () => false,
    mountRobotHead: () => ({ setState() {}, destroy() {} }),
  });
  const tabs = host.querySelectorAll('.tabs a');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].href, '/command-center');
  assert.equal(tabs[0].getAttribute('aria-current'), 'page');
  assert.equal(tabs[1].href, '/classic');
  view.destroy();
  globalThis.document = prevDocument;
});

test('cockpit footer explains cancelled tickets are outside live total and percent', async () => {
  const board = fakeBoard({
    counts: {
      total: 407,
      done: 230,
      ready: 0,
      review: 0,
      blocked: 0,
      todo: 177,
      cancelled: 13,
      proposed: 0,
      superseded: 0,
      remaining: 177,
      percentDone: 57,
      counted: 407,
      needsYou: 0,
      source: 'counts',
    },
    total: 407,
    done: 230,
    percentDone: 57,
  });
  const project = buildProjectCockpit(board, 'alpha');
  const { document, host, mountRobotHead } = setup();
  const prevDocument = globalThis.document;
  globalThis.document = document;
  const view = renderProjectCockpit(host, project, { document, now: () => NOW, glitch: () => false, mountRobotHead });
  const foot = textOf(host.querySelector('.ck-foot span'));
  assert.match(foot, /13 cancelled, not counted in the 407 live tickets or the percent/);
  view.destroy();
  globalThis.document = prevDocument;
});

test('direct-build cockpit hides headline swarm counts', async () => {
  const board = fakeBoard({
    directBuild: true,
    counts: {
      total: 407, done: 230, ready: 40, review: 0, blocked: 0, todo: 137,
      cancelled: 13, proposed: 0, superseded: 0, remaining: 177, percentDone: 57, counted: 407,
      needsYou: 0,
      source: 'counts',
    },
    total: 407,
    done: 230,
    percentDone: 57,
  });
  const project = buildProjectCockpit(board, 'alpha');
  assert.equal(project.directBuild, true);
  const { document, host, mountRobotHead } = setup();
  const prevDocument = globalThis.document;
  globalThis.document = document;
  const view = renderProjectCockpit(host, project, { document, now: () => NOW, glitch: () => false, mountRobotHead });
  assert.match(textOf(host.querySelector('.sub2')), /SWARM COUNTS HIDDEN/);
  assert.equal(host.querySelector('.cnt .v[data-k="tickets"]').textContent, '—');
  assert.match(textOf(host.querySelector('.ck-foot span')), /direct build: swarm counts hidden/);
  view.destroy();
  globalThis.document = prevDocument;
});
