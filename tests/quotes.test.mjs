// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedger, writeLedger } from '../tools/tickets.mjs';
import { distance, rangeOf, buildQuote, renderQuote, readTime, readRecords, saveRecord, readQuoteConfig } from '../tools/quotes.mjs';
import { runTimeCommand, runQuoteCommand } from '../tools/quote-commands.mjs';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quotes-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const rec = (name, over = {}) => ({ id: name, name, source: 'recorded', requirements: 10, stages: 3, screens: 8, services: 2, billedUsd: 20, ownerHours: 30, calendarDays: 20, gpuHours: null, ...over });
const scopeOf = n => ['# Scope: X', 'Version: 1', '## Stages', '- S1: A', '- S2: B', '## S1 A', ...Array.from({ length: n }, (_, i) => `### R-${String(i + 1).padStart(3, '0')} Thing ${i}.\nAcceptance:\n- ok`), '## Screens', '- Home', '- Cart', '## External', '- Resend: email'].join('\n');
const env = dir => ({ SWARM_QUOTES_DIR: dir });

test('hours: logged one entry at a time, validated, listed with a total, bad lines skipped', async t => {
  const root = await tmp(t);
  assert.equal((await runTimeCommand(root, ['log', '2.5', 'wiring', 'the', 'cart'], { now: () => NOW })).exitCode, 0);
  await runTimeCommand(root, ['log', '1'], { now: () => NOW });
  for (const bad of ['0', '-1', '25', 'abc', '1.234', '1e2']) assert.equal((await runTimeCommand(root, ['log', bad])).exitCode, 2, bad);
  await fs.appendFile(path.join(root, '.swarm/project/time.ndjson'), 'not json\n{"hours":99,"at":"x"}\n');
  const t2 = await readTime(root);
  assert.equal(t2.total, 3.5);
  assert.equal(t2.skipped, 2);
  const list = await runTimeCommand(root, ['list']);
  assert.match(list.stdout, /2\.5 h  wiring the cart/);
  assert.match(list.stdout, /total 3\.5 hours \(2 unreadable/);
});

test('distance and ranges: log-size distance on shared traits only; middle half with 3+, lowest to highest with 2, one point with 1, nothing with 0', () => {
  assert.equal(distance({ requirements: 10, stages: 3 }, { requirements: 10, stages: 3 }), 0);
  assert.ok(distance({ requirements: 10 }, { requirements: 20 }) > distance({ requirements: 10 }, { requirements: 12 }));
  assert.equal(distance({ requirements: 10 }, { screens: 5 }), null, 'nothing in common is not comparable');
  assert.equal(distance({ requirements: null }, { requirements: 5 }), null);
  assert.deepEqual(rangeOf([]), null);
  assert.deepEqual(rangeOf([null, undefined]), null);
  assert.deepEqual(rangeOf([5]), { low: 5, high: 5, n: 1, single: true });
  assert.deepEqual(rangeOf([9, 3]), { low: 3, high: 9, n: 2, single: false });
  assert.deepEqual(rangeOf([1, 2, 3, 4, 100]), { low: 2, high: 4, n: 5, single: false }, 'an outlier does not stretch the middle half');
});

test('the quote: no history = no number; few similar = low confidence with the reason; backfilled projects are named', () => {
  const traits = { requirements: 10, stages: 3, screens: 8, services: 2 };
  const none = renderQuote(buildQuote({ traits, records: [], config: { hourlyRate: 100, margin: 0.3 } }));
  assert.match(none, /Confidence: none/);
  assert.doesNotMatch(none, /\$\d/);
  assert.match(none, /Price: blank/);
  const one = buildQuote({ traits, records: [rec('a', { source: 'backfill' })], config: { hourlyRate: null, margin: null } });
  assert.equal(one.confidence, 'low');
  assert.match(one.why, /only 1 similar/);
  assert.match(one.why, /backfilled/);
  assert.match(renderQuote(one), /one project, no range/);
  const nothingShared = buildQuote({ traits: { requirements: 10 }, records: [rec('b', { requirements: null })], config: {} });
  assert.equal(nothingShared.confidence, 'none');
  const many = buildQuote({ traits, records: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => rec(n, { billedUsd: 10 + i, requirements: 10 + (i % 2) })), config: {} });
  assert.equal(many.confidence, 'high');
  assert.equal(many.similar.length, 5, 'the five nearest only');
});

