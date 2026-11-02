import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runLessonsCommand, parseArgs, loadLessonsForNotes } from '../tools/lessons-commands.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { parseScope } from '../tools/scope.mjs';

async function project() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lessons-cmd-')));
}
const add = (root, extra = []) => runLessonsCommand(root, 'lessons', ['add', '--stage', 'build', '--what', 'A write followed a symlink at the target path.', '--rule', 'Never write through a symlink at the target file.', '--tag', 'symlink', '--tag', 'path-safety', ...extra]);

test('parseArgs collects repeatable flags and rejects a flag without a value', () => {
  assert.deepEqual(parseArgs(['--tag', 'a', '--tag', 'b', 'x']).flags.tag, ['a', 'b']);
  assert.throws(() => parseArgs(['--stage']), /needs a value/);
});

test('add, list, show, stats and check work on a fresh project', async () => {
  const root = await project();
  const added = await add(root);
  assert.equal(added.exitCode, 0, added.stdout);
  assert.match(added.stdout, /lessons\/.+\/L-0001\.json/);
  assert.equal((await add(root)).exitCode, 0);
  const list = JSON.parse((await runLessonsCommand(root, 'lessons', ['list', '--tag', 'symlink', '--json'])).stdout);
  assert.deepEqual(list.map(l => l.id), ['L-0001', 'L-0002']);
  assert.match((await runLessonsCommand(root, 'lessons', ['show', 'L-0001'])).stdout, /"stage": "build"/);
  assert.match((await runLessonsCommand(root, 'lessons', ['stats'])).stdout, /2 lessons/);
  assert.equal((await runLessonsCommand(root, 'lessons', ['check'])).exitCode, 0);
});

test('add refuses a lesson that holds an email, a home path or a secret', async () => {
  const root = await project();
  const email = await add(root, ['--fix', 'Ask someone@example.com']);
  assert.equal(email.exitCode, 1);
  const home = await runLessonsCommand(root, 'lessons', ['add', '--stage', 'build', '--what', 'Looked in /Users/someone/work', '--rule', 'Never do that.']);
  assert.equal(home.exitCode, 1);
  const secret = ['gh', 'p_', 'a'.repeat(36)].join('');
  const leaked = await runLessonsCommand(root, 'lessons', ['add', '--stage', 'build', '--what', `Token ${secret} leaked`, '--rule', 'Never commit tokens.']);
  assert.equal(leaked.exitCode, 1);
  assert.doesNotMatch(leaked.stdout, new RegExp(secret));
});

test('check reports an invalid lesson file and exits 1', async () => {
  const root = await project();
  await add(root);
  const dir = path.join(root, 'lessons', path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40));
  await fs.writeFile(path.join(dir, 'L-0099.json'), '{"nope":true}');
  const result = await runLessonsCommand(root, 'lessons', ['check']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /1 invalid/);
});

test('notes show relevant lessons and say so when none are relevant', async () => {
  const root = await project();
  await add(root);
  const hit = await runLessonsCommand(root, 'lessons', ['notes', 'Write the file without following a symlink', '--file', 'src/write.mjs']);
  assert.match(hit.stdout, /Watch out for/);
  assert.match(hit.stdout, /symlink/i);
  assert.match((await runLessonsCommand(root, 'lessons', ['notes', 'Render a cheerful landing page banner'])).stdout, /no relevant lessons/);
});

