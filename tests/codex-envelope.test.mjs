// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCodexReply, codexResultFile, codexWorktreeFallback, resolveCodexEnvelope, git } from '../tools/codex-adapter.mjs';

// Shaped like the real evidence in .swarm-manifests/evidence/ (ac27-response.txt,
// ub-build-response.txt): a bare final JSON object using the shared filesChanged/testsAdded/
// crossJobNames/notes contract, plus job-specific keys, and no files_changed/notes at all.
const ac27Reply = JSON.stringify({ filesChanged: ['CHANGELOG.md', 'src/acme_app/chat_service.py', 'tests/test_chat_tools.py'], testsAdded: 68, mutantsCovered: ['accept_any_token', 'skip_plan_hash'], crossJobNames: [], checks: 'pytest 759 passed; ruff; mypy x2', notes: 'Reply-all fails closed pending complete connector recipient metadata.' });
const ubBuildReply = JSON.stringify({ filesChanged: ['CHANGELOG.md', 'src/components/Chat.tsx', 'tests/Chat.test.tsx'], testsAdded: 30, passes: 3, lastShots: ['.pilot/t27-r1/preview-light-1280x800.png'], crossJobNames: [], notes: '287 tests, typecheck, ESLint and build pass.' });

async function tempDir(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-codex-envelope-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function gitRepo(t, outputs) {
  const root = await tempDir(t);
  await git(root, ['init']);
  for (const [file, content] of Object.entries(outputs)) await fs.writeFile(path.join(root, file), content);
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return root;
}

test('both evidence-shaped replies parse as bare top-level objects (no files_changed/notes schema required)', () => {
  assert.deepEqual(parseCodexReply(ac27Reply), JSON.parse(ac27Reply));
  assert.deepEqual(parseCodexReply(ubBuildReply), JSON.parse(ubBuildReply));
});

test('the last fenced block wins over an earlier one (documented last-fence rule)', () => {
  const text = '```json\n{"notes":"first"}\n```\nthen\n```\n{"notes":"second"}\n```\n';
  assert.deepEqual(parseCodexReply(text), { notes: 'second' });
});

test('prose with a trailing bare object still parses when there is no fence', () => {
  const text = `I finished the task and ran the tests.\n${ac27Reply}\n`;
  assert.deepEqual(parseCodexReply(text), JSON.parse(ac27Reply));
});

test('a reply with no fenced or bare JSON returns null', () => {
  assert.equal(parseCodexReply('All done, no JSON here.'), null);
  assert.equal(parseCodexReply(''), null);
  assert.equal(parseCodexReply(undefined), null);
  assert.equal(parseCodexReply('```json\n[1, 2]\n```'), null);
});

test('missing reply JSON falls back to the worktree\'s result file when it parses as an object', async t => {
  const worktree = await tempDir(t);
  const resultRelative = '.swarm-codex-result-abc123.json';
  const fileResult = { filesChanged: ['output.txt'], notes: 'from the result file' };
  await fs.writeFile(path.join(worktree, resultRelative), JSON.stringify(fileResult));
  assert.deepEqual(await codexResultFile(worktree, resultRelative), fileResult);
  const resolved = await resolveCodexEnvelope('not valid json at all', worktree, resultRelative, { outputs: ['output.txt'] });
  assert.deepEqual(resolved, { result: fileResult, fallback: 'result-file' });
});

test('missing reply JSON and no result file falls back to the worktree\'s changed outputs, excluding non-output files', async t => {
  const root = await gitRepo(t, { 'output.txt': 'committed output', 'other.txt': 'unassigned source' });
  await fs.writeFile(path.join(root, 'output.txt'), 'proposed');
  await fs.writeFile(path.join(root, 'other.txt'), 'undeclared edit');
  const resolved = await resolveCodexEnvelope('', root, '.swarm-codex-result-missing.json', { outputs: ['output.txt'] });
  assert.deepEqual(resolved, { result: { filesChanged: ['output.txt'], fallback: 'worktree' }, fallback: 'worktree' });
});

test('no reply JSON, no result file, and no changed outputs resolves to nothing (the job stays failed)', async t => {
  const root = await gitRepo(t, { 'output.txt': 'committed output' });
  const resolved = await resolveCodexEnvelope('not json', root, '.swarm-codex-result-missing.json', { outputs: ['output.txt'] });
  assert.equal(resolved, null);
  assert.equal(await codexWorktreeFallback(root, { outputs: ['output.txt'] }), null);
});

test('worktree fallback is scoped to outputs only: a dirty context file alone resolves to nothing', async t => {
  const root = await gitRepo(t, { 'input.txt': 'committed context', 'output.txt': 'committed output' });
  await fs.writeFile(path.join(root, 'input.txt'), 'dirty context');
  const job = { context: ['input.txt'], outputs: ['output.txt'] };
  assert.equal(await codexWorktreeFallback(root, job), null);
  const resolved = await resolveCodexEnvelope('not json', root, '.swarm-codex-result-missing.json', job);
  assert.equal(resolved, null);
});

test('worktree fallback with both a dirty output and a dirty context file reports exactly the output', async t => {
  const root = await gitRepo(t, { 'input.txt': 'committed context', 'output.txt': 'committed output' });
  await fs.writeFile(path.join(root, 'input.txt'), 'dirty context');
  await fs.writeFile(path.join(root, 'output.txt'), 'dirty output');
  const job = { context: ['input.txt'], outputs: ['output.txt'] };
  const resolved = await resolveCodexEnvelope('not json', root, '.swarm-codex-result-missing.json', job);
  assert.deepEqual(resolved, { result: { filesChanged: ['output.txt'], fallback: 'worktree' }, fallback: 'worktree' });
});

test('an unfenced reply with two top-level objects returns the later one, not the first (lastTopLevelObject)', () => {
  const text = `For example, a reply might look like {"notes":"example"}.\nHere is the actual result:\n${ac27Reply}\n`;
  assert.deepEqual(parseCodexReply(text), JSON.parse(ac27Reply));
});

test('an unfenced reply where the last top-level candidate is invalid JSON falls back to the earlier valid one', () => {
  const text = `${ubBuildReply}\nA trailing aside: {oops: true,}\n`;
  assert.deepEqual(parseCodexReply(text), JSON.parse(ubBuildReply));
});
