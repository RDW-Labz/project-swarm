// SPDX-License-Identifier: Apache-2.0
// Overlap proof uses resolved percentage layout math (hive-layout.js), not jsdom
// getBoundingClientRect — fake DOM cannot lay out vh-centered ring or % heights faithfully.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderHiveLayout,
  renderHiveLegend,
  renderHiveProjectNodes,
  assignHiveSideSlots,
  hiveCardBoxPct,
  HIVE_LANE_CSS_VAR,
  HIVE_LANES,
  CARD_HEIGHT_PCT,
  HIVE_CARD_MIN_CONTENT_PX,
  assertHiveLayoutGeometry,
} from '../tools/watch-assets/hive-layout.js';

const VIEW_W = 1440;
const VIEW_H = 900;

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toString: () => [...set].join(' '),
  };
}

function collectTextContent(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  return (node.children || []).map(collectTextContent).join('');
}

function makeStyle() {
  const style = {};
  style.setProperty = (name, value) => {
    style[name] = value;
  };
  return style;
}

function makeElement(tag, id) {
  const classList = makeClassList();
  const node = {
    tagName: String(tag).toUpperCase(),
    id: id || '',
    classList,
    children: [],
    childNodes: [],
    style: makeStyle(),
    dataset: {},
    attributes: {},
    parentNode: null,
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
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      this.childNodes = this.children.slice();
      child.parentNode = null;
      return child;
    },
    querySelector(sel) {
      const walk = (n) => {
        if (!n) return null;
        if (sel === '.hive-legend' && n.classList && n.classList.contains('hive-legend')) return n;
        if (sel === '.hive-nodes' && n.classList && n.classList.contains('hive-nodes')) return n;
        if (sel === '#hive-nodes' && n.id === 'hive-nodes') return n;
        if (sel === '.hive-core-ui' && n.classList && n.classList.contains('hive-core-ui')) return n;
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
        if (sel === '.hive-node' && n.classList && n.classList.contains('hive-node')) out.push(n);
        if (sel === '.hive-kv dd' && n.tagName === 'DD') out.push(n);
        if (sel === '.hive-meter' && n.classList && n.classList.contains('hive-meter')) out.push(n);
        if (sel === '.hive-meter .fill' && n.tagName === 'I' && n.classList && n.classList.contains('fill')) {
          out.push(n);
        }
        for (const c of n.children || []) walk(c);
      };
      walk(this);
      return out;
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: VIEW_W, bottom: VIEW_H, width: VIEW_W, height: VIEW_H };
    },
  };
  Object.defineProperty(node, 'className', {
    get() {
      return classList.toString();
    },
    set(v) {
      classList.add(...String(v).split(/\s+/).filter(Boolean));
    },
  });
  Object.defineProperty(node, 'firstChild', {
    get() {
      return this.children[0] || null;
    },
  });
  Object.defineProperty(node, 'textContent', {
    get() {
      return collectTextContent(node);
    },
    set(v) {
      node.children = [];
      node.childNodes = [];
      if (v != null && String(v).length) {
        const t = { nodeType: 3, textContent: String(v) };
        node.children.push(t);
        node.childNodes.push(t);
      }
    },
  });
  return node;
}

function installDom() {
  const document = {
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
  };
  globalThis.document = document;
  return document;
}

function makeProject(i) {
  const lane = HIVE_LANES[i % 4];
  return {
    id: `p-${i + 1}`,
    name: `project-${i + 1}`,
    lane,
    percentDone: { value: `${10 + i}%`, source: `projects[${i}].progress.overall` },
    ticketsBuilding: { value: String(i), source: `projects[${i}].card.now.buildingTickets` },
    needsYou: { value: String(i % 3), source: `projects[${i}].card.blocked.needYou` },
    machine: { value: `host-${i}`, source: `projects[${i}].machine` },
    asks: { value: `asks-${i}`, source: `projects[${i}].hive.asks` },
    out: { value: `out-${i}`, source: `projects[${i}].hive.out` },
    fails: { value: `fails-${i}`, source: `projects[${i}].hive.fails` },
    meter: { value: 20 + i * 7, source: `projects[${i}].progress.overall`, label: 'done' },
  };
}

function buildStageFixture() {
  const stage = makeElement('section');
  stage.className = 'hive-stage';
  const core = makeElement('div');
  core.className = 'hive-core-ui';
  stage.appendChild(core);
  const nodes = makeElement('div', 'hive-nodes');
  nodes.className = 'hive-nodes';
  stage.appendChild(nodes);
  const legend = makeElement('div');
  legend.className = 'hive-legend';
  return { stage, nodes, legend };
}

