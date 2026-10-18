// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { createLedger, writeLedger, readLedger, approveLedger, isApproved, validateTicket, parseLane } from '../tools/tickets.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';

const tk = (id, extra = {}) => ({ id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${id}.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'ready', stage: 'S1', ...extra });
async function project(t, tickets, approved = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lane-risk-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ledger = createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets });
  await writeLedger(root, approved ? { ...ledger, approved: approveLedger(ledger).approved } : ledger);
  return root;
}
const run = (root, args) => runScopeCommand(root, 'tickets', args);
const get = async (root, id) => (await readLedger(root)).tickets.find(x => x.id === id);

test('tickets ID --risk previews, then changes risk with --yes: logged, approval sealed again', async t => {
  const root = await project(t, [tk('T-0001')]);
  const dry = await run(root, ['T-0001', '--risk', 'high']);
  assert.match(dry.stdout, /risk: low {2}-> {2}high/);
  assert.match(dry.stdout, /approval is renewed/);
  assert.equal((await get(root, 'T-0001')).risk, 'low', 'a preview changes nothing');
  const done = await run(root, ['T-0001', '--risk', 'high', '--yes']);
  assert.equal(done.exitCode ?? 0, 0);
  assert.equal((await get(root, 'T-0001')).risk, 'high');
  assert.equal(isApproved(await readLedger(root)), true, 'the ledger is approved again over the new risk');
  const log = await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8').catch(() => '');
  assert.match(log, /"fields":\["risk"\]/);
  assert.match(log, /"reapproved":true/);
});

test('--lane pins the ticket lane: validated, hashed, and used by the manifest', async t => {
  const root = await project(t, [tk('T-0001'), tk('T-0002', { tests: ['tests/a.test.ts'] })]);
  assert.match((await run(root, ['T-0001', '--lane', 'gpt'])).stdout, /lane must be/);
  assert.match((await run(root, ['T-0001', '--lane', 'openrouter'])).stdout, /lane must be/);
  assert.match((await run(root, ['T-0002', '--lane', 'anthropic', '--yes'])).stdout, /cannot run tests/);
  const before = (await readLedger(root)).approved.ticketsHash;
  assert.equal((await run(root, ['T-0001', '--lane', 'claude:opus', '--yes'])).exitCode ?? 0, 0);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].lane, 'claude:opus');
  assert.equal(isApproved(ledger), true);
  assert.notEqual(ledger.approved.ticketsHash, before, 'the lane is part of what was approved');
  const scope = parseScope('# P\n\n## Requirements\n- R-001: x\n');
  const contextEnv = { exists: () => true, sizes: {}, listFiles: () => [], profileContext: {} };
  const job = ticketsToManifest([ledger.tickets[0]], { ledger: { tickets: [] }, scope, ready: true, contextEnv }).manifest.jobs[0];
  assert.equal(job.agent, 'claude');
  assert.equal(job.model, 'opus');
  // Back to auto removes the field, so the hash is the original one again.
  assert.equal((await run(root, ['T-0001', '--lane', 'auto', '--yes'])).exitCode ?? 0, 0);
  assert.equal('lane' in (await get(root, 'T-0001')), false);
  assert.equal((await readLedger(root)).approved.ticketsHash, before, 'clearing the lane restores the original hash');
  assert.equal(ticketsToManifest([await get(root, 'T-0001')], { ledger: { tickets: [] }, scope, ready: true, contextEnv }).manifest.jobs[0].agent, 'auto');
});

test('only a todo, ready or blocked ticket changes; an unapproved ledger stays unapproved; bad values are refused', async t => {
  const root = await project(t, [tk('T-0001', { status: 'done' }), tk('T-0002', { status: 'todo' })], false);
  assert.match((await run(root, ['T-0001', '--risk', 'high', '--yes'])).stdout, /is done; only a todo/);
  assert.match((await run(root, ['T-0002', '--risk', 'extreme', '--yes'])).stdout, /risk must be/);
  assert.equal((await run(root, ['T-0002', '--lane', 'codex', '--yes'])).exitCode ?? 0, 0);
  assert.equal(isApproved(await readLedger(root)), false);
  assert.match((await run(root, ['T-0002', '--lane', 'codex', '--yes'])).stdout, /nothing to change/);
  assert.deepEqual(parseLane('cursor:gpt-5.5'), { agent: 'cursor', model: 'gpt-5.5' });
  assert.equal(parseLane('claude; rm'), null);
  assert.equal(validateTicket(tk('T-9', { lane: 'bogus' })).ok, false);
});

