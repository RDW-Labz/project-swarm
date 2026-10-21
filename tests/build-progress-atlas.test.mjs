// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { approveLedger, createLedger, writeLedger } from '../tools/tickets.mjs';
import { buildProgress, ghPrState, progressSummary } from '../tools/build-progress.mjs';

const execFileP = promisify(execFile);
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const DAY = 86400000;
const atlasFile = fileURLToPath(new URL('./fixtures/ledgers/atlas.anon.json', import.meta.url));

async function git(root, args) {
  return execFileP('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

async function atlasFixture(t, mutate = ledger => ledger) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'build-progress-atlas-')));
  const ledger = mutate(JSON.parse(await fs.readFile(atlasFile, 'utf8')));
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/project/tickets.json'), `${JSON.stringify(ledger)}\n`);
  const historyFile = path.join(root, 'history.ndjson');
  await fs.writeFile(historyFile, '');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, historyFile, projectId: 'atlas-fixture' };
}

async function run(root, runId, state) {
  const dir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id: runId, ...state }));
}

test('atlas excludes human-only S2 from stage rows and uses the exact build/human headline', async t => {
  const fixture = await atlasFixture(t, ledger => ({ ...ledger, branch: 'swarm/atlas' }));
  const progress = await buildProgress({
    ...fixture,
    now: NOW,
    prState: branch => {
      assert.equal(branch, 'swarm/atlas');
      return [{ number: 5, state: 'OPEN', mergedAt: '2026-10-20T12:00:00.000Z', headRefName: branch }];
    },
  });
  const expectedHeadline = 'build 22/33 · human 0/11';
  assert.equal(progress.headline, expectedHeadline);
  assert.equal(progressSummary(progress).headline, expectedHeadline);
  assert.equal(JSON.parse(JSON.stringify(progressSummary(progress))).headline, expectedHeadline);
  assert.equal(progress.stages.some(stage => stage.stageId === 'S2'), false);
  assert.equal(progress.left.human.filter(ticket => ticket.stageId === 'S2').length, 9);
  assert.equal(progress.milestones.find(item => item.key === 'pr').state, 'done');
  assert.equal(progress.milestones.find(item => item.key === 'merged').state, 'current');
});

test('headline omits human segment when the ledger has no human tickets', async t => {
  const fixture = await atlasFixture(t, ledger => ({
    ...ledger,
    tickets: ledger.tickets.filter(ticket => ticket.type !== 'human'),
  }));
  const progress = await buildProgress({ ...fixture, now: NOW });
  const expectedHeadline = `build ${progress.percent.tickets.done}/${progress.percent.tickets.total}`;
  assert.equal(progress.headline, expectedHeadline);
  assert.equal(JSON.parse(JSON.stringify(progressSummary(progress))).headline, expectedHeadline);
});

test('atlas PR state distinguishes open-only from unreadable GitHub state', async t => {
  const fixture = await atlasFixture(t);
  const open = await buildProgress({ ...fixture, now: NOW, prState: () => [{ number: 5, state: 'OPEN', mergedAt: null, headRefName: 'swarm/atlas' }] });
  assert.equal(open.milestones.find(item => item.key === 'pr').state, 'current');
  assert.equal(open.milestones.find(item => item.key === 'merged').state, 'todo');

  const unreadable = await buildProgress({ ...fixture, now: NOW, prState: () => null });
  for (const key of ['pr', 'merged']) {
    const item = unreadable.milestones.find(milestone => milestone.key === key);
    assert.equal(item.state, 'unknown');
    assert.equal(item.evidence, 'not tracked');
  }
});

test('ghPrState uses an argv-only, token-free ten-second GitHub call', async () => {
  let observed;
  const state = ghPrState({ repo: 'owner/repo', env: { GITHUB_TOKEN: 'secret', GH_TOKEN: 'secret2', KEEP: 'yes' }, run: async (...args) => {
    observed = args;
    return { code: 0, stdout: JSON.stringify([{ number: 5, state: 'OPEN', mergedAt: null, headRefName: 'swarm/atlas' }]) };
  } });
  assert.deepEqual(await state('swarm/atlas'), [{ number: 5, state: 'OPEN', mergedAt: null, headRefName: 'swarm/atlas' }]);
  assert.equal(observed[0], 'gh');
  assert.deepEqual(observed[1], ['pr', 'list', '--repo', 'owner/repo', '--head', 'swarm/atlas', '--state', 'all', '--json', 'number,state,mergedAt,headRefName', '--limit', '20']);
  assert.equal(observed[2].shell, false);
  assert.equal(observed[2].timeout, 10000);
  assert.equal(observed[2].env.GITHUB_TOKEN, undefined);
  assert.equal(observed[2].env.GH_TOKEN, undefined);
  assert.equal(observed[2].env.KEEP, 'yes');
});

