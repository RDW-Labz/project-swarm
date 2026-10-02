// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { execute, inspectRun, inspectResults, readState, runCheck, runChecksForRun, parseShipFlags, PRIVATE_DATA_WITHHELD_TEXT } from '../tools/swarm.mjs';
import { parseScaffoldArgs } from '../tools/scaffold.mjs';
import { ship } from '../tools/ship.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const isolate = fileURLToPath(new URL('./_isolate-config.mjs', import.meta.url));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sha9001 = '9'.repeat(40);
const job9001 = () => ({ id: 'output9001', agent: 'claude', model: 'model9001', prompt: '9001', context: ['output9001.mjs'], outputs: ['output9001.mjs'] });
const json = value => JSON.stringify(value) + '\n';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'pipeline9001-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, data) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), data);
  };
  await write('package.json', json({ version: '0.0.0', type: 'module' }));
  await write('output9001.mjs', 'export const value = 9001;\n');
  await write('tests/uncovered9001.test.mjs', "import { value } from '../output9001.mjs';\n");
  // Every git/gh operation in the child CLI is a local protocol fake, never a real repository.
  const fake = '#!' + process.execPath + '\n' + [
    "(async () => {",
    "const fs = await import('node:fs'), path = await import('node:path');",
    "const args = process.argv.slice(2), command = path.basename(process.argv[1]);",
    "const root = process.env.FIXTURE9001_ROOT;",
    "fs.appendFileSync(path.join(root, 'calls9001.jsonl'), JSON.stringify({ command, args }) + '\\n');",
    "const out = value => process.stdout.write(value);",
    "if (args.includes('--version')) out(command + ' 9001\\n');",
    "else if (command === 'gh') {",
    "  if (args.includes('defaultBranchRef')) out('pipeline9002\\n');",
    "  else if (args.includes('visibility')) out('PRIVATE\\n');",
    "  else if (args[0] === 'api') { process.stderr.write('HTTP 404'); process.exitCode = 1; }",
    "  else { process.stderr.write('unexpected gh operation'); process.exitCode = 1; }",
    "} else {",
    "  if (args[0] === '-C') args.splice(0, 2);",
    "  if (args[0] === 'symbolic-ref' || args.includes('--abbrev-ref')) out('pipeline9001\\n');",
    "  else if (args[0] === 'rev-parse' && args.includes('HEAD')) out('9'.repeat(40) + '\\n');",
    "  else if (args[0] === 'rev-parse') out(root + '\\n');",
    "  else if (args[0] === 'ls-files') out(['output9001.mjs', 'tests/uncovered9001.test.mjs', 'package.json'].join(args.includes('-z') ? '\\0' : '\\n') + (args.includes('-z') ? '\\0' : '\\n'));",
    "  else if (args[0] === 'merge-base') out('9'.repeat(40) + '\\n');",
    "  else if (args[0] === 'check-ignore' || args[0] === 'remote' || args[0] === 'config') process.exitCode = 1;",
    "  else if (!['diff', 'status', 'log', 'show'].includes(args[0])) { process.stderr.write('unexpected git operation'); process.exitCode = 1; }",
    "}",
    "})();",
  ].join('\n');
  for (const name of ['git', 'gh']) {
    await write('bin/' + name, fake);
    await fs.chmod(path.join(root, 'bin', name), 0o755);
  }
  const env = { ...process.env, PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH, FIXTURE9001_ROOT: root };
  const cli = async (...args) => {
    try {
      const result = await exec(process.execPath, ['--import', isolate, runner, '--root', root, ...args], { env, cwd: root, maxBuffer: 2 ** 20 });
      return { code: 0, ...result };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const read = file => fs.readFile(path.join(root, file), 'utf8');
  const saveRun = async ({ status = 'failed', privateData = false, checks = [] } = {}) => {
    const job = { ...job9001(), ...(privateData ? { privateData } : {}) };
    const manifest = { version: 1, jobs: [job], checks };
    const state = {
      version: 1, id: 'run-0000', root, status, baseCommit: sha9001, integratedAt: '2000-01-01T00:00:00.000Z',
      integratedFiles: [], integratedNewFiles: [],
      jobs: [{ id: job.id, agent: job.agent, status, model: job.model, workspace: '.swarm/workspaces/run-0000/output9001', outputs: job.outputs, baseHashes: { 'output9001.mjs': hash(await read('output9001.mjs')) }, baseModes: { 'output9001.mjs': 0o644 } }],
    };
    await write('.swarm/runs/run-0000/state.json', json(state));
    await write('.swarm/runs/run-0000/manifest.json', json(manifest));
    await write('.swarm/runs/run-0000/output9001/response.txt', json({ files_changed: ['output9001.mjs'], findings: [{ code: '9001', text: '9002' }] }));
    await write('.swarm/workspaces/run-0000/output9001/output9001.mjs', await read('output9001.mjs'));
    return { state, manifest };
  };
  return { root, write, read, cli, env, saveRun };
}
const parsed = result => {
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(result.stdout, json(value));
  return value;
};
function child9001() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  return child;
}
function failingSpawn(chunks, exitCode, onSpawn = () => {}) {
  return (_program, _args, options) => {
    onSpawn(options);
    const child = child9001();
    queueMicrotask(() => {
      for (const [stream, text] of chunks) child[stream].write(text);
      child.stdout.end(); child.stderr.end(); child.emit('close', exitCode);
    });
    return child;
  };
}

