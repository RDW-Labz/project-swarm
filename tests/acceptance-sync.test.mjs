// SPDX-License-Identifier: Apache-2.0
// Acceptance enforcement at sync: every acceptance line is covered by a passing test (ACn in a test title) or passed the acceptance review;
// a ticket with an unmet line stays in review. Parts-app S8: T-0168 went done without "validate + encode reply links" or "thin page under 8 KB".
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger, writeLedger, createLedger } from '../tools/tickets.mjs';
import { buildPlanSnapshot } from '../tools/watch-plan.mjs';
import { validateProfile } from '../tools/init-profile.mjs';

const LINES = ['validate + encode reply links', 'thin page under 8 KB'];
const tmp = async t => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acc-sync-'))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const put = async (root, file, text) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };
const TESTS = "import { test } from 'vitest';\ntest('AC1: validates and encodes reply links', () => {});\n";
const ticket = (extra = {}) => ({ id: 'T-0001', title: 'Reply page', type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: LINES, files: ['src/page.ts'], tests: ['tests/page.test.ts'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'review', runId: 'r9', ...extra });
const queue = { state: 'done', integrated: ['T-0001'], integratedIn: { 'T-0001': 1 }, checkFailed: [], batches: [{ id: 1, jobs: ['T-0001'], checks: 'passed', checkResults: [{ name: 'tests', status: 'passed', mode: 'full' }] }] };

async function setup(t, { profile = { verify: { command: ['npm', 'test'] } }, tickets = [ticket()], testSource = TESTS } = {}) {
  const root = await tmp(t);
  await put(root, 'package.json', JSON.stringify({ name: 'app', scripts: {} }));
  await put(root, 'src/page.ts', 'export const page = 1;\n');
  await put(root, 'tests/page.test.ts', testSource);
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets }));
  if (profile) await put(root, '.project-swarm.json', JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, ...profile } }));
  await put(root, '.swarm/runs/r9/state.json', JSON.stringify({ id: 'r9', integratedAt: 'now', integratedFiles: [], mergeQueue: queue, jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/page.ts', 'tests/page.test.ts'] }] }));
  return root;
}
const sync = (root, ...more) => runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', ...more]);
const ticketOf = async root => (await readLedger(root)).tickets[0];
const reviewRun = async (root, runId, text, extra = {}) => {
  // The run's manifest carries the review token sync wrote (the command checks it).
  const nonce = JSON.parse(await fs.readFile(path.join(root, '.swarm/acceptance-reviews/r9.hashes.json'), 'utf8')).nonce;
  await put(root, `.swarm/runs/${runId}/manifest.json`, JSON.stringify({ version: 1, jobs: [{ id: 'acc-review-r9', prompt: `review ${nonce}` }] }));
  await put(root, `.swarm/runs/${runId}/state.json`, JSON.stringify({ id: runId, jobs: [{ id: 'acc-review-r9', status: 'complete', model: 'sonnet', ...extra }] }));
  await put(root, `.swarm/runs/${runId}/acc-review-r9/response.txt`, text);
};
const answer = (lines, ticketId = 'T-0001') => `Looked at the code.\n${JSON.stringify({ acceptance: [{ ticket: ticketId, lines }] })}\n`;

test('a line a passing test covers is met; the other goes to the acceptance review and the ticket stays in review', async t => {
  const root = await setup(t);
  const res = await sync(root);
  assert.match(res.stdout, /0 ticket\(s\) marked done/);
  assert.match(res.stdout, /stay in review: acceptance lines no passing test covers[^\n]*T-0001 \(line 2\)/);
  assert.match(res.stdout, /swarm run \.swarm\/acceptance-reviews\/r9\.json; then swarm scope acceptance-review/);
  assert.equal((await ticketOf(root)).status, 'review');
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.swarm/acceptance-reviews/r9.json'), 'utf8'));
  assert.equal(manifest.jobs.length, 1);
  assert.equal(manifest.jobs[0].type, 'review');
  assert.deepEqual(manifest.jobs[0].outputs, []);
  assert.ok(manifest.jobs[0].prompt.includes('thin page under 8 KB'));
  assert.ok(!manifest.jobs[0].prompt.includes('validate + encode reply links'), 'a covered line is not sent to the review');
  assert.ok(manifest.jobs[0].context.includes('src/page.ts') && manifest.jobs[0].context.includes('tests/page.test.ts'));
});

test('a passing review for the other line lets the ticket reach done, with a per-line report on the ticket, in the sync output and in Swarm Watch', async t => {
  const root = await setup(t);
  await sync(root);
  await reviewRun(root, 'rv', answer([{ n: 2, verdict: 'pass', evidence: 'src/page.ts is 120 bytes' }]));
  const rec = await runScopeCommand(root, 'scope', ['acceptance-review', 'rv']);
  assert.equal(rec.exitCode, 0, rec.stdout);
  assert.match(rec.stdout, /T-0001: 1 line\(s\) pass/);
  const done = await sync(root);
  assert.match(done.stdout, /1 ticket\(s\) marked done/);
  assert.match(done.stdout, /acceptance: T-0001 AC1 pass \(test\), AC2 pass \(review\)/);
  const tk = await ticketOf(root);
  assert.equal(tk.status, 'done');
  assert.deepEqual(tk.acceptanceResults.map(r => [r.n, r.by, r.verdict]), [[1, 'test', 'pass'], [2, 'review', 'pass']]);
  assert.equal(tk.acceptanceResults[1].evidence, 'src/page.ts is 120 bytes');
  const snap = buildPlanSnapshot(await readLedger(root));
  assert.equal(snap.tickets['T-0001'].acceptanceResults[1].evidence, 'src/page.ts is 120 bytes');
});

test('a failing line sends the ticket back with the line and the reason; a pass on code that changed since is not used', async t => {
  const root = await setup(t);
  await sync(root);
  await reviewRun(root, 'rv', answer([{ n: 2, verdict: 'fail', evidence: 'the page is 16.7 KB' }]));
  await runScopeCommand(root, 'scope', ['acceptance-review', 'rv']);
  const back = await sync(root);
  assert.match(back.stdout, /back to ready/);
  const tk = await ticketOf(root);
  assert.equal(tk.status, 'ready');
  assert.match(tk.retryNote, /acceptance not met; line 2 "thin page under 8 KB": the page is 16.7 KB/);
  // A pass, then the code changes: the stored verdict no longer counts.
  const root2 = await setup(t);
  await sync(root2);
  await reviewRun(root2, 'rv', answer([{ n: 2, verdict: 'pass', evidence: 'small' }]));
  await runScopeCommand(root2, 'scope', ['acceptance-review', 'rv']);
  await put(root2, 'src/page.ts', 'export const page = 2; // bigger now\n');
  const stale = await sync(root2);
  assert.match(stale.stdout, /0 ticket\(s\) marked done/);
  assert.match(stale.stdout, /T-0001 \(line 2\)/);
  assert.equal((await ticketOf(root2)).status, 'review');
});

test('tests that do not count: a skipped test, a test the runner did not see pass (no verify block), a tag that only looks like one', async t => {
  const skipped = await setup(t, { testSource: "it.skip('AC1: validates', () => {});\n// test('AC2: nothing', () => {});\ntest('AC12: another line', () => {});\n" });
  const res = await sync(skipped);
  assert.match(res.stdout, /T-0001 \(lines 1, 2\)/);
  const unseen = await setup(t, { profile: {} });
  const res2 = await sync(unseen);
  assert.match(res2.stdout, /T-0001 \(lines 1, 2\)/, 'covered by a test that was not seen passing: still needs the review');
});

test('the review answer: asked once more when unusable, then acceptance-blocked; a later verdict clears it', async t => {
  const root = await setup(t);
  await sync(root);
  await reviewRun(root, 'rv', 'it looks fine to me\n');
  const asked = [];
  const runReview = async (r, manifest) => { asked.push(manifest); await reviewRun(r, 'rv2', 'still no result\n'); return { id: 'rv2' }; };
  const res = await runScopeCommand(root, 'scope', ['acceptance-review', 'rv'], { runReview });
  assert.equal(res.exitCode, 1);
  assert.equal(asked.length, 1);
  assert.match(asked[0].jobs[0].prompt, /FORMAT REMINDER: your last answer had no result line[^]*"acceptance":/);
  assert.match(res.stdout, /acceptance-blocked \(not done\): T-0001/);
  assert.equal((await ticketOf(root)).status, 'review');
  assert.ok((await ticketOf(root)).acceptanceBlocked);
  assert.match(await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8'), /"event":"acceptance-blocked"/);
  const again = await runScopeCommand(root, 'scope', ['acceptance-review', 'rv'], { runReview });
  assert.equal(asked.length, 1, 'never a third ask');
  assert.equal(again.exitCode, 1);
  const held = await sync(root);
  assert.match(held.stdout, /acceptance-blocked: the last review gave no result/);
  assert.match(held.stdout, /0 ticket\(s\) marked done/);
  const snap = buildPlanSnapshot(await readLedger(root));
  assert.ok(snap.tickets['T-0001'].acceptanceBlocked);
  await reviewRun(root, 'rv3', answer([{ n: 2, verdict: 'pass', evidence: 'ok' }]));
  assert.equal((await runScopeCommand(root, 'scope', ['acceptance-review', 'rv3'], { runReview })).exitCode, 0);
  assert.equal((await ticketOf(root)).acceptanceBlocked, undefined);
  assert.match((await sync(root)).stdout, /1 ticket\(s\) marked done/);
});

test('--accept-unmet needs a reason and --yes, never overrides a failing line, is logged and shown on the ticket', async t => {
  const root = await setup(t);
  const log = () => fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8').catch(() => '');
  assert.match((await sync(root, '--accept-unmet', 'T-0001', '--yes')).stdout, /needs --reason TEXT/);
  assert.match((await sync(root, '--accept-unmet', 'T-0001', '--reason', 'Sonnet is down today')).stdout, /Rerun with --yes/);
  assert.ok(!/accept-unmet/.test(await log()));
  assert.equal((await ticketOf(root)).status, 'review');
  const ok = await sync(root, '--accept-unmet', 'T-0001', '--reason', 'Sonnet is down today', '--yes');
  assert.match(ok.stdout, /1 ticket\(s\) marked done/);
  const tk = await ticketOf(root);
  assert.equal(tk.status, 'done');
  assert.deepEqual(tk.acceptanceResults.map(r => [r.n, r.by, r.verdict]), [[1, 'test', 'pass'], [2, 'owner', 'accepted']]);
  assert.equal(tk.acceptanceResults[1].evidence, 'Sonnet is down today');
  const entries = (await log()).split('\n').filter(l => l.includes('"event":"accept-unmet"'));
  assert.equal(entries.length, 1);
  assert.deepEqual(JSON.parse(entries[0]).tickets, ['T-0001']);
  // A failing line is not overridden.
  const root2 = await setup(t);
  await sync(root2);
  await reviewRun(root2, 'rv', answer([{ n: 2, verdict: 'fail', evidence: 'too big' }]));
  await runScopeCommand(root2, 'scope', ['acceptance-review', 'rv']);
  const back = await sync(root2, '--accept-unmet', 'T-0001', '--reason', 'I know, ship it anyway', '--yes');
  assert.match(back.stdout, /back to ready/);
  assert.equal((await ticketOf(root2)).status, 'ready');
});

test('enforcement is off for a project with no profile and with acceptance enforce false; the profile block is validated', async t => {
  const none = await setup(t, { profile: null });
  assert.match((await sync(none)).stdout, /1 ticket\(s\) marked done/);
  const off = await setup(t, { profile: { acceptance: { enforce: false } } });
  assert.match((await sync(off)).stdout, /1 ticket\(s\) marked done/);
  assert.deepEqual(validateProfile({ acceptance: { enforce: true, model: 'opus' } }).errors, []);
  assert.ok(validateProfile({ acceptance: { enforce: 'yes' } }).errors.some(e => e.startsWith('profile.acceptance')));
  assert.ok(validateProfile({ acceptance: { model: 'haiku' } }).errors.some(e => e.startsWith('profile.acceptance')));
  assert.ok(validateProfile({ acceptance: { extra: 1 } }).errors.some(e => e.startsWith('profile.acceptance')));
});

test('tickets without acceptance lines, human tickets and ci tickets are not held', async t => {
  const root = await setup(t, { tickets: [ticket({ type: 'docs', acceptance: [], files: ['src/page.ts'], tests: [] })] });
  assert.match((await sync(root)).stdout, /1 ticket\(s\) marked done/);
});

test('review findings: an invalid profile refuses the sync instead of switching the gate off', async t => {
  const root = await setup(t, { profile: { acceptance: { enforce: 'yes' } } });
  const res = await sync(root);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /project profile does not validate, so acceptance lines cannot be checked/);
  assert.equal((await ticketOf(root)).status, 'review');
});

test('review findings: tests accepted as failed, or output already in the tree, are not "seen passing"; a tag in a file that is not a test file covers nothing', async t => {
  const root = await setup(t);
  const state = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs/r9/state.json'), 'utf8'));
  state.mergeQueue = { ...queue, batches: [{ id: 1, jobs: ['T-0001'], checks: 'passed', checkResults: [{ name: 'tests', status: 'failed', mode: 'full', tail: 'expected 200 got 500' }] }] };
  await put(root, '.swarm/runs/r9/state.json', JSON.stringify(state));
  const res = await sync(root, '--accept-failed-check', 'tests', '--yes');
  assert.match(res.stdout, /T-0001 \(lines 1, 2\)/, 'a failure the owner accepted does not make the tagged test count');
  assert.equal((await ticketOf(root)).status, 'review');
  // The tag sits in a helper that is not a test file.
  const root2 = await setup(t, { tickets: [ticket({ tests: ['src/helper.ts'] })], testSource: TESTS });
  await put(root2, 'src/helper.ts', "test('AC1: not a test file', () => {});\n");
  assert.match((await sync(root2)).stdout, /T-0001 \(lines 1, 2\)/);
});

test('review findings: a review made from an older manifest is refused (the token); a verdict follows the text of its line', async t => {
  const root = await setup(t);
  await sync(root);
  await reviewRun(root, 'rv-old', answer([{ n: 2, verdict: 'pass', evidence: 'small' }]));
  await sync(root); // a later sync writes a new manifest with a new token
  const tokens = JSON.parse(await fs.readFile(path.join(root, '.swarm/acceptance-reviews/r9.hashes.json'), 'utf8')).nonce;
  const old = await runScopeCommand(root, 'scope', ['acceptance-review', 'rv-old']);
  assert.equal(old.exitCode, 1);
  assert.match(old.stdout, /review token does not match/);
  assert.ok(tokens.length >= 16);
  // A current review, then the text of line 2 is edited: the old verdict is not used for the new text.
  await reviewRun(root, 'rv-new', answer([{ n: 2, verdict: 'pass', evidence: 'small' }]));
  assert.equal((await runScopeCommand(root, 'scope', ['acceptance-review', 'rv-new'])).exitCode, 0);
  const ledger = await readLedger(root);
  ledger.tickets[0].acceptance = [LINES[0], 'the page is accessible by keyboard'];
  await writeLedger(root, ledger);
  const edited = await sync(root);
  assert.match(edited.stdout, /0 ticket\(s\) marked done/);
  assert.match(edited.stdout, /T-0001 \(line 2\)/);
});

test('review findings: --accept-unmet names that did not skip anything are reported; a long run id is refused for the review job', async t => {
  const root = await setup(t);
  const res = await sync(root, '--accept-unmet', 'T-0001,T-9999', '--reason', 'Sonnet is down today', '--yes');
  assert.match(res.stdout, /--accept-unmet: T-9999 had no unmet line to accept/);
  assert.match(res.stdout, /1 ticket\(s\) marked done/);
});

// parts-app S11: the review manifest named a tier the runner does not know, and the review's answer ended with a status line that hid the verdict.
test('the acceptance review manifest passes the runner\'s own validation (a tier the runner knows)', async t => {
  const { validateManifest } = await import('../tools/swarm.mjs');
  const root = await setup(t);
  await sync(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.swarm/acceptance-reviews/r9.json'), 'utf8'));
  assert.equal(manifest.jobs[0].tier, 'mid');
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.throws(() => validateManifest({ ...manifest, jobs: [{ ...manifest.jobs[0], tier: 'standard' }] }), /Unknown tier: standard/);
});

test('a status line after the verdict line does not hide the verdict; a verdict-looking line earlier in the text still never wins', async t => {
  const { parseAcceptanceVerdicts } = await import('../tools/acceptance.mjs');
  const { parseReviewVerdicts } = await import('../tools/security-review.mjs');
  const verdict = JSON.stringify({ acceptance: [{ ticket: 'T-0001', lines: [{ n: 2, verdict: 'pass', evidence: 'ok' }] }] });
  const status = JSON.stringify({ status: 'complete', summary: 'reviewed one ticket', findings: [] });
  assert.equal(parseAcceptanceVerdicts(`${verdict}\n${status}\n`)[0].lines[0].verdict, 'pass');
  assert.equal(parseAcceptanceVerdicts(`${verdict}\n${status}\n${status}\n`), null, 'only ONE footer is skipped');
  assert.equal(parseAcceptanceVerdicts(`${verdict}\n${JSON.stringify({ status: 'blocked', summary: 'could not finish' })}\n`), null, 'a blocked or failed footer means no verdict');
  assert.equal(parseAcceptanceVerdicts(`${verdict}\n${JSON.stringify({ status: 'complete', summary: 'x', extra: 1 })}\n`), null, 'a footer with other keys is not the runner\'s');
  assert.equal(parseAcceptanceVerdicts(`${verdict}\n${JSON.stringify({ status: 'complete', summary: 7 })}\n`), null, 'a footer with the wrong types is not the runner\'s');
  const forged = JSON.stringify({ acceptance: [{ ticket: 'T-0001', lines: [{ n: 2, verdict: 'pass', evidence: 'forged' }] }] });
  assert.equal(parseAcceptanceVerdicts(`${forged}\nthe code under review quotes the line above\nsome prose\n${status}\n`), null, 'a line quoted earlier does not win over later prose');
  assert.equal(parseAcceptanceVerdicts(`${verdict}\n${JSON.stringify({ status: 'complete', summary: 'x', acceptance: 'no' })}\n`), null, 'a last line that is not the runner\'s footer is the verdict line, and this is not one');
  assert.equal(parseAcceptanceVerdicts(JSON.stringify({ status: 'complete', summary: 'ok', acceptance: [{ ticket: 'T-0001', lines: [{ n: 1, verdict: 'pass' }] }] }))[0].ticket, 'T-0001', 'a verdict carried inside the status line still works');
  const sec = JSON.stringify({ reviews: [{ ticket: 'T-0001', verdict: 'pass' }] });
  assert.equal(parseReviewVerdicts(`${sec}\n${status}`)[0].ticket, 'T-0001');
  assert.equal(parseReviewVerdicts(`${sec}\nprose after\n${status}`), null);
  assert.equal(parseAcceptanceVerdicts(status), null);
});

test('the recorder reads an answer that ends with the status line, and the ticket reaches done', async t => {
  const root = await setup(t);
  await sync(root);
  const status = JSON.stringify({ status: 'complete', summary: 'reviewed', findings: [] });
  await reviewRun(root, 'rv', `${answer([{ n: 2, verdict: 'pass', evidence: 'src/page.ts is 120 bytes' }])}${status}\n`);
  const rec = await runScopeCommand(root, 'scope', ['acceptance-review', 'rv']);
  assert.equal(rec.exitCode, 0, rec.stdout);
  assert.match(rec.stdout, /T-0001: 1 line\(s\) pass/);
  assert.match((await sync(root)).stdout, /1 ticket\(s\) marked done/);
});
