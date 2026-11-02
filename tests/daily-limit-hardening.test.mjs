// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  billedMeteredTodayUsd,
  inFlightReserveUsd,
  loadDailyLimitSettings,
  reserveSpend,
  resolveBudget,
  withSpendStore,
  billedTodayUsd,
} from '../tools/spend.mjs';
import {
  resolveDailyLimit,
  evaluateDailyLimit,
} from '../tools/daily-limit.mjs';
import {
  notifyDailyLimit,
  NOTIFIER_STATE_REL,
  NOTIFY_FAIL_LOG_REL,
} from '../tools/daily-limit-notify.mjs';
import {
  budgetCommand,
  BUDGET_SET_LOG_REL,
  BUDGET_RAISE_APPROVAL_REL,
  agentBudgetRaiseRefusalMessage,
} from '../tools/budget-set-commands.mjs';

const ms = iso => Date.parse(iso);
const ownerTerminal = { stdinIsTTY: true, stdoutIsTTY: true };

async function tempDir(prefix) {
  return await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), prefix));
}

describe('finding 1 reserveSpend loads settings and fail-closed', () => {
  it('refuses paid lane when project settings exist but are invalid JSON', async () => {
    const dir = await tempDir('dl-h1-');
    const root = await tempDir('dl-h1-root-');
    const bad = path.join(root, '.swarm', 'project', 'daily-limit.json');
    await fs.mkdir(path.dirname(bad), { recursive: true });
    await fs.writeFile(bad, '{not json', { mode: 0o600 });
    const now = () => ms('2024-06-15T15:00:00.000Z');
    const result = await reserveSpend({
      dir,
      key: 'k',
      lane: 'openrouter',
      runId: 'r',
      root,
      jobId: 'j',
      usd: 0.5,
      tokens: 1,
      budget: resolveBudget({ cli: { maxUsd: 100 } }),
      runTotals: { usd: 0, tokens: 0 },
      now,
      env: { HOME: root },
      homedir: () => root,
    });
    assert.equal(result.decision?.reason, 'daily-limit');
    assert.match(result.decision?.message, /could not be read/);
  });
});

describe('finding 2 budget set journal, log, and agent approval', () => {
  it('refuses large agent raises without owner approval', async () => {
    const root = await tempDir('dl-h2-');
    const env = { HOME: root, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg') };
    const out = { chunks: [], write(s) { this.chunks.push(s); } };
    const journal = [];
    const code = await budgetCommand(['set', '--daily', '20'], {
      out,
      env,
      root,
      fs,
      homedir: () => root,
      appendEvent: async (r, e) => { journal.push(e); },
    });
    assert.equal(code, 1);
    assert.match(out.chunks.join(''), /approve-raise/);
    assert.equal(journal.length, 0);
  });

  it('allows agent raise after owner approval and logs the change', async () => {
    const root = await tempDir('dl-h2b-');
    const env = { HOME: root, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg') };
    const out = { chunks: [], write(s) { this.chunks.push(s); } };
    const journal = [];
    await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
    await fs.writeFile(path.join(root, BUDGET_RAISE_APPROVAL_REL), JSON.stringify({
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      by: 'owner',
      request: { machine: false, patch: { usd: 12 } },
    }), { mode: 0o600 });
    const code = await budgetCommand(['set', '--daily', '12'], {
      out,
      env,
      root,
      fs,
      homedir: () => root,
      appendEvent: async (r, e) => { journal.push(e); },
    });
    assert.equal(code, 0);
    const log = await fs.readFile(path.join(root, BUDGET_SET_LOG_REL), 'utf8');
    assert.match(log, /"who":"agent-session"/);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].kind, 'command');
  });

  it('always allows lowering from an agent session', async () => {
    const root = await tempDir('dl-h2c-');
    const projectFile = path.join(root, '.swarm', 'project', 'daily-limit.json');
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, JSON.stringify({ usd: 20, mode: 'notify' }) + '\n', { mode: 0o600 });
    const env = { HOME: root, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg') };
    const code = await budgetCommand(['set', '--daily', '8', '--mode', 'stop'], {
      out: { write() {} },
      env,
      root,
      fs,
      homedir: () => root,
      appendEvent: async () => {},
    });
    assert.equal(code, 0);
    const saved = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    assert.equal(saved.usd, 8);
    assert.equal(saved.mode, 'stop');
  });
});

describe('finding 3 resolve sanitizes invalid layers', () => {
  it('falls back to defaults and reports invalid fields', () => {
    const r = resolveDailyLimit({ project: { usd: Number.NaN, mode: 'halt', ceilingUsd: 1 } });
    assert.equal(r.dailyLimitUsd, 2.5);
    assert.equal(r.dailyLimitMode, 'stop');
    assert.equal(r.hardCeilingUsd, 7.5);
    assert.ok(r.reports.length >= 1);
  });
});

describe('finding 4 in-flight reservations count toward the limit', () => {
  it('blocks a second launch that would exceed stop with reservations', async () => {
    const dir = await tempDir('dl-h4-');
    const root = '/fixture';
    const now = () => ms('2024-06-15T15:00:00.000Z');
    const dailyLimit = { settings: { project: { usd: 5, mode: 'stop' } }, project: 'demo' };
    const base = {
      dir,
      lane: 'openrouter',
      runId: 'r',
      root,
      tokens: 1,
      budget: resolveBudget({ cli: { maxUsd: 100 } }),
      runTotals: { usd: 0, tokens: 0 },
      now,
      dailyLimit,
    };
    const first = await reserveSpend({ ...base, key: 'a', jobId: 'a', usd: 3 });
    assert.equal(first.decision, null);
    const second = await reserveSpend({ ...base, key: 'b', jobId: 'b', usd: 3 });
    assert.equal(second.decision?.reason, 'daily-limit');
    assert.equal(second.decision?.action, 'stop');
  });
});

