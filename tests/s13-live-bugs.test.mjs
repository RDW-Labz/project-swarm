// SPDX-License-Identifier: Apache-2.0
// Bugs found in the live parts-app S13 run.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { validateManifest, editInPlaceOnlyJobs, withoutApiOnlyFields } from '../tools/swarm.mjs';
import { checkTicketTree } from '../tools/scope-integrity.mjs';
import { reviewManifest } from '../tools/acceptance.mjs';

const SWARM = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const t = (id, extra = {}) => ({ id, title: id, type: 'build', status: 'todo', files: [`src/${id}.ts`], acceptance: ['it works'], scopeRefs: [], dependsOn: [], size: 'S', ...extra });
const contextEnv = { exists: () => true, sizes: {}, profileContext: [], listFiles: () => [], limits: {} };
const verify = { command: ['npm', 'test'] };

test('2: a ticket with tests stays on the router (auto); the verify block does not pick the builder', () => {
  const tk = t('T-0001', { tests: ['tests/a.test.ts'] });
  const job = ticketsToManifest([tk], { ledger: { tickets: [tk] }, verify, contextEnv }).manifest.jobs[0];
  assert.equal(job.agent, 'auto');
  assert.equal(job.model, undefined);
  assert.equal(job.shell, undefined);
  assert.doesNotThrow(() => validateManifest({ version: 1, jobs: [job] }));
});

test('3: an escalated ticket pinned to codex carries no maxOutputTokens, and the manifest validates', () => {
  const tk = t('T-0001', { lane: 'codex', escalation: 1 });
  const job = ticketsToManifest([tk], { ledger: { tickets: [tk] }, contextEnv, laneModels: { codex: { model: 'gpt-6.1-sol' } } }).manifest.jobs[0];
  assert.equal(job.agent, 'codex');
  assert.equal(job.maxOutputTokens, undefined);
  assert.doesNotThrow(() => validateManifest({ version: 1, jobs: [job] }));
  const unpinned = ticketsToManifest([t('T-0002', { escalation: 1 })], { ledger: { tickets: [] }, contextEnv }).manifest.jobs[0];
  assert.equal(unpinned.maxOutputTokens, 16384, 'an unpinned auto job keeps its bigger limit for the API lanes');
  assert.equal(withoutApiOnlyFields({ id: 'x', agent: 'cursor', maxOutputTokens: 16384, cacheContext: ['a'] }).maxOutputTokens, undefined);
  assert.equal(withoutApiOnlyFields({ id: 'x', agent: 'anthropic', maxOutputTokens: 16384 }).maxOutputTokens, 16384);
});

test('4: scope check warns about a test file owned by a later ticket; the review manifest leaves out files that do not exist yet', () => {
  const build = t('T-0001', { tests: ['tests/a.test.ts'] });
  const test2 = t('T-0002', { type: 'test', files: ['tests/a.test.ts'], dependsOn: ['T-0001'] });
  const out = checkTicketTree({ scope: { requirements: [] }, tickets: [build, test2] });
  const warning = out.warnings.find(w => w.code === 'test-owned-by-later');
  assert.ok(warning, JSON.stringify(out.warnings));
  assert.match(warning.message, /T-0001 lists tests\/a\.test\.ts owned by T-0002/);
  const ok = checkTicketTree({ scope: { requirements: [] }, tickets: [build, { ...test2, dependsOn: [] }] });
  assert.ok(!ok.warnings.some(w => w.code === 'test-owned-by-later'), 'not later: no warning');
  const m = reviewManifest('r1', [{ ticket: build, uncovered: ['it works'] }], { tickets: [build, test2], exists: p => p !== 'tests/a.test.ts' });
  assert.ok(m.jobs[0].context.includes('src/T-0001.ts'));
  assert.ok(!m.jobs[0].context.includes('tests/a.test.ts'));
});

test('5: automatic jobs whose existing outputs are over the output cap are found, and the router keeps them off the API lanes', async t2 => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-cap-'));
  t2.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/big.css'), 'a'.repeat(20000));
  await fs.writeFile(path.join(root, 'src/small.css'), 'a');
  const jobs = [{ id: 'big', agent: 'auto', outputs: ['src/big.css'] }, { id: 'small', agent: 'auto', outputs: ['src/small.css'] }, { id: 'new', agent: 'auto', outputs: ['src/none.css'] }];
  const ids = await editInPlaceOnlyJobs(root, { jobs });
  assert.deepEqual([...ids], ['big']);
  const { routeJob } = await import('../tools/router.mjs');
  const lanes = { anthropic: { model: 'claude-haiku-5-5' }, cursor: { model: 'u' } };
  const job = { id: 'big', agent: 'auto', sensitive: false, outputs: ['src/big.css'] };
  const pick = routeJob(job, { lanes, accepts: c => c.agent !== 'anthropic' });
  assert.equal(pick.agent, 'cursor');
  assert.throws(() => routeJob(job, { lanes: { anthropic: lanes.anthropic }, accepts: c => c.agent !== 'anthropic' }), { code: 'route-exhausted' });
});

