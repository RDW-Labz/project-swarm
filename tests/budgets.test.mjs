// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostAllowed, acceptBudgetFailures, validateBudgetsConfig, parseLighthouse, parseAxe, evaluateBudgets, runBudgets, recordBudgetResults, readBudgetState, openFailures, finishesLastStage, budgetShipGate, checkBaseUrl } from '../tools/budgets.mjs';
import { runBudgetsCommand } from '../tools/budgets-commands.mjs';
import { validateProfile } from '../tools/init-profile.mjs';
import { shipRun } from '../tools/swarm.mjs';
import { createLedger, writeLedger } from '../tools/tickets.mjs';

const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'budgets-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const lh = (perf, a11y) => ({ categories: { performance: { score: perf }, accessibility: { score: a11y }, 'best-practices': { score: 1 }, seo: { score: 0.9 } } });
const axeFile = violations => [{ violations }];
// A fake tool runner: writes the JSON a tool would, for the screen in the URL.
const fakeRun = table => async (cmd, args) => {
  const out = args.find(a => a.endsWith('.json') && a.includes('.swarm/budgets-tmp'))?.replace(/^--out=/, '');
  const url = args.find(a => a.startsWith('http'));
  const key = `${cmd === 'lh' ? 'lighthouse' : 'axe'} ${new URL(url).pathname}`;
  const body = table[key];
  if (body === 'crash') return { code: 1, stdout: '', stderr: 'chrome not found\n' };
  if (body === 'hang') return { code: null, timedOut: true, stdout: '', stderr: '' };
  await fs.writeFile(out, JSON.stringify(body));
  return { code: 0, stdout: '', stderr: '' };
};
const cfg = (extra = {}) => validateBudgetsConfig({ performance: 85, accessibility: 95, screens: [{ id: 'home', path: '/' }, { id: 'cart', path: '/cart' }], lighthouse: { argv: ['lh', '{url}', '--out={out}'] }, axe: { argv: ['ax', '{url}', '--save', '{out}'] }, ...extra });

test('config: defaults, bounds, argv rules (needs {url} and {out}, no shell, no production), screens', () => {
  const d = validateBudgetsConfig({});
  assert.equal(d.ok, true);
  assert.deepEqual([d.config.performance, d.config.accessibility], [85, 95]);
  assert.deepEqual(d.config.axeBlock, ['serious', 'critical']);
  assert.equal(d.config.lighthouse.argv[0], 'npx');
  assert.match(validateBudgetsConfig({ performance: 101 }).errors[0], /0 to 100/);
  assert.match(validateBudgetsConfig({ lighthouse: { argv: ['sh', '-c', 'x {url} {out}'] } }).errors.join(), /shell or a production/);
  assert.match(validateBudgetsConfig({ lighthouse: { argv: ['lh', '{url}'] } }).errors.join(), /\{out\}/);
  assert.match(validateBudgetsConfig({ axe: { argv: ['ax', '--save', '{out}'] } }).errors.join(), /\{url\}/);
  assert.match(validateBudgetsConfig({ screens: [{ id: 'a', path: '../x' }] }).errors.join(), /screens entries/);
  assert.match(validateBudgetsConfig({ screens: [{ id: 'a', path: '/' }, { id: 'a', path: '/b' }] }).errors.join(), /unique/);
  assert.match(validateBudgetsConfig({ axeBlock: ['huge'] }).errors.join(), /axeBlock/);
  assert.match(validateBudgetsConfig({ speed: 1 }).errors.join(), /unknown key/);
});

