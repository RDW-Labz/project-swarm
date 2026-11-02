// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isOwnerMessage, workBlocks, dailyHours, ownerActivity, ownerHoursOf, renderSummary, transcriptDir } from '../tools/time-auto.mjs';
import { logTime, readTime, localDay } from '../tools/quotes.mjs';
import { runTimeCommand, runQuoteCommand } from '../tools/quote-commands.mjs';
import { projectId } from '../tools/projects.mjs';

const MIN = 60000;
const at = (day, hh, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).getTime();
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'time-auto-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const NOW = at('2026-10-19', 15);

async function world(t, { messages = [], merges = [], approvals = [], inbox = [] } = {}) {
  const base = await tmp(t);
  const root = path.join(base, 'proj');
  const claudeDir = path.join(base, 'claude');
  const historyPath = path.join(base, 'history.ndjson');
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.mkdir(transcriptDir(root, { claudeDir }), { recursive: true });
  const user = (ms, content = 'please do the thing', extra = {}) => JSON.stringify({ type: 'user', timestamp: new Date(ms).toISOString(), message: { role: 'user', content }, ...extra });
  await fs.writeFile(path.join(transcriptDir(root, { claudeDir }), 's1.jsonl'), messages.map(ms => user(ms)).join('\n') + '\n');
  await fs.writeFile(historyPath, merges.map(ms => JSON.stringify({ at: new Date(ms).toISOString(), projectId: projectId(root), kind: 'merge' })).join('\n') + '\n');
  await fs.writeFile(path.join(root, '.swarm/project/tickets.log'), approvals.map(ms => JSON.stringify({ at: new Date(ms).toISOString(), event: 'approve', id: 'T-1', by: 'owner' })).join('\n') + '\n');
  await fs.writeFile(path.join(root, '.swarm/project/journal.ndjson'), inbox.map(ms => JSON.stringify({ ts: new Date(ms).toISOString(), kind: 'human' })).join('\n') + '\n');
  return { root, activity: { claudeDir, historyPath } };
}

test('only the owner\'s own messages count: not tool results, system notices, side conversations or meta lines', () => {
  const user = (content, extra = {}) => ({ type: 'user', message: { content }, ...extra });
  assert.equal(isOwnerMessage(user('merge 172')), true);
  assert.equal(isOwnerMessage(user([{ type: 'text', text: 'go ahead' }])), true);
  assert.equal(isOwnerMessage(user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }])), false);
  assert.equal(isOwnerMessage(user('<task-notification>done</task-notification>')), false);
  assert.equal(isOwnerMessage(user('<system-reminder>x</system-reminder>')), false);
  assert.equal(isOwnerMessage(user('[SYSTEM NOTIFICATION - NOT USER INPUT] x')), false);
  assert.equal(isOwnerMessage(user('hi', { isSidechain: true })), false);
  assert.equal(isOwnerMessage(user('hi', { isMeta: true })), false);
  assert.equal(isOwnerMessage(user('   ')), false);
  assert.equal(isOwnerMessage({ type: 'assistant', message: { content: 'hi' } }), false);
  assert.equal(isOwnerMessage(null), false);
});

test('working blocks: activity within 15 minutes is one block; its hours are the span plus a 5 minute tail; a lone event is 5 minutes', () => {
  const d = '2026-10-17';
  const stamps = [at(d, 9, 0), at(d, 9, 10), at(d, 9, 25), at(d, 9, 41), at(d, 12, 0)].map(a => ({ at: a, source: 'message' }));
  const blocks = workBlocks(stamps);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].events, 3, '9:00, 9:10, 9:25 chain; 9:41 is 16 minutes after 9:25');
  assert.equal(Math.round(blocks[0].hours * 60), 30, '25 minutes span plus 5');
  assert.equal(Math.round(blocks[1].hours * 60), 5);
  assert.equal(workBlocks([]).length, 0);
  assert.equal(workBlocks(stamps.slice().reverse()).length, 3, 'order does not matter');
  const exact = workBlocks([at(d, 9, 0), at(d, 9, 15)].map(a => ({ at: a, source: 'merge' })));
  assert.equal(exact.length, 1, 'exactly 15 minutes apart is still one block');
});

test('the sources: messages, approvals, merges and inbox answers all count; another project\'s merge does not; nothing from the content is kept', async t => {
  const d = '2026-10-17';
  const w = await world(t, { messages: [at(d, 9, 0)], approvals: [at(d, 9, 8)], merges: [at(d, 9, 12)], inbox: [at(d, 9, 14)] });
  await fs.appendFile(w.activity.historyPath, `${JSON.stringify({ at: new Date(at(d, 9, 13)).toISOString(), projectId: 'someoneelse00', kind: 'merge' })}\n`);
  await fs.appendFile(path.join(w.root, '.swarm/project/tickets.log'), `${JSON.stringify({ at: new Date(at(d, 20)).toISOString(), event: 'transition', by: 'owner' })}\n${JSON.stringify({ at: new Date(at(d, 21)).toISOString(), event: 'approve', by: 'go' })}\n`);
  const stamps = await ownerActivity(w.root, w.activity);
  assert.deepEqual(stamps.map(s => s.source), ['message', 'approval', 'merge', 'inbox answer']);
  assert.ok(stamps.every(s => Object.keys(s).join() === 'at,source'), 'timestamp and kind only');
  const h = await ownerHoursOf(w.root, w.activity);
  assert.equal(h.rows.length, 1);
  assert.equal(Math.round(h.rows[0].estimatedHours * 60), 19, '14 minutes span plus 5');
  assert.equal(h.rows[0].basis, 'estimated');
});