test('the price stays blank until BOTH rate and margin are set, then is (cost + hours x rate) / (1 - margin) as a range', async t => {
  const traits = { requirements: 10, stages: 3, screens: 8, services: 2 };
  const records = [rec('a', { billedUsd: 10, ownerHours: 20 }), rec('b', { billedUsd: 20, ownerHours: 30 }), rec('c', { billedUsd: 30, ownerHours: 40 })];
  for (const config of [{ hourlyRate: null, margin: null }, { hourlyRate: 100, margin: null }, { hourlyRate: null, margin: 0.3 }]) {
    const q = buildQuote({ traits, records, config });
    assert.equal(q.price, null);
    assert.match(renderQuote(q), /Price:\s+blank until you set both/);
    assert.ok(q.cost && q.hours, 'the cost and hours ranges show anyway');
  }
  const q = buildQuote({ traits, records, config: { hourlyRate: 100, margin: 0.5 } });
  assert.deepEqual(q.price, { low: Math.round((15 + 25 * 100) / 0.5), high: Math.round((25 + 35 * 100) / 0.5) });
  const dir = await tmp(t);
  assert.equal((await runQuoteCommand(dir, ['config', '--rate', '0'], { env: env(dir) })).exitCode, 2);
  assert.equal((await runQuoteCommand(dir, ['config', '--margin', '95'], { env: env(dir) })).exitCode, 2);
  assert.match((await runQuoteCommand(dir, ['config'], { env: env(dir) })).stdout, /rate: not set[\s\S]*blank until both/);
  await runQuoteCommand(dir, ['config', '--rate', '120'], { env: env(dir) });
  await runQuoteCommand(dir, ['config', '--margin', '40%'], { env: env(dir) });
  assert.deepEqual(await readQuoteConfig(dir), { hourlyRate: 120, margin: 0.4 });
});

test('quote SCOPE.md reads the sizes from the scope and prints ranges; an empty scope or a missing file is refused', async t => {
  const root = await tmp(t);
  const dir = path.join(root, 'q');
  for (const [i, n] of [8, 10, 12].entries()) await saveRecord(dir, rec(`p${i}`, { requirements: n, stages: 2, screens: 2, services: 1, billedUsd: 10 * (i + 1), ownerHours: 10 * (i + 1) }));
  await fs.writeFile(path.join(root, 'scope.md'), scopeOf(10));
  const res = await runQuoteCommand(root, ['scope.md'], { env: env(dir) });
  assert.equal(res.exitCode, 0, res.stdout);
  assert.match(res.stdout, /requirements 10, stages 2, screens 2, services 1/);
  assert.match(res.stdout, /Model cost \(billed\):\s+\$15 to \$25/);
  assert.match(res.stdout, /Your hours:\s+15 to 25 hours/);
  assert.match(res.stdout, /Price:\s+blank/);
  assert.match(res.stdout, /Confidence: medium/);
  assert.equal((await runQuoteCommand(root, ['nope.md'], { env: env(dir) })).exitCode, 2);
  await fs.writeFile(path.join(root, 'empty.md'), '# Scope: Y\n');
  assert.equal((await runQuoteCommand(root, ['empty.md'], { env: env(dir) })).exitCode, 1);
});

