// SPDX-License-Identifier: Apache-2.0
// Scenario evals for lessons 28 to 32 (the parts app S4 report). Each one reproduces the failure the owner saw:
// it fails on the 1.90.0 runner and passes with the fix.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runScopeCommand, unlockLedger, buildSplitManifest, qualityFor } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { createLedger, writeLedger, readLedger } from '../tools/tickets.mjs';
import { runChecks } from '../tools/swarm.mjs';
import { runUiCheck } from '../tools/ui-check.mjs';
import { validateProfile } from '../tools/init-profile.mjs';
import { autopilotStep } from '../tools/autopilot.mjs';
import { lessonAreas } from '../tools/lessons.mjs';
import { detectTestCommand } from '../tools/zero-tests.mjs';
import { contextEnvFor } from '../tools/scope-commands.mjs';

const exec = promisify(execFile);
const base = { epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo', stage: 'S1' };
const ticket = over => ({ ...base, id: 'T-0001', title: 'A ticket', type: 'build', ...over });

async function project(t, { pkg = { name: 'app', scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc --noEmit' } } } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'l28-32-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', root]);
  if (pkg) await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(root, 'tsconfig.json'), '{}');
  return root;
}
async function withLedger(root, tickets, profile) {
  await writeLedger(root, createLedger({ scope: { name: 'Parts', version: 1, hash: 'a'.repeat(64) }, tickets }));
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, ...profile } }));
}
async function writeState(root, state) {
  await fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r9/state.json'), JSON.stringify(state));
}
const batch = (results, extra = {}) => ({ state: 'done', integrated: ['T-0001'], integratedIn: { 'T-0001': 1 }, checkFailed: [], batches: [{ id: 1, jobs: ['T-0001'], checks: 'passed', security: 'skipped', checkResults: results.map(name => ({ name, status: 'passed', mode: 'full' })) }], ...extra });

