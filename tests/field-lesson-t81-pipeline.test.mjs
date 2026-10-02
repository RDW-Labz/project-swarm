// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ship, classifyCheckEnvironment, STUB_SECTION_RE, preflightReport } from '../tools/ship.mjs';
import { PIPELINE_STAGES, TICKET_USAGE, parseTicketArgs, ticketPipeline } from '../tools/pipeline.mjs';

const sha9001 = '9'.repeat(40);
const sha9002 = 'a'.repeat(40);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const response = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });
const required9001 = { name: 'required9001', status: 'COMPLETED', conclusion: 'SUCCESS' };
const optional9002 = { name: 'optional9002', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://9001.invalid/actions/runs/9002/job/9002' };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'pipeline9001-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payload = { title: '9001', head: '9001', base: '9002/9003', body: '## Checks\n<!-- swarm:checks -->\n## Mutation check\n9001' };
  const manifest = { version: 1, jobs: [{ id: '9001', outputs: ['output9001'] }], checks: [] };
  await fs.writeFile(path.join(root, 'payload9001.json'), JSON.stringify(payload));
  await fs.writeFile(path.join(root, 'manifest9001.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, 'output9001'), '9001');
  return { root, payload, manifest };
}

function fakeClock9001() {
  let milliseconds = 0;
  return { now: () => milliseconds, sleep: async amount => { milliseconds += amount; } };
}

async function ship9001(t, changes = {}) {
  const { root, payload } = await fixture(t);
  if (changes.body !== undefined) {
    payload.body = changes.body;
    await fs.writeFile(path.join(root, 'payload9001.json'), JSON.stringify(payload));
  }
  const calls = [];
  const clock = fakeClock9001();
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'git') {
      if (args[0] === 'remote') return response(''); // --repo is synthetic; never resolve a real origin.
      if (args[0] === 'rev-parse') return response(sha9001);
      if (['status', 'push', 'diff'].includes(args[0])) return response();
      if (args[0] === 'merge-base') return changes.baseSha ? response(changes.baseSha) : response('', 1);
      if (args[0] === 'show') return response('{"version":"0.0.0"}');
      if (args[0] === 'worktree') return response();
      throw new Error('unexpected git argv: ' + JSON.stringify(args));
    }
    if (file === '9001') return response('Failed to spawn: 9001', 2);
    assert.equal(file, 'gh');
    if (args[0] === 'api' && args[1].endsWith('/required_status_checks')) return changes.protection ?? response(JSON.stringify({ contexts: ['required9001'], checks: [] }));
    if (args[0] === 'api' && args[1].includes('?head=')) return response('[]');
    if (args[0] === 'api' && args[1].endsWith('/pulls')) return response(JSON.stringify({ number: 9001, html_url: 'https://9001.invalid/9001' }));
    if (args[0] === 'pr' && args[1] === 'merge') {
      assert(args.includes('--match-head-commit'));
      assert.equal(args.at(-1), sha9001);
      return response();
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (args.at(-1) === 'state,mergeCommit') return response(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: sha9002 } }));
      const view = changes.view?.(clock.now()) ?? { headRefOid: sha9001, statusCheckRollup: [required9001, optional9002] };
      return response(JSON.stringify(view));
    }
    if (args[0] === 'run') return response();
    throw new Error('unexpected gh argv: ' + JSON.stringify(args));
  };
  const options = {
    root, payloadPath: path.join(root, 'payload9001.json'), repo: '9001/9002',
    exec, ...clock, pollMs: 10, timeoutMs: 30, noCiGraceMs: 20, rerunFlaky: 0,
    env: { HOME: root, SWARM_CONFIG: path.join(root, 'config9001.json') }, home: root,
    authorEmailExec: async () => response(), commitScanExec: async () => response(),
    runChecks: async () => [],
    ...changes.options,
  };
  return { result: await ship(options), calls, root, options, clock };
}

