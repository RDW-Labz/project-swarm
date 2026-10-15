// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateEnvelope, EDIT_RULE } from '../tools/api-adapters.mjs';
import { runManifest } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const edit = (file, find, replace) => ({ path: file, find, replace });
const env = { SWARM_CONFIG: process.env.SWARM_CONFIG };

test('several edits to one path are valid; a path in both files and edits is not', () => {
  const outputs = ['a.txt', 'b.txt'];
  const ok = validateEnvelope({ summary: 's', files: [{ path: 'b.txt', content: 'B' }], edits: [edit('a.txt', 'x', 'y'), edit('a.txt', 'y', 'z')] }, outputs);
  assert.equal(ok.edits.length, 2);
  assert.throws(() => validateEnvelope({ summary: 's', files: [{ path: 'a.txt', content: 'A' }], edits: [edit('a.txt', 'x', 'y'), edit('b.txt', 'q', 'r')] }, outputs), /"a\.txt" is in both files and edits/);
  assert.throws(() => validateEnvelope({ summary: 's', files: [], edits: [edit('a.txt', 'x', 'y')] }, outputs), /every declared output exactly once/);
  assert.throws(() => validateEnvelope({ summary: 's', files: [], edits: [edit('c.txt', 'x', 'y')] }, outputs), /not in declared outputs/);
  assert.throws(() => validateEnvelope({ summary: 's', files: [], edits: [edit('a.txt', '', 'y'), edit('b.txt', 'q', 'r')] }, outputs), /find cannot be empty/);
  const many = Array.from({ length: 201 }, (_, n) => edit('a.txt', `f${n}`, `r${n}`));
  assert.throws(() => validateEnvelope({ summary: 's', files: [{ path: 'b.txt', content: 'B' }], edits: many }, outputs), /too many edits/);
  assert.equal(validateEnvelope({ summary: 's', files: [{ path: 'b.txt', content: 'B' }], edits: many.slice(0, 200) }, outputs).edits.length, 200);
});

async function project(t, content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-multi-edit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'src.txt'), content);
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', 'src.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}
const manifest = agent => ({ version: 1, concurrency: 1, jobs: [{ id: 'edit-job', agent, model: 'test-model', prompt: 'Change src.txt.', context: ['src.txt'], outputs: ['src.txt'], timeoutMs: 5000 }] });
const ollama = edits => async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'edited', files: [], edits }) } }), { headers: { 'content-type': 'application/json' } });
const workspaceFile = (root, state) => fs.readFile(path.join(root, state.jobs[0].workspace, 'src.txt'), 'utf8');

test('an API job applies several edits to one file in order, each on the result of the last', async t => {
  const root = await project(t, 'one two three\n');
  // The second find only exists after the first edit has been applied.
  const state = await runManifest(root, manifest('ollama'), { env, fetchImpl: ollama([edit('src.txt', 'one', 'ONE'), edit('src.txt', 'ONE two', 'ONE 2'), edit('src.txt', 'three', '3')]) });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(await workspaceFile(root, state), 'ONE 2 3\n');
});

test('if any edit does not apply, the job fails and the file is left as it was', async t => {
  const root = await project(t, 'one two three\n');
  const state = await runManifest(root, manifest('ollama'), { env, fetchImpl: ollama([edit('src.txt', 'one', 'ONE'), edit('src.txt', 'missing text', 'x')]) });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /edit-no-match: src\.txt \(edit 2 of 2\)/);
  assert.equal(await workspaceFile(root, state), 'one two three\n');
  const multi = await runManifest(root, manifest('ollama'), { env, fetchImpl: ollama([edit('src.txt', 'o', '0')]) });
  assert.match(multi.jobs[0].error, /edit-multiple-match: src\.txt$/);
});

test('API and Hermes workers are both told the edit rule', async t => {
  const root = await project(t, 'one\n');
  let body = '';
  await runManifest(root, manifest('ollama'), { env, fetchImpl: async (_url, options) => { body = String(options.body); return ollama([edit('src.txt', 'one', 'two')])(); } });
  assert.ok(JSON.parse(body).messages[0].content.includes(EDIT_RULE));
  const hermes = await runManifest(root, manifest('hermes'), { env, spawnImpl: () => spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: ['pipe', 'pipe', 'pipe'] }) });
  const message = await fs.readFile(path.join(root, '.swarm/runs', hermes.id, 'edit-job', 'message.txt'), 'utf8');
  assert.ok(message.includes(EDIT_RULE));
});

test('a Hermes job that answers with edits has them applied (they used to be dropped silently)', async t => {
  const root = await project(t, 'one two three\n');
  const envelope = { summary: 'edited', files: [], edits: [edit('src.txt', 'one', '1'), edit('src.txt', 'three', '3')] };
  const result = { type: 'result', exit_code: 0, text: JSON.stringify(envelope), tokens: { input: 5, output: 5 } };
  const state = await runManifest(root, manifest('hermes'), {
    env, spawnImpl: () => spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)}));`], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(await workspaceFile(root, state), '1 two 3\n');
});
