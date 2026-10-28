// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DAY_CAP_USD, PRICES } from '../tools/anthropic.mjs';
import { LANE_DAILY_DEFAULTS } from '../tools/spend.mjs';
import { MODEL_RATES, modelFamily } from '../tools/rates.mjs';
import { resolveDailyLimit } from '../tools/daily-limit.mjs';
import {
  budgetCommand,
  agentBudgetRaiseRefusalMessage,
  BUDGET_RAISE_APPROVAL_REL,
} from '../tools/budget-set-commands.mjs';

const ownerTerminal = { stdinIsTTY: true, stdoutIsTTY: true };

test('train2 money: anthropic day cap matches spend lane default', () => {
  assert.equal(DAY_CAP_USD, LANE_DAILY_DEFAULTS.anthropic.dailyUsd);
  assert.equal(DAY_CAP_USD, 20);
});

test('train2 money: MODEL_RATES and anthropic PRICES stay aligned', () => {
  const perTok = v => v / 1e6;
  assert.equal(MODEL_RATES.haiku.in, 0.10);
  assert.equal(MODEL_RATES.haiku.out, 0.50);
  const haiku = PRICES['claude-haiku-5-5'];
  assert.equal(haiku.input, perTok(MODEL_RATES.haiku.in));
  assert.equal(haiku.output, perTok(MODEL_RATES.haiku.out));
  assert.equal(haiku.longInput, perTok(MODEL_RATES.haiku.longIn));
  assert.equal(haiku.longOutput, perTok(MODEL_RATES.haiku.longOut));
  assert.equal(haiku.longAt, 100000);

  assert.deepEqual(
    { in: MODEL_RATES.sonnet.in, out: MODEL_RATES.sonnet.out, cacheRead: MODEL_RATES.sonnet.cacheRead },
    { in: 2, out: 10, cacheRead: 0.2 },
  );
  assert.deepEqual(
    { in: MODEL_RATES.opus.in, out: MODEL_RATES.opus.out, cacheRead: MODEL_RATES.opus.cacheRead },
    { in: 4, out: 20, cacheRead: 0.2 },
  );
  assert.deepEqual(
    { in: MODEL_RATES.fable.in, out: MODEL_RATES.fable.out, cacheRead: MODEL_RATES.fable.cacheRead },
    { in: 10, out: 50, cacheRead: 0.25 },
  );

  assert.equal(PRICES['claude-sonnet-5-5'].input, perTok(2));
  assert.equal(PRICES['claude-sonnet-5-5'].output, perTok(10));
  assert.equal(PRICES['claude-opus-5-5'].input, perTok(4));
  assert.equal(PRICES['claude-opus-5-5'].output, perTok(20));
});

test('train2 money: modelFamily recognises fable', () => {
  assert.equal(modelFamily('claude-fable-5-1'), 'fable');
});

test('train2 money: default daily limit is $2.50 stop with stop-mode ceiling', () => {
  const r = resolveDailyLimit({});
  assert.equal(r.dailyLimitUsd, 2.5);
  assert.equal(r.dailyLimitMode, 'stop');
  assert.equal(r.hardCeilingUsd, 7.5);
});

test('train2 money: agent raises need the owner; owner terminal still works', async () => {
  assert.match(agentBudgetRaiseRefusalMessage(), /owner decides spend caps/i);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'train2-money-'));
  const agentEnv = { HOME: root, CLAUDECODE: '1', XDG_CONFIG_HOME: path.join(root, 'xdg') };
  const out = { chunks: [], write(s) { this.chunks.push(s); } };
  const agentCode = await budgetCommand(['set', '--daily', '10'], {
    out,
    env: agentEnv,
    root,
    fs,
    homedir: () => root,
    appendEvent: async () => {},
  });
  assert.equal(agentCode, 1);
  assert.match(out.chunks.join(''), /owner decides spend caps/i);

  const ownerCode = await budgetCommand(['set', '--daily', '10'], {
    out: { write() {} },
    env: { HOME: root, XDG_CONFIG_HOME: path.join(root, 'xdg') },
    root,
    fs,
    homedir: () => root,
    appendEvent: async () => {},
    ...ownerTerminal,
  });
  assert.equal(ownerCode, 0);
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'project', 'daily-limit.json'), 'utf8'));
  assert.equal(saved.usd, 10);
  await assert.rejects(fs.access(path.join(root, BUDGET_RAISE_APPROVAL_REL)));
});
