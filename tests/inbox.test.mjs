// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectInbox, formatInbox, markDone, decide } from '../tools/inbox.mjs';

const NOW = Date.parse('2025-01-02T00:00:00Z');
const TS = '2025-01-01T00:00:00.000Z';

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeDeps(world, extra = {}) {
  const writes = [];
  const events = [];
  const goals = [];
  const deps = {
    now: () => NOW,
    listRuns: async root => {
      const project = world[root];
      if (!project || project.broken) throw new Error('EACCES: permission denied');
      return project.runs.map(run => run.id);
    },
    readState: async (root, runId) => {
      const run = (world[root]?.runs ?? []).find(item => item.id === runId);
      return run ? structuredClone(run) : null;
    },
    readJournal: async root => structuredClone(world[root]?.journal ?? []),
    writeRun: async (root, run) => { writes.push({ root, run: structuredClone(run) }); },
    appendEvent: async (root, event) => { events.push({ root, event }); return event; },
    addGoal: async (root, spec) => { goals.push({ root, spec }); return spec; },
    ...extra,
  };
  return { deps, writes, events, goals };
}

test('sorts human items by transitive unblocks and ignores completed jobs', async t => {
  const root = await tmp(t);
  const world = { [root]: { journal: [], runs: [{ id: 'R1', jobs: [
    { id: 'A', title: 'key', steps: ['get key'], status: 'held', heldReason: 'human', after: [] },
    { id: 'B', status: 'queued', after: ['A'] },
    { id: 'C', status: 'queued', after: ['B'] },
    { id: 'D', status: 'complete', after: ['A'] },
    { id: 'E', title: 'login', steps: [], status: 'held', heldReason: 'human', after: [] },
    { id: 'F', status: 'complete', after: ['E'] },
    { id: 'G', status: 'complete', after: ['E'] },
    { id: 'H', status: 'queued', after: ['G'] },
    { id: 'Z', title: 'design', steps: [], status: 'held', heldReason: 'human', after: [] },
  ] }] } };
  const { deps } = makeDeps(world);
  const items = await collectInbox([root], deps);
  assert.deepEqual(items.map(item => item.id), ['R1:A', 'R1:E', 'R1:Z']);
  assert.deepEqual(items.map(item => item.unblocks), [2, 1, 0]);
  assert.equal(items[0].kind, 'human');
  assert.deepEqual(items[0].steps, ['get key']);
});

test('collects human, decision and blocker items from the journal and runs', async t => {
  const root = await tmp(t);
  const world = { [root]: {
    runs: [{ id: 'R1', jobs: [{ id: 'K', title: 'add key', steps: ['paste key'], status: 'held', heldReason: 'human', after: [] }] }],
    journal: [
      { kind: 'human', id: 'h1', ts: TS, title: 'Pick a logo', steps: ['look'], unblocks: 3 },
      { kind: 'decision', id: 'd1', ts: TS, text: 'Use SQLite?', choice: 'yes', options: ['yes', 'no'], confirm: true },
      { kind: 'blocker', id: 'b1', ts: TS, text: 'npm offline' },
    ],
  } };
  const { deps } = makeDeps(world);
  const items = await collectInbox([root], deps);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(item => item.kind).sort(), ['blocker', 'decision', 'human', 'human']);
  assert.equal(items[0].id, 'h1');
  assert.equal(items[0].unblocks, 3);
  const decision = items.find(item => item.kind === 'decision');
  assert.equal(decision.default, 'yes');
  assert.deepEqual(decision.choices, ['yes', 'no']);
  const blocker = items.find(item => item.kind === 'blocker');
  assert.equal(blocker.unblocks, 0);
});

test('collects items from several project roots and tags each with its root', async t => {
  const a = await tmp(t);
  const b = await tmp(t);
  const held = id => ({ id: 'R', jobs: [{ id, title: id, steps: [], status: 'held', heldReason: 'human', after: [] }] });
  const world = {
    [a]: { journal: [], runs: [held('X')] },
    [b]: { journal: [], runs: [held('Y')] },
  };
  const { deps } = makeDeps(world);
  const items = await collectInbox([a, b], deps);
  assert.deepEqual(items.map(item => item.project).sort(), [a, b].sort());
});

test('skips an unreadable root with a note instead of failing', async t => {
  const ok = await tmp(t);
  const broken = await tmp(t);
  const world = {
    [ok]: { journal: [], runs: [{ id: 'R', jobs: [{ id: 'K', title: 'k', steps: [], status: 'held', heldReason: 'human', after: [] }] }] },
    [broken]: { broken: true },
  };
  const notes = [];
  const { deps } = makeDeps(world);
  const items = await collectInbox([broken, ok], { ...deps, onNote: note => notes.push(note) });
  assert.equal(items.length, 1);
  assert.equal(items[0].project, ok);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes(broken));
});

test('markDone completes a run job and recomputes pause reasons', async t => {
  const root = await tmp(t);
  const world = { [root]: { journal: [], runs: [{ id: 'R1', pause: { reasons: ['human'] }, jobs: [
    { id: 'K', title: 'key', steps: [], status: 'held', heldReason: 'human', after: [] },
    { id: 'L', status: 'held', heldReason: 'after K held', after: ['K'] },
  ] }] } };
  const { deps, writes, events } = makeDeps(world);
  const result = await markDone(root, 'R1:K', deps);
  assert.deepEqual(result, { id: 'R1:K', kind: 'human' });
  assert.equal(writes.length, 1);
  const job = writes[0].run.jobs[0];
  assert.equal(job.status, 'complete');
  assert.equal(job.heldReason, undefined);
  assert.equal(job.human.by, 'owner');
  assert.deepEqual(writes[0].run.pause.reasons, []);
  assert.deepEqual(events[0].event, { kind: 'human', id: 'R1:K', done: true, run: 'R1', job: 'K' });
});

