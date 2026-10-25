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
  SWARM_JOB_GRANT_FILE,
  buildIsolatedProcessEnv,
  createJobGrant,
  deleteJobGrant,
  grantPlaintextLeakCheck,
  loadJobGrantSecrets,
} from '../tools/job-grants.mjs';
import {
  DENY_EXIT_CODE,
  GIT_PUSH_DENIED_MESSAGE,
  guardJobCommandExecution,
} from '../tools/job-sandbox.mjs';
import { issueGrant } from '../tools/job-sandbox-grants.mjs';

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
      env,
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
      SWARM_JOB_GRANT_KEY: 'a'.repeat(64),
    }),
    error => error instanceof JobGrantAccessError && error.code === 'ENOENT',
  );
});

test('deleteJobGrant removes the grant directory and file', async t => {
  const grantsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-grants-'));
  t.after(() => fs.rm(grantsRoot, { recursive: true, force: true }));
  const grant = await createJobGrant({
    grantsRoot,
    jobId: 'job-del',
    needs: NEEDS,
    values: { DATABASE_URL: 'postgres://127.0.0.1:1/db' },
  });
  await fs.access(grant.envFile);
  await deleteJobGrant(grantsRoot, 'job-del');
  await assert.rejects(() => fs.access(grant.envFile), /ENOENT/);
  await assert.rejects(() => fs.access(grant.grantDir), /ENOENT/);
});

test('createJobGrant reapplies tight permissions when overwrite replaces an existing grant', async t => {
  const grantsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-grants-'));
  t.after(() => fs.rm(grantsRoot, { recursive: true, force: true }));
  const grant = await createJobGrant({
    grantsRoot,
    jobId: 'job-perms',
    needs: NEEDS,
    values: { DATABASE_URL: 'postgres://127.0.0.1:1/db' },
  });
  await fs.chmod(grant.grantDir, 0o777);
  await fs.chmod(grant.envFile, 0o666);
  await createJobGrant({
    grantsRoot,
    jobId: 'job-perms',
    needs: NEEDS,
    values: { DATABASE_URL: 'postgres://127.0.0.1:2/db' },
    overwrite: true,
  });
  assert.equal((await fs.stat(grant.grantDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(grant.envFile)).mode & 0o777, 0o600);
});

test('createJobGrant rejects a pre-existing symlink at the grant file path', async t => {
  const grantsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-grants-'));
  t.after(() => fs.rm(grantsRoot, { recursive: true, force: true }));
  const grantDir = path.join(grantsRoot, 'job-sym');
  await fs.mkdir(grantDir, { recursive: true });
  const outside = path.join(grantsRoot, 'outside-target');
  await fs.writeFile(outside, 'pwned', 'utf8');
  await fs.symlink(outside, path.join(grantDir, 'grant.env'));
  await assert.rejects(
    () => createJobGrant({
      grantsRoot,
      jobId: 'job-sym',
      needs: NEEDS,
      values: { DATABASE_URL: 'postgres://127.0.0.1:1/db' },
    }),
    error => error instanceof JobGrantAccessError && error.code === 'EEXIST',
    'must not follow or truncate a pre-existing grant path',
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'pwned');
});

test('concurrent createJobGrant for the same jobId does not silently race', async t => {
  const grantsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-grants-'));
  t.after(() => fs.rm(grantsRoot, { recursive: true, force: true }));
  const opts = {
    grantsRoot,
    jobId: 'job-race',
    needs: NEEDS,
    values: { DATABASE_URL: 'postgres://127.0.0.1:1/db' },
  };
  const results = await Promise.allSettled([
    createJobGrant(opts),
    createJobGrant(opts),
  ]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const fail = rejected[0].reason;
  assert.ok(fail instanceof JobGrantAccessError);
  assert.equal(fail.code, 'EEXIST');
});

async function simulateServiceRun(command, context) {
  let invoked = false;
  const guard = guardJobCommandExecution({ ...context, command });
  if (!guard.proceed) {
    return {
      invoked,
      code: guard.exitCode,
      message: guard.message,
    };
  }
  invoked = true;
  const child = spawn(command, { shell: true, stdio: 'ignore' });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { invoked, code, message: '' };
}

function syntheticIsolatedGrant(jobId) {
  return {
    mode: 'isolated',
    jobId,
    permissions: { gitPush: false, databaseAccess: 'own-database-only' },
  };
}

test('isolated job git push is denied at the service with exit 1 before invocation', async () => {
  const project = { sandbox: { isolated: true } };
  const grant = syntheticIsolatedGrant('job-push-deny');
  const result = await simulateServiceRun('git push origin main', { project, grant });
  assert.equal(result.invoked, false, 'git push must not be spawned for isolated jobs');
  assert.equal(result.code, DENY_EXIT_CODE);
  assert.match(result.message, /git push/i);
  assert.equal(result.message, GIT_PUSH_DENIED_MESSAGE);
});

test('isolated job denies obfuscated git push forms before invocation', async () => {
  const project = { sandbox: { isolated: true } };
  const grant = syntheticIsolatedGrant('job-push-obfusc');
  const attempts = [
    'git  push origin',
    'git\tpush',
    'git -c http.version=HTTP/1.1 push',
    'env git push',
    'sh -c "git push origin"',
  ];
  for (const command of attempts) {
    const guard = guardJobCommandExecution({ project, grant, command });
    assert.equal(guard.proceed, false, command);
    assert.equal(guard.exitCode, 1, command);
    assert.match(guard.message, /git push|git alias/i, command);
  }
});

test('legacy (non-isolated) project jobs may still run git push as before', async t => {
  const project = { sandbox: { isolated: false } };
  const grant = await issueGrant('job-legacy-push', { project });
  assert.equal(grant.mode, 'legacy');
  const guard = guardJobCommandExecution({
    project,
    grant,
    command: 'git push origin main',
  });
  assert.equal(guard.proceed, true);
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-git-push-'));
  t.after(() => fs.rm(repoDir, { recursive: true, force: true }));
  await runChild(
    `import { execSync } from 'node:child_process';
     execSync('git init -q', { cwd: ${JSON.stringify(repoDir)} });
     console.log('ok');`,
    { PATH: process.env.PATH },
  );
  const pushGuard = guardJobCommandExecution({
    project,
    grant,
    argv: ['git', 'push'],
  });
  assert.equal(pushGuard.proceed, true);
});

test('isolated job detected via grant env handles is denied git push', async () => {
  const grantsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-grants-guard-'));
  const grant = await createJobGrant({
    grantsRoot,
    jobId: 'job-env-guard',
    needs: NEEDS,
    values: { DATABASE_URL: 'postgres://127.0.0.1:1/db' },
  });
  const env = buildIsolatedProcessEnv({ baseEnv: { PATH: process.env.PATH }, grant });
  const project = { sandbox: { isolated: true } };
  const guard = guardJobCommandExecution({
    project,
    env,
    command: 'git push',
  });
  assert.equal(guard.proceed, false);
  assert.equal(guard.exitCode, 1);
  await fs.rm(grantsRoot, { recursive: true, force: true });
});

test('createJobGrant rejects a too-short grantKey', async t => {
  const grantsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-grants-'));
  t.after(() => fs.rm(grantsRoot, { recursive: true, force: true }));
  await assert.rejects(
    () => createJobGrant({
      grantsRoot,
      jobId: 'job-weak-key',
      needs: NEEDS,
      values: { DATABASE_URL: 'postgres://127.0.0.1:1/db' },
      grantKey: 'short',
    }),
    /grantKey must be 64 hex characters/,
  );
});