test('scores and violations are read from the tools\' own JSON and compared to the budgets', () => {
  assert.deepEqual(parseLighthouse(lh(0.84, 0.97)), { performance: 84, accessibility: 97, bestPractices: 100, seo: 90 });
  assert.equal(parseLighthouse({}).performance, null);
  const axe = parseAxe(axeFile([{ id: 'color-contrast', impact: 'serious', nodes: [{}, {}] }, { id: 'region', impact: 'moderate', nodes: [{}] }]));
  assert.deepEqual(axe.map(v => [v.id, v.impact, v.nodes]), [['color-contrast', 'serious', 2], ['region', 'moderate', 1]]);
  const { config } = cfg();
  const verdict = evaluateBudgets({ lighthouse: parseLighthouse(lh(0.84, 0.97)), axe }, config);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.failures.map(f => f.metric), ['performance', 'color-contrast']);
  assert.equal(evaluateBudgets({ lighthouse: parseLighthouse(lh(0.9, 0.96)), axe: [] }, config).pass, true);
  assert.equal(evaluateBudgets({ lighthouse: {}, axe: [] }, config).pass, false, 'a missing score is not a pass');
});

test('runBudgets: per screen results; a tool that crashes or hangs is cannot-run, never a pass; only https or local addresses', async t => {
  const root = await tmp(t);
  const { config } = cfg();
  const run = fakeRun({ 'lighthouse /': lh(0.95, 0.99), 'axe /': axeFile([]), 'lighthouse /cart': lh(0.5, 0.99), 'axe /cart': 'crash' });
  const results = await runBudgets({ root, baseUrl: 'https://app-git-x.vercel.app', config, run });
  assert.deepEqual(results.map(r => [r.id, r.status]), [['home', 'passed'], ['cart', 'cannot-run']]);
  assert.match(results[1].failures[0].message, /axe could not run: chrome not found/);
  const hang = await runBudgets({ root, baseUrl: 'http://127.0.0.1:3000', config, run: fakeRun({ 'lighthouse /': 'hang', 'axe /': axeFile([]), 'lighthouse /cart': 'hang', 'axe /cart': axeFile([]) }) });
  assert.match(hang[0].failures[0].message, /timed out/);
  await assert.rejects(runBudgets({ root, baseUrl: 'http://example.com', config, run }), { code: 'budgets-url' });
  assert.equal(checkBaseUrl('https://user:pw@x.dev'), null);
  assert.equal(checkBaseUrl('https://x.dev/path/?q=1'), 'https://x.dev/path', 'a sub-path preview keeps its path');
  assert.equal(checkBaseUrl('https://x.dev/'), 'https://x.dev');
  assert.deepEqual(await fs.readdir(path.join(root, '.swarm/budgets-tmp')), [], 'temporary reports are removed');
});

test('state: the latest result per screen; a pass clears it; open failures are listed', async t => {
  const root = await tmp(t);
  await recordBudgetResults(root, [{ id: 'home', url: 'u', at: 'a', status: 'failed', failures: [{ message: 'm' }] }, { id: 'cart', url: 'u', at: 'a', status: 'passed', failures: [] }]);
  assert.deepEqual(openFailures(await readBudgetState(root)).map(o => o.id), ['home']);
  await recordBudgetResults(root, [{ id: 'home', url: 'u', at: 'b', status: 'passed', failures: [] }]);
  assert.deepEqual(openFailures(await readBudgetState(root)), []);
});

