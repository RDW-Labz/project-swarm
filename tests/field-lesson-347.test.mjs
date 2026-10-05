// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execute } from '../tools/swarm.mjs';
import { claudeQuotaSignal } from '../tools/cli-adapters.mjs';

const limit = "You've hit your weekly limit · resets Oct 2 at 6pm";

test('L347 successful exit ignores quoted stdout and a final stderr limit line without events', () => {
  const stdout = JSON.stringify({ text: limit });
  assert.equal(claudeQuotaSignal(stdout, `worker output\n${limit}`, 0, []), null);
});

test('L347 failed exit ignores ordinary assistant text and quoted file content', () => {
  const stdout = JSON.stringify({ text: limit });
  const events = [{ type: 'assistant', message: { content: [{ type: 'text', text: limit }] } }];
  assert.equal(claudeQuotaSignal(stdout, `${limit}\nworker failed`, 1, events), null);
});

test('L347 failed exit accepts an exact final stderr limit line without events', () => {
  assert.deepEqual(claudeQuotaSignal('', `worker failed\n${limit}`, 1, []), { resetsAt: 'Oct 2 at 6pm' });
});

async function run(t, script) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lesson-347-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'context.txt'), `assert.equal(message, ${JSON.stringify(limit)}); // line 243`);
  return execute({ agent: 'claude', model: 'sonnet', context: ['context.txt'], outputs: [], timeoutMs: 5000 }, root, 'Read context.', {
    spawnImpl: (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', script], options),
  });
}

test('L347 a successful worker quoting a literal limit from context completes normally', async t => {
  const result = await run(t, `import fs from 'node:fs';
    const content = fs.readFileSync('context.txt', 'utf8');
    console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',content}]}}));
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:content}]}}));
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:content}));`);
  assert.equal(result.status, 'complete');
  assert.equal(result.resetsAt, undefined);
});

test('L347 genuine provider error events retain provider-limit classification', async t => {
  const result = await run(t, `console.log(JSON.stringify({type:'assistant',error:'rate_limit',message:{content:[{type:'text',text:${JSON.stringify(limit)}}]}})); process.exitCode=1;`);
  assert.equal(result.status, 'provider-limit');
  assert.equal(result.resetsAt, 'Oct 2 at 6pm');
});

test('L347 only a standalone final stderr limit line on failure is accepted', async t => {
  const result = await run(t, `console.error(${JSON.stringify(limit)}); process.exitCode=1;`);
  assert.equal(result.status, 'provider-limit');
  const quoted = await run(t, `console.error('assert.equal(message, ' + ${JSON.stringify(limit)} + '); line 243'); process.exitCode=1;`);
  assert.equal(quoted.status, 'failed');
  const earlier = await run(t, `console.error(${JSON.stringify(limit)}); console.error('worker failed'); process.exitCode=1;`);
  assert.equal(earlier.status, 'failed');
});
