// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOUR_STEPS,
  completionKey,
  hasCompleted,
  startTour,
} from '../tools/watch-assets/cc-tour.js';

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toString: () => [...set].join(' '),
  };
}

function makeElement(tag, doc) {
  const classList = makeClassList();
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    classList,
    children: [],
    attributes: {},
    hidden: false,
    textContent: '',
    type: 'button',
    disabled: false,
    parentNode: null,
    tabindex: null,
    setAttribute(k, v) {
      this.attributes[k] = v;
      if (k === 'data-tour') this.dataset = { ...this.dataset, tour: v };
    },
    getAttribute(k) {
      return this.attributes[k] ?? null;
    },
    dataset: {},
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    append(...kids) {
      for (const child of kids) this.appendChild(child);
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
    },
    focus() {
      if (doc) doc.activeElement = this;
    },
    click() {
      for (const fn of listeners.click || []) fn({ preventDefault() {} });
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

function matchSelector(node, sel) {
  const dataTour = /^\[data-tour='([^']+)'\]$/.exec(sel);
  if (dataTour) {
    return node.getAttribute('data-tour') === dataTour[1];
  }
  return false;
}

function querySelectorWalk(root, sel) {
  if (!root) return null;
  if (root.getAttribute && matchSelector(root, sel)) return root;
  for (const c of root.children || []) {
    const hit = querySelectorWalk(c, sel);
    if (hit) return hit;
  }
  return null;
}

function makeFakeDoc() {
  const keydownCapture = [];
  let activeElement = null;
  const body = makeElement('body', null);
  const doc = {
    body,
    activeElement,
    createElement(tag) {
      const el = makeElement(tag, doc);
      return el;
    },
    querySelector(sel) {
      const inBody = querySelectorWalk(body, sel);
      if (inBody) return inBody;
      for (const step of TOUR_STEPS) {
        if (sel === step.selector) {
          for (const c of body.children) {
            const hit = querySelectorWalk(c, sel);
            if (hit) return hit;
          }
        }
      }
      return querySelectorWalk(body, sel);
    },
    addEventListener(type, fn, capture) {
      if (type === 'keydown' && capture) keydownCapture.push(fn);
    },
    removeEventListener(type, fn, capture) {
      if (type === 'keydown' && capture) {
        const i = keydownCapture.indexOf(fn);
        if (i >= 0) keydownCapture.splice(i, 1);
      }
    },
    _dispatchKeydown(e) {
      for (const fn of [...keydownCapture]) fn(e);
    },
  };
  Object.defineProperty(doc, 'activeElement', {
    get() {
      return activeElement;
    },
    set(v) {
      activeElement = v;
    },
  });
  body.focus = () => {};
  return doc;
}

function makeStorage() {
  const _d = {};
  return {
    _d,
    getItem(k) {
      return _d[k] ?? null;
    },
    setItem(k, v) {
      _d[k] = v;
    },
  };
}

function installTourTargets(doc) {
  for (const step of TOUR_STEPS) {
    const el = doc.createElement('div');
    const m = /\[data-tour='([^']+)'\]/.exec(step.selector);
    if (m) el.setAttribute('data-tour', m[1]);
    doc.body.appendChild(el);
  }
}

function findOverlay(doc) {
  return doc.body.children.find((c) => c.classList.contains('cc-tour-overlay')) || null;
}

function tourButtons(overlay) {
  const card = overlay.children.find((c) => c.classList.contains('cc-tour-card'));
  assert.ok(card, 'tour card');
  const back = card.children.find((c) => c.tagName === 'BUTTON' && c.textContent === 'Back');
  const next = card.children.find(
    (c) => c.tagName === 'BUTTON' && (c.textContent === 'Next' || c.textContent === 'Finish'),
  );
  const skip = card.children.find((c) => c.tagName === 'BUTTON' && c.textContent === 'Skip tour');
  return { back, next, skip };
}

