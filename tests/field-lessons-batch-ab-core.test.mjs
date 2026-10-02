// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runCheck, runChecksForRun, swarmDirNotIgnoredWarning } from '../tools/swarm.mjs';
import { commandHandlers } from '../tools/scaffold.mjs';
import { preflightReport, ship } from '../tools/ship.mjs';
import { defaultMaxOutputTokens } from '../tools/openrouter.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const isolate = fileURLToPath(new URL('./_isolate-config.mjs', import.meta.url));
const stamp = '2000-01-01T00:00:00.000Z';
const json = value => JSON.stringify(value) + '\n';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const job = (extra = {}) => ({ id: '9001', agent: 'openrouter', model: 'model9001', prompt: '9001', context: [], outputs: ['9001.txt'], ...extra });
const manifest = extra => ({ version: 1, jobs: [job(extra)] });

async function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 946684800000 });
  t.mock.method(globalThis, 'fetch', async () => { throw Error('unexpected network'); });
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'ab9001-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), value);
  };
  const read = file => fs.readFile(path.join(root, file), 'utf8');
  await write('9001.txt', '9001');
  await write('9002.txt', '9002');
  await write('package.json', json({ version: '0.0.0', type: 'module' }));
  await write('config9001.json', '{}');
  // Local command protocol only: never initialize or operate on a real repository.
  const fake = '#!' + process.execPath + '\n' + [
    "(async () => {",
    "const fs = await import('node:fs'), path = await import('node:path');",
    "const args = process.argv.slice(2), command = path.basename(process.argv[1]);",
    "const root = process.env.FIXTURE9001_ROOT;",
    "if (args[0] === '-C') args.splice(0, 2);",
    "const out = text => process.stdout.write(text);",
    "if (command === 'codex') { process.stderr.write('unexpected worker'); process.exitCode = 1; }",
    "else if (args.includes('--version')) out(command + ' 9001\\n');",
    "else if (command === 'gh') { if (args.includes('visibility')) out('PRIVATE\\n'); else process.exitCode = 1; }",
    "else if (args[0] === 'rev-parse') {",
    "  out(args.includes('HEAD') ? '9'.repeat(40) + '\\n' : root + '\\n');",
    "}",
    "else if (args[0] === 'ls-files') {",
    "  const files = fs.readdirSync(root).filter(file => /^(900[0-9]+\\.txt|package\\.json)$/.test(file));",
    "  out(files.join(args.includes('-z') ? '\\0' : '\\n') + (args.includes('-z') ? '\\0' : '\\n'));",
    "}",
    "else if (['remote', 'config', 'check-ignore'].includes(args[0])) process.exitCode = 1;",
    "else if (!['diff', 'status', 'log', 'show'].includes(args[0])) { process.stderr.write('unexpected git operation'); process.exitCode = 1; }",
    "})();",
  ].join('\n');
  for (const command of ['git', 'gh', 'codex']) {
    await write('bin/' + command, fake);
    await fs.chmod(path.join(root, 'bin', command), 0o755);
  }
  await write('preload9001.mjs', [
    "import path from 'node:path';",
    "const root = process.env.FIXTURE9001_ROOT;",
    "process.env.SWARM_CONFIG = path.join(root, 'config9001.json');",
    "process.env.SWARM_LOGS_DIR = path.join(root, 'logs9001');",
    "const RealDate = Date;",
    "globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2000-01-01T00:00:00.000Z'])); } static now() { return 946684800000; } };",
    "globalThis.fetch = async () => { throw Error('unexpected network'); };",
  ].join('\n'));
  const env = {
    ...process.env, PATH: path.join(root, 'bin') + path.delimiter + path.dirname(process.execPath),
    FIXTURE9001_ROOT: root, SWARM_OPENROUTER_NO_KEYCHAIN: '1',
    OPENROUTER_API_KEY: '900190019001', SWARM_CLAUDE_WORKER_API_KEY: '',
  };
  const node = async args => {
    try {
      return { code: 0, ...await exec(process.execPath, ['--import', isolate, '--import', path.join(root, 'preload9001.mjs'), ...args], { cwd: root, env, maxBuffer: 2 ** 20 }) };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const cli = (...args) => node([runner, '--root', root, ...args]);
  const program = code => node(['--input-type=module', '-e', code]);
  const saveRun = async ({ checks = [], onlyBlocked = false } = {}) => {
    const jobs = onlyBlocked ? [job({ agent: 'claude' })] : [job({ agent: 'claude' }), job({ id: '9002', agent: 'claude', outputs: ['9002.txt'] })];
    const state = {
      version: 1, id: 'run-0000', root, status: 'blocked', startedAt: stamp, finishedAt: stamp,
      jobs: jobs.map((entry, index) => ({
        id: entry.id, agent: entry.agent, model: entry.model, status: index || onlyBlocked ? 'blocked' : 'complete',
        outputs: entry.outputs, workspace: '.swarm/workspaces/run-0000/' + entry.id,
        baseHashes: { [entry.outputs[0]]: hash(index ? '9002' : '9001') },
      })),
    };
    await write('.swarm/runs/run-0000/state.json', json(state));
    await write('.swarm/runs/run-0000/manifest.json', json({ version: 1, jobs, checks }));
    for (const entry of jobs) {
      await write('.swarm/runs/run-0000/' + entry.id + '/response.txt', '{}\n');
      if (!onlyBlocked && entry.id === '9001') await write('.swarm/workspaces/run-0000/' + entry.id + '/' + entry.outputs[0], '9003');
    }
    return state;
  };
  return { root, write, read, cli, program, saveRun, env };
}
function parsed(result) {
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}


const warningCode = (result, code) => (result.warnings ?? []).filter(warning => typeof warning === 'string' ? warning.includes(code) : warning.code === code);
function fakeCheck(chunks, code = 1) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      for (const [stream, text] of chunks) child[stream].write(text);
      child.stdout.end(); child.stderr.end(); child.emit('close', code);
    });
    return child;
  };
}