describe('T81 required-context CI', () => {
  test('T81 required checks merge while optional checks run', async t => {
    const { result, calls, clock } = await ship9001(t, {
      options: { waitRequiredOnly: true },
      protection: response(JSON.stringify({ contexts: ['required9001', 'required9001'], checks: [{ context: 'required9001' }] })),
    });
    assert.equal(result.status, 'merged');
    assert.deepEqual(result.requiredContexts, ['required9001']);
    assert.deepEqual(result.pendingAtMerge, ['optional9002']);
    assert.equal(result.waitedForRequiredOnly, true);
    assert.equal(clock.now(), 0); // Optional work never settles, even if the mutant polls forever.
    assert(calls.some(call => call.args[1] === 'merge'));
    assert(!calls.some(call => call.file === 'gh' && call.args[0] === 'run'));
    assert(calls.some(call => call.args[1] === 'repos/9001/9002/branches/9002%2F9003/protection/required_status_checks'));
  });

  test('T81 required checks fallback preserves all-context wait', async t => {
    for (const protection of [response('', 1, 'gh: Not Found (HTTP 404)'), response('null'), response('{"contexts":[],"checks":[]}')]) {
      const { result } = await ship9001(t, { protection, options: { waitRequiredOnly: true } });
      assert.equal(result.status, 'timeout');
      assert.equal(result.requiredContexts, null);
      assert.equal(result.waitedForRequiredOnly, false);
      assert.deepEqual(result.pendingAtMerge, []);
    }
  });

  test('T81 legacy state and default ship remain compatible', async t => {
    const { result, calls } = await ship9001(t);
    assert.equal(result.status, 'timeout');
    for (const key of ['requiredContexts', 'pendingAtMerge', 'waitedForRequiredOnly']) assert(!Object.hasOwn(result, key));
    for (const key of ['tag', 'warnings', 'sha', 'ci', 'checks', 'timing']) assert(Object.hasOwn(result, key));
    assert(!calls.some(call => call.args[1]?.endsWith('/required_status_checks')));
    const legacy9001 = await ship9001(t, { view: () => ({ headRefOid: sha9001, statusCheckRollup: [required9001] }) });
    assert.equal(legacy9001.result.status, 'merged');
  });

  test('missing required entries, stale heads and duplicate required runs never pass early', async t => {
    for (const view of [
      { headRefOid: sha9001, statusCheckRollup: [optional9002] },
      { headRefOid: sha9002, statusCheckRollup: [required9001] },
      { headRefOid: sha9001, statusCheckRollup: [required9001, { ...optional9002, name: 'required9001' }] },
    ]) {
      const { result, calls } = await ship9001(t, { options: { waitRequiredOnly: true }, view: () => view });
      assert.equal(result.status, 'timeout');
      assert.deepEqual(result.pendingAtMerge, []);
      assert(!calls.some(call => call.args[1] === 'merge'));
    }
  });

  test('required failure blocks, optional failure does not, neutral and skipped pass', async t => {
    for (const conclusion of ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'FAILURE']) {
      const { result } = await ship9001(t, { options: { waitRequiredOnly: true }, view: () => ({
        headRefOid: sha9001, statusCheckRollup: [{ ...required9001, conclusion }, { ...optional9002, status: 'COMPLETED', conclusion: 'FAILURE' }],
      }) });
      assert.equal(result.status, conclusion === 'FAILURE' ? 'ci-failed' : 'merged');
      if (conclusion === 'FAILURE') assert.deepEqual(result.ci.failed, ['required9001']);
    }
  });

  test('protection errors refuse before push and hold/ready results never claim pendingAtMerge', async t => {
    for (const protection of [response('', 1, 'HTTP 401'), response('', 1, 'HTTP 403; request 404'), response('', 1, 'HTTP 500'), response('{'), response('{}'), response('{"contexts":[9001]}')]) {
      const { result, calls } = await ship9001(t, { protection, options: { waitRequiredOnly: true } });
      assert.equal(result.status, 'refused');
      assert.equal(result.code, 'required-contexts-unavailable');
      assert.deepEqual(result.pendingAtMerge, []);
      assert(!calls.some(call => call.args[0] === 'push'));
    }
    for (const changes of [{ options: { merge: false } }, { body: '**needs 9001**\n## Checks\n9001' }]) {
      const { result } = await ship9001(t, { ...changes, options: { ...changes.options, waitRequiredOnly: true } });
      assert(['held', 'ready'].includes(result.status));
      assert.deepEqual(result.pendingAtMerge, []);
    }
    const { result } = await ship9001(t, { options: { waitRequiredOnly: true, mergeMethod: '9001' } });
    assert.deepEqual([result.requiredContexts, result.pendingAtMerge, result.waitedForRequiredOnly], [null, [], false]);
  });
});

