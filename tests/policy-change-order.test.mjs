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
import {
  decide,
  effectiveRulesFromOverrides,
  loadPolicy,
  autoDecisionEvent,
  isChangeOrderProtectedRenamePath,
} from '../tools/policy.mjs';
import { runPolicyPass } from '../tools/policy-run.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');
const rules = () => effectiveRulesFromOverrides([]);

function renameFacts(overrides = {}) {
  return {
    renameOnly: true,
    addedRequirements: 0,
    removedRequirements: 0,
    cancelsTickets: 0,
    reopensTickets: 0,
    hasApprovedLedger: true,
    renames: [{ from: 'src/a.ts', to: 'src/b.ts' }],
    ...overrides,
  };
}

test('change-order-rename-only auto-approves clean rename facts', () => {
  const result = decide({ kind: 'change-order', id: 'co-1', facts: renameFacts() }, { rules: rules() });
  assert.equal(result.decision, 'auto-approve');
  assert.equal(result.rule, 'change-order-rename-only');
  const event = autoDecisionEvent({ kind: 'change-order', id: 'co-1', facts: renameFacts() }, result, { now: () => 0 });
  assert.deepEqual(event.renames, [{ from: 'src/a.ts', to: 'src/b.ts' }]);
});

test('change-order-rename-only fails closed on bad cases', () => {
  const cases = [
    renameFacts({ addedRequirements: 1 }),
    renameFacts({ removedRequirements: 1 }),
    renameFacts({ renameOnly: false }),
    renameFacts({ cancelsTickets: 1 }),
    renameFacts({ reopensTickets: 2 }),
    renameFacts({ hasApprovedLedger: false }),
    renameFacts({ renames: [{ from: 'coordination/checks.json', to: 'coordination/checks2.json' }] }),
    renameFacts({
      renames: [
        { from: 'src/1.ts', to: 'src/1a.ts' },
        { from: 'src/2.ts', to: 'src/2a.ts' },
        { from: 'src/3.ts', to: 'src/3a.ts' },
        { from: 'src/4.ts', to: 'src/4a.ts' },
        { from: 'src/5.ts', to: 'src/5a.ts' },
        { from: 'src/6.ts', to: 'src/6a.ts' },
      ],
    }),
  ];
  for (const facts of cases) {
    const result = decide({ kind: 'change-order', id: 'co-x', facts }, { rules: rules() });
    assert.equal(result.decision, 'needs-owner');
  }
  assert.equal(isChangeOrderProtectedRenamePath('.github/workflows/ci.yml'), true);
  assert.equal(isChangeOrderProtectedRenamePath('package.json'), true);
});

test('missing policy file after init marker yields no auto-approve', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'policy-co-home-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configDir = path.join(home, 'cfg');
  await fs.mkdir(configDir, { recursive: true });
  const policyFile = path.join(configDir, 'policy.json');
  await fs.writeFile(path.join(configDir, '.policy-initialized'), '');
  const loaded = loadPolicy(policyFile, { fs: await import('node:fs') });
  assert.equal(loaded.rules.length, 0);
  const result = decide({ kind: 'change-order', id: 'co-1', facts: renameFacts() }, { rules: loaded.rules });
  assert.equal(result.decision, 'needs-owner');
});

test('swarm policy check change-order decides rename-only', async t => {
  const base = process.env.SWARM_TEST_TMP || os.tmpdir();
  const root = await fs.mkdtemp(path.join(base, 'policy-co-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', '-b', 'main', root]);
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'policy-co-cli-home-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configDir = path.join(home, 'cfg');
  await fs.mkdir(configDir, { recursive: true });
  const env = { SWARM_CONFIG: path.join(configDir, 'config.json') };
  await exec(process.execPath, [swarm, '--root', root, 'policy', 'init'], { env: { ...process.env, ...env } });
  const facts = JSON.stringify(renameFacts());
  const out = await exec(process.execPath, [swarm, '--root', root, 'policy', 'check', 'change-order', '--facts', facts], {
    env: { ...process.env, ...env },
  });
  const decision = JSON.parse(out.stdout.trim());
  assert.equal(decision.decision, 'auto-approve');
  assert.equal(decision.rule, 'change-order-rename-only');
  const show = await exec(process.execPath, [swarm, '--root', root, 'policy', 'show'], { env: { ...process.env, ...env } });
  assert.match(show.stdout, /change-order-rename-only/);
});

test('runPolicyPass logs renames before apply', async () => {
  const journal = [];
  const events = [];
  const applied = [];
  const result = await runPolicyPass({
    root: '/tmp/x',
    items: [{ id: 'co-apply', kind: 'change-order', project: 'demo' }],
    rules: rules(),
    factsOf: () => renameFacts(),
    apply: async ctx => { applied.push(ctx); },
    journal: async line => { journal.push(line); },
    events: async line => { events.push(line); },
    readHandled: () => [],
    persistAutoDecision: async (_root, entry) => {
      journal.push(entry);
      events.push(entry);
      return true;
    },
  });
  assert.equal(result.decided.length, 1);
  assert.equal(result.decided[0].rule, 'change-order-rename-only');
  assert.equal(applied.length, 1);
  assert.deepEqual(journal[0].renames, [{ from: 'src/a.ts', to: 'src/b.ts' }]);
});
