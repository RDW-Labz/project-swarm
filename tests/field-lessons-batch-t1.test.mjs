// SPDX-License-Identifier: Apache-2.0
// Swarm batch T job t1: field lessons 248, 252, 253, 254, 255(2)(3) (see .swarm-manifests/contract-t.md).
// #248: a claude job ending `api_error` (5xx/429) is retried once, over its kept workspace, with a
// continuation note; --salvage accepts a `failed` run whose failure is api_error.
// #252: on any non-`result` exit, costUsd is estimated from provider.jsonl (tools/rates.mjs) when
// no reported cost exists, marked costSource: estimated-from-transcript.
// #253: `run` runs the manifest's checks on the committed base first (cached by base sha), and
// refuses to dispatch onto a red base without --accept-red-base --reason; integrate labels a
// failing check's `origin` pre-existing/new by re-running it on the base.
// #254: ship holds (status held-red-check) on a pre-existing check unless --accept-pre-existing.
// #255(2)/(3): validate warns shell-python-no-setup; inspect warns interpreter-outside-workspace.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  runManifest, integrateRun, inspectRun, inspectResults, validateProject, runBaseChecks,
  checkPathMissingWarnings, shellPythonNoSetupWarning, parseShipFlags,
} from '../tools/swarm.mjs';
import { ship } from '../tools/ship.mjs';
import { git } from '../tools/codex-adapter.mjs';
import { MODEL_RATES, estimateCostFromTranscript } from '../tools/rates.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-t1-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function gitFixture(t) {
  const root = await fixture(t);
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  return root;
}
async function commit(root, message) {
  await git(root, ['add', '.']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', message]);
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;

// --- #248: a claude job ending api_error is retried once, over its kept workspace ------------

describe('#248: an api_error (5xx/429) result is retried once with a continuation note', () => {
  test('(a) first attempt api_error 503, second attempt succeeds: one retry, status complete', async t => {
    const root = await fixture(t);
    let calls = 0;
    const spawnImpl = (_command, _args, options) => {
      calls++;
      const script = calls === 1
        ? `console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,api_error_status:503}));`
        : `fs.writeFileSync('input.txt','updated');${done}`;
      return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
    };
    const state = await runManifest(root, manifest(), { spawnImpl });
    assert.equal(calls, 2);
    assert.equal(state.jobs[0].status, 'complete');
    assert.equal(state.jobs[0].retries, 1);
    assert.equal(state.jobs[0].retryReason, 'api_error 503');
  });

  test('(b) both attempts fail (second not api_error): failed, retryReason still names the first api_error, and --salvage accepts its kept workspace', async t => {
    const root = await fixture(t);
    let calls = 0;
    const spawnImpl = (_command, _args, options) => {
      calls++;
      const script = calls === 1
        ? `fs.writeFileSync('input.txt','partial');console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,api_error_status:503}));`
        : `process.exit(7);`;
      return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
    };
    const state = await runManifest(root, manifest(), { spawnImpl });
    assert.equal(calls, 2);
    assert.equal(state.jobs[0].status, 'failed');
    assert.equal(state.jobs[0].retries, 1);
    assert.equal(state.jobs[0].retryReason, 'api_error 503');
    assert.ok(state.jobs[0].keptWorkspace);
    const result = await integrateRun(root, state.id, { salvage: true });
    assert.deepEqual(result.files, ['input.txt']);
    assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'partial');
  });

  test('(c) a non-retryable status (404) is never retried', async t => {
    const root = await fixture(t);
    let calls = 0;
    const spawnImpl = (_command, _args, options) => {
      calls++;
      return spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\nconsole.log(JSON.stringify({type:'result',subtype:'error',is_error:true,api_error_status:404}));`], options);
    };
    const state = await runManifest(root, manifest(), { spawnImpl });
    assert.equal(calls, 1);
    assert.equal(state.jobs[0].retries, undefined);
    assert.equal(state.jobs[0].status, 'failed');
  });
});

// --- #252: costUsd is estimated from the transcript on a non-result exit ----------------------

describe('#252: costUsd is estimated from provider.jsonl when no CLI result event ever reports one', () => {
  test('(a) estimateCostFromTranscript sums usage over unique assistant message ids and estimates output tokens from content size when the stream count is partial', () => {
    const line = id => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 100, output_tokens: 1 }, content: [{ type: 'text', text: 'x'.repeat(100) }] } });
    // Same message id twice (a resumed stream) must not be double-counted.
    const jsonl = [line('msg-1'), line('msg-1')].join('\n');
    const estimate = estimateCostFromTranscript(jsonl, 'claude-sonnet-5-20260101');
    assert.equal(estimate.outputEstimated, true);
    assert.equal(estimate.usage.input_tokens, 100);
    assert.equal(estimate.usage.output_tokens, Math.round(100 * 1.72));
    const expected = (100 / 1e6) * MODEL_RATES.sonnet.in + (Math.round(100 * 1.72) / 1e6) * MODEL_RATES.sonnet.out;
    assert.ok(Math.abs(estimate.costUsd - expected) < 1e-9);
  });

  test('(b) an unknown model reports costUsd null (never a made-up rate)', () => {
    const jsonl = JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 10 } } });
    assert.equal(estimateCostFromTranscript(jsonl, 'some-future-model').costUsd, null);
  });

  test('(c) a job cancelled mid-stream (no result event) reports an estimated cost, not costNotReported', async t => {
    const root = await fixture(t);
    const script = `console.log(JSON.stringify({type:'assistant',message:{id:'m1',usage:{input_tokens:1000,output_tokens:5},content:[{type:'text',text:${JSON.stringify('x'.repeat(1000))}}]}}));setInterval(()=>{},1000);`;
    const pending = runManifest(root, manifest(), { id: 't1-cancel-252', spawnImpl: fake(script) });
    for (let i = 0; i < 200; i++) {
      const text = await fs.readFile(path.join(root, '.swarm/runs/t1-cancel-252/writer/provider.jsonl'), 'utf8').catch(() => '');
      if (text.includes('"type":"assistant"')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const { cancelRun } = await import('../tools/swarm.mjs');
    await cancelRun(root, 't1-cancel-252');
    const state = await pending;
    assert.equal(state.jobs[0].status, 'cancelled');
    assert.ok(state.jobs[0].costUsd > 0);
    assert.equal(state.jobs[0].costSource, 'estimated-from-transcript');
    const results = await inspectResults(root, state.id);
    assert.equal(results.jobs[0].costSource, 'estimated-from-transcript');
  });

  test('(d) an unrecognized model with a real transcript warns cost-rate-unknown instead of silence', async t => {
    const root = await fixture(t);
    const script = `console.log(JSON.stringify({type:'assistant',message:{id:'m1',usage:{input_tokens:10,output_tokens:5}}}));setInterval(()=>{},1000);`;
    const pending = runManifest(root, manifest([job({ model: 'some-future-model' })]), { id: 't1-cancel-252b', spawnImpl: fake(script) });
    for (let i = 0; i < 200; i++) {
      const text = await fs.readFile(path.join(root, '.swarm/runs/t1-cancel-252b/writer/provider.jsonl'), 'utf8').catch(() => '');
      if (text.includes('"type":"assistant"')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const { cancelRun } = await import('../tools/swarm.mjs');
    await cancelRun(root, 't1-cancel-252b');
    const state = await pending;
    assert.equal(state.jobs[0].costUsd, null);
    const results = await inspectResults(root, state.id);
    assert.ok(results.warnings.includes('cost-rate-unknown: some-future-model'));
  });
});

// --- #253: run checks the committed base first; integrate labels a failure's origin -----------

describe('#253: run refuses a red base without --accept-red-base --reason; the base-check is cached by sha', () => {
  const passCheck = { name: 'ok', argv: [process.execPath, '-e', 'process.exit(0)'] };
  const failCheck = { name: 'broken', argv: [process.execPath, '-e', 'process.exit(1)'] };

  test('(a) runBaseChecks caches its verdict by base sha: a second call at the same sha never re-spawns', async t => {
    const root = await fixture(t);
    let spawns = 0;
    const countingSpawn = (...args) => { spawns++; return spawn(...args); };
    const first = await runBaseChecks(root, manifest([], { checks: [passCheck] }), { spawnImpl: countingSpawn, baseSha: 'fixed-sha-1' });
    assert.equal(first.status, 'green');
    assert.equal(spawns, 1);
    const second = await runBaseChecks(root, manifest([], { checks: [passCheck] }), { spawnImpl: countingSpawn, baseSha: 'fixed-sha-1' });
    assert.equal(second.status, 'green');
    assert.equal(spawns, 1, 'a repeat run at the same base sha must not re-spawn the check');
  });

  test('(b) run refuses to dispatch onto a red base without --accept-red-base', async t => {
    const root = await fixture(t);
    await assert.rejects(
      runManifest(root, manifest([job()], { checks: [failCheck] }), { spawnImpl: fake(done), checkBase: true, baseChecks: { spawnImpl: spawn, baseSha: 'fixed-sha-2' } }),
      /Refusing: base is red/,
    );
  });

  test('(c) --accept-red-base without --reason refuses', async t => {
    const root = await fixture(t);
    await assert.rejects(
      runManifest(root, manifest([job()], { checks: [failCheck] }), { spawnImpl: fake(done), checkBase: true, acceptRedBase: true, baseChecks: { spawnImpl: spawn, baseSha: 'fixed-sha-3' } }),
      /--accept-red-base requires --reason/,
    );
  });

  test('(d) --accept-red-base with --reason lets the run through onto a red base', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()], { checks: [failCheck] }), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');${done}`), checkBase: true, acceptRedBase: true, reason: 'known flaky infra', baseChecks: { spawnImpl: spawn, baseSha: 'fixed-sha-4' } });
    assert.equal(state.jobs[0].status, 'complete');
  });

  test('(e) a green base runs normally with no base-check option at all (default off, unchanged behavior)', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job()], { checks: [failCheck] }), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');${done}`) });
    assert.equal(state.jobs[0].status, 'complete');
  });
});