test('markDone keeps the human reason while another human job is still held', async t => {
  const root = await tmp(t);
  const world = { [root]: { journal: [], runs: [{ id: 'R1', pause: { reasons: ['human'] }, jobs: [
    { id: 'K', status: 'held', heldReason: 'human', after: [] },
    { id: 'M', status: 'held', heldReason: 'human', after: [] },
  ] }] } };
  const { deps, writes } = makeDeps(world);
  await markDone(root, 'R1:K', deps);
  assert.deepEqual(writes[0].run.pause.reasons, ['human']);
});

test('markDone refuses unknown, already done and non-human jobs without writing', async t => {
  const root = await tmp(t);
  const world = { [root]: { journal: [], runs: [{ id: 'R1', pause: { reasons: [] }, jobs: [
    { id: 'K', status: 'complete', after: [] },
    { id: 'Q', status: 'queued', after: [] },
  ] }] } };
  const { deps, writes, events } = makeDeps(world);
  await assert.rejects(markDone(root, 'R9:K', deps), /inbox-unknown/);
  await assert.rejects(markDone(root, 'R1:NOPE', deps), /inbox-unknown/);
  await assert.rejects(markDone(root, 'R1:K', deps), /inbox-already-done/);
  await assert.rejects(markDone(root, 'R1:Q', deps), /inbox-not-human/);
  await assert.rejects(markDone(root, 'bare', deps), /inbox-unknown/);
  assert.equal(writes.length, 0);
  assert.equal(events.length, 0);
});

test('markDone closes an open journal human item and refuses a closed one', async t => {
  const root = await tmp(t);
  const world = { [root]: { runs: [], journal: [{ kind: 'human', id: 'k1', ts: TS, title: 'login' }] } };
  const { deps, events } = makeDeps(world);
  const result = await markDone(root, 'k1', deps);
  assert.deepEqual(result, { id: 'k1', kind: 'human' });
  assert.deepEqual(events[0].event, { kind: 'human', id: 'k1', done: true });

  const closed = { [root]: { runs: [], journal: [{ kind: 'human', id: 'k1', ts: TS, title: 'login' }, { kind: 'human', id: 'k1', done: true }] } };
  const second = makeDeps(closed);
  await assert.rejects(markDone(root, 'k1', second.deps), /inbox-unknown/);
  assert.equal(second.events.length, 0);
});

function decisionWorld(root, extra = []) {
  return { [root]: { runs: [], journal: [
    { kind: 'decision', id: 'd1', ts: TS, text: 'Use SQLite?', choice: 'yes', options: ['yes', 'no'], confirm: true },
    ...extra,
  ] } };
}

test('decide with the default choice confirms without adding a goal', async t => {
  const root = await tmp(t);
  const { deps, events, goals } = makeDeps(decisionWorld(root));
  const result = await decide(root, 'd1', 'yes', deps);
  assert.equal(result.changed, false);
  assert.equal(goals.length, 0);
  assert.deepEqual(events[0].event, { kind: 'decision', id: 'd1', confirmed: true, choice: 'yes', text: 'Use SQLite?' });
});

test('decide with a different choice adds a backlog goal through addGoal', async t => {
  const root = await tmp(t);
  const { deps, events, goals } = makeDeps(decisionWorld(root));
  const result = await decide(root, 'd1', 'no', deps);
  assert.equal(result.changed, true);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].root, root);
  assert.equal(goals[0].spec.goal, 'Change decision d1 to no');
  assert.deepEqual(goals[0].spec.paths, []);
  assert.equal(events[0].event.choice, 'no');
});

test('decide refuses unknown, already confirmed and invalid choices without writing', async t => {
  const root = await tmp(t);
  const first = makeDeps(decisionWorld(root));
  await assert.rejects(decide(root, 'nope', 'yes', first.deps), /inbox-unknown/);
  await assert.rejects(decide(root, 'd1', 'maybe', first.deps), /inbox-choice-invalid/);
  await assert.rejects(decide(root, 'd1', '   ', first.deps), /inbox-choice-invalid/);
  assert.equal(first.events.length, 0);
  assert.equal(first.goals.length, 0);

  const done = makeDeps(decisionWorld(root, [{ kind: 'decision', id: 'd1', confirmed: true, choice: 'yes' }]));
  await assert.rejects(decide(root, 'd1', 'no', done.deps), /inbox-unknown/);
  assert.equal(done.goals.length, 0);
});

test('formatInbox prints the empty message and close commands sorted by unblocks', async t => {
  assert.equal(formatInbox([], { now: () => NOW }), 'Nothing needs you.');
  const root = await tmp(t);
  const world = { [root]: {
    runs: [{ id: 'R1', jobs: [{ id: 'K', title: 'key', steps: ['paste'], status: 'held', heldReason: 'human', after: [] }, { id: 'J', status: 'held', heldReason: 'after K held', after: ['K'] }] }],
    journal: [{ kind: 'decision', id: 'd1', ts: TS, text: 'Pick', choice: 'yes', options: ['yes', 'no'], confirm: true }],
  } };
  const { deps } = makeDeps(world);
  const items = await collectInbox([root], deps);
  const text = formatInbox(items, { now: () => NOW });
  assert.ok(text.includes('swarm done R1:K'));
  assert.ok(text.includes('swarm decide d1 yes'));
  assert.ok(text.indexOf('R1:K') < text.indexOf('d1'));
});
