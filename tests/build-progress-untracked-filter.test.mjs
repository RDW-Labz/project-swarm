// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildProgress, offLedgerRunHref, OFF_LEDGER_LIST_ANCHOR_ID } from '../tools/build-progress.mjs';
import { projectDetail } from '../tools/board-data.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';

const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'build-progress-filter-')));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), JSON.stringify({
    version: 1,
    scope: { file: 'missing-scope.md', name: 'Filter fixture' },
    tickets: [],
    approved: { at: new Date(NOW - 1000).toISOString() },
  }));
  await fs.writeFile(path.join(root, 'history.ndjson'), '');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function run(root, id, state) {
  const dir = path.join(root, '.swarm', 'runs', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id, status: 'complete', startedAt: new Date(NOW - 1000).toISOString(), ...state }));
}

test('off-ledger counts exclude smoke, probe, lane tests, and non-integrating runs', async t => {
  const root = await fixture(t);
  const job = id => ({ id, status: 'complete' });
  await run(root, 'smoke-run', { manifestFile: 'smoke.mjs', jobs: [job('smoke-job')] });
  await run(root, 'probe-run', { jobs: [job('probe-job')] });
  await run(root, 'lane-test-run', { jobs: [job('lane-test-job')] });
  await run(root, 'lane-bench-run', { jobs: [job('lane-bench-job')] });
  await run(root, 'doctor-run', { jobs: [job('doctor-job')] });
  await run(root, 'non-integrating', { nonIntegrating: true, jobs: [job('real-job')] });
  await run(root, 'manifest-run', { manifest: 'release.json', jobs: [job('real-job')] });

  const progress = await buildProgress({ root, projectId: 'filter-fixture', now: NOW, historyFile: path.join(root, 'history.ndjson') });
  assert.deepEqual(progress.untracked.runs.map(item => item.runId), ['manifest-run']);
  assert.equal(progress.untracked.jobs, 1);
  assert.deepEqual(progress.untracked.newest, [{ runId: 'manifest-run', name: 'manifest-run', startedAt: new Date(NOW - 1000).toISOString(), status: 'complete' }]);
  assert.equal(progress.untracked.listAnchorId, OFF_LEDGER_LIST_ANCHOR_ID);
  assert.equal(progress.untracked.countHref, `#${OFF_LEDGER_LIST_ANCHOR_ID}`);
  const manifest = progress.untracked.runs.find(item => item.runId === 'manifest-run');
  assert.ok(manifest);
  assert.equal(manifest.href, offLedgerRunHref('filter-fixture', 'manifest-run'));
  for (const excluded of ['smoke-run', 'probe-run', 'lane-test-run', 'lane-bench-run', 'doctor-run', 'non-integrating']) {
    assert.equal(progress.untracked.runs.some(item => item.runId === excluded), false);
  }
});

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    contains: c => set.has(c),
    toString: () => [...set].join(' '),
  };
}

function makeElement(tag, cls) {
  const classList = makeClassList();
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    className: cls || '',
    classList,
    children: [],
    childNodes: [],
    style: {},
    href: '',
    textContent: '',
    title: '',
    parentNode: null,
    setAttribute() {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    appendChild(child) {
      this.children.push(child);
      this.childNodes = this.children.slice();
      child.parentNode = this;
      return child;
    },
    querySelector(sel) {
      const walk = n => {
        if (!n) return null;
        if (sel === 'a.watch-card-fact-link' && n.tagName === 'A' && n.classList.contains('watch-card-fact-link')) return n;
        for (const c of n.children || []) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return classList.toString(); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

async function loadBoardLib() {
  const doc = makeElement('body');
  doc.createElement = tag => makeElement(tag);
  const win = {
    document: doc,
    location: { search: '', pathname: '/', hash: '' },
    navigator: { clipboard: { writeText: async () => {} } },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    history: { replaceState: () => {} },
  };
  const libSrc = await fs.readFile(path.join(assets, 'board-lib.js'), 'utf8');
  const box = { self: win, document: doc };
  vm.runInNewContext(libSrc, box);
  return box.self.BoardLib;
}

test('project page links the untracked runs count to the untracked list', async t => {
  const recent = new Date(NOW - 1000).toISOString();
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    runs: [{ id: 'manifest-run', status: 'complete', startedAt: recent, manifest: 'release.json', jobs: [{ id: 'off-ledger-job', status: 'complete' }] }],
  });
  t.after(fixture.cleanup);
  const detail = await projectDetail(fixture.projects[0], {
    now: NOW,
    liveRunIds: new Set(),
    env: fixture.env,
    summary: async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false }),
    extraRoots: fixture.projects.map(p => p.root),
  });
  assert.ok(detail.card?.facts?.untrackedRuns > 0, 'fixture should surface untracked runs on the card');
  const listHrefOracle = `#${OFF_LEDGER_LIST_ANCHOR_ID}`;
  assert.equal(detail.card.facts.listHref, listHrefOracle);
  const BoardLib = await loadBoardLib();
  const host = makeElement('div');
  BoardLib.renderWatchProjectCard(detail, host, { pageMode: true });
  const link = host.querySelector('a.watch-card-fact-link');
  assert.ok(link, 'untracked runs count should be a link on the project page card');
  assert.equal(link.href, listHrefOracle);
});