describe('T81 CLI wiring', () => {
  test('T81 CLI documents new commands and retains old flags', async t => {
    const f = await fixture(t);
    const help = await f.cli('--help');
    assert.equal(help.code, 0);
    for (const token of ['ticket MANIFEST', 'scaffold job', 'scaffold pr', '--sync', '--wait-required-only', '--resume', '--commit-message', '--require-section', '--check', 'lesson add', 'lesson import', '--accept-pre-existing', '--no-flake-check', '--tag-timeout']) assert.ok(help.stdout.includes(token), token);
    for (const argv of [['ticket', '--help'], ['ticket', '-h'], ['scaffold', 'job', '--help'], ['scaffold', 'pr', '-h']]) {
      const result = await f.cli(...argv, '--root', '/9001/missing');
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
    }
    await assert.rejects(f.read('calls9001.jsonl'), { code: 'ENOENT' });
    assert.equal(parseShipFlags(['--pr', '9001.json', '--wait-required-only']).waitRequiredOnly, true);
    assert.equal(parseShipFlags(['--pr', '9001.json']).waitRequiredOnly, undefined);
    assert.throws(() => parseShipFlags(['--pr', '9001.json', '--check', '["9001"]']), /only for ship --branch/);
  });

  test('T81 new parser failures are one stdout JSON line and nonzero', async t => {
    const f = await fixture(t);
    for (const argv of [
      ['ticket'], ['ticket', '9001.json', '--pr'], ['ticket', '9001.json', '--pr', '9002.json', '--resume', 'run-0000', '--resume', 'run-0000'],
      ['scaffold'], ['scaffold', 'job', '--id', '9001', '--id', '9002'], ['scaffold', 'pr', '--from', 'run-0000', '--title', '9001', '--check', '[]'],
    ]) {
      const result = await f.cli(...argv);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, '');
      const value = JSON.parse(result.stdout);
      assert.equal(result.stdout, json(value));
      assert.equal(value.code ?? value.detail.code, argv[0] === 'ticket' ? 'ticket-args' : 'scaffold-args');
    }
    const base = ['job', '--id', '9001', '--agent', 'claude', '--model', 'model9001', '--tier', 'cheap', '--context', '9001', '--outputs', ''];
    assert.deepEqual(parseScaffoldArgs(base).outputs, []);
    assert.throws(() => parseScaffoldArgs([...base.slice(0, -1), '9001,,9002']), /empty members/);
  });

  test('T81 scaffold job covers uncovered tests and validates', async t => {
    const f = await fixture(t);
    const result = parsed(await f.cli('scaffold', 'job', '--id', 'output9001', '--agent', 'claude', '--model', 'model9001', '--tier', 'mid', '--context', 'output9001.mjs, output9001.mjs', '--outputs', 'output9001.mjs'));
    const job = result.manifest.jobs[0];
    assert.deepEqual(job.context, ['output9001.mjs']);
    assert.deepEqual(job.ignoreTests, ['tests/uncovered9001.test.mjs']);
    assert.ok(job.prompt.includes("ignoreTests: tests/uncovered9001.test.mjs — Existing test is outside this job's declared outputs; the coordinator runs it after integration."));
    assert.ok(job.prompt.endsWith('Return JSON only: {"status":"complete|partial|blocked","filesChanged":[],"reproTest":"PATH or n/a"}'));
    assert.equal(job.timeoutMs, 1800000);
    assert.deepEqual(JSON.parse(await f.read(result.file)), result.manifest);
    assert.equal(parsed(await f.cli('validate', result.file)).status, 'valid');
    const existing = await f.cli('scaffold', 'job', '--id', 'output9001', '--agent', 'claude', '--model', 'model9001', '--tier', 'mid', '--context', 'output9001.mjs', '--outputs', 'output9001.mjs');
    assert.equal(existing.code, 1);
    assert.deepEqual(JSON.parse(existing.stdout), { status: 'error', code: 'scaffold-exists', file: result.file });
  });

  test('T81 scaffold PR carries mutation stub into ship refusal', async t => {
    const f = await fixture(t);
    await f.saveRun({ status: 'complete' });
    const result = parsed(await f.cli('scaffold', 'pr', '--from', 'run-0000', '--title', '9001', '--repo', '9001/9002'));
    assert.deepEqual(Object.keys(result.payload).sort(), ['base', 'body', 'head', 'title']);
    assert.equal(result.payload.head, 'pipeline9001');
    assert.equal(result.payload.base, 'pipeline9002');
    assert.ok(result.payload.body.includes('<!-- swarm:checks -->'));
    assert.ok(result.payload.body.includes('<!-- swarm:stub mutation -->'));
    assert.ok(result.payload.body.includes('Swarm-Run: run-0000'));
    assert.ok(result.payload.body.includes('output9001.mjs'));
    assert.ok(result.payload.body.includes('9002'));
    result.payload.body = result.payload.body.replace('<!-- swarm:stub mutation -->', '9001\n<!-- swarm:stub mutation -->\n9002');
    await f.write(result.file, json(result.payload));
    const refused = await f.cli('ship', 'run-0000', '--repo', '9001/9002', '--pr', result.file, '--require-section', 'Mutation check');
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    const value = JSON.parse(refused.stdout);
    assert.equal(value.code, 'stub-section', refused.stdout);
    assert.equal(value.section, 'Mutation check');
    assert.ok(!Object.hasOwn(value, 'requiredContexts'));
    const protectedResult = await f.cli('ship', 'run-0000', '--repo', '9001/9002', '--pr', result.file, '--require-section', 'Mutation check', '--wait-required-only');
    assert.equal(protectedResult.code, 1);
    const fallback = JSON.parse(protectedResult.stdout);
    assert.equal(fallback.code, 'stub-section');
    assert.equal(fallback.requiredContexts, null);
    assert.deepEqual(fallback.pendingAtMerge, []);
    assert.equal(fallback.waitedForRequiredOnly, false);
    const calls = (await f.read('calls9001.jsonl')).trim().split('\n').map(JSON.parse);
    assert.ok(!calls.some(call => call.args.some(arg => ['push', 'merge', 'create', 'edit'].includes(arg))));
  });

  test('T81 inspect retains twenty stderr lines and legacy privacy defaults', async t => {
    const f = await fixture(t);
    await f.saveRun();
    assert.equal((await readState(f.root, 'run-0000')).jobs[0].retries, 0);
    assert.equal((await readState(f.root, 'run-0000')).jobs[0].retryReason, null);
    assert.equal((await inspectResults(f.root, 'run-0000')).jobs[0].stderrTail, null);
    const lines = Array.from({ length: 25 }, (_, i) => String(9001 + i));
    await f.write('.swarm/runs/run-0000/output9001/stderr.txt', lines.join('\r\n') + '\r\n');
    for (const args of [[], ['--results']]) {
      const result = await f.cli('inspect', 'run-0000', ...args);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stdout).jobs[0].stderrTail, lines.slice(-20).join('\n'));
    }
    await f.write('.swarm/runs/run-0000/output9001/stderr.txt', '9001'.repeat(5 * 1024 * 1024) + '\n' + lines.join('\n') + '\n');
    assert.equal((await inspectResults(f.root, 'run-0000')).jobs[0].stderrTail, lines.slice(-20).join('\n'));
    await f.saveRun({ privateData: true });
    assert.equal((await inspectResults(f.root, 'run-0000')).jobs[0].stderrTail, PRIVATE_DATA_WITHHELD_TEXT);
    assert.equal((await inspectRun(f.root, 'run-0000')).jobs[0].stderrTail, PRIVATE_DATA_WITHHELD_TEXT);
    await f.saveRun({ status: 'complete' });
    assert.ok(!Object.hasOwn((await inspectResults(f.root, 'run-0000')).jobs[0], 'stderrTail'));
  });
});

