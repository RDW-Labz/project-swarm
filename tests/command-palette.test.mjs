// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommandPalette,
  isMacPlatform,
  paletteModifierForPlatform,
  isPaletteToggleEvent,
} from '../tools/watch-assets/command-palette.js';
import { ccNavigate, CC_INITIAL_STATE } from '../tools/watch-assets/cc-router.js';

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toString: () => [...set].join(' '),
  };
}

function makeElement(tag) {
  const classList = makeClassList();
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    classList,
    children: [],
    childNodes: [],
    textContent: '',
    attributes: {},
    parentNode: null,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      this.childNodes = this.children.slice();
      child.parentNode = null;
      return child;
    },
    addEventListener(type, fn, capture) {
      const key = capture ? `${type}:capture` : type;
      (listeners[key] ||= []).push(fn);
    },
    removeEventListener(type, fn, capture) {
      const key = capture ? `${type}:capture` : type;
      const arr = listeners[key];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchKey(type, init, capture) {
      const key = capture ? `${type}:capture` : type;
      const event = {
        key: init.key ?? '',
        metaKey: Boolean(init.metaKey),
        ctrlKey: Boolean(init.ctrlKey),
        preventDefault() { this.defaultPrevented = true; },
        defaultPrevented: false,
      };
      for (const fn of listeners[key] || []) fn(event);
      return event;
    },
    querySelector(sel) {
      const walk = (n) => {
        if (!n) return null;
        if (sel === '[data-cc-palette="open"]' && n.getAttribute && n.getAttribute('data-cc-palette') === 'open') return n;
        if (sel === '.cc-palette-item--selected' && n.classList && n.classList.contains('cc-palette-item--selected')) return n;
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
        if (sel === '.cc-palette-item' && n.classList && n.classList.contains('cc-palette-item')) out.push(n);
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

function makeDoc() {
  const body = makeElement('body');
  const docListeners = {};
  return {
    body,
    createElement: (tag) => makeElement(tag),
    addEventListener(type, fn, capture) {
      const key = capture ? `${type}:capture` : type;
      (docListeners[key] ||= []).push(fn);
    },
    removeEventListener(type, fn, capture) {
      const key = capture ? `${type}:capture` : type;
      const arr = docListeners[key];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchKey(init) {
      const event = {
        key: init.key ?? '',
        metaKey: Boolean(init.metaKey),
        ctrlKey: Boolean(init.ctrlKey),
        preventDefault() { this.defaultPrevented = true; },
        defaultPrevented: false,
      };
      for (const fn of docListeners['keydown:capture'] || []) fn(event);
      return event;
    },
    isPaletteOpen() {
      return Boolean(body.querySelector('[data-cc-palette="open"]'));
    },
  };
}

const SAMPLE_ITEMS = [
  { id: 'go-hive', label: 'Open Hive' },
  { id: 'go-cockpit', label: 'Open Cockpit' },
  { id: 'pause', label: 'Pause motion' },
];

test('platform modifier detection', () => {
  assert.equal(isMacPlatform('MacIntel'), true);
  assert.equal(isMacPlatform('Win32'), false);
  assert.equal(paletteModifierForPlatform('MacIntel'), 'meta');
  assert.equal(paletteModifierForPlatform('Linux x86_64'), 'ctrl');
});

test('Cmd+K opens on Mac; Ctrl+K does not', () => {
  const doc = makeDoc();
  const palette = createCommandPalette({ doc, items: SAMPLE_ITEMS, platform: 'MacIntel' });
  palette.bind();
  assert.equal(doc.isPaletteOpen(), false);
  doc.dispatchKey({ key: 'k', metaKey: true });
  assert.equal(doc.isPaletteOpen(), true);
  doc.dispatchKey({ key: 'k', ctrlKey: true });
  assert.equal(doc.isPaletteOpen(), true);
  palette.unbind();
});

test('Ctrl+K opens off Mac; Cmd+K does not', () => {
  const doc = makeDoc();
  const palette = createCommandPalette({ doc, items: SAMPLE_ITEMS, platform: 'Win32' });
  palette.bind();
  doc.dispatchKey({ key: 'k', metaKey: true });
  assert.equal(doc.isPaletteOpen(), false);
  doc.dispatchKey({ key: 'k', ctrlKey: true });
  assert.equal(doc.isPaletteOpen(), true);
  palette.unbind();
});

test('isPaletteToggleEvent matches platform convention', () => {
  assert.equal(isPaletteToggleEvent({ key: 'k', metaKey: true, ctrlKey: false }, 'MacIntel'), true);
  assert.equal(isPaletteToggleEvent({ key: 'k', metaKey: false, ctrlKey: true }, 'MacIntel'), false);
  assert.equal(isPaletteToggleEvent({ key: 'k', metaKey: false, ctrlKey: true }, 'Win32'), true);
  assert.equal(isPaletteToggleEvent({ key: 'k', metaKey: true, ctrlKey: false }, 'Win32'), false);
});

test('ArrowDown and ArrowUp move selection with wrap', () => {
  const doc = makeDoc();
  const palette = createCommandPalette({ doc, items: SAMPLE_ITEMS, platform: 'Win32' });
  palette.bind();
  doc.dispatchKey({ key: 'k', ctrlKey: true });
  assert.equal(palette.selectedIndex, 0);
  doc.dispatchKey({ key: 'ArrowDown' });
  assert.equal(palette.selectedIndex, 1);
  doc.dispatchKey({ key: 'ArrowDown' });
  assert.equal(palette.selectedIndex, 2);
  doc.dispatchKey({ key: 'ArrowDown' });
  assert.equal(palette.selectedIndex, 0);
  doc.dispatchKey({ key: 'ArrowUp' });
  assert.equal(palette.selectedIndex, 2);
  const selected = doc.body.querySelector('.cc-palette-item--selected');
  assert.equal(selected.getAttribute('data-command-id'), 'pause');
  palette.unbind();
});

test('Enter navigates to selected item and closes', () => {
  const doc = makeDoc();
  const navigated = [];
  const palette = createCommandPalette({
    doc,
    items: SAMPLE_ITEMS,
    platform: 'Win32',
    onNavigate: (item) => navigated.push(item),
  });
  palette.bind();
  doc.dispatchKey({ key: 'k', ctrlKey: true });
  doc.dispatchKey({ key: 'ArrowDown' });
  doc.dispatchKey({ key: 'Enter' });
  assert.equal(doc.isPaletteOpen(), false);
  assert.deepEqual(navigated, [SAMPLE_ITEMS[1]]);
  palette.unbind();
});

test('Escape closes without navigating', () => {
  const doc = makeDoc();
  const navigated = [];
  const palette = createCommandPalette({
    doc,
    items: SAMPLE_ITEMS,
    platform: 'Win32',
    onNavigate: (item) => navigated.push(item),
  });
  palette.bind();
  doc.dispatchKey({ key: 'k', ctrlKey: true });
  doc.dispatchKey({ key: 'Escape' });
  assert.equal(doc.isPaletteOpen(), false);
  assert.equal(navigated.length, 0);
  palette.unbind();
});

const NAV_ITEMS = [
  {
    id: 'nav-project-alpha',
    label: 'Open project Alpha',
    type: 'project',
    projectId: 'project-alpha',
  },
  {
    id: 'nav-doc-build-plan',
    label: 'Open build plan',
    type: 'doc',
    docId: 'docs/scope/build-plan.md',
  },
];

test('Enter on project palette item passes item to onNavigate and projectId drives ccNavigate', () => {
  const doc = makeDoc();
  const navigated = [];
  const palette = createCommandPalette({
    doc,
    items: NAV_ITEMS,
    platform: 'Win32',
    onNavigate: (item) => navigated.push(item),
  });
  palette.bind();
  doc.dispatchKey({ key: 'k', ctrlKey: true });
  assert.equal(palette.selectedIndex, 0);
  doc.dispatchKey({ key: 'Enter' });
  assert.equal(doc.isPaletteOpen(), false);
  assert.equal(navigated.length, 1);
  assert.deepEqual(navigated[0], NAV_ITEMS[0]);

  const cockpitState = ccNavigate(CC_INITIAL_STATE, {
    type: 'select-project',
    projectId: navigated[0].projectId,
  });
  assert.deepEqual(cockpitState, { view: 'cockpit', projectId: 'project-alpha' });
  palette.unbind();
});

test('Enter on doc palette item passes correctly shaped item for future Resources hub router', () => {
  // Routing doc items into the Resources hub is out of scope here (T-0341/T-0342);
  // this test only proves the palette hands off the correct item at its boundary.
  const doc = makeDoc();
  const navigated = [];
  const palette = createCommandPalette({
    doc,
    items: NAV_ITEMS,
    platform: 'Win32',
    onNavigate: (item) => navigated.push(item),
  });
  palette.bind();
  doc.dispatchKey({ key: 'k', ctrlKey: true });
  doc.dispatchKey({ key: 'ArrowDown' });
  assert.equal(palette.selectedIndex, 1);
  doc.dispatchKey({ key: 'Enter' });
  assert.equal(doc.isPaletteOpen(), false);
  assert.equal(navigated.length, 1);
  assert.deepEqual(navigated[0], NAV_ITEMS[1]);
  assert.equal(navigated[0].type, 'doc');
  assert.equal(navigated[0].docId, 'docs/scope/build-plan.md');
  palette.unbind();
});