test('ticketsToManifest puts notes before the job rule and leaves the prompt alone without lessons', async () => {
  const root = await project();
  await add(root);
  const lessons = await loadLessonsForNotes(root, null);
  assert.equal(lessons.length, 1);
  const scope = parseScope('# Scope: X\nVersion: 1\n\n## Stages\n- S1: A\n\n## S1 A\n### R-001 A user can save a file safely.\nAcceptance:\n- Saving never follows a symlink.\n');
  const ticket = { id: 'T-0001', title: 'Save file without following a symlink', type: 'build', stage: 'S1', epic: 'E-01', scopeRefs: ['R-001'], acceptance: ['saves'], files: ['src/save.mjs'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo' };
  const plain = ticketsToManifest([ticket], { scope, ready: false }).manifest.jobs[0].prompt;
  const withNotes = ticketsToManifest([ticket], { scope, ready: false, lessons }).manifest.jobs[0].prompt;
  assert.match(withNotes, /Watch out for/);
  assert.doesNotMatch(plain, /Watch out for/);
  const rule = 'Work only on the files you own; report the ticket id.';
  assert.ok(plain.endsWith(rule) && withNotes.endsWith(rule));
  assert.ok(withNotes.indexOf('Watch out for') < withNotes.lastIndexOf(rule));
});

test('eval commands list, validate and write a manifest for the shipped evals', async () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const listed = await runLessonsCommand(repo, 'eval', ['list']);
  assert.equal(listed.exitCode, 0, listed.stdout);
  assert.match(listed.stdout, /hostname-check/);
  const root = await project();
  await fs.cp(path.join(repo, 'evals'), path.join(root, 'evals'), { recursive: true });
  const manifest = await runLessonsCommand(root, 'eval', ['manifest', '--all', '--agent', 'anthropic', '--model', 'claude-haiku-5-5']);
  assert.equal(manifest.exitCode, 0, manifest.stdout);
  const written = JSON.parse(await fs.readFile(path.join(root, 'evals/.run/manifest.json'), 'utf8'));
  assert.ok(written.jobs.length >= 8);
  assert.ok(written.jobs.every(j => j.sensitive === true && j.id.startsWith('eval-')));
  assert.equal((await runLessonsCommand(root, 'eval', ['manifest', '--all', '--out', '../escape.json'])).exitCode, 1);
});

test('every shipped eval is red on the starting repo and green on its solution', async () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const result = await runLessonsCommand(repo, 'eval', ['validate', '--all']);
  assert.equal(result.exitCode, 0, result.stdout);
});

async function fakeEvalProject(passes) {
  const repo = path.resolve(import.meta.dirname, '..');
  const root = await project();
  await fs.mkdir(path.join(root, 'evals'), { recursive: true });
  for (const name of ['hostname-check', 'stale-lock']) await fs.cp(path.join(repo, 'evals', name), path.join(root, 'evals', name), { recursive: true });
  const runId = '1700000000000-abcdef12';
  await fs.mkdir(path.join(root, '.swarm/runs', runId), { recursive: true });
  const jobs = [];
  for (const [name, mod] of [['hostname-check', 'src/hostname-check.mjs'], ['stale-lock', 'src/stale-lock.mjs']]) {
    const ws = `.swarm/workspaces/${runId}/eval-${name}`;
    const target = path.join(root, ws, 'evals', name, 'repo', mod);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, 'evals', name, passes.includes(name) ? 'solution' : 'repo', mod), target);
    jobs.push({ id: `eval-${name}`, status: 'complete', workspace: ws, agent: 'anthropic', model: 'claude-haiku-5-5' });
  }
  await fs.writeFile(path.join(root, '.swarm/runs', runId, 'state.json'), JSON.stringify({ jobs }));
  return { root, runId };
}

test('eval gate sets a baseline, then fails when the score drops, and refuses a malformed baseline', async () => {
  const good = await fakeEvalProject(['hostname-check', 'stale-lock']);
  const first = await runLessonsCommand(good.root, 'eval', ['gate', good.runId, '--update-baseline']);
  assert.equal(first.exitCode, 0, first.stdout);
  assert.match(first.stdout, /set to 2 of 2/);
  const worse = await fakeEvalProject(['hostname-check']);
  await fs.copyFile(path.join(good.root, 'evals/baseline.json'), path.join(worse.root, 'evals/baseline.json'));
  const dropped = await runLessonsCommand(worse.root, 'eval', ['gate', worse.runId]);
  assert.equal(dropped.exitCode, 1);
  assert.match(dropped.stdout, /regressed/);
  const refused = await runLessonsCommand(worse.root, 'eval', ['gate', worse.runId, '--update-baseline']);
  assert.equal(refused.exitCode, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(worse.root, 'evals/baseline.json'), 'utf8'))['anthropic/claude-haiku-5-5'].passed, 2);
  await fs.writeFile(path.join(worse.root, 'evals/baseline.json'), 'null');
  const malformed = await runLessonsCommand(worse.root, 'eval', ['gate', worse.runId]);
  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.stdout, /baseline-invalid/);
});