describe('#253: integrate labels a failing check origin pre-existing (fails on base too) or new (base passes)', () => {
  const flagCheck = { name: 'flagcheck', argv: [process.execPath, '-e', "process.exit(require('fs').readFileSync('flag.txt','utf8').trim()==='fail'?1:0)"] };

  test('(f) the base already fails the same way: origin pre-existing', async t => {
    const root = await gitFixture(t);
    await fs.writeFile(path.join(root, 'flag.txt'), 'fail');
    await commit(root, 'base already broken');
    const state = await runManifest(root, manifest([job()], { checks: [flagCheck] }), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');${done}`) });
    const result = await integrateRun(root, state.id);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].origin, 'pre-existing');
  });

  test('(g) the base passes and this integration is what breaks it: origin new', async t => {
    const root = await gitFixture(t);
    await fs.writeFile(path.join(root, 'flag.txt'), 'ok');
    await commit(root, 'base green');
    const breaker = job({ context: ['flag.txt'], outputs: ['flag.txt'] });
    const state = await runManifest(root, manifest([breaker], { checks: [flagCheck] }), { spawnImpl: fake(`fs.writeFileSync('flag.txt','fail');${done}`) });
    const result = await integrateRun(root, state.id);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].origin, 'new');
  });
});

// --- #254: ship holds on a pre-existing check unless --accept-pre-existing --------------------