test('the gate blocks only the PR that finishes the last stage, and only while a screen fails', () => {
  const t = (id, stage, status) => ({ id, stage, status });
  const midway = { tickets: [t('1', 'S1', 'done'), t('2', 'S2', 'running')] };
  const finishing = { tickets: [t('1', 'S1', 'done'), t('2', 'S2', 'review'), t('3', 'S0', 'running'), t('4', 'S2', 'proposed')] };
  const failing = { screens: { home: { status: 'failed', failures: [{ message: 'performance 60 is below the budget 85' }], ticket: 'T-0009' } } };
  const budgets = { screens: [{ id: 'home', path: '/' }] };
  assert.equal(finishesLastStage(midway), false);
  assert.equal(finishesLastStage(finishing), true, 'fix tickets (S0) and proposals are not part of a stage');
  assert.equal(budgetShipGate({ budgets, state: failing, ledger: midway }), null, 'an earlier PR is never blocked');
  assert.match(budgetShipGate({ budgets, state: failing, ledger: finishing, runJobIds: ['2'] }).message, /budgets-failing: this PR finishes the last stage.*performance 60.*T-0009/);
  assert.equal(budgetShipGate({ budgets, state: { screens: { home: { status: 'passed' } } }, ledger: finishing }), null);
  // Only the PR that holds a last-stage ticket is THE PR that finishes it: a later hotfix or the fix-ticket PR passes.
  assert.equal(budgetShipGate({ budgets, state: failing, ledger: finishing, runJobIds: ['3'] }), null);
  // A screen the profile no longer lists cannot block; a screen never measured can; an accepted failure does not.
  const renamed = { screens: { 'old-name': { status: 'failed', failures: [{ message: 'x' }] }, home: { status: 'passed' } } };
  assert.equal(budgetShipGate({ budgets, state: renamed, ledger: finishing }), null);
  assert.match(budgetShipGate({ budgets, state: { screens: {} }, ledger: finishing }).message, /never measured: home/);
  assert.equal(budgetShipGate({ budgets, state: { screens: { home: { status: 'failed', failures: [], accepted: { at: 'a', reason: 'owner knows' } } } }, ledger: finishing }), null);
  assert.equal(budgetShipGate({ budgets: undefined, state: failing, ledger: finishing }), null, 'no budgets in the profile: no gate');
  assert.equal(budgetShipGate({ budgets, state: failing, ledger: null }), null);
});

test('swarm budgets check and status: profile required, results recorded, exit 1 when outside budget', async t => {
  const root = await tmp(t);
  assert.match((await runBudgetsCommand(root, ['check', '--url', 'https://x.dev'])).stdout, /no project profile/);
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none' }, budgets: { screens: [{ id: 'home', path: '/' }], lighthouse: { argv: ['lh', '{url}', '--out={out}'] }, axe: { argv: ['ax', '{url}', '--save', '{out}'] } } } }));
  assert.equal((await runBudgetsCommand(root, ['check'])).exitCode, 2);
  assert.equal((await runBudgetsCommand(root, ['check', '--url', 'http://example.com'])).exitCode, 2);
  assert.match((await runBudgetsCommand(root, ['check', '--url', 'https://x.dev', '--screens', 'nope'])).stdout, /unknown screen/);
  const bad = await runBudgetsCommand(root, ['check', '--url', 'https://x.dev'], { run: fakeRun({ 'lighthouse /': lh(0.7, 0.99), 'axe /': axeFile([]) }) });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /performance 70 is below the budget 85/);
  assert.equal((await runBudgetsCommand(root, ['status'])).exitCode, 1);
  const good = await runBudgetsCommand(root, ['check', '--url', 'https://x.dev'], { run: fakeRun({ 'lighthouse /': lh(0.99, 0.99), 'axe /': axeFile([]) }) });
  assert.equal(good.exitCode, 0);
  assert.match((await runBudgetsCommand(root, ['status'])).stdout, /all screens within budget/);
});

test('the profile validates the budgets block and protects a script the tools run', () => {
  const base = { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none' } };
  const ok = validateProfile({ ...base, budgets: { performance: 90, lighthouse: { argv: ['node', 'scripts/lh.mjs', '{url}', '{out}'] } } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.profile.budgets.performance, 90);
  assert.ok(ok.profile.protectedPaths.includes('scripts/lh.mjs'), 'a worker cannot edit the script that measures it');
  assert.match(validateProfile({ ...base, budgets: { performance: 'high' } }).errors.join(), /profile\.budgets\.performance/);
});

test('shipRun refuses the last-stage PR while a screen fails its budget, and does not touch an earlier PR', async t => {
  const root = await tmp(t);
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none' }, budgets: {} } }));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', root, status: 'complete', integratedAt: 'now', jobs: [{ id: 'T-0002' }] }));
  const tk = (id, stage, status) => ({ id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${id}.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status, stage });
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [tk('T-0001', 'S1', 'done'), tk('T-0002', 'S2', 'review')] }));
  await recordBudgetResults(root, [{ id: 'home', url: 'u', at: 'a', status: 'failed', failures: [{ message: 'accessibility 80 is below the budget 95' }] }]);
  const exec = async () => ({ code: 0, stdout: '', stderr: '' });
  await assert.rejects(shipRun(root, 'r1', { payloadPath: 'x.json' }, { exec }), { code: 'budgets-failing' });
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [tk('T-0001', 'S1', 'done'), tk('T-0002', 'S2', 'running')] }));
  await assert.rejects(shipRun(root, 'r1', { payloadPath: 'x.json' }, { exec }), error => error.code !== 'budgets-failing');
});

