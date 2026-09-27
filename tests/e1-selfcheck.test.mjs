// SPDX-License-Identifier: Apache-2.0
// E1 candidate (experimental, off by default): see docs/e1/contract.md.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runManifest, validateManifest, inspectRun, withSelfCheckTree } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const job = (extra = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt', 'marker.txt'], ...extra });
const check = (extra = {}) => ({ name: 'test', argv: [process.execPath, '-e', "process.exit(require('fs').readFileSync('marker.txt','utf8').trim()==='good'?0:1)"], timeoutMs: 5000, ...extra });
const manifest = (jobExtra = {}, spec = {}) => ({ version: 1, jobs: [job(jobExtra)], checks: [check()], ...spec });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-e1-selfcheck-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  return root;
}

// A fake claude worker: writes marker.txt/input.txt on a fresh call, and — only when resumed via
// `--resume` — reads and captures the full stdin message before writing the "fixed" marker, so a
// test can assert the resume message carries the failing check's tail.
function selfCheckSpawn({ freshMarker, resumeMarker, freshCost, resumeCost, onCall } = {}) {
  let calls = 0;
  return (cmd, args, options) => {
    onCall?.(cmd, args);
    if (cmd !== 'claude') return spawn(cmd, args, options); // real check process, unmocked
    calls++;
    const resumed = args.includes('--resume');
    const marker = resumed ? resumeMarker : freshMarker;
    const cost = resumed ? resumeCost : freshCost;
    const script = resumed
      ? "const fs=require('fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{" +
        `fs.writeFileSync('resume-message.txt', input);fs.writeFileSync('marker.txt', ${JSON.stringify(marker)});fs.writeFileSync('input.txt','updated-again');` +
        `console.log(JSON.stringify({type:'system',subtype:'init',session_id:'sess-1'}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',total_cost_usd:${cost}}));});`
      : `const fs=require('fs');fs.writeFileSync('input.txt','updated');fs.writeFileSync('marker.txt', ${JSON.stringify(marker)});` +
        `console.log(JSON.stringify({type:'system',subtype:'init',session_id:'sess-1'}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',total_cost_usd:${cost}}));`;
    return spawn(process.execPath, ['-e', script], options);
  };
}

