// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentState,
  WORKING_MS as BOARD_WORKING_MS,
  ERROR_SHOWN_MS as BOARD_ERROR_SHOWN_MS,
} from '../tools/board-data.mjs';
const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const ROBOT_STATES = ['idle', 'thinking', 'working', 'error', 'sleeping'];
const NOW = Date.UTC(2026, 10, 21, 18, 0, 0);
const iso = at => new Date(at).toISOString();

const KNOWN_LANE_NAMES = ['Orchestrator', 'Haiku', 'Sonnet', 'Opus', 'Codex', 'Cursor', 'GPU', 'Claude'];

function installBoardLib() {
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
  const libSrc = readFileSync(path.join(assets, 'board-lib.js'), 'utf8');
  const box = { self: globalThis };
  vm.runInNewContext(libSrc, box);
  globalThis.BoardLib = box.self.BoardLib;
}

let avatar;
async function loadAvatar() {
  if (!avatar) {
    installBoardLib();
    avatar = await import('../tools/watch-assets/robot-avatar.js');
  }
  return avatar;
}

async function loadBoardLibLaneColor() {
  const libSrc = await fs.readFile(path.join(assets, 'board-lib.js'), 'utf8');
  const box = { self: {} };
  vm.runInNewContext(libSrc, box);
  return box.self.BoardLib.laneColor;
}

test('agent timing constants match board-data', async () => {
  const { WORKING_MS, ERROR_SHOWN_MS } = await loadAvatar();
  assert.equal(WORKING_MS, BOARD_WORKING_MS);
  assert.equal(ERROR_SHOWN_MS, BOARD_ERROR_SHOWN_MS);
});

test('each known lane resolves to board-lib laneColor', async () => {
  const { resolveLaneColor } = await loadAvatar();
  const laneColor = await loadBoardLibLaneColor();
  for (const lane of KNOWN_LANE_NAMES) {
    assert.equal(resolveLaneColor(lane), laneColor(lane), lane);
  }
  assert.equal(resolveLaneColor('NotALane'), laneColor('NotALane'));
  assert.equal(resolveLaneColor(undefined), laneColor(''));
});

test('agent state field maps like board HEAD_STATE', async () => {
  const { HEAD_STATE, resolveRobotState } = await loadAvatar();
  for (const [raw, visual] of Object.entries(HEAD_STATE)) {
    assert.equal(resolveRobotState({ lane: 'Haiku', state: raw }), visual, raw);
  }
  assert.equal(resolveRobotState({ lane: 'Haiku', state: 'sleeping' }), 'sleeping');
  assert.equal(resolveRobotState({ lane: 'Haiku', idle: true }), 'sleeping');
  assert.equal(resolveRobotState({ lane: 'Haiku', state: 'mystery' }), 'idle');
  assert.equal(resolveRobotState(null), 'idle');
  assert.equal(resolveRobotState({ lane: 'Haiku' }), 'idle');
});

test('job status maps through agentState then HEAD_STATE', async () => {
  const { HEAD_STATE, resolveRobotState, WORKING_MS, ERROR_SHOWN_MS } = await loadAvatar();
  const run = (overrides = {}) => ({
    status: 'running',
    startedAt: iso(NOW - 120000),
    progress: { lastOutputAt: iso(NOW - 1000) },
    ...overrides,
  });

  const cases = [
    { job: run(), want: 'working', note: 'running with recent output' },
    { job: run({ progress: { lastOutputAt: iso(NOW - WORKING_MS - 1000) } }), want: 'thinking', note: 'quiet running job' },
    { job: run({ progress: undefined }), want: 'thinking', note: 'no output yet' },
    { job: { status: 'failed', finishedAt: iso(NOW - 60000) }, want: 'error', note: 'recent failure' },
    { job: { status: 'timeout', finishedAt: iso(NOW - 60000) }, want: 'error', note: 'recent timeout' },
    { job: { status: 'failed', finishedAt: iso(NOW - ERROR_SHOWN_MS - 1000) }, want: 'idle', note: 'stale failure' },
    { job: { status: 'failed' }, want: 'idle', note: 'failure without timestamp' },
    ...['complete', 'queued', 'blocked', 'held', 'cancelled', undefined].map(status => ({
      job: { status, finishedAt: iso(NOW) },
      want: 'idle',
      note: `status ${status}`,
    })),
  ];

  for (const { job, want, note } of cases) {
    const viaBoard = agentState(job, NOW);
    const mapped = viaBoard ? (HEAD_STATE[viaBoard] ?? 'idle') : 'idle';
    assert.equal(mapped, want, `board-data path: ${note}`);
    assert.equal(resolveRobotState({ lane: 'Sonnet', ...job }, NOW), want, `robot-avatar: ${note}`);
  }
});

test('buildRobotAvatarMountOptions never yields undefined state or color', async () => {
  const { buildRobotAvatarMountOptions } = await loadAvatar();
  const laneColor = await loadBoardLibLaneColor();
  const mounts = [
    { lane: 'Opus', state: 'working' },
    { lane: 'bogus-lane', state: 'unknown-status' },
    { lane: 'GPU', status: 'queued' },
    { lane: 'Haiku', idle: true },
    {},
  ];
  for (const record of mounts) {
    const opts = buildRobotAvatarMountOptions(record, { now: NOW, size: 24 });
    assert.ok(typeof opts.state === 'string' && ROBOT_STATES.includes(opts.state), `state ${opts.state}`);
    assert.ok(typeof opts.color === 'string' && opts.color.startsWith('#'), `color ${opts.color}`);
    const lane = record.lane ?? '';
    assert.equal(opts.color, laneColor(lane), 'color from laneColor');
  }
});
