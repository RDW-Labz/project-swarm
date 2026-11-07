// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRuns, buildBrief, renderBrief, renderHandoff, renderAgentHandoff, DEFAULT_RULES } from '../tools/brief.mjs';

const NOW = Date.parse('2025-01-01T12:00:00Z');
const now = () => NOW;

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'brief-test-'));
}

async function writeRun(root, name, state) {
  const dir = path.join(root, '.swarm', 'runs', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state));
}

const nextFor = (runs, events = [{ kind: 'goal', text: 'g' }]) => buildBrief({ root: '/r', events, runs, now }).next;

test('loadRuns returns an empty list without a runs directory', async () => {
  assert.deepEqual(await loadRuns(await tempRoot()), []);
});

test('loadRuns skips corrupt state, sorts newest first, limits and summarizes', async () => {
  const root = await tempRoot();
  await writeRun(root, 'old', { id: 'old', status: 'complete', startedAt: '2025-01-01T00:00:00Z', jobs: { a: { costUsd: 1 } }, integratedFiles: ['x.js'] });
  // Jobs need declared outputs so the run is not treated as a no-output (already-integrated) review run.
  await writeRun(root, 'new', { id: 'new', status: 'paused', startedAt: '2025-01-02T00:00:00Z', jobs: { a: { costUsd: 0.5, outputs: ['out/a.txt'] }, b: { costUsd: 0.25, outputs: ['out/b.txt'] } }, summary: { counts: { done: 2 } }, pause: { reasons: ['quota'], until: null } });
  await writeRun(root, 'broken', '{not json');
  const runs = await loadRuns(root);
  assert.deepEqual(runs.map(run => run.id), ['new', 'old']);
  assert.equal(runs[0].costUsd, 0.75);
  assert.deepEqual(runs[0].counts, { done: 2 });
  assert.deepEqual(runs[0].pause, { reasons: ['quota'], until: null });
  assert.equal(runs[0].integrated, false);
  assert.equal(runs[1].integrated, true);
  assert.equal(runs[1].costUsd, 1);
  assert.equal(runs[1].counts, null);
  assert.equal(runs[1].pause, null);
  assert.equal((await loadRuns(root, { limit: 1 })).length, 1);
});

test('loadRuns falls back to directory name for ordering and id', async () => {
  const root = await tempRoot();
  await writeRun(root, 'aaa', { status: 'queued' });
  await writeRun(root, 'bbb', { status: 'queued' });
  assert.deepEqual((await loadRuns(root)).map(run => run.id), ['bbb', 'aaa']);
});

test('buildBrief takes goal from newest goal event and lists done items', () => {
  const events = [
    { kind: 'goal', text: 'old goal' },
    { kind: 'integration', run: 'r0', status: 'integrated', files: 3 },
    { kind: 'goal', text: 'new goal', doneWhen: 'tests pass' },
    { kind: 'pr', number: 42, status: 'merged' },
    { kind: 'run', id: 'r9', status: 'complete' },
  ];
  const brief = buildBrief({ root: '/r', events, runs: [], now });
  assert.equal(brief.goal, 'new goal');
  assert.equal(brief.doneWhen, 'tests pass');
  assert.deepEqual(brief.done, ['PR 42 merged', 'run r0 integrated, 3 files']);
  assert.deepEqual(brief.next, ['swarm status', 'swarm board', 'swarm doctor all']);
  assert.deepEqual(brief.rules, DEFAULT_RULES);
});

test('buildBrief reports goal null and suggests describing the goal', () => {
  const brief = buildBrief({ root: '/r', events: [], runs: [], now });
  assert.equal(brief.goal, null);
  assert.equal(brief.next[0], 'swarm "describe the goal in one sentence"');
});

test('buildBrief lists at most 8 done items and never lists unintegrated complete runs', () => {
  const events = [{ kind: 'goal', text: 'g' }, { kind: 'run', id: 'c1', status: 'complete' }];
  for (let i = 0; i < 10; i++) events.push({ kind: 'integration', run: 'r' + i, status: 'complete', files: i });
  const brief = buildBrief({ root: '/r', events, runs: [], now });
  assert.equal(brief.done.length, 8);
  assert.equal(brief.done[0], 'run r9 integrated, 9 files');
  assert.ok(!brief.done.some(line => line.includes('c1')));
});

test('buildBrief running lists live runs only, at most 5', () => {
  const runs = [{ id: 'a', status: 'running', counts: { done: 1 } }, { id: 'q', status: 'queued', counts: null }, { id: 'x', status: 'complete', counts: null }];
  for (let i = 0; i < 5; i++) runs.push({ id: 'z' + i, status: 'running', counts: null });
  const brief = buildBrief({ root: '/r', events: [], runs, now });
  assert.equal(brief.running.length, 5);
  assert.deepEqual(brief.running[0], { id: 'a', status: 'running', counts: { done: 1 } });
  assert.ok(!brief.running.some(run => run.id === 'x'));
});

test('buildBrief open items come from openItems and are capped at 6', () => {
  const events = [{ kind: 'goal', text: 'g' }, { kind: 'human', id: 'h1', text: 'Approve deploy key', steps: ['open console'] }];
  for (let i = 0; i < 7; i++) events.push({ kind: 'blocker', id: 'b' + i, text: 'blocked ' + i });
  events.push({ kind: 'blocker', id: 'done1', text: 'fixed' }, { kind: 'blocker', id: 'done1', text: 'fixed', resolved: true });
  const brief = buildBrief({ root: '/r', events, runs: [], now });
  assert.equal(brief.open.length, 6);
  assert.equal(brief.open[0].id, 'b6');
  assert.ok(!brief.open.some(item => item.id === 'done1'));
  assert.ok(brief.next.includes('swarm brief'));
});