test('review fixes: previewHosts, empty or error reports are never a pass, accept with a reason, newer results win', async t => {
  assert.equal(validateBudgetsConfig({ previewHosts: ['*.vercel.app', 'app.example.com'] }).ok, true);
  assert.match(validateBudgetsConfig({ previewHosts: ['https://x'] }).errors.join(), /previewHosts/);
  assert.equal(hostAllowed('https://app-git-x.vercel.app/p', ['*.vercel.app']), true);
  assert.equal(hostAllowed('https://vercel.app', ['*.vercel.app']), false);
  assert.equal(hostAllowed('https://evilvercel.app', ['*.vercel.app']), false);
  assert.equal(hostAllowed('https://fast.example', ['*.vercel.app']), false);
  const root = await tmp(t);
  const { config } = cfg({ screens: [{ id: 'home', path: '/' }] });
  const base = { 'lighthouse /': lh(0.99, 0.99) };
  for (const [label, table, re] of [
    ['empty axe', { ...base, 'axe /': [] }, /axe wrote no results/],
    ['axe object without violations', { ...base, 'axe /': {} }, /axe wrote no results/],
    ['lighthouse runtime error', { 'lighthouse /': { runtimeError: { code: 'NO_FCP', message: 'no paint' } }, 'axe /': axeFile([]) }, /Lighthouse reported an error: no paint/],
    ['error status page', { 'lighthouse /': { ...lh(0.99, 0.99), audits: { 'http-status-code': { score: 0 } } }, 'axe /': axeFile([]) }, /error status/],
    ['redirect off host', { 'lighthouse /': { ...lh(0.99, 0.99), finalDisplayedUrl: 'https://login.other.example/' }, 'axe /': axeFile([]) }, /redirected to another host/],
  ]) {
    const [r] = await runBudgets({ root, baseUrl: 'https://x.dev', config, run: fakeRun(table) });
    assert.equal(r.status, 'cannot-run', label);
    assert.match(r.failures[0].message, re, label);
  }
  const [ok] = await runBudgets({ root, baseUrl: 'https://x.dev', config, run: fakeRun({ ...base, 'axe /': axeFile([]) }) });
  assert.equal(ok.status, 'passed');
  // accept: only failing screens, until the next measurement
  await recordBudgetResults(root, [{ id: 'home', url: 'u', at: '2026-01-02T00:00:00.000Z', status: 'failed', failures: [{ message: 'm' }] }]);
  assert.deepEqual(await acceptBudgetFailures(root, ['home', 'nope'], { reason: 'known and tracked' }), ['home']);
  assert.deepEqual(openFailures(await readBudgetState(root)), []);
  await recordBudgetResults(root, [{ id: 'home', url: 'u', at: '2026-01-03T00:00:00.000Z', status: 'failed', failures: [{ message: 'again' }] }]);
  assert.equal(openFailures(await readBudgetState(root)).length, 1, 'a new measurement clears the acceptance');
  // an older result never replaces a newer one, in any order of arrival
  await Promise.all([recordBudgetResults(root, [{ id: 'home', url: 'u', at: '2026-01-05T00:00:00.000Z', status: 'passed', failures: [] }]), recordBudgetResults(root, [{ id: 'home', url: 'u', at: '2026-01-04T00:00:00.000Z', status: 'failed', failures: [{ message: 'old' }] }])]);
  assert.equal((await readBudgetState(root)).screens.home.status, 'passed');
  const cmd = await runBudgetsCommand(root, ['accept', 'home', '--reason', 'short']);
  assert.equal(cmd.exitCode, 2);
  assert.equal((await runBudgetsCommand(root, ['accept', 'home', '--reason', 'long enough reason'])).exitCode, 1, 'needs --yes');
});
