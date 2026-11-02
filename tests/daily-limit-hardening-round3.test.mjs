// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  billedMeteredTodayUsd,
  reserveSpend,
  accrueSpend,
  resolveBudget,
  withSpendStore,
} from '../tools/spend.mjs';
import { resolveDailyLimit } from '../tools/daily-limit.mjs';
import {
  notifyDailyLimit,
  NOTIFIER_STATE_REL,
} from '../tools/daily-limit-notify.mjs';
import {
  budgetCommand,
  budgetSetActor,
  BUDGET_SET_LOG_REL,
  BUDGET_RAISE_APPROVAL_REL,
  BUDGET_RAISE_PENDING_REL,
  BUDGET_SET_MACHINE_LOG_BASENAME,
  raisedTodayUsdFromLog,
  raisedTodayUsdFromLogLines,
  needsOwnerApproval,
  raiseDeltaUsd,
  writeOwnerBudgetApproval,
} from '../tools/budget-set-commands.mjs';

const ms = iso => Date.parse(iso);
const ownerTerminal = { stdinIsTTY: true, stdoutIsTTY: true };

async function tempDir(prefix) {
  return await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), prefix));
}

describe('round3 (1) per-field budget approval', () => {
  it('lowering daily does not excuse raising ceiling or switching to notify', async () => {
    const root = await tempDir('r3-1-');
    const projectFile = path.join(root, '.swarm', 'project', 'daily-limit.json');
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, JSON.stringify({ usd: 10, mode: 'stop', ceilingUsd: 30 }) + '\n', { mode: 0o600 });
    const env = { HOME: root, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg') };
    const out = { chunks: [], write(s) { this.chunks.push(s); } };
    const code = await budgetCommand(['set', '--daily', '4', '--ceiling', '500'], {
      out,
      env,
      root,
      fs,
      homedir: () => root,
      appendEvent: async () => {},
    });
    assert.equal(code, 1);
    assert.match(out.chunks.join(''), /approve-raise/);
    const saved = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    assert.equal(saved.usd, 10);

    out.chunks = [];
    const code2 = await budgetCommand(['set', '--daily', '4', '--mode', 'notify'], {
      out,
      env,
      root,
      fs,
      homedir: () => root,
      appendEvent: async () => {},
    });
    assert.equal(code2, 1);
    assert.equal(JSON.parse(await fs.readFile(projectFile, 'utf8')).mode, 'stop');
  });
});