describe('T81 execution boundaries', () => {
  test('T81 failed fake codex leaves streaming evidence', async t => {
    const f = await fixture(t);
    let child, launched;
    const started = new Promise(resolve => { launched = resolve; });
    const directory = path.join(f.root, '.swarm/runs/run-0000/output9001');
    const pending = execute({ ...job9001(), agent: 'codex' }, f.root, '9001', {
      spawnImpl: () => { child = child9001(); launched(); return child; },
      cancelled: () => false, logDirectory: directory,
      codex: { worktree: f.root, profile: path.join(f.root, '9001.sb'), lastMessage: path.join(f.root, '9001.json'), resultRelative: '9001.json', env: f.env },
    });
    await started;
    child.stderr.write('9001\n');
    child.stdout.write('9002\n');
    assert.equal(await fs.readFile(path.join(directory, 'stderr.txt'), 'utf8'), '9001\n');
    assert.equal(await fs.readFile(path.join(directory, 'stdout.txt'), 'utf8'), '9002\n');
    child.stderr.write('9003\n'); child.stdout.end(); child.stderr.end(); child.emit('close', 2);
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(await fs.readFile(path.join(directory, 'stderr.txt'), 'utf8'), '9001\n9003\n');
    assert.equal(result.stderr, '9001\n9003\n');
    let spawnWasCalled = false;
    const thrown = await execute({ ...job9001(), agent: 'codex' }, f.root, '9001', {
      logDirectory: path.join(f.root, 'legacy9001'), spawnImpl: () => { spawnWasCalled = true; throw Error('9001'); },
      codex: { worktree: f.root, profile: path.join(f.root, '9001.sb'), lastMessage: path.join(f.root, '9001.json'), resultRelative: '9001.json', env: f.env },
    });
    assert.equal(spawnWasCalled, true);
    assert.equal(thrown.status, 'failed');
    for (const stream of ['stdout', 'stderr']) assert.equal(await f.read('legacy9001/' + stream + '.txt'), '');
  });

  test('T81 spawn-shaped failures cannot become pre-existing', async t => {
    const f = await fixture(t);
    await f.saveRun({ status: 'complete', checks: [{ name: 'required9001', argv: [process.execPath, '9001'] }] });
    let spawns = 0;
    const spawnImpl = failingSpawn([['stderr', 'Failed to sp'], ['stdout', 'awn: 9001\r'], ['stderr', '\n9002\n9003\n'], ['stdout', '9004\n'.repeat(1000)]], 2, options => {
      spawns++;
      assert.equal(options.cwd, f.root, 'must not probe a base worktree');
    });
    const result = await runChecksForRun(f.root, 'run-0000', { spawnImpl, env: f.env, gitImpl: async () => assert.fail('environment failures must not probe base') });
    assert.equal(result.checksPassed, false);
    assert.equal(result.checksErrored, true);
    assert.equal(result.checks[0].status, 'check-env-missing');
    assert.equal(result.checks[0].head, 'Failed to spawn: 9001\n9002\n9003');
    assert.equal(result.checks[0].origin, undefined);
    assert.equal(spawns, 2, 'only the bounded environment retry');
    await f.write('9001-pr.json', json({ title: '9001', head: 'pipeline9001', base: 'pipeline9002', body: '## What\n9001\n## Checks\n<!-- swarm:checks -->' }));
    const calls = [];
    let fakeClock9001 = 9001;
    const shipped = await ship({
      root: f.root, repo: '9001/9002', payloadPath: path.join(f.root, '9001-pr.json'), acceptPreExisting: true,
      runChecks: async () => result.checks, checkArgvs: [[process.execPath, '9001']], integratedFiles: [],
      now: () => fakeClock9001, sleep: async ms => { fakeClock9001 += ms; },
      authorEmailExec: async () => ({ stdout: '' }), commitScanExec: async () => ({ stdout: '' }),
      exec: async (file, args) => { calls.push([file, ...args]); return { code: 0, stdout: args[0] === 'rev-parse' ? sha9001 : '', stderr: '' }; },
    });
    assert.equal(shipped.status, 'checks-failed');
    assert.equal(shipped.code, 'check-env-missing');
    assert.ok(!calls.some(call => call.includes('push') || call.includes('merge') || call.includes('worktree')));
  });

  test('T81 check head excludes a fourth-line-only spawn trigger', async () => {
    const result = await runCheck('required9001', ['9001'], '/9001', 1000, failingSpawn([['stdout', '9001\n9002\n9003\nFailed to spawn: 9004\n']], 2));
    assert.equal(result.status, 'failed');
    assert.equal(result.head, '9001\n9002\n9003');
    const missing = await runCheck('required9001', ['9001'], '/9001', 1000, failingSpawn([], 127));
    assert.equal(missing.status, 'check-env-missing');
    assert.equal(missing.head, '');
  });
});

