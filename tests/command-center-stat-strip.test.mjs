// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHiveStatStrip } from '../tools/watch-assets/hive-stat-strip.js';

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
    querySelectorAll(sel) {
      const out = [];
      const walk = n => {
        if (!n) return;
        if (sel === '.cc-stat' && n.classList && n.classList.contains('cc-stat')) out.push(n);
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

function installDom() {
  const document = {
    createElement: tag => makeElement(tag),
  };
  globalThis.document = document;
  return document;
}

function statFigure(statEl) {
  const lbl = (statEl.children || []).find(c => c.classList && c.classList.contains('lbl'));
  const val = (statEl.children || []).find(c => c.classList && c.classList.contains('val'));
  return {
    label: lbl ? lbl.textContent : '',
    value: val ? val.textContent : '',
    title: val ? val.getAttribute('title') : null,
    valClass: val ? val.className : '',
  };
}

test('renderHiveStatStrip renders four figures with label, value, and source title', () => {
  installDom();
  const strip = makeElement('div');
  strip.className = 'hive-stat-strip';

  const entries = [
    { label: 'repos', value: '10', source: 'hive.repos' },
    { label: 'ring', value: '1', source: 'hive.ringCount' },
    { label: 'forks', value: '4,485', source: 'hive.forksTotal', tone: 'bad' },
    { label: 'held', value: '11', source: 'hive.heldForYou', tone: 'warn' },
  ];

  renderHiveStatStrip(strip, entries);

  const stats = strip.querySelectorAll('.cc-stat');
  assert.equal(stats.length, 4);

  for (let i = 0; i < entries.length; i += 1) {
    const want = entries[i];
    const got = statFigure(stats[i]);
    assert.equal(got.label, want.label, `stat[${i}].label`);
    assert.equal(got.value, want.value, `stat[${i}].value`);
    assert.equal(got.title, want.source, `stat[${i}].title`);
    assert.ok(got.valClass.includes('num'), `stat[${i}] uses .num`);
    if (want.tone) assert.ok(got.valClass.includes(want.tone), `stat[${i}].tone`);
  }
});

test('figures without a trusted source are omitted', () => {
  installDom();
  const strip = makeElement('div');

  renderHiveStatStrip(strip, [
    { label: 'repos', value: 10, source: 'hive.repos' },
    { label: 'ghost', value: 99, source: '' },
    { label: 'missing', value: 1 },
    { label: 'held', value: 11, source: 'hive.heldForYou' },
  ]);

  const stats = strip.querySelectorAll('.cc-stat');
  assert.equal(stats.length, 2);
  assert.equal(statFigure(stats[0]).label, 'repos');
  assert.equal(statFigure(stats[0]).title, 'hive.repos');
  assert.equal(statFigure(stats[1]).label, 'held');
  assert.equal(statFigure(stats[1]).title, 'hive.heldForYou');
});

test('re-render replaces prior cc-stat nodes and preserves other strip children', () => {
  installDom();
  const strip = makeElement('div');
  const live = makeElement('div');
  live.className = 'cc-live';
  strip.appendChild(live);

  renderHiveStatStrip(strip, [{ label: 'repos', value: '1', source: 'hive.repos' }]);
  assert.equal(strip.querySelectorAll('.cc-stat').length, 1);

  renderHiveStatStrip(strip, [
    { label: 'ring', value: '2', source: 'hive.ringCount' },
    { label: 'forks', value: '3', source: 'hive.forksTotal' },
  ]);

  assert.equal(strip.querySelectorAll('.cc-stat').length, 2);
  assert.equal(strip.children.filter(c => c.classList.contains('cc-live')).length, 1);
  assert.equal(statFigure(strip.querySelectorAll('.cc-stat')[0]).label, 'ring');
});