describe('round3 (2) cumulative allowance and bound approval', () => {
  it('tracks raises in the log per Central day and binds approval to the exact patch', async () => {
    const root = await tempDir('r3-2-');
    const env = { HOME: root, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg') };
    const now = () => ms('2024-06-15T15:00:00.000Z');
    const out = { chunks: [], write(s) { this.chunks.push(s); } };
    const beforeDefault = { usd: 2.5, mode: 'stop', ceilingUsd: 7.5 };

    assert.equal(await budgetCommand(['set', '--daily', '6'], { out, env, root, fs, homedir: () => root, now, appendEvent: async () => {} }), 1);
    let pending = JSON.parse(await fs.readFile(path.join(root, BUDGET_RAISE_PENDING_REL), 'utf8'));
    assert.deepEqual(pending.request.patch, { usd: 6 });

    await writeOwnerBudgetApproval(fs, root, { request: pending.request, now });
    assert.equal(await budgetCommand(['set', '--daily', '6'], { out: { write() {} }, env, root, fs, homedir: () => root, now, appendEvent: async () => {} }), 0);
    const afterSix = { usd: 6, mode: 'stop', ceilingUsd: 18 };
    const raised = await raisedTodayUsdFromLog(fs, { root, machine: false, machineConfigFile: '', now });
    assert.equal(raised, raiseDeltaUsd(beforeDefault, afterSix, { usd: 6 }));

    out.chunks = [];
    assert.equal(await budgetCommand(['set', '--daily', '7'], { out, env, root, fs, homedir: () => root, now, appendEvent: async () => {} }), 1);
    pending = JSON.parse(await fs.readFile(path.join(root, BUDGET_RAISE_PENDING_REL), 'utf8'));
    assert.deepEqual(pending.request.patch, { usd: 7 });

    await writeOwnerBudgetApproval(fs, root, { request: pending.request, now });
    const approval = JSON.parse(await fs.readFile(path.join(root, BUDGET_RAISE_APPROVAL_REL), 'utf8'));
    assert.deepEqual(approval.request.patch, { usd: 7 });

    assert.equal(await budgetCommand(['set', '--daily', '8'], { out: { write() {} }, env, root, fs, homedir: () => root, now, appendEvent: async () => {} }), 1);

    assert.equal(await budgetCommand(['set', '--daily', '7'], { out: { write() {} }, env, root, fs, homedir: () => root, now, appendEvent: async () => {} }), 0);
    await assert.rejects(fs.access(path.join(root, BUDGET_RAISE_PENDING_REL)));
    await assert.rejects(fs.access(path.join(root, BUDGET_RAISE_APPROVAL_REL)));
  });
});

describe('round3 (3) rented accrueSpend incremental and refusal spend', () => {
  it('uses incremental rental cost and still records spend on refusal', async () => {
    const dir = await tempDir('r3-3-');
    const root = await tempDir('r3-3-root-');
    const now = () => ms('2024-06-15T15:00:00.000Z');
    const dailyLimit = { settings: { project: { usd: 5, mode: 'stop', ceilingUsd: 15 } }, project: 'demo' };
    await withSpendStore(store => {
      store.entries.rental = {
        day: '2024-06-15',
        lane: 'rented',
        runId: 'r',
        root,
        jobId: 'rental',
        usd: 4,
        tokens: 0,
        kind: 'estimated',
        pid: process.pid,
        host: os.hostname(),
        at: new Date(now()).toISOString(),
        flagged: false,
      };
    }, { dir, now });

    const blocked = await accrueSpend({
      dir,
      key: 'rental',
      lane: 'rented',
      runId: 'r',
      root,
      jobId: 'rental',
      usd: 10,
      now,
      dailyLimit,
    });
    assert.equal(blocked.decision?.action, 'stop');
    const billed = await withSpendStore(store => billedMeteredTodayUsd(store, { now, root }), { dir, now });
    assert.equal(billed, 10);
  });
});

describe('round3 (4) notice delivery marks spend store after success', () => {
  it('does not mark spend notified until notifyDailyLimit succeeds', async () => {
    const dir = await tempDir('r3-4-');
    const root = await tempDir('r3-4-root-');
    const now = () => ms('2024-06-15T15:00:00.000Z');
    const dailyLimit = { settings: { project: { usd: 5, mode: 'notify', ceilingUsd: 100 } }, project: 'demo' };
    await withSpendStore(store => {
      store.entries.seed = {
        day: '2024-06-15',
        lane: 'openrouter',
        runId: 'r',
        root,
        jobId: 'seed',
        usd: 5,
        tokens: 0,
        kind: 'actual',
        pid: process.pid,
        host: os.hostname(),
        at: new Date(now()).toISOString(),
        flagged: false,
      };
    }, { dir, now });

    const first = await reserveSpend({
      dir,
      key: 'k',
      lane: 'openrouter',
      runId: 'r',
      root,
      jobId: 'k',
      usd: 0.1,
      tokens: 1,
      budget: resolveBudget({ cli: { maxUsd: 100 } }),
      runTotals: { usd: 0, tokens: 0 },
      now,
      dailyLimit,
    });
    assert.ok(first.dailyLimit?.notices?.length);
    const stateAfterDelivery = await withSpendStore(store => {
      const key = Object.keys(store.dailyLimitByRoot ?? {})[0];
      return store.dailyLimitByRoot?.[key]?.notified ?? [];
    }, { dir, now });
    assert.ok(stateAfterDelivery.includes(1));

    const third = await reserveSpend({
      dir,
      key: 'k2',
      lane: 'openrouter',
      runId: 'r',
      root,
      jobId: 'k2',
      usd: 0.1,
      tokens: 1,
      budget: resolveBudget({ cli: { maxUsd: 100 } }),
      runTotals: { usd: 0, tokens: 0 },
      now,
      dailyLimit,
    });
    assert.deepEqual(third.dailyLimit?.notices ?? [], []);
  });
});

describe('round3 (5) paid lane without project root uses machine limit', () => {
  it('applies machine settings against machine-wide billed totals', async () => {
    const dir = await tempDir('r3-5-');
    const home = await tempDir('r3-5-home-');
    const configFile = path.join(home, 'cfg', 'config.json');
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5, mode: 'stop' } }) + '\n', { mode: 0o600 });
    const now = () => ms('2024-06-15T15:00:00.000Z');
    await withSpendStore(store => {
      store.entries.a = {
        day: '2024-06-15',
        lane: 'openrouter',
        runId: 'r',
        root: '/other-project',
        jobId: 'a',
        usd: 5,
        tokens: 0,
        kind: 'actual',
        pid: process.pid,
        host: os.hostname(),
        at: new Date(now()).toISOString(),
        flagged: false,
      };
    }, { dir, now });

    const blocked = await reserveSpend({
      dir,
      key: 'k',
      lane: 'openrouter',
      runId: 'r',
      root: undefined,
      jobId: 'k',
      usd: 0.5,
      tokens: 1,
      budget: resolveBudget({ cli: { maxUsd: 100 } }),
      runTotals: { usd: 0, tokens: 0 },
      now,
      env: { SWARM_CONFIG: configFile, HOME: home },
      homedir: () => home,
    });
    assert.equal(blocked.decision?.reason, 'daily-limit');
  });
});

