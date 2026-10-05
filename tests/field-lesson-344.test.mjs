// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const isolate = fileURLToPath(new URL('./_isolate-config.mjs', import.meta.url));
const json = value => JSON.stringify(value) + '\n';
const job = (extra = {}) => ({ id: '9001', agent: 'openrouter', model: 'model9001', prompt: '9001', context: [], outputs: ['9001.txt'], ...extra });
const manifest = extra => ({ version: 1, jobs: [job(extra)] });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'l344-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), value);
  };
  await write('9001.txt', '9001');
  // Local command protocol only: a fake git/gh so the root's own git-info reads get a quiet
  // answer without ever touching a real repository.
  const fake = '#!' + process.execPath + '\n' + [
    "(async () => {",
    "const args = process.argv.slice(2);",
    "const root = process.env.FIXTURE344_ROOT;",
    "const out = text => process.stdout.write(text);",
    "if (args.includes('--version')) out('9 9001\\n');",
    "else if (args[0] === 'rev-parse') out((args.includes('HEAD') ? '9'.repeat(40) : root) + '\\n');",
    "else if (['remote', 'config', 'check-ignore'].includes(args[0])) process.exitCode = 1;",
    "else if (!['diff', 'status', 'log', 'show'].includes(args[0])) process.exitCode = 1;",
    "})();",
  ].join('\n');
  for (const command of ['git', 'gh']) {
    await write('bin/' + command, fake);
    await fs.chmod(path.join(root, 'bin', command), 0o755);
  }
  const env = {
    ...process.env, PATH: path.join(root, 'bin') + path.delimiter + path.dirname(process.execPath),
    FIXTURE344_ROOT: root, SWARM_OPENROUTER_NO_KEYCHAIN: '1', OPENROUTER_API_KEY: '900190019001',
  };
  const cli = async (...args) => {
    try {
      return { code: 0, ...await exec(process.execPath, ['--import', isolate, runner, '--root', root, ...args], { cwd: root, env, maxBuffer: 2 ** 20 }) };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return { root, write, cli };
}

test('L344 unknown field editOutputs suggests outputs with the extra sentence', async t => {
  const f = await fixture(t);
  await f.write('9001.json', json(manifest({ editOutputs: ['9001.txt'] })));
  const result = await f.cli('validate', '9001.json');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown job field: editOutputs \(did you mean outputs\?/);
  assert.match(result.stderr, /there is no editOutputs field\)/);
});

test('L344 unknown field contxt suggests context with no extra sentence', async t => {
  const f = await fixture(t);
  await f.write('9001.json', json(manifest({ contxt: [] })));
  const result = await f.cli('validate', '9001.json');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown job field: contxt \(did you mean context\?\)/);
  assert.ok(!result.stderr.includes('there is no'));
});

test('L344 unknown field zzzz keeps the plain message with no suggestion', async t => {
  const f = await fixture(t);
  await f.write('9001.json', json(manifest({ zzzz: true })));
  const result = await f.cli('validate', '9001.json');
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('Unknown job field: zzzz'));
  assert.ok(!result.stderr.includes('did you mean'));
});

test('L344 a valid manifest with only known fields still validates', async t => {
  const f = await fixture(t);
  await f.write('9001.json', json(manifest()));
  const result = await f.cli('validate', '9001.json');
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'valid');
  assert.equal(parsed.jobs[0].id, '9001');
});
