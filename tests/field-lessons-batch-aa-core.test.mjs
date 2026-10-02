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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeApi, API_AGENTS } from '../tools/api-adapters.mjs';
import { responseFinishReason } from '../tools/openrouter.mjs';
import { validateManifest } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const isolate = fileURLToPath(new URL('./_isolate-config.mjs', import.meta.url));
const stamp = '2000-01-01T00:00:00.000Z';
const json = value => JSON.stringify(value) + '\n';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const job = (extra = {}) => ({ id: '9001', agent: 'openrouter', model: 'model9001', prompt: '9001', context: [], outputs: ['9001.txt'], ...extra });
const manifest = extra => ({ version: 1, jobs: [job(extra)] });
const envelope = { summary: '9001', files: [{ path: '9001.txt', content: '9002' }], edits: [] };
const chat = (reason, content = JSON.stringify(envelope)) => ({ model: 'model9001', choices: [{ finish_reason: reason, message: { content } }] });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'aa9001-')));
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
  const saveRun = async () => {
    const jobs = [job({ agent: 'claude' }), job({ id: '9002', agent: 'claude', outputs: ['9002.txt'] })];
    const state = {
      version: 1, id: 'run-0000', root, status: 'blocked', startedAt: stamp, finishedAt: stamp,
      jobs: jobs.map((entry, index) => ({
        id: entry.id, agent: entry.agent, model: entry.model, status: index ? 'blocked' : 'complete',
        outputs: entry.outputs, workspace: '.swarm/workspaces/run-0000/' + entry.id,
        baseHashes: { [entry.outputs[0]]: hash(index ? '9002' : '9001') },
      })),
    };
    await write('.swarm/runs/run-0000/state.json', json(state));
    await write('.swarm/runs/run-0000/manifest.json', json({ version: 1, jobs }));
    for (const entry of jobs) {
      await write('.swarm/runs/run-0000/' + entry.id + '/response.txt', '{}\n');
      await write('.swarm/workspaces/run-0000/' + entry.id + '/' + entry.outputs[0], '9003');
    }
    return state;
  };
  return { root, write, read, cli, program, saveRun };
}
function parsed(result) {
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

describe('L324 integrate argv', () => {
  test('L324 --jobs integrates only the named complete job in all four argv forms', async t => {
    for (const args of [
      ['run-0000', '--jobs', '9001'], ['--jobs', '9001', 'run-0000'],
      ['run-0000', '--jobs=9001'], ['--jobs=9001', 'run-0000'],
    ]) {
      const f = await fixture(t);
      await f.saveRun();
      const result = parsed(await f.cli('integrate', ...args));
      assert.deepEqual(result.integratedJobs, ['9001']);
      assert.deepEqual(result.skippedJobs, ['9002']);
      assert.deepEqual(result.files, ['9001.txt']);
      assert.equal(await f.read('9001.txt'), '9003');
      assert.equal(await f.read('9002.txt'), '9002');
    }
  });

  test('L324 partial run without --jobs refuses and names the flag', async t => {
    const f = await fixture(t);
    await f.saveRun();
    const result = await f.cli('integrate', 'run-0000');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--jobs/);
    assert.equal(await f.read('9001.txt'), '9001');
    const blocked = await f.cli('integrate', 'run-0000', '--jobs', '9002');
    assert.match(blocked.stderr, /Job not complete: 9002/);
    const multiple = await f.cli('integrate', '--jobs=9001,9002', 'run-0000');
    assert.match(multiple.stderr, /Job not complete: 9002/);
  });

  test('L324 malformed --jobs never falls back to integrating every job', async t => {
    const f = await fixture(t);
    for (const args of [['--jobs'], ['--jobs='], ['--jobs', '9001,'], ['--jobs', '9001', '--jobs', '9002']]) {
      const result = await f.cli('integrate', 'run-0000', ...args);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--jobs requires/);
    }
  });

  test('L324 every documented integrate flag is accepted by the real parser', async t => {
    const f = await fixture(t);
    await f.saveRun();
    const flags = new Set(['--no-flake-check']);
    for (const file of ['README.md', 'CHANGELOG.md']) {
      const text = await fs.readFile(new URL('../' + file, import.meta.url), 'utf8');
      for (const paragraph of text.split(/\n\s*\n|\n(?=- )/)) {
        let integrate = false;
        for (const match of paragraph.matchAll(/\x60([^\x60\n]+)\x60/g)) {
          const code = match[1];
          if (/^(?:swarm )?integrate\b/.test(code)) integrate = true;
          else if (/^(?:swarm )?(?:run|validate|preflight|inspect|ship|mutants|scout|sweep|ask|lesson|go|redcheck|doctor|wait|git|node|cargo)\b/.test(code)) integrate = false;
          // Runner examples such as node --test describe checks, not integrate flags.
          if (integrate && !/\b(?:node|cargo|pytest|vitest|jest|mocha)\s*$/.test(paragraph.slice(0, match.index))) {
            if (/^(?:swarm )?integrate\b|^--/.test(code)) {
              for (const token of code.matchAll(/--[a-z][a-z-]*/g)) flags.add(token[0]);
            }
          }
        }
      }
    }
    assert.ok(flags.has('--jobs'), '1.42.0 advertises --jobs but does not parse it');
    const values = { '--jobs': '9002', '--mutants-file': '9001.json', '--mutant-check': '["9001"]' };
    for (const flag of flags) {
      await f.saveRun();
      const result = await f.cli('integrate', 'run-0000', flag, ...(values[flag] ? [values[flag]] : []));
      assert.doesNotMatch(result.stderr + result.stdout, /Invalid arguments|requires a value/, flag);
      if (flag === '--jobs') assert.match(result.stderr, /Job not complete: 9002/);
    }
    const unknown = await f.cli('integrate', 'run-0000', '--unknown9001');
    assert.match(unknown.stderr, /Invalid arguments/);
  });
});

