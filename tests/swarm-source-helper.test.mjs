// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readSwarmSource } from './helpers/swarm-source.mjs';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const entryPath = path.join(packageRoot, 'tools/swarm.mjs');
const modulesDir = path.join(packageRoot, 'tools/swarm');

test('readSwarmSource includes entry and sorted module files with path comments', async () => {
  const entry = await fs.readFile(entryPath, 'utf8');
  const combined = await readSwarmSource();
  assert.ok(combined.startsWith(entry), 'entry text leads the combined source');

  let moduleNames = [];
  try {
    moduleNames = fsSync
      .readdirSync(modulesDir)
      .filter(name => name.endsWith('.mjs'))
      .sort();
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  if (moduleNames.length === 0) {
    assert.equal(combined, entry, 'unsplit layout is only the entry file');
    return;
  }

  assert.ok(combined.length > entry.length, 'split layout appends module bodies');
  let cursor = entry.length;
  for (const name of moduleNames) {
    const rel = `tools/swarm/${name}`;
    const body = await fs.readFile(path.join(modulesDir, name), 'utf8');
    const expected = `\n// ${rel}\n${body}`;
    assert.equal(combined.slice(cursor, cursor + expected.length), expected, rel);
    cursor += expected.length;
  }
  assert.equal(cursor, combined.length);
});
