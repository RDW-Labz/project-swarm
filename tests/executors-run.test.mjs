// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const env = { OPENAI_API_KEY: 'test-not-a-secret', SWARM_CONFIG: process.env.SWARM_CONFIG };

// Only the text-envelope CLIs (Hermes, Qwen) run on a remote host. These tests use Hermes jobs, a fake
// local Hermes process, and a transport stub that answers like swarm-remote-exec does (stdout + exit code).
const COMMANDS = { hermes: '/opt/hermes' };
const outputOf = text => Number(/out\/(\d+)\.txt/.exec(String(text))[1]);
const hermesLine = n => `${JSON.stringify({ type: 'result', exit_code: 0, text: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: `output ${n}\n` }] }) })}\n`;
const localHermes = () => spawn(process.execPath, ['-e', `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const n=/out\\/(\\d+)\\.txt/.exec(input)[1];process.stdout.write(JSON.stringify({type:'result',exit_code:0,text:JSON.stringify({summary:'done',files:[{path:'out/'+n+'.txt',content:'output '+n+'\\n'}]})})+'\\n');});`], { stdio: ['pipe', 'pipe', 'pipe'] });
const remoteAnswer = request => ({ exitCode: 0, stdout: Buffer.from(hermesLine(outputOf(request.stdin))), files: [] });
const sshHost = (id = 'dev2', extra = {}) => ({ id, kind: 'ssh', target: 'worker@dev2', capacity: 1, commands: COMMANDS, ...extra });
const hermesJob = (n, extra) => ({ id: `job-${n}`, agent: 'hermes', model: 'test-model', prompt: `Write out/${n}.txt`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 5000, ...extra });
const hermesJobs = count => Array.from({ length: count }, (_, n) => hermesJob(n));
const oneJob = extra => hermesJob(0, extra);

async function repo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-executors-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'original\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', 'input.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}
const written = (root, job) => fs.readFile(path.join(root, job.workspace, job.outputs[0]), 'utf8');

test('a mixed local and ssh run finishes after the ssh host dies mid-job', async t => {
  const root = await repo(t);
  let remoteRunning = false;
  const seen = [];
  const state = await runManifest(root, {
    version: 1,
    concurrency: 2, lanes: { hermes: { concurrency: 2 } },
    hosts: [{ id: 'local', kind: 'local', capacity: 1, heartbeatMs: 30 }, sshHost('dev2', { heartbeatMs: 30 })],
    jobs: hermesJobs(2),
  }, {
    env,
    heartbeatMs: 30,
    spawnImpl: localHermes,
    hostTransport: {
      async ping(host) { return host.id !== 'dev2' || !remoteRunning; },
      async run(request) {
        seen.push(request.env);
        remoteRunning = true;
        if (request.signal.aborted) throw Object.assign(new Error(`host-dead: ${request.host.id}`), { code: 'host-dead' });
        await new Promise((resolve, reject) => {
          const fail = () => reject(Object.assign(new Error(`host-dead: ${request.host.id}`), { code: 'host-dead' }));
          if (request.signal.aborted) fail();
          else request.signal.addEventListener('abort', fail, { once: true });
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
  for (const job of state.jobs) assert.match(await written(root, job), /^output \d+\n$/);
});

test('a Hermes job on an ssh host runs the named CLI there with the message on stdin and ships no workspace or secret', async t => {
  const root = await repo(t);
  const requests = [];
  const state = await runManifest(root, { version: 1, hosts: [sshHost()], jobs: [oneJob({ sensitive: false })] }, {
    env,
    hostTransport: { async ping() { return true; }, async run(request) { requests.push(request); return remoteAnswer(request); } },
  });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(state.jobs[0].host, 'dev2');
  assert.equal(await written(root, state.jobs[0]), 'output 0\n');
  const [request] = requests;
  assert.equal(request.command, '/opt/hermes');
  assert.ok(request.args.includes('--oneshot') && request.args.includes('--toolsets'));
  assert.match(request.stdin, /original/);
  assert.deepEqual(request.files, []);
  assert.deepEqual(request.outputs, []);
  assert.equal(JSON.stringify(request.env ?? {}).includes('test-not-a-secret'), false);
});

test('a remote CLI that exits non-zero or answers badly fails that job only', async t => {
  const root = await repo(t);
  const state = await runManifest(root, { version: 1, concurrency: 2, hosts: [sshHost('dev2', { capacity: 2 })], jobs: hermesJobs(2) }, {
    env,
    hostTransport: {
      async ping() { return true; },
      async run(request) { return outputOf(request.stdin) === 0 ? { exitCode: 1, stdout: Buffer.alloc(0), files: [] } : remoteAnswer(request); },
    },
  });
  assert.deepEqual(state.jobs.map(job => job.status), ['failed', 'complete']);
  assert.match(state.jobs[0].error, /CLI process failed|exit/i);
});

test('a job whose agent cannot run remotely stays local even when only remote hosts are configured', async t => {
  const root = await repo(t);
  let remoteCalls = 0;
  const reply = n => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: `output ${n}\n` }] }) } }), { headers: { 'content-type': 'application/json' } });
  const state = await runManifest(root, { version: 1, hosts: [sshHost()], jobs: [{ ...oneJob(), agent: 'ollama' }] }, {
    env,
    fetchImpl: async (_url, options) => reply(outputOf(options.body)),
    hostTransport: { async ping() { remoteCalls += 1; return true; }, async run() { remoteCalls += 1; throw new Error('must not run remotely'); } },
  });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(state.jobs[0].hostUses, undefined);
  assert.equal(await written(root, state.jobs[0]), 'output 0\n');
  assert.equal(remoteCalls <= 1, true, 'only the host check may touch the host');
});

