// SPDX-License-Identifier: Apache-2.0
// Scenario evals for the parts-app S6 lessons (lesson 39): move file ownership from a done ticket, ticket deletes through the gate,
// edit acceptance text, and e2e specs that the project's e2e command really runs.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger, writeLedger, createLedger, approveLedger, isApproved, validateTicket } from '../tools/tickets.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { parseScope } from '../tools/scope.mjs';
import { checkTicketTree } from '../tools/scope-integrity.mjs';
import { runSecurityGate } from '../tools/security-gate.mjs';
import { validateManifest } from '../tools/swarm.mjs';
import { e2eSpecWarnings } from '../tools/tool-config.mjs';

const tmp = async (t, prefix) => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const tk = (id, extra = {}) => ({ id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${id}.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo', stage: 'S1', ...extra });
async function approvedProject(t, tickets) {
  const root = await tmp(t, 'l39-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', scripts: {} }));
  const ledger = createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets });
  await writeLedger(root, { ...ledger, approved: approveLedger(ledger).approved });
  return root;
}
const run = (root, args) => runScopeCommand(root, 'tickets', args);

test('eval 39.1: --take-from moves file ownership from a done ticket, logged, approval kept', async t => {
  const root = await approvedProject(t, [tk('T-0090', { status: 'done', files: ['src/useShops.ts', 'src/shops.ts'] }), tk('T-0091'), tk('T-0092', { status: 'running' })]);
  // Old behavior: "src/useShops.ts is already written by T-0090" and no supported way to move it.
  const refused = await run(root, ['T-0091', '--files', 'src/T-0091.ts,src/useShops.ts', '--yes']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /src\/useShops\.ts is already written by T-0090; to move it use --take-from T-0090/);
  const preview = await run(root, ['T-0091', '--files', 'src/T-0091.ts,src/useShops.ts', '--take-from', 'T-0090']);
  assert.match(preview.stdout, /moves from T-0090: src\/useShops\.ts \(T-0090 no longer writes it; T-0090 is done and its tests are not re-run for it\)[\s\S]*Rerun with --yes/);
  assert.deepEqual((await readLedger(root)).tickets[1].files, ['src/T-0091.ts'], 'a preview changes nothing');
  const applied = await run(root, ['T-0091', '--files', 'src/T-0091.ts,src/useShops.ts', '--take-from', 'T-0090', '--yes']);
  assert.equal(applied.exitCode, 0, applied.stdout);
  const ledger = await readLedger(root);
  assert.deepEqual(ledger.tickets[0].files, ['src/shops.ts']);
  assert.equal(ledger.tickets[0].status, 'done', 'the done ticket stays done');
  assert.deepEqual(ledger.tickets[1].files, ['src/T-0091.ts', 'src/useShops.ts']);
  assert.equal(isApproved(ledger), true);
  assert.match(await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8'), /"event":"file-move","by":"owner","from":"T-0090","to":"T-0091","files":\["src\/useShops\.ts"\],"fromStatus":"done","reapproved":true/);
  // Only files the named ticket owns move; another owner, a running source, a missing --files: refused.
  assert.match((await run(root, ['T-0091', '--files', 'src/T-0091.ts,src/T-0092.ts', '--take-from', 'T-0090', '--yes'])).stdout, /src\/T-0092\.ts is already written by T-0092 \(not T-0090 alone\)/);
  assert.match((await run(root, ['T-0091', '--files', 'src/T-0091.ts,src/T-0092.ts', '--take-from', 'T-0092', '--yes'])).stdout, /T-0092 is running; its files cannot move/);
  assert.match((await run(root, ['T-0091', '--take-from', 'T-0090', '--yes'])).stdout, /--take-from needs --files/);
  // A source in review, or a file the source deletes, or a file with a second owner, cannot move.
  const l2 = await readLedger(root);
  l2.tickets.push(tk('T-0093', { status: 'review', files: ['src/rev.ts'] }), tk('T-0094', { status: 'done', files: ['src/a94.ts'], deletes: ['src/gone.ts'] }), tk('T-0095', { status: 'todo', files: ['src/two.ts'] }), tk('T-0096', { status: 'done', files: ['src/two.ts'] }));
  await writeLedger(root, { ...l2, approved: approveLedger(l2).approved });
  assert.match((await run(root, ['T-0091', '--files', 'src/T-0091.ts,src/rev.ts', '--take-from', 'T-0093', '--yes'])).stdout, /T-0093 is review; its files cannot move/);
  assert.match((await run(root, ['T-0091', '--files', 'src/T-0091.ts,src/gone.ts', '--take-from', 'T-0094', '--yes'])).stdout, /src\/gone\.ts is already deleted by T-0094/);
  assert.match((await run(root, ['T-0091', '--files', 'src/T-0091.ts,src/two.ts', '--take-from', 'T-0096', '--yes'])).stdout, /src\/two\.ts is already written by T-0095, T-0096 \(not T-0096 alone\)/);
});

test('eval 39.3: swarm tickets --acceptance edits acceptance text (review and done tickets may only add lines); file lists still need todo, ready or blocked', async t => {
  const root = await approvedProject(t, [tk('T-0001', { acceptance: ['old check'] }), tk('T-0002', { status: 'review' }), tk('T-0003', { status: 'done' })]);
  const replaced = await run(root, ['T-0001', '--acceptance', 'POST /requests returns 201 ;; GET /requests returns 200', '--yes']);
  assert.equal(replaced.exitCode, 0, replaced.stdout);
  assert.deepEqual((await readLedger(root)).tickets[0].acceptance, ['POST /requests returns 201', 'GET /requests returns 200']);
  assert.equal(isApproved(await readLedger(root)), true);
  assert.equal((await run(root, ['T-0001', '--add-acceptance', 'empty list shows a message', '--yes'])).exitCode, 0);
  assert.equal((await readLedger(root)).tickets[0].acceptance.length, 3);
  // A review or done ticket can only add lines (a replace could weaken what the work is judged against); a shell check with || stays one line.
  assert.match((await run(root, ['T-0002', '--acceptance', 'new text', '--yes'])).stdout, /its acceptance can only be added to/);
  assert.match((await run(root, ['T-0003', '--acceptance', 'the real behavior', '--yes'])).stdout, /its acceptance can only be added to/);
  assert.equal((await run(root, ['T-0002', '--add-acceptance', 'curl -f localhost:3000/health || exit 1', '--yes'])).exitCode, 0);
  assert.equal((await run(root, ['T-0003', '--add-acceptance', 'the real behavior', '--yes'])).exitCode, 0);
  assert.deepEqual((await readLedger(root)).tickets[1].acceptance, ['ok', 'curl -f localhost:3000/health || exit 1']);
  // A preview changes nothing; a build ticket needs acceptance; file lists on a review ticket are still refused.
  assert.match((await run(root, ['T-0001', '--acceptance', 'x'])).stdout, /acceptance: POST[\s\S]*->  x[\s\S]*Rerun with --yes/);
  assert.equal((await readLedger(root)).tickets[0].acceptance.length, 3);
  assert.match((await run(root, ['T-0001', '--acceptance', ' ', '--yes'])).stdout, /refused: acceptance is required/);
  assert.match((await run(root, ['T-0002', '--files', 'src/x.ts', '--yes'])).stdout, /only a todo, ready or blocked ticket can change its files/);
});

test('eval 39.2: a ticket can delete files; the worker is told, the gate checks the deletion, a conflict with a writer is named', async t => {
  // Ticket shape.
  assert.equal(validateTicket(tk('T-0001', { deletes: ['src/old.ts'] })).ok, true);
  assert.equal(validateTicket(tk('T-0001', { deletes: ['src/'] })).ok, false);
  assert.equal(validateTicket(tk('T-0001', { deletes: ['src/*.ts'] })).ok, false);
  assert.equal(validateTicket(tk('T-0001', { deletes: ['.env'] })).ok, false);
  assert.equal(validateTicket(tk('T-0001', { files: ['src/a.ts'], deletes: ['src/a.ts'] })).ok, false);
  // Old behavior: no way to declare it, so a worker's deletion was never applied. Now the job declares exactly those files, sees them, and runs where it can delete.
  const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo.', '', '## Stages', '- S1: Core', '', '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '## Protected', '- .env', ''].join('\n');
  const contextEnv = { exists: () => true, sizes: {}, listFiles: () => [], profileContext: {} };
  const { manifest } = ticketsToManifest([tk('T-0001', { status: 'ready', deletes: ['src/old.ts'] })], { ledger: { tickets: [] }, scope: parseScope(SCOPE), ready: true, contextEnv });
  const job = manifest.jobs[0];
  assert.deepEqual(job.deletes, ['src/old.ts']);
  assert.ok(job.context.includes('src/old.ts'));
  assert.equal(job.agent, 'claude');
  assert.equal(job.shell, true);
  validateManifest(JSON.parse(JSON.stringify(manifest)));
  // A ticket that deletes a file another ticket writes is a conflict in the same wave, and the error names both.
  const tree = checkTicketTree({ scope: parseScope(SCOPE), tickets: [tk('T-0001', { deletes: ['src/shared.ts'], files: ['src/a.ts'] }), tk('T-0002', { files: ['src/shared.ts'] })] });
  assert.match(tree.errors.find(e => e.code === 'conflict').message, /T-0001 ".*" and T-0002 ".*" both write src\/shared\.ts/);
  // The security gate looks at deletions: deleting package.json or a workflow needs the owner, an approval for the deletion lets it pass.
  const gate = (file, policy = {}) => runSecurityGate({ changes: [{ file, bytes: null, previous: Buffer.from('x') }], policy: { codeScan: 'off', requireVulnerabilityScan: false, ...policy }, cwd: os.tmpdir(), exec: async () => ({ code: 0, stdout: '', stderr: '' }), fetchImpl: async () => { throw new Error('offline'); } });
  for (const file of ['package.json', 'package-lock.json', '.github/workflows/ci.yml', 'requirements.txt', 'yarn.lock', 'Cargo.lock', '.gitignore', 'CODEOWNERS', '.npmrc', '.husky/pre-commit', '.project-swarm.json']) {
    const blocked = await gate(file);
    assert.ok(blocked.blocks.some(b => ['manifest-delete', 'unsupported-manifest'].includes(b.check) && b.message.includes(file)), file);
    assert.equal((await gate(file, { approvedManifests: [{ file, sha256: 'deleted' }] })).blocks.some(b => ['manifest-delete', 'unsupported-manifest'].includes(b.check)), false, `${file} approved`);
  }
  assert.equal((await gate('src/old.ts')).blocks.some(b => b.check === 'manifest-delete'), false, 'an ordinary file is deleted freely');
  // Fail closed: no `previous` recorded still counts as a deletion; a file known to be absent in the base is not one. allowUnparsedManifests does not waive a deletion.
  const noPrev = file => runSecurityGate({ changes: [{ file, bytes: null }], policy: { codeScan: 'off', requireVulnerabilityScan: false }, cwd: os.tmpdir(), exec: async () => ({ code: 0, stdout: '', stderr: '' }), fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await noPrev('package.json')).blocks.some(b => b.check === 'manifest-delete'), true);
  assert.equal((await gate('package.json', { allowUnparsedManifests: ['package.json'] })).blocks.some(b => b.check === 'manifest-delete'), true);
  // A ticket cannot declare the deletion of such a file at all.
  assert.equal(validateTicket(tk('T-0001', { deletes: ['package-lock.json'] })).ok, false);
  assert.equal(validateTicket(tk('T-0001', { deletes: ['.github/workflows/ci.yml'] })).ok, false);
  // A pnpm lock deletion is an unparsed manifest: approved with the same deleted marker.
  assert.equal((await gate('pnpm-workspace.yaml')).blocks.some(b => b.check === 'unsupported-manifest'), true);
  assert.equal((await gate('pnpm-workspace.yaml', { approvedManifests: [{ file: 'pnpm-workspace.yaml', sha256: 'deleted' }] })).blocks.some(b => b.check === 'unsupported-manifest'), false);
});

test('eval 39.4: a ticket\'s named e2e spec must be run by the project\'s e2e command (warning)', async t => {
  const spec = (file, id = 'T-0001') => ({ id, status: 'todo', type: 'test', tests: [file] });
  // No e2e command at all.
  assert.match(e2eSpecWarnings([spec('e2e/requests.spec.ts')], { scripts: { test: 'vitest run' } })[0], /T-0001 names the e2e spec e2e\/requests\.spec\.ts, but no package\.json near it has an e2e command/);
  // A command that only runs another folder (a path argument, or testDir in the config).
  assert.match(e2eSpecWarnings([spec('e2e/requests.spec.ts')], { scripts: { 'test:e2e': 'playwright test tests/e2e' } })[0], /only runs tests\/e2e: it would never run/);
  assert.match(e2eSpecWarnings([spec('e2e/requests.spec.ts')], { scripts: { e2e: 'playwright test' }, configText: "export default { testDir: './tests/e2e' }" })[0], /only runs tests\/e2e/);
  // Playwright only runs .spec/.test files unless testMatch is set.
  assert.match(e2eSpecWarnings([spec('e2e/requests.ts')], { scripts: { e2e: 'playwright test' } })[0], /only runs files ending in \.spec or \.test/);
  // Fine: command runs it, config limits to its folder, testMatch set, unit tests ignored, done tickets ignored.
  assert.deepEqual(e2eSpecWarnings([spec('e2e/requests.spec.ts')], { scripts: { e2e: 'playwright test' } }), []);
  assert.deepEqual(e2eSpecWarnings([spec('tests/e2e/requests.spec.ts')], { scripts: { e2e: 'playwright test' }, configText: "testDir: './tests/e2e'" }), []);
  assert.deepEqual(e2eSpecWarnings([spec('e2e/requests.ts')], { scripts: { e2e: 'playwright test' }, configText: "testMatch: '**/*.ts'" }), []);
  assert.deepEqual(e2eSpecWarnings([spec('tests/unit/a.test.ts')], { scripts: {} }), []);
  assert.deepEqual(e2eSpecWarnings([{ ...spec('e2e/a.spec.ts'), status: 'done' }], { scripts: {} }), []);
  // No false warnings from other tokens of the script, urls or env assignments; python specs are not judged; cypress needs .cy unless specPattern is set.
  assert.deepEqual(e2eSpecWarnings([spec('e2e/a.spec.ts')], { scripts: { e2e: 'BASE_URL=http://localhost:3000 node scripts/e2e-setup.mjs && node_modules/.bin/playwright test --reporter=html' } }), []);
  assert.deepEqual(e2eSpecWarnings([spec('tests/e2e/test_login.py')], { scripts: {} }), []);
  assert.match(e2eSpecWarnings([spec('cypress/e2e/login.spec.ts')], { scripts: { e2e: 'cypress run' } })[0], /cypress only runs files ending in \.cy/);
  assert.deepEqual(e2eSpecWarnings([spec('cypress/e2e/login.cy.ts')], { scripts: { e2e: 'cypress run' } }), []);
  // The nearest package.json decides in a monorepo.
  assert.deepEqual(e2eSpecWarnings([spec('apps/web/e2e/a.spec.ts')], { scripts: {}, scriptsFor: () => ({ scripts: { e2e: 'playwright test' }, configText: '' }) }), []);
  // Shown by scope check and approve.
  const root = await approvedProject(t, [tk('T-0001', { type: 'test', files: ['e2e/requests.spec.ts'], tests: ['e2e/requests.spec.ts'] })]);
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo.', '', '## Stages', '- S1: Core', '', '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '## Protected', '- .env', ''].join('\n'));
  assert.match((await runScopeCommand(root, 'scope', ['check'])).stdout, /warning: T-0001 names the e2e spec e2e\/requests\.spec\.ts, but no package\.json near it has an e2e command/);
});
