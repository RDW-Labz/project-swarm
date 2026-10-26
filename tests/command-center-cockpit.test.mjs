// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionsOf } from '../tools/orchestrator-events.mjs';
import {
  cockpitOrchestratorState,
  isDispatchDoing,
  isReviewDoing,
} from '../tools/watch-assets/cockpit-orchestrator.js';
import {
  renderCockpit,
  resolveClampPx,
  estimateHeadlineWidthPx,
  headlineTicketText,
  COCKPIT_HEADLINE_CLAMP,
  COCKPIT_SHELL_MAX_PX,
  COCKPIT_HEADLINE_ROOT_PX,
  stageRingProgress,
} from '../tools/watch-assets/cockpit-view.js';

const NOW = Date.UTC(2026, 9, 26, 20, 40, 0);

function iso(at) {
  return new Date(at).toISOString();
}

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
    dataset: {},
    attributes: {},
    textContent: '',
    parentNode: null,
    replaceChildren(...kids) {
      this.children = kids;
      this.childNodes = kids;
      for (const k of kids) k.parentNode = this;
    },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    querySelector(sel) {
      const walk = n => {
        if (!n) return null;
        if (sel === 'h1' && n.tagName === 'H1') return n;
        if (sel === '.cockpit-stage-ring' && n.classList?.contains('cockpit-stage-ring')) return n;
        if (sel === '.headline-num' && n.classList?.contains('headline-num')) return n;
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
        if (sel === '.cockpit-stage-fill' && n.classList?.contains('cockpit-stage-fill')) out.push(n);
        if (sel === '.cockpit-stage-count' && n.classList?.contains('cockpit-stage-count')) out.push(n);
        for (const c of n.children || []) walk(c);
      };
      walk(this);
      return out;
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return [...classList.toString().split(' ')].filter(Boolean).join(' '); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

function installDom() {
  const document = {
    createElement: tag => makeElement(tag),
    createTextNode: text => ({ nodeType: 3, textContent: text }),
    body: makeElement('body'),
  };
  globalThis.document = document;
  return document;
}

function sessionFromEvents(events, now = NOW) {
  const rows = sessionsOf(events, now);
  assert.equal(rows.length, 1, 'fixture should yield one session');
  return rows[0];
}

test('dispatch-shaped doing is detected from real event log', () => {
  const sid = 'sess-dispatch-01';
  const t0 = NOW - 5000;
  const events = [
    { at: iso(t0), s: sid, e: 'prompt', tp: 'abc.jsonl' },
    { at: iso(t0 + 1000), s: sid, e: 'pre', t: 'Task', u: 'tu-1' },
  ];
  const session = sessionFromEvents(events);
  assert.equal(session.state, 'working');
  assert.ok(isDispatchDoing(session.doing));
  const out = cockpitOrchestratorState(session, NOW);
  assert.equal(out.label, 'dispatching');
  assert.match(out.detail, /Task/);
});

test('Bash swarm run maps to dispatching', () => {
  const sid = 'sess-dispatch-02';
  const events = [
    { at: iso(NOW - 8000), s: sid, e: 'prompt' },
    { at: iso(NOW - 2000), s: sid, e: 'pre', t: 'Bash', c: 'swarm run examples/smoke.json', u: 'bash-1' },
  ];
  const session = sessionFromEvents(events);
  assert.equal(session.state, 'working');
  assert.ok(isDispatchDoing(session.doing));
  assert.equal(cockpitOrchestratorState(session, NOW).label, 'dispatching');
});

test('thinking state from prompt tail without running tools', () => {
  const sid = 'sess-think-01';
  const events = [
    { at: iso(NOW - 4000), s: sid, e: 'prompt', tp: 'abc.jsonl' },
    { at: iso(NOW - 3500), s: sid, e: 'pre', t: 'Read', f: 'tools/swarm.mjs', u: 'r1' },
    { at: iso(NOW - 3000), s: sid, e: 'post', t: 'Read', u: 'r1' },
  ];
  const session = sessionFromEvents(events);
  assert.equal(session.state, 'thinking');
  assert.equal(cockpitOrchestratorState(session, NOW).label, 'thinking');
});

test('waiting on you after stop', () => {
  const sid = 'sess-wait-01';
  const events = [
    { at: iso(NOW - 120000), s: sid, e: 'prompt' },
    { at: iso(NOW - 60000), s: sid, e: 'stop', tp: 'abc.jsonl' },
  ];
  const session = sessionFromEvents(events);
  assert.equal(session.state, 'waiting');
  const out = cockpitOrchestratorState(session, NOW);
  assert.equal(out.label, 'waiting on you');
  assert.match(out.detail, /waiting on you/i);
});

test('reviewing while Read tool is in flight', () => {
  const sid = 'sess-review-01';
  const events = [
    { at: iso(NOW - 10000), s: sid, e: 'prompt' },
    { at: iso(NOW - 1500), s: sid, e: 'pre', t: 'Read', f: 'tests/foo.test.mjs', u: 'read-9' },
  ];
  const session = sessionFromEvents(events);
  assert.equal(session.state, 'working');
  assert.ok(isReviewDoing(session.doing));
  assert.equal(cockpitOrchestratorState(session, NOW).label, 'reviewing');
  assert.match(outDetail(session), /Read/);
});

function outDetail(session) {
  return cockpitOrchestratorState(session, NOW).detail;
}

test('headline clamp resolves to 68px at 1440px and text fits one line', () => {
  installDom();
  const fontPx = resolveClampPx(COCKPIT_HEADLINE_CLAMP, COCKPIT_SHELL_MAX_PX, COCKPIT_HEADLINE_ROOT_PX);
  const minRem = 3.5 * COCKPIT_HEADLINE_ROOT_PX;
  const vw = (4.8 / 100) * COCKPIT_SHELL_MAX_PX;
  const maxRem = 4.25 * COCKPIT_HEADLINE_ROOT_PX;
  assert.equal(fontPx, Math.max(minRem, Math.min(vw, maxRem)));
  assert.equal(fontPx, 68);

  const ledger = makeLedgerFixture();
  const host = document.createElement('div');
  const live = ledger.tickets.filter(t => !['cancelled', 'proposed'].includes(t.status));
  const done = live.filter(t => t.status === 'done').length;
  const total = live.length;
  const view = renderCockpit(host, { ledger }, { now: NOW });
  assert.equal(view.headlineFontPxAt1440, 68);
  const h1 = host.querySelector('h1');
  assert.equal(h1.style.fontSize, COCKPIT_HEADLINE_CLAMP);
  const text = headlineTicketText(done, total) + ' tickets done';
  const inner = host.querySelector('.headline-num').parentNode;
  const fullLine = collectText(inner);
  assert.match(fullLine, new RegExp(`${done} of ${total}`));
  const contentWidth = COCKPIT_SHELL_MAX_PX - 24;
  assert.ok(
    estimateHeadlineWidthPx(fullLine, fontPx) <= contentWidth,
    `headline width ${estimateHeadlineWidthPx(fullLine, fontPx)} should fit ${contentWidth}`,
  );
});

test('stage rings reflect ledgerStats done per stage', () => {
  installDom();
  const ledger = makeLedgerFixture();
  const expected = stageRingProgress(ledger);
  assert.deepEqual(
    expected.map(r => ({ id: r.id, done: r.done, total: r.total })),
    [
      { id: 'S1', done: 2, total: 3 },
      { id: 'S2', done: 1, total: 2 },
    ],
  );
  const host = document.createElement('div');
  renderCockpit(host, { ledger }, { now: NOW });
  const stagesWrap = host.children.find(c => c.classList.contains('cockpit-stage-rings'));
  assert.ok(stagesWrap, 'stage rings container');
  const rings = stagesWrap.children.filter(c => c.classList.contains('cockpit-stage-ring'));
  assert.equal(rings.length, 2);
  const counts = rings.map(r => r.children.find(c => c.classList.contains('cockpit-stage-count')));
  assert.equal(counts[0].textContent, '2/3');
  assert.equal(counts[1].textContent, '1/2');
  const fills = rings.map(r => r.children.find(c => c.classList.contains('cockpit-stage-track'))?.children?.[0]);
  assert.equal(fills[0].dataset.pct, '67');
  assert.equal(fills[1].dataset.pct, '50');
  assert.equal(rings[0].dataset.stage, 'S1');
  assert.equal(rings[1].dataset.stage, 'S2');
});

function collectText(node) {
  if (!node) return '';
  if (node.textContent) return node.textContent;
  return (node.children || []).map(collectText).join('');
}

function makeLedgerFixture() {
  return {
    scope: {
      stages: [
        { id: 'S1', name: 'Foundation' },
        { id: 'S2', name: 'Polish' },
      ],
    },
    tickets: [
      { id: 'T-0001', status: 'done', stage: 'S1' },
      { id: 'T-0002', status: 'done', stage: 'S1' },
      { id: 'T-0003', status: 'running', stage: 'S1' },
      { id: 'T-0004', status: 'done', stage: 'S2' },
      { id: 'T-0005', status: 'todo', stage: 'S2' },
      { id: 'T-0099', status: 'proposed', stage: 'S1' },
    ],
  };
}
