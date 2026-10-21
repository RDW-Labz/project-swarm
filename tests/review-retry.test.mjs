// SPDX-License-Identifier: Apache-2.0
// The security review no longer lets a ticket slip to done on an unreadable answer: a missing {"reviews":[...]} result is asked for once more
// with a format reminder, then the ticket is review-blocked; --accept-unreviewed needs a reason and is logged on the ticket and in Swarm Watch.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand, REVIEW_FORMAT_REMINDER } from '../tools/scope-commands.mjs';
import { readLedger, writeLedger, createLedger, validateTicket } from '../tools/tickets.mjs';
import { buildPlanSnapshot } from '../tools/watch-plan.mjs';

const SCOPE_HASH = { name: 'P', version: 1, hash: 'a'.repeat(64) };
const tmp = async t => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-retry-'))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const tk = (id, extra = {}) => ({ id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/app/api/${id}/route.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'review', runId: 'r9', ...extra });
const put = async (root, file, text) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };
const GOOD = id => `Looked at it.\n${JSON.stringify({ reviews: [{ ticket: id, verdict: 'pass', findings: [] }] })}\n`;
const BAD = 'I reviewed the route and it looks fine to me, no problems found.\n';

async function setup(t, ids = ['T-0001']) {
  const root = await tmp(t);
  await put(root, 'package.json', JSON.stringify({ name: 'app', scripts: {} }));
  for (const id of ids) await put(root, `src/app/api/${id}/route.ts`, 'export async function POST() { return Response.json({}); }');
  await writeLedger(root, createLedger({ scope: SCOPE_HASH, tickets: ids.map(id => tk(id)) }));
  await put(root, '.swarm/runs/r9/state.json', JSON.stringify({ id: 'r9', integratedAt: 'now', integratedFiles: [], jobs: ids.map(id => ({ id, status: 'complete', outputs: [`src/app/api/${id}/route.ts`] })) }));
  const synced = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(synced.stdout, /stay in review until an Opus security review passes/);
  return root;
}
const reviewRunFile = async (root, runId, text, extra = {}) => {
  await put(root, `.swarm/runs/${runId}/state.json`, JSON.stringify({ id: runId, jobs: [{ id: 'sec-review-r9', status: 'complete', model: 'opus', ...extra }] }));
  await put(root, `.swarm/runs/${runId}/sec-review-r9/response.txt`, text);
};

test('a review with no reviews array is asked again once, with the format reminder, and the second answer is used', async t => {
  const root = await setup(t);
  await reviewRunFile(root, 'rv', BAD);
  const asked = [];
  const runReview = async (r, manifest) => { asked.push(manifest); await reviewRunFile(r, 'rv2', GOOD('T-0001')); return { id: 'rv2' }; };
  const res = await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview });
  assert.equal(res.exitCode, 0, res.stdout);
  assert.equal(asked.length, 1, 'asked exactly once');
  assert.ok(asked[0].jobs[0].prompt.endsWith(REVIEW_FORMAT_REMINDER), 'the second ask carries the format reminder');
  assert.equal(asked[0].jobs[0].model, 'opus');
  assert.match(res.stdout, /asked once more with the format reminder/);
  assert.match(res.stdout, /T-0001: pass/);
  const records = JSON.parse(await fs.readFile(path.join(root, '.swarm/security-reviews/records.json'), 'utf8'));
  assert.equal(records.tickets['T-0001'].verdict, 'pass');
  assert.equal(records.tickets['T-0001'].run, 'rv2');
  const done = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(done.stdout, /1 ticket\(s\) marked done/);
});

test('a valid first answer never triggers a second ask', async t => {
  const root = await setup(t);
  await reviewRunFile(root, 'rv', GOOD('T-0001'));
  const runReview = async () => { throw new Error('must not be asked'); };
  assert.equal((await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview })).exitCode, 0);
});