test('record keeps a project\'s numbers (scope sizes, tickets, billed vs flat-rate cost, owner hours, calendar days), updates by name, and backfill is marked', async t => {
  const root = await tmp(t);
  const dir = path.join(root, 'q');
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), scopeOf(3));
  const mk = (id, status) => ({ id, title: 't', type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status, stage: 'S1' });
  await writeLedger(root, { ...createLedger({ scope: { name: 'X', version: 1, hash: 'a'.repeat(64) }, tickets: [mk('T-0001', 'done'), mk('T-0002', 'proposed'), mk('T-0003', 'cancelled')] }) });
  const run = (id, start, end, jobs, rental) => fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true }).then(() => fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, startedAt: start, finishedAt: end, jobs, ...(rental ? { rental } : {}) })));
  await run('r1', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', [{ id: 'a', agent: 'anthropic', status: 'complete', costUsd: 2, usage: { total_tokens: 10 }, finishedAt: '2026-10-02T00:00:00Z' }, { id: 'b', agent: 'codex', status: 'complete', costUsd: 5, usage: { total_tokens: 10 }, finishedAt: '2026-10-02T00:00:00Z' }]);
  await run('r2', '2026-10-09T00:00:00Z', '2026-10-11T00:00:00Z', [], { usd: 3, hours: 1.5 });
  await fs.mkdir(path.join(root, '.swarm/runs/broken'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/broken/state.json'), '{');
  await runTimeCommand(root, ['log', '4']);
  const first = await runQuoteCommand(root, ['record', '--name', 'Dealer Portal', '--charged', '9000', '--change-orders', '2', '--backfill'], { env: env(dir), now: () => NOW });
  assert.equal(first.exitCode, 0, first.stdout);
  const [r] = await readRecords(dir);
  assert.deepEqual([r.name, r.source, r.requirements, r.stages, r.screens, r.services, r.tickets], ['Dealer Portal', 'backfill', 3, 2, 2, 1, 1]);
  assert.equal(r.billedUsd, 5, 'per-use anthropic 2 + rented gpu 3; the flat-rate codex 5 is not billed');
  assert.equal(r.flatRateListUsd, 5);
  assert.deepEqual([r.ownerHours, r.calendarDays, r.chargedUsd, r.changeOrders, r.gpuHours], [4, 10, 9000, 2, 1.5]);
  const again = await runQuoteCommand(root, ['record', '--name', 'Dealer Portal'], { env: env(dir), now: () => NOW });
  assert.match(again.stdout, /^updated/);
  assert.equal((await readRecords(dir)).length, 1);
  assert.equal((await runQuoteCommand(root, ['record', '--charged', '-5'], { env: env(dir) })).exitCode, 2);
  assert.equal((await runQuoteCommand(root, ['record', '--change-orders', '1.5'], { env: env(dir) })).exitCode, 2);
  assert.match((await runQuoteCommand(root, ['list'], { env: env(dir) })).stdout, /Dealer Portal.*billed \$5.*owner hours 4/);
});

test('a project with no scope, ledger or hours still records (missing numbers are ?, never 0) and is not used to match on traits it lacks', async t => {
  const root = await tmp(t);
  const dir = path.join(root, 'q');
  const res = await runQuoteCommand(root, ['record', '--name', 'bare'], { env: env(dir), now: () => NOW });
  assert.equal(res.exitCode, 0, res.stdout);
  const [r] = await readRecords(dir);
  assert.deepEqual([r.requirements, r.tickets, r.ownerHours, r.calendarDays], [null, null, null, null]);
  assert.equal(buildQuote({ traits: { requirements: 5 }, records: [r], config: {} }).confidence, 'none');
});

test('the quote files are private, the quote code makes no network call, and nothing is added to a client report', async () => {
  const src = await fs.readFile(new URL('../tools/quotes.mjs', import.meta.url), 'utf8') + await fs.readFile(new URL('../tools/quote-commands.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /fetch\(|node:https?|node:net|child_process|resend/i);
  const report = await fs.readFile(new URL('../tools/client-report.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(report, /quotes|ownerHours|hourlyRate/);
});

test('review fixes: a damaged record file is never overwritten; names that slug alike stay separate; no runs = billed unknown; 0.3 margin is refused; thin cost/hours data lowers confidence; far-off projects are not similar', async t => {
  const root = await tmp(t);
  const dir = path.join(root, 'q');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'projects.json'), '{ half a file');
  const refused = await runQuoteCommand(root, ['record', '--name', 'a'], { env: env(dir), now: () => NOW });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /not valid JSON; nothing was changed/);
  assert.equal(await fs.readFile(path.join(dir, 'projects.json'), 'utf8'), '{ half a file');
  assert.equal((await runQuoteCommand(root, ['list'], { env: env(dir) })).exitCode, 1);
  await fs.writeFile(path.join(root, 'scope.md'), scopeOf(3));
  assert.equal((await runQuoteCommand(root, ['scope.md'], { env: env(dir) })).exitCode, 1, 'no quote from damaged history');
  await fs.rm(path.join(dir, 'projects.json'));
  await runQuoteCommand(root, ['record', '--name', 'Shop!'], { env: env(dir), now: () => NOW });
  await runQuoteCommand(root, ['record', '--name', 'shop'], { env: env(dir), now: () => NOW });
  const list = await readRecords(dir);
  assert.equal(list.length, 2);
  assert.ok(list.every(r => r.billedUsd === null && r.flatRateListUsd === null), 'no runs here: unknown, not $0');
  for (const bad of ['0.3', '95', '-1']) assert.equal((await runQuoteCommand(root, ['config', '--margin', bad], { env: env(dir) })).exitCode, 2, bad);
  assert.equal((await runQuoteCommand(root, ['config', '--margin', '0.3%'], { env: env(dir) })).exitCode, 0);
  assert.equal((await readQuoteConfig(dir)).margin, 0.003);
  assert.equal((await runQuoteCommand(root, ['config', '--margin', '30'], { env: env(dir) })).exitCode, 0);
  assert.equal((await readQuoteConfig(dir)).margin, 0.3);
  const traits = { requirements: 10, stages: 3, screens: 8, services: 2 };
  const thin = buildQuote({ traits, records: [rec('a'), rec('b', { ownerHours: null }), rec('c', { ownerHours: null }), rec('d', { ownerHours: null })], config: { hourlyRate: 100, margin: 0.3 } });
  assert.equal(thin.confidence, 'low');
  assert.match(thin.why, /only 1 have owner hours/);
  const far = buildQuote({ traits, records: [rec('huge', { requirements: 200, stages: 20, screens: 150, services: 12 })], config: {} });
  assert.equal(far.confidence, 'none');
});
