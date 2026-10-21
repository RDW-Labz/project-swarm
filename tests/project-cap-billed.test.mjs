// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PAID_LANES, LANE_RESERVE_DEFAULTS, runTotals } from '../tools/spend.mjs';
import { projectSpend, projectCapDecision, projectSummary, treeSpend } from '../tools/project-spend.mjs';

const exec = promisify(execFile);

async function repo(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-cap-billed-'));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json') } };
}

async function writeRun(root, id, state) {
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, ...state }));
}

function partsAppJobs({ anthropicCost = 2.37, claudeCost = 54.85, extra = [] } = {}) {
  return [
    { id: 'claude-lane', agent: 'claude', costUsd: claudeCost, usage: { total_tokens: 1_000_000 } },
    { id: 'anthropic-api', agent: 'anthropic', costUsd: anthropicCost, usage: { total_tokens: 50_000 } },
    { id: 'codex-zero', agent: 'codex', costUsd: 0, usage: { total_tokens: 10 } },
    { id: 'cursor-zero', agent: 'cursor', costUsd: 0, usage: { total_tokens: 10 } },
    ...extra,
  ];
}

test('parts-app mix: list spend is high but only billed metered lanes count toward the cap', async t => {
  const { root } = await repo(t);
  await writeRun(root, 'mix', { status: 'complete', jobs: partsAppJobs() });
  const spent = await projectSpend(root);
  assert.equal(spent.usd, spent.listUsd);
  assert.ok(Math.abs(spent.listUsd - 57.22) < 0.01, `list ${spent.listUsd}`);
  assert.ok(Math.abs(spent.billedUsd - 2.37) < 0.01, `billed ${spent.billedUsd}`);
  assert.equal(projectCapDecision({ spent, cap: 5 }), null);
  await writeRun(root, 'api-only', { status: 'complete', jobs: [{ id: 'a', agent: 'anthropic', costUsd: 6, usage: { total_tokens: 1 } }] });
  assert.ok(projectCapDecision({ spent: await projectSpend(root), cap: 5 }));
  await writeRun(root, 'extra-api', { status: 'complete', jobs: [{ id: 'b', agent: 'anthropic', costUsd: 6, usage: { total_tokens: 1 } }] });
  const over = await projectSpend(root);
  assert.ok(Math.abs(over.billedUsd - 14.37) < 0.01);
  const decision = projectCapDecision({ spent: over, cap: 5, source: 'profile budget.projectMaxUsd' });
  assert.ok(decision);
  assert.match(decision.message, /been billed \$14\.37 of the \$5\.00 cap/);
  assert.match(decision.message, /list value \$69\.22 across 3 runs is not counted/);
  assert.match(decision.message, /only metered lanes \(/);
  for (const lane of PAID_LANES) assert.match(decision.message, new RegExp(lane));
});

test('unknown cost on a paid lane is billedUnknown, not zero billed', () => {
  const totals = runTotals({
    jobs: [
      { id: 'u', agent: 'anthropic', usage: { total_tokens: 500 } },
      { id: 'c', agent: 'claude', costUsd: 1, usage: { total_tokens: 100 } },
    ],
  });
  assert.equal(totals.billedUsd, 0);
  assert.equal(totals.billedUnknown, 1);
  assert.equal(totals.billedUnknownUsd, LANE_RESERVE_DEFAULTS.anthropic);
  assert.equal(totals.usd, 1);
});

test('projectCapDecision counts unknown metered cost at lane reserve and names it', () => {
  const reserve = LANE_RESERVE_DEFAULTS.anthropic;
  const spent = { usd: 100, listUsd: 100, billedUsd: 0, billedUnknown: 2, billedUnknownUsd: reserve * 2, runs: 1, exposureUsd: 0 };
  const decision = projectCapDecision({ spent, cap: reserve * 2, source: 'test' });
  assert.ok(decision);
  assert.match(decision.message, /2 jobs with unknown cost counted at the reserve/);
  assert.match(decision.message, new RegExp(`been billed \\$${(reserve * 2).toFixed(2)}`));
});

test('null and non-object job entries are skipped; __proto__ job is an ordinary metered unknown', () => {
  const totals = runTotals({
    jobs: [
      null,
      undefined,
      [],
      { id: '__proto__', agent: '__proto__', usage: { total_tokens: 10 } },
      { id: 'paid', agent: 'anthropic', costUsd: 1.5, usage: { total_tokens: 1 } },
    ],
  });
  assert.equal(totals.billedUsd, 1.5);
  assert.equal(totals.billedUnknown, 1);
  assert.equal(totals.billedUnknownUsd, LANE_RESERVE_DEFAULTS.anthropic);
  assert.equal(totals.usd, 1.5);
});

test('projectSpend tolerates null jobs in run state', async t => {
  const { root } = await repo(t);
  await writeRun(root, 'dirty', {
    status: 'complete',
    jobs: [null, { id: '__proto__', agent: '__proto__', usage: { total_tokens: 1 } }, { id: 'a', agent: 'anthropic', costUsd: 2, usage: { total_tokens: 1 } }],
  });
  const spent = await projectSpend(root);
  assert.equal(spent.unreadable.length, 0);
  assert.ok(Math.abs(spent.billedUsd - 2) < 0.01);
  assert.equal(spent.billedUnknown, 1);
});

test('missing or unrecognized lane is metered with reserve default', () => {
  const totals = runTotals({
    jobs: [
      { id: 'no-agent', usage: { total_tokens: 10 } },
      { id: 'weird', agent: 42, usage: { total_tokens: 10 } },
      { id: 'ollama', agent: 'ollama', usage: { total_tokens: 10 } },
    ],
  });
  assert.equal(totals.billedUnknown, 3);
  assert.equal(totals.billedUnknownUsd, LANE_RESERVE_DEFAULTS.anthropic * 3);
});

test('negative rental is ignored and rented job cost is not doubled', () => {
  const totals = runTotals({
    rental: { usd: -5 },
    jobs: [{ id: 'r', agent: 'rented', costUsd: 3, usage: { total_tokens: 1 } }],
  });
  assert.equal(totals.billedUsd, 3);
  assert.equal(totals.usd, 3);
  const doubled = runTotals({
    rental: { usd: 10 },
    jobs: [{ id: 'r', agent: 'rented', costUsd: 3, usage: { total_tokens: 1 } }],
  });
  assert.equal(doubled.billedUsd, 10);
});

test('projectCapDecision without billedUsd fails closed to list usd', () => {
  assert.equal(projectCapDecision({ spent: { usd: 4, listUsd: 4, runs: 1, exposureUsd: 0 }, cap: 5 }), null);
  assert.ok(projectCapDecision({ spent: { usd: 6, listUsd: 6, runs: 1, exposureUsd: 0 }, cap: 5 }));
});

test('exposure applies only to running runs with a paid-lane job', async t => {
  const { root, env } = await repo(t);
  await writeRun(root, 'claude-live', {
    status: 'running',
    budget: { maxUsd: 10 },
    jobs: [{ id: 'j', agent: 'claude', costUsd: 5, usage: { total_tokens: 1 } }],
  });
  assert.equal((await projectSpend(root)).exposureUsd, 0);
  await writeRun(root, 'api-live', {
    status: 'running',
    budget: { maxUsd: 10 },
    jobs: [{ id: 'j', agent: 'anthropic', costUsd: 2, usage: { total_tokens: 1 } }],
  });
  const spent = await projectSpend(root);
  assert.equal(spent.exposureUsd, 8);
  const decision = projectCapDecision({ spent, cap: 10, source: 'x' });
  assert.match(decision.message, /plus \$8\.00 exposure/);
  const summary = await projectSummary(root, { env, ttlMs: 0 });
  assert.equal(summary.spendUsd, summary.listUsd);
  assert.equal(summary.billedUsd, 2);
  assert.equal(summary.listUsd, 7);
  assert.equal(summary.billedUnknown, 0);
});

test('projectCapDecision uses billedUsd not list when cap is tight on list-only spend', () => {
  const spent = { usd: 100, listUsd: 100, billedUsd: 2, runs: 50, exposureUsd: 0 };
  assert.equal(projectCapDecision({ spent, cap: 5 }), null);
  assert.ok(projectCapDecision({ spent: { ...spent, billedUsd: 5 }, cap: 5 }));
});

const RENTED_RESERVE = 0.5;

test('rented job without cost reserves a nonzero amount regardless of job order', () => {
  const unknownRented = { id: 'r', agent: 'rented', usage: { total_tokens: 1 } };
  const withCostFirst = runTotals({ jobs: [{ id: 'r2', agent: 'rented', costUsd: 4, usage: { total_tokens: 1 } }, unknownRented] });
  assert.equal(withCostFirst.billedUsd, 4);
  assert.equal(withCostFirst.billedUnknown, 0);
  const onlyUnknown = runTotals({ jobs: [unknownRented] });
  assert.equal(onlyUnknown.billedUsd, 0);
  assert.equal(onlyUnknown.billedUnknown, 1);
  assert.equal(onlyUnknown.billedUnknownUsd, RENTED_RESERVE);
  const reversed = runTotals({ jobs: [unknownRented, { id: 'r3', agent: 'rented', costUsd: 0, usage: { total_tokens: 1 } }] });
  assert.equal(reversed.billedUnknown, 1);
  assert.equal(reversed.billedUnknownUsd, RENTED_RESERVE);
  const twoUnknown = runTotals({ jobs: [unknownRented, { id: 'r4', agent: 'rented', usage: { total_tokens: 2 } }] });
  assert.equal(twoUnknown.billedUnknown, 2);
  assert.equal(twoUnknown.billedUnknownUsd, RENTED_RESERVE * 2);
});

test('agent names constructor and toString count as metered unknown with a numeric reserve', () => {
  for (const agent of ['constructor', 'toString']) {
    const totals = runTotals({ jobs: [{ id: agent, agent, usage: { total_tokens: 10 } }] });
    assert.equal(totals.billedUnknown, 1);
    assert.equal(totals.billedUnknownUsd, LANE_RESERVE_DEFAULTS.anthropic);
    assert.ok(Number.isFinite(totals.billedUnknownUsd) && totals.billedUnknownUsd > 0);
  }
});

test('invalid rental.usd is counted at the rented reserve, not as free', () => {
  const totals = runTotals({
    rental: { usd: Number.NaN },
    jobs: [{ id: 'r', agent: 'rented', usage: { total_tokens: 1 } }],
  });
  assert.equal(totals.billedUsd, 0);
  assert.equal(totals.billedUnknown, 1);
  assert.equal(totals.billedUnknownUsd, RENTED_RESERVE);
  const decision = projectCapDecision({
    spent: { usd: 0, listUsd: 0, billedUsd: 0, billedUnknown: 1, billedUnknownUsd: RENTED_RESERVE, billedUnknownRented: 1, runs: 1, exposureUsd: 0 },
    cap: RENTED_RESERVE,
    source: 'test',
  });
  assert.ok(decision);
  assert.match(decision.message, /1 rented job with unknown cost counted at the reserve/);
  assert.match(decision.message, /rented/);
});

test('rented job with costUsd 0 and costSource reservation counts at the reserve', () => {
  const totals = runTotals({
    jobs: [{ id: 'r', agent: 'rented', costUsd: 0, costSource: 'reservation', usage: { total_tokens: 1 } }],
  });
  assert.equal(totals.billedUsd, 0);
  assert.equal(totals.billedUnknown, 1);
  assert.equal(totals.billedUnknownUsd, RENTED_RESERVE);
  assert.equal(totals.billedUnknownRented, 1);
});

test('flat-rate lane job with costUsd 0 stays free for the billed cap', () => {
  const totals = runTotals({
    jobs: [
      { id: 'c', agent: 'claude', costUsd: 0, costSource: 'reservation', usage: { total_tokens: 100 } },
      { id: 'x', agent: 'codex', costUsd: 0, costSource: 'reservation', usage: { total_tokens: 10 } },
    ],
  });
  assert.equal(totals.billedUsd, 0);
  assert.equal(totals.billedUnknown, 0);
  assert.equal(totals.billedUnknownUsd, 0);
});

test('stored reservation larger than the lane default is used for billedUnknownUsd', () => {
  const laneDefault = LANE_RESERVE_DEFAULTS.anthropic;
  const stored = laneDefault + 1.25;
  const totals = runTotals({
    jobs: [
      { id: 'u', agent: 'anthropic', costUsd: 0, costSource: 'reservation', reservedUsd: stored, usage: { total_tokens: 1 } },
    ],
  });
  assert.equal(totals.billedUnknown, 1);
  assert.equal(totals.billedUnknownUsd, stored);
  assert.ok(stored > laneDefault);
});

test('treeSpend cache misses when inode changes but mtime and size stay the same', async t => {
  const { root } = await repo(t);
  const id = 'cache-ino';
  await writeRun(root, id, { status: 'complete', jobs: [{ id: 'j', agent: 'anthropic', costUsd: 1, usage: { total_tokens: 1 } }] });
  const file = path.join(root, '.swarm/runs', id, 'state.json');
  const real = await fs.stat(file);
  const fixed = { mtimeMs: real.mtimeMs, size: real.size };
  let ino = 9001;
  let ctimeMs = 1_700_000_000_000;
  const statFn = async target => {
    const stat = await fs.stat(target);
    if (path.resolve(target) !== path.resolve(file)) return stat;
    return { ...stat, ...fixed, ino, ctimeMs };
  };
  const first = await treeSpend(root, { statFn });
  assert.equal(first.billedUsd, 1);
  await writeRun(root, id, { status: 'complete', jobs: [{ id: 'j', agent: 'anthropic', costUsd: 8, usage: { total_tokens: 1 } }] });
  const cached = await treeSpend(root, { statFn });
  assert.equal(cached.billedUsd, 1, 'cache hit when ino, ctime, mtime, and size are unchanged');
  ino = 9002;
  ctimeMs = 1_700_000_000_001;
  const second = await treeSpend(root, { statFn });
  assert.equal(second.billedUsd, 8, 'cache must re-read when ino changes');
});
