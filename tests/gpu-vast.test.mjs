// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gpuUp, gpuDown, gpuStatus, readSessionFile, validateUpOptions } from '../tools/gpu.mjs';

const MODEL = 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8';

function envFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-vast-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  return { ...process.env, SWARM_CONFIG: file };
}

const options = (extra = {}) => ({ target: 'ubuntu@203.0.113.9', key: '/home/me/.ssh/node', model: MODEL, hourlyUsd: 3, maxUsd: 6, pollMs: 1, ...extra });

function fakes(env, { gpus = 1, now = () => 1700000000000, sudo = 'ok', dockerVersion = '28.0.1', ssOutput = '' } = {}) {
  const calls = [];
  return {
    calls, env, now,
    sleep: async () => {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: MODEL }] }) }),
    ssh: async (argv, { input } = {}) => {
      calls.push({ argv, input });
      const last = String(argv.at(-1));
      if (last === 'ss -ltnH') return { stdout: ssOutput };
      return { stdout: last.startsWith('nvidia-smi -L') ? Array.from({ length: gpus }, (_, n) => `GPU ${n}: NVIDIA RTX PRO 6000`).join('\n') + `\nSUDO:${sudo}\nDOCKER:${dockerVersion}` : '' };
    },
    probePort: async () => false,
    openTunnel: async arg => { calls.push({ tunnel: arg.ports, sshOptions: arg.sshOptions }); return { pid: 4242 }; },
    stopTunnel: async pid => { calls.push({ stopped: pid }); },
  };
}

const sshCalls = calls => calls.filter(call => Array.isArray(call.argv));

const hasPortBeforeDashes = argv => {
  const dashes = argv.indexOf('--');
  const p = argv.indexOf('-p');
  return p !== -1 && dashes !== -1 && p < dashes && argv[p + 1] === '2222';
};

const optionsHavePort = list => {
  const p = list.indexOf('-p');
  return p !== -1 && list[p + 1] === '2222';
};

test('gpuUp sends port 2222 on every ssh call, to the tunnel and into the session', async t => {
  const env = envFor(t);
  const deps = fakes(env);
  await gpuUp(options({ sshPort: 2222 }), deps);
  const calls = sshCalls(deps.calls);
  assert.ok(calls.length > 0);
  for (const call of calls) assert.ok(hasPortBeforeDashes(call.argv), call.argv.join(' '));
  const tunnel = deps.calls.find(call => call.tunnel !== undefined);
  assert.ok(tunnel, 'openTunnel was called');
  assert.ok(optionsHavePort(tunnel.sshOptions), 'tunnel sshOptions carry -p 2222');
  const session = readSessionFile(env);
  assert.ok(session);
  assert.ok(optionsHavePort(session.sshOptions), 'session sshOptions carry -p 2222');
});

test('gpuDown stops the node over ssh on port 2222', async t => {
  const env = envFor(t);
  const deps = fakes(env);
  await gpuUp(options({ sshPort: 2222 }), deps);
  deps.calls.splice(0);
  const result = await gpuDown(deps);
  assert.equal(result.stopped, true);
  const calls = sshCalls(deps.calls);
  assert.equal(calls.length, 1);
  assert.ok(hasPortBeforeDashes(calls[0].argv), calls[0].argv.join(' '));
});

test('gpuStatus does not throw for the port 2222 session', async t => {
  const env = envFor(t);
  const deps = fakes(env);
  await gpuUp(options({ sshPort: 2222 }), deps);
  const status = await gpuStatus({ env, fetchImpl: deps.fetchImpl, now: deps.now });
  assert.equal(status.active, true);
});

for (const sshPort of [0, 70000, 1.5, '22']) {
  test(`sshPort ${JSON.stringify(sshPort)} is refused`, async t => {
    assert.throws(() => validateUpOptions(options({ sshPort })), /gpu-option-invalid/);
    const env = envFor(t);
    await assert.rejects(gpuUp(options({ sshPort }), fakes(env)), /gpu-option-invalid/);
    assert.equal(readSessionFile(env), null);
  });
}

test('the first ssh command checks id -u and the start script arms the shutdown timer', async t => {
  const env = envFor(t);
  const deps = fakes(env);
  await gpuUp(options(), deps);
  const first = sshCalls(deps.calls).find(call => String(call.argv.at(-1)).startsWith('nvidia-smi -L'));
  assert.ok(first, 'nvidia-smi probe was sent');
  assert.ok(String(first.argv.at(-1)).includes('id -u'));
  const script = deps.calls.find(call => typeof call.input === 'string' && call.input.includes('sleep '));
  assert.ok(script, 'start script was sent');
  const timer = script.input.split('\n')[0];
  assert.ok(timer.includes('shutdown -h now ||'), timer);
});
