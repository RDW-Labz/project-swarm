// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const env = { OPENAI_API_KEY: 'sk-secret-must-not-ship', SWARM_CONFIG: process.env.SWARM_CONFIG };
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const completion = n => ({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: `output ${n}` + '\n' }] }) } });

test('a mixed local and ssh run finishes after the ssh host dies mid-job', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-executors-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'original\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', 'input.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  let remoteRunning = false;
  let gate = null;
  const opened = new Promise(resolve => { gate = resolve; });
  const seen = [];
  const state = await runManifest(root, {
    version: 1,
    concurrency: 2,
    hosts: [
      { id: 'local', kind: 'local', capacity: 1, heartbeatMs: 30 },
      { id: 'dev2', kind: 'ssh', target: 'worker@dev2', capacity: 1, heartbeatMs: 30 },
    ],
    jobs: [0, 1].map(n => ({ id: `job-${n}`, agent: 'ollama', model: 'test-model', prompt: `Write out/${n}.txt`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 5000 })),
  }, {
    env,
    heartbeatMs: 30,
    fetchImpl: async (_url, options) => {
      const match = /out\/(\d+)\.txt/.exec(String(options?.body ?? ''));
      assert.ok(match, 'request names its output');
      if (gate) { const pending = opened; gate = null; await pending; }
      return reply(completion(Number(match[1])));
    },
    hostTransport: {
      async ping(host) { return host.id !== 'dev2' || !remoteRunning; },
      async run(placement) {
        seen.push(placement.env);
        remoteRunning = true;
        gate?.();
        if (placement.signal.aborted) throw Object.assign(new Error(`host-dead: ${placement.host.id}`), { code: 'host-dead' });
        await new Promise((resolve, reject) => {
          const fail = () => reject(Object.assign(new Error(`host-dead: ${placement.host.id}`), { code: 'host-dead' }));
          if (placement.signal.aborted) fail();
          else placement.signal.addEventListener('abort', fail, { once: true });
        });
      },
    },
  });
  assert.equal(state.status, 'complete', state.error);
  const moved = state.jobs.find(job => job.hostUses?.includes('dev2'));
  assert.ok(moved, 'a job was placed on ssh');
  assert.equal(moved.hostUses.at(-1), 'local');
  assert.equal(state.jobs.filter(job => job.status === 'complete').length, 2);
  assert.equal(seen.some(shipped => shipped && Object.prototype.hasOwnProperty.call(shipped, 'OPENAI_API_KEY')), false);
  for (const job of state.jobs) {
    const text = await fs.readFile(path.join(root, job.workspace, job.outputs[0]), 'utf8');
    assert.match(text, /^output \d+\n$/);
  }
});