test('eval gate fails when the eval count changed unless the baseline is reset on purpose', async () => {
  const a = await fakeEvalProject(['hostname-check', 'stale-lock']);
  await fs.writeFile(path.join(a.root, 'evals/baseline.json'), JSON.stringify({ 'anthropic/claude-haiku-5-5': { passed: 5, total: 5 } }));
  const changed = await runLessonsCommand(a.root, 'eval', ['gate', a.runId]);
  assert.equal(changed.exitCode, 1);
  assert.match(changed.stdout, /total-changed/);
  assert.equal((await runLessonsCommand(a.root, 'eval', ['gate', a.runId, '--update-baseline'])).exitCode, 1);
  const reset = await runLessonsCommand(a.root, 'eval', ['gate', a.runId, '--update-baseline', '--reset-baseline']);
  assert.equal(reset.exitCode, 0, reset.stdout);
});

test('eval manifest refuses a symlinked output file and a third-party agent', async () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const root = await project();
  await fs.cp(path.join(repo, 'evals'), path.join(root, 'evals'), { recursive: true });
  const victim = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'victim-')), 'keep.json');
  await fs.writeFile(victim, 'keep');
  await fs.rm(path.join(root, 'evals/.run'), { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'evals/.run'), { recursive: true });
  await fs.symlink(victim, path.join(root, 'evals/.run/manifest.json'));
  await runLessonsCommand(root, 'eval', ['manifest', '--all']).catch(() => {});
  assert.equal(await fs.readFile(victim, 'utf8'), 'keep');
  const third = await runLessonsCommand(root, 'eval', ['manifest', '--all', '--agent', 'openrouter', '--out', 'evals/other.json']).catch(error => ({ exitCode: 1, stdout: String(error.code) }));
  assert.equal(third.exitCode, 1);
});

test('lessons from the installed swarm are loaded for notes', async () => {
  const root = await project();
  const install = await project();
  await add(install);
  const lessons = await loadLessonsForNotes(root, install);
  assert.equal(lessons.length, 1);
});

test('lessons mine prints clusters without writing, then writes proposals once and never overwrites', async () => {
  const root = await project();
  for (let i = 0; i < 3; i += 1) {
    const r = await runLessonsCommand(root, 'lessons', ['add', '--stage', 'build', '--what', `A lane retried blindly ${i}.`, '--rule', `Retries need evidence ${i}.`, '--tag', 'retries', '--caught-by', 'missed']);
    assert.equal(r.exitCode, 0, r.stdout);
  }
  const dry = await runLessonsCommand(root, 'lessons', ['mine']);
  assert.match(dry.stdout, /retries: 3 lessons/);
  await assert.rejects(fs.access(path.join(root, 'proposals')));
  const written = await runLessonsCommand(root, 'lessons', ['mine', '--write']);
  assert.match(written.stdout, /1 proposal\(s\) written/);
  const file = path.join(root, 'proposals', 'retries.md');
  const first = await fs.readFile(file, 'utf8');
  assert.match(first, /Proposed guard: test-template/);
  assert.match(first, /Not merged automatically/);
  await fs.writeFile(file, `${first}\nhand edit\n`);
  const again = await runLessonsCommand(root, 'lessons', ['mine', '--write']);
  assert.match(again.stdout, /already existed/);
  assert.match(await fs.readFile(file, 'utf8'), /hand edit/);
  assert.equal((await runLessonsCommand(root, 'lessons', ['mine', '--min', '1'])).exitCode, 1);
});

test('profile ci block: valid hooks pass, unknown keys, bad argv and production previews are refused', async () => {
  const { validateProfile } = await import('../tools/init-profile.mjs');
  assert.deepEqual(validateProfile({ ci: { smoke: { argv: ['npx', 'playwright', 'test'] }, preview: { argv: ['vercel', 'deploy'], everyBatches: 2 } } }).errors, []);
  assert.match(validateProfile({ ci: { other: 1 } }).errors[0], /profile\.ci/);
  assert.match(validateProfile({ ci: { smoke: { argv: ['/abs/bin'] } } }).errors[0], /profile\.ci/);
  assert.match(validateProfile({ ci: { preview: { argv: ['vercel', 'deploy', '--prod'] } } }).errors[0], /profile\.ci/);
});
