// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ownerActionAvailable, renderOwnerActions } from '../tools/watch-assets/board-owner-actions.js';

const BOARD_HDR = 'tok-test';

function makeDoc() {
  const nodes = [];
  function createElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: '',
      _text: '',
      hidden: false,
      disabled: false,
      type: '',
      childNodes: [],
      attributes: {},
      style: {},
      addEventListener(type, fn) {
        el._listeners = el._listeners || {};
        (el._listeners[type] = el._listeners[type] || []).push(fn);
      },
      appendChild(child) {
        el.childNodes.push(child);
        child.parentNode = el;
        return child;
      },
      querySelectorAll() {
        const out = [];
        function walk(n) {
          if (n.tagName === 'BUTTON') { out.push(n); }
          for (const c of n.childNodes || []) { walk(c); }
        }
        walk(el);
        return out;
      },
      click() {
        const fns = el._listeners && el._listeners.click;
        if (fns) { fns.forEach((fn) => fn()); }
      },
    };
    Object.defineProperty(el, 'textContent', {
      get() { return el._text; },
      set(v) {
        el._text = v == null ? '' : String(v);
        el.childNodes.length = 0;
      },
    });
    Object.defineProperty(el, 'innerHTML', {
      set() { throw new Error('innerHTML must not be used'); },
      get() { return ''; },
    });
    nodes.push(el);
    return el;
  }
  return { createElement, nodes };
}

async function flushAsync() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function ownerItem(overrides = {}) {
  return {
    id: 'dec-1',
    kind: 'decision',
    needsOwner: true,
    title: 'Pick a lane',
    ...overrides,
  };
}

function buttonTexts(root) {
  const texts = [];
  function walk(n) {
    if (n.tagName === 'BUTTON' && n.textContent) { texts.push(n.textContent); }
    for (const c of n.childNodes || []) { walk(c); }
  }
  walk(root);
  return texts;
}

function statusText(root) {
  function walk(n) {
    if (n.className === 'owner-actions-status') { return n.textContent; }
    for (const c of n.childNodes || []) {
      const hit = walk(c);
      if (hit) { return hit; }
    }
    return '';
  }
  return walk(root);
}

describe('board owner actions UI', () => {
  it('ownerActionAvailable requires sign-in and needsOwner', () => {
    const item = ownerItem();
    assert.equal(ownerActionAvailable(item, { signedIn: false }), false);
    assert.equal(ownerActionAvailable(item, { signedIn: true }), true);
    assert.equal(ownerActionAvailable({ ...item, needsOwner: false }, { signedIn: true }), false);
  });

  it('hides controls when not signed in or not owner-policy', () => {
    const doc = makeDoc();
    const container = doc.createElement('div');
    renderOwnerActions(container, ownerItem(), { fetchImpl: () => {}, token: BOARD_HDR, signedIn: false, doc });
    assert.equal(container.childNodes.length, 0);
    renderOwnerActions(container, { ...ownerItem(), needsOwner: false }, {
      fetchImpl: () => {},
      token: BOARD_HDR,
      signedIn: true,
      doc,
    });
    assert.equal(container.childNodes.length, 0);
  });

  it('never renders controls for refused kinds', () => {
    const doc = makeDoc();
    const container = doc.createElement('div');
    for (const kind of ['merge', 'deploy', 'cap-raise', 'spend', 'key', 'migration', ' Deploy', 'MERGE-request']) {
      container.textContent = '';
      assert.equal(ownerActionAvailable(ownerItem({ kind }), { signedIn: true }), false);
      renderOwnerActions(container, ownerItem({ kind }), {
        fetchImpl: () => {},
        token: BOARD_HDR,
        signedIn: true,
        doc,
      });
      assert.equal(container.childNodes.length, 0);
    }
  });

  it('two-step confirm labels and cancel returns to idle', () => {
    const doc = makeDoc();
    const container = doc.createElement('div');
    renderOwnerActions(container, ownerItem(), { fetchImpl: () => {}, token: BOARD_HDR, signedIn: true, doc });
    const approve = doc.nodes.find((n) => n.textContent === 'Approve');
    approve.click();
    assert.deepEqual(buttonTexts(container), ['Confirm approve?', 'Cancel']);
    const cancel = doc.nodes.find((n) => n.textContent === 'Cancel');
    cancel.click();
    assert.deepEqual(buttonTexts(container), ['Approve', 'Deny']);
  });

  it('sends token only in x-watch-token header and runs prepare then decision', async () => {
    const doc = makeDoc();
    const container = doc.createElement('div');
    const calls = [];
    const fetchImpl = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/prepare')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ confirmToken: 'cfm-1', expiresAt: '2099-01-01T00:00:00.000Z', summary: 'ok' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ itemId: 'dec-1', decision: 'approve', result: 'Recorded' }),
      });
    };
    renderOwnerActions(container, ownerItem(), { fetchImpl, token: BOARD_HDR, signedIn: true, doc });
    doc.nodes.find((n) => n.textContent === 'Approve').click();
    doc.nodes.find((n) => n.textContent === 'Confirm approve?').click();
    await flushAsync();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, '/api/owner/actions/dec-1/prepare');
    assert.equal(calls[1].url, '/api/owner/actions/dec-1/decision');
    for (const c of calls) {
      assert.equal(c.init.headers['x-watch-token'], BOARD_HDR);
      assert.equal(String(c.url).includes('tok'), false);
      assert.equal(String(c.url).includes('?'), false);
    }
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.decision, 'approve');
    assert.equal(body.confirm, 'cfm-1');
    assert.equal(statusText(container), 'Recorded');
  });

  it('shows server refusal message', async () => {
    const doc = makeDoc();
    const container = doc.createElement('div');
    const fetchImpl = () => Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ error: 'refused', message: 'Not owner decidable' }),
    });
    renderOwnerActions(container, ownerItem(), { fetchImpl, token: BOARD_HDR, signedIn: true, doc });
    doc.nodes.find((n) => n.textContent === 'Deny').click();
    doc.nodes.find((n) => n.textContent === 'Confirm deny?').click();
    await flushAsync();
    assert.equal(statusText(container), 'Not owner decidable');
  });

  it('disables buttons while a request is in flight', async () => {
    const doc = makeDoc();
    const container = doc.createElement('div');
    let resolvePrepare;
    const fetchImpl = (url) => {
      if (url.endsWith('/prepare')) {
        return new Promise((resolve) => { resolvePrepare = () => resolve({ ok: true, json: () => Promise.resolve({ confirmToken: 'x' }) }); });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ result: 'ok' }) });
    };
    renderOwnerActions(container, ownerItem(), { fetchImpl, token: BOARD_HDR, signedIn: true, doc });
    doc.nodes.find((n) => n.textContent === 'Approve').click();
    doc.nodes.find((n) => n.textContent === 'Confirm approve?').click();
    await flushAsync();
    const buttons = container.querySelectorAll('button');
    assert.ok(buttons.some((b) => b.disabled));
    resolvePrepare();
    await flushAsync();
  });
});
