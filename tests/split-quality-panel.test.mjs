// SPDX-License-Identifier: Apache-2.0
// Node tests for tools/watch-assets/split-quality-panel.js (no network).
// Real-browser render verification ships with the board mount ticket and the browser smoke test.

import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const panelPath = path.join(repo, 'tools', 'watch-assets', 'split-quality-panel.js');
const require = createRequire(import.meta.url);
const requirePanel = createRequire(panelPath);
let panelExports;
try {
  panelExports = requirePanel('./split-quality-panel.js');
} catch {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const panelModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(panelPath, 'utf8'), {
    module: panelModule,
    exports: panelModule.exports,
    self: globalThis,
  }, { filename: panelPath });
  panelExports = panelModule.exports;
}
const {
  METRIC_ORDER,
  collectMetrics,
  render,
  renderSplitQuality,
} = panelExports;

const EXPECTED_LABELS = [
  'Overhead ratio',
  'First-try pass rate',
  'Critical path',
  'Wave fill',
  'Collisions',
  'Review $ per ticket',
  'Ticket sizes',
];

function makeElement(doc, tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    title: '',
    attributes: {},
    children: [],
    ownerDocument: doc,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
  return node;
}

function makeDocument() {
  const doc = {
    createElement(tag) {
      return makeElement(doc, tag);
    },
  };
  return doc;
}

function makeHost(doc) {
  const host = makeElement(doc, 'div');
  let text = '';
  Object.defineProperty(host, 'textContent', {
    enumerable: true,
    get() {
      return text;
    },
    set(value) {
      text = value == null ? '' : String(value);
      host.children = [];
    },
  });
  return host;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) {
    walk(child, visit);
  }
}

function findAll(node, predicate) {
  const out = [];
  walk(node, (n) => {
    if (predicate(n)) { out.push(n); }
  });
  return out;
}

function contractFieldsFixture(overrides = {}) {
  return {
    grade: 'amber',
    at: '2026-10-26T15:30:00.000Z',
    overheadRatio: 0.125,
    firstTryPassRate: 0.333,
    criticalPath: 5,
    waveFill: 0.5,
    collisions: 2,
    reviewUsdPerTicket: 12.5,
    ticketSizes: [100, 200],
    ...overrides,
  };
}

function gradedMetricsFixture(overrides = {}) {
  return {
    grade: 'amber',
    metrics: [
      { key: 'overhead', label: 'Overhead ratio', display: '12.5%', grade: 'green' },
      { key: 'firstTry', label: 'First-try pass rate', display: '33.3%', grade: 'amber' },
      { key: 'criticalPath', label: 'Critical path', display: '5', grade: 'red' },
      { key: 'waveFill', label: 'Wave fill', display: '50%', grade: 'green' },
      { key: 'collisions', label: 'Collisions', display: '2', grade: 'amber' },
      { key: 'reviewCost', label: 'Review $ per ticket', display: '$12.50', grade: 'red' },
      { key: 'sizes', label: 'Ticket sizes', display: '100, 200', grade: 'unknown' },
    ],
    ...overrides,
  };
}

test('METRIC_ORDER lists seven contract keys in display order', () => {
  assert.deepEqual([...METRIC_ORDER], [
    'overhead',
    'firstTry',
    'criticalPath',
    'waveFill',
    'collisions',
    'reviewCost',
    'sizes',
  ]);
});

test('render(null host) does nothing', () => {
  const doc = makeDocument();
  const host = makeHost(doc);
  render(null, contractFieldsFixture(), { document: doc });
  assert.equal(host.children.length, 0);
});

test('render shows Split quality unavailable for null or empty split quality', () => {
  const doc = makeDocument();
  for (const splitQuality of [null, undefined, { metrics: [null] }]) {
    const host = makeHost(doc);
    render(host, splitQuality, { document: doc });
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0].className, 'board-empty');
    assert.equal(host.children[0].textContent, 'Split quality unavailable.');
  }
});

