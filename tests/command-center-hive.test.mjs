// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHiveStatStrip } from '../tools/watch-assets/hive-stat-strip.js';
import {
  assignHiveSideSlots,
  HIVE_LANES,
  HIVE_LANE_CSS_VAR,
  renderHiveLegend,
  renderHiveProjectNodes,
} from '../tools/watch-assets/hive-layout.js';

const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const hivePanelsPath = path.join(assets, 'hive-panels.js');

const NOW = Date.UTC(2026, 9, 26, 20, 45, 0);

/** One shared Hive view model: stat strip, ring nodes, and dock panels stay in sync. */
const HIVE_FIXTURE = {
  statEntries: [
    { label: 'repos', value: '3', source: 'hive.repos' },
    { label: 'ring', value: '1', source: 'hive.ringCount' },
    { label: 'forks', value: '128', source: 'hive.forksTotal', tone: 'bad' },
    { label: 'held', value: '2', source: 'hive.heldForYou', tone: 'warn' },
  ],
  projects: [
    {
      id: 'hive-alpha',
      name: 'Alpha',
      lane: 'safety',
      percentDone: { value: '42', source: 'project.alpha.percentDone' },
      asks: { value: '1', source: 'project.alpha.asks' },
      out: { value: '0', source: 'project.alpha.out' },
      fails: { value: '0', source: 'project.alpha.fails' },
    },
    {
      id: 'hive-beta',
      name: 'Beta',
      lane: 'route',
      percentDone: { value: '71', source: 'project.beta.percentDone' },
      asks: { value: '2', source: 'project.beta.asks' },
    },
    {
      id: 'hive-gamma',
      name: 'Gamma',
      lane: 'context',
      needsYou: { value: '1', source: 'project.gamma.needsYou' },
      meter: { value: 55, label: 'done', source: 'project.gamma.meter' },
    },
  ],
  panels: {
    journalEvents: [
      {
        kind: 'human',
        id: 'j-human-1',
        title: 'Review hive integration fixture',
        ts: new Date(NOW - 90_000).toISOString(),
      },
      {
        kind: 'blocker',
        id: 'j-block-1',
        text: 'Lane pool saturated on cursor',
        ts: new Date(NOW - 45_000).toISOString(),
      },
    ],
    laneCounts: { cursor: 6, codex: 2 },
    savingsRows: [
      { label: 'llm wakes skipped', value: 16, max: 40, title: 'savings.llmWakesSkipped' },
      { label: 'stale context dropped', value: 44, unit: 'pct', title: 'savings.staleContextDroppedPct' },
    ],
    savingsMax: 40,
    throughputSamples: [2, 5, 3, 8],
    throughputChartLabel: 'Hive throughput (fixture)',
  },
};

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c),
    toString: () => [...set].join(' '),
  };
}

function walkTree(node, fn) {
  if (!node) return;
  fn(node);
  for (const c of node.children || []) walkTree(c, fn);
}