test('still no reviews array after the second ask: the ticket is review-blocked, stays in review, and is never done', async t => {
  const root = await setup(t, ['T-0001', 'T-0002']);
  await reviewRunFile(root, 'rv', BAD);
  let calls = 0;
  const runReview = async r => { calls += 1; await reviewRunFile(r, 'rv2', BAD); return { id: 'rv2' }; };
  const res = await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview });
  assert.equal(res.exitCode, 1);
  assert.equal(calls, 1);
  assert.match(res.stdout, /review-blocked \(not done\): T-0001, T-0002/);
  const ledger = await readLedger(root);
  for (const t2 of ledger.tickets) {
    assert.equal(t2.status, 'review', 'not done');
    assert.equal(t2.securityReview.state, 'blocked');
    assert.match(t2.securityReview.reason, /no \{"reviews":\[\.\.\.\]\} result, also when asked again/);
    assert.equal(validateTicket(t2).ok, true);
  }
  assert.match(await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8'), /"event":"review-blocked","id":"T-0001"/);
  // The same source review is never asked a third time (a marker), and sync does not move the tickets to done.
  const again = await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview });
  assert.equal(calls, 1, 'no second paid ask for the same review');
  assert.equal(again.exitCode, 1);
  const sync = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(sync.stdout, /0 ticket\(s\) marked done/);
  assert.match(sync.stdout, /review-blocked: the last review gave no result/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
  // Swarm Watch shows it.
  const snap = buildPlanSnapshot(await readLedger(root));
  assert.equal(snap.tickets['T-0001'].securityReview.state, 'blocked');
  assert.equal(snap.stages[0].epics[0].cards[0].securityReview.state, 'blocked');
});

test('a second ask that fails to run, or whose job is not opus, also ends review-blocked', async t => {
  const root = await setup(t);
  await reviewRunFile(root, 'rv', BAD);
  const res = await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview: async r => { await reviewRunFile(r, 'rv2', GOOD('T-0001'), { model: 'haiku' }); return { id: 'rv2' }; } });
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /second ask: the security review job reviewer unknown agent\/haiku is not accepted; accepted reviewers: claude\/opus; anthropic\/claude-opus-<version>/);
  assert.equal((await readLedger(root)).tickets[0].securityReview.state, 'blocked');
});

test('a verdict that arrives later clears the blocked mark', async t => {
  const root = await setup(t);
  await reviewRunFile(root, 'rv', BAD);
  await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview: async r => { await reviewRunFile(r, 'rv2', BAD); return { id: 'rv2' }; } });
  assert.equal((await readLedger(root)).tickets[0].securityReview.state, 'blocked');
  await reviewRunFile(root, 'rv3', GOOD('T-0001'));
  const res = await runScopeCommand(root, 'scope', ['security-review', 'rv3'], { runReview: async () => { throw new Error('no ask needed'); } });
  assert.equal(res.exitCode, 0);
  assert.equal((await readLedger(root)).tickets[0].securityReview, undefined);
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /1 ticket\(s\) marked done/);
});

