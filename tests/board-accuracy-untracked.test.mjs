// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardSnapshot, projectDetail, UNTRACKED_HEADLINE_MS } from '../tools/board-data.mjs';
import { collectProjectGcPlan, runGc } from '../tools/gc.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';

const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const OFF_LEDGER_LIST_ANCHOR_ID = 'untracked';
const NOW = Date.UTC(2026, 10, 21, 18, 0, 0);
const DAY = 86400000;
const iso = at => new Date(at).toISOString();
const summary = async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false });

async function snapshotFor(fixture) {
  const projects = fixture.projects.filter(p => p.id === fixture.projects[0].id);
  return boardSnapshot({
    projects,
    liveRuns: [],
    now: NOW,
    env: fixture.env,
    summary,
    historyFile: fixture.historyFile,
    prState: fixture.prState,
    worktreeRoot: async () => null,
  });
}

test('headline untracked count is 7-day real work; full list keeps older and noise runs', async t => {
  const recent = iso(NOW - 2 * DAY);
  const stale = iso(NOW - 20 * DAY);
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    runs: [
      { id: 'recent-real', status: 'complete', startedAt: recent, jobs: [{ id: 'off-ledger-recent', status: 'complete' }] },
      { id: 'stale-real', status: 'complete', startedAt: stale, jobs: [{ id: 'off-ledger-stale', status: 'complete' }] },
      { id: 'recent-smoke', status: 'complete', startedAt: recent, manifestFile: 'smoke.mjs', jobs: [{ id: 'smoke-job', status: 'complete' }] },
      { id: 'recent-probe', status: 'complete', startedAt: recent, jobs: [{ id: 'probe-job', status: 'complete' }] },
      { id: 'recent-bench', status: 'complete', startedAt: recent, jobs: [{ id: 'lane-bench-job', status: 'complete' }] },
    ],
  });
  t.after(fixture.cleanup);

  const snapshot = await snapshotFor(fixture);
  const facts = snapshot.projects[0].card.facts;
  assert.equal(facts.untrackedRuns, 1, 'only the recent real off-ledger run counts on the card');
  assert.equal(facts.listHref, `#${OFF_LEDGER_LIST_ANCHOR_ID}`);

  const detail = await projectDetail(fixture.projects[0], {
    now: NOW,
    liveRunIds: new Set(),
    env: fixture.env,
    summary,
    extraRoots: fixture.projects.map(p => p.root),
  });
  const fullIds = detail.untracked.runs.map(run => run.runId).sort();
  assert.deepEqual(fullIds, ['recent-bench', 'recent-probe', 'recent-real', 'recent-smoke', 'stale-real']);
  assert.equal(detail.untracked.count, 5);
  assert.equal(UNTRACKED_HEADLINE_MS, 7 * DAY);
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
  const node = {
    tagName: String(tag).toUpperCase(),
    classList,
    children: [],
    childNodes: [],
    style: {},
    href: '',
    textContent: '',
    title: '',
    parentNode: null,
    setAttribute() {},
    addEventListener() {},
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

test('untracked headline links to the full untracked list anchor on the project page', async t => {
  const recent = iso(NOW - DAY);
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    runs: [
      { id: 'recent-real', status: 'complete', startedAt: recent, jobs: [{ id: 'off-ledger', status: 'complete' }] },
      { id: 'stale-real', status: 'complete', startedAt: iso(NOW - 30 * DAY), jobs: [{ id: 'off-ledger-old', status: 'complete' }] },
    ],
  });
  t.after(fixture.cleanup);
  const detail = await projectDetail(fixture.projects[0], {
    now: NOW,
    liveRunIds: new Set(),
    env: fixture.env,
    summary,
    extraRoots: fixture.projects.map(p => p.root),
  });
  const listHref = `#${OFF_LEDGER_LIST_ANCHOR_ID}`;
  assert.equal(detail.card.facts.listHref, listHref);
  const BoardLib = await loadBoardLib();
  const host = makeElement('div');
  BoardLib.renderWatchProjectCard(detail, host, { pageMode: true });
  const link = host.querySelector('a.watch-card-fact-link');
  assert.ok(link);
  assert.equal(link.href, listHref);
});

test('gc --archive-untracked plans noise and stale off-ledger runs', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gc-untracked-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), JSON.stringify({
    version: 1,
    tickets: [{ id: 'T-0001', status: 'done', type: 'build' }],
    approved: { at: '2020-01-01T00:00:00.000Z' },
  }));
  const writeRun = async (id, state) => {
    const dir = path.join(root, '.swarm', 'runs', id);
    await fs.mkdir(path.join(dir, 'jobs', 'j1'), { recursive: true });
    await fs.writeFile(path.join(dir, 'jobs', 'j1', 'out.txt'), 'payload');
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id, status: 'complete', ...state }));
  };
  await writeRun('keep-recent', {
    startedAt: iso(NOW - DAY),
    jobs: [{ id: 'off-ledger-new', status: 'complete' }],
  });
  await writeRun('archive-stale', {
    startedAt: iso(NOW - 20 * DAY),
    jobs: [{ id: 'off-ledger-old', status: 'complete' }],
  });
  await writeRun('archive-smoke', {
    startedAt: iso(NOW - DAY),
    manifestFile: 'smoke.mjs',
    jobs: [{ id: 'smoke-job', status: 'complete' }],
  });
  const env = { ...process.env };
  const dry = await runGc(['--json', '--root', root, '--archive-untracked'], { env, defaultRoot: () => root, now: () => NOW });
  assert.equal(dry.exitCode, 0);
  const payload = JSON.parse(dry.stdout);
  const archives = payload.plans?.[0]?.categories?.untrackedArchives ?? [];
  const ids = archives.map(row => row.runId).sort();
  assert.deepEqual(ids, ['archive-smoke', 'archive-stale']);
  const plan = await collectProjectGcPlan(root, { archiveUntracked: true, nowMs: NOW });
  assert.equal(plan.categories.untrackedArchives.length, 2);
});
