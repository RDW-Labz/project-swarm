// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadLocalConfig } from '../tools/local-config.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function fixture(t) {
  const base = path.join(repoRoot, '.swarm-tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'sandbox-tmp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const source of ['SWARM_TEST_TMP', 'TMPDIR', 'os.tmpdir']) {
  test(`#299: isolation creates config, home and test tmp under ${source}`, t => {
    const base = fixture(t);
    const env = { ...process.env, TMPDIR: path.join(base, 'unused-tmp') };
    delete env.SWARM_TEST_TMP;
    if (source === 'SWARM_TEST_TMP') env.SWARM_TEST_TMP = base;
    if (source === 'TMPDIR') env.TMPDIR = base;
    if (source === 'os.tmpdir') delete env.TMPDIR;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      const base = ${JSON.stringify(base)};
      if (${JSON.stringify(source)} === 'os.tmpdir') os.tmpdir = () => base;
      const created = [];
      const mkdtemp = fs.mkdtempSync;
      fs.mkdtempSync = (prefix, ...args) => {
        if (path.dirname(prefix) !== base) throw Error('isolation escaped its temp base');
        const dir = mkdtemp(prefix, ...args);
        created.push(dir);
        return dir;
      };
      await import('./tests/_isolate-config.mjs');
      console.log(JSON.stringify({ created, config: process.env.SWARM_CONFIG,
        home: process.env.HOME, tmp: process.env.SWARM_TEST_TMP }));
    `], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
    const result = JSON.parse(probe.stdout);
    const dirs = [path.dirname(result.config), result.home, result.tmp];
    assert.equal(new Set(dirs).size, 3);
    assert.deepEqual(result.created, dirs);
    for (const dir of dirs) {
      assert.equal(path.dirname(dir), base);
      assert.ok(fs.statSync(dir).isDirectory());
    }
    assert.deepEqual(fs.readdirSync(base).sort(), dirs.map(dir => path.basename(dir)).sort());
  });
}

test('#299: config guard accepts sandbox directories and still refuses other repo paths', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.git'));
  for (const dir of ['.swarm-tmp', '.swarm']) {
    const file = path.join(root, dir, 'x', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fixture: true }));
    assert.deepEqual(loadLocalConfig({ env: { SWARM_CONFIG: file } }), { fixture: true });
    assert.deepEqual(loadLocalConfig({ env: { SWARM_CONFIG: path.join(root, dir, 'missing.json') } }), {});
  }
  for (const relative of ['config.json', '.swarm-tmp-other/x/config.json', '.swarm-other/x/config.json', 'sub/.swarm/config.json', '.swarm-tmp/../config.json']) {
    assert.throws(() => loadLocalConfig({ env: { SWARM_CONFIG: path.join(root, relative) } }), /config-inside-repo:/);
  }
});