describe('finding 5 per-project billed and notified state', () => {
  it('scopes billed totals and notified markers by root', async () => {
    const dir = await tempDir('dl-h5-');
    const now = () => ms('2024-06-15T15:00:00.000Z');
    const at = now();
    await withSpendStore(store => {
      store.entries.a = {
        day: new Date(at).toISOString().slice(0, 10),
        lane: 'openrouter',
        runId: 'r',
        root: '/project-a',
        jobId: 'a',
        usd: 4,
        tokens: 0,
        kind: 'actual',
        pid: process.pid,
        host: os.hostname(),
        at: new Date(at).toISOString(),
        flagged: false,
      };
      store.entries.b = {
        day: new Date(at).toISOString().slice(0, 10),
        lane: 'openrouter',
        runId: 'r',
        root: '/project-b',
        jobId: 'b',
        usd: 9,
        tokens: 0,
        kind: 'actual',
        pid: process.pid,
        host: os.hostname(),
        at: new Date(at).toISOString(),
        flagged: false,
      };
      assert.equal(billedMeteredTodayUsd(store, { now, root: '/project-a' }), 4);
      assert.equal(billedMeteredTodayUsd(store, { now, root: '/project-b' }), 9);
      store.dailyLimitByRoot = {
        [path.resolve('/project-a')]: { day: '2024-06-15', notified: [1] },
        [path.resolve('/project-b')]: { day: '2024-06-15', notified: [2] },
      };
    }, { dir, now });
    const totalA = await billedTodayUsd('/project-a', now, { dir });
    assert.equal(totalA, 4);
  });
});

describe('finding 6 notify delivery before dedupe marker', () => {
  it('retries when delivery fails and does not mark notified', async () => {
    const root = await tempDir('dl-h6-');
    let fail = true;
    const deps = {
      root,
      now: () => ms('2030-06-15T18:00:00.000Z'),
      fs,
      writeBoardBanner: async () => {
        if (fail) throw new Error('banner down');
      },
      appendSummaryLine: async () => {},
    };
    const settings = { project: { usd: 5, mode: 'notify', ceilingUsd: 15 } };
    const first = await notifyDailyLimit({ project: 'demo', level: 1, billedTodayUsd: 5, settings, deps });
    assert.equal(first.sent, false);
    assert.equal(first.reason, 'delivery-failed');
    await assert.rejects(fs.access(path.join(root, NOTIFIER_STATE_REL)));
    const log = await fs.readFile(path.join(root, NOTIFY_FAIL_LOG_REL), 'utf8');
    assert.match(log, /banner down/);
    fail = false;
    const second = await notifyDailyLimit({ project: 'demo', level: 1, billedTodayUsd: 5, settings, deps });
    assert.equal(second.sent, true);
  });
});

describe('finding 7 machine config mode preserved', () => {
  it('does not chmod machine config to 644', async () => {
    const root = await tempDir('dl-h7-');
    const configDir = path.join(root, 'cfg');
    const configFile = path.join(configDir, 'config.json');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({ spend: { projectMaxUsd: 1 } }) + '\n', { mode: 0o600 });
    const env = { SWARM_CONFIG: configFile, HOME: root };
    await budgetCommand(['set', '--machine', '--daily', '6'], {
      out: { write() {} },
      env,
      root,
      fs,
      homedir: () => root,
      appendEvent: async () => {},
      ...ownerTerminal,
    });
    const stat = await fs.stat(configFile);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe('finding 8 notify levels and human items', () => {
  it('does not notify level 4 and ceiling uses a human item title', async () => {
    const notify = evaluateDailyLimit({
      settings: { project: { usd: 5, mode: 'notify', ceilingUsd: 100 } },
      billedTodayUsd: 25,
      lane: 'openrouter',
      notifiedLevels: [1, 2, 3],
    });
    assert.deepEqual(notify.notify, []);
    const root = await tempDir('dl-h8-');
    const journal = [];
    await notifyDailyLimit({
      project: 'demo',
      level: 'ceiling',
      billedTodayUsd: 15,
      settings: { project: { usd: 5, mode: 'notify', ceilingUsd: 15 } },
      deps: {
        root,
        now: () => ms('2030-06-15T18:00:00.000Z'),
        fs,
        appendEvent: async (r, e) => { journal.push(e); },
        writeBoardBanner: async () => {},
        appendSummaryLine: async () => {},
      },
    });
    assert.equal(journal.length, 1);
    assert.match(journal[0].title, /hard ceiling/i);
    assert.doesNotMatch(journal[0].title, /FYI/);
  });
});

describe('refusal message documents owner approval', () => {
  it('mentions approve-raise and owner decides spend caps', () => {
    assert.match(agentBudgetRaiseRefusalMessage(), /approve-raise/);
    assert.match(agentBudgetRaiseRefusalMessage(), /owner decides spend caps/i);
  });
});
