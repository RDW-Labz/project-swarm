// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costPerMillionTokens, summarizeLane, qwenAtFullLoad, renderComparison } from '../bench/gpu-bakeoff/compare-lanes.mjs';

const results = [
  { taskId: 'a', pass: true, costUsd: 0.01, tokens: { input_tokens: 100, output_tokens: 50 }, durationMs: 2000 },
  { taskId: 'b', pass: false, costUsd: 0.02, tokens: 300, durationMs: 3000 },
  { taskId: 'c', pass: true, costUsd: null, tokens: { total_tokens: 70 }, durationMs: 1000 },
];
const hard = { passedAll: true, costUsd: 0.03, tokens: 500, seconds: 4 };

function qwenFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-test-'));
  try {
    const detailsFile = path.join(dir, 'details.json');
    fs.writeFileSync(detailsFile, JSON.stringify([
      { pass: true, tokens: 1000 },
      { pass: true, tokens: 2000 },
      { pass: false, tokens: 3000 },
      { pass: true, tokens: null },
    ]));
    return qwenAtFullLoad({ detailsFile, hardTokens: 4000, hardPassed: true, hourlyUsd: 3.6, tokensPerSecond: 1000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('costPerMillionTokens rounds to 4 decimals', () => {
  const expected = Math.round(1.807 / (3718 * 3600) * 1e6 * 1e4) / 1e4;
  assert.equal(costPerMillionTokens({ hourlyUsd: 1.807, tokensPerSecond: 3718 }), expected);
  assert.equal(expected, 0.135);
});

test('summarizeLane aggregates results and hard task', () => {
  const s = summarizeLane({ lane: 'x', results, hard });
  assert.equal(s.tasks, 4);
  assert.equal(s.passed, 3);
  assert.equal(s.passRate, 0.75);
  assert.equal(s.costUsd, 0.06);
  assert.equal(s.tokens, 1020);
  assert.equal(s.costPerPassingUsd, 0.02);
  assert.equal(s.seconds, 10);
});

test('summarizeLane with no cost anywhere gives null costs', () => {
  const s = summarizeLane({
    lane: 'x',
    results: [{ taskId: 'a', pass: true, costUsd: null, tokens: 1, durationMs: 1 }, { taskId: 'b', pass: false, tokens: 1, durationMs: 1 }],
    hard: null,
  });
  assert.equal(s.costUsd, null);
  assert.equal(s.costPerPassingUsd, null);
});

test('summarizeLane with zero passes gives null cost per passing task', () => {
  const s = summarizeLane({ lane: 'x', results: [{ taskId: 'a', pass: false, costUsd: 0.5, tokens: 1, durationMs: 1 }], hard: null });
  assert.equal(s.costUsd, 0.5);
  assert.equal(s.costPerPassingUsd, null);
});

test('summarizeLane with null hard counts 3 tasks', () => {
  const s = summarizeLane({ lane: 'x', results: results, hard: null });
  assert.equal(s.tasks, 3);
});

test('qwenAtFullLoad computes tokens, passes and cost', () => {
  const q = qwenFixture();
  assert.equal(q.tokens, 10000);
  assert.equal(q.passed, 4);
  assert.equal(q.usdPerMillionTokens, 1);
  assert.equal(q.costUsd, 0.01);
  assert.equal(q.costPerPassingUsd, 0.0025);
});

test('renderComparison includes table, null-cost text, Qwen row and dollar figures', () => {
  const lanes = [
    summarizeLane({ lane: 'Haiku', results, hard }),
    summarizeLane({ lane: 'Codex', results: [{ taskId: 'a', pass: true, costUsd: null, tokens: 10, durationMs: 1000 }], hard: null }),
  ];
  const md = renderComparison({ lanes, qwen: qwenFixture(), date: '2026-10-16' });
  assert.match(md, /Lane/);
  assert.match(md, /Pass rate/);
  assert.match(md, /subscription \(not reported\)/);
  assert.match(md, /Qwen3\.6/);
  assert.match(md, /\$0\.0600/);
  assert.match(md, /\$0\.0100/);
  assert.match(md, /2026-10-16/);
});
