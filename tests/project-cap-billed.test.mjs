// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PAID_LANES, runTotals } from '../tools/spend.mjs';
import { projectSpend, projectCapDecision, projectSummary } from '../tools/project-spend.mjs';

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
  assert.match(decision.message, /been billed \$14\.37/);
  assert.match(decision.message, /list value \$69\.22 across 3 runs/);
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
  assert.equal(totals.usd, 1);
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
  assert.match(decision.message, /may spend \$8\.00 more/);
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