describe('L327 command handlers', () => {
  test('L327 scaffold command follows lesson import dispatch', async t => {
    const f = await fixture(t);
    await f.write('tools/lessons-publish.mjs', 'export {};\n');
    const result = parsed(await f.cli('scaffold', 'job', '--id', '9001', '--agent', 'claude', '--model', 'model9001', '--tier', 'mid', '--context', '9001.txt', '--outputs', '9002.txt', '--command', 'swarm lesson import --dry-run'));
    assert.deepEqual(result.manifest.jobs[0].context, ['9001.txt', 'tools/lessons-publish.mjs']);
    const handlers = await commandHandlers();
    assert.deepEqual(handlers.get('lesson import'), ['tools/lessons-publish.mjs']);
    assert.ok(handlers.get('lesson').includes('tools/lessons.mjs'));
    assert.ok(handlers.has('integrate'));
    const unknown = await f.cli('scaffold', 'job', '--id', '9002', '--agent', 'claude', '--model', 'model9001', '--tier', 'mid', '--context', '9001.txt', '--outputs', '9002.txt', '--command', 'unknown9001');
    assert.equal(unknown.code, 1);
    assert.equal(JSON.parse(unknown.stdout).code, 'scaffold-invalid');
  });

  test('L327 validate warns only when the named handler is undeclared', async t => {
    const f = await fixture(t);
    await f.write('tools/lessons-publish.mjs', 'export {};\n');
    for (const prompt of ['wire \x60lesson import --dry-run\x60', 'swarm lesson import --dry-run']) {
      for (const place of ['missing', 'context', 'outputs']) {
        await f.write('9001.json', json(manifest({
          agent: 'claude', prompt,
          context: place === 'context' ? ['tools/lessons-publish.mjs'] : [],
          outputs: place === 'outputs' ? ['tools/lessons-publish.mjs'] : ['9001.txt'],
        })));
        const warnings = warningCode(parsed(await f.cli('validate', '9001.json')), 'command-handler-not-in-job');
        assert.equal(warnings.length, place === 'missing' ? 1 : 0);
        if (warnings.length) assert.equal(warnings[0].path, 'tools/lessons-publish.mjs');
      }
    }
    await f.write('9001.json', json(manifest({ agent: 'claude', prompt: '9001 \x60unknown9001\x60' })));
    assert.deepEqual(warningCode(parsed(await f.cli('validate', '9001.json')), 'command-handler-not-in-job'), []);
  });
});