test('a sensitive job does not run on an untrusted sandbox', async t => {
  const root = await repo(t);
  let ran = false;
  const state = await runManifest(root, {
    version: 1,
    hosts: [{ id: 'box', kind: 'sandbox', capacity: 1, driver: ['swarm-sandbox', 'run'], commands: COMMANDS, heartbeatMs: 1000 }],
    jobs: [oneJob()],
  }, {
    env,
    hostTransport: { async ping() { return true; }, async run() { ran = true; return { exitCode: 0, stdout: Buffer.alloc(0), files: [] }; } },
  });
  assert.equal(ran, false);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /host-untrusted/);
});

test('a trusted sandbox can run a sensitive job and an untrusted sandbox can run a non-sensitive one', async t => {
  const root = await repo(t);
  const box = extra => ({ id: 'box', kind: 'sandbox', capacity: 1, driver: ['swarm-sandbox', 'run'], commands: COMMANDS, heartbeatMs: 1000, ...extra });
  const transport = { async ping() { return true; }, async run(request) { return remoteAnswer(request); } };
  const trusted = await runManifest(root, { version: 1, hosts: [box({ trusted: true })], jobs: [oneJob()] }, { env, hostTransport: transport });
  assert.equal(trusted.status, 'complete', trusted.error);
  assert.equal(trusted.jobs[0].host, 'box');
  const open = await runManifest(root, { version: 1, hosts: [box()], jobs: [oneJob({ sensitive: false })] }, { env, hostTransport: transport });
  assert.equal(open.status, 'complete', open.error);
  assert.equal(open.jobs[0].host, 'box');
});