test('render builds overall header and seven metric rows in METRIC_ORDER', () => {
  const doc = makeDocument();
  const host = makeHost(doc);
  const splitQuality = gradedMetricsFixture({
    at: '2026-10-26T15:30:00.000Z',
    metrics: gradedMetricsFixture().metrics.map((m, i) => (
      i === 0 ? { ...m, note: 'Overhead note for title' } : m
    )),
  });
  render(host, splitQuality, { document: doc });

  const header = host.children[0];
  assert.equal(header.className, 'row');
  const headerNames = findAll(header, (n) => n.className === 'name');
  assert.equal(headerNames[0].textContent, 'Overall');
  const pill = findAll(header, (n) => n.className === 'pill warn')[0];
  assert.ok(pill, 'overall amber pill');
  assert.equal(pill.textContent, 'amber');
  const mono = findAll(header, (n) => n.className === 'mono')[0];
  assert.equal(mono.textContent, '2026-10-26 15:30');

  const rows = host.children.filter((c) => c.className === 'board-entry');
  assert.equal(rows.length, 7);
  const labels = rows.map((row) => {
    const name = findAll(row, (n) => n.className === 'name')[0];
    return name.textContent;
  });
  assert.deepEqual(labels, EXPECTED_LABELS);
  assert.deepEqual(collectMetrics(splitQuality).map((m) => m.key), [
    'overhead',
    'firstTry',
    'criticalPath',
    'waveFill',
    'collisions',
    'reviewCost',
    'sizes',
  ]);

  const overheadRow = rows[0];
  assert.equal(overheadRow.title, 'Overhead note for title');
});

test('render maps contract fields to row labels and values', () => {
  const doc = makeDocument();
  const host = makeHost(doc);
  render(host, contractFieldsFixture(), { document: doc });
  const rows = host.children.filter((c) => c.className === 'board-entry');
  assert.equal(rows.length, 7);
  const labels = rows.map((row) => findAll(row, (n) => n.className === 'name')[0].textContent);
  const displays = rows.map((row) => findAll(row, (n) => n.className === 'mono')[0].textContent);
  assert.deepEqual(labels, EXPECTED_LABELS);
  assert.deepEqual(displays, ['12.5%', '33.3%', '5', '50%', '2', '$12.50', '100, 200']);
});

test('render applies dot and pill grade classes for green, amber, red, and unknown', () => {
  const doc = makeDocument();
  const host = makeHost(doc);
  render(host, gradedMetricsFixture(), { document: doc });

  const rows = host.children.filter((c) => c.className === 'board-entry');
  const dotClasses = rows.map((row) => findAll(row, (n) => n.className.startsWith('dot '))[0].className);
  assert.deepEqual(dotClasses, [
    'dot grade-green',
    'dot grade-amber',
    'dot grade-red',
    'dot grade-green',
    'dot grade-amber',
    'dot grade-red',
    'dot grade-unknown',
  ]);

  const headerPill = findAll(host.children[0], (n) => n.className.startsWith('pill '))[0];
  assert.equal(headerPill.className, 'pill warn');

  render(host, gradedMetricsFixture({ grade: 'green' }), { document: doc });
  const greenPill = findAll(host.children[0], (n) => n.className.startsWith('pill '))[0];
  assert.equal(greenPill.className, 'pill good');

  render(host, gradedMetricsFixture({ grade: 'red' }), { document: doc });
  const redPill = findAll(host.children[0], (n) => n.className.startsWith('pill '))[0];
  assert.equal(redPill.className, 'pill bad');

  render(host, gradedMetricsFixture({ grade: 'mystery' }), { document: doc });
  const unknownPill = findAll(host.children[0], (n) => n.className.startsWith('pill '))[0];
  assert.equal(unknownPill.className, 'pill info');
});

test('collectMetrics maps contract fields to display strings', () => {
  const metrics = collectMetrics(contractFieldsFixture());
  assert.equal(metrics.length, 7);
  for (let i = 0; i < METRIC_ORDER.length; i += 1) {
    assert.equal(metrics[i].key, METRIC_ORDER[i]);
  }
  const displays = ['12.5%', '33.3%', '5', '50%', '2', '$12.50', '100, 200'];
  for (let i = 0; i < EXPECTED_LABELS.length; i += 1) {
    assert.equal(metrics[i].label, EXPECTED_LABELS[i]);
    assert.equal(metrics[i].display, displays[i]);
  }
});

test('collectMetrics preserves grades from an explicit metrics list', () => {
  const metrics = collectMetrics(gradedMetricsFixture());
  assert.deepEqual(metrics.map((m) => m.grade), [
    'green',
    'amber',
    'red',
    'green',
    'amber',
    'red',
    'unknown',
  ]);
});

test('renderSplitQuality is an alias for render', () => {
  assert.equal(renderSplitQuality, render);
});