describe('L328 skipped job outputs', () => {
  test('L328 accept-blocked skips unwritten blocked outputs', async t => {
    const f = await fixture(t);
    await f.saveRun();
    const refused = await f.cli('integrate', 'run-0000');
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Only a complete/);
    assert.equal(await f.read('9001.txt'), '9001');
    const result = parsed(await f.cli('integrate', 'run-0000', '--accept-blocked'));
    assert.equal(result.status, 'integrated');
    assert.deepEqual(result.files, ['9001.txt']);
    assert.equal(await f.read('9001.txt'), '9003');
    assert.equal(await f.read('9002.txt'), '9002');
    assert.deepEqual(warningCode(result, 'output-never-written'), []);
  });

  test('L328 selected jobs skip absent unselected workspaces', async t => {
    const f = await fixture(t);
    await f.saveRun();
    const result = parsed(await f.cli('integrate', 'run-0000', '--jobs', '9001'));
    assert.deepEqual(result.files, ['9001.txt']);
    assert.deepEqual(result.integratedJobs, ['9001']);
    assert.deepEqual(result.skippedJobs, ['9002']);
    assert.equal(await f.read('9002.txt'), '9002');
  });

  test('L328 blocked-only run integrates nothing', async t => {
    const f = await fixture(t);
    await f.saveRun({ onlyBlocked: true });
    const result = parsed(await f.cli('integrate', 'run-0000', '--accept-blocked'));
    assert.equal(result.status, 'integrated');
    assert.deepEqual(result.files, []);
    assert.equal(await f.read('9001.txt'), '9001');
  });

  test('L328 blocked writes still integrate while unwritten blocked deletes are skipped', async t => {
    const f = await fixture(t);
    await f.saveRun();
    await f.write('.swarm/workspaces/run-0000/9002/9002.txt', '9004');
    const saved = JSON.parse(await f.read('.swarm/runs/run-0000/manifest.json'));
    saved.jobs[1].outputs.push('9003.txt');
    saved.jobs[1].deletes = ['9003.txt'];
    await f.write('9003.txt', '9003');
    await f.write('.swarm/runs/run-0000/manifest.json', json(saved));
    const state = JSON.parse(await f.read('.swarm/runs/run-0000/state.json'));
    state.jobs[1].outputs = saved.jobs[1].outputs;
    state.jobs[1].baseHashes['9003.txt'] = hash('9003');
    await f.write('.swarm/runs/run-0000/state.json', json(state));
    const result = parsed(await f.cli('integrate', 'run-0000', '--accept-blocked'));
    // Lesson 131: what a blocked job did write still integrates; only its unwritten outputs skip.
    assert.deepEqual(result.files, ['9001.txt', '9002.txt']);
    assert.equal(await f.read('9002.txt'), '9004');
    assert.equal(await f.read('9003.txt'), '9003');
  });
});

