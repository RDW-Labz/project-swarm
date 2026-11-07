// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInboxCommand } from '../tools/inbox-commands.mjs';
import { readJournal, journalPath } from '../tools/journal.mjs';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

async function projectRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-board-safe-'));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('--board-safe records boardSafe on the journal event', async t => {
  const root = await projectRoot(t);
  const out = await runInboxCommand(root, 'decision', ['Which theme?', '--choice', 'dark', '--id', 'theme-pick', '--board-safe'], { now: () => NOW });
  assert.equal(out.exitCode, 0);
  const event = (await readJournal(root, { limit: Infinity })).find(e => e.kind === 'decision' && e.id === 'theme-pick');
  assert.equal(event.boardSafe, true);
});

test('without --board-safe the decision event has no boardSafe field', async t => {
  const root = await projectRoot(t);
  const out = await runInboxCommand(root, 'decision', ['Which theme?', '--choice', 'dark', '--id', 'theme-plain'], { now: () => NOW });
  assert.equal(out.exitCode, 0);
  const event = (await readJournal(root, { limit: Infinity })).find(e => e.kind === 'decision' && e.id === 'theme-plain');
  assert.equal('boardSafe' in event, false);
});

test('--board-safe with a merge decision exits 1 and writes nothing', async t => {
  const root = await projectRoot(t);
  const out = await runInboxCommand(root, 'decision', ['Merge PR 12 into main?', '--choice', 'yes', '--id', 'merge-pr', '--board-safe'], { now: () => NOW });
  assert.equal(out.exitCode, 1);
  assert.equal(out.stdout, 'a decision about merge, deploy, spend, caps, keys or migrations can never be answered from the board; drop --board-safe\n');
  let text = '';
  try { text = await fs.readFile(journalPath(root), 'utf8'); } catch { /* no file */ }
  assert.equal(text.trim(), '');
});
