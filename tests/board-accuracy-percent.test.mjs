// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardPercent, buildProgress } from '../tools/build-progress.mjs';
import { boardSnapshot, projectDetail, projectOverview } from '../tools/board-data.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const ledgerDir = fileURLToPath(new URL('./fixtures/ledgers/', import.meta.url));
const ledgerNames = ['roadmap-ledger.json', 'atlas.anon.json', 'parts-app-ledger.anon.json'];
const otherLedger = {
  'roadmap-ledger.json': 'atlas.anon.json',
  'atlas.anon.json': 'parts-app-ledger.anon.json',
  'parts-app-ledger.anon.json': 'roadmap-ledger.json',
};
const summary = async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false });
const options = fixture => ({ now: NOW, historyFile: fixture.historyFile, summary });

async function readLedger(name) {
  return JSON.parse(await fs.readFile(path.join(ledgerDir, name), 'utf8'));
}

function countedStats(ledger) {
  const counted = ledger.tickets.filter(ticket => ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status));
  const done = counted.filter(ticket => ticket.status === 'done').length;
  return { done, total: counted.length, pct: counted.length ? Math.floor(done * 100 / counted.length) : null };
}

function completionRuns(ledger, prefix) {
  return [{
    id: `${prefix}-completions`,
    status: 'complete',
    startedAt: '2026-10-20T12:00:00.000Z',
    jobs: ledger.tickets.filter(ticket => ticket.status === 'done').map((ticket, index) => ({
      id: ticket.id,
      status: 'complete',
      finishedAt: new Date(Date.UTC(2026, 9, 20, 12, index % 12, 0)).toISOString(),
    })),
  }];
}

async function assertBoardValues(t, baseName, registered) {
  const childName = otherLedger[baseName];
  const baseLedger = await readLedger(baseName);
  const childLedger = await readLedger(childName);
  const fixture = await makeBoardFixture({
    ledger: baseName,
    worktrees: [{ name: 'linked', ledger: childName, runs: completionRuns(childLedger, 'child') }],
    runs: completionRuns(baseLedger, 'main'),
    scratch: [{ runs: [{ id: 'scratch-run', status: 'complete', jobs: [] }] }],
    prs: [{ number: 8010, mergedAt: '2026-10-20T12:00:00.000Z', title: 'Merged fixture PR' }],
    spend: { billedToday: 1.25, listToday: 2.5 },
  });
  t.after(fixture.cleanup);
  assert.equal(fixture.env.SWARM_PROJECTS_FILE, fixture.projectsFile);
  assert.equal((await fixture.prState()).length, 1);

  const mainProject = fixture.projects[0];
  const childProject = fixture.projects[1];
  const target = registered ? mainProject : childProject;
  const projects = registered ? [mainProject, childProject] : [childProject];
  const selectedLedger = registered
    ? (Date.parse(baseLedger.approved.at) >= Date.parse(childLedger.approved.at) ? baseLedger : childLedger)
    : childLedger;
  const expected = countedStats(selectedLedger);
  const board = await boardSnapshot({ projects, liveRuns: [], ...options(fixture) });
  const card = board.projects.find(project => project.id === target.id);
  const overview = await projectOverview(target, [], options(fixture));
  const detail = await projectDetail(target, options(fixture));
  const direct = await buildProgress({ root: target.root, projectId: target.id, ...options(fixture), ownOnly: !registered, prState: fixture.prState });

  assert.equal(card.progress.overall, expected.pct);
  assert.equal(overview.progress.overall, expected.pct);
  assert.equal(detail.progress.percent.overall, expected.pct);
  assert.equal(direct.percent.overall, expected.pct);
  assert.equal(boardPercent(detail.progress), expected.pct);
  assert.equal(detail.progress.eta.remaining, expected.total - expected.done);
  assert.equal(direct.eta.remaining, expected.total - expected.done);
  assert.equal(detail.progress.percent.board.done, expected.done);
  assert.equal(detail.progress.percent.board.total, expected.total);
}

for (const ledger of ledgerNames) {
  test(`${ledger}: registered parent uses family-selected board percent`, async t => {
    await assertBoardValues(t, ledger, true);
  });

  test(`${ledger}: unregistered parent still treats linked checkout as own ledger`, async t => {
    await assertBoardValues(t, ledger, false);
  });
}