describe('T81 ship refusals', () => {
  test('T81 spawn-shaped failures cannot become pre-existing', async t => {
    const { result, calls } = await ship9001(t, { baseSha: sha9002, options: {
      acceptPreExisting: true, checkArgvs: [['9001']],
      runChecks: async () => [{ name: '9001', status: 'failed', exitCode: 2, head: 'Failed to spawn: 9001\r\n9002', tail: '9003\n'.repeat(9001) }],
    } });
    assert.equal(result.status, 'checks-failed');
    assert.equal(result.code, 'check-env-missing');
    assert.equal(result.checks[0].status, 'check-env-missing');
    assert.equal(result.hint, 'run uv sync --locked / npm ci in this worktree or pass --sync');
    assert(!calls.some(call => call.args[0] === 'worktree' || call.file === '9001' || call.args[0] === 'push' || call.args[1] === 'merge'));
    for (const head of ['Failed to spawn', '9001\r\ncommand not found', '9001\n9002\nNo such file or directory']) assert.equal(classifyCheckEnvironment({ exitCode: 2, head }).code, 'check-env-missing');
    assert.equal(classifyCheckEnvironment({ exitCode: 127, head: '' }).code, 'check-env-missing');
    assert.equal(classifyCheckEnvironment({ exitCode: 2, head: '9001\n9002\n9003\nFailed to spawn' }), null);
    assert.equal(classifyCheckEnvironment({ exitCode: null, head: 'Failed to spawn' }), null);
    assert.equal(classifyCheckEnvironment({ exitCode: 1, head: 'Failed to spawn' }), null);
    const numericSpawn = await ship9001(t, { options: { runChecks: async () => [{ status: 'spawn-error', exitCode: 127, head: '' }] } });
    assert.equal(numericSpawn.result.code, 'check-env-missing');
    for (const legacy9001 of [{ output: 'Failed to spawn: 9001' }, { tail: 'Failed to spawn: 9001' }]) {
      const legacy = await ship9001(t, { options: { runChecks: async () => [{ status: 'pre-existing', exitCode: 2, ...legacy9001 }] } });
      assert.equal(legacy.result.code, 'check-env-missing');
    }
  });

  test('T81 required mutation section rejects literal stub', async t => {
    const body = '## Checks\n9001\n## Mutation check (9001)\n9001\n<!-- swarm:stub mutation -->\n9002';
    assert(STUB_SECTION_RE.test(body));
    const { result, calls, root, options } = await ship9001(t, { body, options: { requireSections: ['Mutation check'] } });
    assert.equal(result.status, 'refused');
    assert.equal(result.code, 'stub-section');
    assert.equal(result.section, 'Mutation check');
    assert.equal(result.reason, 'stub-section: Mutation check');
    assert(result.failures.some(failure => failure.code === 'stub-section' && failure.section === 'Mutation check'));
    assert(!calls.some(call => call.args[0] === 'push' || call.args.includes('--input')));
    const report = await preflightReport({ ...options, root, body, payloadBase: '9002', requireSections: ['Mutation check'] });
    assert.equal(report.ok, false);
    assert.equal(report.failures[0].code, 'stub-section');
    const positive = await ship9001(t, { body: body.replace('<!-- swarm:stub mutation -->', '9003'), options: { requireSections: ['Mutation check'], waitRequiredOnly: true } });
    assert.equal(positive.result.status, 'merged');
    const unrelated = await ship9001(t, { body, options: { requireSections: ['Checks'], waitRequiredOnly: true } });
    assert.equal(unrelated.result.status, 'merged');
  });
});

