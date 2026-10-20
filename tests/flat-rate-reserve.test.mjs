// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateReservation, flatRateReserve, capDecision } from '../tools/spend.mjs';

const history = [0.9, 0.9, 0.9, 0.9, 0.9];

test('codex, cursor, hermes, and qwen reserve $0 even with five finished jobs at $0.9 each', () => {
  for (const lane of ['codex', 'cursor', 'hermes', 'qwen']) {
    assert.equal(flatRateReserve({ lane, model: 'any', history }), 0, lane);
    assert.equal(estimateReservation({ job: {}, lane, model: 'any', inputChars: 0, rates: null, flatHistory: history }).usd, 0, lane);
  }
});

test('claude opus still reserves $1.00; anthropic (metered) still reserves lane default $0.5', () => {
  assert.equal(flatRateReserve({ lane: 'claude', model: 'opus' }), 1.0);
  assert.equal(estimateReservation({ job: {}, lane: 'claude', model: 'opus', inputChars: 0, rates: null }).usd, 1.0);
  assert.equal(estimateReservation({ job: {}, lane: 'anthropic', model: 'claude-sonnet', inputChars: 0, rates: null }).usd, 0.5);
  assert.equal(estimateReservation({ job: {}, lane: 'anthropic', model: 'claude-sonnet', inputChars: 0, rates: null }).source, 'lane-default');
});

test('capDecision: Codex in flight reserves nothing, so another Codex job or split is allowed under a $10 cap', () => {
  const budget = { maxUsd: 10, maxTokens: null, lanes: {} };
  const run = { usd: 0, tokens: 0 };
  const codexReserve = estimateReservation({ job: {}, lane: 'codex', model: 'gpt-5', inputChars: 0, rates: null });
  assert.equal(codexReserve.usd, 0);
  assert.equal(capDecision({ budget, run, laneToday: {}, agent: 'codex', add: { usd: codexReserve.usd, tokens: 0 } }), null, 'first Codex job');
  const runWithCodex = { usd: 0, tokens: 0 };
  assert.equal(capDecision({ budget, run: runWithCodex, laneToday: {}, agent: 'codex', add: { usd: 0, tokens: 0 } }), null, 'another Codex job while one is in flight');
  for (let i = 0; i < 5; i++) {
    assert.equal(capDecision({ budget, run: runWithCodex, laneToday: {}, agent: 'codex', add: { usd: 0, tokens: 0 } }), null, `split job ${i + 1}`);
  }
});

test('capDecision: anthropic reservation $0.5 with $9.8 already reserved refuses the run', () => {
  const budget = { maxUsd: 10, maxTokens: null, lanes: {} };
  const refused = capDecision({ budget, run: { usd: 9.8, tokens: 0 }, laneToday: {}, agent: 'anthropic', add: { usd: 0.5, tokens: 0 } });
  assert.equal(refused?.reason, 'run-cap');
});
