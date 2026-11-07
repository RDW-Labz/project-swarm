// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { git } from '../tools/codex-adapter.mjs';
import { executeCodexJob } from '../tools/swarm.mjs';

const job = extra => ({
  id: 'writer',
  agent: 'codex',
  model: 'test-model',
  context: ['input.txt'],
  outputs: ['src/one.txt', 'src/two.txt'],
  prompt: 'Update both files.',
  timeoutMs: 10000,
  ...extra,
});

async function put(root, file, text) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}

async function commit(root) {
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'missing-output-reask-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  for (const [file, text] of Object.entries({
    'input.txt': 'context',
    'src/one.txt': 'one',
    'src/two.txt': 'two',
    '.gitignore': '.swarm/\nnode_modules/\n',
  })) await put(root, file, text);
  await commit(root);
  return root;
}

function codexSpawnSequence(calls) {
  let index = 0;
  return (_command, args, options) => {
    assert.equal(_command, 'sandbox-exec');
    const call = calls[index++];
    assert.ok(call, `unexpected extra codex launch (${index})`);
    const resultPath = args[args.indexOf('-o') + 1];
    const body = `import fs from 'node:fs'; ${call.script ?? ''} fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(${JSON.stringify(call.envelope)}));`;
    return spawn(process.execPath, ['--input-type=module', '-e', body], options);
  };
}

async function runJob(t, calls, { cancelled, extraOptions = {} } = {}) {
  const root = await fixture(t);
  const directory = '.swarm/runs/missing-reask';
  await fs.mkdir(path.join(root, directory), { recursive: true });
  const proposal = path.join(root, '.swarm/proposal');
  await fs.mkdir(proposal, { recursive: true });
  let launches = 0;
  const spawnImpl = codexSpawnSequence(calls);
  const wrappedSpawn = (...args) => {
    launches++;
    return spawnImpl(...args);
  };
  const result = await executeCodexJob(root, directory, job(), proposal, {
    env: process.env,
    portBase: 4710,
    cancelled: cancelled ?? (() => false),
    platform: 'darwin',
    spawnImpl: wrappedSpawn,
    ...extraOptions,
  });
  return { root, proposal, result, launches };
}

const envelope = (files, notes = ['done']) => ({ files_changed: files, notes });

test('missing-output re-ask writes the missing file then completes', async t => {
  const { proposal, result, launches } = await runJob(t, [
    { envelope: envelope(['src/one.txt']), script: "fs.writeFileSync('src/one.txt', 'changed'); try { fs.unlinkSync('src/two.txt'); } catch {}" },
    { envelope: envelope(['src/one.txt', 'src/two.txt']), script: "fs.writeFileSync('src/two.txt', 'two-written');" },
  ]);
  assert.equal(launches, 2);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.missingReasked, ['src/two.txt']);
  assert.equal(await fs.readFile(path.join(proposal, 'src/one.txt'), 'utf8'), 'changed');
  assert.equal(await fs.readFile(path.join(proposal, 'src/two.txt'), 'utf8'), 'two-written');
});

test('missing-output re-ask that writes nothing fails with after one re-ask', async t => {
  const { result, launches } = await runJob(t, [
    { envelope: envelope(['src/one.txt']), script: "fs.writeFileSync('src/one.txt', 'changed'); try { fs.unlinkSync('src/two.txt'); } catch {}" },
    { envelope: envelope([]), script: '' },
  ]);
  assert.equal(launches, 2);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Missing output \(deletions are never propagated\): src\/two\.txt \(after one re-ask\)/);
  assert.deepEqual(result.missingReasked, ['src/two.txt']);
});

test('present outputs changed during missing-output re-ask are restored', async t => {
  const { result, launches } = await runJob(t, [
    { envelope: envelope(['src/one.txt']), script: "fs.writeFileSync('src/one.txt', 'changed'); try { fs.unlinkSync('src/two.txt'); } catch {}" },
    { envelope: envelope([]), script: "fs.writeFileSync('src/one.txt', 'tampered');" },
  ]);
  assert.equal(launches, 2);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /\(after one re-ask\)/);
  assert.deepEqual(result.missingReaskRestored, ['src/one.txt']);
  assert.ok(result.keptWorkspace, 'failed run keeps edited worktree');
  assert.equal(await fs.readFile(path.join(result.keptWorkspace, 'src/one.txt'), 'utf8'), 'changed');
});

test('cancelled run is not missing-output re-asked', async t => {
  const root = await fixture(t);
  const directory = '.swarm/runs/missing-reask-cancel';
  await fs.mkdir(path.join(root, directory), { recursive: true });
  const proposal = path.join(root, '.swarm/proposal-cancel');
  await fs.mkdir(proposal, { recursive: true });
  let spawnCalls = 0;
  let cancelAfterFirstSpawn = false;
  const spawnImpl = (_command, args, options) => {
    spawnCalls++;
    cancelAfterFirstSpawn = true;
    const resultPath = args[args.indexOf('-o') + 1];
    const script = "fs.writeFileSync('src/one.txt', 'changed'); try { fs.unlinkSync('src/two.txt'); } catch {}";
    const body = `import fs from 'node:fs'; ${script} fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(${JSON.stringify(envelope(['src/one.txt']))}));`;
    return spawn(process.execPath, ['--input-type=module', '-e', body], options);
  };
  const result = await executeCodexJob(root, directory, job(), proposal, {
    env: process.env,
    portBase: 4711,
    cancelled: () => cancelAfterFirstSpawn,
    platform: 'darwin',
    spawnImpl,
  });
  assert.equal(spawnCalls, 1);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Missing output \(deletions are never propagated\): src\/two\.txt/);
  assert.doesNotMatch(result.error, /\(after one re-ask\)/);
  assert.equal(result.missingReasked, undefined);
});
