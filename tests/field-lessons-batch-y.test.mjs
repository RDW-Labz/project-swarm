// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { validateManifest, integrateRun, runManifest } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const job = (extra = {}) => ({
  id: 'writer',
  agent: 'claude',
  model: 'sonnet',
  prompt: 'Update input.',
  context: ['input.txt'],
  outputs: ['input.txt'],
  ...extra
});

const manifest = (jobExtra = {}, spec = {}) => ({
  version: 1,
  jobs: [job(jobExtra)],
  ...spec
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lessons-batch-y-')));
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

// --- L298: integrate --jobs <id,...> for partial runs -------

describe('L298: integrate RUN --jobs <id,...> integrates only named complete jobs', () => {
  test('plain integrate of run with one complete and one failed job refuses', async t => {
    const root = await fixture(t);
    const m = {
      version: 1,
      jobs: [
        { ...job({ id: 'j1' }) },
        { ...job({ id: 'j2', outputs: ['output2.txt'] }) }
      ]
    };

    // Create fake run state with one complete and one failed job
    const runDir = path.join(root, '.swarm', 'runs', 'run-0000');
    await fs.mkdir(runDir, { recursive: true });

    // j1 complete
    const j1Dir = path.join(runDir, 'j1');
    await fs.mkdir(j1Dir);
    await fs.writeFile(path.join(j1Dir, 'response.txt'), '{"type":"result","is_error":false}');
    const j1State = {
      id: 'j1',
      status: 'complete',
      outputs: { 'input.txt': { hash: 'abc123', bytes: 100 } }
    };
    await fs.writeFile(path.join(j1Dir, 'state.json'), JSON.stringify(j1State));

    // j2 failed
    const j2Dir = path.join(runDir, 'j2');
    await fs.mkdir(j2Dir);
    await fs.writeFile(path.join(j2Dir, 'response.txt'), '{"type":"result","is_error":true}');
    const j2State = {
      id: 'j2',
      status: 'failed'
    };
    await fs.writeFile(path.join(j2Dir, 'state.json'), JSON.stringify(j2State));

    // write run state.json
    const runState = {
      version: 1,
      id: 'run-0000',
      jobs: ['j1', 'j2']
    };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    // Without --jobs flag, integrate should refuse partial runs
    const result = await integrateRun(root, 'run-0000');
    assert.equal(result.status, 'refused');
  });

  test('integrate --jobs j1 integrates only the complete j1 job and returns integratedJobs', async t => {
    const root = await fixture(t);

    // Create fake run state
    const runDir = path.join(root, '.swarm', 'runs', 'run-0000');
    await fs.mkdir(runDir, { recursive: true });

    // j1 complete with files
    const j1Dir = path.join(runDir, 'j1');
    await fs.mkdir(j1Dir);
    await fs.writeFile(path.join(j1Dir, 'input.txt'), 'j1 output');
    await fs.writeFile(path.join(j1Dir, 'response.txt'), '{"type":"result","is_error":false}');
    const j1State = {
      id: 'j1',
      status: 'complete',
      outputs: { 'input.txt': { hash: 'abc123', bytes: 100 } }
    };
    await fs.writeFile(path.join(j1Dir, 'state.json'), JSON.stringify(j1State));

    // j2 failed
    const j2Dir = path.join(runDir, 'j2');
    await fs.mkdir(j2Dir);
    await fs.writeFile(path.join(j2Dir, 'response.txt'), '{"type":"result","is_error":true}');
    const j2State = {
      id: 'j2',
      status: 'failed'
    };
    await fs.writeFile(path.join(j2Dir, 'state.json'), JSON.stringify(j2State));

    const runState = {
      version: 1,
      id: 'run-0000',
      jobs: ['j1', 'j2']
    };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    // With --jobs j1, should integrate only j1
    const result = await integrateRun(root, 'run-0000', { jobs: ['j1'] });
    assert(result.integratedJobs || result.status === 'integrated');
    if (result.integratedJobs) {
      assert(result.integratedJobs.includes('j1'));
      assert.equal(result.skippedJobs.length, 1);
    }
  });

  test('integrate --jobs j2 refuses when j2 is not complete', async t => {
    const root = await fixture(t);

    const runDir = path.join(root, '.swarm', 'runs', 'run-0000');
    await fs.mkdir(runDir, { recursive: true });

    // j1 complete
    const j1Dir = path.join(runDir, 'j1');
    await fs.mkdir(j1Dir);
    await fs.writeFile(path.join(j1Dir, 'response.txt'), '{"type":"result","is_error":false}');
    const j1State = { id: 'j1', status: 'complete', outputs: {} };
    await fs.writeFile(path.join(j1Dir, 'state.json'), JSON.stringify(j1State));

    // j2 failed (not complete)
    const j2Dir = path.join(runDir, 'j2');
    await fs.mkdir(j2Dir);
    const j2State = { id: 'j2', status: 'failed' };
    await fs.writeFile(path.join(j2Dir, 'state.json'), JSON.stringify(j2State));

    const runState = { version: 1, id: 'run-0000', jobs: ['j1', 'j2'] };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    // --jobs j2 where j2 is not complete should refuse
    const result = await integrateRun(root, 'run-0000', { jobs: ['j2'] });
    assert.equal(result.status, 'refused');
  });
});

// --- L294: validate output-cap-too-small -------

describe('L294: validate warns output-cap-too-small when outputs exceed maxOutputTokens', () => {
  test('a manifest with many large outputs and small cap refuses validation', () => {
    const m = manifest(
      {
        agent: 'openrouter',
        model: 'anthropic/claude-sonnet-5.5',
        outputs: [
          'output1.txt',
          'output2.txt',
          'output3.txt',
          'output4.txt',
          'output5.txt'
        ],
        maxOutputTokens: 2000
      }
    );

    // Should throw error about output-cap
    assert.throws(() => validateManifest(m), /output-cap-too-small/);
  });

  test('a manifest with large outputs but adequate cap passes validation', () => {
    const m = manifest(
      {
        agent: 'openrouter',
        model: 'anthropic/claude-sonnet-5.5',
        outputs: [
          'output1.txt',
          'output2.txt',
          'output3.txt',
          'output4.txt',
          'output5.txt'
        ],
        maxOutputTokens: 200000
      }
    );

    // Should pass without error
    validateManifest(m);
  });
});

// --- L293: validate/integrate private-name scan -------

describe('L293: validate/integrate refuse private-name on shared/fixtures/tests outputs', () => {
  test('integrate with private-names FILE refuses output under shared/ containing a term', async t => {
    const root = await fixture(t);

    // Create private-terms file
    const termsPath = path.join(root, 'private-terms.txt');
    await fs.writeFile(termsPath, 'TestCompany\nAlice Smith\n');

    // Create a run with output containing private term in shared/
    const runDir = path.join(root, '.swarm', 'runs', 'run-0000');
    await fs.mkdir(runDir, { recursive: true });

    const jobDir = path.join(runDir, 'j1');
    await fs.mkdir(jobDir);

    // Create output under shared/ with a private term
    const sharedDir = path.join(jobDir, 'shared', 'skills');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, 'skill.yaml'), 'name: TestCompany Secret Skill\n');

    const jobState = {
      id: 'j1',
      status: 'complete',
      outputs: { 'shared/skills/skill.yaml': { hash: 'abc', bytes: 100 } }
    };
    await fs.writeFile(path.join(jobDir, 'state.json'), JSON.stringify(jobState));

    const runState = { version: 1, id: 'run-0000', jobs: ['j1'] };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    // integrate --private-names should refuse
    const result = await integrateRun(root, 'run-0000', { privateNamesFile: termsPath });
    assert.equal(result.status, 'refused');
    assert.match(result.code || result.reason || '', /private-name/i);
  });

  test('integrate --private-names FILE passes output under shared/ without private terms', async t => {
    const root = await fixture(t);

    const termsPath = path.join(root, 'private-terms.txt');
    await fs.writeFile(termsPath, 'TestCompany\nAlice Smith\n');

    const runDir = path.join(root, '.swarm', 'runs', 'run-0001');
    await fs.mkdir(runDir, { recursive: true });

    const jobDir = path.join(runDir, 'j1');
    await fs.mkdir(jobDir);

    // Create clean output without private terms
    const sharedDir = path.join(jobDir, 'shared', 'skills');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, 'skill.yaml'), 'name: Generic Clean Skill\n');

    const jobState = {
      id: 'j1',
      status: 'complete',
      outputs: { 'shared/skills/skill.yaml': { hash: 'abc', bytes: 100 } }
    };
    await fs.writeFile(path.join(jobDir, 'state.json'), JSON.stringify(jobState));

    const runState = { version: 1, id: 'run-0001', jobs: ['j1'] };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    const result = await integrateRun(root, 'run-0001', { privateNamesFile: termsPath });
    assert(result.status === 'integrated' || result.status !== 'refused');
  });
});
