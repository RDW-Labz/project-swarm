// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { shipRun, scoutRun, runManifest, integrateRun } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const job = (extra = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], ...extra });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lessons-batch-c-')));
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
const fakeAgent = (_cmd, _args, options) => spawn(process.execPath, ['-e', "const fs=require('fs');fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));"], options);

// --- L118: gh/git preflight runs before any check ------------------------------------------------

describe('L118: ship refuses at once when gh/git is missing, before any check runs', () => {
  test('a PATH lacking gh refuses before touching any check, readState, or exec beyond the preflight', async t => {
    const root = await fixture(t);
    const markerPath = path.join(root, 'marker.txt');
    const markerCheck = { name: 'marker', argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(markerPath)},'ran')`] };
    const state = await runManifest(root, { version: 1, jobs: [job()], checks: [markerCheck] }, { spawnImpl: fakeAgent });
    await integrateRun(root, state.id, { noChecks: true });
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text' }));
    // The preflight only trusts the real exec (a caller-supplied exec models its own command
    // surface and isn't expected to answer `--version`), so a genuinely missing `gh` is exercised
    // here through a real PATH: a directory with a working `git` shim and no `gh` at all.
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-nogh-'));
    t.after(() => fs.rm(binDir, { recursive: true, force: true }));
    const gitShim = path.join(binDir, 'git');
    await fs.writeFile(gitShim, `#!${process.execPath}\nprocess.exit(0);\n`);
    await fs.chmod(gitShim, 0o755);
    const originalPath = process.env.PATH;
    t.after(() => { process.env.PATH = originalPath; });
    process.env.PATH = binDir;
    let result;
    try {
      result = await shipRun(root, state.id, { payloadPath, requireSections: [], merge: true });
    } finally {
      process.env.PATH = originalPath;
    }
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /gh/);
    await assert.rejects(fs.access(markerPath));
  });
});

// --- L111: --brief accepts any readable path, including outside root -----------------------------

describe('L111: scout --brief accepts any readable path outside root, copied in for provenance', () => {
  const scoutSpawn = (_cmd, _args, options) => spawn(process.execPath, ['-e', `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ picks: [], rejected: [], top: [] }))}}));`], options);

  test('an absolute --brief path outside root is accepted and copied in as brief.md', async t => {
    const root = await fixture(t);
    const briefDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-brief-'));
    t.after(() => fs.rm(briefDir, { recursive: true, force: true }));
    const briefPath = path.join(briefDir, 'brief.md');
    await fs.writeFile(briefPath, '# External brief\nsome research context');
    const result = await scoutRun(root, { model: 'sonnet', brief: briefPath, goal: 'find a library' }, { spawnImpl: scoutSpawn });
    assert.equal(result.status, 'complete');
    const copied = await fs.readFile(path.join(root, '.swarm/scouts', result.id, 'brief.md'), 'utf8');
    assert.equal(copied, '# External brief\nsome research context');
  });

  test('an unreadable --brief path refuses at once, before anything is spawned', async t => {
    const root = await fixture(t);
    let spawnCalled = false;
    const spawnImpl = () => { spawnCalled = true; throw new Error('should never spawn'); };
    await assert.rejects(
      scoutRun(root, { model: 'sonnet', brief: '/nonexistent/does-not-exist/brief.md', goal: 'find a library' }, { spawnImpl }),
      /scout brief not found/
    );
    assert.equal(spawnCalled, false);
  });
});