describe('#254: the ship command holds (status held-red-check) on a pre-existing check unless --accept-pre-existing', () => {
  test('(a) parseShipFlags recognizes --accept-pre-existing', () => {
    const flags = parseShipFlags(['--pr', 'payload.json', '--accept-pre-existing']);
    assert.equal(flags.acceptPreExisting, true);
  });
  test('(b) --accept-pre-existing is false by default', () => {
    const flags = parseShipFlags(['--pr', 'payload.json']);
    assert.equal(flags.acceptPreExisting ?? false, false);
  });

  async function writePayload(root, payload) {
    const payloadPath = path.join(root, 'payload.json');
    await fs.writeFile(payloadPath, JSON.stringify(payload));
    return payloadPath;
  }
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr = 'boom') => ({ code: 1, stdout: '', stderr });
  // Same shape as tests/field-lessons-batch-j.test.mjs's own fakeShipExec.
  function fakeShipExec(handlers = {}) {
    return async (file, args) => {
      for (const handler of handlers.custom ?? []) {
        const result = handler(file, args);
        if (result !== undefined) return result;
      }
      if (file === 'git' && args[0] === 'remote') return ok('https://github.com/acme/widgets.git\n');
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok(`${handlers.branch ?? 'feature-branch'}\n`);
      if (file === 'git' && args[0] === 'rev-parse') return ok(`${handlers.sha ?? 'sha-fixture'}\n`);
      if (file === 'git' && args[0] === 'status') return ok('');
      if (file === 'git' && args[0] === 'merge-base') return handlers.baseSha ? ok(`${handlers.baseSha}\n`) : fail('no base');
      if (file === 'git' && args[0] === 'worktree') return ok('');
      if (file === 'git' && args[0] === 'push') return ok('');
      if (file === 'gh' && args[0] === 'api' && args[1]?.includes('/pulls?head=')) return ok('[]');
      if (file === 'gh' && args[0] === 'api' && args[1]?.endsWith('/pulls')) return ok(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' }));
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefOid: handlers.sha ?? 'sha-fixture', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      if (file === 'gh' && args[0] === 'run') return ok('');
      if (file === 'fake-checker') return fail('still broken');
      return ok('');
    };
  }

  test('(c) --accept-pre-existing false (the ship command\'s own default): a pre-existing check holds, naming it, never merges', async t => {
    const root = await fixture(t);
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      acceptPreExisting: false,
      runChecks: async () => [{ name: 'format-check', status: 'failed', exitCode: 1, tail: 'still broken' }],
      checkArgvs: [['fake-checker']],
      integratedFiles: [],
      merge: false,
      exec: fakeShipExec({ baseSha: 'base-sha-1' }), sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'held-red-check', JSON.stringify(result));
    assert.match(result.reason, /held-red-check/);
    assert.equal(result.checks[0].status, 'pre-existing');
  });

  test('(d) --accept-pre-existing true lets a pre-existing check through, as ship() always has by default', async t => {
    const root = await fixture(t);
    const payloadPath = await writePayload(root, { title: 't', head: 'feature', base: 'main', body: 'body text' });
    const result = await ship({
      root, repo: 'acme/widgets', payloadPath,
      acceptPreExisting: true,
      runChecks: async () => [{ name: 'format-check', status: 'failed', exitCode: 1, tail: 'still broken' }],
      checkArgvs: [['fake-checker']],
      integratedFiles: [],
      merge: false,
      exec: fakeShipExec({ baseSha: 'base-sha-1' }), sleep: async () => {}, now: () => 0,
    });
    assert.equal(result.status, 'ready', JSON.stringify(result));
  });
});