test('a list filter still works: tickets --risk high without an id only filters', async t => {
  const root = await project(t, [tk('T-0001', { risk: 'high' }), tk('T-0002')]);
  const listed = await run(root, ['--risk', 'high']);
  assert.match(listed.stdout, /T-0001/);
  assert.doesNotMatch(listed.stdout, /T-0002/);
  assert.equal((await get(root, 'T-0002')).risk, 'low');
});

test('review fixes: lane text is normalised, a model cannot start with a dash, sensitive tickets stay with known providers, flags are not mixed', async t => {
  const root = await project(t, [tk('T-0001'), tk('T-0002', { sensitive: true })]);
  assert.match((await run(root, ['T-0001', '--lane', 'claude:--dangerously-skip-permissions', '--yes'])).stdout, /lane must be/);
  assert.equal((await run(root, ['T-0001', '--lane', ' codex ', '--yes'])).exitCode ?? 0, 0);
  assert.equal((await get(root, 'T-0001')).lane, 'codex');
  assert.match((await run(root, ['T-0001', '--lane', 'codex', '--yes'])).stdout, /nothing to change/);
  assert.match((await run(root, ['T-0002', '--lane', 'cursor:gpt-5.5', '--yes'])).stdout, /sensitive/);
  assert.equal((await run(root, ['T-0002', '--lane', 'cursor', '--yes'])).exitCode ?? 0, 0);
  const mixed = await run(root, ['T-0001', '--lane', 'claude', '--files', 'src/x.ts', '--yes']);
  assert.notEqual(mixed.exitCode ?? 0, 0);
  assert.match(mixed.stdout + (mixed.stderr ?? ''), /cannot be combined/);
  assert.equal((await get(root, 'T-0001')).lane, 'codex');
  assert.equal(validateTicket(tk('T-9', { sensitive: true, lane: 'cursor:gemini-2.5-pro' })).ok, false);
});

test('manifest: the pin keeps the model when the agent is unchanged, drops it when the agent changes, and is ignored where it cannot work', () => {
  const scope = parseScope('# P\n\n## Requirements\n- R-001: x\n');
  const contextEnv = { exists: () => true, sizes: {}, listFiles: () => [], profileContext: {} };
  const build = ticket => ticketsToManifest([ticket], { ledger: { tickets: [] }, scope, ready: true, contextEnv });
  // A delete ticket is a claude/sonnet shell job; pinning plain claude keeps sonnet, pinning codex drops the model.
  const del = tk('T-0001', { deletes: ['src/old.ts'], files: ['src/new.ts'] });
  assert.equal(build({ ...del, lane: 'claude' }).manifest.jobs[0].model, 'sonnet');
  const codex = build({ ...del, lane: 'codex' }).manifest.jobs[0];
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.model, undefined);
  // anthropic cannot delete files: the pin is ignored with a warning (validateTicket refuses it up front; this is a ledger edited by hand).
  const bad = build({ ...del, lane: 'anthropic' });
  assert.equal(bad.manifest.jobs[0].agent, 'claude');
  assert.match(bad.warnings.join('\n'), /T-0001: lane anthropic ignored/);
  // A sensitive job does not take a pinned cursor model.
  const sensitive = build({ ...tk('T-0002', { lane: 'cursor:gpt-5.5' }), sensitive: true });
  const job = sensitive.manifest.jobs[0];
  assert.equal(job.sensitive, true);
  assert.notEqual(job.model, 'gpt-5.5');
  assert.match(sensitive.warnings.join('\n'), /ignored: this ticket is sensitive/);
});
