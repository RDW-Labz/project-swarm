// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeOrchestratorHandoff, HANDOFF_FILE } from '../tools/orchestrator-handoff.mjs';
import {
  maybeScheduleOrchestratorHandoff,
  resetOrchestratorHandoffHookState,
  runOrchestratorHandoffHookFromRecord,
} from '../tools/orchestrator-handoff-hook.mjs';
import { HANDOFF_TRANSCRIPT_BYTES_ENV } from '../tools/orchestrator-context.mjs';
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

const THRESHOLD = 256 * 1024;

function hookInput(root, transcriptName, extra = {}) {
  return {
    cwd: root,
    session_id: 'orch-hook-test-session',
    transcript_path: transcriptName,
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/x' },
    ...extra,
  };
}

async function withTranscriptRoot(t, fn) {
  const transcriptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-handoff-tx-'));
  const saved = process.env.SWARM_TRANSCRIPT_ROOTS;
  process.env.SWARM_TRANSCRIPT_ROOTS = transcriptRoot;
  t.after(async () => {
    process.env.SWARM_TRANSCRIPT_ROOTS = saved;
    await fs.rm(transcriptRoot, { recursive: true, force: true });
  });
  const name = 'hook-size.jsonl';
  const file = path.join(transcriptRoot, name);
  return fn({ name, file });
}

test('hook schedules handoff on pre when over limit but does not write until post', async (t) => {
  resetOrchestratorHandoffHookState();
  const root = await tempRoot();
  await appendEvent(root, { kind: 'goal', text: 'G' });
  let writeCalls = 0;
  const writeHandoff = async () => { writeCalls += 1; return writeOrchestratorHandoff(root); };

  await withTranscriptRoot(t, async ({ name, file }) => {
    fsSync.writeFileSync(file, 'x'.repeat(THRESHOLD), 'utf8');
    const input = hookInput(root, name);
    const pre = await maybeScheduleOrchestratorHandoff('pre', input, root, { threshold: THRESHOLD, writeHandoff, env: {} });
    assert.equal(pre.action, 'scheduled');
    assert.equal(pre.inFlight, 1);
    assert.equal(writeCalls, 0);
    assert.equal(await fs.stat(path.join(root, '.swarm', 'project', HANDOFF_FILE)).catch(() => null), null);

    const post = await maybeScheduleOrchestratorHandoff('post', input, root, { threshold: THRESHOLD, writeHandoff, env: {} });
    assert.equal(post.action, 'handoff');
    assert.equal(post.wrote, true);
    assert.equal(writeCalls, 1);
    const onDisk = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'project', HANDOFF_FILE), 'utf8'));
    assert.equal(onDisk.goal, 'G');
  });
});

test('hook defers handoff until nested in-flight tools finish', async (t) => {
  resetOrchestratorHandoffHookState();
  const root = await tempRoot();
  await appendEvent(root, { kind: 'goal', text: 'Nested' });
  let writeCalls = 0;
  const writeHandoff = async () => { writeCalls += 1; };

  await withTranscriptRoot(t, async ({ name, file }) => {
    fsSync.writeFileSync(file, 'x'.repeat(THRESHOLD), 'utf8');
    const input = hookInput(root, name);
    await maybeScheduleOrchestratorHandoff('pre', input, root, { threshold: THRESHOLD, writeHandoff, env: {} });
    await maybeScheduleOrchestratorHandoff('pre', input, root, { threshold: THRESHOLD, writeHandoff, env: {} });
    assert.equal(writeCalls, 0);

    const mid = await maybeScheduleOrchestratorHandoff('post', input, root, { threshold: THRESHOLD, writeHandoff, env: {} });
    assert.equal(mid.action, 'scheduled');
    assert.equal(mid.inFlight, 1);
    assert.equal(writeCalls, 0);

    const done = await maybeScheduleOrchestratorHandoff('post', input, root, { threshold: THRESHOLD, writeHandoff, env: {} });
    assert.equal(done.action, 'handoff');
    assert.equal(writeCalls, 1);
  });
});

test('hook does not schedule when transcript is under the threshold', async (t) => {
  resetOrchestratorHandoffHookState();
  const root = await tempRoot();
  let writeCalls = 0;
  const writeHandoff = async () => { writeCalls += 1; };

  await withTranscriptRoot(t, async ({ name, file }) => {
    fsSync.writeFileSync(file, 'x'.repeat(THRESHOLD - 1), 'utf8');
    const input = hookInput(root, name);
    const pre = await maybeScheduleOrchestratorHandoff('pre', input, root, { threshold: THRESHOLD, writeHandoff, env: {} });
    assert.equal(pre.action, 'continue');
    const post = await maybeScheduleOrchestratorHandoff('post', input, root, { threshold: THRESHOLD, writeHandoff, env: {} });
    assert.equal(post.action, 'continue');
    assert.equal(writeCalls, 0);
  });
});

test('spawned hook worker keeps in-flight state across pre and post', async (t) => {
  resetOrchestratorHandoffHookState();
  const root = await tempRoot();
  await fs.writeFile(path.join(root, '.project-swarm.json'), '{}');
  await appendEvent(root, { kind: 'goal', text: 'Spawned' });
  const savedEnv = process.env[HANDOFF_TRANSCRIPT_BYTES_ENV];
  process.env[HANDOFF_TRANSCRIPT_BYTES_ENV] = String(THRESHOLD);
  t.after(() => { process.env[HANDOFF_TRANSCRIPT_BYTES_ENV] = savedEnv; });

  await withTranscriptRoot(t, async ({ name, file }) => {
    fsSync.writeFileSync(file, 'x'.repeat(THRESHOLD), 'utf8');
    const raw = JSON.stringify(hookInput(root, name, { session_id: 'spawn-session' }));
    runOrchestratorHandoffHookFromRecord('pre', raw);
    assert.equal(await fs.readFile(path.join(root, '.swarm', 'project', HANDOFF_FILE)).catch(() => null), null);
    runOrchestratorHandoffHookFromRecord('post', raw);
    const onDisk = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'project', HANDOFF_FILE), 'utf8'));
    assert.equal(onDisk.goal, 'Spawned');
  });
});

test('hook skips worker workspaces', async () => {
  resetOrchestratorHandoffHookState();
  const root = await tempRoot();
  let writeCalls = 0;
  const out = await maybeScheduleOrchestratorHandoff('pre', {
    cwd: path.join(root, '.swarm', 'workspaces', 'run', 'job'),
    session_id: 'worker-session',
    transcript_path: 'x.jsonl',
  }, root, { writeHandoff: async () => { writeCalls += 1; } });
  assert.equal(out.action, 'skip');
  assert.equal(writeCalls, 0);
});