// --- #254: validate's check-path-missing warning -----------------------------------------------

describe('#254: validate warns check-path-missing when a check\'s own env PATH= omits a program the orchestrator PATH has', () => {
  // Field lesson #261: this case used to warn about `gh` for a check whose argv never even runs
  // it (an over-broad warning against every program on the orchestrator's PATH); it now asserts
  // the #261 behaviour instead: a check whose argv actually runs `gh` with a PATH lacking it still
  // warns, but a check that never runs `gh` at all never does.
  test('(a) a check env PATH missing gh, with gh present on the orchestrator PATH: warns only when the check\'s own argv runs gh', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-t1-path-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const narrowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-t1-narrow-'));
    t.after(() => fs.rm(narrowDir, { recursive: true, force: true }));
    const invokesGh = { name: 'ci-check', argv: ['env', `PATH=${narrowDir}`, 'gh', 'pr', 'view'] };
    const warnings = await checkPathMissingWarnings({ checks: [invokesGh] }, { env: { PATH: dir } });
    assert.ok(warnings.some(w => w.message === 'check-path-missing: ci-check: gh'));

    const neverRunsGh = { name: 'ci-check', argv: ['env', `PATH=${narrowDir}`, 'true'] };
    const noGhWarnings = await checkPathMissingWarnings({ checks: [neverRunsGh] }, { env: { PATH: dir } });
    assert.ok(!noGhWarnings.some(w => w.prog === 'gh'), JSON.stringify(noGhWarnings));
  });

  test('(b) the check\'s own PATH already includes the program: no warning', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-t1-path2-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const check = { name: 'ci-check', argv: ['env', `PATH=${dir}`, 'true'] };
    const warnings = await checkPathMissingWarnings({ checks: [check] }, { env: { PATH: dir } });
    assert.deepEqual(warnings.filter(w => w.code === 'check-path-missing'), []);
  });
});