describe('L330 check output', () => {
  test('L330 integrate ignores two swarm error lines and warns once', async t => {
    const f = await fixture(t);
    const text = '.swarm/runs/run-0000/9001.mjs:1 error 9001\n.swarm/runs/run-0000/9002.mjs:2 error 9002\n';
    await f.saveRun({ checks: [{ name: '9001', argv: [process.execPath, '-e', 'process.stderr.write(' + JSON.stringify(text) + '); process.exitCode = 1;'] }] });
    const result = parsed(await f.cli('integrate', 'run-0000', '--accept-blocked'));
    assert.equal(result.checksPassed, true);
    assert.equal(result.checks[0].status, 'passed');
    assert.equal(result.checks[0].tail, '');
    assert.equal(result.checks[0].swarmLineCount, 2);
    assert.equal(warningCode(result, 'check-hit-swarm-dir').length, 1);
    assert.match(warningCode(result, 'check-hit-swarm-dir')[0], /\b2\b/);
  });

  test('L330 real errors remain failures even outside the retained tail', async t => {
    const f = await fixture(t);
    const text = '9001.mjs:1 error 9001\n' + '.swarm/runs/run-0000/9002.mjs:2 error 9002\n'.repeat(200);
    await f.saveRun({ checks: [{ name: '9001', argv: [process.execPath, '-e', 'process.stdout.write(' + JSON.stringify(text) + '); process.exitCode = 1;'] }] });
    const raw = await f.cli('integrate', 'run-0000', '--accept-blocked');
    assert.equal(raw.code, 1);
    const result = JSON.parse(raw.stdout);
    assert.equal(result.checksPassed, false);
    assert.equal(result.checks[0].status, 'failed');
    assert.match(result.checks[0].tail, /9001.mjs:1 error/);
    assert.equal(result.checks[0].swarmLineCount, 200);
    assert.equal(warningCode(result, 'check-hit-swarm-dir').length, 1);
  });

  test('L330 filter handles chunks ANSI absolute paths and missing final newline', async t => {
    const f = await fixture(t);
    const result = await runCheck('9001', ['9001'], f.root, 1000, fakeCheck([
      ['stderr', '\x1b[31m.sw'], ['stderr', 'arm/runs/run-0000/9001: error\x1b[0m\n'],
      ['stdout', path.join(f.root, '.swarm/runs/run-0000/9002') + ': error'],
    ]), false, () => {}, f.env, { ignoreSwarmPaths: true });
    assert.equal(result.status, 'passed');
    assert.equal(result.swarmLineCount, 2);
    const silent = await runCheck('9001', ['9001'], f.root, 1000, fakeCheck([]), false, () => {}, f.env, { ignoreSwarmPaths: true });
    assert.equal(silent.status, 'failed');
    const missing = await runCheck('9001', ['9001'], f.root, 1000, fakeCheck([['stdout', '.swarm/runs/run-0000/9001: error\n']], 127), false, () => {}, f.env, { ignoreSwarmPaths: true });
    assert.equal(missing.status, 'check-env-missing');
  });

  test('L330 run warns swarm-dir-not-ignored only when a root config never names .swarm', async t => {
    const f = await fixture(t);
    assert.equal(await swarmDirNotIgnoredWarning(f.root), null);
    await f.write('pyproject.toml', '[project]\nname = "9001"\n');
    assert.equal(await swarmDirNotIgnoredWarning(f.root), null);
    await f.write('eslint.config.mjs', 'export default [];\n');
    assert.match(await swarmDirNotIgnoredWarning(f.root), /^swarm-dir-not-ignored: eslint\.config\.mjs/);
    await f.write('eslint.config.mjs', "export default [{ ignores: ['.swarm/**'] }];\n");
    assert.equal(await swarmDirNotIgnoredWarning(f.root), null);
  });

  test('L330 ship reports the same filtered check warning', async t => {
    const f = await fixture(t);
    await f.saveRun({ checks: [{ name: '9001', argv: [process.execPath, '9001'] }] });
    await f.write('9001-pr.json', json({ title: '9001', head: '9001', base: '9002', body: '## Checks\n<!-- swarm:checks -->' }));
    for (const realError of [false, true]) {
      let time = 9001;
      const output = '.swarm/runs/run-0000/9001: error\n.swarm/runs/run-0000/9002: error\n' + (realError ? '9001.mjs:1 error\n' : '');
      const checks = await runChecksForRun(f.root, 'run-0000', { env: f.env, spawnImpl: fakeCheck([['stderr', output]]) });
      const result = await ship({
        root: f.root, repo: '9001/9002', payloadPath: path.join(f.root, '9001-pr.json'),
        env: f.env, runChecks: async () => checks.checks, checkArgvs: [[process.execPath, '9001']],
        now: () => time, sleep: async ms => { time += ms; }, merge: false,
        authorEmailExec: async () => ({ code: 0, stdout: '' }), commitScanExec: async () => ({ code: 0, stdout: '' }),
        exec: async (_file, args) => ({ code: ['push', 'merge-base'].includes(args[0]) ? 1 : 0, stdout: args[0] === 'rev-parse' ? '9'.repeat(40) : '', stderr: '' }),
      });
      assert.equal(result.checks[0].status, realError ? 'failed' : 'passed');
      assert.equal(result.status === 'checks-failed', realError);
      assert.equal(warningCode(result, 'check-hit-swarm-dir').length, 1);
      assert.match(warningCode(result, 'check-hit-swarm-dir')[0], /\b2\b/);
    }
  });
});