test('eval 28: a build ticket is done only after typecheck and lint passed; a failure goes back with the errors', async t => {
  const root = await project(t);
  await withLedger(root, [ticket({ status: 'review', files: ['src/a.ts'] })], {});
  assert.deepEqual((await qualityFor(root, null)).map(c => c.name), ['typecheck', 'lint']);
  // The manifest the runner builds carries both checks, so every merge batch with a build ticket runs them.
  const quality = await qualityFor(root, null);
  const { manifest } = ticketsToManifest([ticket({ files: ['src/a.ts'] })], { ledger: { tickets: [] }, ready: false, quality });
  assert.deepEqual(manifest.checks.map(c => c.name), ['typecheck', 'lint']);
  // The run's manifest is what says which checks the batches ran (a tsconfig or lint script added later by a ticket cannot demand more).
  await fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r9/manifest.json'), JSON.stringify(manifest));
  // Old behavior: a batch with no quality check marked the ticket done. Now it stays in review.
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/a.ts'] }], mergeQueue: batch(['tests']) });
  const missing = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(missing.stdout, /stay in review.*T-0001 \(no typecheck check ran/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
  // Both passed: done.
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/a.ts'] }], mergeQueue: batch(['typecheck', 'lint']) });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /1 ticket\(s\) marked done/);
  // A failing typecheck rolls the ticket back with its errors in the retry note (no tests were needed to catch it).
  await withLedger(root, [ticket({ status: 'review', files: ['src/a.ts'] })], {});
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/a.ts'] }], mergeQueue: batch([], { integrated: ['T-0001'], checkFailed: [{ job: 'T-0001', checks: ['typecheck'], tail: 'src/a.ts(3,5): error TS2304: Cannot find name foo' }] }) });
  const retry = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(retry.stdout, /back to ready, one level higher/);
  const after = (await readLedger(root)).tickets[0];
  assert.equal(after.status, 'ready');
  assert.match(after.retryNote, /TS2304/);
  const again = ticketsToManifest([after], { ledger: { tickets: [] }, ready: false, quality });
  assert.match(again.manifest.jobs[0].prompt, /Previous attempt failed.*TS2304/);
  // The profile can turn a check off or replace it; build is opt-in.
  assert.deepEqual((await qualityFor(root, { quality: { lint: false, build: true } })).map(c => c.name), ['typecheck']);
  assert.equal(validateProfile({ quality: { lint: 'yes' } }).errors.length, 1);
});

test('eval 29: truncation and repeated failure escalate instead of waiting for a person; split sizes tickets', async t => {
  const root = await project(t);
  await withLedger(root, [ticket({ status: 'running', files: ['src/big.ts'] })], {});
  const fail = error => writeState(root, { id: 'r9', jobs: [{ id: 'T-0001', status: 'failed', error }] });
  await fail('Anthropic response truncated: stop_reason max_tokens');
  const first = await runScopeCommand(root, 'scope', ['sync', 'r9']);
  assert.match(first.stdout, /sent back to ready one level higher/);
  let current = (await readLedger(root)).tickets[0];
  assert.equal(current.status, 'ready');
  assert.ok(current.escalation >= 2, 'a cut-off answer skips the cheap level');
  // The next manifest routes it to Codex (hard) with the biggest output.
  const job = ticketsToManifest([current], { ledger: { tickets: [] }, ready: false }).manifest.jobs[0];
  assert.equal(job.hard, true);
  assert.equal(job.maxOutputTokens, 32768);
  // Fails again and again: it climbs to Claude, and only after the last level does it block (never silently stuck in running).
  for (let i = 0; i < 4; i += 1) {
    const ledger = await readLedger(root);
    if (ledger.tickets[0].status === 'blocked') break;
    ledger.tickets[0].status = 'running';
    await writeLedger(root, ledger);
    await fail('worker failed');
    await runScopeCommand(root, 'scope', ['sync', 'r9']);
  }
  current = (await readLedger(root)).tickets[0];
  assert.equal(current.status, 'blocked');
  assert.equal(current.blockReason, 'failure');
  const last = ticketsToManifest([{ ...current, status: 'ready', escalation: 3 }], { ledger: { tickets: [] }, ready: false }).manifest.jobs[0];
  assert.equal(last.tier, 'expensive');
  // Split asks for tickets that fit one answer.
  const scope = parseScope(['# Scope: P', 'Version: 1', '', '## Overview', 'x', '', '## Stages', 'S1: Core', '', '## S1 Core', '### R-001 Thing', 'Do it.', '- works'].join('\n'));
  assert.match(buildSplitManifest(scope, {}).jobs[0].prompt, /at most 4 files/);
});

test('eval 30: a ticket blocked only by dependencies unlocks when they are done (go --scope and autopilot)', async t => {
  const root = await project(t);
  await withLedger(root, [ticket({ id: 'T-0001', status: 'running' }), ticket({ id: 'T-0002', status: 'running', dependsOn: ['T-0001'] }), ticket({ id: 'T-0003', status: 'blocked', blockReason: 'failure', attempts: 2, retryNote: 'x', dependsOn: ['T-0004'] }), ticket({ id: 'T-0004', status: 'done' })], {});
  // T-0001 fails, so the runner skips T-0002 (it waits on it): that ticket is blocked by dependencies, not stuck in running.
  await writeState(root, { id: 'r9', jobs: [{ id: 'T-0001', status: 'failed', error: 'boom' }, { id: 'T-0002', status: 'skipped', error: 'after T-0001 failed' }] });
  await runScopeCommand(root, 'scope', ['sync', 'r9']);
  let tickets = (await readLedger(root)).tickets;
  assert.equal(tickets.find(x => x.id === 'T-0002').status, 'blocked');
  assert.equal(tickets.find(x => x.id === 'T-0002').blockReason, 'deps');
  // Nothing unlocks while T-0001 is not done; the failure-blocked ticket never unlocks by itself.
  assert.deepEqual(await unlockLedger(root), []);
  const ledger = await readLedger(root);
  ledger.tickets.find(x => x.id === 'T-0001').status = 'done';
  await writeLedger(root, ledger);
  // autopilot does it on its next pass.
  const events = [];
  const out = await autopilotStep(root, { readJournal: async () => [], loadRuns: async () => [], appendEvent: async (_r, e) => { events.push(e); }, readPlan: async () => null, unlockTickets: unlockLedger, checkout: async () => ({}) });
  assert.ok(out.actions.some(a => a.action === 'unlock-tickets' && /T-0002/.test(a.result)), JSON.stringify(out));
  tickets = (await readLedger(root)).tickets;
  assert.equal(tickets.find(x => x.id === 'T-0002').status, 'ready');
  assert.equal(tickets.find(x => x.id === 'T-0003').status, 'blocked');
});

test('eval 31: ui check runs its own server on a free port, passes mockup state and waitFor, and counts as evidence', async t => {
  // A decoy "dev server" the owner left running at the configured base url (serving other code).
  const decoy = await new Promise(resolve => { const s = net.createServer(c => c.end('HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\ndecoy')); s.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => decoy.close());
  const root = await project(t);
  await fs.mkdir(path.join(root, 'docs/design/screens'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/design/screens/A.html'), '<html><body>a</body></html>');
  const start = ['node', '-e', "require('http').createServer((q,r)=>r.end('real')).listen(Number(process.argv[1]),'127.0.0.1')", '{port}'];
  const ui = { baseUrl: `http://127.0.0.1:${decoy.address().port}`, timeoutSec: 30, start, screens: [{ id: 'step-two', route: '/wizard?step=2', mockup: 'docs/design/screens/A.html', mockupQuery: 'step=2', waitFor: '#ready' }] };
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, ui } }));
  let seen;
  const m = { viewportWidth: 390, scrollWidth: 390, bodyFont: 'x', bodyMargin: '0px', fonts: [], colors: ['#fff'], backgrounds: ['#000'], words: ['a'], styled: true };
  const browser = async args => { seen = args.screens[0]; return [{ id: 'step-two', mockup: { metrics: m, screenshot: null }, page: { metrics: m, screenshot: null } }]; };
  await runUiCheck(root, { deps: { browser, tree: 'tree1', head: 'h' } }).catch(() => {});
  assert.ok(seen, 'the browser step ran');
  assert.notEqual(new URL(seen.pageUrl).port, String(decoy.address().port), 'the owner server is not used');
  assert.match(seen.pageUrl, /\/wizard\?step=2$/);
  assert.match(seen.mockupUrl, /A\.html\?step=2$/);
  assert.equal(seen.waitFor, '#ready');
  // Bad states are refused when the profile is read.
  assert.equal(validateProfile({ ui: { ...ui, screens: [{ ...ui.screens[0], mockupQuery: 'a#b' }] } }).errors.length, 1);
  assert.equal(validateProfile({ ui: { ...ui, screens: [{ ...ui.screens[0], waitFor: 'x;y' }] } }).errors.length, 1);
});

test('eval 32: a test check that ran 0 tests is a failure, and the real test command is detected', async t => {
  const root = await project(t);
  // The wrong runner for the files: the command exits 0 and reports no test at all (node:test summary).
  const check = { name: 'tests', argv: [process.execPath, '-e', "console.log('# tests 0\\n# pass 0\\n# fail 0')"] };
  const result = await runChecks(root, [check], [], [], spawn, {});
  assert.equal(result.checks[0].status, 'failed');
  assert.equal(result.checks[0].noTests, true);
  assert.equal(result.checksPassed, false);
  const good = await runChecks(root, [{ ...check, argv: [process.execPath, '-e', "console.log('# tests 3\\n# pass 3')"] }], [], [], spawn, {});
  assert.equal(good.checks[0].status, 'passed');
  // Other checks (lint) are not judged by a test count.
  const lint = await runChecks(root, [{ name: 'lint', argv: [process.execPath, '-e', "console.log('# tests 0')"] }], [], [], spawn, {});
  assert.equal(lint.checks[0].status, 'passed');
  // The project's real test command is detected (vitest here, not node --test) and offered for the profile's verify block.
  assert.deepEqual(detectTestCommand({ pkg: { scripts: { test: 'vitest run' }, devDependencies: { vitest: '1.0.0' } } }), { runner: 'vitest', command: ['npx', 'vitest', 'run', '{tests}'] });
});

test('small fixes: lesson areas are the real ones; example env names reach the ticket prompt without values', async t => {
  const root = await project(t, { pkg: null });
  assert.deepEqual(await lessonAreas(root), ['tool', 'gotchas']);
  await fs.mkdir(path.join(root, 'coordination/skills/process'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/skills/process/SKILL.md'), 'x');
  assert.deepEqual(await lessonAreas(root), ['tool', 'gotchas', 'process']);
  await fs.writeFile(path.join(root, '.env.example'), '# keys\nDATABASE_URL=postgres://u:secretpw@db/x\nexport STRIPE_KEY=sk_live_abc\nlowercase=1\n');
  const env = contextEnvFor(root, null);
  assert.match(env.envLine, /DATABASE_URL, STRIPE_KEY/);
  assert.doesNotMatch(env.envLine, /secretpw|sk_live|postgres/);
  const { manifest } = ticketsToManifest([ticket({ files: ['src/a.ts'] })], { ledger: { tickets: [] }, ready: false, contextEnv: { ...env, exists: () => false, sizes: {}, listFiles: () => [], profileContext: {} } });
  assert.match(manifest.jobs[0].prompt, /Environment variable names this project reads/);
});

test('review fixes: no paid retries for failures that are not the tickets, stale runs cannot move tickets, notes are redacted', async t => {
  const root = await project(t);
  const three = ['T-0001', 'T-0002', 'T-0003'];
  const mk = id => ticket({ id, status: 'review', files: [`src/${id}.ts`] });
  await withLedger(root, three.map(mk), {});
  const jobs = three.map(id => ({ id, status: 'complete', outputs: [`src/${id}.ts`] }));
  // A run built before the project had a lint script: the batches never ran lint, so the ticket cannot be asked for it (and the owner is warned).
  await fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r9/manifest.json'), JSON.stringify({ version: 1, jobs: [], checks: [] }));
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs, mergeQueue: { state: 'done', integrated: three, integratedIn: Object.fromEntries(three.map(id => [id, 1])), checkFailed: [], batches: [{ id: 1, jobs: three, checks: 'passed', checkResults: [] }] } });
  const early = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(early.stdout, /3 ticket\(s\) marked done/);
  assert.match(early.stdout, /profile now asks for typecheck, lint/);
  // The base already fails lint: every ticket of the run fails it. Nothing climbs the paid ladder.
  await withLedger(root, three.map(mk), {});
  const lint = id => ({ job: id, checks: ['lint'], tail: 'old error in a file nobody owns' });
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs, mergeQueue: { state: 'done', integrated: [], checkFailed: three.map(lint), batches: [] } });
  const systemic = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(systemic.stdout, /lint check failed for 3 tickets of this run/);
  assert.deepEqual((await readLedger(root)).tickets.map(x => [x.status, x.escalation ?? 0]), [['review', 0], ['review', 0], ['review', 0]]);
  // A test check that ran 0 tests is a configuration error, not a ticket failure.
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs, mergeQueue: { state: 'done', integrated: [], checkFailed: [{ job: 'T-0001', checks: ['tests'], tail: 'ok\nno-tests: the check passed but ran 0 tests' }], batches: [] } });
  const noTests = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(noTests.stdout, /T-0001 \(the tests check ran 0 tests: fix verify.command/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
  // One ticket failing alone is retried, and its stored note holds no credentials.
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs, mergeQueue: { state: 'done', integrated: [], checkFailed: [{ job: 'T-0001', checks: ['tests'], tail: 'connect postgres://app:hunter2pw@db.internal/x failed; API_TOKEN=abcd1234 ' + 'a'.repeat(40) }], batches: [] } });
  await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  const note = (await readLedger(root)).tickets[0].retryNote;
  assert.match(note, /connect postgres:\/\/\*\*\*@db\.internal/);
  assert.doesNotMatch(note, /hunter2pw|abcd1234|a{32}/);
  // An older run synced again cannot move a ticket that a newer wave is running.
  const ledger = await readLedger(root);
  ledger.tickets[1] = { ...ledger.tickets[1], status: 'running', waveAt: '2026-10-17T12:00:00.000Z' };
  await writeLedger(root, ledger);
  await writeState(root, { id: 'r9', startedAt: '2026-10-17T10:00:00.000Z', jobs: [{ id: 'T-0002', status: 'failed', error: 'boom' }] });
  await runScopeCommand(root, 'scope', ['sync', 'r9']);
  assert.equal((await readLedger(root)).tickets[1].status, 'running');
});

test('review fixes: zero-test counting handles go, vitest and nested tap; verify tickets get one retry', async () => {
  const { countTests } = await import('../tools/zero-tests.mjs');
  assert.equal(countTests('ok  mod/a 0.01s\n?   mod/b [no test files]').count, 1);
  assert.equal(countTests('?   mod/b [no test files]').count, 0);
  assert.equal(countTests('# Subtest\n    1..0\n# tests 4').count, 4);
  assert.equal(countTests('No test files found\n Tests  3 passed (3)').count, 3);
  assert.equal(countTests(' Tests  5 skipped (5)').count, 0);
  assert.equal(countTests('ℹ tests 0\nℹ pass 0').count, 0);
  const { nextStep } = await import('../tools/escalation.mjs');
  assert.equal(nextStep({}, { error: 'x', maxLevel: 1 }).status, 'ready');
  assert.equal(nextStep({ escalation: 1 }, { error: 'x', maxLevel: 1 }).status, 'blocked');
});
