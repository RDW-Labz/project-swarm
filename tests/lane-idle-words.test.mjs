// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { laneIdleReasons } from '../tools/board-data.mjs';
import { lanePassRates, routingFailures } from '../tools/lane-pass-routing.mjs';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');

function allIdleTexts(input) {
  return Object.values(laneIdleReasons(input)).map(entry => entry?.text ?? '');
}

test('idle copy never uses the old recent jobs named phrase', () => {
  const samples = [
    { now: NOW, configured: { cursor: 'c', codex: 'g' }, recent: { codex: { jobs: 5, explicit: 5 } } },
    { now: NOW, configured: { cursor: 'c' } },
    { now: NOW, pauses: { cursor: { state: 'backoff', until: NOW + 60_000 } }, configured: { cursor: 'c' } },
    { now: NOW, configured: { codex: 'g' }, recent: { codex: { jobs: 1, explicit: 0, lastProviderLimitAt: NOW - 1000 } } },
  ];
  for (const input of samples) {
    for (const text of allIdleTexts(input)) {
      assert.equal(text.includes('recent jobs named'), false, text);
    }
  }
});

test('each idle reason uses plain sentences with the lane name', () => {
  const until = NOW + 45_000;
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { codex: 'gpt' }, pauses: { codex: { state: 'backoff', until } } }).Codex.text,
    'Codex is rate limited; back in 45s.',
  );
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { cursor: 'c' }, pauses: { cursor: { state: 'paused', until } } }).Cursor.text,
    'Cursor is paused by its provider (quota or credit limit); back in 45s.',
  );
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { codex: 'gpt' }, caps: { codex: 1 }, todayUsd: { codex: 1 } }).Codex.text,
    'Codex hit its daily spend cap ($1 of $1).',
  );
  assert.equal(laneIdleReasons({ now: NOW }).Cursor.text, 'Cursor is not set up: no model in the local config.');
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { cursor: 'c' }, demand: { cursor: 2 } }).Cursor.text,
    '2 Cursor jobs waiting for a free slot.',
  );
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { cursor: 'c' }, queued: { cursor: 3 } }).Cursor.text,
    '3 jobs queued for Cursor, starting soon.',
  );
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { cursor: 'c' }, queued: { auto: 2 } }).Cursor.text,
    '2 auto jobs not routed yet.',
  );
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { claude: 'opus' } }).Opus.text,
    'Opus is not in auto routing: only expensive-tier jobs or jobs after two failures on cheaper lanes.',
  );
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { qwen: 'q' } }).qwen.text,
    'qwen is not in auto routing: only jobs that name it explicitly.',
  );
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { hermes: 'h' } }).hermes.text,
    'hermes is not in auto routing: research job type only.',
  );
  assert.equal(
    laneIdleReasons({ now: NOW, configured: { cursor: 'c', codex: 'g' } }).Codex.text,
    'Codex is idle: nothing in the queue is routed to Codex right now.',
  );
  assert.equal(
    laneIdleReasons({
      now: NOW,
      configured: { cursor: 'c', codex: 'g' },
      recent: { codex: { jobs: 3, explicit: 3 } },
    }).Cursor.text,
    'Cursor is idle: nothing in the queue is routed to Cursor right now. The last 3 jobs went to Codex because their manifests named it.',
  );
});

test('provider limit on the latest job surfaces before the generic idle line', () => {
  const reason = laneIdleReasons({
    now: NOW,
    configured: { codex: 'gpt' },
    recent: { codex: { jobs: 2, explicit: 0, lastProviderLimitAt: NOW - 5000 } },
  }).Codex;
  assert.equal(reason.reason, 'provider-limit');
  assert.equal(
    reason.text,
    'Codex may be out of credits: its last job failed with a provider limit message. Refill it, or route work to another lane.',
  );
});

test('lanePassRates ignores provider quota and credit failures for routing', () => {
  const creditFailures = Array.from({ length: 6 }, () => ({
    agent: 'cursor',
    status: 'failed',
    error: 'You are out of credits. Please refill.',
  }));
  const rates = lanePassRates({ run: { jobs: creditFailures } });
  assert.deepEqual(rates, {});
  assert.deepEqual(routingFailures(rates), {});
});