function keydown(doc, key, opts = {}) {
  const e = {
    key,
    shiftKey: Boolean(opts.shiftKey),
    preventDefault() {},
  };
  doc._dispatchKeydown(e);
  return e;
}

test('completionKey and hasCompleted round-trip through storage', () => {
  const storage = makeStorage();
  const userId = 'user-42';
  assert.equal(completionKey(userId), 'cc-tour-completed:user-42');
  assert.equal(completionKey(), 'cc-tour-completed:anonymous');
  assert.equal(hasCompleted(storage, userId), false);
  storage.setItem(completionKey(userId), '1');
  assert.equal(hasCompleted(storage, userId), true);
  assert.equal(storage.getItem(completionKey(userId)), '1');
});

test('startTour returns null when already completed and replay is false', () => {
  const doc = makeFakeDoc();
  installTourTargets(doc);
  const storage = makeStorage();
  storage.setItem(completionKey('u1'), '1');
  assert.equal(startTour({ doc, storage, userId: 'u1', replay: false }), null);
  assert.equal(findOverlay(doc), null);
});

test('replay:true starts tour again without clearing completion for hasCompleted', () => {
  const doc = makeFakeDoc();
  installTourTargets(doc);
  const storage = makeStorage();
  storage.setItem(completionKey('u1'), '1');
  assert.equal(hasCompleted(storage, 'u1'), true);
  const handle = startTour({ doc, storage, userId: 'u1', replay: true });
  assert.ok(handle);
  assert.ok(findOverlay(doc));
  handle.close();
  assert.equal(hasCompleted(storage, 'u1'), true);
});

test('tour overlay controls are focusable and Tab moves focus in order', () => {
  const doc = makeFakeDoc();
  installTourTargets(doc);
  const storage = makeStorage();
  const prior = doc.createElement('button');
  prior.textContent = 'prior';
  doc.body.appendChild(prior);
  prior.focus();
  doc.activeElement = prior;

  const handle = startTour({ doc, storage, userId: 'tab-user' });
  assert.ok(handle);
  const overlay = findOverlay(doc);
  assert.ok(overlay);
  const { back, next, skip } = tourButtons(overlay);
  assert.ok(back && next && skip, 'back, next, skip in DOM');

  for (const btn of [back, next, skip]) {
    assert.notEqual(btn.getAttribute('tabindex'), '-1');
    assert.equal(btn.hidden, false);
    assert.equal(btn.tagName, 'BUTTON');
  }

  assert.equal(doc.activeElement, next, 'show(0) focuses Next');

  keydown(doc, 'Tab');
  assert.equal(doc.activeElement, skip);
  keydown(doc, 'Tab');
  assert.equal(doc.activeElement, back);
  keydown(doc, 'Tab');
  assert.equal(doc.activeElement, next);

  keydown(doc, 'Tab', { shiftKey: true });
  assert.equal(doc.activeElement, back);

  handle.close();
});

test('Escape dismisses tour, removes overlay, and restores prior focus', () => {
  const doc = makeFakeDoc();
  installTourTargets(doc);
  const storage = makeStorage();
  const prior = doc.createElement('button');
  prior.textContent = 'prior';
  let priorFocused = 0;
  prior.focus = () => {
    priorFocused += 1;
    doc.activeElement = prior;
  };
  doc.body.appendChild(prior);
  doc.activeElement = prior;

  const onCloseCalls = [];
  const handle = startTour({
    doc,
    storage,
    userId: 'esc-user',
    onClose: (completed) => onCloseCalls.push(completed),
  });
  assert.ok(handle);
  assert.ok(findOverlay(doc));

  keydown(doc, 'Escape');
  assert.equal(findOverlay(doc), null);
  assert.equal(priorFocused, 1, 'focus returns to element active before tour');
  assert.deepEqual(onCloseCalls, [false]);
  assert.equal(hasCompleted(storage, 'esc-user'), true);
});
