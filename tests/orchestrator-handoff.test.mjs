// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeOrchestratorHandoff, HANDOFF_FILE } from '../tools/orchestrator-handoff.mjs';
import { appendEvent, readJournal } from '../tools/journal.mjs';

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'handoff-'));
}

test('writes handoff state with goal, plan, open tickets and decisions', async () => {
  const root = await tempRoot();
  const now = () => Date.parse('2025-01-01T00:00:00.000Z');
  await appendEvent(root, { kind: 'goal', text: 'Ship feature X', doneWhen: 'tests pass' }, { now });
  await appendEvent(root, { kind: 'plan', text: 'Step one then two' }, { now });
  await appendEvent(root, { kind: 'decision', text: 'Use approach A' }, { now });
  await appendEvent(root, { kind: 'blocker', id: 'b1', text: 'Waiting on review' }, { now });

  const result = await writeOrchestratorHandoff(root, { now });
  const onDisk = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'project', HANDOFF_FILE), 'utf8'));
  assert.equal(onDisk.goal, 'Ship feature X');
  assert.equal(onDisk.doneWhen, 'tests pass');
  assert.equal(onDisk.plan, 'Step one then two');
  assert.equal(onDisk.openTickets.length, 1);
  assert.equal(onDisk.openTickets[0].id, 'b1');
  assert.equal(onDisk.recentDecisions[0].text, 'Use approach A');
  assert.equal(result.handoff.goal, 'Ship feature X');
});

test('appends a handoff action event to the journal', async () => {
  const root = await tempRoot();
  await appendEvent(root, { kind: 'goal', text: 'G' });
  await writeOrchestratorHandoff(root);
  const events = await readJournal(root, { limit: Infinity });
  const handoffEvents = events.filter(e => e.action === 'orchestrator-handoff');
  assert.equal(handoffEvents.length, 1);
  assert.equal(handoffEvents[0].kind, 'action');
});

test('handles an empty project without a goal', async () => {
  const root = await tempRoot();
  const result = await writeOrchestratorHandoff(root);
  assert.equal(result.handoff.goal, null);
  assert.deepEqual(result.handoff.openTickets, []);
  assert.deepEqual(result.handoff.recentDecisions, []);
});

test('rejects a missing root', async () => {
  await assert.rejects(() => writeOrchestratorHandoff(''), /handoff-needs-root/);
});
