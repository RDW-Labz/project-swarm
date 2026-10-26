// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  diffFingerprints,
  gateEnvFingerprint,
  saveGateCapture,
} from '../tools/gate-fingerprint.mjs';

function makeEnv(extra = {}) {
  return {
    HOME: '/tmp/home',
    PATH: '/bin',
    ...extra,
  };
}

test('gateEnvFingerprint exposes allowlist values and name-only extras', () => {
  const fakeA = ['sk', '-'].join('') + 'a'.repeat(24);
  const envName = ['MY', '_', 'FAKE', '_', 'VAR'].join('');
  const env = makeEnv({ [envName]: fakeA, TZ: 'UTC' });
  const fp = gateEnvFingerprint({
    cwd: '/work',
    env,
    ports: [3000],
    concurrency: 2,
    timeoutMs: 5000,
    cleanedDirs: ['dist'],
    browserPath: '/browsers',
    node: 'v20.0.0',
  });

  assert.equal(fp.cwd, '/work');
  assert.equal(fp.env.HOME, '/tmp/home');
  assert.equal(fp.env.TZ, 'UTC');
  assert.deepEqual(fp.extraEnvNames, [envName]);
  assert.deepEqual(fp.ports, [3000]);
  assert.equal(fp.concurrency, 2);
  assert.equal(fp.node, 'v20.0.0');

  const serialized = JSON.stringify(fp);
  assert.ok(!serialized.includes(fakeA), 'fingerprint must not contain non-allowlist env values');
});

test('diffFingerprints reports same and differing fields', () => {
  const base = gateEnvFingerprint({
    cwd: '/a',
    env: makeEnv({ LANG: 'en_US' }),
    ports: 1,
    concurrency: 1,
    timeoutMs: 100,
    cleanedDirs: [],
    browserPath: null,
    node: 'v20',
  });
  const clone = gateEnvFingerprint({
    cwd: '/a',
    env: makeEnv({ LANG: 'en_US' }),
    ports: 1,
    concurrency: 1,
    timeoutMs: 100,
    cleanedDirs: [],
    browserPath: null,
    node: 'v20',
  });
  const same = diffFingerprints(base, clone);
  assert.equal(same.same, true);
  assert.equal(same.differences.length, 0);

  const other = gateEnvFingerprint({
    cwd: '/b',
    env: makeEnv({ LANG: 'en_US' }),
    ports: 1,
    concurrency: 1,
    timeoutMs: 100,
    cleanedDirs: [],
    browserPath: null,
    node: 'v20',
  });
  const diff = diffFingerprints(base, other);
  assert.equal(diff.same, false);
  assert.ok(diff.differences.some((d) => d.field === 'cwd'));
});

test('saveGateCapture writes atomically with safe permissions', async (t) => {
  const runDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gate-cap-run-'));
  t.after(async () => {
    await fsPromises.rm(runDir, { recursive: true, force: true });
  });

  const capture = { kind: 'gate', tail: 'short' };
  const outPath = await saveGateCapture(runDir, 'ticket-1', capture);
  assert.equal(outPath, path.join(runDir, 'gate-failures', 'ticket-1.json'));
  const stat = await fsPromises.stat(outPath);
  assert.equal(stat.mode & 0o777, 0o600);
  const dirStat = await fsPromises.stat(path.join(runDir, 'gate-failures'));
  assert.equal(dirStat.mode & 0o777, 0o700);
  const parsed = JSON.parse(await fsPromises.readFile(outPath, 'utf8'));
  assert.deepEqual(parsed, capture);
});

test('saveGateCapture rejects invalid ticketId', async (t) => {
  const runDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gate-cap-bad-id-'));
  t.after(async () => {
    await fsPromises.rm(runDir, { recursive: true, force: true });
  });
  await assert.rejects(
    () => saveGateCapture(runDir, '../evil', { tail: '' }),
    /invalid ticketId/,
  );
  await assert.rejects(
    () => saveGateCapture(runDir, '', { tail: '' }),
    /invalid ticketId/,
  );
});

