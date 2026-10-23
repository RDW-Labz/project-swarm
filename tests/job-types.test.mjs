// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { JOB_TYPES, applyJobType, jobTypeOutputViolations, isDocsFile } from '../tools/job-types.mjs';
import { validateManifest, validateProject, runManifest } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const job = (overrides = {}) => ({ id: 'typed', agent: 'auto', prompt: 'Perform the assigned work.', context: [], outputs: [], ...overrides });
const manifest = value => ({ version: 1, jobs: [value] });
const leadArea = { goal: 'Plan child jobs.', scope: ['app/'] };

test('untyped jobs remain unchanged and are copied', () => {
  const job = { id: 'plain', prompt: 'Implement it.', outputs: ['src/main.mjs'] };
  const result = applyJobType(job);
  assert.deepEqual(result, { job, warnings: [] });
  assert.notEqual(result.job, job);
});

test('presets are frozen and match the contract defaults', () => {
  const expected = {
    build: ['any', ['local', 'anthropic', 'cursor'], 1800000, null], // owner decision 2026-10-22
    fix: ['any', ['local', 'anthropic', 'cursor'], 1800000, 'diagnosing-bugs'], // owner decision 2026-10-22
    test: ['tests', ['local', 'codex', 'anthropic', 'hermes', 'cursor'], 1200000, 'tdd'], // owner decision 2026-10-22
    review: ['none', ['anthropic', 'cursor'], 900000, 'code-review'], // owner decision 2026-10-22
    research: ['none', ['hermes'], 900000, null],
    docs: ['docs', ['local', 'anthropic', 'hermes', 'cursor'], 900000, null], // owner decision 2026-10-22
    merge: ['any', ['codex'], 1800000, 'resolving-merge-conflicts'],
    lead: ['manifest', ['codex'], 900000, null],
  };
  assert.equal(Object.isFrozen(JOB_TYPES), true);
  assert.deepEqual(Object.keys(JOB_TYPES), Object.keys(expected));
  for (const [type, [writes, route, timeoutMs, skill]] of Object.entries(expected)) {
    const preset = JOB_TYPES[type];
    assert.deepEqual([preset.writes, preset.route, preset.timeoutMs, preset.skill], [writes, route, timeoutMs, skill]);
    assert.equal(Object.isFrozen(preset), true);
    assert.equal(Object.isFrozen(preset.route), true);
    const input = Object.freeze(job({ type }));
    const result = applyJobType(input, { skillNames: ['tdd', 'code-review', 'diagnosing-bugs', 'resolving-merge-conflicts'] });
    assert.equal(result.job.timeoutMs, timeoutMs);
    assert.deepEqual(result.job.typeRoute, route);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.job.skills, skill ? [skill] : undefined);
    assert.equal(result.job.prompt, input.prompt + '\n\nJob type ' + type + ': ' + preset.promptLine);
    assert.deepEqual(applyJobType(result.job, { skillNames: [] }).job, result.job);
    assert.equal(input.prompt, 'Perform the assigned work.');
    assert.equal(input.timeoutMs, undefined);
  }
});

