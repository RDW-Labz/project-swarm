import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listEvals, EVAL_GROUP_MARKER } from '../tools/evals.mjs';
import { runLessonsCommand } from '../tools/lessons-commands.mjs';

const repo = path.resolve(import.meta.dirname, '..');

async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evals-groups-')));
}

test('shipped evals: twelve evals plus managers fixture group skipped', async () => {
  const evalDirs = (await fs.readdir(path.join(repo, 'evals'), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  assert.ok(evalDirs.some((e) => e.name === 'managers'));
  const { evals, invalid } = await listEvals(repo);
  assert.equal(evals.length, evalDirs.length - 1);
  assert.equal(invalid.length, 0);
  assert.ok(!evals.some((e) => e.id === 'managers'));
  assert.ok(!invalid.some((i) => i.id === 'managers'));
  const listed = await runLessonsCommand(repo, 'eval', ['list']);
  assert.equal(listed.exitCode, 0, listed.stdout);
  assert.match(listed.stdout, new RegExp(`^${evals.length} evals, 0 invalid`));
  assert.doesNotMatch(listed.stdout, /INVALID managers/);
});

test('fixture group folder is skipped by list and validate', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'evals', 'replay-fixtures'), { recursive: true });
  await fs.writeFile(path.join(root, 'evals', 'replay-fixtures', EVAL_GROUP_MARKER), 'not an eval\n');
  const { evals, invalid } = await listEvals(root);
  assert.deepEqual(evals, []);
  assert.deepEqual(invalid, []);
  const listed = await runLessonsCommand(root, 'eval', ['list']);
  assert.equal(listed.exitCode, 0);
  assert.match(listed.stdout, /0 evals, 0 invalid/);
  const validated = await runLessonsCommand(root, 'eval', ['validate', '--all']);
  assert.equal(validated.exitCode, 1);
  assert.match(validated.stdout, /no evals to validate/);
});

test('unmarked folder without eval.json is still INVALID', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'evals', 'not-an-eval'), { recursive: true });
  const { evals, invalid } = await listEvals(root);
  assert.equal(evals.length, 0);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].id, 'not-an-eval');
  const listed = await runLessonsCommand(root, 'eval', ['list']);
  assert.equal(listed.exitCode, 1);
  assert.match(listed.stdout, /INVALID not-an-eval/);
});
