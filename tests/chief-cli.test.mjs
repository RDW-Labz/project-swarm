import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tools/chief-status.mjs', import.meta.url));

function writeSnapshot(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-cli-'));
  const file = path.join(dir, 'snapshot.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('status CLI prints every active project and exits 0', () => {
  const file = writeSnapshot({
    cap: 4,
    projects: [
      { name: 'alpha', active: true, slots: 2 },
      { name: 'beta', active: true, slots: 1 },
      { name: 'gamma', active: false, slots: 0 },
    ],
  });
  const run = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /alpha/);
  assert.match(run.stdout, /beta/);
  assert.doesNotMatch(run.stdout, /gamma/);
});

test('status CLI with no argument prints usage and exits 2', () => {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage/);
});

test('status CLI with an invalid cap exits non-zero', () => {
  const file = writeSnapshot({ cap: 0, projects: [] });
  const run = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
});