test('rollup keeps a finished scope row and calculates overall build percent across scopes', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'build-progress-atlas-scopes-'));
  const main = path.join(temp, 'main');
  const linked = path.join(temp, 'linked');
  await fs.mkdir(path.join(main, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(main, 'docs/scope/a.md'), '# Scope: Scope A\nVersion: 1\n\n## S1 Foundation\n### R-001 Requirement\nAcceptance:\n- done\n');
  await git(main, ['init', '-q']);
  await git(main, ['config', 'user.name', 'Atlas Fixture']);
  await git(main, ['config', 'user.email', 'atlas@example.invalid']);
  const makeTicket = (id, status) => ({ id, title: id, type: 'build', status, stage: 'S1', scopeRefs: ['R-001'], acceptance: ['done'], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false });
  const a = approveLedger(createLedger({ scope: { file: 'docs/scope/a.md', name: 'Scope A' }, tickets: Array.from({ length: 17 }, (_, i) => makeTicket(`T-${String(i + 1).padStart(4, '0')}`, 'done')), now: NOW - DAY }), { now: NOW - DAY });
  await writeLedger(main, a);
  await git(main, ['add', '.']);
  await git(main, ['commit', '-qm', 'scope a']);
  await git(main, ['worktree', 'add', '-q', '-b', 'scope-b', linked]);
  await fs.writeFile(path.join(linked, 'docs/scope/b.md'), '# Scope: Scope B\nVersion: 1\n\n## S1 Foundation\n### R-001 Requirement\nAcceptance:\n- done\n');
  const b = approveLedger(createLedger({ scope: { file: 'docs/scope/b.md', name: 'Scope B' }, tickets: Array.from({ length: 12 }, (_, i) => makeTicket(`T-${String(i + 101).padStart(4, '0')}`, i < 3 ? 'done' : 'todo')), now: NOW }), { now: NOW });
  await writeLedger(linked, b);
  const historyFile = path.join(temp, 'history.ndjson');
  await fs.writeFile(historyFile, '');
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const progress = await buildProgress({ root: main, projectId: 'atlas-scopes', now: NOW, historyFile });
  assert.deepEqual(progress.scopes.map(scope => [scope.name, scope.build.done, scope.build.total, scope.done]), [['Scope B', 3, 12, false], ['Scope A', 17, 17, true]]);
  assert.deepEqual(progress.percent.tickets, { done: 20, total: 29, pct: 68 });
});

test('untracked work counts unmapped jobs and ignores jobs mapped to ledger tickets', async t => {
  const fixture = await atlasFixture(t);
  await run(fixture.root, 'untracked', { status: 'complete', startedAt: new Date(NOW - DAY).toISOString(), name: 'Untracked run', jobs: [{ name: 'not-a-ticket', status: 'complete' }] });
  await run(fixture.root, 'mapped', { status: 'complete', startedAt: new Date(NOW - DAY / 2).toISOString(), name: 'Mapped run', jobs: [{ id: 'T-0001', name: 'T-0001', status: 'complete' }] });
  const progress = await buildProgress({ ...fixture, now: NOW });
  assert.equal(progress.untracked.runs.length, 1);
  assert.equal(progress.untracked.jobs, 1);
  assert.deepEqual(progress.untracked.newest, [{ runId: 'untracked', name: 'Untracked run', startedAt: new Date(NOW - DAY).toISOString(), status: 'complete' }]);
  assert.equal(progress.untracked.warning, 'untracked work: no ledger ticket');
  assert.equal(progress.offLedger, progress.untracked);
  assert.deepEqual(progressSummary(progress).untracked, { runs: 1, jobs: 1 });
});