test('6: with-concurrency takes --root before the word, after it, or before the --, and hands it to the command', async t2 => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-wc-'));
  t2.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.json');
  const project = path.join(dir, 'proj');
  await fs.mkdir(project);
  spawnSync('git', ['init', '-q'], { cwd: project });
  await fs.writeFile(config, JSON.stringify({ machineConcurrency: 4 }));
  const env = { ...process.env, SWARM_CONFIG: config, HOME: dir };
  for (const argv of [['--root', project, 'with-concurrency', '8', '--', 'status'], ['with-concurrency', '--root', project, '8', '--', 'status'], ['with-concurrency', '8', '--root', project, '--', 'status'], ['with-concurrency', '8', '--', '--root', project, 'status']]) {
    const r = spawnSync(process.execPath, [SWARM, ...argv], { encoding: 'utf8', env });
    assert.match(r.stderr, /machineConcurrency was 4, set to 8 for this command, and is back to 4/, `${argv.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).machineConcurrency, 4);
  }
  // the root really reaches the command: `version` refuses --root, so it fails the same way with or without the wrapper
  const bad = spawnSync(process.execPath, [SWARM, '--root', project, 'with-concurrency', '8', '--', 'version'], { encoding: 'utf8', env });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /--root is not allowed for version\/update/);
});

test('update refuses while a run is live (naming it) and goes ahead with --force', async t2 => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-upd-'));
  t2.after(() => fs.rm(home, { recursive: true, force: true }));
  const live = path.join(home, '.project-swarm', 'live');
  await fs.mkdir(live, { recursive: true });
  const root = path.join(home, 'proj');
  await fs.mkdir(root);
  await fs.writeFile(path.join(live, '1792466337986-cfef3f98.json'), JSON.stringify({ runId: '1792466337986-cfef3f98', root, pid: process.pid, startedAt: new Date().toISOString(), jobs: [{ id: 'a', status: 'running' }, { id: 'b', status: 'complete' }] }));
  const env = { ...process.env, HOME: home, SWARM_LIVE_DIR: live };
  const refused = spawnSync(process.execPath, [SWARM, 'update', '--yes'], { encoding: 'utf8', env });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /update-refused: 1 run\(s\) are live/);
  assert.match(refused.stdout + refused.stderr, /1792466337986-cfef3f98/);
  assert.match(refused.stdout + refused.stderr, /--force/);
  const forced = spawnSync(process.execPath, [SWARM, 'update', '--yes', '--force'], { encoding: 'utf8', env });
  assert.doesNotMatch(forced.stdout + forced.stderr, /update-refused/);
});

import { buildTicketContext } from '../tools/ticket-context.mjs';
test('a test ticket sees the files under test, the runner config, tsconfig and one existing test as an example', () => {
  const have = new Set(['src/lib/price.ts', 'src/lib/other.ts', 'vitest.config.ts', 'tsconfig.json', 'tests/old.test.ts', 'tests/mine.test.ts', 'package.json']);
  const tree = { src: ['src/lib/price.ts', 'src/lib/other.ts'], tests: ['tests/old.test.ts', 'tests/mine.test.ts'] };
  const build = t('T-0010', { files: ['src/lib/price.ts'], tests: ['tests/mine.test.ts'] });
  const test2 = t('T-0011', { type: 'test', files: ['tests/mine.test.ts'], dependsOn: [] });
  const r = buildTicketContext({ ticket: test2, allTickets: [build, test2], exists: p => have.has(p), listFiles: d => tree[d] ?? [] });
  assert.equal(r.kind, 'test');
  for (const p of ['src/lib/price.ts', 'vitest.config.ts', 'tsconfig.json', 'tests/old.test.ts']) assert.ok(r.context.includes(p), `${p} in ${r.context}`);
  assert.ok(!r.context.includes('src/lib/other.ts'), 'unrelated implementation files stay out');
  const byName = buildTicketContext({ ticket: t('T-0012', { type: 'test', files: ['tests/price.test.ts'] }), allTickets: [], exists: p => have.has(p), listFiles: d => tree[d] ?? [] });
  assert.ok(byName.context.includes('src/lib/price.ts'), 'matched by the name of the test file when no ticket names it');
});