test('--accept-unreviewed needs a --reason; with it the ticket is logged, marked on the ticket and shown in Swarm Watch', async t => {
  const root = await setup(t);
  const log = () => fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8').catch(() => '');
  const noReason = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-unreviewed', 'T-0001', '--yes']);
  assert.equal(noReason.exitCode, 1);
  assert.match(noReason.stdout, /needs --reason TEXT/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review', 'nothing changed');
  assert.ok(!/accept-unreviewed/.test(await log()), 'nothing was logged');
  const tooShort = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-unreviewed', 'T-0001', '--reason', 'ok', '--yes']);
  assert.equal(tooShort.exitCode, 1);
  const noYes = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-unreviewed', 'T-0001', '--reason', 'Opus returned no reviews array twice']);
  assert.equal(noYes.exitCode, 1);
  assert.match(noYes.stdout, /reason: Opus returned no reviews array twice/);
  const ok = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-unreviewed', 'T-0001', '--reason', 'Opus returned no reviews array twice', '--yes']);
  assert.match(ok.stdout, /1 ticket\(s\) marked done/);
  const ticket = (await readLedger(root)).tickets[0];
  assert.equal(ticket.status, 'done');
  assert.equal(ticket.securityReview.state, 'accepted-unreviewed');
  assert.equal(ticket.securityReview.reason, 'Opus returned no reviews array twice');
  assert.match(await log(), /"event":"accept-unreviewed"[^\n]*"reason":"Opus returned no reviews array twice"/);
  const snap = buildPlanSnapshot(await readLedger(root));
  assert.equal(snap.tickets['T-0001'].securityReview.state, 'accepted-unreviewed');
  assert.equal(snap.tickets['T-0001'].securityReview.reason, 'Opus returned no reviews array twice');
});

test('securityReview on a ticket is validated', () => {
  const base = tk('T-0001', { status: 'ready' });
  assert.equal(validateTicket({ ...base, securityReview: { state: 'blocked', reason: 'x' } }).ok, true);
  assert.equal(validateTicket({ ...base, securityReview: { state: 'nope', reason: 'x' } }).ok, false);
  assert.equal(validateTicket({ ...base, securityReview: { state: 'blocked' } }).ok, false);
  assert.equal(validateTicket({ ...base, securityReview: 'blocked' }).ok, false);
});

test('review findings: a tampered manifest is never paid for; a rerun reads the earlier second answer; an empty list is unusable', async t => {
  const root = await setup(t);
  await reviewRunFile(root, 'rv', BAD);
  const file = path.join(root, '.swarm/security-reviews/r9.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...manifest, jobs: [...manifest.jobs, { ...manifest.jobs[0], id: 'extra' }] }));
  let calls = 0;
  const runReview = async r => { calls += 1; await reviewRunFile(r, 'rv2', GOOD('T-0001')); return { id: 'rv2' }; };
  const tampered = await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview });
  assert.equal(calls, 0, 'nothing was paid for');
  assert.match(tampered.stdout, /the review manifest is not the single read-only review job sync wrote; accepted reviewers: claude\/opus; anthropic\/claude-opus-<version>/);
  assert.equal((await readLedger(root)).tickets[0].securityReview.state, 'blocked');
  // A good manifest, an empty list as the first answer: asked again; the marker keeps the second run, so a rerun reads it and does not pay or block.
  await fs.writeFile(file, JSON.stringify(manifest));
  const ledger = await readLedger(root);
  delete ledger.tickets[0].securityReview;
  await writeLedger(root, ledger);
  await reviewRunFile(root, 'rv', `nothing\n${JSON.stringify({ reviews: [] })}\n`);
  const first = await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview });
  assert.equal(first.exitCode, 0, first.stdout);
  assert.equal(calls, 1);
  const rerun = await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview });
  assert.equal(calls, 1, 'never a third ask');
  assert.equal(rerun.exitCode, 0, rerun.stdout);
  assert.match(rerun.stdout, /the second ask made earlier is read/);
  assert.equal((await readLedger(root)).tickets[0].securityReview, undefined, 'a ticket with a valid verdict is not blocked');
});