test('renderHiveLayout renders 10 cards with 5 per side', () => {
  installDom();
  const { stage, nodes, legend } = buildStageFixture();
  const projects = Array.from({ length: 10 }, (_, i) => makeProject(i));

  renderHiveLayout(stage, projects, { nodesMount: nodes, legendEl: legend, stageEl: stage });

  const cards = nodes.querySelectorAll('.hive-node');
  assert.equal(cards.length, 10);

  const placed = assignHiveSideSlots(projects);
  const left = placed.filter((p) => p.side === 'left');
  const right = placed.filter((p) => p.side === 'right');
  assert.equal(left.length, 5);
  assert.equal(right.length, 5);

  for (const card of cards) {
    assert.equal(card.style.width, '21%');
    assert.ok(card.style.top.endsWith('%'));
    assert.ok(card.style.height === `${CARD_HEIGHT_PCT}%`);
  }
});

test('legend lane swatches use the same CSS variables as node lane headers', () => {
  installDom();
  const legend = makeElement('div');
  renderHiveLegend(legend);

  const chips = legend.children;
  assert.equal(chips.length, 4);

  for (let i = 0; i < HIVE_LANES.length; i += 1) {
    const lane = HIVE_LANES[i];
    const chip = chips[i];
    const swatch = chip.children[0];
    assert.ok(swatch, `legend swatch for ${lane}`);
    assert.equal(swatch.style.background, `var(${HIVE_LANE_CSS_VAR[lane]})`);
    assert.match(chip.textContent || '', new RegExp(lane));
  }

  const { nodes } = buildStageFixture();
  const projects = [makeProject(0), makeProject(1)];
  renderHiveProjectNodes(nodes, projects);
  for (const card of nodes.querySelectorAll('.hive-node')) {
    const laneClass = HIVE_LANES.find((lane) => card.classList.contains(lane));
    assert.ok(laneClass, 'card carries lane class for header colour');
    assert.equal(HIVE_LANE_CSS_VAR[laneClass], `--hive-${laneClass}`);
  }
});

test('each card has asks, out, and fails rows with source titles', () => {
  installDom();
  const { nodes } = buildStageFixture();
  const projects = Array.from({ length: 10 }, (_, i) => makeProject(i));
  renderHiveProjectNodes(nodes, projects);

  for (let i = 0; i < 10; i += 1) {
    const card = nodes.querySelectorAll('.hive-node')[i];
    const dts = (card.children.find((c) => c.classList.contains('hive-node-bd'))?.children
      .find((c) => c.classList.contains('hive-kv'))?.children || [])
      .filter((c) => c.tagName === 'DT');
    const labels = dts.map((dt) => dt.textContent);
    assert.deepEqual(labels, ['asks', 'out', 'fails']);

    const dds = card.querySelectorAll('.hive-kv dd');
    assert.equal(dds.length, 3);
    for (const dd of dds) {
      assert.ok(dd.getAttribute('title') && dd.getAttribute('title').length > 0, 'dd needs source title');
    }
  }
});

test('meter bars fit inside card bounds at 1440x900', () => {
  installDom();
  const stageHeight = VIEW_H;
  const cardHeightPx = (CARD_HEIGHT_PCT / 100) * stageHeight;
  assert.ok(cardHeightPx >= HIVE_CARD_MIN_CONTENT_PX, 'stage height yields enough card px for meter');

  const { nodes } = buildStageFixture();
  const projects = Array.from({ length: 10 }, (_, i) => makeProject(i));
  renderHiveProjectNodes(nodes, projects);

  for (const card of nodes.querySelectorAll('.hive-node')) {
    const meter = card.querySelectorAll('.hive-meter')[0];
    assert.ok(meter, 'card has meter');
    const fill = card.querySelectorAll('.hive-meter .fill')[0];
    assert.ok(fill, 'meter has fill');
    const width = parseFloat(fill.style.width);
    assert.ok(width >= 0 && width <= 100);
    const bd = card.children.find((c) => c.classList.contains('hive-node-bd'));
    assert.ok(bd, 'body wraps meter');
    assert.ok(bd.children.some((c) => c.classList.contains('hive-meter')), 'meter is last in body flex column');
  }
});

test('hive cards do not overlap each other or the central ring', () => {
  installDom();
  const projects = Array.from({ length: 10 }, (_, i) => makeProject(i));
  assertHiveLayoutGeometry(VIEW_W, VIEW_H, VIEW_H, projects);

  const placed = assignHiveSideSlots(projects);
  const boxes = placed.map((p) => hiveCardBoxPct(p.side, p.slot));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const separated = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      assert.ok(separated, `cards ${i} and ${j} must not overlap`);
    }
  }
});
