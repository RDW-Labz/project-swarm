// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chatUrlFor } from '../tools/orchestrator-chat.mjs';

const SESSION_ID = 'sess-test-orch-001';
const BRIDGE = 'session_01ABCDEFghij';
const GOOD_URL = `https://claude.ai/code/${BRIDGE}`;

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chat-home-'));
}

function sessionsDir(home) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function projectsTranscript(home, name = `${SESSION_ID}.jsonl`) {
  const dir = path.join(home, '.claude', 'projects', 'proj-folder');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

test('finds chat URL by sessionId from sessions folder', () => {
  const home = makeHome();
  const dir = sessionsDir(home);
  fs.writeFileSync(
    path.join(dir, '4242.json'),
    JSON.stringify({
      pid: 4242,
      sessionId: SESSION_ID,
      bridgeSessionId: BRIDGE,
      updatedAt: 1_700_000_000_000,
    }),
  );
  const url = chatUrlFor(SESSION_ID, { home, now: 1 });
  assert.equal(url, GOOD_URL);
});

test('ignores .key files and never opens them', () => {
  const home = makeHome();
  const dir = sessionsDir(home);
  const keyPath = path.join(dir, '9999.deadbeefcafebabe.key');
  fs.writeFileSync(keyPath, 'secret', { mode: 0o000 });
  fs.writeFileSync(
    path.join(dir, '9999.json'),
    JSON.stringify({
      pid: 9999,
      sessionId: SESSION_ID,
      bridgeSessionId: BRIDGE,
      updatedAt: 2,
    }),
  );
  const url = chatUrlFor(SESSION_ID, { home, now: 1 });
  assert.equal(url, GOOD_URL);
});

test('bad bridgeSessionId in session file yields null without transcript', () => {
  const home = makeHome();
  const dir = sessionsDir(home);
  fs.writeFileSync(
    path.join(dir, '1.json'),
    JSON.stringify({
      sessionId: SESSION_ID,
      bridgeSessionId: 'not-a-valid-bridge',
      updatedAt: 1,
    }),
  );
  assert.equal(chatUrlFor(SESSION_ID, { home, now: 1 }), null);
});

test('prefers newest session file for the same sessionId', () => {
  const home = makeHome();
  const dir = sessionsDir(home);
  const olderBridge = 'session_01olderbridge12';
  const newerBridge = BRIDGE;
  fs.writeFileSync(
    path.join(dir, '10.json'),
    JSON.stringify({
      sessionId: SESSION_ID,
      bridgeSessionId: olderBridge,
      updatedAt: 100,
    }),
  );
  fs.writeFileSync(
    path.join(dir, '11.json'),
    JSON.stringify({
      sessionId: SESSION_ID,
      bridgeSessionId: newerBridge,
      updatedAt: 200,
    }),
  );
  assert.equal(chatUrlFor(SESSION_ID, { home, now: 1 }), GOOD_URL);
});

test('transcript fallback picks newest bridge_status url', () => {
  const home = makeHome();
  const transcript = projectsTranscript(home);
  const older = 'session_01olderstatus1';
  const newer = BRIDGE;
  const lines = [
    JSON.stringify({
      type: 'system',
      subtype: 'bridge_status',
      url: `https://claude.ai/code/${older}`,
      timestamp: 100,
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'bridge_status',
      url: GOOD_URL,
      timestamp: 200,
    }),
  ];
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  const url = chatUrlFor('other-session', {
    home,
    now: 1,
    transcriptPath: transcript,
  });
  assert.equal(url, GOOD_URL);
});

test('transcript outside ~/.claude/projects is refused', () => {
  const home = makeHome();
  const outside = path.join(home, 'tmp', 'leak.jsonl');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(
    outside,
    JSON.stringify({
      type: 'system',
      subtype: 'bridge_status',
      url: GOOD_URL,
    }) + '\n',
  );
  assert.equal(
    chatUrlFor(SESSION_ID, { home, now: 1, transcriptPath: outside }),
    null,
  );
});

test('bridge_status url on another host is refused', () => {
  const home = makeHome();
  const transcript = projectsTranscript(home);
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      type: 'system',
      subtype: 'bridge_status',
      url: `https://evil.example/code/${BRIDGE}`,
    }) + '\n',
  );
  assert.equal(
    chatUrlFor(SESSION_ID, { home, now: 1, transcriptPath: transcript }),
    null,
  );
});

test('missing sessions and projects folders returns null', () => {
  const home = makeHome();
  assert.equal(chatUrlFor(SESSION_ID, { home, now: 1 }), null);
});

test('falls back to transcript when session bridge id is invalid', () => {
  const home = makeHome();
  const dir = sessionsDir(home);
  fs.writeFileSync(
    path.join(dir, '5.json'),
    JSON.stringify({
      sessionId: SESSION_ID,
      bridgeSessionId: 'bad',
      updatedAt: 1,
    }),
  );
  const transcript = projectsTranscript(home);
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      type: 'system',
      subtype: 'bridge_status',
      url: GOOD_URL,
      timestamp: 1,
    }) + '\n',
  );
  assert.equal(
    chatUrlFor(SESSION_ID, { home, now: 1, transcriptPath: transcript }),
    GOOD_URL,
  );
});

test('chatUrlFor never throws on garbage input', () => {
  assert.equal(chatUrlFor(null, { home: makeHome(), now: 1 }), null);
  assert.equal(chatUrlFor('', { home: makeHome(), now: 1 }), null);
});
