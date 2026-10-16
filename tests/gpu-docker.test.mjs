// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gpu from '../tools/gpu.mjs';
import { gpuUp, readSessionFile } from '../tools/gpu.mjs';

const MODEL = 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8';

function envFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-docker-'));
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
    openTunnel: async ({ ports }) => { calls.push({ tunnel: ports }); return { pid: 4242 }; },
    stopTunnel: async pid => { calls.push({ stopped: pid }); },
  };
}

test('parseDockerMajor reads the major version from the DOCKER line', () => {
  const parse = gpu.parseDockerMajor;
  assert.equal(typeof parse, 'function', 'parseDockerMajor must be exported from tools/gpu.mjs');
  assert.equal(parse('GPU 0: x\nSUDO:ok\nDOCKER:28.0.1'), 28);
  assert.equal(parse('GPU 0: x\nSUDO:ok\nDOCKER:27.5.1'), 27);
  assert.equal(parse('GPU 0: x\nSUDO:ok\nDOCKER:'), null);
  assert.equal(parse('GPU 0: x\nSUDO:ok'), null);
  assert.equal(parse('GPU 0: x\nSUDO:ok\nDOCKER:abc'), null);
  assert.equal(parse('GPU 0: x\nSUDO:ok\nDOCKER:29.1.0\n'), 29);
});

for (const dockerVersion of ['27.5.1', '', 'weird']) {
  test(`gpuUp refuses docker '${dockerVersion}' before sending any start script and writes no session`, async t => {
    const env = envFor(t);
    const deps = fakes(env, { dockerVersion });
    await assert.rejects(gpuUp(options(), deps), /gpu-docker-old/);
    assert.equal(deps.calls.some(call => call.input), false, 'no start script was sent');
    assert.equal(readSessionFile(env), null, 'no session file exists');
  });
}

for (const dockerVersion of ['28.0.0', '29.2.1']) {
  test(`gpuUp accepts docker ${dockerVersion}`, async t => {
    const env = envFor(t);
    const deps = fakes(env, { dockerVersion });
    const session = await gpuUp(options(), deps);
    assert.ok(session);
    assert.notEqual(readSessionFile(env), null);
  });
}