async function pipeline9001(t, { red, throws, dirty = [], editLocks = false, additional = false } = {}) {
  const { root, manifest } = await fixture(t);
  await fs.writeFile(path.join(root, 'uv.lock'), '9001');
  const options = parseTicketArgs(['manifest9001.json', '--pr', 'payload9001.json', ...(additional ? ['--check', '["9001","9002"]'] : [])]);
  const calls = [], commits = [], shipFlags = [];
  let worktreeDirt = dirty, branch = '9001';
  const journalPath = path.join(root, '.swarm/runs/run-0000/pipeline.json');
  const readJournal = async () => JSON.parse(await fs.readFile(journalPath, 'utf8'));
  const results = {
    run: { id: 'run-0000', status: 'complete', jobs: [{ id: '9001', status: 'complete', baseHashes: { output9001: digest('9001') } }] },
    inspect: { jobs: [{ id: '9001', status: 'complete' }], files: [{ path: 'output9001', status: 'ready' }], warnings: ['9001'] },
    integrate: { status: 'integrated', files: ['output9001'], preChecks: [{ status: 'passed' }] },
    checks: { checks: [], checksPassed: true, checksErrored: false },
    commit: { status: 'committed', files: ['output9001'], sha: sha9002 },
    ship: { status: 'held', reason: '9001', warnings: ['9002'] },
  };
  const deps = {
    now: () => 9001,
    makeRunId: prefix => { assert.equal(prefix, 'ticket'); return 'run-0000'; },
    exec: async (file, args) => {
      assert.equal(file, 'git');
      if (args[0] === 'symbolic-ref') return response(branch);
      if (args[0] === 'status') return response(worktreeDirt.map(file => ' M ' + file + '\0').join(''));
      if (args[0] === 'rev-parse') return response(sha9002);
      throw new Error('unexpected argv');
    },
  };
  for (const stage of PIPELINE_STAGES) deps[stage] = async (...args) => {
    calls.push(stage);
    const journal = await readJournal();
    assert.equal(journal.stages.at(-1).status, 'running');
    assert.equal(journal.stages.at(-1).stage, stage);
    assert.equal(journal.stages.at(-1).finishedAt, null);
    assert.equal(args[0], root);
    if (stage === 'run') {
      assert.deepEqual(args[1], manifest);
      assert.equal(args[2], 'run-0000');
      await assert.rejects(fs.stat(path.join(root, '.swarm/runs/run-0000/claim')), { code: 'ENOENT' });
    }
    if (stage === 'integrate') {
      assert.deepEqual(args[2], { noChecks: true });
      worktreeDirt = ['output9001'];
      if (editLocks) {
        await fs.writeFile(path.join(root, 'uv.lock'), '9002');
        worktreeDirt.push('uv.lock');
      }
    }
    if (stage === 'checks') {
      assert.deepEqual(args[2], options.checks);
      if (editLocks) {
        await fs.writeFile(path.join(root, 'package-lock.json'), '9003');
        worktreeDirt.push('package-lock.json');
      }
    }
    if (stage === 'commit') { commits.push(args); worktreeDirt = []; }
    if (stage === 'ship') shipFlags.push(args[2]);
    if (stage === throws) throw new Error('9001');
    return stage === red ? { status: 'failed', diagnostic: '9001' } : results[stage];
  };
  return { root, options, deps, calls, commits, shipFlags, results, readJournal, journalPath, setDirty: value => { worktreeDirt = value; }, setBranch: value => { branch = value; } };
}

