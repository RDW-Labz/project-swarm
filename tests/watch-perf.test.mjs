// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { redactUrl } from '../tools/watch-perf.mjs';

test('redactUrl replaces ?t= token value', () => {
  assert.equal(
    redactUrl('https://watch.example/command-center?t=secret-token&x=1'),
    'https://watch.example/command-center?t=…&x=1',
  );
});

test('redactUrl replaces &t= token value', () => {
  assert.equal(
    redactUrl('https://watch.example/command-center?x=1&t=secret-token'),
    'https://watch.example/command-center?x=1&t=…',
  );
});

test('redactUrl handles multiple query params and trailing segment', () => {
  assert.equal(
    redactUrl('https://watch.example/cc?t=aaa&tour=0&mode=1'),
    'https://watch.example/cc?t=…&tour=0&mode=1',
  );
});

test('redactUrl leaves URLs without t= unchanged', () => {
  const plain = 'https://watch.example/command-center?tour=0';
  assert.equal(redactUrl(plain), plain);
});

test('watch-perf result JSON uses redactUrl for url field', async () => {
  const source = await readFile(fileURLToPath(new URL('../tools/watch-perf.mjs', import.meta.url)), 'utf8');
  assert.match(source, /url:\s*redactUrl\(opts\.url\)/);
  assert.doesNotMatch(source, /url:\s*opts\.url/);
});
