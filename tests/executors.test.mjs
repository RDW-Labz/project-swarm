// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkPulled, createHostPool, defaultHostTransport, hashBytes, isSecretPath, remoteEnv, resolveHosts, sshArgv } from '../tools/executors.mjs';

const hosts = () => resolveHosts([
  { id: 'local', kind: 'local', capacity: 1, heartbeatMs: 1000 },
  { id: 'dev2', kind: 'ssh', target: 'worker@dev2', capacity: 1, heartbeatMs: 20 },
]);

test('host records reject bad shapes and keep ssh, sandbox, and local apart', () => {
  assert.equal(resolveHosts(undefined), null);
  assert.throws(() => resolveHosts([]), { code: 'hosts-invalid' });
  assert.throws(() => resolveHosts([{ id: 'Dev', kind: 'local', capacity: 1 }]), { code: 'hosts-invalid' });
  assert.throws(() => resolveHosts([{ id: 'box', kind: 'ssh', capacity: 1, target: 'not a host' }]), { code: 'hosts-invalid' });
  assert.throws(() => resolveHosts([{ id: 'box', kind: 'sandbox', capacity: 1 }]), { code: 'hosts-invalid' });
  const sandbox = resolveHosts([{ id: 'box', kind: 'sandbox', capacity: 2, driver: ['swarm-sandbox', '--run'] }]);
  assert.deepEqual(sandbox[0].driver, ['swarm-sandbox', '--run']);
  assert.deepEqual(sshArgv(hosts()[1], 'true').slice(0, 6), ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'worker@dev2']);
});

test('remote shipment drops secret paths and secret environment variables', () => {
  assert.equal(isSecretPath('.env'), true);
  assert.equal(isSecretPath('nested/.env.local'), true);
  assert.equal(isSecretPath('.ssh/id_ed25519'), true);
  assert.equal(isSecretPath('src/app.js'), false);
  assert.deepEqual(remoteEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk-secret', HOME: '/Users/bean', LANG: 'C' }), { PATH: '/bin', LANG: 'C' });
});

test('a pulled output must match its hash and cannot be a secret path', () => {
  const bytes = Buffer.from('output\n');
  checkPulled([{ path: 'out/0.txt', bytes, sha256: hashBytes(bytes) }]);
  assert.throws(() => checkPulled([{ path: 'out/0.txt', bytes, sha256: 'nope' }]), { code: 'host-pull-mismatch' });
  assert.throws(() => checkPulled([{ path: '.env', bytes, sha256: hashBytes(bytes) }]), { code: 'host-pull-mismatch' });
});

test('a dead ssh host frees its job so the waiting job can take the live host', async () => {
  let armed = false;
  const pool = createHostPool({
    hosts: hosts(),
    ping: async host => host.id !== 'dev2' || !armed,
  });
  const first = await pool.claim();
  const second = await pool.claim();
  assert.deepEqual([first.host.id, second.host.id], ['local', 'dev2']);
  let thirdHost = null;
  const third = pool.claim().then(placement => { thirdHost = placement.host.id; return placement; });
  armed = true;
  await new Promise(resolve => second.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(second.signal.reason.code, 'host-dead');
  second.release();
  first.release();
  const placement = await third;
  assert.equal(thirdHost, 'local');
  placement.release();
  pool.close();
});

test('the default ssh transport ships no secret env and checks the pulled hash', async () => {
  const body = Buffer.from('remote output\n');
  const pulled = JSON.stringify({ files: [{ path: 'out/0.txt', bytes: body.toString('utf8'), sha256: hashBytes(body) }] });
  let seenEnv = null;
  const transport = defaultHostTransport({
    spawnImpl: (_command, args, options) => {
      seenEnv = options.env;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = () => {};
      process.nextTick(() => {
        if (args.at(-1) === 'swarm-remote-exec') child.stdout.emit('data', Buffer.from(pulled));
        child.emit('exit', 0);
      });
      return child;
    },
  });
  const host = hosts()[1];
  assert.equal(await transport.ping(host), true);
  const result = await transport.run({ host, files: [{ path: '.env', bytes: Buffer.from('SECRET=1') }, { path: 'input.txt', bytes: Buffer.from('hi') }], outputs: ['out/0.txt'], env: { PATH: '/bin', OPENAI_API_KEY: 'sk-secret' } });
  assert.equal(seenEnv.OPENAI_API_KEY, undefined);
  assert.equal(seenEnv.PATH, '/bin');
  assert.equal(result.files[0].bytes.toString(), 'remote output\n');
});
