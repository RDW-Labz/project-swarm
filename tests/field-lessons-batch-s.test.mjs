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
import { runManifest, integrateRun, inspectResults } from '../tools/swarm.mjs';
import { ciChecksFromWorkflowText, loadChecksFromCi, parseWorkflowSteps } from '../tools/checks-from-ci.mjs';

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
const doneWithChanged = changed => `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ changed }))}}));`;

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
    await assert.rejects(integrateRun(root, state.id), /dropped-writes: writer: \.swarm\/skills\/formatting\/SKILL\.md/);
    const result = await integrateRun(root, state.id, { acceptDropped: true });
    assert.ok((result.warnings ?? []).includes('dropped write: .swarm/skills/formatting/SKILL.md (new) (not in outputs)'));
  });
});

// --- #245: mutant-missing-for-changed-file -----------------------------------------------------

const twoFileJob = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned files.', context: ['tools/a.js', 'tools/b.js'], outputs: ['tools/a.js', 'tools/b.js'], timeoutMs: 5000, ...overrides });
const passCheck = { argv: [process.execPath, '-e', 'process.exit(0)'] };
const editBoth = fake(`fs.writeFileSync('tools/a.js','const a = 2;\\n');fs.writeFileSync('tools/b.js','const b = 2;\\n');${done}`);
async function twoFileFixture(t) {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools/a.js'), 'const a = 1;\n');
  await fs.writeFile(path.join(root, 'tools/b.js'), 'const b = 1;\n');
  return root;
}

describe('#245: integrate --mutants warns mutant-missing-for-changed-file for an uncovered changed source file', () => {
  test('(c) two changed files, mutants for only one: reports the other', async t => {
    const root = await twoFileFixture(t);
    const state = await runManifest(root, manifest([twoFileJob()], {
      mutants: [{ name: 'flip-a', file: 'tools/a.js', find: 'const a = 2;', replace: 'const a = 999;' }],
      mutantCheck: passCheck,
    }), { spawnImpl: editBoth });
    const result = await integrateRun(root, state.id, { mutants: true });
    assert.deepEqual((result.warnings ?? []).filter(w => w.startsWith('mutant-missing-for-changed-file')), ['mutant-missing-for-changed-file: tools/b.js']);
  });

  test('(d) two changed files, mutants cover both: no missing-coverage warnings', async t => {
    const root = await twoFileFixture(t);
    const state = await runManifest(root, manifest([twoFileJob()], {
      mutants: [
        { name: 'flip-a', file: 'tools/a.js', find: 'const a = 2;', replace: 'const a = 999;' },
        { name: 'flip-b', file: 'tools/b.js', find: 'const b = 2;', replace: 'const b = 999;' },
      ],
      mutantCheck: passCheck,
    }), { spawnImpl: editBoth });
    const result = await integrateRun(root, state.id, { mutants: true });
    assert.deepEqual((result.warnings ?? []).filter(w => w.startsWith('mutant-missing-for-changed-file')), []);
  });
});

// --- #247: checks-from-ci skips CI-only steps --------------------------------------------------

describe('#247: checks-from-ci skips a CI-only step (native marker), replays an ordinary one', () => {
  test('(e) a workflow with one native pytest step yields ci-only skip, not a check', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-s-ci-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dir, '.github/workflows'), { recursive: true });
    await fs.writeFile(path.join(dir, '.github/workflows/ci.yml'), 'steps:\n  - run: pytest -m native\n');
    const { checks, skipped } = ciChecksFromWorkflowText('steps:\n  - run: pytest -m native\n');
    assert.deepEqual(checks, []);
    assert.deepEqual(skipped, [{ raw: 'pytest -m native', reason: 'ci-only' }]);
    const loaded = await loadChecksFromCi(dir);
    assert.deepEqual(loaded.checks, []);
    assert.ok(loaded.skipped.some(skip => skip.reason === 'ci-only' && skip.raw === 'pytest -m native'));
  });

  test('(f) an ordinary pytest step replays normally', () => {
    const { checks, skipped } = ciChecksFromWorkflowText('steps:\n  - run: pytest tests/\n');
    assert.deepEqual(checks.map(c => c.argv), [['pytest', 'tests/']]);
    assert.deepEqual(skipped, []);
  });
});

// --- #250: job-level env: never leaks into a sibling job's steps ------------------------------

