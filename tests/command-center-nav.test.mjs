// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ccNavigate, CC_INITIAL_STATE, mountCcRouter } from '../tools/watch-assets/cc-router.js';

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, force) => {
      const on = force !== undefined ? force : !set.has(c);
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
    contains: (c) => set.has(c),
    toString: () => [...set].join(' '),
  };
}

function matchesSelector(n, sel) {
  if (!n || !n.classList) return false;
  if (sel === '.hive-nodes' && n.classList.contains('hive-nodes')) return true;
  if (sel === '#hive-nodes' && n.id === 'hive-nodes') return true;
  if (sel === '.hive-legend' && n.classList.contains('hive-legend')) return true;
  if (sel === '.hive-node' && n.classList.contains('hive-node')) return true;
  if (sel === '.cockpit-nav' && n.classList.contains('cockpit-nav')) return true;
  if (sel === '.nav-block' && n.classList.contains('nav-block')) return true;
  if (sel === '.cc-cockpit-root' && n.classList.contains('cc-cockpit-root')) return true;
  return false;
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
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
    },
    dataset: {},
    attributes: {},
    hidden: false,
    textContent: '',
    title: '',
    parentNode: null,
    firstChild: null,
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    getAttribute(k) {
      return this.attributes[k] ?? null;
    },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      this.firstChild = this.children[0] || null;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      this.childNodes = this.children.slice();
      this.firstChild = this.children[0] || null;
      return child;
    },
    replaceChildren(...kids) {
      this.children = [];
      this.childNodes = [];
      for (const k of kids) this.appendChild(k);
      this.firstChild = this.children[0] || null;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    click() {
      for (const fn of listeners.click || []) fn({ target: this, preventDefault() {} });
    },
    querySelector(sel) {
      const compound = String(sel).trim().split(/\s+/).filter(Boolean);
      if (compound.length > 1) {
        let scope = this;
        for (const part of compound) {
          scope = scope.querySelector(part);
          if (!scope) return null;
        }
        return scope;
      }
      const walk = (n) => {
        if (!n) return null;
        if (matchesSelector(n, sel)) return n;
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
      const walk = (n) => {
        if (!n) return;
        if (matchesSelector(n, sel)) out.push(n);
        for (const c of n.children || []) walk(c);
      };
      walk(this);
      return out;
    },
    closest() {
      return null;
    },
  };
  Object.defineProperty(node, 'className', {
    get() {
      return [...classList.toString().split(' ')].filter(Boolean).join(' ');
    },
    set(v) {
      classList.add(...String(v).split(/\s+/).filter(Boolean));
    },
  });
  return node;
}

function installFakeDocument() {
  const document = {
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    body: makeElement('body'),
  };
  globalThis.document = document;
  globalThis.window = { innerHeight: 800, document };
  return document;
}

const SAMPLE_PROJECTS = [
  { id: 'proj-alpha', name: 'Alpha', lane: 'safety' },
  { id: 'proj-beta', name: 'Beta', lane: 'route' },
];

test('ccNavigate select-project: hive -> cockpit(projectId) table-driven', () => {
  for (const projectId of ['proj-alpha', 'proj-beta', 'proj-gamma-99']) {
    const next = ccNavigate(CC_INITIAL_STATE, { type: 'select-project', projectId });
    assert.deepEqual(next, { view: 'cockpit', projectId });
  }
});

test('ccNavigate back: cockpit -> hive in one action', () => {
  const cockpit = { view: 'cockpit', projectId: 'proj-alpha' };
  const next = ccNavigate(cockpit, { type: 'back' });
  assert.deepEqual(next, { view: 'hive' });
  assert.notDeepEqual(next, cockpit);
});

test('hive node click opens cockpit for that card project id', () => {
  installFakeDocument();
  const seen = [];

  function mountWithContainer() {
    const container = document.createElement('div');
    const router = mountCcRouter(container, {
      projects: SAMPLE_PROJECTS,
      getCockpitData: (projectId) => {
        seen.push(projectId);
        return {
          ledger: { tickets: [] },
          meta: { project: projectId },
        };
      },
    });
    return { container, router };
  }

  const betaRun = mountWithContainer();
  const cardsBeta = betaRun.container.querySelectorAll('.hive-node');
  assert.equal(cardsBeta.length, 2);
  cardsBeta[1].click();
  assert.equal(seen.at(-1), 'proj-beta');
  assert.deepEqual(betaRun.router.getState(), { view: 'cockpit', projectId: 'proj-beta' });
  assert.ok(betaRun.container.querySelector('.cockpit-nav'), 'cockpit breadcrumb visible');
  assert.equal(betaRun.container.querySelectorAll('.hive-node').length, 0);

  const alphaRun = mountWithContainer();
  alphaRun.container.querySelectorAll('.hive-node')[0].click();
  assert.equal(seen.at(-1), 'proj-alpha');
  assert.deepEqual(alphaRun.router.getState(), { view: 'cockpit', projectId: 'proj-alpha' });
});

test('cockpit breadcrumb click returns to hive with node cards visible', () => {
  installFakeDocument();
  const container = document.createElement('div');
  const router = mountCcRouter(container, {
    projects: SAMPLE_PROJECTS,
    getCockpitData: (projectId) => ({
      ledger: { tickets: [] },
      meta: { owner: 'you', lane: 'build', project: projectId },
    }),
  });

  container.querySelectorAll('.hive-node')[0].click();
  assert.equal(router.getState().view, 'cockpit');
  assert.equal(router.getState().projectId, 'proj-alpha');

  const breadcrumb = container.querySelector('.cockpit-nav .nav-block')
    || container.querySelector('.cockpit-nav');
  assert.ok(breadcrumb, 'breadcrumb nav-block');
  breadcrumb.click();

  assert.deepEqual(router.getState(), { view: 'hive' });
  const cardsAfter = container.querySelectorAll('.hive-node');
  assert.equal(cardsAfter.length, 2);
  assert.ok(cardsAfter[0].classList.contains('hive-node'));
  assert.ok(cardsAfter[1].classList.contains('hive-node'));
});
