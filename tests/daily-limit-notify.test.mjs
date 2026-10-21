// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it } from 'node:test';
import {
  notifyDailyLimit,
  BOARD_BANNER_REL,
  SUMMARY_LINES_REL,
  NOTIFIER_STATE_REL,
} from '../tools/daily-limit-notify.mjs';
import { centralDayKey } from '../tools/daily-limit.mjs';

const NOW = Date.parse('2030-06-15T18:00:00.000Z');

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'daily-limit-notify-'));
}

describe('notifyDailyLimit', () => {
  it('writes all three destinations once per level per day', async () => {
    const root = await tempRoot();
    const board = [];
    const phone = [];
    const summary = [];
    const deps = {
      root,
      now: () => NOW,
      fs,
      writeBoardBanner: async (r, notice) => { board.push(notice); },
      appendPhoneInbox: async (r, notice) => { phone.push(notice); },
      appendSummaryLine: async (r, notice) => { summary.push(notice); },
    };
    const settings = { project: { usd: 5, mode: 'notify', ceilingUsd: 15 } };
    const first = await notifyDailyLimit({ project: 'demo', level: 1, billedTodayUsd: 5.5, settings, deps });
    assert.equal(first.sent, true);
    assert.equal(board.length, 1);
    assert.equal(phone.length, 1);
    assert.equal(summary.length, 1);
    assert.equal(board[0].kind, 'daily-limit');

    const again = await notifyDailyLimit({ project: 'demo', level: 1, billedTodayUsd: 6, settings, deps });
    assert.equal(again.sent, false);
    assert.equal(again.reason, 'deduped');
    assert.equal(board.length, 1);

    const second = await notifyDailyLimit({ project: 'demo', level: 2, billedTodayUsd: 11, settings, deps });
    assert.equal(second.sent, true);
    assert.equal(board.length, 2);
  });

  it('dedupes ceiling separately and resets on a new Central day', async () => {
    const root = await tempRoot();
    let now = NOW;
    const deps = {
      root,
      now: () => now,
      fs,
      writeBoardBanner: async () => {},
      appendPhoneInbox: async () => {},
      appendSummaryLine: async () => {},
    };
    const settings = { project: { usd: 5, mode: 'notify', ceilingUsd: 15 } };
    assert.equal((await notifyDailyLimit({ project: 'p', level: 'ceiling', billedTodayUsd: 15, settings, deps })).sent, true);
    assert.equal((await notifyDailyLimit({ project: 'p', level: 'ceiling', billedTodayUsd: 16, settings, deps })).sent, false);

    const day = centralDayKey(() => now);
    const stateFile = path.join(root, NOTIFIER_STATE_REL);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(state.day, day);
    assert.deepEqual(state.byProject.p, ['ceiling']);

    now = NOW + 36 * 3600 * 1000;
    assert.equal((await notifyDailyLimit({ project: 'p', level: 1, billedTodayUsd: 5, settings, deps })).sent, true);
  });

  it('default deps write banner, phone journal line, and summary ndjson', async () => {
    const root = await tempRoot();
    const journal = [];
    const deps = {
      root,
      now: () => NOW,
      fs,
      appendEvent: async (r, event) => { journal.push(event); },
    };
    await notifyDailyLimit({
      project: 'demo',
      level: 3,
      billedTodayUsd: 16,
      settings: { project: { usd: 5, mode: 'notify', ceilingUsd: 20 } },
      deps,
    });
    const banner = JSON.parse(await fs.readFile(path.join(root, BOARD_BANNER_REL), 'utf8'));
    assert.equal(banner.kind, 'daily-limit');
    assert.equal(banner.level, 3);
    assert.equal(journal.length, 1);
    assert.match(journal[0].title, /FYI, no action needed/);
    const summaryText = await fs.readFile(path.join(root, SUMMARY_LINES_REL), 'utf8');
    const summaryLine = JSON.parse(summaryText.trim().split('\n')[0]);
    assert.equal(summaryLine.kind, 'daily-limit');
    assert.ok(summaryLine.text.length < 200);
  });
});
