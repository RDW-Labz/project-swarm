// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { execute, plainClaudeJobEnv } from '../tools/swarm/core-41.mjs';

function fakeKey() {
  return 'zz'.repeat(12);
}

test('plainClaudeJobEnv omits ambient paid keys but keeps other variables', () => {
  const key = fakeKey();
  const parent = { PATH: '/bin', HOME: '/tmp/home', ANTHROPIC_API_KEY: key, SWARM_CLAUDE_WORKER_API_KEY: key };
  const child = plainClaudeJobEnv(parent);
  assert.equal('ANTHROPIC_API_KEY' in child, false);
  assert.equal('SWARM_CLAUDE_WORKER_API_KEY' in child, false);
  assert.equal(child.PATH, '/bin');
  assert.equal(child.HOME, '/tmp/home');
});

test('execute strips paid keys from plain claude child env when parent has them', async () => {
  const key = fakeKey();
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedWorker = process.env.SWARM_CLAUDE_WORKER_API_KEY;
  process.env.ANTHROPIC_API_KEY = key;
  process.env.SWARM_CLAUDE_WORKER_API_KEY = key;
  try {
    let captured;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = { end() {}, on() {}, destroy() {} };
    const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{}' });
    const spawnImpl = (program, _args, options) => {
      assert.equal(program, 'claude');
      captured = options.env;
      queueMicrotask(() => {
        child.stdout.write(`${resultLine}\n`);
        child.emit('close', 0);
      });
      return child;
    };
    const job = { agent: 'claude', model: 'sonnet', context: [], outputs: [], timeoutMs: 5000 };
    const result = await execute(job, '/tmp/wt', 'hello', { spawnImpl });
    assert.equal(result.status, 'complete');
    assert.equal('ANTHROPIC_API_KEY' in captured, false);
    assert.equal('SWARM_CLAUDE_WORKER_API_KEY' in captured, false);
  } finally {
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedWorker === undefined) delete process.env.SWARM_CLAUDE_WORKER_API_KEY;
    else process.env.SWARM_CLAUDE_WORKER_API_KEY = savedWorker;
  }
});
