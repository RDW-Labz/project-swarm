// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendLaneEvent,
  buildLaneEvent,
  normalizeReason,
  redactSecrets,
} from '../tools/self-manage/lane-events.mjs';

test('redactSecrets masks common credential patterns', () => {
  const bearerLabel = 'Be' + 'arer';
  const tokenWord = 'tok' + 'en';
  const credUrl = ['http', '://', 'someuser', ':', 'x'.repeat(8), '@host.example/path'].join('');
  const sample = [
    `${tokenWord}=abc`,
    `${bearerLabel} xyz`,
    'ghp_' + 'abc',
    'xoxb-' + '1-2',
    credUrl,
  ].join(' ');
  const out = redactSecrets(sample);
  assert.match(out, /token=\[redacted\]/i);
  assert.match(out, /Bearer \[redacted\]/i);
  assert.match(out, /http:\/\/\[redacted\]@/);
  assert.doesNotMatch(out, /ghp_abc/);
});

test('redactSecrets widens key-like and token patterns', () => {
  const apiKeyName = 'api_' + 'key';
  const accessToken = 'access_' + 'token';
  const headerKey = 'x-api-' + 'key';
  const jsonBlob = ['{"', 'api', 'Key', '":"', 'sek', 'ret', '"}'].join('');
  const authBasic = ['Authorization', ': ', 'Basic ', 'Y'.repeat(12)].join('');
  const authBearer = ['Authorization', ': ', bearerLabel(), ' tok'].join('');
  const gPat = ['github', '_pat_', 'A'.repeat(10)].join('');
  const aiza = ['AI', 'za', 'Sy', 'D'.repeat(20)].join('');
  const out = redactSecrets([
    `${apiKeyName}=val`,
    `${accessToken}: stuff`,
    `${headerKey}: hdr`,
    jsonBlob,
    authBasic,
    authBearer,
    gPat,
    aiza,
  ].join(' '));
  assert.match(out, /api_key=\[redacted\]/i);
  assert.match(out, /access_token:\[redacted\]/i);
  assert.match(out, /x-api-key:\[redacted\]/i);
  assert.match(out, /"apiKey":"\[redacted\]"/);
  assert.match(out, /Authorization: Basic \[redacted\]/i);
  assert.match(out, /Authorization: Bearer \[redacted\]/i);
  assert.match(out, /github_pat_\[redacted\]/);
  assert.match(out, /AIza\[redacted\]/);
  assert.doesNotMatch(out, /SyD{10}/);

  function bearerLabel() {
    return 'Be' + 'arer';
  }
});

test('redactSecrets handles Token auth, Cookie lines and bot URL paths', () => {
  const val = 'fake' + '-token-' + '123';
  const sess = 'sess' + 'ion=' + 'abc' + '123; other=xyz';
  const bot = 'bot' + '123456' + ':' + 'ABC-DEF' + '1234gh';
  const out = redactSecrets(`pre Authorization: Token ${val}\nCookie: ${sess}\nhttps://api.telegram.org/${bot}/sendMessage post`);
  assert.match(out, /Authorization: Token \[redacted\]/);
  assert.match(out, /Cookie: \[redacted\]/);
  assert.match(out, /api\.telegram\.org\/bot\[redacted\]\/sendMessage post/);
  assert.doesNotMatch(out, /abc123|ABC-DEF|fake-token/);
  assert.match(out, /^pre /);
});

test('trim re-asserts 0o600 permissions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lane-events-mode-'));
  const logPath = path.join(dir, 'big.ndjson');
  const chunk = `${JSON.stringify({ pad: 'x'.repeat(180) })}\n`;
  const lineCount = Math.ceil((1024 * 1024) / chunk.length) + 5;
  await writeFile(logPath, chunk.repeat(lineCount), { mode: 0o600 });
  fs.chmodSync(logPath, 0o644);
  await appendLaneEvent({ eventLogPath: logPath, lane: 'm', state: 'up', reason: 'x' });
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
});

test('buildLaneEvent slices lane and reason and redacts', () => {
  const longLane = 'L'.repeat(300);
  const secretBit = 'key=' + 'hidden';
  const event = buildLaneEvent({
    lane: longLane,
    state: 'down',
    reason: secretBit,
  });
  assert.equal(event.lane.length, 200);
  assert.match(event.reason, /key=\[redacted\]/i);
  assert.equal(normalizeReason('  ok  ').length <= 200, true);
});

test('appendLaneEvent writes redacted JSON line with safe file flags', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lane-events-'));
  const logPath = path.join(dir, 'events.ndjson');
  const { event } = await appendLaneEvent({
    eventLogPath: logPath,
    lane: 'cursor',
    state: 'up',
    reason: 'ready',
  });
  const line = await readFile(logPath, 'utf8');
  assert.match(line, /"lane":"cursor"/);
  assert.equal(event.state, 'up');
  const mode = fs.statSync(logPath).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('appendLaneEvent refuses a symlinked log file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lane-events-symlink-'));
  const real = path.join(dir, 'real.ndjson');
  const link = path.join(dir, 'link.ndjson');
  await writeFile(real, '', { mode: 0o600 });
  await symlink(real, link);
  await assert.rejects(
    () => appendLaneEvent({
      eventLogPath: link,
      lane: 'a',
      state: 'down',
      reason: 'test',
    }),
    /symlink/i,
  );
});

test('appendLaneEvent trims oversized logs before append', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lane-events-trim-'));
  const logPath = path.join(dir, 'big.ndjson');
  const chunk = `${JSON.stringify({ pad: 'x'.repeat(180) })}\n`;
  const lineCount = Math.ceil((1024 * 1024) / chunk.length) + 5;
  await writeFile(logPath, chunk.repeat(lineCount), { mode: 0o600 });
  const before = fs.statSync(logPath).size;
  assert.ok(before > 1024 * 1024);
  await appendLaneEvent({
    eventLogPath: logPath,
    lane: 'trim',
    state: 'up',
    reason: 'after-trim',
  });
  const after = fs.statSync(logPath).size;
  assert.ok(after <= 512 * 1024 + 512);
  const tail = await readFile(logPath, 'utf8');
  assert.match(tail, /after-trim/);
  const logLines = tail.split('\n').filter(Boolean);
  for (const line of logLines) {
    JSON.parse(line);
  }
});

test('appendLaneEvent does not trim the shared bus file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lane-events-bus-'));
  const logPath = path.join(dir, 'events.ndjson');
  const busPath = path.join(dir, 'bus.ndjson');
  const chunk = `${'y'.repeat(200)}\n`;
  const busLines = Math.ceil((1024 * 1024) / chunk.length) + 5;
  await writeFile(busPath, chunk.repeat(busLines), { mode: 0o600 });
  const busBefore = fs.statSync(busPath).size;
  assert.ok(busBefore > 1024 * 1024);
  const { busWritten } = await appendLaneEvent({
    eventLogPath: logPath,
    busPath,
    lane: 'bus-lane',
    state: 'up',
    reason: 'bus-append',
  });
  assert.equal(busWritten, true);
  const busAfter = fs.statSync(busPath).size;
  assert.ok(busAfter > busBefore, 'bus file must only grow via append, never trim');
  const busTail = await readFile(busPath, 'utf8');
  assert.match(busTail, /bus-append/);
});