function makeElement(tag) {
  const classList = makeClassList();
  const node = {
    tagName: String(tag).toUpperCase(),
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
    textContent: '',
    parentNode: null,
    firstChild: null,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      this.firstChild = this.children[0] || null;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) {
        this.children.splice(i, 1);
        this.childNodes = this.children.slice();
        child.parentNode = null;
        this.firstChild = this.children[0] || null;
      }
      return child;
    },
    querySelector(sel) {
      let found = null;
      walkTree(this, n => {
        if (found) return;
        if (sel === '.cc-stat' && n.classList?.contains('cc-stat')) found = n;
        if (sel === '.lane-bars' && n.classList?.contains('lane-bars')) found = n;
        if (sel === '.savings-rows' && n.classList?.contains('savings-rows')) found = n;
        if (sel === '.event-time' && n.classList?.contains('event-time')) found = n;
      });
      return found;
    },
    querySelectorAll(sel) {
      const out = [];
      walkTree(this, n => {
        if (sel === '.cc-stat' && n.classList?.contains('cc-stat')) out.push(n);
        if (sel === '.hive-node' && n.classList?.contains('hive-node')) out.push(n);
        if (sel === '.lane-row' && n.classList?.contains('lane-row')) out.push(n);
        if (sel === '.lane-fill' && n.classList?.contains('lane-fill')) out.push(n);
        if (sel === '.saving-row' && n.classList?.contains('saving-row')) out.push(n);
        if (sel === '.fill' && n.classList?.contains('fill')) out.push(n);
        if (sel === 'li' && n.tagName === 'LI') out.push(n);
        if (sel === '.event-tag' && n.classList?.contains('event-tag')) out.push(n);
      });
      return out;
    },
    getContext() {
      return {
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fill() {},
        arc() {},
      };
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
    createElement(tag) {
      return makeElement(tag);
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: text };
    },
  };
  globalThis.document = document;
}

async function loadHivePanels() {
  installDom();
  const src = await fs.readFile(hivePanelsPath, 'utf8');
  const box = {
    module: { exports: {} },
    exports: {},
    document: globalThis.document,
    self: globalThis,
    globalThis,
  };
  vm.runInNewContext(src, box, { filename: hivePanelsPath });
  const out = box.module.exports;
  if (out && typeof out.renderHivePanels === 'function') return out;
  return box.HivePanels || box.self?.HivePanels;
}

function statFigure(statEl) {
  const lbl = (statEl.children || []).find(c => c.classList?.contains('lbl'));
  const val = (statEl.children || []).find(c => c.classList?.contains('val'));
  return {
    label: lbl ? lbl.textContent : '',
    value: val ? val.textContent : '',
    title: val ? val.getAttribute('title') : null,
    valClass: val ? val.className : '',
  };
}

function collectText(node) {
  if (!node) return '';
  if (node.textContent) return node.textContent;
  let s = '';
  for (const c of node.children || []) s += collectText(c);
  if (node.nodeType === 3) s += node.textContent || '';
  return s;
}

function normalizeLane(lane) {
  if (typeof lane === 'string' && HIVE_LANES.includes(lane)) return lane;
  return 'control';
}

