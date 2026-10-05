// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, integrateRun, validateProject } from '../tools/swarm.mjs';

const exec = promisify(execFile);
async function fixture(t, { skill = 'reporter', missing = false, filesMustChange = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lesson-349-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\nskills-source/\n');
  const git = (...args) => exec('git', args, { cwd: root });
  await git('init', '-q', '-b', 'main');
  await git('add', 'input.txt', '.gitignore');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const skillsDir = path.join(root, 'skills-source');
  await fs.mkdir(path.join(skillsDir, skill), { recursive: true });
  await fs.writeFile(path.join(skillsDir, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Report results.\npaths:\n  - input.txt\nchecks:\n  resultKeys:\n    - status\n    - reproTest\n${filesMustChange ? '  filesMustChange:\n    - input.txt\n' : ''}---\nReport results.\n`);
  const job = { id: 'contract', agent: 'claude', model: 'sonnet', prompt: 'Write a contract. Return JSON only: {"status":"done","reproTest":"none"}', context: ['input.txt'], outputs: ['contract.txt', ...(missing ? ['missing.txt'] : [])], timeoutMs: 5000 };
  const manifest = { version: 1, skillsDir, jobs: [job] };
  const spawnImpl = (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; fs.writeFileSync('contract.txt','Contract written.'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'{"notes":"written"}'}));`], options);
  return { root, job, manifest, spawnImpl };
}

test('L349 a contract job with outputs on disk integrates with a diagnostic shape warning', async t => {
  const f = await fixture(t);
  const state = await runManifest(f.root, f.manifest, { spawnImpl: f.spawnImpl });
  assert.equal(state.status, 'complete');
  const result = await integrateRun(f.root, state.id, { noChecks: true });
  assert.equal(result.status, 'integrated');
  assert.equal(await fs.readFile(path.join(f.root, 'contract.txt'), 'utf8'), 'Contract written.');
  const warning = result.warnings.find(value => value.includes('result-shape'));
  assert.match(warning, /parsed keys.*notes/);
  assert.match(warning, /response.txt/);
  assert.match(warning, /written/);
  assert.match(warning, /--accept-result-shape/);
});

test('L349 incomplete outputs refuse shape with parsed text, and explicit override is recorded', async t => {
  const f = await fixture(t, { missing: true });
  const state = await runManifest(f.root, f.manifest, { spawnImpl: f.spawnImpl });
  await assert.rejects(integrateRun(f.root, state.id, { noChecks: true }), /skill-check-failed:.*parsed keys.*notes.*response.txt.*written.*--accept-result-shape/);
  await assert.rejects(fs.access(path.join(f.root, 'contract.txt')));
  const result = await integrateRun(f.root, state.id, { noChecks: true, acceptResultShape: true });
  assert.equal(result.status, 'integrated');
  assert.ok(result.warnings.some(value => value.includes('accepted-result-shape')));
  assert.ok(result.warnings.some(value => value.includes('output-never-written: missing.txt')));
});

test('L349 shape acceptance never bypasses filesMustChange checks', async t => {
  const f = await fixture(t, { filesMustChange: true });
  const state = await runManifest(f.root, f.manifest, { spawnImpl: f.spawnImpl });
  await assert.rejects(integrateRun(f.root, state.id, { noChecks: true, acceptResultShape: true }), /skill-check-failed:.*filesMustChange/);
});

test('L349 debugging only attaches to fix prompts or explicit manifest opt-in', async t => {
  const f = await fixture(t, { skill: 'debugging' });
  f.job.prompt = 'Write a contract.';
  assert.equal((await validateProject(f.root, f.manifest)).status, 'valid');
  f.job.prompt = 'Fix the failing contract test.';
  await assert.rejects(validateProject(f.root, f.manifest), /debugging: resultKeys missing status/);
  f.job.prompt = 'Write a contract.';
  f.job.skills = ['debugging'];
  await assert.rejects(validateProject(f.root, f.manifest), /debugging: resultKeys missing status/);
});
