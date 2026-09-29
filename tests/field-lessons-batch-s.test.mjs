// SPDX-License-Identifier: Apache-2.0
// Swarm batch S: field lessons 244-247 (see .swarm-manifests/contract-s.md).
// #244: dropped-write detection excludes swarm-seeded paths (.swarm/skills/**) unless a worker
// actually edited one, comparing by path + seeded content hash.
// #245: integrate --mutants / validate of a job's mutantsFile output warns
// mutant-missing-for-changed-file for a changed non-test source file under tools/ or src/ with no
// covering mutant.
// #247: checks-from-ci skips a CI-only step (GITHUB_ACTIONS/runner.os mention, a native pytest
// marker, or a secrets.-referencing env), reporting checks-from-ci-skipped (ci-only).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runManifest, integrateRun, undeclaredMutantsFileWarnings } from '../tools/swarm.mjs';
import { ciChecksFromWorkflowText } from '../tools/checks-from-ci.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-s-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Same shape as tests/worker-skills.test.mjs's own writeSkill fixture helper.
async function writeSkill(dir, name, { description = 'A test skill.', body = 'Full skill body text.' } = {}) {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;
const noWrites = fake(done);

// --- #244: dropped-write detection excludes swarm-seeded paths --------------------------------

describe('#244: dropped-write detection excludes swarm-seeded skill copies unless a worker edits one', () => {
  test('(a) skills seeded, no worker writes: no dropped writes reported', async t => {
    const root = await fixture(t);
    const skillsDir = path.join(root, 'skills');
    await writeSkill(skillsDir, 'formatting', {});
    const state = await runManifest(root, manifest([job()], { skillsDir }), { spawnImpl: noWrites });
    assert.equal(state.jobs[0].droppedWrites, undefined);
    assert.equal(state.jobs[0].workerKeyExposed, undefined);
    const result = await integrateRun(root, state.id);
    assert.equal((result.warnings ?? []).some(w => w.startsWith('dropped write')), false);
  });

  test('(b) a worker edits a seeded skill file: still reported as a dropped write', async t => {
    const root = await fixture(t);
    const skillsDir = path.join(root, 'skills');
    await writeSkill(skillsDir, 'formatting', {});
    const edit = fake(`fs.writeFileSync('.swarm/skills/formatting/SKILL.md', 'tampered by worker'); ${done}`);
    const state = await runManifest(root, manifest([job()], { skillsDir }), { spawnImpl: edit });
    assert.deepEqual(state.jobs[0].droppedWrites, ['.swarm/skills/formatting/SKILL.md']);
    assert.deepEqual(state.jobs[0].droppedWritesNew, ['.swarm/skills/formatting/SKILL.md']);
    const result = await integrateRun(root, state.id);
    assert.ok((result.warnings ?? []).includes('dropped write: .swarm/skills/formatting/SKILL.md (new) (not in outputs)'));
  });
});
