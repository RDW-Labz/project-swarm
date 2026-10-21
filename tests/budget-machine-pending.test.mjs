// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  budgetCommand,
  BUDGET_RAISE_PENDING_REL,
  BUDGET_RAISE_PENDING_MACHINE_BASENAME,
  BUDGET_RAISE_APPROVAL_MACHINE_BASENAME,
  BUDGET_SET_MACHINE_LOG_BASENAME,
  OWNER_APPROVAL_TTL_MS,
  readBudgetSetLogLines,
} from '../tools/budget-set-commands.mjs';

const ms = iso => Date.parse(iso);
const ownerTerminal = { stdinIsTTY: true, stdoutIsTTY: true };

function ownerBudgetEnv(home) {
  return { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), TERM_PROGRAM: '' };
}

async function tempDir(prefix) {
  return await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), prefix));
}

function outCapture() {
  return { chunks: [], write(s) { this.chunks.push(s); } };
}

describe('machine-wide budget raise pending and approval', () => {
  it('agent machine raise is refused, pending file has requested values and mode 0600', async () => {
    const root = await tempDir('bmp-refuse-');
    const home = await tempDir('bmp-refuse-home-');
    const configFile = path.join(home, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5, mode: 'stop' } }) + '\n', { mode: 0o600 });
    const env = { SWARM_CONFIG: configFile, HOME: home, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(home, 'xdg') };
    const out = outCapture();
    const code = await budgetCommand(['set', '--machine', '--daily', '20'], {
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

    const pendingFile = path.join(path.dirname(configFile), BUDGET_RAISE_PENDING_MACHINE_BASENAME);
    const stat = await fs.stat(pendingFile);
    assert.equal(stat.mode & 0o777, 0o600);
    const pending = JSON.parse(await fs.readFile(pendingFile, 'utf8'));
    assert.equal(pending.request.machine, true);
    assert.deepEqual(pending.request.patch, { usd: 20 });

    const lines = await readBudgetSetLogLines(fs, { root, machineConfigFile: configFile, machine: true });
    const refused = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    assert.ok(refused.some(r => r.refused && r.patch.usd === 20));
  });

  it('approve-raise without --machine reports machine pending and approves nothing', async () => {
    const root = await tempDir('bmp-noflag-');
    const home = await tempDir('bmp-noflag-home-');
    const configFile = path.join(home, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5, mode: 'stop' } }) + '\n', { mode: 0o600 });
    const pendingFile = path.join(path.dirname(configFile), BUDGET_RAISE_PENDING_MACHINE_BASENAME);
    await fs.writeFile(
      pendingFile,
      `${JSON.stringify({ at: new Date().toISOString(), request: { machine: true, patch: { usd: 20 } } })}\n`,
      { mode: 0o600 },
    );
    const env = ownerBudgetEnv(home);
    const out = outCapture();
    const code = await budgetCommand(['approve-raise', '--yes'], {
      out,
      env: { ...env, SWARM_CONFIG: configFile },
      root,
      fs,
      homedir: () => home,
      ...ownerTerminal,
    });
    assert.equal(code, 1);
    assert.match(out.chunks.join(''), /--machine/);
    await fs.access(pendingFile);
    await assert.rejects(fs.access(path.join(path.dirname(configFile), BUDGET_RAISE_APPROVAL_MACHINE_BASENAME)));
  });

  it('owner approve-raise --machine records approval and clears pending; agent retry succeeds once', async () => {
    const root = await tempDir('bmp-flow-');
    const home = await tempDir('bmp-flow-home-');
    const configFile = path.join(home, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5, mode: 'stop' } }) + '\n', { mode: 0o600 });
    const agentEnv = { SWARM_CONFIG: configFile, HOME: home, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(home, 'xdg') };
    const now = () => ms('2024-06-15T15:00:00.000Z');
    const out = outCapture();

    assert.equal(
      await budgetCommand(['set', '--machine', '--daily', '20'], {
        out,
        env: agentEnv,
        root,
        fs,
        homedir: () => home,
        now,
        appendEvent: async () => {},
      }),
      1,
    );

    const pendingFile = path.join(path.dirname(configFile), BUDGET_RAISE_PENDING_MACHINE_BASENAME);
    assert.ok(await fs.stat(pendingFile));

    assert.equal(
      await budgetCommand(['approve-raise', '--machine', '--yes'], {
        out: { write() {} },
        env: { ...ownerBudgetEnv(home), SWARM_CONFIG: configFile },
        root,
        fs,
        homedir: () => home,
        now,
        ...ownerTerminal,
      }),
      0,
    );
    await assert.rejects(fs.access(pendingFile));
    const approvalFile = path.join(path.dirname(configFile), BUDGET_RAISE_APPROVAL_MACHINE_BASENAME);
    const approval = JSON.parse(await fs.readFile(approvalFile, 'utf8'));
    assert.deepEqual(approval.request.patch, { usd: 20 });

    assert.equal(
      await budgetCommand(['set', '--machine', '--daily', '20'], {
        out: { write() {} },
        env: agentEnv,
        root,
        fs,
        homedir: () => home,
        now,
        appendEvent: async () => {},
      }),
      0,
    );
    const machine = JSON.parse(await fs.readFile(configFile, 'utf8'));
    assert.equal(machine.dailyLimit.usd, 20);
    await assert.rejects(fs.access(approvalFile));
  });

  it('changed value, second retry, and expired approval are refused', async () => {
    const root = await tempDir('bmp-bind-');
    const home = await tempDir('bmp-bind-home-');
    const configFile = path.join(home, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5, mode: 'stop' } }) + '\n', { mode: 0o600 });
    const agentEnv = { SWARM_CONFIG: configFile, HOME: home, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(home, 'xdg') };
    const t0 = ms('2024-06-15T15:00:00.000Z');
    let nowMs = t0;
    const now = () => nowMs;

    await budgetCommand(['set', '--machine', '--daily', '20'], {
      out: { write() {} },
      env: agentEnv,
      root,
      fs,
      homedir: () => home,
      now,
      appendEvent: async () => {},
    });
    await budgetCommand(['approve-raise', '--machine', '--yes'], {
      out: { write() {} },
      env: { ...ownerBudgetEnv(home), SWARM_CONFIG: configFile },
      root,
      fs,
      homedir: () => home,
      now,
      ...ownerTerminal,
    });

    assert.equal(
      await budgetCommand(['set', '--machine', '--daily', '21'], {
        out: { write() {} },
        env: agentEnv,
        root,
        fs,
        homedir: () => home,
        now,
        appendEvent: async () => {},
      }),
      1,
    );

    assert.equal(
      await budgetCommand(['set', '--machine', '--daily', '20'], {
        out: { write() {} },
        env: agentEnv,
        root,
        fs,
        homedir: () => home,
        now,
        appendEvent: async () => {},
      }),
      0,
    );

    assert.equal(
      await budgetCommand(['set', '--machine', '--daily', '25'], {
        out: { write() {} },
        env: agentEnv,
        root,
        fs,
        homedir: () => home,
        now,
        appendEvent: async () => {},
      }),
      1,
    );

    nowMs = t0;
    await budgetCommand(['set', '--machine', '--daily', '25'], {
      out: { write() {} },
      env: agentEnv,
      root,
      fs,
      homedir: () => home,
      now,
      appendEvent: async () => {},
    });
    await budgetCommand(['approve-raise', '--machine', '--yes'], {
      out: { write() {} },
      env: { ...ownerBudgetEnv(home), SWARM_CONFIG: configFile },
      root,
      fs,
      homedir: () => home,
      now,
      ...ownerTerminal,
    });
    nowMs = t0 + OWNER_APPROVAL_TTL_MS + 1;
    assert.equal(
      await budgetCommand(['set', '--machine', '--daily', '25'], {
        out: { write() {} },
        env: agentEnv,
        root,
        fs,
        homedir: () => home,
        now,
        appendEvent: async () => {},
      }),
      1,
    );
  });

  it('approve-raise --machine inside an agent session is refused', async () => {
    const root = await tempDir('bmp-agent-appr-');
    const home = await tempDir('bmp-agent-appr-home-');
    const configFile = path.join(home, 'machine.json');
    const pendingFile = path.join(path.dirname(configFile), BUDGET_RAISE_PENDING_MACHINE_BASENAME);
    await fs.writeFile(
      pendingFile,
      `${JSON.stringify({ at: new Date().toISOString(), request: { machine: true, patch: { usd: 20 } } })}\n`,
      { mode: 0o600 },
    );
    const out = outCapture();
    const code = await budgetCommand(['approve-raise', '--machine', '--yes'], {
      out,
      env: { SWARM_CONFIG: configFile, HOME: home, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(home, 'xdg') },
      root,
      fs,
      homedir: () => home,
      ...ownerTerminal,
    });
    assert.equal(code, 1);
    assert.match(out.chunks.join(''), /owner terminal/);
    await fs.access(pendingFile);
  });

  it('project flow still works end to end; machine pending does not affect project set', async () => {
    const root = await tempDir('bmp-project-');
    const home = await tempDir('bmp-project-home-');
    const configFile = path.join(home, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 5, mode: 'stop' } }) + '\n', { mode: 0o600 });
    const projectFile = path.join(root, '.swarm', 'project', 'daily-limit.json');
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, JSON.stringify({ usd: 5, mode: 'stop', ceilingUsd: 15 }) + '\n', { mode: 0o600 });
    const machinePendingFile = path.join(path.dirname(configFile), BUDGET_RAISE_PENDING_MACHINE_BASENAME);
    await fs.writeFile(
      machinePendingFile,
      `${JSON.stringify({ at: new Date().toISOString(), request: { machine: true, patch: { usd: 50 } } })}\n`,
      { mode: 0o600 },
    );

    const agentEnv = { HOME: root, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg') };
    const now = () => ms('2024-06-15T15:00:00.000Z');

    assert.equal(
      await budgetCommand(['set', '--daily', '20', '--ceiling', '60'], {
        out: { write() {} },
        env: agentEnv,
        root,
        fs,
        homedir: () => root,
        now,
        appendEvent: async () => {},
      }),
      1,
    );
    const projectPending = JSON.parse(await fs.readFile(path.join(root, BUDGET_RAISE_PENDING_REL), 'utf8'));
    assert.deepEqual(projectPending.request.patch, { usd: 20, ceilingUsd: 60 });

    assert.equal(
      await budgetCommand(['approve-raise', '--yes'], {
        out: { write() {} },
        env: ownerBudgetEnv(root),
        root,
        fs,
        homedir: () => root,
        now,
        ...ownerTerminal,
      }),
      0,
    );
    assert.equal(
      await budgetCommand(['set', '--daily', '20', '--ceiling', '60'], {
        out: { write() {} },
        env: agentEnv,
        root,
        fs,
        homedir: () => root,
        now,
        appendEvent: async () => {},
      }),
      0,
    );
    assert.equal(JSON.parse(await fs.readFile(projectFile, 'utf8')).usd, 20);
    await fs.access(machinePendingFile);
  });

  it('owner lowering machine limit clears machine pending; machine log records steps', async () => {
    const root = await tempDir('bmp-lower-');
    const home = await tempDir('bmp-lower-home-');
    const configFile = path.join(home, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 10, mode: 'stop' } }) + '\n', { mode: 0o600 });
    const pendingFile = path.join(path.dirname(configFile), BUDGET_RAISE_PENDING_MACHINE_BASENAME);
    await fs.writeFile(
      pendingFile,
      `${JSON.stringify({ at: new Date().toISOString(), request: { machine: true, patch: { usd: 20 } } })}\n`,
      { mode: 0o600 },
    );
    const env = { SWARM_CONFIG: configFile, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
    assert.equal(
      await budgetCommand(['set', '--machine', '--daily', '8'], {
        out: { write() {} },
        env,
        root,
        fs,
        homedir: () => home,
        appendEvent: async () => {},
        ...ownerTerminal,
      }),
      0,
    );
    await assert.rejects(fs.access(pendingFile));
    const machineLog = path.join(path.dirname(configFile), BUDGET_SET_MACHINE_LOG_BASENAME);
    const logText = await fs.readFile(machineLog, 'utf8');
    assert.ok(logText.includes('"who":"owner-terminal"'));
    assert.ok(logText.includes('"usd":8'));
  });
});
