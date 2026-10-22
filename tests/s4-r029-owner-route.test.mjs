// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowedChatUrl } from '../tools/watch-assets/orchestrator-view.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const boardSrc = fs.readFileSync(path.join(repo, 'tools/watch-assets/board.js'), 'utf8');
const orchSrc = fs.readFileSync(path.join(repo, 'tools/watch-assets/orchestrator-view.js'), 'utf8');

test('board wires Needs-you owner controls only through board-owner-actions', () => {
  assert.match(boardSrc, /from '\.\/board-owner-actions\.js'/);
  assert.match(boardSrc, /renderOwnerActions\(/);
  assert.match(boardSrc, /ownerActionAvailable\(/);
  assert.match(boardSrc, /fetchImpl:\s*fetch/);
  assert.match(boardSrc, /token:\s*TOKEN/);
  assert.doesNotMatch(boardSrc, /\/api\/owner\/actions/);
  assert.match(boardSrc, /openRun\s*===\s*false/);
});

test('orchestrator cards link Open chat only to allow-listed Remote Control URLs', () => {
  assert.match(orchSrc, /Open chat/);
  assert.match(orchSrc, /allowedChatUrl/);
  assert.equal(allowedChatUrl('https://claude.ai/code/session_ABCDEFGHIJ'), true);
  assert.equal(allowedChatUrl('https://evil.test/session_ABCDEFGHIJ'), false);
  assert.equal(allowedChatUrl('javascript:alert(1)'), false);
});