describe('#250: a job-level env: applies only to that job\'s own steps, reset at each job boundary', () => {
  test('(g) job A env with secrets + job B without env: B\'s pytest is a check, A\'s run lines are ci-only', () => {
    const yaml = [
      'jobs:',
      '  job-a:',
      '    env:',
      '      TOKEN: ${{ secrets.X }}',
      '    steps:',
      '      - run: npm ci',
      '  job-b:',
      '    steps:',
      '      - run: pytest tests/',
    ].join('\n');
    const { checks, skipped } = ciChecksFromWorkflowText(yaml);
    assert.deepEqual(checks.map(c => c.argv), [['pytest', 'tests/']]);
    assert.ok(skipped.some(s => s.raw === 'npm ci' && s.reason === 'ci-only'));
  });

  test('(h) a step whose if: mentions runner.os is ci-only', () => {
    const yaml = ['steps:', '  - if: runner.os == \'Linux\'', '    run: pytest tests/'].join('\n');
    const { checks, skipped } = ciChecksFromWorkflowText(yaml);
    assert.deepEqual(checks, []);
    assert.deepEqual(skipped, [{ raw: 'pytest tests/', reason: 'ci-only' }]);
  });

  test('(i) a run line that itself tests $GITHUB_ACTIONS is ci-only', () => {
    const yaml = ['steps:', '  - run: test "$GITHUB_ACTIONS" = true && pytest tests/'].join('\n');
    const { checks, skipped } = ciChecksFromWorkflowText(yaml);
    assert.deepEqual(checks, []);
    assert.deepEqual(skipped, [{ raw: 'test "$GITHUB_ACTIONS" = true && pytest tests/', reason: 'ci-only' }]);
  });

  test('(j) a step-level env: with secrets. is ci-only; a sibling step without it replays', () => {
    const yaml = [
      'steps:',
      '  - env:',
      '      TOKEN: ${{ secrets.X }}',
      '    run: npm ci',
      '  - run: pytest tests/',
    ].join('\n');
    const { checks, skipped } = ciChecksFromWorkflowText(yaml);
    assert.deepEqual(checks.map(c => c.argv), [['pytest', 'tests/']]);
    assert.ok(skipped.some(s => s.raw === 'npm ci' && s.reason === 'ci-only'));
  });

  test('(k) a workflow-level env: with secrets. makes every step ci-only', () => {
    const yaml = [
      'env:',
      '  TOKEN: ${{ secrets.X }}',
      'jobs:',
      '  job-a:',
      '    steps:',
      '      - run: pytest tests/',
    ].join('\n');
    const { checks, skipped } = ciChecksFromWorkflowText(yaml);
    assert.deepEqual(checks, []);
    assert.deepEqual(skipped, [{ raw: 'pytest tests/', reason: 'ci-only' }]);
  });

  test('(n) two jobs: job 2\'s parsed steps carry none of job 1\'s env keys', () => {
    const yaml = [
      'jobs:',
      '  job-1:',
      '    env:',
      '      FOO_TOKEN: ${{ secrets.FOO }}',
      '      BAR: plain',
      '    steps:',
      '      - run: npm ci',
      '  job-2:',
      '    env:',
      '      BAZ: plain2',
      '    steps:',
      '      - run: pytest tests/',
    ].join('\n');
    const steps = parseWorkflowSteps(yaml);
    const job2Step = steps.find(step => step.blockText.includes('pytest tests/'));
    assert.ok(job2Step);
    assert.ok(!job2Step.jobEnvText.includes('FOO_TOKEN'));
    assert.ok(!job2Step.jobEnvText.includes('BAR'));
    assert.ok(job2Step.jobEnvText.includes('BAZ'));
    const { checks } = ciChecksFromWorkflowText(yaml);
    assert.ok(checks.some(c => c.raw === 'pytest tests/'));
  });
});

// --- #249: a self-reported "changed" entry is normalized before comparing to outputs ----------

describe('#249: inspect --results normalizes a self-reported "changed" entry before comparing it to outputs', () => {
  test('(l) changed [\'out.txt created\'] with outputs [\'out.txt\']: no dropped-write warning', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job({ context: [], outputs: ['out.txt'] })]), { spawnImpl: fake(doneWithChanged(['out.txt created'])) });
    const results = await inspectResults(root, state.id);
    assert.equal((results.warnings ?? []).some(w => w.startsWith('dropped write')), false);
  });

  test('(m) changed [\'other.txt (new)\']: warns dropped write: other.txt (not in outputs)', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest([job({ context: [], outputs: ['out.txt'] })]), { spawnImpl: fake(doneWithChanged(['other.txt (new)'])) });
    const results = await inspectResults(root, state.id);
    assert.ok((results.warnings ?? []).includes('dropped write: other.txt (not in outputs)'));
  });
});