describe('T81 Codex worktree wiring', () => {
  test('T81 sync precedes worker and never follows root dependency links', async t => {
    const { executeCodexJob } = await import('../tools/swarm.mjs');
    const f = await fixture(t);
    await f.write('pyproject.toml', '[project]\nname = "9001"\nversion = "0.0.0"\n');
    await f.write('package-lock.json', '{"lockfileVersion":3}\n');
    await fs.mkdir(path.join(f.root, '.git'), { recursive: true });
    const worktree = path.join(f.root, '.swarm/runs/run-0000/worktrees/output9001');
    const order = [];
    const gitImpl = async (_cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        assert.equal(args[3], worktree);
        await fs.mkdir(path.join(worktree, '.git'), { recursive: true });
        for (const file of ['output9001.mjs', 'pyproject.toml', 'package-lock.json']) await fs.writeFile(path.join(worktree, file), await f.read(file));
        return '';
      }
      if (args.includes('--git-common-dir')) return path.join(f.root, '.git');
      if (args.includes('--absolute-git-dir')) return path.join(worktree, '.git');
      if (args[0] === 'worktree' && args[1] === 'remove') return '';
      assert.fail(JSON.stringify(args));
    };
    const spawnImpl = (program, args, options) => {
      order.push([program, ...args]);
      const child = child9001();
      if (program !== 'sandbox-exec') {
        assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
        assert.equal(options.env.SWARM_CLAUDE_WORKER_API_KEY, undefined);
      }
      queueMicrotask(() => {
        child.stdout.end(); child.stderr.end(); child.emit('close', program === 'sandbox-exec' ? 2 : 0);
      });
      return child;
    };
    const job = { ...job9001(), agent: 'codex', setup: [['9003']] };
    const options = { sync: true, gitImpl, spawnImpl, portBase: 9001, cancelled: () => false, env: f.env, swarmEnv: {} };
    const result = await executeCodexJob(f.root, '.swarm/runs/run-0000', job, path.join(f.root, '.swarm/workspaces/run-0000/output9001'), options);
    assert.equal(result.status, 'failed');
    assert.deepEqual(order.slice(0, 3), [['uv', 'sync', '--locked'], ['npm', 'ci'], ['9003']]);
    assert.equal(order[3][0], 'sandbox-exec');
    await fs.mkdir(path.join(f.root, 'node_modules'), { recursive: true });
    await fs.symlink(path.join(f.root, 'node_modules'), path.join(worktree, 'node_modules'));
    order.length = 0;
    const refused = await executeCodexJob(f.root, '.swarm/runs/run-0000', job, path.join(f.root, '.swarm/workspaces/run-0000/output9001'), options);
    assert.equal(refused.code, 'workspace-env-invalid');
    assert.equal(refused.refusedBeforeStart, true);
    assert.deepEqual(order, []);
  });

  test('T81 Codex retry call site retains failed stderr and uses fresh reply paths', async t => {
    const { executeCodexJob } = await import('../tools/swarm.mjs');
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, '.git'), { recursive: true });
    const worktree = path.join(f.root, '.swarm/runs/run-0000/worktrees/output9001');
    let attempts = 0;
    const replies = [], retries = [];
    const gitImpl = async (_cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        assert.equal(args[3], worktree);
        await fs.mkdir(path.join(worktree, '.git'), { recursive: true });
        await fs.writeFile(path.join(worktree, 'output9001.mjs'), await f.read('output9001.mjs'));
        return '';
      }
      if (args.includes('--git-common-dir')) return path.join(f.root, '.git');
      if (args.includes('--absolute-git-dir')) return path.join(worktree, '.git');
      if (args[0] === 'worktree' && args[1] === 'remove') return '';
      assert.fail(JSON.stringify(args));
    };
    const spawnImpl = (_program, args) => {
      attempts++;
      assert.equal(retries.length, attempts - 1, 'retry must be recorded before launch');
      replies.push(args[args.indexOf('-o') + 1]);
      const child = child9001();
      queueMicrotask(() => {
        child.stderr.end('workspace routing discovery failed\n');
        child.stdout.end();
        child.emit('close', 2);
      });
      return child;
    };
    const result = await executeCodexJob(f.root, '.swarm/runs/run-0000', { ...job9001(), agent: 'codex' }, path.join(f.root, '.swarm/workspaces/run-0000/output9001'), {
      gitImpl, spawnImpl, env: f.env, portBase: 9001, cancelled: () => false,
      onRetry: async reason => { retries.push(reason); },
      checks: [{ name: 'required9001', argv: ['9001'] }],
    });
    assert.equal(result.status, 'failed');
    assert.equal(attempts, 2);
    assert.equal(retries[0], 'codex-blip: workspace routing discovery failed');
    assert.notEqual(replies[0], replies[1]);
    assert.equal(await f.read('.swarm/runs/run-0000/output9001/stderr.txt'), 'workspace routing discovery failed\n'.repeat(2));
    assert.ok((await f.read('.swarm/runs/run-0000/output9001/message.txt')).includes('required9001: ["9001"]'));
  });

  test('T81 legacy state and default ship remain compatible', async t => {
    const f = await fixture(t);
    await f.saveRun({ status: 'complete' });
    const saved = JSON.parse(await f.read('.swarm/runs/run-0000/state.json'));
    assert.ok(!Object.hasOwn(saved.jobs[0], 'retries'));
    const state = await readState(f.root, 'run-0000');
    assert.equal(state.jobs[0].retries, 0);
    assert.equal(state.jobs[0].retryReason, null);
    const flags = parseShipFlags(['--pr', '9001.json', '--tag-timeout', '0', '--no-flake-check', '--accept-pre-existing']);
    assert.equal(flags.waitRequiredOnly, undefined);
    assert.equal(flags.tagTimeoutMs, 0);
    assert.equal(flags.acceptPreExisting, true);
    assert.equal(flags.noFlakeCheck, true);
  });

  test('T81 ticket dispatch preserves branch and resume refusal boundaries', async t => {
    const f = await fixture(t);
    await f.write('9001.json', json({ version: 1, jobs: [job9001()] }));
    await f.write('9002.json', json({ title: '9001', head: 'pipeline9002', base: '9003', body: '9001' }));
    const mismatch = await f.cli('ticket', '9001.json', '--pr', '9002.json');
    assert.equal(mismatch.code, 1);
    assert.equal(mismatch.stderr, '');
    assert.equal(JSON.parse(mismatch.stdout).detail.code, 'pipeline-branch-mismatch');
    const resume = await f.cli('ticket', '9001.json', '--pr', '9002.json', '--resume', 'run-0000');
    assert.equal(resume.code, 1);
    assert.equal(JSON.parse(resume.stdout).detail.code, 'pipeline-invalid');
    const calls = (await f.read('calls9001.jsonl')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(call => call.command === 'git'));
    assert.ok(!calls.some(call => call.args.includes('commit') || call.args.includes('push')));
  });
});
