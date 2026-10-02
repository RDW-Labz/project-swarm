// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  prepareWorkspaceEnvironment, createAdapterLogSink, CODEX_BLIP_RE, runCodexWithRetry,
  codexProfile, codexMessage, parseCodexReply,
} from '../tools/codex-adapter.mjs';
import { shellProfile, shellMessage } from '../tools/claude-shell.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const withheld = '[transcript withheld: job declared privateData: true]\n';
async function fixture(t) {
  const base = process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir();
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'blip9001-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worktree = path.join(root, 'output9001'), home = path.join(root, 'legacy9001');
  await fs.mkdir(worktree);
  await fs.mkdir(home);
  return { root, worktree, home };
}
const profiles = options => [
  codexProfile({ commonDir: path.join(options.root, '9001'), metadataDir: path.join(options.root, '9002'), ...options }),
  shellProfile({ commonDir: path.join(options.root, '9001'), shellDir: path.join(options.root, '9002'), proxyPort: 9001, ...options }),
];
async function snapshot(file) {
  try { return { hash: digest(await fs.readFile(file)), mode: (await fs.stat(file)).mode & 0o777 }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

describe('T81 adapter workspace environments', () => {
  test('T81 linked dependencies are readable executable and never writable', async t => {
    const options = await fixture(t);
    const { root, worktree, home } = options;
    for (const name of ['.venv', 'node_modules']) await fs.mkdir(path.join(root, name));
    const result = await prepareWorkspaceEnvironment(root, worktree, { home });
    assert.deepEqual(result, { environmentReadPaths: [path.join(root, '.venv'), path.join(root, 'node_modules')], setupResult: null });
    for (const name of ['.venv', 'node_modules']) {
      assert.equal((await fs.lstat(path.join(worktree, name))).isSymbolicLink(), true);
      assert.equal(await fs.realpath(path.join(worktree, name)), path.join(root, name));
    }
    assert.deepEqual(await prepareWorkspaceEnvironment(root, worktree, { home }), result);
    for (const profile of profiles({ ...options, environmentReadPaths: result.environmentReadPaths, tmpRoots: [root] })) {
      for (const dependency of result.environmentReadPaths) {
        const read = '(allow file-read* (subpath "' + dependency + '"))';
        const exec = '(allow process-exec (subpath "' + dependency + '"))';
        const deny = '(deny file-write* (subpath "' + dependency + '"))';
        assert.ok(profile.includes(read));
        assert.ok(profile.includes(exec));
        assert.ok(profile.indexOf(read) > profile.indexOf('(deny file-read* process-exec'));
        assert.ok(profile.indexOf(deny) > profile.lastIndexOf('(allow file-write*'));
        assert.ok(profile.indexOf(deny) > profile.indexOf('(deny file-write* (require-not'));
        assert.ok(profile.indexOf(deny) < profile.lastIndexOf('(deny file-read* file-write*'));
      }
      const metadata = profile.split('\n').filter(line => line.startsWith('(allow file-read-metadata ')).join('\n');
      for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
        assert.ok(metadata.includes('(literal "' + ancestor + '")'));
        if (ancestor === path.parse(ancestor).root) break;
      }
      assert.ok(!profile.includes('(allow file-read* (subpath "' + root + '"))'));
    }
    const explicitWritable = path.join(worktree, '9003');
    for (const profile of profiles({ ...options, environmentReadPaths: [explicitWritable] })) {
      assert.ok(profile.indexOf('(deny file-write* (subpath "' + explicitWritable + '"))') > profile.lastIndexOf('(allow file-write*'));
    }
  });

  test('T81 local dependency directories survive and aliases resolve canonically', async t => {
    const { root, worktree, home } = await fixture(t);
    await fs.mkdir(path.join(root, '9001'));
    await fs.symlink(path.join(root, '9001'), path.join(root, '.venv'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.mkdir(path.join(worktree, 'node_modules'));
    await fs.writeFile(path.join(worktree, 'node_modules', '9001'), '9001');
    const result = await prepareWorkspaceEnvironment(root, worktree, { home });
    assert.deepEqual(result.environmentReadPaths, [path.join(root, '9001')]);
    assert.equal(await fs.readFile(path.join(worktree, 'node_modules', '9001'), 'utf8'), '9001');
    assert.equal((await fs.lstat(path.join(worktree, 'node_modules'))).isDirectory(), true);
  });

  test('T81 rejects conflicting links files broken aliases and denied credentials before linking', async t => {
    for (const kind of ['file', 'conflict', 'broken', 'denied', 'custom']) {
      const { root, worktree, home } = await fixture(t);
      await fs.mkdir(path.join(root, '.venv'));
      const source = path.join(root, 'node_modules'), destination = path.join(worktree, 'node_modules');
      let config = {};
      if (kind === 'denied' || kind === 'custom') {
        const target = path.join(home, kind === 'denied' ? '.ssh' : '9001');
        await fs.mkdir(target);
        await fs.symlink(target, source);
        if (kind === 'custom') config = { deniedHomeDirs: ['9001'] };
      } else {
        await fs.mkdir(source);
        if (kind === 'file') await fs.writeFile(destination, '9001');
        else await fs.symlink(path.join(root, kind === 'broken' ? '9001' : 'legacy9001'), destination);
      }
      await assert.rejects(prepareWorkspaceEnvironment(root, worktree, { home, config }), error => {
        assert.equal(error.code, 'workspace-env-invalid');
        assert.equal(error.path, kind === 'denied' || kind === 'custom' ? source : destination);
        return true;
      });
      await assert.rejects(fs.lstat(path.join(worktree, '.venv')), { code: 'ENOENT' });
    }
    const options = await fixture(t);
    for (const profile of [codexProfile, shellProfile]) {
      assert.throws(() => profile({ ...options, commonDir: options.root, metadataDir: options.root, shellDir: options.root, proxyPort: 9001, environmentReadPaths: [path.join(options.home, '.ssh')] }), /denied home/);
    }
  });

  test('T81 sync precedes worker and never follows root dependency links', async t => {
    const { root, worktree, home } = await fixture(t);
    for (const marker of ['pyproject.toml', 'package-lock.json']) await fs.writeFile(path.join(worktree, marker), '');
    for (const name of ['.venv', 'node_modules']) await fs.mkdir(path.join(root, name));
    const calls = [];
    const result = await prepareWorkspaceEnvironment(root, worktree, {
      home, sync: true,
      runSetup: async argv => {
        calls.push(argv);
        for (const name of ['.venv', 'node_modules']) await assert.rejects(fs.lstat(path.join(worktree, name)), { code: 'ENOENT' });
        return { status: 'passed', exitCode: 0 };
      },
    });
    assert.deepEqual(calls, [['uv', 'sync', '--locked'], ['npm', 'ci']]);
    assert.deepEqual(result, { environmentReadPaths: [], setupResult: { status: 'passed', exitCode: 0 } });
    await fs.symlink(path.join(root, 'node_modules'), path.join(worktree, 'node_modules'));
    await assert.rejects(prepareWorkspaceEnvironment(root, worktree, { home, sync: true, runSetup: () => assert.fail('installer followed a root link') }), { code: 'workspace-env-invalid', path: path.join(worktree, 'node_modules') });
  });

  test('T81 sync stops on a failed setup and missing markers are a no-op', async t => {
    const { root, worktree, home } = await fixture(t);
    assert.deepEqual(await prepareWorkspaceEnvironment(root, worktree, { home, sync: true }), { environmentReadPaths: [], setupResult: null });
    assert.deepEqual(await prepareWorkspaceEnvironment(root, worktree, { home }), { environmentReadPaths: [], setupResult: null });
    for (const marker of ['pyproject.toml', 'package-lock.json']) await fs.writeFile(path.join(worktree, marker), '');
    const calls = [], failed = { status: 'failed', exitCode: 2, tail: '9001' };
    const result = await prepareWorkspaceEnvironment(root, worktree, { home, sync: true, runSetup: async argv => { calls.push(argv); return failed; } });
    assert.deepEqual(calls, [['uv', 'sync', '--locked']]);
    assert.equal(result.setupResult, failed);
    assert.deepEqual(result.environmentReadPaths, []);
  });
});

describe('T81 adapter streaming evidence', () => {
  test('T81 failed fake codex leaves streaming evidence', async t => {
    const { root } = await fixture(t);
    const directory = path.join(root, '.swarm', 'runs', 'run-0000', 'blip9001');
    const sink = await createAdapterLogSink(directory);
    t.after(() => sink.close());
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    for (const stream of ['stderr', 'stdout']) {
      assert.equal(await fs.readFile(path.join(directory, stream + '.txt'), 'utf8'), '');
      child[stream].on('data', chunk => sink.write(stream, chunk));
    }
    let close;
    child.once('close', () => { close = sink.close(); });
    child.stderr.emit('data', Buffer.from('Reconnecting... '));
    child.stderr.emit('data', Buffer.from('5/5\n9001\n'));
    child.stdout.emit('data', Buffer.from('9002\n'));
    // The append must already exist before close, including the terminating chunk.
    assert.equal(await fs.readFile(path.join(directory, 'stderr.txt'), 'utf8'), 'Reconnecting... 5/5\n9001\n');
    assert.equal(await fs.readFile(path.join(directory, 'stdout.txt'), 'utf8'), '9002\n');
    child.emit('close', 1);
    await close;
    assert.equal(await fs.readFile(path.join(directory, 'stderr.txt'), 'utf8'), 'Reconnecting... 5/5\n9001\n');
    const retry = await createAdapterLogSink(directory);
    retry.write('stderr', '9003\n');
    await retry.close();
    assert.equal(await fs.readFile(path.join(directory, 'stderr.txt'), 'utf8'), 'Reconnecting... 5/5\n9001\n9003\n');
  });

  test('T81 stream sink preserves arbitrary bytes and a final partial key prefix', async t => {
    const { root } = await fixture(t);
    const sink = await createAdapterLogSink(root, { workerKey: '90019002' });
    const bytes = Buffer.from([0, 255, 195, 169, 13, 10]);
    sink.write('stdout', bytes.subarray(0, 3));
    sink.write('stdout', bytes.subarray(3));
    sink.write('stderr', '900');
    await sink.close();
    assert.deepEqual(await fs.readFile(path.join(root, 'stdout.txt')), bytes);
    assert.equal(await fs.readFile(path.join(root, 'stderr.txt'), 'utf8'), '900');
  });

  test('T81 thrown spawn leaves both empty streams and close is idempotent', async t => {
    const { root } = await fixture(t);
    const sink = await createAdapterLogSink(root);
    const spawn = () => { throw Error('9001'); };
    try { assert.throws(spawn, /9001/); } finally { await sink.close(); }
    await sink.close();
    for (const stream of ['stderr', 'stdout']) assert.equal((await fs.readFile(path.join(root, stream + '.txt'))).length, 0);
  });

  test('T81 privacy withholds streams and rolling redaction spans every key boundary', async t => {
    const { root } = await fixture(t);
    const key = '900190029003';
    for (let split = 1; split < key.length; split++) {
      const directory = path.join(root, String(9000 + split));
      const sink = await createAdapterLogSink(directory, { workerKey: key });
      sink.write('stderr', '9004:' + key.slice(0, split));
      sink.write('stdout', Buffer.from('9005:' + key));
      assert.equal(await fs.readFile(path.join(directory, 'stderr.txt'), 'utf8'), '9004:');
      sink.write('stderr', key.slice(split) + ':' + key + ':900');
      await sink.close();
      assert.equal(await fs.readFile(path.join(directory, 'stderr.txt'), 'utf8'), '9004:[worker-key-redacted]:[worker-key-redacted]:900');
      assert.equal(await fs.readFile(path.join(directory, 'stdout.txt'), 'utf8'), '9005:[worker-key-redacted]');
    }
    const privateDir = path.join(root, '9000');
    const privateSink = await createAdapterLogSink(privateDir, { privateData: true, workerKey: key });
    for (const stream of ['stderr', 'stdout']) privateSink.write(stream, key + '9004');
    await privateSink.close();
    for (const stream of ['stderr', 'stdout']) assert.equal(await fs.readFile(path.join(privateDir, stream + '.txt'), 'utf8'), withheld);
  });

  test('T81 log failures identify the stream and never follow evidence symlinks', async t => {
    for (const stream of ['stderr', 'stdout']) {
      const { root } = await fixture(t);
      await fs.mkdir(path.join(root, stream + '.txt'));
      await assert.rejects(createAdapterLogSink(root), { code: 'adapter-log-failed', stream });
    }
    const { root } = await fixture(t);
    const target = path.join(root, '9001');
    await fs.writeFile(target, '9001');
    await fs.symlink(target, path.join(root, 'stderr.txt'));
    await assert.rejects(createAdapterLogSink(root), { code: 'adapter-log-failed', stream: 'stderr' });
    assert.equal(await fs.readFile(target, 'utf8'), '9001');
  });
});

describe('T81 codex retry and prompt guidance', () => {
  test('T81 codex retries only blips with zero written outputs', async t => {
    const { root } = await fixture(t);
    const output = path.join(root, 'output9001.txt');
    const blip = 'workspace routing discovery failed';
    for (const mutation of ['unchanged', 'modified', 'created', 'deleted', 'mode']) {
      if (mutation === 'created') await fs.rm(output, { force: true });
      else { await fs.writeFile(output, '9001'); await fs.chmod(output, 0o644); }
      const baseline = await snapshot(output);
      const calls = [], reasons = [];
      const result = await runCodexWithRetry(async index => {
        calls.push(index);
        if (mutation === 'modified' || mutation === 'created') await fs.writeFile(output, '9002');
        if (mutation === 'deleted') await fs.rm(output);
        if (mutation === 'mode') await fs.chmod(output, 0o755);
        if (index === 1) {
          assert.deepEqual(reasons, ['codex-blip: ' + blip]);
          assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '9001.json'), 'utf8')), { retries: 1, retryReason: 'codex-blip: ' + blip });
        }
        return { status: 'failed', stderr: blip, exitCode: 1, index };
      }, {
        hasWrittenOutputs: async () => JSON.stringify(await snapshot(output)) !== JSON.stringify(baseline),
        onRetry: async reason => {
          await fs.writeFile(path.join(root, '9001.json'), JSON.stringify({ retries: 1, retryReason: reason }));
          reasons.push(reason);
        },
      });
      assert.deepEqual(calls, mutation === 'unchanged' ? [0, 1] : [0], mutation);
      assert.equal(result.index, mutation === 'unchanged' ? 1 : 0);
      assert.equal(reasons.length, mutation === 'unchanged' ? 1 : 0);
    }
    for (const stderr of ['9001', 'ReconnectingXXX 5/5', 'Connection failed: 9001']) {
      const calls = [];
      const result = await runCodexWithRetry(async index => { calls.push(index); return { status: 'failed', stderr }; }, {
        hasWrittenOutputs: async () => false,
        onRetry: async () => assert.fail('unsigned failure retried'),
      });
      assert.deepEqual(calls, [0]);
      assert.equal(result.stderr, stderr);
    }
    for (const stderr of ['Reconnecting... 5/5', 'Connection failed: error sending request']) {
      assert.ok(CODEX_BLIP_RE.test(stderr));
      const calls = [], reasons = [];
      const result = await runCodexWithRetry(async index => {
        calls.push(index);
        return { status: index ? 'complete' : 'failed', stderr };
      }, { hasWrittenOutputs: async () => false, onRetry: async reason => { reasons.push(reason); } });
      assert.deepEqual(calls, [0, 1]);
      assert.deepEqual(reasons, ['codex-blip: ' + stderr]);
      assert.equal(result.status, 'complete');
    }
  });

  test('T81 cancellation timeout cleanup refusal and evidence failures veto retry', async () => {
    for (const extra of [
      { status: 'complete' }, { status: 'timeout' }, { status: 'cancelled' },
      { cleanupError: '9001' }, { refusedBeforeStart: true }, { terminationReason: '9001' },
      { code: 'adapter-log-failed' },
    ]) {
      const result = { status: 'failed', stderr: 'Reconnecting... 5/5', ...extra };
      const calls = [];
      assert.equal(await runCodexWithRetry(async index => { calls.push(index); return result; }, {
        hasWrittenOutputs: async () => assert.fail('ineligible attempt probed outputs'),
        onRetry: async () => assert.fail('ineligible attempt retried'),
      }), result);
      assert.deepEqual(calls, [0]);
    }
    const result = { status: 'failed', stderr: 'Reconnecting... 5/5' };
    assert.equal(await runCodexWithRetry(async () => result, {
      cancelled: async () => true, hasWrittenOutputs: async () => assert.fail('cancelled'), onRetry: async () => assert.fail('cancelled'),
    }), result);
  });

  test('T81 both shell prompts list checks and request checksRun', () => {
    const job = { context: ['output9001'], outputs: ['output9001'], prompt: '' };
    const checks = [
      { name: 'required9001', argv: ['node', 'output9001'] },
      { name: 'optional9002', argv: ['node', '9002'], integrateOnly: true },
      { name: '9003 (integrate-only: path outside this worktree)', argv: ['node', '9003'] },
      { name: '9004', argv: ['node', '{integrated}'] },
    ];
    for (const message of [codexMessage(job, { checks }), shellMessage(job, { files: job.context, checks })]) {
      assert.ok(message.includes('Manifest checks: required9001: ["node","output9001"]'));
      assert.ok(message.includes('optional9002: ["node","9002"] (not run:'));
      assert.ok(message.includes('9003 (integrate-only: path outside this worktree): ["node","9003"] (not run:'));
      assert.ok(message.includes('9004: ["node","{integrated}"] (not run:'));
      assert.ok(message.includes('Run these; fix red before you return; report checksRun.'));
      assert.ok(message.includes('Checks marked not run must stay not run'));
      assert.ok(message.includes('Do not delete files.'));
    }
    for (const message of [codexMessage(job), shellMessage(job, { files: job.context })]) {
      assert.ok(message.includes('Manifest checks: none declared; run relevant tests.'));
    }
    assert.deepEqual(parseCodexReply('{"files_changed":["output9001"],"notes":[]}'), { files_changed: ['output9001'], notes: [] });
  });
});