test('buildBrief human item shows steps and asks for swarm brief', () => {
  const events = [{ kind: 'goal', text: 'g' }, { kind: 'human', id: 'h1', text: 'Approve key', steps: ['one'] }];
  const brief = buildBrief({ root: '/r', events, runs: [], now });
  assert.deepEqual(brief.open[0], { id: 'h1', kind: 'human', text: 'Approve key', steps: ['one'] });
  assert.ok(brief.next.includes('swarm brief'));
});

test('next: running run gets monitor command', () => {
  assert.equal(nextFor([{ id: 'a', status: 'running', counts: null }])[0], 'swarm monitor a --watch');
});

test('next: quota pause in the past resumes with wait', () => {
  const runs = [{ id: 'p', status: 'paused', pause: { reasons: ['quota'], until: '2025-01-01T11:00:00Z' } }];
  assert.equal(nextFor(runs)[0], 'swarm resume p --wait');
});

test('next: quota pause in the future waits', () => {
  const runs = [{ id: 'p', status: 'paused', pause: { reasons: ['quota'], until: '2025-01-01T13:00:00Z' } }];
  assert.equal(nextFor(runs)[0], 'swarm wait p');
});

test('next: cap pause points to swarm brief and never suggests a raise', () => {
  const runs = [{ id: 'p', status: 'paused', pause: { reasons: ['run-cap'], until: null } }];
  const next = nextFor(runs);
  assert.ok(next.includes('swarm brief'));
  assert.ok(!next.some(command => command.includes('--raise')));
});

test('next: complete unintegrated run gets integrate command', () => {
  assert.equal(nextFor([{ id: 'c', status: 'complete', integrated: false }])[0], 'swarm integrate c --queue');
});

test('next: failed or cancelled run gets inspect command', () => {
  assert.equal(nextFor([{ id: 'f', status: 'failed', counts: { failed: 1 } }])[0], 'swarm inspect f --results');
  assert.equal(nextFor([{ id: 'k', status: 'cancelled', counts: null }])[0], 'swarm inspect k --results');
});

test('next always has three distinct swarm commands', () => {
  const runs = [{ id: 'a', status: 'running' }, { id: 'f', status: 'failed' }, { id: 'c', status: 'complete', integrated: false }];
  const next = nextFor(runs, []);
  assert.equal(next.length, 3);
  assert.equal(new Set(next).size, 3);
  assert.ok(next.every(command => command.startsWith('swarm ')));
});

test('buildBrief uses the rules argument when given', () => {
  const brief = buildBrief({ root: '/r', events: [], runs: [], rules: ['only rule'], now });
  assert.deepEqual(brief.rules, ['only rule']);
});

test('DEFAULT_RULES contains the five exact rules', () => {
  assert.equal(DEFAULT_RULES.length, 5);
  assert.equal(DEFAULT_RULES[4], 'Record decisions with swarm note "<text>".');
});

test('renderBrief prints sections and none for empty ones', () => {
  const text = renderBrief(buildBrief({ root: '/r', events: [], runs: [], now }));
  assert.ok(text.startsWith('Project Swarm brief'));
  assert.ok(text.includes('Goal: none'));
  assert.ok(text.includes('Done: none'));
  assert.ok(text.includes('Running: none'));
  assert.ok(text.includes('Needs the owner: none'));
  assert.ok(text.includes('Next 3 actions:\n  1. swarm "describe'));
  assert.ok(text.includes('Rules:'));
});

test('renderBrief stays under 4096 bytes and clips long lines to 160 characters', () => {
  const events = [{ kind: 'goal', text: 'g'.repeat(5000) }];
  for (let i = 0; i < 8; i++) events.push({ kind: 'integration', run: 'r' + i, status: 'complete', files: i });
  for (let i = 0; i < 6; i++) events.push({ kind: 'blocker', id: 'b' + i, text: 'x'.repeat(3000) });
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: 'run' + i, status: 'running', counts: { done: i } }));
  const brief = buildBrief({ root: '/r', events, runs, rules: ['y'.repeat(4000)], now });
  const text = renderBrief(brief);
  assert.ok(Buffer.byteLength(text) <= 4096);
  assert.ok(text.split('\n').every(line => line.length <= 160));
});

test('renderHandoff starts with the generated marker', () => {
  const text = renderHandoff(buildBrief({ root: '/r', events: [], runs: [], now }));
  assert.equal(text.split('\n')[0], '<!-- generated by swarm; do not edit: regenerated from .swarm/project/journal.ndjson -->');
  assert.ok(text.includes('Project Swarm brief'));
});

test('renderAgentHandoff names the right file per agent and rejects others', () => {
  const brief = buildBrief({ root: '/r', events: [], runs: [], now });
  assert.ok(renderAgentHandoff(brief, 'codex').includes('AGENTS.md'));
  assert.ok(renderAgentHandoff(brief, 'cursor').includes('.cursor/rules/project-swarm.mdc'));
  assert.ok(renderAgentHandoff(brief, 'claude').includes('CLAUDE.md'));
  assert.ok(renderAgentHandoff(brief, 'gemini').includes('GEMINI.md'));
  assert.ok(renderAgentHandoff(brief, 'codex').includes('orchestrator'));
  assert.throws(() => renderAgentHandoff(brief, 'gpt'), { message: 'handoff-agent-invalid: gpt' });
});
