// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { blockedNoteFromReply, git } from '../tools/codex-adapter.mjs';
import { executeCodexJob } from '../tools/swarm.mjs';

const job = extra => ({ id: 'writer', agent: 'codex', model: 'test-model', context: ['input.txt'], outputs: ['src/one.txt'], prompt: 'Update the file.', timeoutMs: 10000, ...extra });

async function put(root, file, text) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}

async function commit(root) {
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'codex-blocked-note-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  for (const [file, text] of Object.entries({ 'input.txt': 'context', 'src/one.txt': 'one', '.gitignore': '.swarm/\nnode_modules/\n' })) await put(root, file, text);
  await commit(root);
  return root;
}

function codexSpawn(envelope, script = '') {
  return (_command, args, options) => {
    assert.equal(_command, 'sandbox-exec');
    const resultPath = args[args.indexOf('-o') + 1];
    const body = `import fs from 'node:fs'; ${script} fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(${JSON.stringify(envelope)}));`;
    return spawn(process.execPath, ['--input-type=module', '-e', body], options);
  };
}

test('blockedNoteFromReply recognizes blocked notes and ignores non-blocked text', () => {
  assert.equal(blockedNoteFromReply({ notes: ['T-0620 status: blocked.'] }), 'T-0620 status: blocked.');
  assert.equal(blockedNoteFromReply({ notes: ['Blocked: Vitest could not create its API token'] }), 'Blocked: Vitest could not create its API token');
  assert.equal(blockedNoteFromReply({ notes: ['no blocked items here'] }), null);
  assert.equal(blockedNoteFromReply({ notes: ['Lint passed'] }), null);
  assert.equal(blockedNoteFromReply({ notes: ['not blocked'] }), null);
  assert.equal(blockedNoteFromReply({ notes: 'done' }), null);
  assert.equal(blockedNoteFromReply(null), null);
});

test('complete with blocked note and unchanged outputs becomes blocked', async t => {
  const root = await fixture(t);
  const directory = '.swarm/runs/blocked-note';
  await fs.mkdir(path.join(root, directory), { recursive: true });
  const proposal = path.join(root, '.swarm/proposal');
  await fs.mkdir(proposal, { recursive: true });
  const envelope = { files_changed: [], notes: ['Blocked: Vitest could not create its API token'] };
  const result = await executeCodexJob(root, directory, job(), proposal, {
    env: process.env, portBase: 4600, cancelled: () => false, platform: 'darwin',
    spawnImpl: codexSpawn(envelope),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'blocked: Blocked: Vitest could not create its API token');
});

test('complete with blocked note stays complete when outputs changed', async t => {
  const root = await fixture(t);
  const directory = '.swarm/runs/blocked-changed';
  await fs.mkdir(path.join(root, directory), { recursive: true });
  const proposal = path.join(root, '.swarm/proposal-changed');
  await fs.mkdir(proposal, { recursive: true });
  const envelope = { files_changed: ['src/one.txt'], notes: ['Blocked: should not downgrade'] };
  const result = await executeCodexJob(root, directory, job(), proposal, {
    env: process.env, portBase: 4601, cancelled: () => false, platform: 'darwin',
    spawnImpl: codexSpawn(envelope, "fs.writeFileSync('src/one.txt', 'changed');"),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.error, null);
});

test('missing-output blocked envelope uses note when summary is absent', async t => {
  const root = await fixture(t);
  const directory = '.swarm/runs/blocked-missing';
  await fs.mkdir(path.join(root, directory), { recursive: true });
  const proposal = path.join(root, '.swarm/proposal-missing');
  await fs.mkdir(proposal, { recursive: true });
  const envelope = { status: 'blocked', notes: ['T-0620 status: blocked.'] };
  const result = await executeCodexJob(root, directory, job(), proposal, {
    env: process.env, portBase: 4602, cancelled: () => false, platform: 'darwin',
    spawnImpl: codexSpawn(envelope, "try { fs.unlinkSync('src/one.txt'); } catch {}"),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'blocked: T-0620 status: blocked.');
});

test('complete without changes adds completed-without-changes warning', async t => {
  const root = await fixture(t);
  const directory = '.swarm/runs/no-change';
  await fs.mkdir(path.join(root, directory), { recursive: true });
  const proposal = path.join(root, '.swarm/proposal-no-change');
  await fs.mkdir(proposal, { recursive: true });
  const envelope = { files_changed: [], notes: ['Lint passed'] };
  const result = await executeCodexJob(root, directory, job(), proposal, {
    env: process.env, portBase: 4603, cancelled: () => false, platform: 'darwin',
    spawnImpl: codexSpawn(envelope),
  });
  assert.equal(result.status, 'complete');
  assert.ok((result.warnings ?? []).includes('completed-without-changes: no declared output changed'));
});