test('explicit values win and protected job fields remain unchanged', () => {
  const input = job({ type: 'fix', agent: 'codex', model: 'gpt-5', timeoutMs: 1234, skills: [], context: ['tools/router.mjs'], outputs: ['tools/router.mjs'] });
  const snapshot = structuredClone(input);
  const result = applyJobType(input);
  assert.deepEqual(input, snapshot);
  for (const key of ['agent', 'model', 'timeoutMs', 'skills', 'context', 'outputs']) assert.deepEqual(result.job[key], input[key]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(applyJobType({ ...input, skills: ['custom'] }).job.skills, ['custom']);
});

test('preset skills attach only when available and otherwise warn', () => {
  for (const skillNames of [null, [], ['another-skill']]) {
    const result = applyJobType(job({ type: 'test' }), { skillNames });
    assert.equal(Object.hasOwn(result.job, 'skills'), false);
    assert.deepEqual(result.warnings, [{
      code: 'job-type-skill-unavailable', jobId: 'typed', skill: 'tdd',
      message: 'job-type-skill-unavailable: Job typed (type test) wants skill tdd; configure a skills dir that has it',
    }]);
  }
  assert.deepEqual(applyJobType(job({ type: 'test' }), { skillNames: ['tdd'] }).job.skills, ['tdd']);
});

test('documentation paths and every write rule including manifest edge cases', () => {
  for (const file of ['README.md', 'guide.mdx', 'guide.rst', 'guide.adoc', 'README.txt', 'notes/CHANGELOG.txt', 'docs/guide.md', 'DOCS\\guide.MD', 'notes/readme.TXT']) assert.equal(isDocsFile(file), true, file);
  for (const file of ['src/main.mjs', 'mydocs/data.json', 'guide.md.js', 'requirements.txt', 'docs/x.js', 'docs/data.json', 'docs/state/usage-ledger.md', 'DOCS\\STATE\\ledger.MD', 'guide.txt']) assert.equal(isDocsFile(file), false, file);
  assert.deepEqual(jobTypeOutputViolations(job({ outputs: ['src/main.mjs'] })), []);
  for (const type of ['build', 'fix', 'merge']) assert.deepEqual(jobTypeOutputViolations(job({ type, outputs: ['src/main.mjs'] })), []);
  for (const type of ['review', 'research']) {
    assert.deepEqual(jobTypeOutputViolations(job({ type })), []);
    assert.deepEqual(jobTypeOutputViolations(job({ type, outputs: ['README.md', 'tests/x.mjs'] })), ['README.md', 'tests/x.mjs']);
  }
  assert.deepEqual(jobTypeOutputViolations(job({ type: 'test', outputs: ['tests/x.mjs', 'src/x.test.mjs', 'test_x.py', 'x_test.go', 'src/x.mjs'] })), ['src/x.mjs']);
  assert.deepEqual(jobTypeOutputViolations(job({ type: 'docs', outputs: ['README.md', 'docs/data.json', 'src/x.mjs'] })), ['docs/data.json', 'src/x.mjs']);
  assert.deepEqual(jobTypeOutputViolations(job({ type: 'lead', area: leadArea, outputs: ['coordination/child.json'] })), []);
  for (const outputs of [[], ['child.md'], ['a.json', 'b.json'], ['a.json', 'b.md']]) {
    const violations = outputs.length ? outputs : ['(none)'];
    assert.deepEqual(jobTypeOutputViolations(job({ type: 'lead', area: leadArea, outputs })), violations);
    assert.throws(() => validateManifest(manifest(job({ type: 'lead', area: leadArea, outputs }))), { code: 'job-type-output', message: 'Job typed (type lead) may not write: ' + violations.join(', ') });
  }
  assert.throws(() => validateManifest(manifest(job({ type: 'test', outputs: ['tools/router.mjs'] }))), { code: 'job-type-output' });
  assert.throws(() => validateManifest(manifest(job({ type: 'docs', outputs: ['tools/router.mjs'] }))), { code: 'job-type-output' });
  assert.throws(() => validateManifest(manifest(job({ type: 'review', outputs: ['README.md'] }))), { code: 'job-type-output' });
});

test('unknown types and forged internal routes refuse', () => {
  for (const type of ['unknown', 'toString', '', null, 42]) {
    const input = job({ type });
    for (const check of [applyJobType, jobTypeOutputViolations, value => validateManifest(manifest(value))]) {
      assert.throws(() => check(input), { code: 'job-type-invalid', message: 'Job typed: unknown type ' + type });
    }
  }
  validateManifest(manifest(job({ type: 'build', typeRoute: ['local', 'anthropic', 'cursor'] }))); // owner decision 2026-10-22
  for (const input of [job({ typeRoute: ['codex'] }), job({ type: 'build', typeRoute: ['cursor', 'codex'] }), job({ type: 'build', typeRoute: [] })]) {
    assert.throws(() => validateManifest(manifest(input)), { code: 'job-type-invalid' });
  }
});

test('every type example is a valid auto manifest with compliant outputs', async () => {
  for (const type of Object.keys(JOB_TYPES)) {
    const example = JSON.parse(await fs.readFile(new URL('../examples/type-' + type + '.json', import.meta.url), 'utf8'));
    validateManifest(example);
    assert.equal(example.jobs[0].type, type);
    assert.equal(example.jobs[0].agent, 'auto');
    assert.equal(Object.hasOwn(example.jobs[0], 'model'), false);
    assert.deepEqual(jobTypeOutputViolations(example.jobs[0]), []);
  }
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-job-types-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'Fixture input.\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', 'input.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}

test('validateProject returns skill warnings and the applied prompt before routing', async t => {
  const root = await fixture(t);
  const input = job({ type: 'review', context: ['input.txt'] });
  const value = { ...manifest(input), lanes: { hermes: { model: 'test-model' }, anthropic: { model: 'claude-haiku-5-5' }, cursor: { model: 'u' } } };
  const result = await validateProject(root, value);
  assert.equal(result.routes[0].agent, 'anthropic'); // owner decision 2026-10-22: review routes anthropic (Sonnet), not codex
  assert.equal(result.jobs[0].prompt, applyJobType(input).job.prompt);
  assert.equal(result.jobs[0].timeoutMs, 900000);
  assert.equal(result.warnings.filter(warning => warning.code === 'job-type-skill-unavailable').length, 1);
  assert.equal(input.prompt, 'Perform the assigned work.');
  const skillDir = path.join(root, 'skills/code-review');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: code-review\ndescription: Review source.\n---\nReview the supplied source.\n');
  const available = await validateProject(root, { ...value, skillsDir: 'skills' });
  assert.deepEqual(available.jobs[0].skills, ['code-review']);
  assert.equal(available.warnings.some(warning => warning.code === 'job-type-skill-unavailable'), false);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: code-review\ndescription: Review source.\nunknown: invalid\n---\nReview the supplied source.\n');
  const broken = await validateProject(root, { ...value, skillsDir: 'skills' });
  assert.equal(broken.warnings.some(warning => warning.code === 'job-type-skill-unavailable'), true);
  assert.equal(broken.jobs[0].skills, undefined);
});

test('runManifest saves applied presets and surfaces unavailable skill warnings', async t => {
  const root = await fixture(t);
  const input = job({ type: 'fix', agent: 'claude', model: 'sonnet', context: ['input.txt'], outputs: ['input.txt'] });
  const state = await runManifest(root, manifest(input), {
    id: 'typed-run',
    spawnImpl: (_command, _args, options) => spawn(process.execPath, ['-e', 'console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Done"}))'], options),
  });
  assert.equal(state.status, 'complete');
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs/typed-run/manifest.json'), 'utf8'));
  assert.deepEqual(saved.jobs[0], applyJobType(input).job);
  assert.equal(state.warnings.some(warning => warning.includes('job-type-skill-unavailable')), true);
});

test('research routes to Hermes first; docs and test use it only after Anthropic; the other job types never do', async t => {
  const root = await fixture(t);
  const lanesConfig = { hermes: { model: 'test-model' }, anthropic: { model: 'claude-haiku-5-5' }, codex: { model: 'gpt-5' } };
  const research = await validateProject(root, { ...manifest(job({ type: 'research', context: ['input.txt'], outputs: [] })), lanes: lanesConfig });
  assert.equal(research.routes[0].agent, 'hermes');
  for (const type of ['build', 'fix', 'review', 'merge', 'lead']) assert.equal(JOB_TYPES[type].route.includes('hermes'), false, type);
  for (const type of ['docs', 'test']) {
    const route = JOB_TYPES[type].route;
    assert.ok(route.includes('hermes') && route.indexOf('hermes') > route.indexOf('anthropic'), type);
  }
});
