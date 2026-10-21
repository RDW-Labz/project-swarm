// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accrueSpend,
  billedMeteredTodayUsd,
  settleSpend,
  withSpendStore,
} from '../tools/spend.mjs';
import { resolveDailyLimit } from '../tools/daily-limit.mjs';
import {
  notifyDailyLimit,
  notifierDedupeKey,
  NOTIFIER_STATE_REL,
} from '../tools/daily-limit-notify.mjs';
import {
  budgetCommand,
  budgetSetActor,
  BUDGET_RAISE_APPROVAL_REL,
  BUDGET_RAISE_PENDING_REL,
  writeOwnerBudgetApproval,
} from '../tools/budget-set-commands.mjs';

const ms = iso => Date.parse(iso);
const ownerTerminal = { stdinIsTTY: true, stdoutIsTTY: true };

async function tempDir(prefix) {
  return await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), prefix));
}

describe('round4 (1) machine budget set compares machine layer only', () => {
  it('agent cannot raise machine defaults while a high project override masks effective limits', async () => {
    const root = await tempDir('r4-1-');
    const home = await tempDir('r4-1-home-');
    const configFile = path.join(home, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5, mode: 'stop' } }) + '\n', { mode: 0o600 });
    const projectFile = path.join(root, '.swarm', 'project', 'daily-limit.json');
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, JSON.stringify({ usd: 200, mode: 'stop', ceilingUsd: 600 }) + '\n', { mode: 0o600 });

    const env = { SWARM_CONFIG: configFile, HOME: home, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(home, 'xdg') };
    const out = { chunks: [], write(s) { this.chunks.push(s); } };
    const code = await budgetCommand(['set', '--machine', '--daily', '50'], {
      out,
      env,
      root,
      fs,
      homedir: () => home,
      appendEvent: async () => {},
    });
    assert.equal(code, 1);
    assert.match(out.chunks.join(''), /approve-raise/);
    const machine = JSON.parse(await fs.readFile(configFile, 'utf8'));
    assert.equal(machine.dailyLimit.usd, 5);
  });

  it('project set still compares against effective project limits', async () => {
    const root = await tempDir('r4-1b-');
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
  });
});

