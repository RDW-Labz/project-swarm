import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { askRun } from '../tools/swarm.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-test-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}

const initEvent = model => JSON.stringify({ type: 'system', subtype: 'init', model });

test('askRun rejects an empty context file before any worker launches', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  let calls = 0;
  await assert.rejects(
    askRun(root, { model: 'sonnet', context: ['empty.txt'], question: 'What is in the file?' }, {
      spawnImpl: () => {
        calls++;
        throw new Error('unexpected worker launch');
      },
    }),
    error => {
      assert.equal(error.code, 'ask-context-empty');
      assert.match(error.message, /ask: context file empty\.txt is empty/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('CLI ask with an empty context file prints one JSON error line and exits non-zero', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, '--root', root, 'ask', '--model', 'sonnet', '--context', 'empty.txt', 'What is in the file?']),
    error => {
      assert.equal(error.code, 1);
      const lines = error.stderr.trim().split('\n');
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.status, 'error');
      assert.match(parsed.error, /ask: context file empty\.txt is empty/);
      return true;
    },
  );
});

test('ask with a non-empty context file still runs like a read-only job', async t => {
  const root = await fixture(t);
  const answer = JSON.stringify({ answer: 'yes' });
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(answer)},total_cost_usd:0.03}));`;
  const result = await askRun(root, { model: 'sonnet', context: ['input.txt'], question: 'Should we ship?' }, { spawnImpl: fake(script) });
  assert.deepEqual(Object.keys(result).sort(), ['actualModel', 'contextFiles', 'costUsd', 'id', 'model', 'modelMismatch', 'result', 'status', 'warnings'].sort());
  assert.equal(result.status, 'complete');
  assert.equal(result.costUsd, 0.03);
  assert.deepEqual(result.result, { answer: 'yes' });
  assert.deepEqual(result.contextFiles, ['input.txt']);
});