describe('L325 output byte caps', () => {
  test('L325 openrouter refuses an oversized output before dispatch', async t => {
    const f = await fixture(t);
    await f.write('9001.txt', 'é'.repeat(7681));
    await f.write('9001.json', json(manifest()));
    for (const command of ['validate', 'run']) {
      const result = await f.cli(command, '9001.json');
      assert.equal(result.code, 1);
      assert.match(result.stderr, /output-cap-exceeded/);
      assert.match(result.stderr, /9001.txt: 15362 bytes/);
      assert.ok(JSON.parse(result.stderr).error.endsWith('route this job to agent codex (edits in place) or split the outputs'));
    }
  });

  test('L325 every API model uses the total cap and lists contributing files', async t => {
    const f = await fixture(t);
    const outputs = Array.from({ length: 5 }, (_, i) => (9001 + i) + '.txt');
    for (const file of outputs) await f.write(file, '9'.repeat(12289));
    for (const agent of API_AGENTS) {
      await f.write('9001.json', json(manifest({ agent, outputs })));
      const result = await f.cli('validate', '9001.json');
      assert.equal(result.code, 1, agent);
      assert.match(result.stderr, /total 61445 bytes/);
      for (const file of outputs) assert.ok(result.stderr.includes(file + ': 12289 bytes'), file);
    }
  });

  test('L325 exact boundaries and nonexistent outputs pass', async t => {
    const f = await fixture(t);
    const outputs = ['9001.txt', '9002.txt', '9003.txt', '9004.txt', 'missing9001.txt'];
    for (const file of outputs.slice(0, 4)) await f.write(file, '9'.repeat(15360));
    await f.write('9001.json', json(manifest({ outputs })));
    assert.equal(parsed(await f.cli('validate', '9001.json')).status, 'valid');
  });

  test('L325 config cap and job override use the existing config loader', async t => {
    const f = await fixture(t);
    await f.write('config9001.json', json({ outputCap: { total: 3, perFile: 3 } }));
    await f.write('9001.json', json(manifest()));
    assert.match((await f.cli('validate', '9001.json')).stderr, /output-cap-exceeded/);
    await f.write('9001.json', json(manifest({ outputCapBytes: { total: 4, perFile: 4 } })));
    assert.equal(parsed(await f.cli('validate', '9001.json')).status, 'valid');
    await f.write('9001.txt', '9'.repeat(15361));
    await f.write('config9001.json', json({ outputCap: { total: 20000, perFile: 20000 } }));
    await f.write('9001.json', json(manifest()));
    assert.equal(parsed(await f.cli('validate', '9001.json')).status, 'valid');
    await f.write('9001.json', json(manifest({ outputCapBytes: { total: 4, perFile: 4 } })));
    assert.match((await f.cli('validate', '9001.json')).stderr, /output-cap-exceeded/);
  });

  test('L325 malformed job and config caps fail with invalid-output-cap', async t => {
    for (const cap of [null, [], {}, { total: 1 }, { total: 0, perFile: 1 }, { total: 1, perFile: -1 }, { total: 1.5, perFile: 1 }, { total: '4', perFile: 4 }]) {
      assert.throws(() => validateManifest(manifest({ outputCapBytes: cap })), { code: 'invalid-output-cap' });
    }
    const f = await fixture(t);
    await f.write('config9001.json', json({ outputCap: { total: 1, perFile: false } }));
    await f.write('9001.json', json(manifest()));
    assert.match((await f.cli('validate', '9001.json')).stderr, /invalid-output-cap/);
  });

  test('L325 codex and claude shell jobs bypass output caps', async t => {
    const f = await fixture(t);
    await f.write('9001.txt', '9'.repeat(61441));
    await f.write('config9001.json', json({ outputCap: { total: 1, perFile: 1 } }));
    for (const extra of [{ agent: 'codex' }, { agent: 'claude' }, { agent: 'claude', shell: true }]) {
      await f.write('9001.json', json(manifest({ ...extra, outputCapBytes: { total: 1, perFile: 1 } })));
      assert.equal(parsed(await f.cli('validate', '9001.json')).status, 'valid');
    }
  });

  test('L325 help documents selection, defaults and override fields', async t => {
    const f = await fixture(t);
    const help = await f.cli('--help');
    assert.equal(help.code, 0);
    for (const text of ['--jobs <id,...>', '61440', '15360', 'outputCapBytes', 'outputCap', 'output-cap-exceeded']) assert.ok(help.stdout.includes(text), text);
  });
});

