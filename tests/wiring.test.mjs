// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { wiringGaps, addWiringDeps, unwiredRequirements, moduleTickets } from '../tools/wiring.mjs';
import { findReleasable, releaseReady } from '../tools/ticket-unlock.mjs';
import { pruneCancelledDeps, approveLedger, isApproved, requirementWired } from '../tools/tickets.mjs';
import { isBuildArtifact, withoutIgnored } from '../tools/ignored-artifacts.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const t = (id, over = {}) => ({ id, type: 'build', scopeRefs: ['R-001'], status: 'todo', dependsOn: [], ...over });

test('wiringGaps names a requirement with modules and no integration ticket, or one with no test', () => {
  assert.equal(wiringGaps([t('a'), t('b')]).length, 1);
  assert.match(wiringGaps([t('a'), t('m', { integration: true })])[0].reason, /no route-level test/);
  assert.deepEqual(wiringGaps([t('a'), t('m', { integration: true, tests: ['x.test.mjs'] })]), []);
  assert.deepEqual(wiringGaps([t('a', { type: 'docs' })]), []);
  assert.deepEqual(wiringGaps([t('a', { status: 'cancelled' })]), []);
});

test('addWiringDeps makes the integration ticket wait for the modules, without a cycle', () => {
  const mod = t('a');
  const loop = t('b', { dependsOn: ['m'] });
  const mount = t('m', { integration: true });
  addWiringDeps([mod, loop, mount], []);
  assert.deepEqual(mount.dependsOn, ['a']);
  assert.deepEqual(unwiredRequirements([mod, loop]), ['R-001']);
  assert.deepEqual(unwiredRequirements([mod, mount]), []);
  assert.equal(moduleTickets([mod, mount], 'R-001').length, 1);
});

test('requirementWired only holds ledgers made with the wiring rule', () => {
  assert.equal(requirementWired({ tickets: [t('a')] }, 'R-001'), true);
  assert.equal(requirementWired({ wiring: true, tickets: [t('a')] }, 'R-001'), false);
  assert.equal(requirementWired({ wiring: true, tickets: [t('a'), t('m', { integration: true })] }, 'R-001'), false, 'no route-level test');
  assert.equal(requirementWired({ wiring: true, tickets: [t('a'), t('m', { integration: true, tests: ['r.test.mjs'] })] }, 'R-001'), true);
});

test('releaseReady moves todo tickets with done (or no) dependencies to ready; human tickets stay', () => {
  const tickets = [t('a', { status: 'done' }), t('b', { dependsOn: ['a'] }), t('c'), t('d', { dependsOn: ['b'] }), t('h', { type: 'human' })];
  assert.deepEqual(findReleasable(tickets), ['b', 'c']);
  const { ledger, released } = releaseReady({ tickets });
  assert.deepEqual(released, ['b', 'c']);
  assert.equal(ledger.tickets.find(x => x.id === 'd').status, 'todo');
  assert.equal(tickets.find(x => x.id === 'b').status, 'todo', 'input is not mutated');
});

test('pruneCancelledDeps removes dead dependencies and keeps a valid approval valid', () => {
  const base = { scope: { hash: 'h' }, tickets: [t('a', { status: 'cancelled' }), t('b', { dependsOn: ['a', 'c'] }), t('c', { status: 'done' })], approved: null };
  const approved = approveLedger(base, { by: 'owner' });
  assert.equal(isApproved(approved), true);
  const { pruned } = pruneCancelledDeps(approved);
  assert.deepEqual(pruned, [{ id: 'b', removed: ['a'] }]);
  assert.deepEqual(approved.tickets[1].dependsOn, ['c']);
  assert.equal(isApproved(approved), true);
  const open = { ...base, approved: null };
  pruneCancelledDeps(open);
  assert.equal(open.approved, null, 'an unapproved ledger stays unapproved');
});

test('isBuildArtifact names build files, never source or secrets', () => {
  for (const f of ['tsconfig.tsbuildinfo', 'packages/a/tsconfig.tsbuildinfo', 'coverage/lcov.info', '.next/cache/x', 'node_modules/a/b.js', 'x/__pycache__/m.pyc', '.eslintcache']) assert.equal(isBuildArtifact(f), true, f);
  for (const f of ['src/a.ts', 'tests/a.test.ts', '.env', 'extra.txt', 'buildinfo.md']) assert.equal(isBuildArtifact(f), false, f);
});

test('withoutIgnored keeps secrets and tracked files, drops build files, and ignores catch-all rules', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ign-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', root]);
  await fs.writeFile(path.join(root, '.gitignore'), 'generated/\n');
  await fs.mkdir(path.join(root, 'build'));
  await fs.writeFile(path.join(root, 'build/tracked.mjs'), 'x');
  await exec('git', ['add', '-f', '.gitignore', 'build/tracked.mjs'], { cwd: root });
  const names = ['.env', '.envrc', 'dist/.env', 'deploy.pem', 'terraform.tfvars', 'tsconfig.tsbuildinfo', 'coverage/lcov.info', 'generated/a.ts', 'build/tracked.mjs', 'src/a.ts'];
  assert.deepEqual((await withoutIgnored(root, names)).sort(), ['.env', '.envrc', 'build/tracked.mjs', 'deploy.pem', 'dist/.env', 'src/a.ts', 'terraform.tfvars']);
  // A catch-all .gitignore must not hide a stray source file.
  await fs.writeFile(path.join(root, '.gitignore'), '*\n!.gitignore\n');
  assert.deepEqual(await withoutIgnored(root, ['src/evil.ts']), ['src/evil.ts']);
});
