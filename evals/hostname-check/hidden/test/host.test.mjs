import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHost } from '../src/host.mjs';

test('matches the exact hostname', () => {
  assert.equal(isHost('https://example.com/path', 'example.com'), true);
  assert.equal(isHost('https://EXAMPLE.com/', 'Example.COM'), true);
});

test('rejects a host that only appears in path, query or fragment', () => {
  assert.equal(isHost('https://evil.net/example.com', 'example.com'), false);
  assert.equal(isHost('https://evil.net/?next=example.com', 'example.com'), false);
  assert.equal(isHost('https://evil.net/#example.com', 'example.com'), false);
});

test('rejects user info tricks', () => {
  assert.equal(isHost('https://example.com@evil.net/', 'example.com'), false);
  assert.equal(isHost('https://example.com:1@evil.net/', 'example.com'), false);
});

test('rejects look-alike and subdomain hosts', () => {
  assert.equal(isHost('https://notexample.com/', 'example.com'), false);
  assert.equal(isHost('https://example.com.evil.net/', 'example.com'), false);
  assert.equal(isHost('https://sub.example.com/', 'example.com'), false);
});

test('rejects invalid input', () => {
  assert.equal(isHost('not a url example.com', 'example.com'), false);
  assert.equal(isHost('example.com', 'example.com'), false);
  assert.equal(isHost('', 'example.com'), false);
  assert.equal(isHost(undefined, 'example.com'), false);
  assert.equal(isHost('https://example.com/', undefined), false);
  assert.equal(isHost('file:///tmp/x', ''), false);
});
