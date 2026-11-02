// SPDX-License-Identifier: Apache-2.0
// Lesson #152: imported directly (not only via the package.json test script) so this file stays
// hermetic even run alone as `node --test tests/dispatch-refusals.test.mjs`.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, validateProject } from '../tools/swarm.mjs';

const execFileAsync = promisify(execFile);
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-dispatch-refusals-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function writeSkill(dir, name, { description = 'A test skill.', paths, checks, body = 'Full skill body text.' } = {}) {
  const lines = [`name: ${name}`, `description: ${description}`];
  if (paths) { lines.push('paths:'); for (const value of paths) lines.push(`  - ${value}`); }
  if (checks) {
    lines.push('checks:');
    if (checks.filesMustChange) { lines.push('  filesMustChange:'); for (const value of checks.filesMustChange) lines.push(`    - ${value}`); }
    if (checks.resultKeys) { lines.push('  resultKeys:'); for (const value of checks.resultKeys) lines.push(`    - ${value}`); }
  }
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\n${lines.join('\n')}\n---\n${body}\n`);
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = result => `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(result)}}));`;
const update = fake(`fs.writeFileSync('input.txt','updated'); ${done('Worker complete')}`);

test('resultKeys refusal names the skills source dir, the matching paths glob and the override', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'reporter', { paths: ['input.*'], checks: { resultKeys: ['approved'] } });
  await assert.rejects(
    validateProject(root, manifest([job()], { skillsDir })),
    error => {
      assert.match(
        error.message,
        new RegExp(`reporter: resultKeys missing approved \\(skill from ${escapeRegex(skillsDir)}, attached by paths: input\\.\\*; to run without these skills set "skillsDir" in the manifest to an empty directory, or declare the key in the job's "Return JSON only" shape\\)`),
      );
      return true;
    },
  );
});

test('a job attached via skills: list says manifest skills list in the resultKeys refusal', async t => {
  const root = await fixture(t);
  const skillsDir = path.join(root, 'skills');
  await writeSkill(skillsDir, 'reporter', { checks: { resultKeys: ['approved'] } });
  await assert.rejects(
    validateProject(root, manifest([job({ skills: ['reporter'] })], { skillsDir })),
    error => {
      assert.match(
        error.message,
        new RegExp(`reporter: resultKeys missing approved \\(skill from ${escapeRegex(skillsDir)}, attached by manifest skills list;`),
      );
      return true;
    },
  );
});

test('run on a git repo with zero commits refuses no-commits, naming --allow-empty, before any worker spawns', async t => {
  const root = await fixture(t);
  await execFileAsync('git', ['init'], { cwd: root });
  let calls = 0;
  const redCheck = { name: 'suite', argv: [process.execPath, '-e', 'process.exit(0)'] };
  await assert.rejects(
    runManifest(root, manifest([job()], { checks: [redCheck] }), { checkBase: true, spawnImpl: () => { calls++; throw new Error('unexpected spawn'); } }),
    error => {
      assert.equal(error.code, 'no-commits');
      assert.match(error.message, /git commit --allow-empty -m "init"/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('a copied-workspace run on a git repo with zero commits and no checks still runs (no HEAD needed)', async t => {
  const root = await fixture(t);
  await execFileAsync('git', ['init'], { cwd: root });
  const state = await runManifest(root, manifest(), { spawnImpl: update });
  assert.equal(state.status, 'complete');
});

test('a run with no .git at all (never initialized) is unaffected by the no-commits refusal', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: update });
  assert.equal(state.status, 'complete');
});

test('state.json carries acceptRedBase + reason + baseCheckFailures after an accepted red base', async t => {
  const root = await fixture(t);
  const redCheck = { name: 'suite', argv: [process.execPath, '-e', 'process.exit(1)'] };
  const routedSpawn = (command, args, options) => (command === process.execPath ? spawn(command, args, options) : update(command, args, options));
  const state = await runManifest(root, manifest([job()], { checks: [redCheck] }), {
    spawnImpl: routedSpawn,
    checkBase: true,
    acceptRedBase: true,
    reason: 'known flaky, shipping anyway',
    baseChecks: { baseSha: 'fake0000000000000000000000000000000000' },
  });
  assert.equal(state.acceptRedBase, true);
  assert.equal(state.acceptRedBaseReason, 'known flaky, shipping anyway');
  assert.deepEqual(state.baseCheckFailures, ['suite']);
  const onDisk = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'state.json'), 'utf8'));
  assert.equal(onDisk.acceptRedBase, true);
  assert.equal(onDisk.acceptRedBaseReason, 'known flaky, shipping anyway');
  assert.deepEqual(onDisk.baseCheckFailures, ['suite']);
});