describe('T81 durable ticket stages', () => {
  test('T81 pipeline stops at first red stage', async t => {
    for (const stage of PIPELINE_STAGES) {
      for (const thrown of [false, true]) {
        const fixture = await pipeline9001(t, thrown ? { throws: stage } : { red: stage });
        const result = await ticketPipeline(fixture.root, fixture.options, fixture.deps);
        assert.equal(result.status, 'error');
        assert.equal(result.stage, stage);
        assert.equal(result.detail.code, 'pipeline-stage-failed');
        assert.deepEqual(fixture.calls, PIPELINE_STAGES.slice(0, PIPELINE_STAGES.indexOf(stage) + 1));
        const journal = await fixture.readJournal();
        assert.equal(journal.stages.at(-1).stage, stage);
        assert.equal(journal.stages.at(-1).status, 'error');
        assert.deepEqual(journal.stages.at(-1).detail, result.detail.result);
        assert.equal(journal.stages.at(-1).startedAt, journal.stages.at(-2).startedAt);
        assert.equal(journal.stages.at(-1).finishedAt, new Date(9001).toISOString());
      }
    }
  });

  test('T81 resume skips every green stage', async t => {
    const fixture = await pipeline9001(t);
    const first = await ticketPipeline(fixture.root, fixture.options, fixture.deps);
    assert.equal(first.status, 'complete');
    assert.equal(first.ship.status, 'held');
    const journalBefore = await fs.readFile(fixture.journalPath, 'utf8');
    let callbacks = 0;
    const forbidden = Object.fromEntries(Object.keys(fixture.deps).map(key => [key, () => { callbacks++; throw new Error('green stage reran'); }]));
    const resumed = await ticketPipeline(fixture.root, { ...fixture.options, resume: 'run-0000' }, forbidden);
    assert.deepEqual(resumed, first);
    assert.equal(callbacks, 0);
    assert.equal(await fs.readFile(fixture.journalPath, 'utf8'), journalBefore);
    assert(journalBefore.endsWith('\n'));
    assert.deepEqual((await fixture.readJournal()).stages.find(entry => entry.stage === 'inspect' && entry.status === 'ok').detail.warnings, ['9001']);
  });

  test('T81 commit includes only outputs and check-changed lockfiles', async t => {
    const fixture = await pipeline9001(t, { editLocks: true, additional: true });
    const result = await ticketPipeline(fixture.root, fixture.options, fixture.deps);
    assert.equal(result.status, 'complete');
    assert.deepEqual(fixture.commits[0].slice(1), [['output9001', 'package-lock.json', 'uv.lock'], '9001']);
    assert.deepEqual(fixture.shipFlags[0].additionalChecks, [{ name: 'ticket-check-1', argv: ['9001', '9002'] }]);
    assert(!Object.hasOwn(fixture.shipFlags[0], 'waitRequiredOnly'));
    const journal = await fixture.readJournal();
    assert.equal(journal.lockfileBaseline['uv.lock'], digest('9001'));
    assert.equal(journal.lockfileBaseline['package-lock.json'], null);
    assert.equal(Object.keys(journal.lockfileBaseline).length, 6);
    const unchanged = await pipeline9001(t);
    const integrate = unchanged.deps.integrate;
    unchanged.deps.integrate = async (...args) => { const result = await integrate(...args); unchanged.setDirty([]); return result; };
    assert.equal((await ticketPipeline(unchanged.root, unchanged.options, unchanged.deps)).status, 'complete');
    assert.equal(unchanged.commits.length, 0);
    assert.deepEqual((await unchanged.readJournal()).stages.findLast(entry => entry.stage === 'commit').detail, { status: 'unchanged', files: [], sha: sha9002 });
  });

  test('failed checks resume after repair and retain the red attempt', async t => {
    const fixture = await pipeline9001(t, { red: 'checks' });
    const first = await ticketPipeline(fixture.root, fixture.options, fixture.deps);
    assert.equal(first.stage, 'checks');
    fixture.calls.length = 0;
    fixture.deps.checks = async () => { fixture.calls.push('checks'); return fixture.results.checks; };
    const result = await ticketPipeline(fixture.root, { ...fixture.options, resume: 'run-0000' }, fixture.deps);
    assert.equal(result.status, 'complete');
    assert.deepEqual(fixture.calls, ['checks', 'commit', 'ship']);
    const attempts = (await fixture.readJournal()).stages.filter(entry => entry.stage === 'checks');
    assert.deepEqual(attempts.map(entry => entry.status), ['running', 'error', 'running', 'ok']);
    assert.deepEqual(attempts[1].detail, first.detail.result);
  });

  test('lockfile edits after saved checks cannot be attributed to those checks', async t => {
    const fixture = await pipeline9001(t, { red: 'commit' });
    assert.equal((await ticketPipeline(fixture.root, fixture.options, fixture.deps)).stage, 'commit');
    await fs.writeFile(path.join(fixture.root, 'uv.lock'), '9002');
    fixture.setDirty(['uv.lock']);
    fixture.calls.length = 0;
    const result = await ticketPipeline(fixture.root, { ...fixture.options, resume: 'run-0000' }, fixture.deps);
    assert.deepEqual(result, { status: 'error', stage: 'commit', detail: { code: 'pipeline-dirty', paths: ['uv.lock'] } });
    assert.deepEqual(fixture.calls, []);
  });

  test('explicit ticket flags and legacy successful commit receipts reach ship intact', async t => {
    const fixture = await pipeline9001(t);
    fixture.options = { ...fixture.options, repo: '9001/9002', branch: '9001', commitMessage: '9003', requireSections: ['9004'], waitRequiredOnly: true };
    fixture.results.commit = { committed: true, files: ['output9001'], sha: sha9002 };
    const result = await ticketPipeline(fixture.root, fixture.options, fixture.deps);
    assert.equal(result.status, 'complete');
    assert.equal(fixture.commits[0][2], '9003');
    assert.deepEqual(fixture.shipFlags[0], { payloadPath: path.join(fixture.root, 'payload9001.json'), repo: '9001/9002', requireSections: ['9004'], additionalChecks: [], waitRequiredOnly: true });
    assert.equal((await fixture.readJournal()).stages.findLast(entry => entry.stage === 'commit').detail.committed, true);
  });

  test('corrupt, mismatched, legacy and interrupted journals refuse; a failed run never relaunches', async t => {
    for (const mutate of [
      journal => { journal.version = 9001; },
      journal => { journal.root += '/9001'; },
      journal => { journal.manifestHash = '9'.repeat(64); },
      journal => { journal.options.waitRequiredOnly = true; },
      journal => { delete journal.lockfileBaseline['uv.lock']; },
      journal => { journal.stages.splice(0, 2); },
      journal => { journal.stages.at(-1).detail = null; },
    ]) {
      const fixture = await pipeline9001(t);
      await ticketPipeline(fixture.root, fixture.options, fixture.deps);
      const journal = await fixture.readJournal(); mutate(journal);
      await fs.writeFile(fixture.journalPath, JSON.stringify(journal));
      fixture.calls.length = 0;
      const result = await ticketPipeline(fixture.root, { ...fixture.options, resume: 'run-0000' }, fixture.deps);
      assert.equal(result.detail.code, 'pipeline-invalid');
      assert.deepEqual(fixture.calls, []);
    }
    const interrupted = await pipeline9001(t, { red: 'checks' });
    await ticketPipeline(interrupted.root, interrupted.options, interrupted.deps);
    const journal = await interrupted.readJournal(); journal.stages.pop();
    await fs.writeFile(interrupted.journalPath, JSON.stringify(journal));
    assert.deepEqual(await ticketPipeline(interrupted.root, { ...interrupted.options, resume: 'run-0000' }, interrupted.deps), { status: 'error', stage: 'resume', detail: { code: 'pipeline-resume-unsafe', stage: 'checks' } });
    const failedRun = await pipeline9001(t, { red: 'run' });
    const first = await ticketPipeline(failedRun.root, failedRun.options, failedRun.deps);
    failedRun.calls.length = 0;
    assert.deepEqual(await ticketPipeline(failedRun.root, { ...failedRun.options, resume: 'run-0000' }, failedRun.deps), first);
    assert.deepEqual(failedRun.calls, []);
    const legacy9001 = await pipeline9001(t);
    assert.equal((await ticketPipeline(legacy9001.root, { ...legacy9001.options, resume: 'run-0000' }, legacy9001.deps)).detail.code, 'pipeline-invalid');
    const linked = await pipeline9001(t);
    await ticketPipeline(linked.root, linked.options, linked.deps);
    await fs.rename(linked.journalPath, linked.journalPath + '.9001');
    await fs.symlink(linked.journalPath + '.9001', linked.journalPath);
    linked.calls.length = 0;
    assert.equal((await ticketPipeline(linked.root, { ...linked.options, resume: 'run-0000' }, linked.deps)).detail.code, 'pipeline-invalid');
    assert.deepEqual(linked.calls, []);
  });

  test('dirty lockfiles, staged unrelated files, branch mismatch and concurrent dirt refuse', async t => {
    for (const file of ['uv.lock', '9002']) {
      const fixture = await pipeline9001(t, { dirty: [file] });
      const result = await ticketPipeline(fixture.root, fixture.options, fixture.deps);
      assert.deepEqual(result, { status: 'error', stage: 'commit', detail: { code: 'pipeline-dirty', paths: [file] } });
      assert.deepEqual(fixture.calls, []);
    }
    const staged = await pipeline9001(t);
    const git = staged.deps.exec;
    staged.deps.exec = (file, args, options) => args[0] === 'status' ? response('A  9002\0') : git(file, args, options);
    assert.equal((await ticketPipeline(staged.root, staged.options, staged.deps)).detail.code, 'pipeline-dirty');
    assert.deepEqual(staged.calls, []);
    for (const branch of ['', '9002']) {
      const fixture = await pipeline9001(t); fixture.setBranch(branch);
      const result = await ticketPipeline(fixture.root, fixture.options, fixture.deps);
      assert.equal(result.detail.code, 'pipeline-branch-mismatch');
      assert.deepEqual(fixture.calls, []);
    }
    const concurrent = await pipeline9001(t);
    const checks = concurrent.deps.checks;
    concurrent.deps.checks = async (...args) => { const result = await checks(...args); concurrent.setDirty(['output9001', '9002']); return result; };
    const result = await ticketPipeline(concurrent.root, concurrent.options, concurrent.deps);
    assert.equal(result.detail.code, 'pipeline-dirty');
    assert.deepEqual(result.detail.paths, ['9002']);
    assert(!concurrent.calls.includes('commit'));
    assert(!concurrent.calls.includes('ship'));
    assert.equal((await concurrent.readJournal()).stages.at(-1).status, 'error');
  });

  test('every stage uses the explicit success predicate', async t => {
    for (const [stage, result] of [
      ['run', { id: 'run-0000', status: 'complete', jobs: [{ status: 'failed' }] }],
      ['inspect', { jobs: [{ status: 'complete' }], files: [{ status: 'conflict' }] }],
      ['inspect', { jobs: [{ status: 'failed' }], files: [] }],
      ['integrate', { status: 'integrated', preChecks: [{ status: 'failed' }] }],
      ['integrate', { status: 'integrated', acceptedDeviations: ['9001'] }],
      ['checks', { checksPassed: true, checksErrored: true }],
      ['checks', { checks: [{ status: 'failed' }], checksPassed: false }],
      ['commit', { status: 'failed', sha: sha9001 }],
      ['ship', { status: 'held-red-check' }],
    ]) {
      const fixture = await pipeline9001(t); fixture.results[stage] = result;
      const failed = await ticketPipeline(fixture.root, fixture.options, fixture.deps);
      assert.equal(failed.stage, stage);
      assert.equal(failed.status, 'error');
      assert.equal(fixture.calls.at(-1), stage);
    }
  });

  test('ticket parser is strict, ordered and help performs no IO', async t => {
    assert.deepEqual(parseTicketArgs(['--9001', '--help']), { help: true });
    assert.deepEqual(await ticketPipeline('/9001', { help: true }, {}), { help: true });
    for (const argv of [[], ['9001'], ['9001', '--pr'], ['9001', '--pr', '--repo', '9001/9002'], ['9001', '--pr', '9002', '--9003'], ['9001', '--pr', '9002', '--pr', '9003'], ['9001', '--pr', '9002', '--wait-required-only', '--wait-required-only'], ['9001', '--pr', '9002', '--check', '{}'], ['9001', '--pr', '9002', '--resume', '../9003']]) {
      assert.throws(() => parseTicketArgs(argv), error => error.pipelineError?.detail.code === 'ticket-args');
    }
    const parsed = parseTicketArgs(['9001', '--pr', '9002', '--require-section', '9003', '--require-section', '9004', '--check', '["9005"]', '--check', '["9006"]', '--wait-required-only']);
    assert.deepEqual(parsed.requireSections, ['9003', '9004']);
    assert.deepEqual(parsed.checks, [{ name: 'ticket-check-1', argv: ['9005'] }, { name: 'ticket-check-2', argv: ['9006'] }]);
    assert.equal(parsed.waitRequiredOnly, true);
    assert.throws(() => parseTicketArgs(['9001', '--pr', '9002', ...Array.from({ length: 11 }, () => ['--check', '["9001"]']).flat()]), error => error.pipelineError?.detail.code === 'ticket-args');
    assert(TICKET_USAGE.includes('--resume'));
    assert(TICKET_USAGE.includes('--root'));
    const collision = await pipeline9001(t, { additional: true });
    const manifestPath = path.join(collision.root, 'manifest9001.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.checks = [{ name: 'ticket-check-1', argv: ['9001'] }];
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal((await ticketPipeline(collision.root, collision.options, collision.deps)).detail.code, 'ticket-args');
    assert.deepEqual(collision.calls, []);
  });

  test('red pipeline JSON produces nonzero child command exits at every stage', async t => {
    // The ticket CLI is wired by C. This child adapter exercises the exported pipeline
    // with fake callbacks and the same one-line JSON / exit contract, without git or providers.
    const moduleUrl = new URL('../tools/pipeline.mjs', import.meta.url).href;
    const isolate = fileURLToPath(new URL('./_isolate-config.mjs', import.meta.url));
    for (const red of PIPELINE_STAGES) {
      const { root } = await fixture(t);
      const source = `
        import { ticketPipeline, PIPELINE_STAGES } from ${JSON.stringify(moduleUrl)};
        let dirty = false;
        const green = {
          run: { id: 'run-0000', status: 'complete', jobs: [{ status: 'complete' }] },
          inspect: { jobs: [{ status: 'complete' }], files: [] },
          integrate: { status: 'integrated' }, checks: { checksPassed: true, checksErrored: false },
          commit: { status: 'committed', sha: '${sha9001}' }, ship: { status: 'ready' }
        };
        const deps = { now: () => 9001, makeRunId: () => 'run-0000', exec: async (_, args) => ({ code: 0, stdout: args[0] === 'symbolic-ref' ? '9001' : args[0] === 'status' ? (dirty ? ' M output9001\\0' : '') : '${sha9001}' }) };
        for (const stage of PIPELINE_STAGES) deps[stage] = async () => {
          if (stage === 'integrate') dirty = true;
          if (stage === 'commit') dirty = false;
          return stage === ${JSON.stringify(red)} ? { status: 'failed' } : green[stage];
        };
        const result = await ticketPipeline(${JSON.stringify(root)}, { manifestPath: 'manifest9001.json', payloadPath: 'payload9001.json' }, deps);
        process.stdout.write(JSON.stringify(result) + '\\n');
        process.exitCode = result.status === 'complete' ? 0 : 1;
      `;
      const child = spawn(process.execPath, ['--import', isolate, '--input-type=module', '-e', source], { env: { ...process.env } });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(exit, 1, stderr);
      assert.equal(stdout.trim().split('\n').length, 1);
      assert.equal(JSON.parse(stdout).stage, red);
    }
  });
});
