// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseBudgetSetArgs, budgetCommand } from '../tools/budget-set-commands.mjs';

const ownerTerminal = { stdinIsTTY: true, stdoutIsTTY: true };

describe('parseBudgetSetArgs', () => {
  it('parses set and show', () => {
    assert.deepEqual(parseBudgetSetArgs(['budget', 'set', '--daily', '10', '--mode', 'notify', '--ceiling', '30']), {
      command: 'set',
      machine: false,
      values: { usd: 10, mode: 'notify', ceilingUsd: 30 },
    });
    assert.deepEqual(parseBudgetSetArgs(['budget', 'show', '--json']), { command: 'show', json: true });
  });

  it('validation errors', () => {
    assert.ok(parseBudgetSetArgs(['budget', 'set', '--daily', 'nope']).errors);
    assert.ok(parseBudgetSetArgs(['budget', 'set', '--mode', 'bad']).errors);
    assert.ok(parseBudgetSetArgs(['budget', 'set', '--daily', '10', '--ceiling', '5']).errors);
    assert.ok(parseBudgetSetArgs(['budget', 'set', '--daily', '10', '--bogus']).errors);
    assert.ok(parseBudgetSetArgs(['budget', 'set']).errors);
  });
});

describe('budgetCommand', () => {
  async function tempRoot() {
    return await fs.mkdtemp(path.join(os.tmpdir(), 'budget-set-'));
  }

  it('round trips machine config preserving other keys', async () => {
    const root = await tempRoot();
    const configDir = path.join(root, 'cfg');
    const configFile = path.join(configDir, 'config.json');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({ spend: { projectMaxUsd: 99 }, other: true }) + '\n');
    const env = { SWARM_CONFIG: configFile, HOME: root };
    const out = { chunks: [], write(s) { this.chunks.push(s); } };

    const code = await budgetCommand(['budget', 'set', '--machine', '--daily', '10', '--mode', 'notify'], {
      out,
      env,
      root,
      fs,
      homedir: () => root,
      ...ownerTerminal,
    });
    assert.equal(code, 0);
    const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
    assert.equal(saved.spend.projectMaxUsd, 99);
    assert.equal(saved.other, true);
    assert.deepEqual(saved.dailyLimit, { usd: 10, mode: 'notify' });

    out.chunks = [];
    const showCode = await budgetCommand(['budget', 'show', '--json'], {
      out,
      env,
      root,
      fs,
      homedir: () => root,
      billedToday: async () => 3.5,
    });
    assert.equal(showCode, 0);
    const shown = JSON.parse(out.chunks.join(''));
    assert.equal(shown.dailyLimitUsd, 10);
    assert.equal(shown.source, 'machine');
    assert.equal(shown.billedTodayUsd, 3.5);
    assert.ok(shown.resetsAt > Date.now() - 86400000);
  });

  it('round trips project file with mode 0600', async () => {
    const root = await tempRoot();
    const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'xdg') };
    const out = { chunks: [], write(s) { this.chunks.push(s); } };

    const code = await budgetCommand(['set', '--daily', '7', '--ceiling', '21'], {
      out,
      env,
      root,
      fs,
      homedir: () => root,
      ...ownerTerminal,
    });
    assert.equal(code, 0);
    const projectFile = path.join(root, '.swarm', 'project', 'daily-limit.json');
    const stat = await fs.stat(projectFile);
    assert.equal(stat.mode & 0o777, 0o600);
    const data = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    assert.deepEqual(data, { usd: 7, ceilingUsd: 21 });

    out.chunks = [];
    await budgetCommand(['show'], { out, env, root, fs, homedir: () => root });
    const text = out.chunks.join('');
    assert.match(text, /\[project\]/);
    assert.match(text, /\$7\.00/);
  });

  it('project overrides machine on show', async () => {
    const root = await tempRoot();
    const configFile = path.join(root, 'machine.json');
    await fs.writeFile(configFile, JSON.stringify({ dailyLimit: { usd: 20 } }) + '\n');
    const env = { SWARM_CONFIG: configFile, HOME: root };
    await budgetCommand(['set', '--daily', '9'], {
      out: { write() {} },
      env,
      root,
      fs,
      homedir: () => root,
      ...ownerTerminal,
    });
    const out = { chunks: [], write(s) { this.chunks.push(s); } };
    await budgetCommand(['show', '--json'], { out, env, root, fs, homedir: () => root });
    const shown = JSON.parse(out.chunks.join(''));
    assert.equal(shown.dailyLimitUsd, 9);
    assert.equal(shown.source, 'project');
  });
});