test('review findings: a blocked ticket is held until a verdict newer than the block arrives; a wrong second job is refused', async t => {
  const root = await setup(t);
  const hashes = JSON.parse(await fs.readFile(path.join(root, '.swarm/security-reviews/r9.hashes.json'), 'utf8'));
  // An old pass on the current code, then a block: the old pass must not carry the ticket to done.
  await put(root, '.swarm/security-reviews/records.json', JSON.stringify({ tickets: { 'T-0001': { verdict: 'pass', findings: [], run: 'old', at: '2020-01-01T00:00:00.000Z', filesHash: hashes['T-0001'] } } }));
  const ledger = await readLedger(root);
  ledger.tickets[0].securityReview = { state: 'blocked', reason: 'no result twice', at: new Date().toISOString(), run: 'rv' };
  await writeLedger(root, ledger);
  const held = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(held.stdout, /0 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
  await reviewRunFile(root, 'rv9', GOOD('T-0001'));
  await runScopeCommand(root, 'scope', ['security-review', 'rv9'], {});
  const done = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(done.stdout, /1 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets[0].securityReview, undefined, 'the blocked mark is gone once it is done');
  // A second ask whose job belongs to another source run is refused.
  const root2 = await setup(t);
  await reviewRunFile(root2, 'rv', BAD);
  const res = await runScopeCommand(root2, 'scope', ['security-review', 'rv'], { runReview: async r => { await put(r, '.swarm/runs/rv2/state.json', JSON.stringify({ id: 'rv2', jobs: [{ id: 'sec-review-other', status: 'complete', model: 'opus' }] })); await put(r, '.swarm/runs/rv2/sec-review-other/response.txt', GOOD('T-0001')); return { id: 'rv2' }; } });
  assert.match(res.stdout, /not the review of the same source run/);
  assert.equal(res.exitCode, 1);
});

test('review findings: --accept-unreviewed never overrides a failing review, is not marked on a ticket whose review passed, logs only real skips, validates before logging', async t => {
  const root = await setup(t, ['T-0001', 'T-0002', 'T-0003']);
  const hashes = JSON.parse(await fs.readFile(path.join(root, '.swarm/security-reviews/r9.hashes.json'), 'utf8'));
  await put(root, '.swarm/security-reviews/records.json', JSON.stringify({ tickets: {
    'T-0001': { verdict: 'fail', findings: [{ severity: 'high', issue: 'no auth' }], run: 'rv', at: new Date().toISOString(), filesHash: hashes['T-0001'] },
    'T-0002': { verdict: 'pass', findings: [], run: 'rv', at: new Date().toISOString(), filesHash: hashes['T-0002'] },
  } }));
  const log = () => fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8').catch(() => '');
  const refused = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-failed-check', 'test', '--accept-unreviewed', 'T-0001', '--yes']);
  assert.equal(refused.exitCode, 1);
  assert.ok(!/accept-failed-check/.test(await log()), 'a refused command logs nothing, not even the other flag');
  const res = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-unreviewed', 'T-0001,T-0002,T-0003,T-9999', '--reason', 'Opus keeps answering without a result', '--yes']);
  const ledger = await readLedger(root);
  const by = id => ledger.tickets.find(x => x.id === id);
  assert.equal(by('T-0001').status, 'ready', 'a failing review sends the ticket back, it is not overridden');
  assert.equal(by('T-0002').status, 'done');
  assert.equal(by('T-0002').securityReview, undefined, 'its review passed: it did not skip anything');
  assert.equal(by('T-0003').status, 'done');
  assert.equal(by('T-0003').securityReview.state, 'accepted-unreviewed');
  assert.match(res.stdout, /did not skip a review/);
  const entry = (await log()).split('\n').filter(l => l.includes('"event":"accept-unreviewed"'));
  assert.equal(entry.length, 1);
  assert.deepEqual(JSON.parse(entry[0]).tickets, ['T-0003']);
  // Control characters and bidi marks do not count towards the reason and are not stored.
  const root2 = await setup(t);
  const bad = await runScopeCommand(root2, 'scope', ['sync', 'r9', '--integrated', '--accept-unreviewed', 'T-0001', '--reason', '\u0000\u001b‮‮‮‮‮‮‮‮', '--yes']);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /needs --reason/);
});

test('a re-ask refused by the project spend cap is reported, and the one re-ask is not used up', async t => {
  const root = await setup(t);
  await reviewRunFile(root, 'rv', BAD);
  const capped = async () => { throw Object.assign(new Error('project-cap: this project has spent $5.00 across 2 runs >= the project cap $5.00; no new run starts.'), { code: 'project-cap' }); };
  const res = await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview: capped });
  assert.match(res.stdout, /project-cap: this project has spent/);
  await assert.rejects(fs.stat(path.join(root, '.swarm/security-reviews/rv.retried')), { code: 'ENOENT' }, 'no retried marker');
  // The owner raised the cap: the same review is asked again, once.
  let asked = 0;
  const ok = await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview: async r => { asked += 1; await reviewRunFile(r, 'rv2', GOOD('T-0001')); return { id: 'rv2' }; } });
  assert.equal(asked, 1);
  assert.equal(ok.exitCode, 0, ok.stdout);
});

test('a re-ask that fails before a review run exists because the cap setting is invalid also keeps its retry', async t => {
  const root = await setup(t);
  await reviewRunFile(root, 'rv', BAD);
  await runScopeCommand(root, 'scope', ['security-review', 'rv'], { runReview: async () => { throw Object.assign(new Error('project-cap-invalid: profile budget.projectMaxUsd must be a number above 0'), { code: 'project-cap-invalid' }); } });
  await assert.rejects(fs.stat(path.join(root, '.swarm/security-reviews/rv.retried')), { code: 'ENOENT' });
});
