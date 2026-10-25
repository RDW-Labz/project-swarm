// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  JobGrantAccessError,
  buildIsolatedProcessEnv,
  createJobGrant,
  grantPlaintextLeakCheck,
  loadJobGrantSecrets,
} from '../tools/job-grants.mjs';

const NEEDS = ['DATABASE_URL'];

async function listenToken(host, port, token) {
  const server = net.createServer(socket => {
    socket.once('data', buf => {
      const line = buf.toString('utf8').trim();
      socket.end(line === token ? 'OK\n' : 'DENY\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

function runChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code, stdout, stderr });
    });
  });
}

test('createJobGrant writes a per-job file with tight permissions and does not mutate process.env', async t => {
  const grantsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-grants-'));
  t.after(() => fs.rm(grantsRoot, { recursive: true, force: true }));
  const beforeDb = process.env.DATABASE_URL;
  const grant = await createJobGrant({
    grantsRoot,
    jobId: 'job-a',
    needs: NEEDS,
    values: { DATABASE_URL: 'postgres://127.0.0.1:1/db-a' },
  });
  assert.equal(process.env.DATABASE_URL, beforeDb);
  assert.equal(process.env.SWARM_JOB_GRANT_FILE, undefined);
  assert.equal(process.env.SWARM_JOB_GRANT_KEY, undefined);
  assert.equal(grant.envFile, path.join(grantsRoot, 'job-a', 'grant.env'));
  assert.equal((await fs.stat(grant.grantDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(grant.envFile)).mode & 0o777, 0o600);
  const raw = await fs.readFile(grant.envFile, 'utf8');
  assert.equal(grantPlaintextLeakCheck(raw, 'postgres://127.0.0.1:1/db-a'), false);
});

test('two concurrent isolated jobs cannot read each other DATABASE_URL value', async t => {
  const grantsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-grants-'));
  t.after(() => fs.rm(grantsRoot, { recursive: true, force: true }));

  const portA = 52000 + Math.floor(Math.random() * 1000);
  const portB = portA + 1;
  const urlA = `postgres://127.0.0.1:${portA}/db-a`;
  const urlB = `postgres://127.0.0.1:${portB}/db-b`;
  const serverA = await listenToken('127.0.0.1', portA, 'token-a');
  const serverB = await listenToken('127.0.0.1', portB, 'token-b');
  t.after(() => {
    serverA.close();
    serverB.close();
  });

  const [grantA, grantB] = await Promise.all([
    createJobGrant({ grantsRoot, jobId: 'job-a', needs: NEEDS, values: { DATABASE_URL: urlA } }),
    createJobGrant({ grantsRoot, jobId: 'job-b', needs: NEEDS, values: { DATABASE_URL: urlB } }),
  ]);

  assert.notEqual(grantA.envFile, grantB.envFile);

  const grantModule = fileURLToPath(new URL('../tools/job-grants.mjs', import.meta.url));
  const workerScript = `
    import net from 'node:net';
    import fs from 'node:fs/promises';
    import assert from 'node:assert/strict';
    import { loadJobGrantSecrets, grantPlaintextLeakCheck, JobGrantAccessError } from ${JSON.stringify(grantModule)};

    const own = await loadJobGrantSecrets(process.env);
    assert.equal(own.DATABASE_URL, process.env.EXPECTED_URL);
    assert.equal(process.env.DATABASE_URL, undefined, 'parent must not inject DATABASE_URL');

    let peerDenied = false;
    try {
      await loadJobGrantSecrets({
        ...process.env,
        SWARM_JOB_GRANT_FILE: process.env.PEER_GRANT_FILE,
      });
    } catch (error) {
      peerDenied = error instanceof JobGrantAccessError;
    }
    assert.equal(peerDenied, true, 'peer grant must not decrypt with this job key');

    const peerRaw = await fs.readFile(process.env.PEER_GRANT_FILE, 'utf8');
    assert.equal(grantPlaintextLeakCheck(peerRaw, process.env.PEER_SECRET_SNIPPET), false);

    const ownHostPort = own.DATABASE_URL.replace(/^postgres:\\/\\//, '').split('/')[0].split(':');
    const ownOk = await new Promise(resolve => {
      const socket = net.connect({ host: ownHostPort[0], port: Number(ownHostPort[1]) }, () => {
        socket.write(process.env.OWN_TOKEN + '\\n');
        socket.once('data', buf => { socket.end(); resolve(buf.toString()); });
      });
      socket.on('error', err => resolve(String(err.code ?? err.message)));
    });
    assert.equal(ownOk, 'OK\\n');

    const peerHostPort = process.env.PEER_URL.replace(/^postgres:\\/\\//, '').split('/')[0].split(':');
    const cross = await new Promise(resolve => {
      const socket = net.connect({ host: peerHostPort[0], port: Number(peerHostPort[1]) }, () => {
        socket.write('token-wrong\\n');
        socket.once('data', buf => { socket.end(); resolve(buf.toString()); });
      });
      socket.on('error', err => resolve(String(err.code ?? err.message)));
    });
    assert.ok(cross === 'DENY\\n' || cross === 'ECONNREFUSED' || cross.includes('ECONNREFUSED'), cross);

    console.log(JSON.stringify({ ok: true }));
  `;

  const base = { PATH: process.env.PATH, NODE_OPTIONS: '' };
  const envA = buildIsolatedProcessEnv({
    baseEnv: { ...base, DATABASE_URL: urlB },
    grant: grantA,
  });
  const envB = buildIsolatedProcessEnv({
    baseEnv: { ...base, DATABASE_URL: urlA },
    grant: grantB,
  });

  const [runA, runB] = await Promise.all([
    runChild(workerScript, {
      ...envA,
      EXPECTED_URL: urlA,
      OWN_TOKEN: 'token-a',
      PEER_GRANT_FILE: grantB.envFile,
      PEER_SECRET_SNIPPET: urlB,
      PEER_URL: urlB,
    }),
    runChild(workerScript, {
      ...envB,
      EXPECTED_URL: urlB,
      OWN_TOKEN: 'token-b',
      PEER_GRANT_FILE: grantA.envFile,
      PEER_SECRET_SNIPPET: urlA,
      PEER_URL: urlA,
    }),
  ]);

  assert.equal(runA.code, 0, runA.stderr || runA.stdout);
  assert.equal(runB.code, 0, runB.stderr || runB.stdout);
  assert.deepEqual(JSON.parse(runA.stdout.trim()), { ok: true });
  assert.deepEqual(JSON.parse(runB.stdout.trim()), { ok: true });
});

test('loadJobGrantSecrets surfaces missing grant files as not found', async () => {
  await assert.rejects(
    () => loadJobGrantSecrets({
      SWARM_JOB_ID: 'job-z',
      SWARM_JOB_GRANT_FILE: path.join(os.tmpdir(), 'missing-grant.env'),
      SWARM_JOB_GRANT_KEY: 'abc',
    }),
    error => error instanceof JobGrantAccessError && error.code === 'ENOENT',
  );
});
