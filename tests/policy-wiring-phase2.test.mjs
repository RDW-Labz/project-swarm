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
import fss from 'node:fs';
import { centralDayKey, centralMidnightAfter } from '../tools/daily-limit.mjs';
import { executePolicyPass } from '../tools/autopilot.mjs';
import { DEFAULT_POLICY_FILE, loadPolicy, policyPath } from '../tools/policy.mjs';
import { createRequest } from '../tools/handbuild.mjs';
import { withSpendStore, spendDir } from '../tools/spend.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');

async function temp(t, prefix = 'policy-wiring2-') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function project(t) {
  const root = await temp(t);
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
  return root;
}

function run(root, home, args, extraEnv = {}) {
  return exec(process.execPath, [swarm, '--root', root, ...args], {
    env: { ...process.env, HOME: home, SWARM_CONFIG: process.env.SWARM_CONFIG, ...extraEnv },
  });
}

test('policy check ignores caller pastDailyAutoLimit and reports it', async t => {
  const root = await project(t);
  const home = await temp(t, 'policy-wiring2-home-');
  const configDir = path.join(home, 'cfg');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'policy.json'), `${JSON.stringify(DEFAULT_POLICY_FILE, null, 2)}\n`);
  const env = { SWARM_CONFIG: path.join(configDir, 'config.json') };

  const out = await run(root, home, [
    'policy', 'check', 'ticket-retry', '--facts', JSON.stringify({ pastDailyAutoLimit: true }),
  ], env);
  const payload = JSON.parse(out.stdout.trim());
  assert.deepEqual(payload.ignoredFacts, ['pastDailyAutoLimit']);
  assert.equal(payload.decision, 'auto-approve');
});

test('policy pass skips when billedToday dep is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-wiring2-skip-'));
  let applied = false;
  const r = await executePolicyPass(root, {
    policyPass: {
      loadRules: async () => [],
      openRequests: async () => [{ id: 't1', kind: 'ticket-retry', project: 'p' }],
      billedTodayUsd: undefined,
      events: async () => {},
      apply: async () => { applied = true; },
    },
  });
  assert.equal(r.skipped, true);
  assert.equal(applied, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('policy pass runs with a policy file and does nothing without one', async t => {
  const root = await project(t);
  const home = await temp(t, 'policy-wiring2-pass-');
  const configDir = path.join(home, 'cfg');
  await fs.mkdir(configDir, { recursive: true });
  const env = { SWARM_CONFIG: path.join(configDir, 'config.json'), HOME: home };
  const policyFile = policyPath(env, home);
  assert.equal(fss.existsSync(policyFile), false);

  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# notes\n');
  await exec('git', ['-C', root, 'checkout', '-b', 'swarm/policy-wiring']);
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'routing-only setup path for policy pass wiring test',
    files: 'CLAUDE.md',
    git: 'commit',
    minutes: 15,
  });
  const item = {
    id: `handbuild-${req.id}`,
    kind: 'hand-build-request',
    project: path.basename(root),
    facts: { files: ['CLAUDE.md'], git: ['commit'], branch: 'swarm/policy-wiring' },
  };

  let opened = false;
  const skipped = await executePolicyPass(root, {
    policyPass: {
      loadRules: async () => null,
      openRequests: async () => { opened = true; return [item]; },
      apply: async () => {},
      events: async () => {},
    },
  });
  assert.equal(opened, false);
  assert.equal(skipped.skipped, true);

  await fs.writeFile(policyFile, `${JSON.stringify(DEFAULT_POLICY_FILE, null, 2)}\n`);
  assert.equal(fss.existsSync(policyFile), true);
  const { rules } = loadPolicy(policyFile, { fs: fss });
  const journal = [];
  const events = [];
  const applied = [];
  await executePolicyPass(root, {
    policyPass: {
      loadRules: async () => rules,
      openRequests: async () => [item],
      billedTodayUsd: async () => 0,
      dailyLimitSettings: async () => ({}),
      factsOf: it => it.facts ?? {},
      apply: async ({ item: it }) => {
        const { decideRequest } = await import('../tools/handbuild.mjs');
        const hbId = String(it.id).slice('handbuild-'.length);
        decideRequest(root, hbId, 'approve', { by: 'policy', channel: 'policy' });
        applied.push(it.id);
      },
      events: async line => { events.push(line); },
      appendAutoDecisionDeps: {
        appendJournal: async (_r, line) => { journal.push(line); },
        appendEvents: async (_r, line) => { events.push(line); },
      },
    },
  });
  assert.deepEqual(applied, [item.id]);
  assert.equal(journal.some(e => e.requestKind === 'hand-build-request'), true);
  assert.equal(events.some(e => e.requestKind === 'hand-build-request'), true);
});

test('budget show prints non-zero billed today and Central reset', async t => {
  const root = await project(t);
  const home = await temp(t, 'policy-wiring2-budget-');
  const spendRoot = path.join(home, 'spend');
  await fs.mkdir(spendRoot, { recursive: true });
  const env = { HOME: home, SWARM_SPEND_DIR: spendRoot };
  const now = Date.now();
  const day = centralDayKey(() => now);
  await withSpendStore(store => {
    store.version = 1;
    store.entries = {
      k1: {
        kind: 'reserved-as-cost',
        lane: 'openrouter',
        root: path.resolve(root),
        runId: 'r1',
        jobId: 'j1',
        usd: 2.25,
        tokens: 10,
        day,
        at: new Date(now).toISOString(),
        pid: process.pid,
        host: os.hostname(),
        flagged: false,
      },
    };
  }, { dir: spendDir(env, home), now: () => now });

  const show = await run(root, home, ['budget', 'show'], env);
  assert.match(show.stdout, /billed today: \$2\.25/);
  assert.match(show.stdout, /resets at: .+\b(CST|CDT)\b/);
  const resetsAt = centralMidnightAfter(() => now);
  assert.ok(show.stdout.includes(centralResetSnippet(resetsAt)));
});

function centralResetSnippet(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms)).split(',')[0];
}
