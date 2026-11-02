// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const assetsDir = path.join(repo, 'tools', 'watch-assets');
const dataModulePath = path.join(assetsDir, 'command-center-data.js');
const uiModulePath = path.join(assetsDir, 'command-center.js');
const dataModuleSource = () => fs.readFileSync(dataModulePath, 'utf8');
const uiModuleSource = () => fs.readFileSync(uiModulePath, 'utf8');

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
    replaceChildren(...nodes) {
      for (const c of this.children) c.parentNode = null;
      this.children = nodes.slice();
      this.childNodes = this.children.slice();
      for (const c of this.children) c.parentNode = this;
    },
    querySelector(sel) {
      const walk = n => {
        if (!n) return null;
        if (sel.startsWith('[data-stat-key="') && sel.endsWith('"]')) {
          const want = sel.slice('[data-stat-key="'.length, -2);
          if (n.getAttribute && n.getAttribute('data-stat-key') === want) return n;
        }
        if (sel === '.command-center-stat-value' && n.classList && n.classList.contains('command-center-stat-value')) {
          return n;
        }
        if (sel === '.command-center-stat-unit' && n.classList && n.classList.contains('command-center-stat-unit')) {
          return n;
        }
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
        if (sel === '.command-center-stat' && n.classList && n.classList.contains('command-center-stat')) {
          out.push(n);
        }
        if (sel === '.command-center-stat-value' && n.classList && n.classList.contains('command-center-stat-value')) {
          out.push(n);
        }
        if (sel === '.command-center-stat-unit' && n.classList && n.classList.contains('command-center-stat-unit')) {
          out.push(n);
        }
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

function makeDocument() {
  return {
    createElement: tag => makeElement(tag),
    body: makeElement('body'),
  };
}

function loadCommandCenterData() {
  const box = { self: {} };
  vm.runInNewContext(dataModuleSource(), box);
  return box.self.CommandCenterData;
}

function loadCommandCenterUi(document) {
  const win = { document };
  const box = {
    self: win,
    document,
    globalThis: win,
    module: { exports: {} },
    exports: {},
  };
  box.module.exports = box.exports;
  vm.runInNewContext(uiModuleSource(), box);
  return box.self.CommandCenter || box.module.exports;
}

function labelled(over) {
  return Object.assign({
    label: 'Projects',
    value: 3,
    unit: 'count',
    source: 'board.projects.length',
    explanation: 'Registered projects on this board.',
  }, over || {});
}

function snapshotBody(over) {
  return Object.assign({
    at: '2026-10-26T12:00:00.000Z',
    stats: {},
    projects: [],
  }, over || {});
}

function collectText(node) {
  if (!node) return '';
  if (node.textContent) return node.textContent;
  return (node.children || []).map(collectText).join('');
}

function statRow(host, key) {
  const shell = host.children[0];
  assert.ok(shell, 'command center shell');
  const walk = n => {
    if (!n) return null;
    if (n.getAttribute && n.getAttribute('data-stat-key') === key) return n;
    for (const c of n.children || []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(shell);
}

function assertStatRendered(host, stat) {
  const row = statRow(host, stat.key);
  assert.ok(row, 'stat row for ' + stat.key);
  const valueEl = row.querySelector('.command-center-stat-value');
  const unitEl = row.querySelector('.command-center-stat-unit');
  assert.equal(valueEl.textContent, String(stat.value), stat.key + ' value');
  assert.equal(unitEl.textContent, stat.unit, stat.key + ' unit');
}

test('renderCommandCenter reflects fixture stat values and units', () => {
  const dataMod = loadCommandCenterData();
  const document = makeDocument();
  const ui = loadCommandCenterUi(document);
  const host = document.createElement('div');

  const fixtureA = {
    projectsTotal: { key: 'projectsTotal', value: 7, unit: 'count' },
    agentsLive: { key: 'agentsLive', value: 11, unit: 'count' },
    needsYouCount: { key: 'needsYouCount', value: 2, unit: 'count' },
    spendUsd: { key: 'spendUsd', value: 19.75, unit: 'usd' },
  };

  const bodyA = snapshotBody({
    stats: {
      projectsTotal: labelled({ label: 'Projects', value: fixtureA.projectsTotal.value, source: 'a.projects' }),
      agentsLive: labelled({ label: 'Agents live', value: fixtureA.agentsLive.value, source: 'a.agents' }),
      needsYouCount: labelled({ label: 'Needs you', value: fixtureA.needsYouCount.value, source: 'a.inbox' }),
      spendUsd: labelled({
        label: 'Spend',
        value: fixtureA.spendUsd.value,
        unit: 'usd',
        source: 'a.spend.usd',
      }),
    },
    projects: [{ id: 'p-a', name: 'Alpha' }],
  });

  const snapshotA = dataMod.parseCommandCenterSnapshot(bodyA);
  ui.renderCommandCenter(host, snapshotA);
  for (const stat of Object.values(fixtureA)) {
    assertStatRendered(host, stat);
  }
  const textA = collectText(host);
  assert.match(textA, new RegExp(String(fixtureA.spendUsd.value)));
  assert.match(textA, /usd/);

  const fixtureB = {
    projectsTotal: { key: 'projectsTotal', value: 4, unit: 'count' },
    agentsLive: { key: 'agentsLive', value: 0, unit: 'count' },
    needsYouCount: { key: 'needsYouCount', value: 9, unit: 'count' },
    spendUsd: { key: 'spendUsd', value: 3.5, unit: 'usd' },
  };

  const bodyB = snapshotBody({
    at: '2026-10-27T08:15:00.000Z',
    stats: {
      projectsTotal: labelled({ label: 'Projects', value: fixtureB.projectsTotal.value, source: 'b.projects' }),
      agentsLive: labelled({ label: 'Agents live', value: fixtureB.agentsLive.value, source: 'b.agents' }),
      needsYouCount: labelled({ label: 'Needs you', value: fixtureB.needsYouCount.value, source: 'b.inbox' }),
      spendUsd: labelled({
        label: 'Spend',
        value: fixtureB.spendUsd.value,
        unit: 'usd',
        source: 'b.spend.usd',
      }),
    },
    projects: [{ id: 'p-b', name: 'Beta' }],
  });

  const snapshotB = dataMod.parseCommandCenterSnapshot(bodyB);
  const hostB = document.createElement('div');
  ui.renderCommandCenter(hostB, snapshotB);
  for (const stat of Object.values(fixtureB)) {
    assertStatRendered(hostB, stat);
  }
  const rowBProjects = statRow(hostB, 'projectsTotal');
  const rowBAgents = statRow(hostB, 'agentsLive');
  assert.equal(rowBProjects.querySelector('.command-center-stat-value').textContent, String(fixtureB.projectsTotal.value));
  assert.equal(rowBAgents.querySelector('.command-center-stat-value').textContent, String(fixtureB.agentsLive.value));
  assert.notEqual(
    rowBProjects.querySelector('.command-center-stat-value').textContent,
    String(fixtureA.projectsTotal.value),
  );
  assert.notEqual(
    rowBAgents.querySelector('.command-center-stat-value').textContent,
    String(fixtureA.agentsLive.value),
  );
});

test('renderCommandCenter is idempotent when called twice on the same host', () => {
  const dataMod = loadCommandCenterData();
  const document = makeDocument();
  const ui = loadCommandCenterUi(document);
  const host = document.createElement('div');

  const body = snapshotBody({
    stats: {
      projectsTotal: labelled({ label: 'Projects', value: 1, source: 'x.projects' }),
      agentsLive: labelled({ label: 'Agents live', value: 2, source: 'x.agents' }),
      needsYouCount: labelled({ label: 'Needs you', value: 3, source: 'x.inbox' }),
      spendUsd: labelled({ label: 'Spend', value: 6, unit: 'usd', source: 'x.spend' }),
    },
    projects: [{ id: 'p1', name: null }],
  });
  const snapshot = dataMod.parseCommandCenterSnapshot(body);

  ui.renderCommandCenter(host, snapshot);
  const firstShell = host.children[0];
  assert.ok(firstShell);
  assert.equal(firstShell.getAttribute('data-command-center-shell'), 'true');
  assert.equal(host.querySelectorAll('.command-center-stat').length, 4);

  ui.renderCommandCenter(host, snapshot);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].getAttribute('data-command-center-shell'), 'true');
  assert.equal(host.querySelectorAll('.command-center-stat').length, 4);
  assertStatRendered(host, { key: 'needsYouCount', value: 3, unit: 'count' });
});