describe('L325 finishReason', () => {
  test('L325 extracts only string finish_reason or stop_reason metadata', () => {
    assert.equal(responseFinishReason(chat('length')), 'length');
    assert.equal(responseFinishReason({ stop_reason: 'max_tokens' }), 'max_tokens');
    assert.equal(responseFinishReason({ finish_reason: 'stop' }), 'stop');
    for (const body of [null, {}, { stop_reason: 9001 }, { choices: [{ finish_reason: {} }] }]) assert.equal(responseFinishReason(body), null);
  });

  test('L325 records failed, missing, Anthropic and retry finish reasons from fake fetch', async t => {
    const f = await fixture(t);
    const env = { OPENROUTER_API_KEY: '900190019001', LAMBDA_API_KEY: '900190019001', SWARM_LOGS_DIR: path.join(f.root, 'logs9001') };
    for (const scenario of [
      { agent: 'openrouter', bodies: [chat('length', '9001')], expected: 'length', status: 'failed' },
      { agent: 'openrouter', bodies: [chat('length', ''), chat('stop')], expected: 'stop', status: 'complete', retry: true },
      { agent: 'openrouter', bodies: [chat('length', ''), {}], expected: null, status: 'failed' },
      { agent: 'lambda', bodies: [{ stop_reason: 'max_tokens' }], expected: 'max_tokens', status: 'failed' },
      { agent: 'lambda', bodies: [chat('stop')], expected: 'stop', status: 'complete' },
      { agent: 'lambda', bodies: [{}], expected: null, status: 'failed' },
    ]) {
      let requests = 0;
      const recorded = [], limits = [];
      const result = await executeApi(job({ agent: scenario.agent }), [], {
        env, now: () => new Date(stamp), onFinishReason: reason => { recorded.push(reason); },
        fetchImpl: async (_url, options) => {
          if (options.method === 'GET') return new Response(json({ data: [{ id: 'model9001', pricing: { prompt: '0', completion: '0' } }] }));
          limits.push(JSON.parse(options.body).max_tokens);
          assert.ok(requests < scenario.bodies.length, 'unexpected extra request');
          return new Response(json(scenario.bodies[requests++]));
        },
      });
      assert.equal(result.status, scenario.status, result.error);
      assert.equal(result.finishReason, scenario.expected);
      assert.equal(recorded.at(-1), scenario.expected);
      assert.equal(requests, scenario.bodies.length);
      if (scenario.retry) {
        assert.equal(result.retriedForLength, true);
        assert.deepEqual(recorded, [null, 'length', null, 'stop']);
        assert.deepEqual(limits, [8192, 16384]);
      }
    }
  });

  test('L325 finishReason does not retain echoed credentials', async t => {
    const f = await fixture(t);
    const recorded = [];
    const result = await executeApi(job(), [], {
      env: { OPENROUTER_API_KEY: '900190019001', SWARM_LOGS_DIR: path.join(f.root, 'logs9001') },
      now: () => new Date(stamp), onFinishReason: reason => { recorded.push(reason); },
      fetchImpl: async (_url, options) => new Response(json(options.method === 'GET'
        ? { data: [{ id: 'model9001', pricing: { prompt: '0', completion: '0' } }] }
        : chat('900190019001'))),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.finishReason, null);
    assert.deepEqual(recorded, [null]);
    assert.ok(!JSON.stringify(result).includes('900190019001'));
  });

  test('L325 finishReason persists each response to state and inspect reads legacy null', async t => {
    const f = await fixture(t);
    const result = await f.program([
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      'import assert from "node:assert/strict";',
      'import {runManifest} from ' + JSON.stringify(pathToFileURL(runner).href) + ';',
      'const root = process.env.FIXTURE9001_ROOT;',
      'const statePath = path.join(root, ".swarm/runs/run-0000/state.json");',
      'let requests = 0; const reasons = [];',
      'const result = await runManifest(root, ' + JSON.stringify(manifest()) + ', {',
      ' id: "run-0000", liveDir: path.join(root, "live9001"),',
      ' fetchImpl: async (_url, options) => {',
      '  if (options.method === "GET") return new Response(JSON.stringify({data:[{id:"model9001",pricing:{prompt:"0",completion:"0"}}]}));',
      '  if (requests++) return new Response(JSON.stringify(' + JSON.stringify(chat('content_filter', '9001')) + '));',
      '  return new Response(JSON.stringify(' + JSON.stringify(chat('length', '')) + '));',
      ' },',
      ' onState: state => { reasons.push(state.jobs[0]?.finishReason); if (state.jobs[0]?.finishReason === "length") assert.equal(state.jobs[0].status, "running"); },',
      '});',
      'const state = JSON.parse(await fs.readFile(statePath, "utf8"));',
      'assert.equal(requests, 2);',
      'assert.ok(reasons.includes("length"), "first request must be saved before retry");',
      'assert.equal(state.jobs[0].finishReason, "content_filter");',
      'console.log(JSON.stringify({status: result.status, finishReason: state.jobs[0].finishReason}));',
    ].join('\n'));
    assert.equal(parsed(result).finishReason, 'content_filter');
    const inspectResult = await f.cli('inspect', 'run-0000');
    assert.equal(inspectResult.code, 1, inspectResult.stderr + inspectResult.stdout);
    const inspected = JSON.parse(inspectResult.stdout);
    assert.equal(inspected.jobs[0].finishReason, 'content_filter');
    const state = JSON.parse(await f.read('.swarm/runs/run-0000/state.json'));
    delete state.jobs[0].finishReason;
    await f.write('.swarm/runs/run-0000/state.json', json(state));
    const legacyInspectResult = await f.cli('inspect', 'run-0000');
    assert.equal(legacyInspectResult.code, 1, legacyInspectResult.stderr + legacyInspectResult.stdout);
    assert.equal(JSON.parse(legacyInspectResult.stdout).jobs[0].finishReason, null);
  });
});
