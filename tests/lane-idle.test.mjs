// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boardSnapshot, laneIdleReasons } from '../tools/board-data.mjs';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');

test('lane idle reasons use the requested priority and explain every branch', () => {
  const until = NOW + 45_000;
  const paused = laneIdleReasons({
    now: NOW,
    configured: { codex: 'gpt' },
    pauses: { codex: { state: 'backoff', until } },
    caps: { codex: 1 },
    todayUsd: { codex: 2 },
  }).Codex;
  assert.deepEqual(paused, { reason: 'rate-limited', text: 'rate limited, back in 45s', until: new Date(until).toISOString() });

  assert.equal(laneIdleReasons({ now: NOW, configured: { codex: 'gpt' }, caps: { codex: 1 }, todayUsd: { codex: 1 } }).Codex.reason, 'daily-cap');
  assert.equal(laneIdleReasons({ now: NOW }).Cursor.reason, 'not-set-up');
  assert.equal(laneIdleReasons({ now: NOW, configured: { cursor: 'composer' }, demand: { cursor: 2 } }).Cursor.text, '2 jobs waiting for a slot');
  assert.equal(laneIdleReasons({ now: NOW, configured: { cursor: 'composer' }, queued: { cursor: 3 } }).Cursor.text, '3 queued, starting soon');
  assert.equal(laneIdleReasons({ now: NOW, configured: { cursor: 'composer' }, queued: { auto: 2 } }).Cursor.text, '2 auto jobs not routed yet');
  assert.equal(laneIdleReasons({ now: NOW, configured: { claude: 'claude-opus' } }).Opus.text, 'only for expensive tier or after 2 failures');
  assert.equal(laneIdleReasons({ now: NOW, configured: { qwen: 'qwen' } }).qwen.text, 'not in auto routing; only explicit jobs');
  assert.equal(laneIdleReasons({ now: NOW, configured: { hermes: 'research' } }).hermes.text, 'research job type only');
  const bothRecent = laneIdleReasons({
    now: NOW,
    configured: { cursor: 'composer', codex: 'gpt' },
    recent: { codex: { jobs: 2, explicit: 2 }, cursor: { jobs: 1, explicit: 1 } },
  });
  assert.equal(bothRecent.Codex.text, 'no ready jobs');
  assert.equal(bothRecent.Cursor.text, 'no ready jobs');
  const cursorIdleCodexExplicit = laneIdleReasons({
    now: NOW,
    configured: { cursor: 'composer', codex: 'gpt' },
    recent: { codex: { jobs: 3, explicit: 3 } },
  });
  assert.equal(cursorIdleCodexExplicit.Cursor.text, 'no ready jobs; recent jobs named Codex explicitly');
  assert.equal(cursorIdleCodexExplicit.Codex.text, 'no ready jobs');
  assert.equal(laneIdleReasons({ now: NOW, running: { Codex: 1 } }).Codex, undefined);
  assert.equal(laneIdleReasons({ now: NOW }).GPU.text, 'no GPU configured');
});

test('lane idle countdowns use compact seconds, minutes, and hours', () => {
  assert.equal(laneIdleReasons({ now: NOW, pauses: { cursor: { state: 'paused', until: NOW + 45_000 } } }).Cursor.text, 'quota paused, back in 45s');
  assert.equal(laneIdleReasons({ now: NOW, pauses: { cursor: { state: 'paused', until: NOW + 12 * 60_000 } } }).Cursor.text, 'quota paused, back in 12m');
  assert.equal(laneIdleReasons({ now: NOW, pauses: { cursor: { state: 'paused', until: NOW + (3 * 60 + 5) * 60_000 } } }).Cursor.text, 'quota paused, back in 3h 5m');
});

test('boardSnapshot includes injected idle state and omits running lanes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lane-idle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.swarm', 'runs', 'run-1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', 'run-1', 'state.json'), JSON.stringify({
    status: 'running',
    jobs: [{ id: 'codex-job', agent: 'codex', model: 'gpt', status: 'running', startedAt: new Date(NOW - 1000).toISOString() }],
  }));
  const snapshot = await boardSnapshot({
    now: NOW,
    projects: [{ id: 'p', name: 'p', root }],
    liveRuns: [{ runId: 'run-1', root }],
    summary: async () => ({}),
    worktreeRoot: async () => null,
    laneState: async () => ({ configured: { cursor: 'composer', codex: 'gpt' }, pauses: {}, demand: { cursor: 1 }, caps: {} }),
  });
  assert.equal(snapshot.machine.laneIdle.Cursor.reason, 'waiting-slot');
  assert.equal(snapshot.machine.laneIdle.Cursor.text, '1 job waiting for a slot');
  assert.equal(snapshot.machine.laneIdle.Codex, undefined);
});