describe('E1 selfCheck (experimental, off by default)', () => {
  test('validate accepts and refuses the documented selfCheck shapes', () => {
    const base = manifest();
    assert.doesNotThrow(() => validateManifest({ ...base, selfCheck: {} }));
    assert.doesNotThrow(() => validateManifest({ ...base, selfCheck: { maxRetries: 2, checks: ['test'] } }));
    assert.doesNotThrow(() => validateManifest({ ...base, jobs: [job({ selfCheck: false })] }));
    assert.doesNotThrow(() => validateManifest({ ...base, jobs: [job({ selfCheck: { maxRetries: 0 } })] }));
    assert.throws(() => validateManifest({ ...base, selfCheck: false }), /Invalid selfCheck/);
    assert.throws(() => validateManifest({ ...base, selfCheck: { bogus: 1 } }), /Unknown selfCheck field/);
    assert.throws(() => validateManifest({ ...base, selfCheck: { maxRetries: 3 } }), /maxRetries must be 0-2/);
    assert.throws(() => validateManifest({ ...base, selfCheck: { maxRetries: -1 } }), /maxRetries must be 0-2/);
    assert.throws(() => validateManifest({ ...base, selfCheck: { checks: ['nope'] } }), /unknown check: nope/);
  });

  test('absent selfCheck leaves state.json and spawn calls unchanged from 1.18.0', async t => {
    const root = await fixture(t);
    const calls = [];
    const spawnImpl = selfCheckSpawn({ freshMarker: 'good', freshCost: 1, onCall: (cmd, args) => calls.push({ cmd, args }) });
    const m = { version: 1, jobs: [job()] }; // no `checks`, no `selfCheck`
    const state = await runManifest(root, m, { spawnImpl });
    assert.equal(state.jobs[0].status, 'complete');
    assert.equal(Object.hasOwn(state.jobs[0], 'selfCheck'), false);
    assert.equal(Object.hasOwn(state.jobs[0], 'phase'), false);
    assert.equal(calls.length, 1, 'only the worker itself is spawned; no self-check tree, no extra process');
    await assert.rejects(fs.stat(path.join(root, '.swarm/selfcheck')));
  });

  test('a check that fails then passes triggers one resume with the failing tail, then passed=true, retries=1, costs summed', async t => {
    const root = await fixture(t);
    const spawnImpl = selfCheckSpawn({ freshMarker: 'bad', resumeMarker: 'good', freshCost: 1, resumeCost: 2 });
    const m = manifest({}, { selfCheck: { maxRetries: 1 } });
    const state = await runManifest(root, m, { spawnImpl });
    const record = state.jobs[0];
    assert.equal(record.status, 'complete');
    assert.equal(record.selfCheck.passed, true);
    assert.equal(record.selfCheck.retries, 1);
    assert.equal(record.selfCheck.retryCostUsd, 2);
    assert.equal(record.costUsd, 3, 'the retry cost is added to the job\'s own costUsd');
    assert.deepEqual(record.selfCheck.checks.map(c => c.name), ['test']);
    assert.equal(record.selfCheck.checks[0].status, 'passed');
    const resumeMessage = await fs.readFile(path.join(root, '.swarm/workspaces', state.id, 'writer', 'resume-message.txt'), 'utf8');
    assert.match(resumeMessage, /Self-check failed: test/);
    assert.match(resumeMessage, /Fix the cause in your outputs\. Do not delete, skip or loosen tests\. Files outside outputs are discarded\./);
  });

  test('still red after the last retry leaves the job complete, passed=false, with an inspect warning', async t => {
    const root = await fixture(t);
    const spawnImpl = selfCheckSpawn({ freshMarker: 'bad', freshCost: 1 });
    const m = manifest({}, { selfCheck: { maxRetries: 0 } });
    const state = await runManifest(root, m, { spawnImpl });
    const record = state.jobs[0];
    assert.equal(record.status, 'complete', 'integrate remains the actual gate');
    assert.equal(record.selfCheck.passed, false);
    assert.equal(record.selfCheck.retries, 0);
    const report = await inspectRun(root, state.id);
    assert.ok(report.warnings.includes('self-check red: writer: test'));
  });

  test('withSelfCheckTree always removes the check tree, even when the callback throws', async t => {
    const root = await fixture(t);
    const baseCommit = (await git(root, ['rev-parse', 'HEAD'])).trim();
    await assert.rejects(withSelfCheckTree(root, 'run-throw', 'job-throw', baseCommit, async () => { throw new Error('boom'); }), /boom/);
    const worktrees = await git(root, ['worktree', 'list']);
    assert.ok(!worktrees.includes('selfcheck'), 'the check tree worktree was removed despite the throw');
    await assert.rejects(fs.stat(path.join(root, '.swarm/selfcheck/run-throw/job-throw')));
  });

  test('node_modules is symlinked into the check tree, not copied', async t => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'marker.js'), 'module.exports = 1;');
    const spawnImpl = selfCheckSpawn({ freshMarker: 'good', freshCost: 1 });
    const m = {
      version: 1,
      jobs: [job()],
      checks: [{ name: 'nm-symlink', argv: [process.execPath, '-e', "process.exit(require('fs').lstatSync('node_modules').isSymbolicLink() ? 0 : 1)"], timeoutMs: 5000 }],
      selfCheck: { maxRetries: 0 },
    };
    const state = await runManifest(root, m, { spawnImpl });
    const record = state.jobs[0];
    assert.equal(record.selfCheck.passed, true, 'node_modules was a symlink in the check tree, not a copy');
  });
});
