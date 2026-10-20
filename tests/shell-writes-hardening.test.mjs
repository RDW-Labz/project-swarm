// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeShell } from '../tools/shell-writes.mjs';
import { buildEvent } from '../tools/orchestrator-events.mjs';

test('rm unlink rmdir: glob targets are unknown unless under a free folder', () => {
  const root = '/p';
  const a = c => analyzeShell(c, { root, cwd: root });
  assert.equal(a('rm -rf .swarm/*').unknown, true);
  assert.equal(a('rm -rf .swarm/notes?').unknown, true);
  assert.equal(a('rm -rf .swarm/{a,b}').unknown, true);
  assert.equal(a('rm -rf src/*').unknown, true);
  assert.equal(a('rm -rf *').unknown, true);
  assert.deepEqual(a('rm -rf dist/*').writes, []);
  assert.equal(a('rm -rf dist/*').unknown, false);
});

test('rm glob under home .claude is protected-outside', () => {
  const home = '/Users/someone';
  const root = '/p';
  const protectedAbs = [path.join(home, '.claude')];
  const r = analyzeShell('rm -rf ~/.claude/*', { root, cwd: root, home, protectedAbs });
  assert.ok(r.protectedOutside.length > 0);
});

test('dd curl wget tee find-delete: shell expansions in targets are unknown', () => {
  const root = '/p';
  const a = c => analyzeShell(c, { root, cwd: root });
  assert.equal(a('dd if=/dev/zero of=$OUT bs=1 count=1').unknown, true);
  assert.equal(a('curl -o "$OUT" https://example.com/x').unknown, true);
  assert.equal(a('wget -O "$OUT" https://example.com/x').unknown, true);
  assert.equal(a('tee $OUT < in').unknown, true);
  assert.equal(a('find src -name x -delete').unknown, false);
  assert.equal(a('find -name x -delete').unknown, true);
  assert.equal(a('find -delete').unknown, true);
});

test('find -exec rm with no search path is unknown', () => {
  const root = '/p';
  const r = analyzeShell('find -exec rm {} \\;', { root, cwd: root });
  assert.equal(r.unknown, true);
});

test('cd to a missing directory makes later relative writes unknown', () => {
  const root = '/p';
  const r = analyzeShell('cd /no/such/dir; echo x > src/a.ts', { root, cwd: root });
  assert.equal(r.unknown, true);
  assert.deepEqual(r.writes, []);
});

test('git push force refspec and delete forms', () => {
  const root = '/p';
  const a = c => analyzeShell(c, { root, cwd: root });
  assert.equal(a('git push -uf origin main').ops[0].force, true);
  assert.equal(a('git push --force-with-lease origin main').ops[0].force, true);
  assert.equal(a('git push --force-with-lease=main origin main').ops[0].force, true);
  assert.equal(a('git push --force-if-includes origin main').ops[0].force, true);
  assert.equal(a('git push origin +main').ops[0].force, true);
  assert.equal(a('git push origin HEAD:refs/heads/main').ops[0].branch, 'main');
  assert.equal(a('git push origin :main').ops[0].delete, 'remote');
  assert.equal(a('git push --delete origin main').ops[0].delete, 'remote');
});

test('gh and vercel global options set globalOpts and skip to subcommand', () => {
  const root = '/p';
  const a = c => analyzeShell(c, { root, cwd: root });
  assert.equal(a('gh -R o/r pr list').ops[0].globalOpts, true);
  assert.equal(a('gh -R o/r pr list').ops[0].sub, 'pr list');
  assert.equal(a('vercel --token T ls').ops[0].globalOpts, true);
  assert.equal(a('vercel --token T ls').ops[0].sub, 'ls');
});

test('hand-built counter: spaces in paths count; project scratchpad folder does not', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-harden-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'scratchpad'), { recursive: true });
  const base = { session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'x' } };
  const ev = (writes) => buildEvent('pre', base, {
    root,
    now: () => Date.UTC(2026, 9, 20, 12, 0, 0),
    analyze: () => ({ writes, git: [], inline: false, unknown: false }),
  });
  assert.equal(ev(['src/a b.ts']).hb, 1);
  assert.equal(ev(['scratchpad/x.txt']).hb, 1);
  const scratch = path.join(os.tmpdir(), 'claude-abc', 'scratchpad', 'n.txt');
  assert.equal(ev([scratch]).hb, undefined);
});

test('analyzer paths are treated as root-relative when hook cwd differs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-harden-root-'));
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-harden-cwd-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const ev = buildEvent('pre', {
    session_id: 's',
    cwd: elsewhere,
    tool_name: 'Bash',
    tool_input: { command: 'sed -i "" s/a/b/ src/a.ts' },
  }, { root, now: () => Date.UTC(2026, 9, 20, 12, 0, 0), analyze: analyzeShell });
  assert.equal(ev.hb, 1);
  assert.deepEqual(ev.bf, ['src/a.ts']);
});