test('a manual entry replaces that day\'s estimate; --date corrects a past day; the estimate is never written to the time file', async t => {
  const w = await world(t, { messages: [at('2026-10-16', 9), at('2026-10-16', 9, 10), at('2026-10-17', 14)] });
  const before = await ownerHoursOf(w.root, w.activity);
  assert.deepEqual(before.rows.map(r => [r.day, r.basis]), [['2026-10-16', 'estimated'], ['2026-10-17', 'estimated']]);
  assert.equal(await fs.readFile(path.join(w.root, '.swarm/project/time.ndjson'), 'utf8').catch(() => ''), '', 'nothing written by estimating');
  const res = await runTimeCommand(w.root, ['log', '3', 'was longer', '--date', '2026-10-16'], { now: () => NOW, activity: w.activity });
  assert.equal(res.exitCode, 0, res.stdout);
  const after = await ownerHoursOf(w.root, w.activity);
  const row = after.rows.find(r => r.day === '2026-10-16');
  assert.deepEqual([row.counted, row.basis, row.manualHours], [3, 'entered', 3]);
  assert.equal(after.rows.find(r => r.day === '2026-10-17').basis, 'estimated');
  assert.equal(after.total, Math.round((3 + 5 / 60) * 100) / 100);
  const summary = (await runTimeCommand(w.root, ['summary'], { now: () => NOW, activity: w.activity })).stdout;
  assert.match(summary, /2026-10-16\s+3 h  you entered; the estimate was 0\.25/);
  assert.match(summary, /2026-10-17\s+0\.08 h  estimated \(1 working block\)/);
  assert.match(summary, /Correct a day with: swarm time log/);
  const noEntry = await runTimeCommand(w.root, ['log', '2', '--date', '2026-10-20'], { now: () => NOW });
  assert.match(noEntry.stdout, /cannot be in the future/);
  for (const bad of ['2026-13-01', '2026-02-30', 'yesterday', '2024-01-01']) assert.equal((await runTimeCommand(w.root, ['log', '1', '--date', bad], { now: () => NOW })).exitCode, 2, bad);
  assert.equal((await runTimeCommand(w.root, ['log', '1', '--date', '2026-10-17', '--through', '2026-10-17'], { now: () => NOW })).exitCode, 2, 'not both');
});

test('"5.5 hours so far" (--through): counted once and silences the estimates before it; later days are estimated again', async t => {
  const w = await world(t, { messages: [at('2026-10-16', 9), at('2026-10-17', 10), at('2026-10-18', 11), at('2026-10-20', 9)] });
  await runTimeCommand(w.root, ['log', '5.5', 'total so far', '--through', '2026-10-18'], { now: () => at('2026-10-20', 12), activity: w.activity });
  const h = await ownerHoursOf(w.root, w.activity);
  assert.deepEqual(h.rows.map(r => [r.day, r.counted, r.basis]), [['2026-10-16', 0, 'covered by your total'], ['2026-10-17', 0, 'covered by your total'], ['2026-10-18', 5.5, 'entered'], ['2026-10-20', 0.08, 'estimated']]);
  assert.equal(h.total, 5.58);
  assert.equal(h.estimatedPart, 0.08);
  const big = await logTime(w.root, '80', 'x', { now: () => NOW, through: '2026-10-18' });
  assert.equal(big.ok, true, 'a total may exceed one day');
  assert.equal((await logTime(w.root, '80', 'x', { now: () => NOW })).ok, false, 'a plain entry may not');
  assert.equal((await readTime(w.root)).skipped, 0);
});

test('the quote record keeps counted hours and says how many are estimated; a project with no activity and no entry has no hours (not 0)', async t => {
  const w = await world(t, { messages: [at('2026-10-17', 9)] });
  const dir = path.join(w.root, 'q');
  const res = await runQuoteCommand(w.root, ['record', '--name', 'p'], { env: { SWARM_QUOTES_DIR: dir }, now: () => NOW, activity: w.activity });
  assert.match(res.stdout, /owner hours 0\.08 \(0\.08 of them estimated\)/);
  const empty = await world(t);
  const res2 = await runQuoteCommand(empty.root, ['record', '--name', 'q'], { env: { SWARM_QUOTES_DIR: dir }, now: () => NOW, activity: empty.activity });
  assert.match(res2.stdout, /owner hours none/);
  assert.match(renderSummary({ rows: [], total: 0, estimatedPart: 0 }, { now: () => NOW }), /No activity/);
});

test('privacy: the auto time code reads timestamps only and makes no network call', async () => {
  const src = await fs.readFile(new URL('../tools/time-auto.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /fetch\(|node:https?|node:net|child_process/);
  assert.equal(localDay(at('2026-10-19', 0, 5)), '2026-10-19');
});