describe('L331 ignored fixture preflight', () => {
  test('L331 missing runtime paths pass while existing ignored fixtures fail', async t => {
    const f = await fixture(t);
    const file = 'tests/9001.test.mjs';
    const calls = [];
    const exec = async (_program, args) => {
      calls.push(args);
      return { code: args[0] === 'merge-base' ? 1 : 0, stdout: '', stderr: '' };
    };
    const options = {
      root: f.root, payloadBase: '9001', exec, env: f.env, integratedFiles: [file],
      authorEmailExec: async () => ({ code: 0, stdout: '' }), commitScanExec: async () => ({ code: 0, stdout: '' }),
    };
    await f.write(file, "const value = '.swarm/runs/run-0000/state.json';\n");
    assert.equal((await preflightReport(options)).ok, true);
    assert.ok(!calls.some(args => args[0] === 'check-ignore'));
    await f.write('fixtures/secret.json', '{}');
    await f.write(file, "const value = 'fixtures/secret.json';\n");
    const report = await preflightReport(options);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some(failure => failure.code === 'test-reads-git-ignored-path'));
    assert.equal((await preflightReport({ ...options, exemptions: [{ guard: 'git-ignored-fixture', file, reason: '9001' }] })).ok, true);
    assert.equal((await preflightReport({ ...options, exec: async (_program, args) => ({ code: args[0] === 'check-ignore' || args[0] === 'merge-base' ? 1 : 0, stdout: '', stderr: '' }) })).ok, true);
  });
});

describe('L332 model output defaults', () => {
  test('L332 warns below the model default from the real table and not at it', async t => {
    const f = await fixture(t);
    // Lesson 226: a reasoning model's own default (deepseek/deepseek-r1: 16000 from the real
    // table in tools/openrouter.mjs) covers its thinking plus its reply; placeholder test model
    // names (e.g. 'model9001') are not in that table and have no default to assert against.
    const model = 'deepseek/deepseek-r1';
    const modelDefault = defaultMaxOutputTokens(model);
    assert.equal(modelDefault, 16000, 'reasoning default covers thinking (lesson 226)');
    for (const maxOutputTokens of [modelDefault - 1, modelDefault, undefined]) {
      const payload = '.swarm-manifests/9001-payload.md';
      await f.write(payload, '9001');
      await f.write('9001.json', json(manifest({ model, outputs: [payload], ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) })));
      const warnings = warningCode(parsed(await f.cli('validate', '9001.json')), 'max-output-below-model-default');
      assert.equal(warnings.length, maxOutputTokens === modelDefault - 1 ? 1 : 0, String(maxOutputTokens));
      if (warnings.length) {
        assert.equal(warnings[0].modelDefault, modelDefault);
        assert.match(warnings[0].message, new RegExp('\\b' + (modelDefault - 1) + '\\b'));
        assert.match(warnings[0].message, new RegExp('\\b' + modelDefault + '\\b'));
      }
    }
    await f.write('9001.json', json(manifest({ agent: 'claude', maxOutputTokens: 6000 })));
    const invalid = await f.cli('validate', '9001.json');
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /maxOutputTokens is API-only/);
  });

  test('L332 help documents every new flag and warning', async t => {
    const f = await fixture(t);
    const help = await f.cli('--help');
    assert.equal(help.code, 0);
    for (const text of ['--command', '--accept-blocked', '--jobs', 'command-handler-not-in-job', 'check-hit-swarm-dir', 'git-ignored-fixture', 'max-output-below-model-default']) assert.ok(help.stdout.includes(text), text);
    assert.ok((await f.cli('ship', '--help')).stdout.includes('check-hit-swarm-dir'));
    assert.ok((await f.cli('scaffold', 'job', '--help')).stdout.includes('--command'));
  });
});