test('one missed ping does not move a remote job', async t => {
  const root = await repo(t);
  let armed = false;
  let missed = false;
  const state = await runManifest(root, { version: 1, hosts: [sshHost('dev2', { heartbeatMs: 30 })], jobs: [oneJob()] }, {
    env,
    heartbeatMs: 30,
    hostTransport: {
      async ping() {
        if (!armed || missed) return true;
        missed = true;
        return false;
      },
      async run(request) {
        armed = true;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no heartbeat')), 2000);
          const poll = () => { if (missed) { clearTimeout(timer); resolve(); } else setTimeout(poll, 10); };
          poll();
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(request.signal.aborted, false);
        return remoteAnswer(request);
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
  const state = await runManifest(root, { version: 1, hosts: [sshHost('dev2', { heartbeatMs: 20 })], jobs: [oneJob()] }, {
    env,
    heartbeatMs: 20,
    hostTransport: {
      async ping() { return !down; },
      async kill(_host, ids) {
        events.push(`kill:${ids[0]}`);
        return { costUsd: 0.4 };
      },
      async run(request) {
        events.push('run');
        if (events.filter(event => event === 'run').length === 1) {
          down = true;
          await new Promise((resolve, reject) => {
            const fail = () => { down = false; reject(Object.assign(new Error(`host-dead: ${request.host.id}`), { code: 'host-dead' })); };
            if (request.signal.aborted) fail();
            else request.signal.addEventListener('abort', fail, { once: true });
          });
        }
        return remoteAnswer(request);
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

const sshDown = (calls = []) => ({
  async ping(host) { calls.push(`ping:${host.id}`); throw Object.assign(new Error('host-unreachable: ssh exit 255 (connection failed)'), { code: 'host-unreachable' }); },
  async run(request) { calls.push(`run:${request.host.id}`); throw new Error('an excluded host must never run a job'); },
});

test('an unreachable ssh host fails its check before placement and the whole run finishes on local', async t => {
  const root = await repo(t);
  const calls = [];
  const state = await runManifest(root, {
    version: 1, concurrency: 4,
    hosts: [{ id: 'local', kind: 'local', capacity: 4 }, sshHost('dev2', { target: 'dev2@10.10.10.220', capacity: 2 })],
    jobs: hermesJobs(6),
  }, { env, spawnImpl: localHermes, hostTransport: sshDown(calls) });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(state.jobs.filter(job => job.status === 'complete').length, 6);
  assert.deepEqual(state.jobs.flatMap(job => job.hostUses ?? []).filter(id => id !== 'local'), []);
  assert.ok(calls.includes('ping:dev2') && !calls.includes('run:dev2'));
  assert.deepEqual(state.hostsExcluded.map(host => host.id), ['dev2']);
  assert.ok(state.warnings.some(warning => /host-unavailable: dev2/.test(warning)));
});

test('ssh exit 255 mid-run moves that job to a live host and cancels nothing', async t => {
  const root = await repo(t);
  let first = true;
  const state = await runManifest(root, {
    version: 1, concurrency: 4,
    hosts: [sshHost('dev2', { target: 'dev2@10.10.10.220' }), { id: 'local', kind: 'local', capacity: 4 }],
    jobs: hermesJobs(5),
  }, {
    env, spawnImpl: localHermes,
    hostTransport: {
      async ping() { return true; },
      async run() { if (first) { first = false; throw Object.assign(new Error('host-unreachable: ssh exit 255 (connection failed)'), { code: 'host-unreachable' }); } throw new Error('the host stays out once it failed'); },
    },
  });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(state.jobs.filter(job => job.status === 'complete').length, 5);
  const moved = state.jobs.find(job => job.hostUses?.includes('dev2'));
  assert.equal(moved.hostUses.at(-1), 'local');
  assert.equal(state.jobs.some(job => job.status === 'cancelled'), false);
});

test('a remote command failure fails that job only and never the run', async t => {
  const root = await repo(t);
  const state = await runManifest(root, {
    version: 1, concurrency: 4, lanes: { hermes: { concurrency: 4 } },
    hosts: [sshHost('dev2', { target: 'dev2@10.10.10.220' }), { id: 'local', kind: 'local', capacity: 4 }],
    jobs: hermesJobs(4),
  }, {
    env, spawnImpl: localHermes,
    hostTransport: { async ping() { return true; }, async run() { throw Object.assign(new Error('host-exit: 2'), { code: 'host-exit' }); } },
  });
  for (const job of state.jobs) {
    const lastHost = job.hostUses?.at(-1);
    if (lastHost === 'local') {
      assert.equal(job.status, 'complete', job.error);
    } else {
      assert.equal(job.status, 'failed', job.error);
      assert.match(job.error, /host-exit: 2/);
    }
  }
  assert.equal(
    state.jobs.filter(job => job.status === 'complete' || job.status === 'failed').length,
    4,
  );
  assert.equal(state.jobs.some(job => job.status === 'cancelled'), false);
  assert.ok(!/Coordinator failed/.test(String(state.error ?? '')));
  assert.ok(!/Coordinator failed/.test(JSON.stringify(state.jobs.map(job => job.error))));
});

test('when no usable host is left a job fails alone with hosts-exhausted', async t => {
  const root = await repo(t);
  const state = await runManifest(root, {
    version: 1, concurrency: 2,
    hosts: [sshHost('dev2', { target: 'dev2@10.10.10.220' })],
    jobs: hermesJobs(2),
  }, { env, hostTransport: sshDown() });
  assert.deepEqual(state.jobs.map(job => job.status), ['failed', 'failed']);
  assert.ok(state.jobs.every(job => /hosts-exhausted/.test(job.error)));
  assert.ok(!/Coordinator failed/.test(JSON.stringify(state.jobs.map(job => job.error))));
});

test('a host marked enabled: false is kept in config but never pinged or used', async t => {
  const root = await repo(t);
  const calls = [];
  const state = await runManifest(root, {
    version: 1, concurrency: 2,
    hosts: [{ id: 'local', kind: 'local', capacity: 2 }, sshHost('dev2', { target: 'dev2@10.10.10.220', capacity: 2, enabled: false })],
    jobs: hermesJobs(3),
  }, { env, spawnImpl: localHermes, hostTransport: sshDown(calls) });
  assert.equal(state.status, 'complete', state.error);
  assert.deepEqual(calls, []);
});
