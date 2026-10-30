// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionsOf } from '../tools/orchestrator-events.mjs';
import {
  cockpitOrchestratorState,
  cockpitOrchestratorFromSessions,
  isDispatchDoing,
  isReviewDoing,
} from '../tools/watch-assets/cockpit-orchestrator.js';
import {
  renderCockpit,
  resolveClampPx,
  estimateHeadlineWidthPx,
  cockpitSubline,
  orchestratorHeadState,
  orchestratorCaption,
  COCKPIT_TITLE_PX,
  COCKPIT_SHELL_MAX_PX,
  COCKPIT_HEADLINE_ROOT_PX,
  stageRingProgress,
} from '../tools/watch-assets/cockpit-view.js';
import { STAGE_COLOURS } from '../tools/watch-assets/cockpit-lists.js';

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
      this.children = [...kids];
      this.childNodes = [...kids];
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
    /** Selectors used here: a tag name or one class. */
    querySelectorAll(sel) {
      const test = sel.startsWith('.')
        ? n => n.classList?.contains(sel.slice(1))
        : n => n.tagName === sel.toUpperCase();
      const out = [];
      const walk = n => {
        for (const c of n.children || []) {
          if (test(c)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
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

test('clamp helper still resolves a clamp() size at a viewport width', () => {
  const fontPx = resolveClampPx('clamp(3.5rem, 4.8vw, 4.25rem)', 1440, COCKPIT_HEADLINE_ROOT_PX);
  assert.equal(fontPx, 68);
});

test('title block: project name, counts from the ledger, one line at 1440px and 390px', () => {
  installDom();
  const ledger = makeLedgerFixture();
  const host = document.createElement('div');
  const live = ledger.tickets.filter(t => !['cancelled', 'proposed'].includes(t.status));
  const done = live.filter(t => t.status === 'done').length;
  const total = live.length;
  const view = renderCockpit(host, { ledger, name: 'project-swarm' }, { now: NOW });
  assert.equal(view.done, done);
  assert.equal(view.total, total);
  const h1 = host.querySelector('h1');
  assert.equal(h1.textContent, 'PROJECT-SWARM');
  const sub = host.querySelector('.sub2');
  assert.equal(sub.textContent, cockpitSubline(done, total));
  assert.equal(sub.textContent, `${total} TICKETS · ${Math.round((100 * done) / total)}% DONE · ${total - done} LEFT`);
  // the project name fits one line at the artifact title sizes (54px wide wrap, 34px on a 390px phone)
  assert.ok(estimateHeadlineWidthPx(h1.textContent, COCKPIT_TITLE_PX.desktop) <= COCKPIT_SHELL_MAX_PX);
  assert.ok(estimateHeadlineWidthPx(h1.textContent, COCKPIT_TITLE_PX.phone) <= 390 - 32);
  // the right end of the stage line says when the ledger was read
  const stripl = host.querySelector('.stripl');
  assert.match(stripl.children[1].textContent, /LIVE LEDGER · 20:40 UTC$/);
});

test('title block falls back to short lines without a name, tickets or stages', () => {
  installDom();
  const host = document.createElement('div');
  renderCockpit(host, { ledger: { tickets: [] }, id: 'p-1' }, { now: NOW });
  assert.equal(host.querySelector('h1').textContent, 'P-1');
  assert.equal(host.querySelector('.sub2').textContent, 'NO TICKETS IN THE LEDGER');
  assert.equal(host.querySelector('.stripl').children[0].textContent, 'no stage ledger for this project');
  assert.equal(host.querySelector('.strip').children.length, 1);
  const bare = document.createElement('div');
  renderCockpit(bare, { ledger: { tickets: [] } }, { now: NOW });
  assert.equal(bare.querySelector('h1').textContent, 'UNNAMED PROJECT');
});

test('orchestrator label maps to a head state and a caption', () => {
  assert.equal(orchestratorHeadState('thinking', false), 'thinking');
  assert.equal(orchestratorHeadState('dispatching', false), 'working');
  assert.equal(orchestratorHeadState('reviewing', false), 'working');
  assert.equal(orchestratorHeadState('waiting on you', false), 'idle');
  assert.equal(orchestratorHeadState('idle', false), 'idle');
  assert.equal(orchestratorHeadState('idle', true), 'sleeping');
  assert.equal(orchestratorCaption('thinking', false), 'THINKING');
  assert.equal(orchestratorCaption('waiting on you', false), 'WAITING ON YOU');
  assert.equal(orchestratorCaption('idle', true), 'FINISHED · RESTING');
  assert.match(orchestratorCaption('idle', false), /NO SESSION ACTIVE/);
});

test('renderCockpit surfaces orchestrator label and detail from session fixture', () => {
  installDom();
  const sid = 'sess-render-orch-01';
  const events = [
    { at: iso(NOW - 6000), s: sid, e: 'prompt' },
    { at: iso(NOW - 1000), s: sid, e: 'pre', t: 'Task', u: 'task-1' },
  ];
  const session = sessionFromEvents(events);
  const ledger = makeLedgerFixture();
  const host = document.createElement('div');
  const view = renderCockpit(host, { ledger, sessions: [session] }, { now: NOW });
  assert.equal(view.orchestrator.label, 'dispatching');
  assert.match(String(view.orchestrator.detail), /Task/);
  assert.equal(orchestratorHeadState(view.orchestrator.label, false), 'working');
});

test('primary session wins when multiple orchestrator states are live', () => {
  installDom();
  const thinkingEvents = [
    { at: iso(NOW - 8000), s: 'sess-multi-think', e: 'prompt' },
    { at: iso(NOW - 7000), s: 'sess-multi-think', e: 'pre', t: 'Read', f: 'a.mjs', u: 'r1' },
    { at: iso(NOW - 6500), s: 'sess-multi-think', e: 'post', t: 'Read', u: 'r1' },
  ];
  const waitingEvents = [
    { at: iso(NOW - 20000), s: 'sess-multi-wait', e: 'prompt' },
    { at: iso(NOW - 10000), s: 'sess-multi-wait', e: 'stop' },
  ];
  const primary = sessionFromEvents(thinkingEvents);
  const secondary = sessionsOf([...thinkingEvents, ...waitingEvents], NOW).find(s => s.id === 'sess-multi-wait');
  assert.ok(secondary);
  assert.equal(primary.state, 'thinking');
  assert.equal(secondary.state, 'waiting');
  const merged = cockpitOrchestratorFromSessions([primary, secondary], NOW);
  assert.equal(merged.label, 'thinking');
  const ledger = makeLedgerFixture();
  const host = document.createElement('div');
  const view = renderCockpit(host, { ledger, sessions: [primary, secondary] }, { now: NOW });
  assert.equal(view.orchestrator.label, 'thinking');
  assert.equal(orchestratorCaption(view.orchestrator.label, false), 'THINKING');
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
  assert.deepEqual(expected.map(r => r.pct), [67, 50]);
  const host = document.createElement('div');
  const view = renderCockpit(host, { ledger }, { now: NOW });
  assert.equal(view.rings.length, 2);
  assert.equal(host.querySelector('.stripl').children[0].textContent, 'S1 2/3  ·  S2 1/2');
  assert.match(host.querySelector('.stripl').children[1].textContent, /^0 OF 2 STAGES DONE · LIVE LEDGER/);
  const segs = host.querySelector('.strip').children;
  assert.equal(segs.length, 2);
  assert.equal(segs[0].style.background, STAGE_COLOURS[0]);
  assert.equal(segs[1].style.background, STAGE_COLOURS[1]);
});

test('stage ring progress is computed independently per stage', () => {
  installDom();
  const ledger = makePerStageRatioLedgerFixture();
  const expected = stageRingProgress(ledger);
  assert.deepEqual(
    expected.map(r => ({ id: r.id, done: r.done, total: r.total, pct: r.pct })),
    [
      { id: 'S1', done: 2, total: 2, pct: 100 },
      { id: 'S2', done: 0, total: 2, pct: 0 },
      { id: 'S3', done: 1, total: 3, pct: 33 },
    ],
  );
  const host = document.createElement('div');
  const view = renderCockpit(host, { ledger }, { now: NOW });
  assert.equal(view.stagesDone, 1);
  assert.equal(host.querySelector('.stripl').children[0].textContent, 'S1 2/2  ·  S2 0/2  ·  S3 1/3');
  assert.match(host.querySelector('.stripl').children[1].textContent, /^1 OF 3 STAGES DONE/);
  const segs = host.querySelector('.strip').children;
  assert.equal(segs.length, 3);
  assert.equal(segs[0].style.background, '#4d7cff', 'a finished stage turns blue');
  assert.equal(segs[1].style.background, STAGE_COLOURS[1]);
  assert.equal(segs[2].style.background, STAGE_COLOURS[2]);
});

function makePerStageRatioLedgerFixture() {
  return {
    scope: {
      stages: [
        { id: 'S1', name: 'Complete' },
        { id: 'S2', name: 'Not started' },
        { id: 'S3', name: 'Partial' },
      ],
    },
    tickets: [
      { id: 'T-0101', status: 'done', stage: 'S1' },
      { id: 'T-0102', status: 'done', stage: 'S1' },
      { id: 'T-0201', status: 'todo', stage: 'S2' },
      { id: 'T-0202', status: 'running', stage: 'S2' },
      { id: 'T-0301', status: 'done', stage: 'S3' },
      { id: 'T-0302', status: 'todo', stage: 'S3' },
      { id: 'T-0303', status: 'blocked', stage: 'S3' },
      { id: 'T-9900', status: 'proposed', stage: 'S1' },
      { id: 'T-9901', status: 'cancelled', stage: 'S2' },
    ],
  };
}

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
