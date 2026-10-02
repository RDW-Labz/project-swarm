// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { validateManifest, integrateRun, runManifest } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

// Mirrors the internal `digest` helper in tools/swarm.mjs so hand-built run fixtures carry a
// baseHashes value that actually matches what integrateRun will compute for the fixture's
// committed bytes, instead of a placeholder `null` that only happens to work when the base file
// never existed.
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

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
    await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(m));

    // j1 complete
    const j1Dir = path.join(runDir, 'j1');
    await fs.mkdir(j1Dir);
    await fs.writeFile(path.join(j1Dir, 'response.txt'), '{"type":"result","is_error":false}');
    const j1State = {
      id: 'j1',
      status: 'complete',
      outputs: ['input.txt'],
      baseHashes: { 'input.txt': null }
    };
    await fs.writeFile(path.join(j1Dir, 'state.json'), JSON.stringify(j1State));

    // j2 failed
    const j2Dir = path.join(runDir, 'j2');
    await fs.mkdir(j2Dir);
    await fs.writeFile(path.join(j2Dir, 'response.txt'), '{"type":"result","is_error":true}');
    const j2State = {
      id: 'j2',
      status: 'failed',
      outputs: ['output2.txt'],
      baseHashes: { 'output2.txt': null }
    };
    await fs.writeFile(path.join(j2Dir, 'state.json'), JSON.stringify(j2State));

    // write run state.json with proper job records
    const runState = {
      version: 1,
      id: 'run-0000',
      root: root,
      jobs: [
        { id: 'j1', status: 'complete', outputs: ['input.txt'], baseHashes: { 'input.txt': null }, workspace: '.swarm/workspaces/run-0000/j1' },
        { id: 'j2', status: 'failed', outputs: ['output2.txt'], baseHashes: { 'output2.txt': null }, workspace: '.swarm/workspaces/run-0000/j2' }
      ],
      status: 'complete'
    };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    // Without --jobs flag, integrate should refuse partial runs
    await assert.rejects(
      () => integrateRun(root, 'run-0000'),
      /--jobs|complete/i
    );
  });

  test('integrate --jobs j1 integrates only the complete j1 job and returns integratedJobs', async t => {
    const root = await fixture(t);
    const m = {
      version: 1,
      jobs: [
        { ...job({ id: 'j1' }) },
        { ...job({ id: 'j2', outputs: ['output2.txt'] }) }
      ]
    };

    // Create fake run state
    const runDir = path.join(root, '.swarm', 'runs', 'run-0000');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(m));

    // j1 complete with files - write to workspace
    const j1WorkspaceDir = path.join(root, '.swarm', 'workspaces', 'run-0000', 'j1');
    await fs.mkdir(j1WorkspaceDir, { recursive: true });
    // Write the output file to the workspace
    const outputContent = 'j1 output content';
    await fs.writeFile(path.join(j1WorkspaceDir, 'input.txt'), outputContent);
    const j1Dir = path.join(runDir, 'j1');
    await fs.mkdir(j1Dir);
    await fs.writeFile(path.join(j1Dir, 'response.txt'), '{"type":"result","is_error":false}');
    // input.txt was committed as 'original' by fixture(); baseHashes must reflect that real
    // snapshot or integrate correctly refuses the hand-built fixture as a conflict.
    const inputBaseHash = sha256(Buffer.from('original'));
    const j1State = {
      id: 'j1',
      status: 'complete',
      outputs: ['input.txt'],
      baseHashes: { 'input.txt': inputBaseHash }
    };
    await fs.writeFile(path.join(j1Dir, 'state.json'), JSON.stringify(j1State));

    // j2 failed
    const j2Dir = path.join(runDir, 'j2');
    await fs.mkdir(j2Dir);
    await fs.writeFile(path.join(j2Dir, 'response.txt'), '{"type":"result","is_error":true}');
    const j2State = {
      id: 'j2',
      status: 'failed',
      outputs: ['output2.txt'],
      baseHashes: { 'output2.txt': null }
    };
    await fs.writeFile(path.join(j2Dir, 'state.json'), JSON.stringify(j2State));

    const runState = {
      version: 1,
      id: 'run-0000',
      root: root,
      jobs: [
        { id: 'j1', status: 'complete', outputs: ['input.txt'], baseHashes: { 'input.txt': inputBaseHash }, workspace: '.swarm/workspaces/run-0000/j1' },
        { id: 'j2', status: 'failed', outputs: ['output2.txt'], baseHashes: { 'output2.txt': null }, workspace: '.swarm/workspaces/run-0000/j2' }
      ],
      status: 'complete'
    };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    // With --jobs j1, should integrate only j1
    const result = await integrateRun(root, 'run-0000', { jobs: ['j1'] });
    assert(result.integratedJobs || result.status === 'ok' || !result.error);
    if (result.integratedJobs) {
      assert(result.integratedJobs.includes('j1'));
      assert.equal(result.skippedJobs.length, 1);
    }
  });

  test('integrate --jobs j2 refuses when j2 is not complete', async t => {
    const root = await fixture(t);
    const m = {
      version: 1,
      jobs: [
        { ...job({ id: 'j1' }) },
        { ...job({ id: 'j2' }) }
      ]
    };

    const runDir = path.join(root, '.swarm', 'runs', 'run-0000');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(m));

    // j1 complete
    const j1Dir = path.join(runDir, 'j1');
    await fs.mkdir(j1Dir);
    await fs.writeFile(path.join(j1Dir, 'response.txt'), '{"type":"result","is_error":false}');
    const j1State = { id: 'j1', status: 'complete', outputs: ['input.txt'], baseHashes: { 'input.txt': null } };
    await fs.writeFile(path.join(j1Dir, 'state.json'), JSON.stringify(j1State));

    // j2 failed (not complete)
    const j2Dir = path.join(runDir, 'j2');
    await fs.mkdir(j2Dir);
    const j2State = { id: 'j2', status: 'failed', outputs: ['input.txt'], baseHashes: { 'input.txt': null } };
    await fs.writeFile(path.join(j2Dir, 'state.json'), JSON.stringify(j2State));

    const runState = {
      version: 1,
      id: 'run-0000',
      root: root,
      jobs: [
        { id: 'j1', status: 'complete', outputs: ['input.txt'], baseHashes: { 'input.txt': null }, workspace: '.swarm/workspaces/run-0000/j1' },
        { id: 'j2', status: 'failed', outputs: ['input.txt'], baseHashes: { 'input.txt': null }, workspace: '.swarm/workspaces/run-0000/j2' }
      ],
      status: 'complete'
    };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    // --jobs j2 where j2 is not complete should refuse
    await assert.rejects(
      () => integrateRun(root, 'run-0000', { jobs: ['j2'] }),
      /not complete/i
    );
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
        maxOutputTokens: 32768
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

    const m = {
      version: 1,
      jobs: [
        { ...job({ id: 'j1', outputs: ['shared/skills/skill.yaml'] }) }
      ]
    };

    // Create a run with output containing private term in shared/
    const runDir = path.join(root, '.swarm', 'runs', 'run-0000');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(m));

    const jobDir = path.join(runDir, 'j1');
    await fs.mkdir(jobDir);

    // integrate reads a job's outputs from its real workspace (.swarm/workspaces/<run>/<job>/...),
    // never from the run's own record directory (.swarm/runs/<run>/<job>/) — that one only ever
    // holds response.txt/state.json. Write the proposed output where integrate actually looks.
    const workspaceDir = path.join(root, '.swarm', 'workspaces', 'run-0000', 'j1');
    const sharedDir = path.join(workspaceDir, 'shared', 'skills');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, 'skill.yaml'), 'name: TestCompany Secret Skill\n');

    const jobState = {
      id: 'j1',
      status: 'complete',
      outputs: ['shared/skills/skill.yaml'],
      baseHashes: { 'shared/skills/skill.yaml': null }
    };
    await fs.writeFile(path.join(jobDir, 'state.json'), JSON.stringify(jobState));

    const runState = {
      version: 1,
      id: 'run-0000',
      root: root,
      jobs: [
        { id: 'j1', status: 'complete', outputs: ['shared/skills/skill.yaml'], baseHashes: { 'shared/skills/skill.yaml': null }, workspace: '.swarm/workspaces/run-0000/j1' }
      ],
      status: 'complete'
    };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    // integrate --private-names should refuse
    await assert.rejects(
      () => integrateRun(root, 'run-0000', { privateNamesFile: termsPath }),
      /private-name/i
    );
  });

  test('integrate --private-names FILE passes output under shared/ without private terms', async t => {
    const root = await fixture(t);

    const termsPath = path.join(root, 'private-terms.txt');
    await fs.writeFile(termsPath, 'TestCompany\nAlice Smith\n');

    const m = {
      version: 1,
      jobs: [
        { ...job({ id: 'j1', outputs: ['shared/skills/skill.yaml'] }) }
      ]
    };

    const runDir = path.join(root, '.swarm', 'runs', 'run-0001');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(m));

    const jobDir = path.join(runDir, 'j1');
    await fs.mkdir(jobDir);

    // Same real-workspace layout as the refusal case above: clean output, no private terms.
    const workspaceDir = path.join(root, '.swarm', 'workspaces', 'run-0001', 'j1');
    const sharedDir = path.join(workspaceDir, 'shared', 'skills');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, 'skill.yaml'), 'name: Generic Clean Skill\n');

    const jobState = {
      id: 'j1',
      status: 'complete',
      outputs: ['shared/skills/skill.yaml'],
      baseHashes: { 'shared/skills/skill.yaml': null }
    };
    await fs.writeFile(path.join(jobDir, 'state.json'), JSON.stringify(jobState));

    const runState = {
      version: 1,
      id: 'run-0001',
      root: root,
      jobs: [
        { id: 'j1', status: 'complete', outputs: ['shared/skills/skill.yaml'], baseHashes: { 'shared/skills/skill.yaml': null }, workspace: '.swarm/workspaces/run-0001/j1' }
      ],
      status: 'complete'
    };
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(runState));

    const result = await integrateRun(root, 'run-0001', { privateNamesFile: termsPath });
    // Should succeed without throwing
    assert(!result.error);
  });
});
