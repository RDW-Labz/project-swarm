// SPDX-License-Identifier: Apache-2.0
// Found by the Phase 17 practice run (1,000 stub workers, then the first live go --scope over 100 tickets): each of these was a real failure there.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../tools/acceptance.mjs';
import { createLedger, writeLedger, approveLedger } from '../tools/tickets.mjs';
import { writePracticeProject } from './fixtures/make-practice-project.mjs';
import { parseScope, checkScope } from '../tools/scope.mjs';

const SWARM = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'practice-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

test('go --scope ends with its own summary line and the right exit code (it used to throw "say is not defined" after every loop)', async t => {
  const root = await tmp(t);
  spawnSync('git', ['init', '-q', '-b', 'build'], { cwd: root });
  await fs.writeFile(path.join(root, 'a.txt'), 'x');
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-qm', 'i'], { cwd: root });
  const ticket = { id: 'T-0001', title: 'x', type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: ['a.txt'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'done', stage: 'S1' };
  await writeLedger(root, approveLedger(createLedger({ scope: { name: 'x', version: 1, hash: 'a'.repeat(64) }, tickets: [ticket] }), { by: 'owner' }));
  const r = spawnSync(process.execPath, [SWARM, '--root', root, 'go', '--scope', '--max-usd', '1'], { encoding: 'utf8', env: { ...process.env, HOME: root, SWARM_CONFIG: path.join(root, 'config.json') } });
  assert.doesNotMatch(r.stdout + r.stderr, /say is not defined/);
  const last = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(last.status, 'failed');
  assert.match(r.stderr, /scope: failed: the approved scope file docs\/scope\/scope\.md is missing/);
  assert.equal(r.status, 1, 'the exit code for a failed loop');
});

test('a line a test covers but that test was not seen passing is satisfied by a recorded review pass; without one it stays pending', () => {
  const cov = { lines: [{ n: 1, line: 'clamp(5,0,3) returns 3', covered: true, by: { file: 'tests/clamp.test.mjs', title: 'AC1: clamps' } }] };
  const passRecord = { filesHash: 'h', at: '2026-10-20T00:00:00Z', lines: [{ n: 1, verdict: 'pass', evidence: 'src/clamp.mjs:2 and the test assert both' }] };
  const withReview = evaluate({ ticket: {}, cov, record: passRecord, filesHash: 'h', testsPassed: false });
  assert.equal(withReview.state, 'met');
  assert.equal(withReview.lines[0].by, 'review');
  assert.match(withReview.lines[0].evidence, /clamp\.mjs/);
  const none = evaluate({ ticket: {}, cov, record: null, filesHash: 'h', testsPassed: false });
  assert.equal(none.state, 'review');
  assert.equal(none.lines[0].verdict, 'pending');
  const failed = evaluate({ ticket: {}, cov, record: { filesHash: 'h', at: '2026-10-20T00:00:00Z', lines: [{ n: 1, verdict: 'fail', evidence: 'wrong' }] }, filesHash: 'h', testsPassed: false });
  assert.equal(failed.lines[0].verdict, 'pending', 'a failing review does not count as a pass');
  const stale = evaluate({ ticket: {}, cov, record: passRecord, filesHash: 'changed', testsPassed: false });
  assert.equal(stale.lines[0].verdict, 'pending', 'a review of older code does not count');
  const seen = evaluate({ ticket: {}, cov, record: null, filesHash: 'h', testsPassed: true });
  assert.equal(seen.lines[0].by, 'test');
});

test('the practice project generator writes a scope of 100 requirements in 5 stages that the scope checker accepts, with no outside service and nothing sensitive', async t => {
  const dir = await tmp(t);
  assert.equal(await writePracticeProject(dir), 100);
  const scope = parseScope(await fs.readFile(path.join(dir, 'docs/scope/scope.md'), 'utf8'));
  assert.equal(scope.requirements.length, 100);
  assert.equal(scope.stages.length, 5);
  assert.deepEqual([...new Set(scope.requirements.map(r => r.stage))], ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.ok(scope.requirements.every(r => r.acceptance.length === 3));
  const names = scope.requirements.map(r => /The function (\w+)/.exec(r.text)[1]);
  assert.equal(new Set(names).size, 100, 'every function is different');
  assert.equal(checkScope(scope).findings.length, 0);
  assert.deepEqual(scope.external, []);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
});

test('scale --full: a stub run, the Watch board over a live run, the panic button and a backup, all in a throwaway repo and all free', { timeout: 180000 }, async () => {
  const r = spawnSync(process.execPath, [SWARM, 'scale', '--full', '--jobs', '40', '--concurrency', '40'], { encoding: 'utf8', timeout: 170000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const d = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(d.ok, true);
  assert.equal(d.run.complete, 40); assert.equal(d.run.costUsd, 0);
  assert.equal(d.liveRunning >= 36, true, `live workers ${d.liveRunning}`);
  assert.equal(d.watch.liveJobsRunning >= 36, true);
  assert.equal(d.watch.liveMapSquares, 40);
  assert.equal(d.panic.runStatus, 'cancelled');
  assert.equal(d.panic.jobStatuses.cancelled, 40);
  assert.ok(d.panic.steps.some(s => s.startsWith('runs:done')));
  assert.equal(d.backup.verifyOk, true);
});