test('Hive view renders stat strip, nodes, legend, and panels from one shared fixture', async () => {
  installDom();
  const HivePanels = await loadHivePanels();
  const { renderHivePanels, journalEntrySentence, laneRowsFromCounts } = HivePanels;

  const strip = makeElement('div');
  strip.className = 'hive-stat-strip';
  renderHiveStatStrip(strip, HIVE_FIXTURE.statEntries);

  const stats = strip.querySelectorAll('.cc-stat');
  assert.equal(stats.length, HIVE_FIXTURE.statEntries.length);
  for (let i = 0; i < HIVE_FIXTURE.statEntries.length; i += 1) {
    const want = HIVE_FIXTURE.statEntries[i];
    const got = statFigure(stats[i]);
    assert.equal(got.label, want.label, `stat[${i}].label`);
    assert.equal(got.value, want.value, `stat[${i}].value`);
    assert.equal(got.title, want.source, `stat[${i}].source title`);
    if (want.tone) assert.ok(got.valClass.includes(want.tone), `stat[${i}].tone`);
  }
  const reposStat = statFigure(stats[0]);
  assert.equal(reposStat.value, String(HIVE_FIXTURE.projects.length), 'repos stat matches project count');

  const nodesMount = makeElement('div');
  nodesMount.id = 'hive-nodes';
  const placed = assignHiveSideSlots(HIVE_FIXTURE.projects);
  const nodeRefs = renderHiveProjectNodes(nodesMount, HIVE_FIXTURE.projects);
  assert.equal(nodeRefs.length, HIVE_FIXTURE.projects.length);
  const cards = nodesMount.querySelectorAll('.hive-node');
  assert.equal(cards.length, HIVE_FIXTURE.projects.length);

  for (let i = 0; i < HIVE_FIXTURE.projects.length; i += 1) {
    const raw = HIVE_FIXTURE.projects[i];
    const slot = placed[i];
    const { project, el } = nodeRefs[i];
    assert.equal(project.side, slot.side, `project[${i}].side from assignHiveSideSlots`);
    assert.equal(project.slot, slot.slot, `project[${i}].slot from assignHiveSideSlots`);
    assert.equal(el.dataset.side, slot.side);
    assert.equal(el.dataset.slot, String(slot.slot));
    const lane = normalizeLane(raw.lane);
    assert.ok(el.classList.contains('hive-node'));
    assert.ok(el.classList.contains(lane), `card[${i}] lane class`);
    assert.equal(el.getAttribute('aria-label'), `Project ${raw.name}`);
    const nameEl = (el.children || []).find(c => c.classList?.contains('hive-node-hd'))
      ?.children?.find(c => c.classList?.contains('name'));
    assert.equal(nameEl?.textContent, raw.name);
  }

  const legend = makeElement('div');
  renderHiveLegend(legend);
  assert.equal(legend.className, 'cc-legend hive-legend');
  assert.equal(legend.getAttribute('aria-label'), 'Node lane colours');
  const legendRows = legend.children;
  assert.equal(legendRows.length, HIVE_LANES.length);
  for (let i = 0; i < HIVE_LANES.length; i += 1) {
    const lane = HIVE_LANES[i];
    const row = legendRows[i];
    const swatch = row.children[0];
    assert.equal(swatch.style.background, `var(${HIVE_LANE_CSS_VAR[lane]})`);
    const labelText = row.children[1]?.textContent ?? collectText(row);
    assert.equal(labelText, lane);
  }

  const eventLog = makeElement('ul');
  const lanesPanel = makeElement('section');
  const savingsPanel = makeElement('section');
  renderHivePanels(
    { eventLog, lanes: lanesPanel, savings: savingsPanel },
    HIVE_FIXTURE.panels,
    { nowMs: NOW },
  );

  const logText = collectText(eventLog);
  for (const ev of HIVE_FIXTURE.panels.journalEvents) {
    assert.match(logText, new RegExp(journalEntrySentence(ev).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(logText, /placeholder/i);
  assert.equal(eventLog.querySelectorAll('li').length, HIVE_FIXTURE.panels.journalEvents.length);

  const laneRows = laneRowsFromCounts(HIVE_FIXTURE.panels.laneCounts);
  const laneDomRows = lanesPanel.querySelectorAll('.lane-row');
  assert.equal(laneDomRows.length, laneRows.length);
  for (let i = 0; i < laneRows.length; i += 1) {
    const want = laneRows[i];
    const rowEl = laneDomRows[i];
    const nameEl = (rowEl.children || []).find(c => c.classList?.contains('name'));
    const numEl = (rowEl.children || []).find(c => c.classList?.contains('num'));
    assert.equal(nameEl?.textContent, want.name);
    assert.equal(numEl?.textContent, String(want.count));
    const fill = rowEl.querySelectorAll('.lane-fill')[0];
    assert.equal(fill?.style.width, `${want.fillPct.toFixed(2)}%`);
  }

  const savingsText = collectText(savingsPanel);
  for (const row of HIVE_FIXTURE.panels.savingsRows) {
    assert.match(savingsText, new RegExp(row.label));
  }
  assert.match(savingsText, /16/);
  assert.match(savingsText, /44%/);
  const savingDomRows = savingsPanel.querySelectorAll('.saving-row');
  assert.equal(savingDomRows.length, HIVE_FIXTURE.panels.savingsRows.length);
  const fills = savingsPanel.querySelectorAll('.fill');
  assert.equal(fills.length, HIVE_FIXTURE.panels.savingsRows.length);
});