describe('round3 (6) implied ceiling when raising usd only', () => {
  it('counts implied 3x ceiling growth toward approval', () => {
    const before = { usd: 5, mode: 'stop', ceilingUsd: 15 };
    const after = { usd: 10, mode: 'stop', ceilingUsd: 30 };
    const patch = { usd: 10 };
    assert.equal(raiseDeltaUsd(before, after, patch), 20);
    assert.equal(needsOwnerApproval(before, after, patch, 0), true);
  });
});

describe('round3 (7) changelog before settings and machine log', () => {
  it('writes project log before daily-limit.json and machine changes to machine log', async () => {
    const root = await tempDir('r3-7-');
    const home = await tempDir('r3-7-home-');
    const configFile = path.join(home, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5 } }) + '\n', { mode: 0o600 });
    const env = { SWARM_CONFIG: configFile, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
    const projectFile = path.join(root, '.swarm', 'project', 'daily-limit.json');

    let logSeen = false;
    const origAppend = fs.appendFile.bind(fs);
    const patchedFs = {
      ...fs,
      appendFile: async (file, data, opts) => {
        if (String(file).endsWith('daily-limit-set.log') && !logSeen) {
          logSeen = true;
          await assert.rejects(fs.access(projectFile));
        }
        return origAppend(file, data, opts);
      },
    };

    await budgetCommand(['set', '--daily', '6'], {
      out: { write() {} },
      env,
      root,
      fs: patchedFs,
      homedir: () => home,
      appendEvent: async () => {},
      ...ownerTerminal,
    });
    assert.ok(logSeen);

    await budgetCommand(['set', '--machine', '--daily', '7'], {
      out: { write() {} },
      env,
      root,
      fs,
      homedir: () => home,
      appendEvent: async () => {},
      ...ownerTerminal,
    });
    const machineLog = path.join(path.dirname(configFile), BUDGET_SET_MACHINE_LOG_BASENAME);
    const log = await fs.readFile(machineLog, 'utf8');
    assert.match(log, /"machine":true/);
  });
});

describe('round3 (8) realpath root matching', () => {
  it('matches billed totals across symlinked project roots', async () => {
    const dir = await tempDir('r3-8-');
    const realRoot = await tempDir('r3-8-real-');
    const linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
    await fs.symlink(realRoot, linkRoot);
    const now = () => ms('2024-06-15T15:00:00.000Z');
    await withSpendStore(store => {
      store.entries.e = {
        day: '2024-06-15',
        lane: 'openrouter',
        runId: 'r',
        root: realRoot,
        jobId: 'e',
        usd: 3,
        tokens: 0,
        kind: 'actual',
        pid: process.pid,
        host: os.hostname(),
        at: new Date(now()).toISOString(),
        flagged: false,
      };
    }, { dir, now });
    const viaLink = await withSpendStore(store => billedMeteredTodayUsd(store, { now, root: linkRoot }), { dir, now });
    assert.equal(viaLink, 3);
  });
});

describe('round3 (9) raisedTodayUsd uses Central day', () => {
  it('ignores log lines from other Central days', () => {
    const lines = [
      JSON.stringify({ day: '2024-06-14', machine: false, raiseDeltaUsd: 4, refused: false }),
      JSON.stringify({ day: '2024-06-15', machine: false, raiseDeltaUsd: 2, refused: false }),
    ];
    assert.equal(raisedTodayUsdFromLogLines(lines, { day: '2024-06-15', machine: false }), 2);
  });
});

describe('round3 (10) agent detection and corrupt notifier state', () => {
  it('treats CODEX as an agent session and replaces corrupt notifier state', async () => {
    assert.equal(budgetSetActor({ CODEX: '1' }), 'agent-session');
    const root = await tempDir('r3-10-');
    const stateFile = path.join(root, NOTIFIER_STATE_REL);
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, '{not json', { mode: 0o600 });
    const result = await notifyDailyLimit({
      project: 'demo',
      level: 1,
      billedTodayUsd: 5,
      settings: { project: { usd: 5, mode: 'notify', ceilingUsd: 15 } },
      deps: {
        root,
        now: () => ms('2030-06-15T18:00:00.000Z'),
        fs,
        writeBoardBanner: async () => {},
        appendSummaryLine: async () => {},
        appendFyiNote: async () => {},
      },
    });
    assert.equal(result.sent, true);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.deepEqual(state.byProject.demo, [1]);
  });

  it('reports when machine ceiling is below project daily limit', () => {
    const r = resolveDailyLimit({ machine: { ceilingUsd: 8 }, project: { usd: 10 } });
    assert.ok(r.reports.some(line => /machine\.ceilingUsd is below the project daily limit/.test(line)));
  });
});