describe('round4 (2) accrueSpend without root uses machine-wide billing', () => {
  it('applies machine settings against all projects billed today', async () => {
    const dir = await tempDir('r4-2-');
    const home = await tempDir('r4-2-home-');
    const configFile = path.join(home, 'cfg.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5, mode: 'stop' } }) + '\n', { mode: 0o600 });
    const now = () => ms('2024-06-15T15:00:00.000Z');
    await withSpendStore(store => {
      store.entries.seed = {
        day: '2024-06-15',
        lane: 'openrouter',
        runId: 'r',
        root: '/other',
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

    const blocked = await accrueSpend({
      dir,
      key: 'rental',
      lane: 'rented',
      runId: 'r',
      root: undefined,
      jobId: 'rental',
      usd: 1,
      now,
      env: { SWARM_CONFIG: configFile, HOME: home },
      homedir: () => home,
    });
    assert.equal(blocked.decision?.reason, 'daily-limit');
    const billed = await withSpendStore(store => billedMeteredTodayUsd(store, { now, root: undefined }), { dir, now });
    assert.equal(billed, 6);
  });
});

describe('round4 (3) machine ceiling below project daily and budget set reports', () => {
  it('honors explicit machine ceiling and prints effective report after set', async () => {
    const resolved = resolveDailyLimit({ machine: { ceilingUsd: 8 }, project: { usd: 10 } });
    assert.equal(resolved.hardCeilingUsd, 8);
    assert.ok(resolved.reports.some(line => /machine\.ceilingUsd is below the project daily limit/.test(line)));

    const root = await tempDir('r4-3-');
    const home = await tempDir('r4-3-home-');
    const configFile = path.join(home, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5, ceilingUsd: 8 } }) + '\n', { mode: 0o600 });
    await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.swarm', 'project', 'daily-limit.json'),
      JSON.stringify({ usd: 10 }) + '\n',
      { mode: 0o600 },
    );
    const env = { SWARM_CONFIG: configFile, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
    const out = { chunks: [], write(s) { this.chunks.push(s); } };
    const code = await budgetCommand(['set', '--daily', '11'], {
      out,
      env,
      root,
      fs,
      homedir: () => home,
      appendEvent: async () => {},
      ...ownerTerminal,
    });
    assert.equal(code, 0);
    assert.match(out.chunks.join(''), /machine\.ceilingUsd is below the project daily limit/);
  });
});

describe('round4 (4) owner terminal detection and bound approval', () => {
  it('requires stdin and stdout TTY and rejects agent env prefixes', () => {
    assert.equal(budgetSetActor({}, { stdinIsTTY: true, stdoutIsTTY: true, overlay: {} }), 'owner-terminal');
    assert.equal(budgetSetActor({}, { stdinIsTTY: true, stdoutIsTTY: false, overlay: {} }), 'agent-session');
    assert.equal(
      budgetSetActor({ CURSOR_SESSION: '1' }, { stdinIsTTY: true, stdoutIsTTY: true, overlay: { CURSOR_SESSION: '1' } }),
      'agent-session',
    );
    assert.equal(
      budgetSetActor({ TERM_PROGRAM: 'cursor' }, { stdinIsTTY: true, stdoutIsTTY: true, overlay: {} }),
      'agent-session',
    );
    assert.equal(
      budgetSetActor({ CODEX: '1' }, { stdinIsTTY: true, stdoutIsTTY: true, overlay: { CODEX: '1' } }),
      'agent-session',
    );
  });

  it('refuses approval files with no request field', async () => {
    const root = await tempDir('r4-4-');
    const projectFile = path.join(root, '.swarm', 'project', 'daily-limit.json');
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, JSON.stringify({ usd: 5, mode: 'stop', ceilingUsd: 15 }) + '\n', { mode: 0o600 });
    const env = { HOME: root, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg') };
    const now = () => ms('2024-06-15T15:00:00.000Z');
    await writeOwnerBudgetApproval(fs, root, { now });
    const out = { chunks: [], write(s) { this.chunks.push(s); } };
    const code = await budgetCommand(['set', '--daily', '20', '--ceiling', '60'], {
      out,
      env,
      root,
      fs,
      homedir: () => root,
      now,
      appendEvent: async () => {},
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(await fs.readFile(projectFile, 'utf8')).usd, 5);
    await fs.writeFile(
      path.join(root, BUDGET_RAISE_PENDING_REL),
      `${JSON.stringify({ at: new Date(now()).toISOString(), request: { machine: false, patch: { usd: 20, ceilingUsd: 60 } } })}\n`,
      { mode: 0o600 },
    );
    await budgetCommand(['approve-raise', '--yes'], {
      out: { write() {} },
      env: { HOME: root, XDG_CONFIG_HOME: path.join(root, 'xdg') },
      root,
      fs,
      homedir: () => root,
      now,
      ...ownerTerminal,
    });
    const approval = JSON.parse(await fs.readFile(path.join(root, BUDGET_RAISE_APPROVAL_REL), 'utf8'));
    assert.ok(approval.request);
    assert.deepEqual(approval.request.patch, { usd: 20, ceilingUsd: 60 });
    assert.equal(
      await budgetCommand(['set', '--daily', '20', '--ceiling', '60'], {
        out: { write() {} },
        env,
        root,
        fs,
        homedir: () => root,
        now,
        appendEvent: async () => {},
      }),
      0,
    );
  });
});

describe('round4 extras notifier realpath and settle day', () => {
  it('dedupes notifier state via realpath across symlinked roots', async () => {
    const realRoot = await tempDir('r4-n-real-');
    const linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
    await fs.symlink(realRoot, linkRoot);
    const now = () => ms('2030-06-15T18:00:00.000Z');
    const deps = {
      now,
      fs,
      writeBoardBanner: async () => {},
      appendSummaryLine: async () => {},
      appendFyiNote: async () => {},
    };
    await notifyDailyLimit({
      project: 'demo',
      level: 1,
      billedTodayUsd: 5,
      settings: { project: { usd: 5, mode: 'notify', ceilingUsd: 15 } },
      deps: { ...deps, root: realRoot },
    });
    const second = await notifyDailyLimit({
      project: 'other-name',
      level: 1,
      billedTodayUsd: 5,
      settings: { project: { usd: 5, mode: 'notify', ceilingUsd: 15 } },
      deps: { ...deps, root: linkRoot },
    });
    assert.equal(second.reason, 'deduped');
    const stateFile = path.join(notifierDedupeKey(realRoot), NOTIFIER_STATE_REL);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.ok(Object.keys(state.byProject).length >= 1);
  });

  it('settleSpend bills on settle day after Central midnight while keeping reservation day', async () => {
    const dir = await tempDir('r4-settle-');
    const root = await tempDir('r4-settle-root-');
    const reserveDay = '2024-06-14';
    const settleAt = ms('2024-06-15T05:30:00.000Z');
    await withSpendStore(store => {
      store.entries.job = {
        day: reserveDay,
        lane: 'openrouter',
        runId: 'r',
        root,
        jobId: 'job',
        usd: 0.5,
        tokens: 0,
        kind: 'reservation',
        pid: process.pid,
        host: os.hostname(),
        at: new Date(ms('2024-06-15T04:30:00.000Z')).toISOString(),
        flagged: false,
      };
    }, { dir, now: () => settleAt });

    await settleSpend({
      dir,
      key: 'job',
      usd: 2,
      tokens: 10,
      kind: 'actual',
      flagged: false,
      now: () => settleAt,
    });

    const entry = await withSpendStore(store => store.entries.job, { dir, now: () => settleAt });
    assert.equal(entry.day, reserveDay);
    const billedReserveDay = await withSpendStore(
      store => billedMeteredTodayUsd(store, { now: () => ms('2024-06-15T04:30:00.000Z'), root }),
      { dir, now: () => settleAt },
    );
    const billedSettleDay = await withSpendStore(
      store => billedMeteredTodayUsd(store, { now: () => settleAt, root }),
      { dir, now: () => settleAt },
    );
    assert.equal(billedReserveDay, 0);
    assert.equal(billedSettleDay, 2);
  });
});
