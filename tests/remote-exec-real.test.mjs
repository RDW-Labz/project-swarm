// SPDX-License-Identifier: Apache-2.0
// Runs the real ssh transport against a real host. It is skipped unless a host is configured:
//   SWARM_TEST_SSH_HOST=user@host SWARM_TEST_SSH_EXEC=/abs/path/to/swarm-remote-exec node --test tests/remote-exec-real.test.mjs
// The remote side must have node and the remote-exec script (tools/remote-exec.mjs) at that path. The
// jobs only run /bin/sh with tiny scripts: no model, no key, no repository file is sent.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { defaultHostTransport, hashBytes } from '../tools/executors.mjs';

const target = process.env.SWARM_TEST_SSH_HOST;
const remoteExec = process.env.SWARM_TEST_SSH_EXEC;
const skip = target && remoteExec ? false : 'set SWARM_TEST_SSH_HOST and SWARM_TEST_SSH_EXEC to run against a real ssh host';
const host = { id: 'real', kind: 'ssh', target, remoteExec, capacity: 1 };
const transport = () => defaultHostTransport({ spawnImpl: spawn });
const jobId = () => crypto.randomBytes(8).toString('hex');
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
// A flaky link needs a few tries; a real failure still fails after the last one.
async function withRetry(fn, tries = 10) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try { return await fn(); } catch (error) {
      last = error;
      if (error?.code !== 'host-unreachable') throw error;
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }
  throw last;
}

test('real host: ping succeeds', { skip, timeout: 600000 }, async () => {
  assert.equal(await withRetry(() => transport().ping(host)), true);
});

test('real host: a command runs there with stdin, files, an env allowlist, and its output file comes back with a matching sha256', { skip, timeout: 600000 }, async () => {
  const result = await withRetry(() => transport().run({
    host, jobId: jobId(), command: '/bin/sh',
    args: ['-c', 'cat > got-stdin.txt; cat in.txt > out.txt; printf "%s|%s|%s" "$HOME" "${SECRET_TOKEN:-unset}" "$LANG" >> out.txt; echo from-remote'],
    stdin: 'hello over ssh', env: { ...env, SECRET_TOKEN: 'must-not-travel' },
    files: [{ path: 'in.txt', bytes: Buffer.from('file-body\n') }], outputs: ['out.txt', 'missing.txt', 'got-stdin.txt'],
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString('utf8'), 'from-remote\n');
  const byPath = Object.fromEntries(result.files.map(file => [file.path, file]));
  assert.ok(!byPath['missing.txt'], 'a missing output is skipped, not an error');
  assert.equal(byPath['got-stdin.txt'].bytes.toString('utf8'), 'hello over ssh');
  const out = byPath['out.txt'].bytes.toString('utf8');
  assert.match(out, /^file-body\n/);
  assert.ok(!out.includes('must-not-travel'), 'only allowlisted variables reach the job');
  assert.match(out, /\|unset\|C\.UTF-8$/);
  for (const file of result.files) assert.equal(file.sha256, hashBytes(file.bytes));
});

test('real host: a non-zero exit is a result, not a transport failure', { skip, timeout: 600000 }, async () => {
  const failed = await withRetry(() => transport().run({ host, jobId: jobId(), command: '/bin/sh', args: ['-c', 'echo oops >&2; exit 7'], stdin: '', env, files: [], outputs: [] }));
  assert.equal(failed.exitCode, 7);
});

test('real host: secret paths are dropped before anything is sent, so the job never sees them', { skip, timeout: 600000 }, async () => {
  const probe = await withRetry(() => transport().run({
    host, jobId: jobId(), command: '/bin/sh', env, stdin: '', outputs: [],
    args: ['-c', 'for f in .env .env.local .git/config .ssh/id x/.aws/c ok.txt; do if [ -e "$f" ]; then echo "$f present"; else echo "$f absent"; fi; done'],
    files: ['.env', '.env.local', '.git/config', '.ssh/id', 'x/.aws/c', 'ok.txt'].map(file => ({ path: file, bytes: Buffer.from('x') })),
  }));
  assert.equal(probe.stdout.toString('utf8'), '.env absent\n.env.local absent\n.git/config absent\n.ssh/id absent\nx/.aws/c absent\nok.txt present\n');
});

// Paths that could leave the workspace do reach the remote side, which refuses the whole request.
for (const bad of ['../escape.txt', '/etc/swarm-test-should-not-exist']) {
  test(`real host: the remote side refuses the path ${bad}`, { skip, timeout: 600000 }, async () => {
    await assert.rejects(withRetry(() => transport().run({ host, jobId: jobId(), command: '/bin/sh', args: ['-c', 'touch ran'], stdin: '', env, files: [{ path: bad, bytes: Buffer.from('x') }], outputs: [] })), { code: 'host-exit' });
  });
}
