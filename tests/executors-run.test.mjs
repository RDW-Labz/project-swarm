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
import { hashBytes } from '../tools/executors.mjs';

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

async function repo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-executors-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'original\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', 'input.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}

const oneJob = extra => ({ id: 'job-0', agent: 'ollama', model: 'test-model', prompt: 'Write out/0.txt', context: ['input.txt'], outputs: ['out/0.txt'], timeoutMs: 5000, ...extra });

function pulledFile() {
  const bytes = Buffer.from('output 0\n');
  return { files: [{ path: 'out/0.txt', bytes, sha256: hashBytes(bytes) }] };
}

test('a sensitive job does not run on an untrusted sandbox', async t => {
  const root = await repo(t);
  let ran = false;
  const state = await runManifest(root, {
    version: 1,
    hosts: [{ id: 'box', kind: 'sandbox', capacity: 1, driver: ['swarm-sandbox', 'run'], heartbeatMs: 1000 }],
    jobs: [oneJob()],
  }, {
    env,
    hostTransport: { async ping() { return true; }, async run() { ran = true; return pulledFile(); } },
  });
  assert.equal(ran, false);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /host-untrusted/);
});

test('a trusted sandbox can run a sensitive job and an untrusted sandbox can run a non-sensitive one', async t => {
  const root = await repo(t);
  const trusted = await runManifest(root, {
    version: 1,
    hosts: [{ id: 'box', kind: 'sandbox', capacity: 1, driver: ['swarm-sandbox', 'run'], trusted: true, heartbeatMs: 1000 }],
    jobs: [oneJob()],
  }, { env, hostTransport: { async ping() { return true; }, async run() { return pulledFile(); } } });
  assert.equal(trusted.status, 'complete', trusted.error);
  assert.equal(trusted.jobs[0].host, 'box');
  const open = await runManifest(root, {
    version: 1,
    hosts: [{ id: 'box', kind: 'sandbox', capacity: 1, driver: ['swarm-sandbox', 'run'], heartbeatMs: 1000 }],
    jobs: [oneJob({ sensitive: false })],
  }, { env, hostTransport: { async ping() { return true; }, async run() { return pulledFile(); } } });
  assert.equal(open.status, 'complete', open.error);
  assert.equal(open.jobs[0].host, 'box');
});

test('one missed ping does not move a remote job', async t => {
  const root = await repo(t);
  let armed = false;
  let missed = false;
  const state = await runManifest(root, {
    version: 1,
    hosts: [{ id: 'dev2', kind: 'ssh', target: 'worker@dev2', capacity: 1, heartbeatMs: 30 }],
    jobs: [oneJob()],
  }, {
    env,
    heartbeatMs: 30,
    hostTransport: {
      async ping() {
        if (!armed || missed) return true;
        missed = true;
        return false;
      },
      async run(placement) {
        armed = true;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no heartbeat')), 2000);
          const poll = () => { if (missed) { clearTimeout(timer); resolve(); } else setTimeout(poll, 10); };
          poll();
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(placement.signal.aborted, false);
        return pulledFile();
      },
    },
  });
  assert.equal(state.status, 'complete', state.error);
  assert.deepEqual(state.jobs[0].hostUses, ['dev2']);
});

test('a returning host kills the orphaned job before reuse and the spend is counted', async t => {
  const root = await repo(t);
  const events = [];
  let down = false;
  const state = await runManifest(root, {
    version: 1,
    hosts: [{ id: 'dev2', kind: 'ssh', target: 'worker@dev2', capacity: 1, heartbeatMs: 20 }],
    jobs: [oneJob()],
  }, {
    env,
    heartbeatMs: 20,
    hostTransport: {
      async ping() { return !down; },
      async kill(_host, ids) {
        events.push(`kill:${ids[0]}`);
        return { costUsd: 0.4 };
      },
      async run(placement) {
        events.push('run');
        if (events.filter(event => event === 'run').length === 1) {
          down = true;
          await new Promise((resolve, reject) => {
            const fail = () => { down = false; reject(Object.assign(new Error(`host-dead: ${placement.host.id}`), { code: 'host-dead' })); };
            if (placement.signal.aborted) fail();
            else placement.signal.addEventListener('abort', fail, { once: true });
          });
        }
        return pulledFile();
      },
    },
  });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(events[0], 'run');
  assert.match(events[1], /^kill:/);
  assert.equal(events[2], 'run');
  assert.equal(state.orphanCostUsd, 0.4);
  assert.equal(state.jobs[0].hostUses.length, 2);
});