test('saveGateCapture refuses symlinked runDir or gate-failures', async (t) => {
  const base = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gate-cap-sym-'));
  t.after(async () => {
    await fsPromises.rm(base, { recursive: true, force: true });
  });

  const realRun = path.join(base, 'real-run');
  await fsPromises.mkdir(realRun, { recursive: true });
  const linkRun = path.join(base, 'link-run');
  await fsPromises.symlink(realRun, linkRun);

  await assert.rejects(
    () => saveGateCapture(linkRun, 't1', { tail: '' }),
    /must not be a symlink/,
  );

  const runDir = path.join(base, 'run2');
  await fsPromises.mkdir(runDir, { recursive: true });
  const failures = path.join(runDir, 'gate-failures');
  await fsPromises.mkdir(failures, { recursive: true });
  const realTarget = path.join(base, 'real-failures');
  await fsPromises.mkdir(realTarget, { recursive: true });
  await fsPromises.rm(failures, { recursive: true, force: true });
  await fsPromises.symlink(realTarget, failures);

  await assert.rejects(
    () => saveGateCapture(runDir, 't2', { tail: '' }),
    /must not be a symlink/,
  );
});

test('saveGateCapture trims tail to stay under 256KB', async (t) => {
  const runDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gate-cap-trim-'));
  t.after(async () => {
    await fsPromises.rm(runDir, { recursive: true, force: true });
  });

  const endMark = ['_', 'T', 'A', 'I', 'L', '_', 'E', 'N', 'D'].join('');
  const huge =
    'x'.repeat(300 * 1024 - endMark.length) + endMark;
  const outPath = await saveGateCapture(runDir, 'big-tail', {
    meta: 'gate-failure',
    tail: huge,
  });
  const buf = await fsPromises.readFile(outPath);
  assert.ok(buf.byteLength <= 256 * 1024);
  const parsed = JSON.parse(buf.toString('utf8'));
  assert.ok(typeof parsed.tail === 'string');
  assert.ok(parsed.tail.length < huge.length);
  assert.ok(parsed.tail.endsWith(endMark), 'trim must keep the end of the tail field');
});

test('saveGateCapture redacts Bearer tokens in capture strings', async (t) => {
  const runDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gate-cap-redact-'));
  t.after(async () => {
    await fsPromises.rm(runDir, { recursive: true, force: true });
  });

  const opaque = ['A', 'b', 'c', '1', '2', '3'].join('').repeat(4);
  const rawLine = ['Bearer', ' ', opaque].join('');
  const outPath = await saveGateCapture(
    runDir,
    'redact-bearer',
    { tail: rawLine, nested: { log: rawLine } },
    makeEnv(),
  );
  const parsed = JSON.parse(await fsPromises.readFile(outPath, 'utf8'));
  const serialized = JSON.stringify(parsed);
  assert.ok(!serialized.includes(opaque));
  assert.match(parsed.tail, /Bearer \[redacted\]/);
  assert.match(parsed.nested.log, /Bearer \[redacted\]/);
});

test('saveGateCapture refuses symlinked capture destination', async (t) => {
  const base = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gate-cap-sym-dest-'));
  t.after(async () => {
    await fsPromises.rm(base, { recursive: true, force: true });
  });

  const runDir = path.join(base, 'run');
  await fsPromises.mkdir(runDir, { recursive: true });
  const failuresDir = path.join(runDir, 'gate-failures');
  await fsPromises.mkdir(failuresDir, { recursive: true });
  const realFile = path.join(base, 'real-capture.json');
  await fsPromises.writeFile(realFile, '{}\n', 'utf8');
  const destLink = path.join(failuresDir, 'planted.json');
  await fsPromises.symlink(realFile, destLink);

  await assert.rejects(
    () => saveGateCapture(runDir, 'planted', { tail: 'ok' }),
    /must not be a symlink/,
  );
});

test('saveGateCapture rejects capture that cannot fit in 256KB', async (t) => {
  const runDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gate-cap-oversize-'));
  t.after(async () => {
    await fsPromises.rm(runDir, { recursive: true, force: true });
  });

  const filler = 'q';
  const items = Array.from({ length: 120_000 }, () => filler);
  await assert.rejects(
    () => saveGateCapture(runDir, 'oversize', { tail: '', items }),
    /exceeds.*bytes/,
  );
});