// --- #255(2): validate warns shell-python-no-setup ----------------------------------------------

describe('#255(2): validate warns shell-python-no-setup for a shell job whose checks run python/uv/pytest with no setup', () => {
  test('(a) a shell job, a pytest check, no setup: warns', () => {
    const shellJob = job({ shell: true });
    const warning = shellPythonNoSetupWarning(shellJob, { checks: [{ name: 'pytest', argv: ['pytest', 'tests/'] }] });
    assert.deepEqual(warning, { code: 'shell-python-no-setup', jobId: 'writer', message: 'shell-python-no-setup: writer' });
  });

  test('(b) the same job with a setup step: no warning', () => {
    const shellJob = job({ shell: true, setup: [['uv', 'sync', '--offline', '--locked']] });
    assert.equal(shellPythonNoSetupWarning(shellJob, { checks: [{ name: 'pytest', argv: ['pytest', 'tests/'] }] }), null);
  });

  test('(c) a non-shell job is never warned, even with a python check', () => {
    assert.equal(shellPythonNoSetupWarning(job(), { checks: [{ name: 'pytest', argv: ['pytest', 'tests/'] }] }), null);
  });

  test('(d) validateProject surfaces the warning end to end', async t => {
    const root = await fixture(t);
    const shellManifest = manifest([job({ shell: true, prompt: 'Run pytest tests/ and fix anything red.' })], { checks: [] });
    const result = await validateProject(root, shellManifest);
    assert.ok(result.warnings.some(w => w.code === 'shell-python-no-setup' && w.jobId === 'writer'));
  });
});

// --- #255(3): inspect warns interpreter-outside-workspace ---------------------------------------

describe('#255(3): inspect warns interpreter-outside-workspace when a job\'s own reported interpreter names a path outside its workspace', () => {
  test('(a) an interpreter path under some other checkout\'s .venv: warns', async t => {
    const root = await fixture(t);
    const foreignInterpreter = '/private/tmp/some-other-checkout/.venv/bin/python3';
    const resultLine = JSON.stringify({ interpreter: foreignInterpreter, notes: ['ran pytest'] });
    const state = await runManifest(root, manifest(), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(resultLine)}}));`) });
    const results = await inspectResults(root, state.id);
    assert.ok(results.warnings.includes(`interpreter-outside-workspace: writer: ${foreignInterpreter}`));
  });

  test('(b) an interpreter path inside the job\'s own workspace: no warning', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest(), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');const interpreter=process.cwd()+'/.venv/bin/python3';console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({interpreter,notes:['ran pytest']})}));`) });
    const results = await inspectResults(root, state.id);
    assert.equal(results.warnings.some(w => w.startsWith('interpreter-outside-workspace')), false);
  });
});
